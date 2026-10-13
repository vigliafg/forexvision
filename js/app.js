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
  const DIV = window.Divergence;
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
    divergence: null,      // divergenze prezzo / oscillatori
    pivots: null,          // pivot point del periodo precedente
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
  let divTimer = null;

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
    bindCloseWatch();
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

  /* ------------------------ chiusura della finestra ------------------------- */
  /*
   * Se la pagina e' stata aperta dal lanciatore (`avvia.sh` / `avvia.bat`),
   * l'indirizzo porta un token (`?chiudi=...`): quando la finestra si chiude
   * l'app lo dichiara al ponte, che si ferma, e il lanciatore esce. Il token
   * evita che una pagina qualsiasi possa fermare il ponte, e il ponte aspetta
   * qualche secondo prima di spegnersi: un ricaricamento manda lo stesso
   * segnale, ma le prime richieste della pagina ricaricata lo annullano.
   */
  function bindCloseWatch() {
    const found = /[?&]chiudi=([\w.-]+)/.exec(location.search || '');
    if (!found) return;
    const token = encodeURIComponent(found[1]);

    // 1. La finestra resta collegata al ponte finche' e' aperta: quando si
    //    chiude (o si chiude il browser) la connessione cade da sola, quindi il
    //    ponte lo sa anche se la pagina non fa in tempo a dire niente.
    if (window.EventSource) {
      const sessione = new EventSource('/api/sessione?token=' + token);
      sessione.onerror = function () {
        // un errore puo' essere un singhiozzo: se pero' il ponte non risponde
        // piu' non ha senso continuare a riprovare
        fetch('/api/status', { cache: 'no-store' }).catch(function () { sessione.close(); });
      };
    }

    // 2. Il segnale esplicito, per i browser che chiudono la pagina senza
    //    chiudere subito la connessione.
    if (!navigator.sendBeacon) return;
    const tell = function () {
      try { navigator.sendBeacon('/api/chiudi?token=' + token); } catch (e) { /* niente */ }
    };
    window.addEventListener('pagehide', tell);
    window.addEventListener('beforeunload', tell);
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
      if (e.key !== 'Escape') return;
      if (isHelpOpen()) { closeHelp(); return; }   // prima la finestra in primo piano
      if (isReportOpen()) closeReport();
    });

    // --- aiuto delle card: bottoni, chiusura e aggiornamento ---
    injectHelpButtons();
    $('helpClose').addEventListener('click', closeHelp);
    $('helpOverlay').addEventListener('click', function (e) {
      if (e.target === $('helpOverlay')) closeHelp();
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
    analyzeExtras();

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

    // Studio di efficacia delle divergenze: cammina la serie e verifica quante
    // volte il movimento e' andato nel verso del segnale (differito, come il
    // backtest, perche' piu' oneroso della sola lettura corrente).
    if (divTimer) clearTimeout(divTimer);
    divTimer = setTimeout(function () {
      state.divStudy = DIV.backtest(state.series.candles, state.analysis.indicators,
        state.instrument, {
          horizon: state.horizon, window: 300,
          swings: state.smc ? state.smc.swings : null, atr: state.analysis.atr
        });
      renderDivergence();
    }, 45);

    chart.setData(state.series, state.analysis, state.instrument, state.smc);
    chart.setExtras(state.divergence, state.pivots);
    renderDashboard();
    repaintPanels();
    renderHeader();
    renderSignal();
    renderConfluence();
    renderSmc();
    renderIndicators();
    renderTrendIndicators();
    renderDivergence();
    renderForecast();
    renderContext();
    renderSentiment();
    renderJournal();
    refreshButtonState();

    // report divulgativo: dati sempre pronti, finestra aggiornata se aperta
    buildReport();
    if (isReportOpen()) renderReport();
    // spiegazione della card: se e' aperta si aggiorna con i dati appena calcolati
    if (isHelpOpen()) renderHelp();
  }

  /** Divergenze e livelli di riferimento: due letture che dipendono dalle
   *  candele (e dai punti di swing gia' calcolati dallo studio SMC), quindi
   *  vanno ricalcolate a ogni aggiornamento come gli altri studi. */
  function analyzeExtras() {
    const candles = state.series.candles;
    const a = state.analysis;
    if (DIV) {
      state.divergence = DIV.analyze(candles, a.indicators, state.instrument, {
        lookback: 3,
        lastIndex: a.index,
        atr: a.atr,
        swings: state.smc ? state.smc.swings : null
      });
    }
    state.pivots = IND.pivotPoints(candles, D.TIMEFRAMES[state.tf].minutes);
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
  /**
   * Ridisegna tutto quello che mostra i numeri del sentiment: la card, il
   * verdetto, i quadranti della dashboard (che portano lo stesso punteggio
   * della card) e la spiegazione se e' aperta. Senza questo, un aggiornamento
   * del sentiment lasciava i quadranti fermi sul punteggio precedente.
   */
  function redrawSentimentPanels() {
    renderSentiment();
    renderConfluence();
    renderDashboard();
    if (isHelpOpen()) renderHelp();
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
      if (throttled) { redrawSentimentPanels(); return Promise.resolve(state.sentiment); }
    }
    if (sentimentBusy) return Promise.resolve(null);
    sentimentBusy = true;
    return FX.loadSentiment(state.pair, { force: !!force }).then(function (payload) {
      sentimentBusy = false;
      state.lastSentimentFetch = Date.now();
      if (state.source !== 'real') return null;     // nel frattempo è cambiata la modalità
      applyRealSentiment(payload);
      redrawSentimentPanels();
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
    analyzeExtras();

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
    chart.setExtras(state.divergence, state.pivots);
    renderDashboard();
    repaintPanels();
    renderHeader();
    renderSignal();
    renderConfluence();
    renderSmc();
    renderIndicators();
    renderTrendIndicators();
    renderDivergence();
    renderForecast();
    renderSentiment();
    // anche il contesto di mercato segue il tick: sessioni, volatilità
    // rispetto alla media e posizione nel range altrimenti resterebbero
    // fermi al refresh precedente mentre il resto della pagina si aggiorna
    renderContext();
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
    renderTrailingStop();
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

  function scoreColor(s) { return s >= 0.15 ? '#18c98a' : s <= -0.15 ? '#f2555a' : '#5a8fd0'; }

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
    /* indicatori di trend e inversione: le stesse voci delle tile */
    const cloudRow = cloudRead(ind, i, c);
    const sqRow = squeezeRead(ind, i);
    if (ind.plusDI[i] != null) {
      row('+DI / \u2212DI (14)', ind.plusDI[i].toFixed(1) + ' / ' + ind.minusDI[i].toFixed(1),
        (ind.plusDI[i] - ind.minusDI[i]) / Math.max(10, ind.plusDI[i] + ind.minusDI[i]));
    }
    if (ind.adxr[i] != null && ind.adx[i] != null) {
      row('ADXR (14)', ind.adxr[i].toFixed(1), (ind.adx[i] - ind.adxr[i]) / 6);
    }
    if (ind.superTrend && ind.superTrend.line[i] != null) row('SuperTrend (10\u00b73)', ind.superTrend.line[i].toFixed(d), ind.superTrend.dir[i]);
    if (ind.psar[i] != null) row('Parabolic SAR', ind.psar[i].toFixed(d), ind.psar[i] < c ? 1 : -1);
    if (cloudRow) {
      row('Ichimoku 9/26/52', 'Tenkan ' + cloudRow.tenkan.toFixed(d) + ' \u00b7 Kijun ' + cloudRow.kijun.toFixed(d) +
        ' \u00b7 ' + cloudRow.text, cloudRow.score);
    }
    if (ind.aroon.up[i] != null) {
      row('Aroon (25)', 'Up ' + ind.aroon.up[i].toFixed(0) + ' / Down ' + ind.aroon.down[i].toFixed(0), ind.aroon.osc[i] / 100);
    }
    if (ind.vortex.plus[i] != null) {
      row('Vortex (14)', 'VI+ ' + ind.vortex.plus[i].toFixed(2) + ' / VI\u2212 ' + ind.vortex.minus[i].toFixed(2),
        (ind.vortex.plus[i] - ind.vortex.minus[i]) / 2);
    }
    if (ind.cci[i] != null) row('CCI (20)', ind.cci[i].toFixed(1), -ind.cci[i] / 200);
    if (ind.stochRsi && ind.stochRsi.k[i] != null) {
      row('Stochastic RSI %K/%D', ind.stochRsi.k[i].toFixed(1) +
        (ind.stochRsi.d[i] != null ? ' / ' + ind.stochRsi.d[i].toFixed(1) : ''), (ind.stochRsi.k[i] - 50) / 50);
    }
    if (ind.choppiness[i] != null) {
      row('Choppiness Index (14)', ind.choppiness[i].toFixed(1),
        ind.choppiness[i] < 38 ? 0.6 : ind.choppiness[i] > 62 ? -0.6 : 0);
    }
    if (ind.keltner && ind.keltner.upper[i] != null) {
      row('Keltner sup./inf.', ind.keltner.lower[i].toFixed(d) + ' / ' + ind.keltner.upper[i].toFixed(d),
        sqRow && sqRow.squeeze ? 0.2 : 0);
    }
    if (ind.linreg && ind.linreg.r2[i] != null) {
      row('Regressione (50)', 'R\u00b2 ' + ind.linreg.r2[i].toFixed(2) + ' \u00b7 ' +
        signed(pip(ind.linreg.slope[i], inst), 2) + ' pip/barra', Math.sign(ind.linreg.slope[i]) * ind.linreg.r2[i]);
    }

    $('indTable').querySelector('tbody').innerHTML = rows.join('');
  }

  /** Stop trailing del SuperTrend: dice se il livello che il trend offre come
   *  stop dinamico e' coerente con lo scenario operativo in corso. */
  function renderTrailingStop() {
    const el = $('planTrail');
    if (!el) return;
    const a = state.analysis;
    const inst = state.instrument;
    const st = a && a.indicators && a.indicators.superTrend;
    if (!a || !inst || !st || st.line[a.index] == null) {
      el.textContent = '\u2014';
      el.className = 'mono';
      return;
    }
    const line = st.line[a.index];
    const dir = st.dir[a.index];
    const allineato = (a.direction === 'BUY' && dir === 1) || (a.direction === 'SELL' && dir === -1);
    const verso = dir === 1 ? 'sopra il ribasso' : 'sotto il rialzo';
    el.textContent = line.toFixed(inst.digits) + '  (' + signed(pip(line - a.price, inst), 1) + ' pip' +
      (allineato ? '' : ', ' + verso) + ')';
    el.className = 'mono ' + (allineato ? 'pos' : '');
  }

  /* ------------- divergenze prezzo/oscillatori e pivot point ------------- */

  /**
   * Tabella dello studio di efficacia: quanti casi, quante volte il movimento
   * e' andato nel verso del segnale e rendimento medio in multipli di ATR, con
   * l'incertezza dell'intervallo di confidenza al 95%.
   */
  function divStudyHtml(study) {
    if (!study || !study.count) {
      return '<p class="dim small">Campionamento insufficiente: servono divergenze gia' +
        ' concluse dentro la finestra analizzata.</p>';
    }
    const rows = [];
    const row = function (label, st, group) {
      if (!st || !st.count) return;
      const pf = st.profitFactor === Infinity ? '\u221e' : st.profitFactor.toFixed(2);
      const cls = st.significant ? 'pos' : (st.avgR + st.ci95 < 0 ? 'neg' : '');
      rows.push('<tr' + (group ? ' class="group"' : '') + '>' +
        '<td>' + label + '</td><td>' + st.count + '</td>' +
        '<td>' + (st.hitRate * 100).toFixed(0) + '%</td>' +
        '<td class="' + cls + '">' + (st.avgR >= 0 ? '+' : '') + st.avgR.toFixed(2) + '</td>' +
        '<td>\u00b1' + Math.abs(st.ci95).toFixed(2) + '</td>' +
        '<td>' + pf + '</td></tr>');
    };
    row('tutte', study.all, true);
    row('regolari', study.byKind.regular);
    row('nascoste', study.byKind.hidden);
    Object.keys(study.byOsc || {}).forEach(function (k) { row(k, study.byOsc[k]); });
    const v = DIV.verdictOf(study.all);
    return '<table><thead><tr><th>Segnale</th><th>Casi</th><th>A favore</th>' +
      '<th>R medio</th><th>Incertezza</th><th>PF</th></tr></thead><tbody>' +
      rows.join('') + '</tbody></table>' +
      '<p class="verdict ' + v.level + '">' + v.text + '</p>';
  }

  /** Pannello con le divergenze rilevate e i livelli di riferimento: stesso
   *  contenuto sotto il grafico (tab Grafici) e nella tab Analisi tecnica. */
  function renderDivergence() {
    const div = state.divergence;
    const piv = state.pivots;
    const inst = state.instrument;
    const a = state.analysis;
    if (!inst || !a) return;
    const d = inst.digits;
    const score = div ? div.score : 0;
    const arrowOf = function (v) { return v > 0 ? '\u25b2' : v < 0 ? '\u25bc' : '\u25cf'; };
    const colorOf = function (v) { return v > 0 ? '#18c98a' : v < 0 ? '#f2555a' : '#5a8fd0'; };
    const tiles = [];

    // lettura complessiva delle divergenze
    if (div) {
      const n = div.items.length;
      tiles.push(trendTile({
        arrow: arrowOf(score), color: colorOf(score),
        value: n ? (div.bull + ' rialziste / ' + div.bear + ' ribassiste') : 'nessuna attiva',
        label: 'Divergenze (RSI \u00b7 MACD) \u2014 ' + div.text,
        tag: n ? tagFor(score) : '<span class="tag neu">NESSUNA</span>'
      }));
    }

    // posizione del prezzo rispetto al pivot centrale
    if (piv) {
      const p = piv.classic.p;
      const sopra = a.price >= p;
      tiles.push(trendTile({
        arrow: arrowOf(sopra ? 1 : -1), color: colorOf(sopra ? 1 : -1),
        value: p.toFixed(d) + '  (' + signed(pip(a.price - p, inst), 1) + ' pip)',
        label: 'Pivot point \u2014 prezzo ' + (sopra ? 'sopra' : 'sotto') + ' il livello centrale',
        tag: tagFor(sopra ? 0.4 : -0.4)
      }));
    }

    const listRows = (div && div.items.length) ? div.items.map(function (it) {
      const cls = it.dir > 0 ? 'bull' : 'bear';
      const tipo = it.kind === 'regular' ? '' : ' nasc.';
      const verso = it.dir > 0 ? '\u2191' : '\u2193';
      const estremo = it.extreme ? ' \u00b7 estremo' : '';
      return '<li>' +
        '<span class="zt ' + cls + '">' + it.osc + tipo + ' ' + verso + '</span>' +
        '<span class="zr">' + (it.dir > 0 ? 'minimo' : 'massimo') + ' ' + it.from.price.toFixed(d) +
        ' \u2192 ' + it.to.price.toFixed(d) + '</span>' +
        '<span class="zs">' + it.age + ' barre fa' + estremo + '</span></li>';
    }).join('') : '<li class="empty">Nessuna divergenza fra prezzo e oscillatori nella finestra recente</li>';

    const pivotRows = piv ? [
      ['R3', piv.classic.r3, 'neg'], ['R2', piv.classic.r2, 'neg'], ['R1', piv.classic.r1, 'neg'],
      ['Pivot', piv.classic.p, ''],
      ['S1', piv.classic.s1, 'pos'], ['S2', piv.classic.s2, 'pos'], ['S3', piv.classic.s3, 'pos']
    ].map(function (row) {
      return '<div class="kpi"><div class="k">' + row[0] + '</div>' +
        '<div class="v ' + row[2] + '">' + row[1].toFixed(d) + '</div></div>';
    }).join('') : '<div class="kpi"><div class="k">Pivot</div><div class="v">non disponibili</div></div>';

    const tilesHtml = tiles.join('');
    const sets = [
      { block: 'divBlock', list: 'divList', pivot: 'pivotGrid', stamp: 'divStamp', scope: 'divScope',
        pstamp: 'pivotStamp', study: 'divStudy', sscope: 'divStudyScope' },
      { block: 'divBlockChart', list: 'divListChart', pivot: 'pivotGridChart', stamp: 'divStampChart',
        scope: 'divScopeChart', pstamp: 'pivotStampChart', study: 'divStudyChart', sscope: 'divStudyScopeChart' }
    ];
    sets.forEach(function (s) {
      const block = $(s.block), list = $(s.list), pivot = $(s.pivot);
      if (block) block.innerHTML = tilesHtml;
      if (list) list.innerHTML = listRows;
      if (pivot) pivot.innerHTML = pivotRows;
      const stamp = $(s.stamp);
      if (stamp) {
        stamp.textContent = 'aggiornato alle ' + new Date().toLocaleTimeString('it-IT') +
          ' \u00b7 ' + (div ? div.items.length : 0) + ' divergenze';
      }
      const study = $(s.study);
      if (study) study.innerHTML = divStudyHtml(state.divStudy);
      const sscope = $(s.sscope);
      if (sscope) {
        // Tre stati distinti: studio non ancora calcolato, calcolato senza
        // casi, calcolato con casi. "in calcolo" significa solo il primo.
        sscope.textContent = state.divStudy
          ? (state.divStudy.count
              ? state.divStudy.count + ' casi su ' + state.divStudy.window + ' barre, esito a ' +
                state.divStudy.horizon + ' barre'
              : 'nessun caso misurabile nella finestra di ' + state.divStudy.window + ' barre')
          : 'in calcolo';
      }
      const scope = $(s.scope);
      if (scope) scope.textContent = 'RSI e MACD sui punti di swing frattali (3 barre)';
      const pstamp = $(s.pstamp);
      if (pstamp) {
        pstamp.textContent = piv
          ? 'dal periodo ' + piv.period + ' (max ' + piv.high.toFixed(d) + ' \u00b7 min ' + piv.low.toFixed(d) +
            ' \u00b7 chiusura ' + piv.close.toFixed(d) + ')'
          : 'periodo precedente non disponibile';
      }
    });
  }

  /* ---------------- indicatori di trend e di inversione ---------------- */

  /** Posizione del prezzo rispetto alla nuvola di Ichimoku (lettura causale). */
  function cloudRead(ind, i, price) {
    const ic = ind.ichimoku;
    if (!ic || ic.spanA[i] == null || ic.spanB[i] == null || ic.tenkan[i] == null || ic.kijun[i] == null) return null;
    const top = Math.max(ic.spanA[i], ic.spanB[i]);
    const bot = Math.min(ic.spanA[i], ic.spanB[i]);
    return {
      top: top, bot: bot,
      tenkan: ic.tenkan[i], kijun: ic.kijun[i], chikou: ic.chikou[i],
      bullCloud: ic.spanA[i] >= ic.spanB[i],
      text: price > top ? 'sopra la nuvola' : price < bot ? 'sotto la nuvola' : 'dentro la nuvola',
      score: price > top ? 1 : price < bot ? -1 : 0
    };
  }

  /** Squeeze di volatilita': bande di Bollinger compresse dentro Keltner. */
  function squeezeRead(ind, i) {
    if (!ind.keltner || !ind.bb || ind.keltner.upper[i] == null || ind.bb.upper[i] == null) return null;
    return { squeeze: ind.bb.upper[i] < ind.keltner.upper[i] && ind.bb.lower[i] > ind.keltner.lower[i] };
  }

  /** Tile di un indicatore: freccia direzionale oppure grafica, valore, nota,
   *  tag di giudizio. */
  function trendTile(o) {
    const head = o.svg ? o.svg
      : '<div style="font-size:1.45rem;line-height:1.2;color:' + (o.color || '#5a8fd0') + '">' + o.arrow + '</div>';
    return '<div class="gauge-tile">' + head +
      '<div class="gt-v">' + o.value + '</div>' +
      '<div class="gt-l">' + o.label + '</div>' +
      (o.tag || '') + '</div>';
  }

  /** Un solo blocco di tile, mostrato in due punti: sotto il grafico (tab
   *  Grafici) e sotto il segnale operativo (tab Analisi tecnica). */
  function renderTrendIndicators() {
    const a = state.analysis;
    const inst = state.instrument;
    if (!a || !a.indicators || !inst) return;
    const ind = a.indicators;
    const i = a.index;
    const d = inst.digits;
    const price = ind.closes[i];
    const atr = a.atr || 0;

    const BULL = '#18c98a', BEAR = '#f2555a', NEUTRAL = '#5a8fd0';
    const arrowOf = function (v) { return v > 0 ? '\u25b2' : v < 0 ? '\u25bc' : '\u25cf'; };
    const colorOf = function (v) { return v > 0 ? BULL : v < 0 ? BEAR : NEUTRAL; };
    const neuTag = function (t) { return '<span class="tag neu">' + t + '</span>'; };
    const tiles = [];

    // 1. SuperTrend: direzione e trailing stop
    if (ind.superTrend && ind.superTrend.line[i] != null) {
      const dir = ind.superTrend.dir[i];
      tiles.push(trendTile({
        arrow: arrowOf(dir), color: colorOf(dir),
        value: ind.superTrend.line[i].toFixed(d) + '  (' + signed(pip(price - ind.superTrend.line[i], inst), 1) + ' pip)',
        label: 'SuperTrend (ATR 10 \u00d7 3) \u2014 ' + (dir === 1 ? 'sostegno' : 'resistenza'),
        tag: tagFor(dir * 0.6)
      }));
    }

    // 2. Parabolic SAR: punti di inversione
    if (ind.psar && ind.psar[i] != null) {
      const s = ind.psar[i] < price ? 1 : -1;
      tiles.push(trendTile({
        arrow: arrowOf(s), color: colorOf(s),
        value: ind.psar[i].toFixed(d) + '  (' + (atr ? signed((price - ind.psar[i]) / atr, 2) + ' ATR' : '\u2014') + ')',
        label: 'Parabolic SAR (0,02 / 0,2) \u2014 ' + (s > 0 ? 'sotto il prezzo' : 'sopra il prezzo'),
        tag: tagFor(s * 0.5)
      }));
    }

    // 3. Ichimoku: nuvola, incrocio e conferma del ritardo
    const cloud = cloudRead(ind, i, price);
    if (cloud) {
      tiles.push(trendTile({
        arrow: arrowOf(cloud.score), color: colorOf(cloud.score),
        value: 'Kijun ' + cloud.kijun.toFixed(d) + '  (nuvola ' + cloud.bot.toFixed(d) + ' \u2013 ' + cloud.top.toFixed(d) + ')',
        label: 'Ichimoku 9/26/52 \u2014 prezzo ' + cloud.text +
          '<br>Tenkan ' + cloud.tenkan.toFixed(d) + ' \u00b7 nuvola ' + (cloud.bullCloud ? 'rialzista' : 'ribassista') +
          ' \u00b7 Chikou ' + (cloud.chikou > 0 ? '\u25b2' : '\u25bc'),
        tag: tagFor(cloud.score * 0.7)
      }));
    }

    // 4. DMI: +DI contro -DI
    if (ind.plusDI && ind.plusDI[i] != null) {
      const p = ind.plusDI[i], m = ind.minusDI[i];
      const s = p >= m ? 1 : -1;
      tiles.push(trendTile({
        arrow: arrowOf(s), color: colorOf(s),
        value: '+DI ' + p.toFixed(1) + ' / \u2212DI ' + m.toFixed(1),
        label: 'DMI (14) \u2014 ' + (s > 0 ? 'pressione rialzista' : 'pressione ribassista'),
        tag: tagFor((p - m) / Math.max(10, p + m))
      }));
    }

    // 5. ADXR: la tendenza si rafforza o si spegne?
    if (ind.adxr && ind.adxr[i] != null && ind.adx[i] != null) {
      tiles.push(trendTile({
        svg: Ui.dialSvg(ind.adxr[i], 0, 60, [
          { from: 0, to: 20, color: 'rgba(120,150,200,.5)' },
          { from: 20, to: 25, color: '#d9a34a' },
          { from: 25, to: 60, color: '#18c98a' }
        ], ind.adxr[i] > 25 ? BULL : NEUTRAL),
        value: ind.adxr[i].toFixed(1) + '  (ADX ' + ind.adx[i].toFixed(1) + ')',
        label: 'ADXR (14) \u2014 tendenza ' + (ind.adx[i] >= ind.adxr[i] ? 'in rafforzamento' : 'in esaurimento'),
        tag: tagFor((ind.adx[i] - ind.adxr[i]) / 6)
      }));
    }

    // 6. Aroon: da quante barre il massimo/minimo del periodo e' recente
    if (ind.aroon && ind.aroon.up[i] != null) {
      const up = ind.aroon.up[i], dn = ind.aroon.down[i];
      tiles.push(trendTile({
        svg: Ui.dialSvg(up, 0, 100, [
          { from: 0, to: 30, color: 'rgba(120,150,200,.35)' },
          { from: 30, to: 70, color: 'rgba(120,150,200,.22)' },
          { from: 70, to: 100, color: 'rgba(24,201,138,.55)' }
        ], up >= 70 ? BULL : dn >= 70 ? BEAR : NEUTRAL),
        value: 'Up ' + up.toFixed(0) + ' / Down ' + dn.toFixed(0),
        label: 'Aroon (25) \u2014 ' + (up >= 70 && dn <= 30 ? 'massimi ribassisti recenti'
          : dn >= 70 && up <= 30 ? 'minimi rialzisti recenti' : 'nessuna tendenza salda'),
        tag: tagFor(ind.aroon.osc[i] / 100)
      }));
    }

    // 7. Vortex: verso del flusso
    if (ind.vortex && ind.vortex.plus[i] != null) {
      const p = ind.vortex.plus[i], m = ind.vortex.minus[i];
      const s = p >= m ? 1 : -1;
      tiles.push(trendTile({
        arrow: arrowOf(s), color: colorOf(s),
        value: 'VI+ ' + p.toFixed(2) + ' / VI\u2212 ' + m.toFixed(2),
        label: 'Vortex (14) \u2014 flusso ' + (s > 0 ? 'rialzista' : 'ribassista'),
        tag: tagFor((p - m) / 2)
      }));
    }

    // 8. CCI: oscillatore di inversione
    if (ind.cci && ind.cci[i] != null) {
      const v = ind.cci[i];
      tiles.push(trendTile({
        svg: Ui.dialSvg(v, -200, 200, [
          { from: -200, to: -100, color: 'rgba(24,201,138,.55)' },
          { from: -100, to: 100, color: 'rgba(120,150,200,.4)' },
          { from: 100, to: 200, color: 'rgba(242,85,90,.55)' }
        ], scoreColor(-v / 200)),
        value: v.toFixed(1),
        label: 'CCI (20) \u2014 ' + (v > 100 ? 'ipercomprato' : v < -100 ? 'ipervenduto' : 'nella norma'),
        tag: tagFor(-v / 200)
      }));
    }

    // 9. Stochastic RSI
    if (ind.stochRsi && ind.stochRsi.k[i] != null) {
      const kv = ind.stochRsi.k[i], dv = ind.stochRsi.d[i];
      tiles.push(trendTile({
        svg: Ui.dialSvg(kv, 0, 100, [
          { from: 0, to: 20, color: '#18c98a' },
          { from: 20, to: 80, color: 'rgba(120,150,200,.5)' },
          { from: 80, to: 100, color: '#f2555a' }
        ], scoreColor((kv - 50) / 50)),
        value: 'K ' + kv.toFixed(1) + ' / D ' + (dv == null ? '\u2014' : dv.toFixed(1)),
        label: 'Stochastic RSI (14) \u2014 segnale di inversione pi\u00f9 tempestivo',
        tag: tagFor((kv - 50) / 50)
      }));
    }

    // 10. Choppiness Index: regime di mercato
    if (ind.choppiness && ind.choppiness[i] != null) {
      const ch = ind.choppiness[i];
      const label = ch < 38 ? 'trend definito' : ch > 62 ? 'mercato laterale' : 'carattere misto';
      tiles.push(trendTile({
        svg: Ui.dialSvg(ch, 0, 100, [
          { from: 0, to: 38, color: 'rgba(24,201,138,.5)' },
          { from: 38, to: 62, color: 'rgba(120,150,200,.4)' },
          { from: 62, to: 100, color: 'rgba(217,163,74,.6)' }
        ], ch < 38 ? BULL : ch > 62 ? '#d9a34a' : NEUTRAL),
        value: ch.toFixed(1),
        label: 'Choppiness Index (14) \u2014 ' + label,
        tag: neuTag(ch < 38 ? 'TENDENZA' : ch > 62 ? 'LATERALE' : 'MISTO')
      }));
    }

    // 11. Keltner e squeeze rispetto alle bande di Bollinger
    if (ind.keltner && ind.keltner.upper[i] != null) {
      const up = ind.keltner.upper[i], lo = ind.keltner.lower[i];
      const sq = squeezeRead(ind, i);
      const pos = Ui.clamp((price - lo) / ((up - lo) || 1), 0, 1) * 100;
      tiles.push(trendTile({
        svg: '<div class="meter" style="margin:16px 0 4px">' +
          '<span class="meter-zone" style="position:absolute;inset:0">' +
          '<i style="width:100%;background:rgba(90,143,208,.35)"></i></span>' +
          '<span style="position:absolute;top:-3px;left:' + pos.toFixed(1) + '%;width:3px;bottom:-3px;background:#fff"></span>' +
          '</div>',
        value: lo.toFixed(d) + ' \u2013 ' + up.toFixed(d),
        label: 'Keltner (20 \u00b7 2 ATR) \u2014 ' + (sq && sq.squeeze ? 'squeeze: Bollinger dentro Keltner' : 'nessuna compressione'),
        tag: sq && sq.squeeze ? '<span class="tag neg">SQUEEZE</span>' : neuTag('ESPANSO')
      }));
    }

    // 12. Regressione lineare: qualita' della tendenza
    if (ind.linreg && ind.linreg.r2[i] != null) {
      const r2v = ind.linreg.r2[i], sl = ind.linreg.slope[i];
      tiles.push(trendTile({
        arrow: arrowOf(Math.sign(sl) * r2v), color: colorOf(sl),
        value: 'R\u00b2 ' + r2v.toFixed(2) + '  (' + signed(pip(sl, inst), 2) + ' pip/barra)',
        label: 'Regressione (50) \u2014 ' + (r2v > 0.6 ? 'tendenza ben definita' : r2v > 0.3 ? 'tendenza moderata' : 'mercato erratico'),
        tag: tagFor(Math.sign(sl) * r2v)
      }));
    }

    const html = tiles.join('');
    [$('trendBlock'), $('trendBlockTech')].forEach(function (box) {
      if (box) box.innerHTML = html;
    });
    const stamp = 'aggiornato alle ' + new Date().toLocaleTimeString('it-IT') + ' \u00b7 ' + tiles.length + ' indicatori';
    [$('trendStamp'), $('trendStampTech')].forEach(function (el) {
      if (el) el.textContent = stamp;
    });
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

  /**
   * I numeri del pannello "Contesto di mercato", calcolati una volta sola:
   * li usa il pannello per disegnarsi e le spiegazioni per citarli, cosi'
   * l'aiuto non puo' raccontare una finestra diversa da quella mostrata.
   */
  const CONTEXT_RANGE_BARS = 100;
  const CONTEXT_VOL_BARS = 50;

  function contextNumbers() {
    const a = state.analysis;
    const inst = state.instrument;
    const candles = (state.series && state.series.candles) || [];
    const now = new Date();
    const hUtc = now.getUTCHours();

    const sessions = [];
    if (hUtc >= 21 || hUtc < 6) sessions.push('Sydney');
    if (hUtc >= 0 && hUtc < 9) sessions.push('Tokyo');
    if (hUtc >= 7 && hUtc < 16) sessions.push('Londra');
    if (hUtc >= 12 && hUtc < 21) sessions.push('New York');

    // media ATR a 50 barre per confronto
    const atrSeries = a && a.indicators ? a.indicators.atr.slice(-CONTEXT_VOL_BARS).filter(function (v) { return v != null; }) : [];
    const atrAvg = atrSeries.reduce(function (x, y) { return x + y; }, 0) / (atrSeries.length || 1);
    const volRatio = a && a.atr && atrAvg ? a.atr / atrAvg : null;

    const window = candles.slice(-CONTEXT_RANGE_BARS);
    const hi = window.length ? Math.max.apply(null, window.map(function (c) { return c.high; })) : null;
    const lo = window.length ? Math.min.apply(null, window.map(function (c) { return c.low; })) : null;
    const posInRange = a && lo != null && hi != null && hi > lo ? (a.price - lo) / (hi - lo) : null;

    return {
      sessions: sessions,
      hourUtc: hUtc,
      volRatio: volRatio,
      volBars: CONTEXT_VOL_BARS,
      volLabel: volRatio == null ? null : volRatio > 1.3 ? 'espansione' : volRatio < 0.75 ? 'compressione' : 'stabile',
      rangeBars: window.length,
      rangeBarsWanted: CONTEXT_RANGE_BARS,
      rangeLow: lo,
      rangeHigh: hi,
      rangePosition: posInRange == null ? null : posInRange * 100,
      spread: inst ? inst.spread : null,
      day: now.toLocaleDateString('it-IT', { weekday: 'long' }),
      adx: a ? a.adx : null
    };
  }

  function renderContext() {
    const a = state.analysis;
    const inst = state.instrument;
    const c = contextNumbers();
    const sessions = c.sessions;
    const volRatio = c.volRatio;
    const hi = c.rangeHigh;
    const lo = c.rangeLow;
    const posInRange = c.rangePosition == null ? null : c.rangePosition / 100;

    const items = [
      ['\ud83d\udd52', 'Sessione attiva', sessions.length ? sessions.join(' + ') : 'Nessuna sessione principale'],
      ['\ud83d\udcca', 'Volatilit\u00e0 vs media 50', volRatio == null ? 'n.d.'
        : volRatio.toFixed(2) + 'x (' + c.volLabel + ')'],
      ['\ud83d\udccf', 'Posizione nel range 100 barre', posInRange == null ? 'n.d.'
        : (posInRange * 100).toFixed(0) + '% (' + lo.toFixed(inst.digits) + ' \u2013 ' + hi.toFixed(inst.digits) + ')'],
      ['\ud83d\udd01', 'Spread tipico', inst.spread.toFixed(1) + ' pip \u00b7 tipo ' + inst.type],
      ['\ud83d\udcc5', 'Giorno di contrattazione', c.day],
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

  /* ------------------------------ aiuto delle card ------------------------------ */

  // Etichette leggibili dei timeframe, allineate alle voci del selettore.
  const TF_LABEL = {
    M5: '5 minuti', M10: '10 minuti', M15: '15 minuti',
    H1: '1 ora', H4: '4 ore', D1: 'giornaliero'
  };

  let helpKey = null;

  /** Contesto per le spiegazioni: i dati presenti in questo momento. */
  function helpCtx() {
    const inst = state.instrument;
    const candles = (state.series && state.series.candles) || [];
    const lastC = candles.length ? candles[candles.length - 1] : null;
    const prev = candles.length > 1 ? candles[candles.length - 2] : null;
    const layers = [];
    document.querySelectorAll('.chart-toggles .chip.active').forEach(function (chip) {
      layers.push(chip.textContent.trim());
    });
    const news = state.news || {};
    const now = Date.now();
    const upcoming = (news.calendar || []).filter(function (e) { return e.time >= now; })
      .sort(function (a, b) { return a.time - b.time; });
    // Quanti elementi ogni elenco mostra davvero: le spiegazioni citano questi
    // numeri, cosi' il testo non puo' contraddire quello che si vede a schermo.
    const countIn = function (sel) { return document.querySelectorAll(sel).length; };
    const shown = {
      ob: countIn('#obList li:not(.empty)'),
      fvg: countIn('#fvgList li:not(.empty)'),
      liq: countIn('#liqList li:not(.empty)'),
      divergences: countIn('#divList li:not(.empty)'),
      pivots: countIn('#pivotGrid .kpi'),
      news: countIn('#newsList li'),
      calendar: countIn('#calendarList li'),
      watchlist: countIn('#watchlist li'),
      journal: countIn('#journalBody tr:not(.empty-row)')
    };
    return {
      shown: shown,
      inst: inst,
      digits: inst ? inst.digits : null,
      pair: inst ? inst.symbol : state.pair,
      tf: state.tf,
      tfLabel: TF_LABEL[state.tf] || state.tf,
      horizon: state.horizon,
      source: state.source,
      price: lastC ? lastC.close : (state.analysis ? state.analysis.price : null),
      changePct: lastC && prev && prev.close ? (lastC.close - prev.close) / prev.close * 100 : null,
      lastVolume: lastC ? lastC.volume : null,
      series: state.series,
      analysis: state.analysis,
      smc: state.smc,
      divergence: state.divergence,
      pivots: state.pivots,
      divStudy: state.divStudy,
      backtest: state.backtest,
      confluence: state.confluence,
      sentiment: state.sentiment,
      news: (news.news || []),
      calendar: upcoming,
      context: contextNumbers(),
      newsSources: news.sourcesOk || null,
      journal: state.journal,
      market: state.marketCache,
      activeLayers: layers
    };
  }

  /**
   * Lettura dello stato per l'automazione e per i test: la stessa fotografia
   * dei dati che usano le spiegazioni. E' di sola lettura (non espone nulla che
   * possa modificare l'app) e non viene mai chiamata dal ciclo di disegno: serve
   * a chi deve confrontare quello che si vede a schermo con i dati che lo
   * hanno prodotto.
   */
  window.ForexApp = {
    context: helpCtx,
    helpText: function (key) {
      if (!window.CardHelp || !window.CardHelp.has(key)) return null;
      return window.CardHelp.explain(key, helpCtx());
    },
    /** Solo le righe "in questo momento", senza le parti generali. */
    helpNow: function (key) {
      const e = window.CardHelp && window.CardHelp.EXPLAIN[key];
      if (!e || !e.now) return null;
      try { return e.now(helpCtx()); } catch (err) { return null; }
    },
    keys: function () { return window.CardHelp ? window.CardHelp.keys() : []; }
  };

  function isHelpOpen() {
    const ov = $('helpOverlay');
    return !!ov && !ov.classList.contains('hidden');
  }

  /** Rigenera il testo della finestra aperta con i dati di adesso. */
  function renderHelp() {
    if (!helpKey || !window.CardHelp) return;
    const info = window.CardHelp.explain(helpKey, helpCtx());
    if (!info) return;
    $('helpTitle').textContent = info.title;
    $('helpSubtitle').textContent = info.subtitle;
    $('helpBody').innerHTML = info.html;
  }

  function openHelp(key) {
    if (!window.CardHelp || !window.CardHelp.has(key)) return;
    helpKey = key;
    renderHelp();
    const ov = $('helpOverlay');
    ov.classList.remove('hidden');
    ov.scrollTop = 0;
    const body = $('helpBody');
    body.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    const close = $('helpClose');
    if (close) close.focus();
  }

  function closeHelp() {
    const ov = $('helpOverlay');
    if (ov) ov.classList.add('hidden');
    helpKey = null;
    document.body.style.overflow = '';
  }

  /**
   * Un bottone "?" su ogni card (dall'attributo data-help) e su ogni grafico
   * (dagli elementi con data-help-key). Ogni bottone apre la spiegazione della
   * propria card, ricalcolata sui dati del momento in cui viene aperta.
   */
  function injectHelpButtons() {
    document.querySelectorAll('.card[data-help]').forEach(function (card) {
      const head = card.querySelector('.card-head') || card;
      if (head.querySelector('.card-help')) return;      // gia' presente
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card-help';
      btn.textContent = '?';
      btn.setAttribute('data-help-key', card.getAttribute('data-help'));
      btn.setAttribute('aria-label', 'Spiega questa card: che cosa mostra in generale e che cosa dicono i dati di adesso');
      btn.title = 'Spiega questa card con i dati di adesso';
      head.appendChild(btn);
    });
    document.querySelectorAll('[data-help-key]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openHelp(el.getAttribute('data-help-key'));
      });
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
      divergence: state.divergence,
      pivots: state.pivots,
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
