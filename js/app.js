/* =========================================================================
 * app.js - Controller dell'applicazione ForexVision
 * Collega dati, indicatori, motore previsionale e grafico all'interfaccia.
 * ========================================================================= */
(function () {
  'use strict';

  const D = window.ForexData;
  const F = window.Forecast;
  const IND = window.Indicators;
  const SMC = window.SMC;
  const SEN = window.Sentiment;
  const FX = window.ForexFeed;
  const REP = window.Report;

  const STORAGE_KEY = 'forexvision.journal.v1';

  const state = {
    pair: 'EUR/USD',
    tf: 'M10',
    horizon: 10,
    salt: 0,
    series: null,
    analysis: null,
    smc: null,
    sentiment: null,
    confluence: null,
    report: null,
    marketCache: [],
    backtest: null,
    instrument: null,
    live: true,
    source: 'sim',          // 'sim' | 'real'
    feedInfo: null,         // informazioni sugli ultimi dati reali
    feedError: null,        // ultimo errore del ponte dati (o null)
    simContext: false,      // sentiment reale: includere anche le coppie simulate?
    loadToken: 0,           // per scartare risposte dati superate
    journal: []
  };

  let chart = null;
  let chartEl, tooltipEl;
  let btTimer = null;

  /* ------------------------------ utilità ------------------------------ */
  const $ = function (id) { return document.getElementById(id); };

  function num(v, d) { return (v == null || !isFinite(v)) ? '\u2014' : Number(v).toFixed(d); }

  function signed(v, d) { return (v >= 0 ? '+' : '') + Number(v).toFixed(d); }

  function pip(v, instrument) {
    return D.pipsBetween(0, v, instrument);
  }

  function fmtInt(v) { return Math.round(v).toLocaleString('it-IT'); }

  /* ------------------------------ avvio ------------------------------ */
  function init() {
    chartEl = $('chart');
    tooltipEl = $('tooltip');
    chart = new window.ForexChart(chartEl, tooltipEl);
    chart.onHover = function (idx) {
      if (!state.series) return;
      const c = state.series.candles[idx];
      $('ohlcReadout').textContent =
        'O ' + c.open.toFixed(state.instrument.digits) +
        '  H ' + c.high.toFixed(state.instrument.digits) +
        '  L ' + c.low.toFixed(state.instrument.digits) +
        '  C ' + c.close.toFixed(state.instrument.digits) +
        '  V ' + fmtInt(c.volume);
    };
    chart.onLeave = function () {
      if (!state.series) return;
      const c = state.series.candles[state.series.candles.length - 1];
      $('ohlcReadout').textContent =
        'O ' + c.open.toFixed(state.instrument.digits) +
        '  H ' + c.high.toFixed(state.instrument.digits) +
        '  L ' + c.low.toFixed(state.instrument.digits) +
        '  C ' + c.close.toFixed(state.instrument.digits) +
        '  V ' + fmtInt(c.volume);
    };

    buildPairSelect();
    loadJournal();
    bindEvents();
    startClock();
    refresh(true).then(function () {
      renderWatchlist();
      startFeedPolling();
    });

    // collegamento diretto: index.html#report apre subito il report
    if (location.hash === '#report') openReport();

    // Aggiornamento automatico della watchlist e dello studio di sentiment
    setInterval(function () { if (state.live) tick(); }, 2500);
    setInterval(function () {
      if (!state.live) return;
      buildMarketCache();
      renderWatchlist();
      state.sentiment = SEN.analyze(state.marketCache, state.pair, state.instrument, sentimentOpts());
      state.confluence = computeConfluence();
      renderSentiment();
      renderConfluence();
    }, 30000);
  }

  function buildPairSelect() {
    const sel = $('pairSelect');
    sel.innerHTML = '';
    const groups = { major: 'Coppie principali', cross: 'Coppie incrociate', metal: 'Metalli' };
    Object.keys(groups).forEach(function (g) {
      const og = document.createElement('optgroup');
      og.label = groups[g];
      D.INSTRUMENTS.filter(function (i) { return i.type === g; }).forEach(function (i) {
        const o = document.createElement('option');
        o.value = i.symbol;
        o.textContent = i.symbol;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = state.pair;
  }

  function bindEvents() {
    $('pairSelect').addEventListener('change', function (e) {
      state.pair = e.target.value;
      refresh(false);
      markActiveWatchlist();
    });

    $('tfSelect').addEventListener('change', function (e) {
      state.tf = e.target.value;
      refresh(false);
      renderWatchlist();
    });

    $('horizonSelect').addEventListener('change', function (e) {
      state.horizon = parseInt(e.target.value, 10);
      refresh(false);
    });

    $('refreshBtn').addEventListener('click', function () {
      state.salt = (state.salt + 1) % 9973;
      refresh(true).then(function () { renderWatchlist(); });
    });

    // --- report divulgativo ---
    $('reportBtn').addEventListener('click', openReport);
    $('confReportBtn').addEventListener('click', openReport);
    $('reportClose').addEventListener('click', closeReport);
    $('reportCopy').addEventListener('click', copyReport);
    $('reportDownload').addEventListener('click', downloadReport);
    $('reportPrint').addEventListener('click', function () { window.print(); });
    // chiusura cliccando lo sfondo o premendo Esc
    $('reportOverlay').addEventListener('click', function (e) {
      if (e.target === $('reportOverlay')) closeReport();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isReportOpen()) closeReport();
    });

    $('simCtx').addEventListener('change', function (e) {
      state.simContext = e.target.checked;
      if (!state.sentiment) return;
      state.sentiment = SEN.analyze(state.marketCache, state.pair, state.instrument, sentimentOpts());
      state.confluence = computeConfluence();
      renderSentiment();
      renderConfluence();
      buildReport();
      if (isReportOpen()) renderReport();
    });

    document.querySelectorAll('.chart-toggles .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        const layer = chip.dataset.layer;
        chip.classList.toggle('active');
        chart.setLayer(layer, chip.classList.contains('active'));
      });
    });

    $('saveTradeBtn').addEventListener('click', saveTrade);
    $('clearJournal').addEventListener('click', function () {
      if (state.journal.length === 0) return;
      if (confirm('Eliminare tutte le operazioni registrate?')) {
        state.journal = [];
        persistJournal();
        renderJournal();
      }
    });

    window.addEventListener('resize', function () {
      chart.draw();
      drawBacktestChart();
    });
  }

  /* ------------------------------ dati + analisi ------------------------------ */
  /**
   * Prepara i dati e ricalcola l'analisi completa.
   * In modalità reale chiede le candele vere al ponte locale (server.py) e, se
   * il ponte o il fornitore non rispondono, ripiega sulla simulazione
   * dichiarandolo chiaramente nella parte superiore della pagina.
   */
  function refresh(regenerate) {
    const token = ++state.loadToken;
    state.instrument = D.instrumentBySymbol(state.pair);
    // `?sim=1` forza comunque la modalità simulata: serve ai test automatici,
    // che hanno bisogno di risultati deterministici.
    const forceSim = /[?&](sim|offline)=1/.test(location.search);

    if (state.pair === 'EUR/USD' && !forceSim) {
      return feedLoad(regenerate).then(function (series) {
        if (token !== state.loadToken) return;
        state.source = 'real';
        state.series = series;
        state.feedInfo = series.info;
        state.feedError = null;
        finishRefresh();
      }).catch(function (err) {
        if (token !== state.loadToken) return;
        state.source = 'sim';
        state.feedInfo = null;
        state.feedError = (err && err.message) ? err.message : String(err);
        state.series = D.generateSeries(state.pair, state.tf, state.salt);
        finishRefresh();
      });
    }

    // Le altre coppie non sono collegate ai dati reali: si analizzano i dati
    // simulati, spiegando perché in cima alla pagina.
    state.source = 'sim';
    state.series = D.generateSeries(state.pair, state.tf, state.salt);
    state.feedInfo = null;
    state.feedError = 'al flusso dati reali è collegata solo la coppia EUR/USD';
    finishRefresh();
    return Promise.resolve();
  }

  /** Scarica i dati reali dal ponte locale, se raggiungibile. */
  function feedLoad(regenerate) {
    return FX.probe().then(function (online) {
      if (!online) throw new Error('server dati locale non trovato: modalità simulata');
      return FX.load(state.tf, {
        symbol: state.pair,
        instrument: state.instrument,
        force: !!regenerate
      });
    });
  }

  /** Ricalcola l'analisi completa a partire da state.series (reali o fittizie). */
  function finishRefresh() {
    state.analysis = F.analyze(state.series.candles, state.instrument, state.horizon);
    state.smc = SMC.analyze(state.series.candles, state.analysis.indicators, state.instrument);

    // cache di tutte le coppie: serve alla watchlist e allo studio di sentiment
    buildMarketCache();
    state.sentiment = SEN.analyze(state.marketCache, state.pair, state.instrument, sentimentOpts());
    state.confluence = computeConfluence();

    // Il backtest è più oneroso: lo ricalcolo in modo differito
    if (btTimer) clearTimeout(btTimer);
    btTimer = setTimeout(function () {
      state.backtest = F.backtest(state.series.candles, state.instrument, state.horizon, { window: 250 });
      renderBacktest();
    }, 30);

    chart.setData(state.series, state.analysis, state.instrument, state.smc);
    renderHeader();
    renderSignal();
    renderConfluence();
    renderSmc();
    renderIndicators();
    renderForecast();
    renderContext();
    renderSentiment();
    renderJournal();
    refreshButtonState();

    // report divulgativo: dati sempre pronti, finestra aggiornata se aperta
    buildReport();
    if (isReportOpen()) renderReport();
  }

  /** Campi di scelta per lo studio di sentiment. */
  function sentimentOpts() {
    return { includeSimulated: state.source !== 'real' || state.simContext };
  }

  /** Verdetto di confluenza. In modalità reale ridotta il sentiment pesa solo se
   *  ha un universo completo di cambi (cioè se è attivo anche il contesto simulato). */
  function computeConfluence() {
    const structuralReliable = state.source !== 'real' || state.simContext ||
      !state.sentiment || !state.sentiment.scope || !state.sentiment.scope.partial;
    return SEN.confluence(state.analysis.score, state.smc.score, state.sentiment.score,
      { sentimentReliable: structuralReliable });
  }

  /** Aggiornamento periodico dei dati reali (ogni 60 secondi, cache del ponte 60 s). */
  function startFeedPolling() {
    if (state.source !== 'real' || FX.status().polling) return;
    FX.startPolling(
      function () { return state.tf; },
      function () { return { symbol: state.pair, instrument: state.instrument }; },
      function (series, meta) {
        if (state.source !== 'real' || !meta || meta.timeframe !== state.tf) return;
        state.series = series;
        state.feedInfo = series.info;
        state.feedError = null;
        finishRefresh();
      },
      function (err) {
        state.feedError = (err && err.message) ? err.message : String(err);
        refreshButtonState();
      }
    );
  }

  /** Genera (o rigenera) la cache di tutte le coppie con indicatori e punteggi.
   *  Con i dati reali la coppia selezionata porta la serie vera; le altre
   *  restano simulate e vengono marcate così, in modo che ogni studio che le
   *  usa (sentiment, watchlist) possa dichiararlo. */
  function buildMarketCache() {
    state.marketCache = D.INSTRUMENTS.map(function (inst) {
      const isRealPair = state.source === 'real' && inst.symbol === state.pair;
      const series = isRealPair ? state.series : D.generateSeries(inst.symbol, state.tf, state.salt);
      const ind = IND.computeAll(series.candles);
      const i = series.candles.length - 1;
      const s = F.scoreAtIndex(ind, i);
      const last = series.candles[i], prev = series.candles[i - 1];
      return {
        symbol: inst.symbol,
        instrument: inst,
        candles: series.candles,
        ind: ind,
        score: s.score,
        price: last.close,
        chg: (last.close - prev.close) / prev.close * 100,
        simulated: !isRealPair
      };
    });
    return state.marketCache;
  }

  function refreshButtonState() {
    const badge = $('feedBadge');
    const info = $('feedInfo');

    if (state.source === 'real') {
      badge.className = 'badge badge-real';
      badge.textContent = 'DATI REALI \u00b7 YAHOO FINANCE';
    } else if (state.feedError && state.pair === 'EUR/USD') {
      badge.className = 'badge badge-sim';
      badge.textContent = 'DATI SIMULATI (OFFLINE)';
    } else {
      badge.className = 'badge badge-sim';
      badge.textContent = 'DATI SIMULATI';
    }

    if (state.source === 'real' && state.feedInfo) {
      const fi = state.feedInfo;
      info.style.display = '';
      info.textContent = 'EUR/USD \u00b7 ultimo aggiornamento ' +
        new Date(fi.fetchedAt || Date.now()).toLocaleTimeString('it-IT') +
        (fi.forming ? ' \u00b7 candela in formazione' : '') +
        (fi.stale ? ' \u00b7 dati non aggiornati' : '');
      let title = 'Fonte: ' + fi.provider + ' (' + fi.yahooSymbol + ')\n' +
        'Storico disponibile: ' + fi.history + '\n' +
        'Intervallo: ' + fi.interval + ' \u00b7 ' + fi.bars + ' candele' +
        (fi.aggregated ? ' (ricostruito dalla serie minore)' : '') + '\n' +
        'Aggiornato alle: ' + new Date(fi.fetchedAt).toLocaleString('it-IT') + '\n' +
        'Ultima candela: ' + new Date(fi.lastBarTime).toLocaleString('it-IT');
      if (fi.note) title += '\nNota: ' + fi.note;
      info.title = title;
      info.classList.toggle('warn', !!fi.stale);
    } else {
      info.style.display = '';
      info.textContent = state.source === 'real'
        ? 'in aggiornamento\u2026'
        : (state.feedError || 'simulato');
      info.title = state.feedError
        ? state.feedError
        : 'Nessun server dati trovato: l\u2019app analizza una storia simulata.';
    }
  }

  /* ------------------------------ tick "live" ------------------------------ */
  function tick() {
    // Con i dati reali i movimenti arrivano dal fornitore: niente rumore finto.
    if (state.source === 'real') return;
    // il primo giro puo' scattare prima che la serie sia pronta (per esempio
    // quando il ponte risponde piano): senza dati non c'e' niente da muovere
    if (!state.series || !state.analysis) return;

    const candles = state.series.candles;
    const last = candles[candles.length - 1];
    const inst = state.instrument;
    const atr = state.analysis.atr;

    // piccola variazione casuale proporzionale all'ATR
    const move = (Math.random() - 0.5) * atr * 0.35;
    last.close = D.round(Math.max(0.00001, last.close + move), inst.digits);
    last.high = Math.max(last.high, last.close);
    last.low = Math.min(last.low, last.close);
    last.volume += Math.round(Math.random() * 120);

    // ogni tanto nasce una nuova candela
    const tfMs = D.TIMEFRAMES[state.tf].minutes * 60000;
    if (Math.random() < 0.05 && candles.length > 100) {
      const nb = {
        time: last.time + tfMs,
        open: last.close,
        high: last.close,
        low: last.close,
        close: last.close,
        volume: Math.round(Math.random() * 300)
      };
      candles.push(nb);
      candles.shift();
    }

    state.analysis = F.analyze(candles, inst, state.horizon);
    state.smc = SMC.analyze(candles, state.analysis.indicators, inst);

    // aggiorno la coppia selezionata nella cache e ricalcolo lo studio di
    // sentiment (operazione leggera: nessun ricalcolo di indicatori)
    const cacheEntry = state.marketCache.filter(function (e) { return e.symbol === state.pair; })[0];
    if (cacheEntry) {
      cacheEntry.candles = candles;
      cacheEntry.ind = state.analysis.indicators;
      cacheEntry.score = state.analysis.score;
      cacheEntry.price = last.close;
    }
    state.sentiment = SEN.analyze(state.marketCache, state.pair, inst, sentimentOpts());
    state.confluence = computeConfluence();

    chart.setData(state.series, state.analysis, inst, state.smc);
    renderHeader();
    renderSignal();
    renderConfluence();
    renderSmc();
    renderIndicators();
    renderForecast();
    renderSentiment();
    // i dati del report si aggiornano, ma la finestra non viene ridisegnata
    // per non spostare la lettura di chi la sta consultando
    buildReport();
  }

  /* ------------------------------ render ------------------------------ */
  function renderHeader() {
    const a = state.analysis;
    const inst = state.instrument;
    const candles = state.series.candles;
    const prev = candles[candles.length - 2];
    const last = candles[candles.length - 1];
    const chg = (last.close - prev.close) / prev.close * 100;
    const chgPips = D.pipsBetween(prev.close, last.close, inst);

    $('chartTitle').textContent = state.pair + ' \u00b7 ' + state.tf;
    $('lastPrice').textContent = last.close.toFixed(inst.digits);
    const dEl = $('lastChange');
    dEl.textContent = signed(chgPips, 1) + ' pip  (' + signed(chg, 2) + '%)';
    dEl.className = 'delta ' + (chg >= 0 ? 'pos' : 'neg');

    $('ohlcReadout').textContent =
      'O ' + last.open.toFixed(inst.digits) +
      '  H ' + last.high.toFixed(inst.digits) +
      '  L ' + last.low.toFixed(inst.digits) +
      '  C ' + last.close.toFixed(inst.digits) +
      '  V ' + fmtInt(last.volume);

    $('signalStamp').textContent = 'aggiornato alle ' +
      new Date().toLocaleTimeString('it-IT');
  }

  function renderSignal() {
    const a = state.analysis;
    const inst = state.instrument;
    const badge = $('signalBadge');
    const labels = { BUY: 'ACQUISTO', SELL: 'VENDITA', NEUTRAL: 'NEUTRO' };
    badge.className = 'signal-badge ' + (a.direction === 'BUY' ? 'buy' : a.direction === 'SELL' ? 'sell' : 'neutral');
    badge.querySelector('.signal-dir').textContent = labels[a.direction];
    badge.querySelector('.signal-conf').textContent =
      'confidenza ' + (a.confidence * 100).toFixed(0) + '%  \u00b7  score ' + signed(a.score, 3);

    $('gaugeFill').style.left = ((a.score + 1) / 2 * 100) + '%';

    $('planEntry').textContent = a.price.toFixed(inst.digits);
    $('planTp').textContent = a.target.toFixed(inst.digits) +
      '  (' + signed(pip(a.target - a.price, inst), 1) + ' pip)';
    $('planSl').textContent = a.stop.toFixed(inst.digits) +
      '  (' + signed(pip(a.stop - a.price, inst), 1) + ' pip)';
    $('planRr').textContent = num(a.rr, 2) + ' : 1';
    $('planExp').textContent = signed(pip(a.expectedMove, inst), 1) + ' pip  (' +
      signed(a.expectedMove / a.price * 100, 2) + '%)';
    $('planAtr').textContent = a.atr.toFixed(inst.digits) + '  (' + a.atrPct.toFixed(2) + '%)';

    const list = $('reasonList');
    list.innerHTML = '';
    a.reasons.forEach(function (r) {
      const li = document.createElement('li');
      li.className = r.tone;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = r.tone === 'bull' ? '\u25b2' : r.tone === 'bear' ? '\u25bc' : '\u25cf';
      const span = document.createElement('span');
      span.textContent = r.text;
      li.appendChild(dot);
      li.appendChild(span);
      list.appendChild(li);
    });
  }

  function tagFor(score) {
    if (score > 0.15) return '<span class="tag bull">RIALZO</span>';
    if (score < -0.15) return '<span class="tag bear">RIBASSO</span>';
    return '<span class="tag flat">NEUTRO</span>';
  }

  function renderIndicators() {
    const a = state.analysis;
    const ind = a.indicators;
    const inst = state.instrument;
    const i = a.index;
    const rows = [];

    function row(label, value, score) {
      rows.push('<tr><td>' + label + '</td><td>' + value + '</td><td>' + tagFor(score) + '</td></tr>');
    }

    const c = ind.closes[i];
    row('Prezzo', c.toFixed(inst.digits), a.score);
    if (ind.ema9[i] != null) row('EMA 9', ind.ema9[i].toFixed(inst.digits), Math.sign(ind.ema9[i] - c) * -1);
    if (ind.ema21[i] != null) row('EMA 21', ind.ema21[i].toFixed(inst.digits), Math.sign(ind.ema21[i] - c) * -1);
    if (ind.ema50[i] != null) row('EMA 50', ind.ema50[i].toFixed(inst.digits), Math.sign(ind.ema50[i] - c) * -1);
    if (ind.sma200[i] != null) row('SMA 200', ind.sma200[i].toFixed(inst.digits), Math.sign(ind.sma200[i] - c) * -1);
    if (ind.rsi[i] != null) row('RSI (14)', ind.rsi[i].toFixed(1), (ind.rsi[i] - 50) / 50);
    if (ind.stoch.k[i] != null) row('%K / %D', ind.stoch.k[i].toFixed(1) + ' / ' + (ind.stoch.d[i] || 0).toFixed(1), (ind.stoch.k[i] - 50) / 50);
    if (ind.macd.macd[i] != null) row('MACD', (ind.macd.macd[i] * Math.pow(10, inst.pipDecimals)).toFixed(1) + ' pip', Math.sign(ind.macd.histogram[i]));
    if (ind.macd.histogram[i] != null) row('MACD istogr.', (ind.macd.histogram[i] * Math.pow(10, inst.pipDecimals)).toFixed(1) + ' pip', ind.macd.histogram[i] / (a.atr * 0.9));
    if (ind.bb.upper[i] != null) {
      row('Bollinger sup.', ind.bb.upper[i].toFixed(inst.digits), -(ind.bb.percentB[i] - 0.5));
      row('Bollinger inf.', ind.bb.lower[i].toFixed(inst.digits), -(ind.bb.percentB[i] - 0.5));
      row('%B', ind.bb.percentB[i].toFixed(2), -(ind.bb.percentB[i] - 0.5) * 2);
    }
    if (ind.atr[i] != null) row('ATR (14)', ind.atr[i].toFixed(inst.digits), 0);
    if (ind.adx[i] != null) row('ADX (14)', ind.adx[i].toFixed(1), ind.adx[i] > 25 ? 0.5 : -0.2);
    if (ind.volumeSma[i] != null && ind.volumeSma[i] > 0) {
      const vr = ind.volumes[i] / ind.volumeSma[i];
      row('Volumi vs media', vr.toFixed(2) + 'x', (vr - 1) * Math.sign(ind.closes[i] - ind.closes[i - 1] || 1));
    } else if (state.source === 'real' && state.feedInfo && !state.feedInfo.hasVolume) {
      row('Volumi vs media', 'n.d.', 0);
    }

    $('indTable').querySelector('tbody').innerHTML = rows.join('');
  }

  function renderForecast() {
    const a = state.analysis;
    const inst = state.instrument;
    $('fcHorizonLabel').textContent = 'orizzonte ' + a.horizon + ' candele ' + state.tf;

    const tiles = [
      { k: 'Prob. rialzo', v: (a.probabilityUp * 100).toFixed(1) + '%', tone: a.probabilityUp > 0.5 ? 'pos' : 'neg' },
      { k: 'Prob. ribasso', v: (a.probabilityDown * 100).toFixed(1) + '%', tone: a.probabilityDown > 0.5 ? 'neg' : '' },
      { k: 'Chiusura attesa', v: (a.price + a.expectedMove).toFixed(inst.digits), tone: a.expectedMove >= 0 ? 'pos' : 'neg' },
      { k: 'Movimento atteso', v: signed(pip(a.expectedMove, inst), 1) + ' pip', tone: a.expectedMove >= 0 ? 'pos' : 'neg' },
      { k: 'Interno 1\u03c3', v: (a.atr * Math.sqrt(a.horizon) * 1.10 / a.price * 100).toFixed(2) + '%', tone: '' },
      { k: 'Regime', v: a.trendRegime > 0.6 ? 'Trend' : a.trendRegime < 0.3 ? 'Laterale' : 'Misto', tone: '' }
    ];

    $('fcSummary').innerHTML = tiles.map(function (t) {
      return '<div class="fc-tile"><div class="k">' + t.k + '</div><div class="v ' + (t.tone || '') + '">' + t.v + '</div></div>';
    }).join('');

    const rows = a.levels.map(function (l) {
      const upW = Math.round(l.pUp * 100), dnW = Math.round(l.pDn * 100);
      return '' +
        '<div class="lvl">' +
          '<span class="dim">+' + l.multiple + ' ATR</span>' +
          '<div class="lvl-bar"><div class="lvl-fill" style="width:' + upW + '%"></div></div>' +
          '<span class="num pos">' + upW + '% <small class="dim">' + l.up.toFixed(inst.digits) + '</small></span>' +
        '</div>' +
        '<div class="lvl">' +
          '<span class="dim">-' + l.multiple + ' ATR</span>' +
          '<div class="lvl-bar"><div class="lvl-fill" style="width:' + dnW + '%;background:linear-gradient(90deg,rgba(242,85,90,.35),rgba(242,85,90,.75))"></div></div>' +
          '<span class="num neg">' + dnW + '% <small class="dim">' + l.down.toFixed(inst.digits) + '</small></span>' +
        '</div>';
    }).join('');

    $('fcLevels').innerHTML =
      '<p class="dim" style="margin:0 0 4px;font-size:.72rem">Probabilit\u00e0 di toccare ciascun livello entro ' +
      a.horizon + ' candele (modello a random walk con drift, banda 1\u03c3 = ' + a.atr.toFixed(inst.digits) +
      ' per barra)</p>' + rows;
  }

  function renderContext() {
    const a = state.analysis;
    const inst = state.instrument;
    const candles = state.series.candles;
    const now = new Date();
    const hUtc = now.getUTCHours();

    const sessions = [];
    if (hUtc >= 21 || hUtc < 6) sessions.push('Sydney');
    if (hUtc >= 0 && hUtc < 9) sessions.push('Tokyo');
    if (hUtc >= 7 && hUtc < 16) sessions.push('Londra');
    if (hUtc >= 12 && hUtc < 21) sessions.push('New York');

    // media ATR a 50 barre per confronto
    const atrSeries = a.indicators.atr.slice(-50).filter(function (v) { return v != null; });
    const atrAvg = atrSeries.reduce(function (x, y) { return x + y; }, 0) / (atrSeries.length || 1);
    const volRatio = a.atr / atrAvg;

    const window100 = candles.slice(-100);
    const hi = Math.max.apply(null, window100.map(function (c) { return c.high; }));
    const lo = Math.min.apply(null, window100.map(function (c) { return c.low; }));
    const posInRange = (a.price - lo) / (hi - lo);

    const items = [
      ['\ud83d\udd52', 'Sessione attiva', sessions.length ? sessions.join(' + ') : 'Nessuna sessione principale'],
      ['\ud83d\udcca', 'Volatilit\u00e0 vs media 50', volRatio.toFixed(2) + 'x ' + (volRatio > 1.3 ? '(espansione)' : volRatio < 0.75 ? '(compressione)' : '(stabile)')],
      ['\ud83d\udccf', 'Posizione nel range 100 barre', (posInRange * 100).toFixed(0) + '% (' + lo.toFixed(inst.digits) + ' \u2013 ' + hi.toFixed(inst.digits) + ')'],
      ['\ud83d\udd01', 'Spread tipico', inst.spread.toFixed(1) + ' pip \u00b7 tipo ' + inst.type],
      ['\ud83d\udcc5', 'Giorno di contrattazione', now.toLocaleDateString('it-IT', { weekday: 'long' })],
      ['\ud83e\udded', 'Forza del trend (ADX)', a.adx.toFixed(1) + (a.adx > 25 ? ' \u2014 trend definito' : a.adx < 18 ? ' \u2014 mercato laterale' : ' \u2014 direzione incerta')]
    ];

    $('contextList').innerHTML = items.map(function (it) {
      return '<li><span>' + it[0] + '</span><span class="dim" style="min-width:150px">' + it[1] + '</span><span>' + it[2] + '</span></li>';
    }).join('');
  }

  /* ------------------------------ confluenza ------------------------------ */
  const DIR_LABEL = { BUY: 'ACQUISTO', SELL: 'VENDITA', NEUTRAL: 'NEUTRO' };

  function scoreColor(v) {
    return v > 0.08 ? 'var(--up)' : v < -0.08 ? 'var(--down)' : 'var(--dim)';
  }

  function renderConfluence() {
    const c = state.confluence;
    if (!c) return;
    // I tre studi dell'app restano sempre visibili, con gli stessi nomi usati nel
    // report: analisi tecnica, analisi SMC e sentiment di mercato. Quando uno studio
    // non entra nel verdetto (il sentiment, con i dati reali di una sola coppia) il
    // suo riquadro lo dichiara invece di sparire: il verdetto resta sui modelli
    // affidabili, ma nessuno studio viene nascosto all'utente.
    const active = {};
    c.parts.forEach(function (p) { active[p.name] = true; });
    const studies = [
      { name: 'Tecnico', label: 'Analisi tecnica', short: 'analisi tecnica',
        dir: state.analysis.direction, score: state.analysis.score },
      { name: 'SMC', label: 'Analisi SMC', short: 'SMC',
        dir: state.smc.signal, score: state.smc.score },
      { name: 'Sentiment', label: 'Sentiment di mercato', short: 'sentiment',
        dir: state.sentiment ? state.sentiment.direction : 'NEUTRAL',
        score: state.sentiment ? state.sentiment.score : 0 }
    ];

    // Intestazione: elenca i tre studi e segnala quelli fuori dal verdetto.
    $('confStamp').textContent = studies.map(function (s) {
      return active[s.name] ? s.short : '(' + s.short + ' escluso dal verdetto)';
    }).join(' \u00b7 ');

    $('confGrid').innerHTML = studies.map(function (s) {
      const used = !!active[s.name];
      const dir = used ? s.dir : 'NEUTRAL';
      const color = used ? scoreColor(s.score) : 'var(--dim)';
      const pos = (s.score + 1) / 2 * 100;
      const fillLeft = s.score >= 0 ? 50 : 50 + s.score * 50;
      const fillW = Math.abs(s.score) * 50;
      return '' +
        '<div class="conf-item' + (used ? '' : ' excluded') + '">' +
          '<div class="name"><span>' + s.label + '</span><span style="color:' +
            (used ? color : 'var(--warn)') + '">' + (used ? DIR_LABEL[dir] : 'escluso') + '</span></div>' +
          '<div class="val" style="color:' + color + '">' + signed(s.score, 3) + '</div>' +
          '<div class="conf-bar" style="color:' + color + '">' +
            '<b style="left:' + fillLeft + '%;width:' + fillW + '%;background:' + color + '"></b>' +
            '<i style="left:' + pos + '%"></i>' +
          '</div>' +
          (used ? '' : '<div class="conf-note">' + c.excludedReason + '</div>') +
        '</div>';
    }).join('');

    const v = $('confVerdict');
    v.className = 'conf-verdict ' + (c.direction === 'BUY' ? 'buy' : c.direction === 'SELL' ? 'sell' : 'neutral');
    v.innerHTML = '<span class="tag-big">' + DIR_LABEL[c.direction] + '</span>' +
      '<span>Score combinato <b class="mono">' + signed(c.score, 3) + '</b> \u00b7 confidenza ' +
      (c.confidence * 100).toFixed(0) + '% \u00b7 ' + c.count + '/' + c.parts.length + ' modelli concordi</span>' +
      '<span class="dim">' + c.text + '</span>';
  }

  /* ------------------------------ SMC ------------------------------ */
  function renderSmc() {
    const s = state.smc;
    if (!s) return;
    const inst = state.instrument;
    const d = inst.digits;

    $('smcStamp').textContent = s.swings.length + ' swing \u00b7 ' + s.structure.events.length +
      ' eventi \u00b7 ' + s.orderBlocks.length + ' OB \u00b7 ' + s.fvgs.length + ' FVG \u00b7 ' +
      s.liquidity.length + ' pool';

    const struct = $('smcBias').parentElement;
    struct.className = 'smc-structure ' + (s.direction === 1 ? 'bull' : 'bear');
    $('smcBias').textContent = s.biasLabel + ' \u00b7 ' + signed(s.score, 3);
    const ev = s.structure.lastEvent;
    $('smcEvent').textContent = ev
      ? ev.type + ' ' + (ev.dir === 1 ? 'rialzista' : 'ribassista') + ' su ' + ev.level.toFixed(d) +
        ' (' + (s.lastIndex - ev.index) + ' barre fa), ' + s.structure.consecutive + ' rotture consecutive'
      : 'nessun evento di struttura rilevato';

    // banda premio / sconto
    const r = s.range;
    $('pdMarker').style.left = (r.position * 100) + '%';
    const ote = $('pdOte');
    if (r.span > 0) {
      ote.style.left = ((r.ote.bottom - r.low) / r.span * 100) + '%';
      ote.style.width = (Math.abs(r.ote.top - r.ote.bottom) / r.span * 100) + '%';
    }
    $('pdText').textContent = 'Prezzo al ' + (r.position * 100).toFixed(0) + '% \u00b7 ' +
      r.low.toFixed(d) + ' - ' + r.high.toFixed(d) + ' \u00b7 ' +
      (r.inDiscount ? 'sconto' : 'premio') + (r.inOte ? ' (dentro l\u2019OTE)' : '') +
      ' \u00b7 equilibrio ' + r.equilibrium.toFixed(d);

    function zoneRow(cls, tag, range, status, statusCls) {
      return '<li><span class="zt ' + cls + '">' + tag + '</span>' +
        '<span class="zr">' + range + '</span>' +
        '<span class="zs ' + (statusCls || '') + '">' + status + '</span></li>';
    }

    // order block: i tre piu' recenti ancora validi
    const obs = s.orderBlocks.filter(function (z) { return z.status !== 'invalidated'; }).slice(-3).reverse();
    $('obList').innerHTML = obs.length ? obs.map(function (z) {
      return zoneRow(z.kind === 'bullish' ? 'bull' : 'bear',
        (z.kind === 'bullish' ? 'OB \u2191' : 'OB \u2193'),
        z.bottom.toFixed(d) + ' \u2013 ' + z.top.toFixed(d),
        z.status === 'fresh' ? 'nuovo' : 'testato',
        z.status === 'fresh' ? 'fresh' : '');
    }).join('') : '<li class="empty">Nessun order block attivo in questo momento</li>';

    const fvgs = s.fvgs.filter(function (z) { return z.status !== 'invalidated'; }).slice(-3).reverse();
    $('fvgList').innerHTML = fvgs.length ? fvgs.map(function (z) {
      return zoneRow(z.kind === 'bullish' ? 'bull' : 'bear',
        (z.kind === 'bullish' ? 'FVG \u2191' : 'FVG \u2193'),
        z.bottom.toFixed(d) + ' \u2013 ' + z.top.toFixed(d),
        z.filled ? 'riempito ' + (z.penetration * 100).toFixed(0) + '%' : 'aperto',
        z.filled ? '' : 'fresh');
    }).join('') : '<li class="empty">Nessuno squilibrio aperto</li>';

    // liquidita': fino a due pool per lato, prima quelli non ancora presi;
    // la freccia indica la POSIZIONE rispetto al prezzo, il tipo (massimi o
    // minimi uguali) e' riportato nello stato
    function pickLiquidity(list, fromEnd) {
      const ordered = list.filter(function (l) { return !l.taken; })
        .concat(list.filter(function (l) { return l.taken; }));
      return fromEnd ? ordered.slice(-2).reverse() : ordered.slice(0, 2);
    }
    const liqRows = pickLiquidity(s.liquidity.filter(function (l) { return l.price > s.price; }), false)
      .concat(pickLiquidity(s.liquidity.filter(function (l) { return l.price < s.price; }), true));
    $('liqList').innerHTML = liqRows.length ? liqRows.map(function (l) {
      const state = l.taken ? 'presa' : (l.sweptAt != null ? 'sweep' : 'intatta');
      return zoneRow('liq', (l.price > s.price ? 'LIQ \u2191' : 'LIQ \u2193'),
        l.price.toFixed(d) + ' (x' + l.members + ')',
        (l.kind === 'buy-side' ? 'max' : 'min') + ' \u00b7 ' + state,
        l.taken ? 'invalidated' : (l.sweptAt != null ? '' : 'fresh'));
    }).join('') : '<li class="empty">Nessun massimo/minimo uguale rilevato</li>';

    // piano operativo SMC
    const p = s.plan;
    const cells = [
      { k: 'Scenario', v: p.direction === 1 ? 'LONG' : 'SHORT', hi: true,
        n: p.inZone ? 'prezzo gi\u00e0 nella zona' : 'attesa del ritracciamento' },
      { k: 'Ingresso limite', v: p.limitEntry.toFixed(d),
        n: p.entryZone ? 'zona ' + p.entryZone.bottom.toFixed(d) + ' \u2013 ' + p.entryZone.top.toFixed(d) : 'area di sconto/premio' },
      { k: 'Stop', v: p.stop.toFixed(d), n: signed(pip(p.stop - p.marketEntry, inst), 1) + ' pip dal prezzo' },
      { k: 'TP1 (equilibrio)', v: p.tp1.toFixed(d), n: signed(pip(p.tp1 - p.marketEntry, inst), 1) + ' pip' },
      { k: 'TP2 (liquidit\u00e0)', v: p.tp2.toFixed(d),
        n: p.targetLiquidity ? p.targetLiquidity.members + ' massimi/minimi uguali' : 'estremo del range' },
      { k: 'Rapporto R:R', v: num(p.rr, 2) + ' : 1', n: 'rischio ' +
        Math.abs(pip(p.stop - p.marketEntry, inst)).toFixed(1) + ' pip' }
    ];
    $('smcPlan').innerHTML = cells.map(function (c) {
      return '<div class="cell' + (c.hi ? ' hi' : '') + '"><div class="k">' + c.k + '</div>' +
        '<div class="v">' + c.v + '</div><div class="n">' + c.n + '</div></div>';
    }).join('');

    const list = $('smcReasons');
    list.innerHTML = '';
    s.reasons.forEach(function (r2) {
      const li = document.createElement('li');
      li.className = r2.tone;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = r2.tone === 'bull' ? '\u25b2' : r2.tone === 'bear' ? '\u25bc' : '\u25cf';
      const span = document.createElement('span');
      span.textContent = r2.text;
      li.appendChild(dot);
      li.appendChild(span);
      list.appendChild(li);
    });
  }

  /* ------------------------------ sentiment ------------------------------ */
  function renderSentiment() {
    const s = state.sentiment;
    if (!s) return;
    const barColor = function (v) { return v >= 62 ? 'var(--up)' : v <= 38 ? 'var(--down)' : 'rgba(120,150,200,.85)'; };

    $('sentStamp').textContent = 'aggiornato alle ' + new Date().toLocaleTimeString('it-IT');

    // In modalità dati reali si spiega con chiarezza quale universo usa lo
    // studio: solo EUR/USD oppure anche il contesto simulato delle altre coppie.
    const scopeEl = $('sentScope');
    const simRow = $('simCtxRow');
    const simCheck = $('simCtx');
    if (simCheck) simCheck.checked = !!state.simContext;
    if (state.source === 'real' && s.scope) {
      simRow.style.display = 'block';
      if (state.simContext) {
        scopeEl.style.display = 'block';
        scopeEl.className = 'note small sent-scope warn';
        scopeEl.textContent = 'Il confronto fra valute include anche 13 coppie simulate: solo EUR/USD ha prezzi reali qui sotto.';
      } else if (s.scope.partial) {
        scopeEl.style.display = 'block';
        scopeEl.className = 'note small sent-scope warn';
        scopeEl.textContent = 'Dati reali solo per EUR/USD: la forza delle valute mette a confronto le due valute della coppia (le altre restano neutre) e il verdetto finale pesa analisi tecnica e SMC.';
      } else {
        scopeEl.style.display = 'none';
      }
    } else {
      scopeEl.style.display = 'none';
      simRow.style.display = 'none';
    }

    const badge = $('sentBadge');
    badge.className = 'sent-badge ' + (s.direction === 'BUY' ? 'buy' : s.direction === 'SELL' ? 'sell' : 'neutral');
    badge.querySelector('.sent-dir').textContent = s.bias;
    badge.querySelector('.sent-conf').textContent = s.symbol + ' \u00b7 score ' + signed(s.score, 3) +
      ' \u00b7 confidenza ' + (s.confidence * 100).toFixed(0) + '%';

    $('strengthTf').textContent = '5 / 20 / 60 ' + state.tf;
    $('strengthList').innerHTML = s.strength.list.map(function (c) {
      const w = Math.max(2, Math.round(c.score));
      return '<li>' +
        '<span class="cur">' + c.currency + '</span>' +
        '<span class="sbar"><i style="width:' + w + '%;background:' + barColor(c.score) + '"></i></span>' +
        '<span class="val">' + c.score.toFixed(0) + '</span>' +
        '<span class="chg ' + (c.change >= 0 ? 'pos' : 'neg') + '">' + signed(c.change, 2) + '%</span>' +
        '</li>';
    }).join('');

    const rt = s.retail;
    if (rt) {
      $('retailPair').textContent = s.symbol;
      $('retailLong').style.width = rt.longPct + '%';
      $('retailShort').style.width = rt.shortPct + '%';
      $('retailLabel').textContent = rt.longPct.toFixed(0) + '% long \u00b7 ' + rt.shortPct.toFixed(0) + '% short';
      $('retailNote').textContent = rt.contrarianText +
        '. Modello simulato: la percentuale riproduce il comportamento contro-tendenza tipico' +
        ' della folla (nessuna fonte dati di broker, valori indicativi).';
    }

    $('riskFill').style.left = s.risk.score + '%';
    $('riskList').innerHTML = [
      ['Regime', s.risk.label + ' (' + s.risk.score.toFixed(0) + '/100)'],
      ['Volatilit\u00e0', s.risk.volLabel + ' (' + s.risk.volRatio.toFixed(2) + 'x)'],
      ['Valute pro-cicliche', s.risk.riskCurrencies.toFixed(0) + '/100'],
      ['Valute rifugio', s.risk.havens.toFixed(0) + '/100']
    ].map(function (row) {
      return '<li><span class="k">' + row[0] + '</span><span class="v">' + row[1] + '</span></li>';
    }).join('');

    const top = s.institutional.list.slice(0, 3);
    const light = s.institutional.lightest;
    $('instList').innerHTML = top.map(function (i) {
      return '<li><span class="k">' + i.currency + ' netto long</span><span class="v ' +
        (i.extreme === 'long' ? 'extreme-long' : i.extreme === 'short' ? 'extreme-short' : '') + '">' +
        i.net.toFixed(0) + '% \u00b7 ' + (i.change >= 0 ? '+' : '') + i.change.toFixed(1) + '</span></li>';
    }).concat(['<li><span class="k">' + light.currency + ' (pi\u00f9 leggera)</span><span class="v ' +
      (light.extreme === 'short' ? 'extreme-short' : '') + '">' + light.net.toFixed(0) + '%</span></li>'])
      .join('');

    const list = $('sentReasons');
    list.innerHTML = '';
    s.reasons.forEach(function (r2) {
      const li = document.createElement('li');
      li.className = r2.tone;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = r2.tone === 'bull' ? '\u25b2' : r2.tone === 'bear' ? '\u25bc' : '\u25cf';
      const span = document.createElement('span');
      span.textContent = r2.text;
      li.appendChild(dot);
      li.appendChild(span);
      list.appendChild(li);
    });
  }

  /* ------------------------------ report divulgativo ------------------------------ */
  function isReportOpen() {
    const ov = $('reportOverlay');
    return ov && !ov.classList.contains('hidden');
  }

  /** Costruisce i dati del report a partire dallo stato corrente. */
  function buildReport() {
    if (!REP || !state.analysis || !state.smc || !state.sentiment || !state.confluence) return;
    state.report = REP.build({
      pair: state.pair,
      tf: state.tf,
      horizon: state.horizon,
      instrument: state.instrument,
      candles: state.series.candles,
      analysis: state.analysis,
      smc: state.smc,
      sentiment: state.sentiment,
      confluence: state.confluence,
      source: {
        mode: state.source,
        info: state.feedInfo,
        error: state.feedError
      }
    });
  }

  function renderReport() {
    if (!state.report) buildReport();
    const r = state.report;
    if (!r) return;
    $('reportSubtitle').textContent = r.pair + ' \u00b7 candele da ' + r.tfName +
      ' \u00b7 orizzonte ' + state.horizon + ' candele \u00b7 generato alle ' +
      r.generatedAt.toLocaleTimeString('it-IT');
    $('reportBody').innerHTML = REP.toHtml(r);
  }

  function openReport() {
    renderReport();
    const ov = $('reportOverlay');
    ov.classList.remove('hidden');
    ov.scrollTop = 0;
    $('reportBody').scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }

  function closeReport() {
    $('reportOverlay').classList.add('hidden');
    document.body.style.overflow = '';
  }

  function flashButton(btn, text) {
    const original = btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = original; }, 1500);
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* copia non disponibile */ }
    document.body.removeChild(ta);
    done();
  }

  function copyReport() {
    if (!state.report) return;
    const text = REP.toText(state.report);
    const ok = function () { flashButton($('reportCopy'), '\u2713 Copiato'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { fallbackCopy(text, ok); });
    } else {
      fallbackCopy(text, ok);
    }
  }

  function downloadReport() {
    if (!state.report) return;
    const blob = new Blob([REP.toText(state.report)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'report-' + state.pair.replace('/', '-') + '-' + state.tf + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function renderBacktest() {
    const bt = state.backtest;
    if (!bt) return;
    const stats = [
      { k: 'Operazioni', v: bt.count },
      { k: 'Hit rate', v: (bt.winRate * 100).toFixed(1) + '%' },
      { k: 'Media per trade', v: signed(bt.avgR, 3) + ' R' },
      { k: 'Profit factor', v: isFinite(bt.profitFactor) ? bt.profitFactor.toFixed(2) : '\u221e' },
      { k: 'Guadagno medio', v: '+' + bt.avgWin.toFixed(2) + ' R' },
      { k: 'Perdita media', v: '\u2212' + bt.avgLoss.toFixed(2) + ' R' },
      { k: 'R totali', v: signed(bt.totalR, 2) + ' R' },
      { k: 'Max drawdown', v: '\u2212' + bt.maxDrawdown.toFixed(2) + ' R' }
    ];
    $('btStats').innerHTML = stats.map(function (s) {
      return '<div class="stat"><div class="k">' + s.k + '</div><div class="v">' + s.v + '</div></div>';
    }).join('');
    drawBacktestChart();
  }

  function drawBacktestChart() {
    const bt = state.backtest;
    const color = bt && bt.totalR >= 0 ? '#18c98a' : '#f2555a';
    window.drawEquityCurve($('equity'), bt ? bt.equity : null, color);
  }

  /* ------------------------------ watchlist ------------------------------ */
  function renderWatchlist() {
    const ul = $('watchlist');
    if (!state.marketCache.length) buildMarketCache();

    const rows = state.marketCache.map(function (e) {
      return {
        symbol: e.symbol,
        price: e.price.toFixed(e.instrument.digits),
        score: e.score,
        dir: e.score > 0.08 ? 'BUY' : e.score < -0.08 ? 'SELL' : 'NEU',
        chg: e.chg,
        simulated: !!e.simulated
      };
    });

    rows.sort(function (a, b) { return b.score - a.score; });

    ul.innerHTML = rows.map(function (r) {
      const tone = r.dir === 'BUY' ? 'pos' : r.dir === 'SELL' ? 'neg' : 'dim';
      return '' +
        '<li data-pair="' + r.symbol + '" class="' + (r.symbol === state.pair ? 'active' : '') + '">' +
          '<span>' + r.symbol + (r.simulated ? ' <small class="dim sim-tag">sim</small>' : '') +
            ' <small class="dim">' + signed(r.chg, 2) + '%</small></span>' +
          '<span class="wl-price">' + r.price + '</span>' +
          '<span class="wl-score ' + tone + '">' + r.dir + ' ' + signed(r.score, 2) + '</span>' +
        '</li>';
    }).join('');

    Array.prototype.forEach.call(ul.querySelectorAll('li'), function (li) {
      li.addEventListener('click', function () {
        state.pair = li.dataset.pair;
        $('pairSelect').value = state.pair;
        refresh(false);
        markActiveWatchlist();
      });
    });
  }

  function markActiveWatchlist() {
    Array.prototype.forEach.call($('watchlist').querySelectorAll('li'), function (li) {
      li.classList.toggle('active', li.dataset.pair === state.pair);
    });
  }

  /* ------------------------------ registro operazioni ------------------------------ */
  function loadJournal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      state.journal = raw ? JSON.parse(raw) : [];
    } catch (e) {
      state.journal = [];
    }
  }

  function persistJournal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.journal));
    } catch (e) { /* storage non disponibile */ }
  }

  function saveTrade() {
    const a = state.analysis;
    const inst = state.instrument;
    if (a.direction === 'NEUTRAL') {
      alert('Il segnale \u00e8 neutro: attendi un\u2019indicazione direzionale prima di registrare un\u2019operazione.');
      return;
    }
    state.journal.unshift({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      time: Date.now(),
      pair: state.pair,
      tf: state.tf,
      digits: inst.digits,
      dir: a.direction,
      entry: a.price,
      tp: a.target,
      sl: a.stop,
      conf: a.confidence,
      score: a.score,
      horizon: a.horizon,
      status: 'APERTO'
    });
    persistJournal();
    renderJournal();
  }

  function renderJournal() {
    const body = $('journalBody');
    if (state.journal.length === 0) {
      body.innerHTML = '<tr class="empty-row"><td colspan="10">Nessuna operazione registrata. ' +
        'Apri un segnale e premi \u00abRegistra trade virtuale\u00bb per annotarlo qui.</td></tr>';
      $('journalSummary').textContent = '';
      return;
    }
    body.innerHTML = state.journal.map(function (t) {
      const tone = t.dir === 'BUY' ? 'pos' : 'neg';
      const statusClass = t.status === 'VINTO' ? 'pos' : t.status === 'PERSO' ? 'neg' : 'dim';
      return '' +
        '<tr data-id="' + t.id + '">' +
          '<td>' + new Date(t.time).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</td>' +
          '<td>' + t.pair + '</td>' +
          '<td>' + t.tf + '</td>' +
          '<td class="' + tone + '">' + t.dir + '</td>' +
          '<td>' + t.entry.toFixed(t.digits) + '</td>' +
          '<td>' + t.tp.toFixed(t.digits) + '</td>' +
          '<td>' + t.sl.toFixed(t.digits) + '</td>' +
          '<td>' + (t.conf * 100).toFixed(0) + '%</td>' +
          '<td class="' + statusClass + '">' + t.status + '</td>' +
          '<td>' +
            '<button class="del ok" title="Chiudi in profitto">&#10003;</button>' +
            '<button class="del ko" title="Chiudi in perdita">&#10007;</button>' +
            '<button class="del rm" title="Elimina">&times;</button>' +
          '</td>' +
        '</tr>';
    }).join('');

    Array.prototype.forEach.call(body.querySelectorAll('button.ok'), function (b) {
      b.addEventListener('click', function () { setStatus(b.closest('tr').dataset.id, 'VINTO'); });
    });
    Array.prototype.forEach.call(body.querySelectorAll('button.ko'), function (b) {
      b.addEventListener('click', function () { setStatus(b.closest('tr').dataset.id, 'PERSO'); });
    });
    Array.prototype.forEach.call(body.querySelectorAll('button.rm'), function (b) {
      b.addEventListener('click', function () {
        const id = b.closest('tr').dataset.id;
        state.journal = state.journal.filter(function (t) { return t.id !== id; });
        persistJournal();
        renderJournal();
      });
    });

    const closed = state.journal.filter(function (t) { return t.status !== 'APERTO'; });
    const wins = closed.filter(function (t) { return t.status === 'VINTO'; }).length;
    $('journalSummary').textContent = state.journal.length + ' operazioni \u00b7 ' +
      (state.journal.length - closed.length) + ' aperte \u00b7 ' +
      (closed.length ? 'hit rate ' + (wins / closed.length * 100).toFixed(0) + '%' : 'nessuna chiusa');
  }

  function setStatus(id, status) {
    state.journal.forEach(function (t) { if (t.id === id) t.status = status; });
    persistJournal();
    renderJournal();
  }

  /* ------------------------------ orologio ------------------------------ */
  function startClock() {
    function upd() {
      const now = new Date();
      $('clock').textContent = now.toLocaleTimeString('it-IT') + ' \u00b7 UTC ' +
        now.toLocaleTimeString('it-IT', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
    }
    upd();
    setInterval(upd, 1000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
