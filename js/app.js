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
    news: null,             // payload notizie + calendario dal ponte
    newsStamp: 0,           // quando è arrivato l'ultimo payload valido
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
      fetchNews().then(function () { renderNews(); renderDashboard(); });
    });
    // il grafico/partitura vive in tab che possono essere nascostre:
    // il gestore tab richiede il ridisegno all'attivazione
    Ui.Tabs.init(function () { repaintPanels(); });

    // Notizie e calendario: il ponte tiene una cache di 5 minuti, quindi un
    // ciclo di 5 minuti è la cadenza giusta (indipendente dai dati candele).
    setInterval(function () {
      fetchNews().then(function (ok) { if (ok) { renderNews(); renderDashboard(); } });
    }, 5 * 60 * 1000);

    // collegamento diretto: index.html#report apre subito il report
    if (location.hash === '#report') openReport();

    // Aggiornamento automatico della watchlist e dello studio di sentiment
    setInterval(function () { if (state.live) tick(); }, 2500);
    setInterval(function () {
      if (!state.live) return;
      buildMarketCache();
      renderWatchlist();
      recomputeSentiment();
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
      recomputeSentiment();
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
      repaintPanels();
    });
  }

  /** Ridisegna tutti i canvas, anche quelli in tab nascoste (le quali non
   *  hanno larghezza da layout: si disegna a fallback e, all'attivazione della
   *  tab, il callback dei Tabs lo richiama con la dimensione reale). */
  function repaintPanels() {
    chart.draw();
    drawBacktestChart();
    drawMacdStrip();
    drawDashSpark();
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
    // Se lo studio reale (COT/VIX/DXY) è attivo NON si ricalcola quello
    // simulato: si riapplica il payload già scaricato alle candele fresche
    // (retail e momentum si aggiornano, i percentile COT restano validi).
    // Altrimenti studio simulato a universo ridotto, dichiarato.
    recomputeSentiment();

    // Sentiment reale (CFTC COT + VIX + DXY): arriva dopo le candele e, se
    // disponibile, sostituisce lo studio a universo ridotto e rientra nel
    // verdetto. Se la fonte non risponde, resta quello simulato dichiarato.
    refreshRealSentiment();

    // Il backtest è più oneroso: lo ricalcolo in modo differito
    if (btTimer) clearTimeout(btTimer);
    btTimer = setTimeout(function () {
      state.backtest = F.backtest(state.series.candles, state.instrument, state.horizon, { window: 250 });
      renderBacktest();
      repaintPanels();
    }, 30);

    chart.setData(state.series, state.analysis, state.instrument, state.smc);
    renderDashboard();
    repaintPanels();
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

  /** Ricalcola lo studio di sentiment preservando quello reale.
   *  Con lo studio reale (COT/VIX/DXY) attivo non si torna mai al simulato:
   *  il payload già scaricato viene riapplicato alle candele correnti. */
  function recomputeSentiment() {
    if (state.source === 'real' && state.sentimentPayload &&
        state.sentiment && state.sentiment.real) {
      applyRealSentiment(state.sentimentPayload);
    } else {
      state.sentiment = SEN.analyze(state.marketCache, state.pair, state.instrument, sentimentOpts());
      state.confluence = computeConfluence();
    }
  }

  /* ------------------------------ notizie e calendario ------------------------------ */
  let newsBusy = false;
  const NEWS_RETRY_MS = 60 * 1000;     // su errore si riprova al giro dopo
  function fetchNews(force) {
    const now = Date.now();
    if (state.news && state.newsStamp && now - state.newsStamp < 3 * 60 * 1000 && !force) {
      return Promise.resolve(true);              // il ponte tiene 5 minuti: no spam
    }
    if (newsBusy) return Promise.resolve(false);
    newsBusy = true;
    return FX.loadNews({ force: !!force }).then(function (payload) {
      newsBusy = false;
      state.news = payload;
      state.newsStamp = Date.now();
      state.newsError = null;
      return true;
    }).catch(function (err) {
      newsBusy = false;
      state.newsError = err && err.message ? err.message : String(err);
      setTimeout(function () { if (state.newsError) fetchNews(true); }, NEWS_RETRY_MS);
      return false;
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Rendering del pannello notizie e calendario. */
  function renderNews() {
    const listEl = $('newsList'), calEl = $('calendarList'), noteEl = $('newsNote');
    if (!listEl || !calEl) return;               // pannello assente (pagine di test)
    const n = state.news;
    if (!n) {
      listEl.innerHTML = '';
      calEl.innerHTML = '';
      noteEl.style.display = '';
      noteEl.textContent = 'Notizie ' + (state.newsError ? 'non disponibili: ' + state.newsError :
        'in caricamento dal ponte dati…');
      return;
    }
    const stamp = $('newsStamp');
    if (stamp) {
      const when = new Date(n.fetchedAt).toLocaleTimeString('it-IT');
      stamp.textContent = 'aggiornato alle ' + when + (n.stale ? ' \u00b7 dati non aggiornati' : '');
    }
    const srcNote = $('newsSourceNote');
    if (srcNote) {
      const okNum = n.sourcesOk || 1;
      srcNote.textContent = 'fonte: ponte locale (' + okNum + ' fonti attive)';
    }
    noteEl.style.display = 'none';

    // calendario: i prossimi eventi in evidenza, i passati attenuati
    const now = Date.now();
    const cal = n.calendar || [];
    const upcoming = cal.filter(function (e) { return e.time >= now; });
    const past = cal.filter(function (e) { return e.time < now; }).slice(-4);
    const next = upcoming[0];
    const fmtWhen = function (t) {
      const d = new Date(t);
      const sameDay = new Date().toDateString() === d.toDateString();
      return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' }) +
        ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) +
        (sameDay ? '' : '');
    };
    const countdown = function (t) {
      const ms = t - now;
      if (ms <= 0) return '';
      const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
      return h > 0 ? 'tra ' + h + 'h' + (m ? ' ' + m + 'm' : '') : 'tra ' + m + 'm';
    };
    calEl.innerHTML = cal.map(function (e) {
      const impact = e.impact === 'High' ? 'high' : e.impact === 'Medium' ? 'med' : 'low';
      const cls = e === next ? 'next' : (e.time < now ? 'past' : '');
      const extra = e.forecast || e.previous ?
        ' (' + (e.forecast ? 'atteso: ' + esc(e.forecast) : '') +
        (e.forecast && e.previous ? ', ' : '') +
        (e.previous ? 'prec.: ' + esc(e.previous) : '') + ')' : '';
      return '<li class="' + cls + '">' +
        '<span class="impact ' + impact + '">' + esc(e.impact) + '</span>' +
        '<span class="ccy">' + esc(e.country) + '</span>' +
        '<span class="ev">' + esc(e.title) + extra + '</span>' +
        '<span class="when">' + fmtWhen(e.time) + (e === next ? '<br><span class="count">' + countdown(e.time) + '</span>' : '') + '</span>' +
        '</li>';
    }).join('') || '<li class="past"><span class="ev">nessun evento pertinente questa settimana</span></li>';

    // notizie: prima quelle marcate pertinenti EUR/USD, poi le altre
    const news = n.news || [];
    const relevant = news.filter(function (x) { return x.eurusd; });
    const rest = news.filter(function (x) { return !x.eurusd; });
    const ordered = relevant.concat(rest).slice(0, 22);
    const fmtTime = function (t) { return new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }); };
    listEl.innerHTML = ordered.map(function (x) {
      const d = new Date(x.time);
      const day = new Date().toDateString() === d.toDateString() ? '' :
        ' ' + d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
      return '<li' + (x.eurusd ? ' class="relevant"' : '') + '>' +
        '<span class="nsrc' + (x.kind === 'bank' ? ' bank' : '') + '">' + esc(x.source) + '</span>' +
        '<span class="ntime">' + fmtTime(x.time) + day + '</span>' +
        '<a href="' + esc(x.link) + '" target="_blank" rel="noopener noreferrer">' + esc(x.title) + '</a>' +
        '</li>';
    }).join('');
  }

  /** Sentiment reale: CFTC (COT), VIX e indice del dollaro dal ponte.
   *  Si aggiorna al massimo ogni 5 minuti (il COT è settimanale; il VIX
   *  quotidiano non cambia più spesso delle candele). In caso di errore lo
   *  studio resta quello simulato a universo ridotto, dichiarato. */
  const SENTIMENT_REFRESH_MS = 5 * 60 * 1000;
  let sentimentBusy = false;
  /** Applica un payload di sentiment reale allo stato corrente e ridisegna. */
  function applyRealSentiment(payload) {
    state.sentimentPayload = payload;
    state.sentiment = SEN.analyzeReal(payload, state.series.candles, state.instrument,
      { symbol: state.pair, indicators: state.analysis.indicators });
    state.sentimentRealError = null;
    state.confluence = computeConfluence();
  }
  function refreshRealSentiment(force) {
    if (state.source !== 'real') return Promise.resolve(null);
    const now = Date.now();
    const throttled = !force && state.sentimentPayload &&
      now - state.lastSentimentFetch < SENTIMENT_REFRESH_MS;
    // Con payload già in mano si riapplica subito: retail e momentum seguono
    // le candele appena arrivate senza aspettare la rete.
    if (state.sentimentPayload && state.sentiment && state.sentiment.real) {
      applyRealSentiment(state.sentimentPayload);
      if (throttled) { renderSentiment(); renderConfluence(); return Promise.resolve(state.sentiment); }
    }
    if (sentimentBusy) return Promise.resolve(null);
    sentimentBusy = true;
    return FX.loadSentiment(state.pair, { force: !!force }).then(function (payload) {
      sentimentBusy = false;
      state.lastSentimentFetch = Date.now();
      if (state.source !== 'real') return null;     // nel frattempo è cambiata la modalità
      applyRealSentiment(payload);
      renderSentiment();
      renderConfluence();
      buildReport();
      if (isReportOpen()) renderReport();
      return state.sentiment;
    }).catch(function (err) {
      sentimentBusy = false;
      state.sentimentRealError = err && err.message ? err.message : String(err);
      console.warn('sentiment reale non disponibile: ' + state.sentimentRealError +
        (err && err.stack ? '\n' + err.stack.split('\n').slice(0, 3).join('\n') : ''));
      return null;                                   // resta lo studio simulato
    });
  }

  /** Verdetto di confluenza. In modalità reale ridotta il sentiment pesa solo se
   *  ha un universo completo di cambi (cioè se è attivo anche il contesto simulato)
   *  oppure se lo studio è costruito su fonti reali indipendenti (COT/VIX/DXY). */
  function computeConfluence() {
    const sen = state.sentiment;
    const structuralReliable = state.source !== 'real' || state.simContext ||
      !sen || !sen.scope || !sen.scope.partial || !!sen.real;
    return SEN.confluence(state.analysis.score, state.smc.score, sen ? sen.score : 0,
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
    recomputeSentiment();

    chart.setData(state.series, state.analysis, inst, state.smc);
    renderDashboard();
    repaintPanels();
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

  /* -------------------- dashboard: scala, sparkline, evento -------------------- */
  function renderDashboard() {
    const a = state.analysis;
    const s = state.smc;
    const sen = state.sentiment;
    const inst = state.instrument;
    if (!a || !s || !inst || !state.series) return;

    // scala operativa: piano tecnico + piano SMC su uno stesso asse di prezzo
    const items = [];
    const seen = {};
    function step(price, label, text, cls) {
      const key = price.toFixed(inst.digits);
      if (seen[key]) return;
      seen[key] = true;
      items.push({ price: price, label: label, text: text, cls: cls });
    }
    step(a.price, 'Prezzo attuale', a.price.toFixed(inst.digits), 'entry');
    step(a.stop, 'Stop tecnico', a.stop.toFixed(inst.digits), 'sl');
    step(a.target, 'Obiettivo tecnico', a.target.toFixed(inst.digits), 'tp');
    if (s.plan) {
      step(s.plan.stop, 'Invalidazione SMC', s.plan.stop.toFixed(inst.digits), 'extra');
      step(s.plan.tp1, 'TP1 \u2013 equilibrio', s.plan.tp1.toFixed(inst.digits), 'extra');
      step(s.plan.tp2, 'Liquidit\u00e0 (TP2)', s.plan.tp2.toFixed(inst.digits), 'tp2');
    }
    // la zona rossa copre la distanza prezzo-stop, la verde il verso l'obiettivo
    Ui.ladder($('dashLadder'), items, {
      risk: [a.price, a.stop],
      gain: [a.price, a.target]
    }, 'h');   // nella dashboard la scala è orizzontale

    // sparkline del moto recente + kpi di contesto
    const candles = state.series.candles;
    const closes = candles.slice(-40).map(function (cn) { return cn.close; });
    const tone = a.direction === 'BUY' ? '#18c98a' : a.direction === 'SELL' ? '#f2555a' : '#5a8fd0';
    Ui.spark($('dashSpark'), closes, tone);
    const prev = candles[candles.length - Math.min(21, candles.length - 1)].close;
    const chg = (a.price - prev) / prev * 100;
    const regime = a.trendRegime > 0.6 ? 'Trend' : a.trendRegime < 0.3 ? 'Laterale' : 'Misto';
    $('dashPriceKpi').innerHTML = [
      { k: 'Prezzo', v: a.price.toFixed(inst.digits), tone: '' },
      { k: 'Su 20 candele', v: signed(chg, 2) + '%', tone: chg >= 0 ? 'pos' : 'neg' },
      { k: 'ATR %', v: a.atrPct.toFixed(2) + '%', tone: '' },
      { k: 'Regime', v: regime, tone: '' }
    ].map(function (t) {
      return '<div class="kpi"><div class="k">' + t.k + '</div><div class="v ' + t.tone + '">' + t.v + '</div></div>';
    }).join('');

    // tre modelli con la stessa scala -1/+1
    const dial = function (score, label, kind) {
      const col = score >= 0.12 ? '#18c98a' : score <= -0.12 ? '#f2555a' : '#5a8fd0';
      return '<div class="gauge-tile">' +
        Ui.dialSvg(score, -1, 1, [
          { from: -1, to: 0, color: '#f2555a' },
          { from: 0, to: 1, color: '#18c98a' }
        ], col) +
        '<div class="gt-v">' + signed(score, 2) + '</div>' +
        '<div class="gt-l">' + label + '</div>' +
        '</div>';
    };
    $('dashDials').innerHTML =
      dial(a.score, 'Analisi tecnica') +
      dial(s.score, 'Smart Money Concepts') +
      dial(sen ? sen.score : 0, 'Sentiment');

    renderDashEvent();
  }

  /** Prossimo evento ad alto impatto dal calendario del ponte. */
  function renderDashEvent() {
    const box = $('dashEvent'), note = $('dashEventNote');
    if (!box) return;
    const cal = (state.news && state.news.calendar) || [];
    const now = Date.now();
    const ev = cal.filter(function (e) {
      return e.time >= now;
    })[0];
    if (!ev) {
      box.innerHTML = '<div class="kpi"><div class="k">Agenda</div><div class="v">\u2014</div></div>';
      if (note) {
        note.style.display = '';
        note.textContent = state.news
          ? 'Nessun evento in arrivo questa settimana nel calendario pertinente.'
          : 'Calendario ancora in caricamento dal ponte\u2026';
      }
      return;
    }
    const when = new Date(ev.time);
    const ms = ev.time - now;
    const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
    const impact = ev.impact === 'High' ? 'neg' : 'neu';
    box.innerHTML =
      '<div class="kpi"><div class="k">Evento</div><div class="v" style="font-size:.8rem">' + ev.title + '</div></div>' +
      '<div class="kpi"><div class="k">Impatto</div><div class="v ' + impact + '">' + ev.impact + ' \u00b7 ' + ev.country + '</div></div>' +
      '<div class="kpi"><div class="k">Data</div><div class="v" style="font-size:.8rem">' +
      when.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</div></div>' +
      '<div class="kpi"><div class="k">Countdown</div><div class="v">' +
      (h > 0 ? h + 'h' + (m ? ' ' + m + 'm' : '') : m + 'm') + '</div></div>';
    if (note) {
      note.style.display = '';
      note.textContent = 'Fonte: calendario ForexFactory (mirror faireconomy.media). ' +
        (ev.forecast ? 'Ateso ' + ev.forecast + ', ' : '') +
        (ev.previous ? 'precedente ' + ev.previous + '.' : '');
    }
  }

  function drawDashSpark() {
    if (!state.series) return;
    const closes = state.series.candles.slice(-40).map(function (c) { return c.close; });
    const a = state.analysis;
    const tone = a && a.direction === 'BUY' ? '#18c98a' : a && a.direction === 'SELL' ? '#f2555a' : '#5a8fd0';
    Ui.spark($('dashSpark'), closes, tone);
  }

  function drawMacdStrip() {
    const a = state.analysis;
    if (!a || !a.indicators) return;
    const hist = a.indicators.macd.histogram.slice(-30);
    Ui.histogram($('macdHist'), hist);
  }

  function renderDashEventDone() {}

  function renderIndicators() {
    const a = state.analysis;
    const ind = a.indicators;
    const inst = state.instrument;
    const i = a.index;
    const c = ind.closes[i];
    const d = inst.digits;
    const tiles = [];

    /* pila delle medie: grafica sopra/sotto il prezzo */
    const stack = [
      ['EMA 9', ind.ema9[i]], ['EMA 21', ind.ema21[i]],
      ['EMA 50', ind.ema50[i]], ['SMA 200', ind.sma200[i]]
    ].filter(function (r) { return r[1] != null; });
    const vals = stack.map(function (r) { return r[1]; }).concat([c]);
    const dMin = Math.min.apply(null, vals), dMax = Math.max.apply(null, vals);
    const span = (dMax - dMin) || c * 1e-6;
    const emaRows = stack.map(function (r) {
      const above = c >= r[1];
      const bw = Ui.clamp(Math.abs(c - r[1]) / span * 1.05, 0.05, 1) * 100;
      return '<div class="ema-row ' + (above ? 'up' : 'dn') + '">' +
        '<span>' + r[0] + '</span>' +
        '<span class="bar"><i style="width:' + bw.toFixed(0) + '%"></i></span>' +
        '<span class="s">' + r[1].toFixed(d) + '</span>' +
        '<span class="s">' + signed(pip(c - r[1], inst), 1) + ' pip ' +
        (above ? 'sopra' : 'sotto') + '</span></div>';
    }).join('');
    tiles.push('<div class="gauge-tile">' +
      '<div class="ema-stack">' + emaRows + '</div>' +
      '<div class="gt-v">' + c.toFixed(d) + '</div>' +
      '<div class="gt-l">prezzo vs medie</div>' +
      tagFor(stack.filter(function (r) { return c >= r[1]; }).length / stack.length * 2 - 1) +
      '</div>');

    const scoreColor = function (s) { return s >= 0.15 ? '#18c98a' : s <= -0.15 ? '#f2555a' : '#5a8fd0'; };

    if (ind.rsi[i] != null) {
      const s = (ind.rsi[i] - 50) / 50;
      tiles.push('<div class="gauge-tile">' +
        Ui.dialSvg(ind.rsi[i], 0, 100, [
          { from: 0, to: 30, color: '#18c98a' },
          { from: 30, to: 70, color: 'rgba(120,150,200,.5)' },
          { from: 70, to: 100, color: '#f2555a' }
        ], scoreColor(s)) +
        '<div class="gt-v">' + ind.rsi[i].toFixed(1) + '</div>' +
        '<div class="gt-l">RSI (14)</div>' + tagFor(s) + '</div>');
    }
    if (ind.stoch.k[i] != null) {
      const s = (ind.stoch.k[i] - 50) / 50;
      tiles.push('<div class="gauge-tile">' +
        Ui.dialSvg(ind.stoch.k[i], 0, 100, [
          { from: 0, to: 20, color: '#18c98a' },
          { from: 20, to: 80, color: 'rgba(120,150,200,.5)' },
          { from: 80, to: 100, color: '#f2555a' }
        ], scoreColor(s)) +
        '<div class="gt-v">' + ind.stoch.k[i].toFixed(1) + ' / ' + (ind.stoch.d[i] || 0).toFixed(1) + '</div>' +
        '<div class="gt-l">Stochastic %K/%D</div>' + tagFor(s) + '</div>');
    }
    if (ind.adx[i] != null) {
      tiles.push('<div class="gauge-tile">' +
        Ui.dialSvg(ind.adx[i], 0, 60, [
          { from: 0, to: 20, color: 'rgba(120,150,200,.5)' },
          { from: 20, to: 25, color: '#d9a34a' },
          { from: 25, to: 60, color: '#18c98a' }
        ], ind.adx[i] > 25 ? '#18c98a' : '#5a8fd0') +
        '<div class="gt-v">' + ind.adx[i].toFixed(1) + '</div>' +
        '<div class="gt-l">ADX (14) ' + (ind.adx[i] > 25 ? '- trend definito' : ind.adx[i] < 20 ? '- laterale' : '- debole') + '</div>' +
        '</div>');
    }

    /* barre a zone */
    if (ind.bb.percentB[i] != null) {
      const pb = ind.bb.percentB[i];
      const left = Ui.clamp(pb, -0.25, 1.25) / 2.5 * 100;  // scala -0,25..1,25 centrata su 0,5
      tiles.push('<div class="gauge-tile">' +
        '<div class="meter" style="margin-top:14px">' +
        '<span class="meter-zone" style="position:absolute;inset:0">' +
        '<i style="width:40%;background:rgba(24,201,138,.4)"></i>' +
        '<i style="width:40%;background:rgba(120,150,200,.35)"></i>' +
        '<i style="width:20%;background:rgba(242,85,90,.45)"></i>' +
        '</span>' +
        '<span style="position:absolute;top:-3px;left:' + left.toFixed(1) + '%;width:3px;bottom:-3px;background:#fff;border-radius:2px"></span>' +
        '(<b style="position:absolute;left:' + left.toFixed(1) + '%;top:16px;color:#fff;font-size:0"></b>)' +
        '</div>' +
        '<div class="gt-v">' + pb.toFixed(2) + '</div>' +
        '<div class="gt-l">%B \u2013 -0,25 \u2192 1,25 (sotto banda / dentro / sopra)</div>' +
        tagFor(-(pb - 0.5) * 2) + '</div>');
    }

    if (ind.atr[i] != null) {
      const hist = ind.atr.slice(Math.max(0, i - 49), i + 1).filter(function (v) { return v != null && isFinite(v); });
      const meanAtr = hist.length ? hist.reduce(function (x, y) { return x + y; }, 0) / hist.length : ind.atr[i];
      const ratio = ind.atr[i] / meanAtr;
      const w = Ui.clamp(ratio / 2, 0, 1) * 100;
      tiles.push('<div class="gauge-tile">' +
        '<div class="meter" style="margin-top:14px">' +
        '<span class="meter-zone" style="position:absolute;inset:0">' +
        '<i style="width:50%;background:rgba(90,143,208,.4)"></i>' +
        '<i style="width:50%;background:rgba(217,163,74,.45)"></i>' +
        '</span>' +
        '<span style="position:absolute;top:-3px;left:' + w.toFixed(1) + '%;width:3px;bottom:-3px;background:#fff"></span>' +
        '</div>' +
        '<div class="gt-v">' + ind.atr[i].toFixed(d) + ' (' + ratio.toFixed(2) + 'x)</div>' +
        '<div class="gt-l">ATR (14) vs media di 50 barre</div>' +
        '</div>');
    }

    if (ind.volumeSma[i] != null && ind.volumeSma[i] > 0) {
      const vr = ind.volumes[i] / ind.volumeSma[i];
      const w = Ui.clamp(vr / 2, 0, 1) * 100;
      tiles.push('<div class="gauge-tile">' +
        '<div class="meter" style="margin-top:14px">' +
        '<span class="meter-zone" style="position:absolute;inset:0">' +
        '<i style="width:50%;background:rgba(90,143,208,.4)"></i>' +
        '<i style="width:50%;background:rgba(217,163,74,.45)"></i>' +
        '</span>' +
        '<span style="position:absolute;top:-3px;left:' + w.toFixed(1) + '%;width:3px;bottom:-3px;background:#fff"></span>' +
        '</div>' +
        '<div class="gt-v">' + vr.toFixed(2) + 'x</div>' +
        '<div class="gt-l">volumi vs media</div>' +
        '</div>');
    } else if (state.source === 'real' && state.feedInfo && !state.feedInfo.hasVolume) {
      tiles.push('<div class="gauge-tile"><div class="gt-v">n.d.</div><div class="gt-l">volumi vs media<br>(non offerti sulla coppia)</div></div>');
    }

    if (ind.roc5[i] != null) {
      const unit = a.atr / c;
      const v = Ui.clamp(ind.roc5[i] / (unit * 3), -1, 1);
      const from = v < 0 ? 50 + v * 50 : 50, width = Math.abs(v) * 50;
      tiles.push('<div class="gauge-tile">' +
        '<div class="meter" style="margin-top:14px">' +
        '<span class="meter-zone" style="position:absolute;inset:0">' +
        '<i style="width:50%;background:rgba(242,85,90,.4)"></i>' +
        '<i style="width:50%;background:rgba(24,201,138,.4)"></i>' +
        '</span>' +
        '<span style="position:absolute;top:-3px;left:50%;width:3px;bottom:-3px;background:rgba(255,255,255,.35)"></span>' +
        '<span style="position:absolute;top:-3px;left:' + from.toFixed(1) + '%;width:' + width.toFixed(1) + '%;bottom:-3px;background:#5a8fd0;border-radius:2px"></span>' +
        '</div>' +
        '<div class="gt-v">' + (ind.roc5[i] * 100).toFixed(2) + '%</div>' +
        '<div class="gt-l">ROC su 5 barre</div>' +
        tagFor(ind.roc5[i] / (unit * 3)) + '</div>');
    }

    if (ind.sma200[i] != null) {
      const dist = (c - ind.sma200[i]) / a.atr;
      const v = Ui.clamp(dist / 4, -1, 1);
      const from = v < 0 ? 50 + v * 50 : 50, width = Math.abs(v) * 50;
      tiles.push('<div class="gauge-tile">' +
        '<div class="meter" style="margin-top:14px">' +
        '<span class="meter-zone" style="position:absolute;inset:0">' +
        '<i style="width:50%;background:rgba(242,85,90,.4)"></i>' +
        '<i style="width:50%;background:rgba(24,201,138,.4)"></i>' +
        '</span>' +
        '<span style="position:absolute;top:-3px;left:50%;width:3px;bottom:-3px;background:rgba(255,255,255,.35)"></span>' +
        '<span style="position:absolute;top:-3px;left:' + from.toFixed(1) + '%;width:' + width.toFixed(1) + '%;bottom:-3px;background:#5a8fd0;border-radius:2px"></span>' +
        '</div>' +
        '<div class="gt-v">' + signed(dist, 2) + ' ATR</div>' +
        '<div class="gt-l">bias SMA200</div>' +
        tagFor(dist / 4) + '</div>');
    }

    if (ind.macd.histogram[i] != null) {
      tiles.push('<div class="gauge-tile">' +
        '<canvas id="macdHist" class="macd-strip"></canvas>' +
        '<div class="gt-v">' + (ind.macd.histogram[i] * Math.pow(10, inst.pipDecimals)).toFixed(1) + ' pip</div>' +
        '<div class="gt-l">MACD istogramma (30 barre)</div>' +
        tagFor(ind.macd.histogram[i] / (a.atr * 0.9)) + '</div>');
    }

    $('indBlock').innerHTML = tiles.join('');
    drawMacdStrip();

    /* il dettaglio numerico resta disponibile in tabella ripiegata */
    const rows = [];
    function row(label, value, score) {
      rows.push('<tr><td>' + label + '</td><td>' + value + '</td><td>' + tagFor(score) + '</td></tr>');
    }
    row('Prezzo', c.toFixed(d), a.score);
    if (ind.ema9[i] != null) row('EMA 9', ind.ema9[i].toFixed(d), Math.sign(ind.ema9[i] - c) * -1);
    if (ind.ema21[i] != null) row('EMA 21', ind.ema21[i].toFixed(d), Math.sign(ind.ema21[i] - c) * -1);
    if (ind.ema50[i] != null) row('EMA 50', ind.ema50[i].toFixed(d), Math.sign(ind.ema50[i] - c) * -1);
    if (ind.sma200[i] != null) row('SMA 200', ind.sma200[i].toFixed(d), Math.sign(ind.sma200[i] - c) * -1);
    if (ind.rsi[i] != null) row('RSI (14)', ind.rsi[i].toFixed(1), (ind.rsi[i] - 50) / 50);
    if (ind.stoch.k[i] != null) row('%K / %D', ind.stoch.k[i].toFixed(1) + ' / ' + (ind.stoch.d[i] || 0).toFixed(1), (ind.stoch.k[i] - 50) / 50);
    if (ind.macd.macd[i] != null) row('MACD', (ind.macd.macd[i] * Math.pow(10, inst.pipDecimals)).toFixed(1) + ' pip', Math.sign(ind.macd.histogram[i]));
    if (ind.macd.histogram[i] != null) row('MACD istogr.', (ind.macd.histogram[i] * Math.pow(10, inst.pipDecimals)).toFixed(1) + ' pip', ind.macd.histogram[i] / (a.atr * 0.9));
    if (ind.bb.upper[i] != null) {
      row('Bollinger sup.', ind.bb.upper[i].toFixed(d), -(ind.bb.percentB[i] - 0.5));
      row('Bollinger inf.', ind.bb.lower[i].toFixed(d), -(ind.bb.percentB[i] - 0.5));
      row('%B', ind.bb.percentB[i].toFixed(2), -(ind.bb.percentB[i] - 0.5) * 2);
    }
    if (ind.atr[i] != null) row('ATR (14)', ind.atr[i].toFixed(d), 0);
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

    /* mappa della liquidita', scala operativa e timeline di struttura */
    if (window.Ui) {
      Ui.levelMap($('liqMap'), s.liquidity, s.price, d);
      const ladderItems = [
        { price: s.price, label: 'Prezzo attuale', text: s.price.toFixed(d), cls: 'entry' },
        { price: p.stop, label: 'Scenario invalidato', text: p.stop.toFixed(d), cls: 'sl' },
        { price: p.tp1, label: 'TP1 \u2013 equilibrio', text: p.tp1.toFixed(d), cls: 'extra' },
        { price: p.tp2, label: 'Liquidit\u00e0 (TP2)', text: p.tp2.toFixed(d), cls: 'tp2' },
        { price: p.limitEntry, label: 'Ingresso limite', text: p.limitEntry.toFixed(d), cls: 'extra' }
      ];
      Ui.ladder($('smcLadder'), ladderItems, {
        risk: [s.price, p.stop],
        gain: [s.price, p.tp2]
      }, 'h');   // come nel cruscotto: scala orizzontale
      Ui.timeline($('structTimeline'), s.structure.events, s.lastIndex, 50);
    }

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
    // studio. Con il sentiment reale (COT/VIX/DXY) la fonte è dichiarata;
    // senza, si spiega l'universo ridotto delle sole coppie reali.
    const scopeEl = $('sentScope');
    const simRow = $('simCtxRow');
    const simCheck = $('simCtx');
    if (simCheck) simCheck.checked = !!state.simContext;
    if (state.source === 'real' && s.scope) {
      if (s.real) {
        simRow.style.display = 'none';
        scopeEl.style.display = 'block';
        scopeEl.className = 'note small sent-scope';
        scopeEl.textContent = 'Sentiment su dati reali: posizionamento CFTC (COT del ' +
          (s.scope.cotAsOf || '') + '), VIX e indice del dollaro. Il pannello retail resta ' +
          'un modello simulato dichiarato ed è fuori dal punteggio.';
      } else {
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

    $('strengthTf').textContent = s.real
      ? 'COT CFTC \u00b7 percentile ' + (s.scope.cotAsOf || '')
      : '5 / 20 / 60 ' + state.tf;
    $('strengthList').innerHTML = s.strength.list.map(function (c) {
      const w = Math.max(2, Math.round(c.score));
      return '<li>' +
        '<span class="cur">' + c.currency + '</span>' +
        '<span class="sbar"><i style="width:' + w + '%;background:' + barColor(c.score) + '"></i></span>' +
        '<span class="val">' + c.score.toFixed(0) + '</span>' +
        '<span class="chg ' + (c.change >= 0 ? 'pos' : 'neg') + '">' + signed(c.change, 2) + '</span>' +
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

    if (s.risk && isFinite(s.risk.score)) {
      $('riskFill').style.left = s.risk.score + '%';
      const riskRows = [
        ['Regime', s.risk.label + ' (' + s.risk.score.toFixed(0) + '/100)'],
        ['Volatilit\u00e0', s.risk.volLabel + ' (' + s.risk.volRatio.toFixed(2) + 'x)']
      ];
      if (isFinite(s.risk.riskCurrencies)) riskRows.push(['Valute pro-cicliche', s.risk.riskCurrencies.toFixed(0) + '/100']);
      if (isFinite(s.risk.havens)) riskRows.push(['Valute rifugio', s.risk.havens.toFixed(0) + '/100']);
      if (s.real && isFinite(s.risk.vix)) riskRows.push(['VIX', s.risk.vix.toFixed(1) + ' (percentile ' + s.risk.vixPercentile.toFixed(0) + ')']);
      $('riskList').innerHTML = riskRows.map(function (row) {
        return '<li><span class="k">' + row[0] + '</span><span class="v">' + row[1] + '</span></li>';
      }).join('');
    }

    const top = s.institutional.list.slice(0, 3);
    const light = s.institutional.lightest;
    const instTitle = $('instTitle');
    if (instTitle) {
      instTitle.textContent = s.real
        ? 'COT CFTC del ' + (s.institutional.asOf || '') + ' (percentile 5 anni, reale)'
        : '(COT-style, simulato)';
    }
    $('instList').innerHTML = top.map(function (i) {
      return '<li><span class="k">' + i.currency + (s.real ? ' (COT)' : ' netto long') +
        '</span><span class="v ' +
        (i.extreme === 'long' ? 'extreme-long' : i.extreme === 'short' ? 'extreme-short' : '') + '">' +
        i.net.toFixed(0) + (s.real ? ' percentile' : '%') + ' \u00b7 ' + (i.change >= 0 ? '+' : '') + i.change.toFixed(1) + '</span></li>';
    }).concat(['<li><span class="k">' + light.currency + (s.real ? ' (meno affollata)' : ' (pi\u00f9 leggera)') +
      '</span><span class="v ' +
      (light.extreme === 'short' ? 'extreme-short' : '') + '">' + light.net.toFixed(0) + (s.real ? ' percentile' : '%') + '</span></li>'])
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
