/* =========================================================================
 * feed.js - Collegamento ai dati di mercato reali (Yahoo Finance)
 * -------------------------------------------------------------------------
 * L'applicazione resta utilizzabile senza rete: questo modulo prova a
 * procurarsi le candele vere dal server locale (server.py) e, se non ci
 * riesce per qualunque motivo, lo dice chiaramente e lascia il posto al
 * generatore simulato.
 *
 * Perche' passa da un server locale: il browser non puo' interrogare
 * direttamente Yahoo Finance (il fornitore non autorizza le pagine di altri
 * siti) e i dati vanno comunque ripuliti e, per alcuni timeframe, ricostruiti.
 *
 * Cosa fa questo modulo:
 *   - trova il server locale (stessa origine, oppure le porte di riserva se
 *     la pagina e' stata aperta con un doppio clic da file://);
 *   - chiede le candele per il timeframe richiesto e le controlla una per una
 *     (prezzi finiti e positivi, tempi crescenti, nessun buco anomalo);
 *   - sa dire qual e' la profondita' storica disponibile per ogni timeframe;
 *   - puo' richiedere i dati a intervalli regolari (aggiornamento periodico).
 * ========================================================================= */
(function (global) {
  'use strict';

  // Ogni quanto si richiedono i dati al server. Il server tiene una cache di
  // 60 secondi, quindi non si disturba il fornitore piu' del necessario.
  const POLL_MS = 60 * 1000;
  const PROBE_TIMEOUT = 4000;
  const LOAD_TIMEOUT = 25000;
  const DEFAULT_PORT = 8901;
  const PORT_RANGE = 10;

  // Profondita' storica fornita dal fornitore, usata finche' non si conosce
  // quella dichiarata dal server (stessa tabella di server.py).
  const TF_FALLBACK = {
    M5:  { history: '60 giorni (limite del fornitore)', interval: '5m' },
    M10: { history: '60 giorni; candele ricostruite da quelle a 5 minuti', interval: '5m' },
    M15: { history: '60 giorni (limite del fornitore)', interval: '15m' },
    H1:  { history: 'circa 2 anni (limite del fornitore)', interval: '60m' },
    H4:  { history: 'circa 2 anni; candele ricostruite da quelle orarie', interval: '60m' },
    D1:  { history: '5 anni', interval: '1d' }
  };

  const state = {
    base: null,          // indirizzo del server locale, es. "http://127.0.0.1:8901"
    status: null,        // ultima risposta di /api/status
    lastMeta: null,      // informazioni sull'ultimo scaricamento riuscito
    lastError: null,     // ultimo errore (stringa) o null
    lastFetch: 0,        // quando e' arrivato l'ultimo dato buono
    timer: null,
    polling: false,
    onUpdate: null,
    onError: null
  };

  /* ------------------------------------------------------------------ */
  /* Indirizzo del server                                               */
  /* ------------------------------------------------------------------ */
  function candidateBases() {
    const out = [];
    if (global.FOREXVISION_API) out.push(global.FOREXVISION_API);
    try {
      const saved = global.localStorage && global.localStorage.getItem('forexvision.api');
      if (saved) out.push(saved);
    } catch (e) { /* storage non disponibile */ }
    if (global.location && /^https?:$/.test(global.location.protocol)) {
      // pagina servita dal ponte: si usa la stessa origine
      out.push('');
    } else {
      for (let i = 0; i < PORT_RANGE; i++) {
        out.push('http://127.0.0.1:' + (DEFAULT_PORT + i));
      }
    }
    return out;
  }

  function fetchJson(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctrl) ctrl.abort();
        reject(new Error('il server non ha risposto entro ' + Math.round(timeoutMs / 1000) + ' s'));
      }, timeoutMs);

      const options = { cache: 'no-store' };
      if (ctrl) options.signal = ctrl.signal;

      let promise;
      try {
        promise = global.fetch(url, options);
      } catch (e) {
        clearTimeout(timer);
        return reject(new Error('richiesta non avviata: ' + e.message));
      }
      promise.then(function (resp) {
        if (done) return;
        // 503 = il fornitore non risponde: il corpo contiene la spiegazione
        return resp.json().then(function (body) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (!resp.ok || !body || body.ok === false) {
            reject(new Error((body && body.error) || ('risposta ' + resp.status)));
          } else {
            resolve(body);
          }
        });
      }).catch(function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Cerca il server locale fra gli indirizzi candidati (una volta sola). */
  function probe() {
    if (state.base !== null && state.status) return Promise.resolve(state.status);
    const bases = candidateBases();
    let index = 0;

    function attempt() {
      if (index >= bases.length) {
        state.lastError = 'server locale non raggiungibile';
        return Promise.resolve(null);
      }
      const base = bases[index++];
      return fetchJson(base + '/api/status', PROBE_TIMEOUT).then(function (status) {
        state.base = base;
        state.status = status;
        state.lastError = null;
        return status;
      }).catch(function () {
        return attempt();
      });
    }
    return attempt();
  }

  /* ------------------------------------------------------------------ */
  /* Controllo dei dati ricevuti                                        */
  /* ------------------------------------------------------------------ */
  function isFinitePositive(v) {
    return typeof v === 'number' && isFinite(v) && v > 0;
  }

  /**
   * Ripulisce le candele ricevute: scarta quelle illeggibili, impone tempi
   * crescenti e si assicura che massimo e minimo contengano apertura e
   * chiusura. Un dato malformato non deve mai arrivare al motore di analisi.
   */
  function sanitizeCandles(raw) {
    const out = [];
    let dropped = 0;
    (raw || []).forEach(function (c) {
      if (!c) { dropped++; return; }
      const time = Number(c.time);
      const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
      if (!isFinite(time) || !isFinitePositive(o) || !isFinitePositive(h) ||
          !isFinitePositive(l) || !isFinitePositive(cl)) {
        dropped++;
        return;
      }
      if (out.length && time <= out[out.length - 1].time) { dropped++; return; }
      const vol = Number(c.volume);
      out.push({
        time: time,
        open: o,
        high: Math.max(h, o, cl),
        low: Math.min(l, o, cl),
        close: cl,
        volume: isFinite(vol) && vol >= 0 ? vol : 0
      });
    });
    return { candles: out, dropped: dropped };
  }

  function seriesFromPayload(payload, instrument) {
    const clean = sanitizeCandles(payload.candles);
    if (clean.candles.length < 50) {
      throw new Error('dati insufficienti dal fornitore (' + clean.candles.length + ' candele valide)');
    }
    const last = clean.candles[clean.candles.length - 1];
    return {
      instrument: instrument,
      timeframe: payload.timeframe,
      candles: clean.candles,
      source: 'yahoo-finance',
      info: {
        provider: payload.provider || 'Yahoo Finance',
        providerUrl: payload.providerUrl || '',
        yahooSymbol: payload.yahooSymbol || '',
        interval: payload.interval || '',
        history: payload.history || '',
        aggregated: !!payload.aggregated,
        bars: clean.candles.length,
        dropped: clean.dropped + (payload.skippedEmpty || 0),
        hasVolume: !!payload.hasVolume,
        stale: !!payload.stale,
        fromCache: !!payload.fromCache,
        cacheAgeSeconds: payload.cacheAgeSeconds || 0,
        fetchedAt: payload.fetchedAt || Date.now(),
        lastBarTime: last.time,
        forming: !!last.forming,
        marketState: payload.marketState || '',
        exchangeTimezone: payload.exchangeTimezone || '',
        providerPrice: typeof payload.providerPrice === 'number' ? payload.providerPrice : null,
        note: payload.error || null
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Lettura dei dati                                                   */
  /* ------------------------------------------------------------------ */
  /**
   * Chiede al server le candele reali del timeframe indicato.
   * @param {string} tf  M5 | M10 | M15 | H1 | H4 | D1
   * @param {Object} opts  {symbol, force, instrument}
   * @returns {Promise<Object>} serie nel formato usato dall'applicazione
   */
  function load(tf, opts) {
    opts = opts || {};
    const symbol = opts.symbol || 'EUR/USD';
    return probe().then(function (status) {
      if (!status) throw new Error(state.lastError || 'server locale non raggiungibile');
      const url = state.base + '/api/candles?tf=' + encodeURIComponent(tf) +
        '&symbol=' + encodeURIComponent(symbol) + (opts.force ? '&force=1' : '');
      return fetchJson(url, LOAD_TIMEOUT);
    }).then(function (payload) {
      const series = seriesFromPayload(payload, opts.instrument);
      state.lastMeta = series.info;
      state.lastFetch = Date.now();
      state.lastError = null;
      return series;
    }).catch(function (err) {
      state.lastError = err && err.message ? err.message : String(err);
      throw err;
    });
  }

  /**
   * Chiede al server lo stato del sentiment reale (CFTC COT + VIX + indice
   * del dollaro). Valida le parti essenziali: senza COT il sentiment reale
   * non esiste e l'errore torna al chiamante, che ripiega sul simulato.
   * @param {string} symbol  coppia (default EUR/USD)
   * @param {Object} opts  {force}
   * @returns {Promise<Object>} payload del ponte
   */
  function loadSentiment(symbol, opts) {
    opts = opts || {};
    return probe().then(function (status) {
      if (!status) throw new Error(state.lastError || 'server locale non raggiungibile');
      const url = state.base + '/api/sentiment?symbol=' +
        encodeURIComponent(symbol || 'EUR/USD') + (opts.force ? '&force=1' : '');
      return fetchJson(url, LOAD_TIMEOUT);
    }).then(function (payload) {
      const checked = checkSentimentPayload(payload);
      state.lastFetch = Date.now();
      state.lastError = null;
      return checked;
    }).catch(function (err) {
      state.lastError = err && err.message ? err.message : String(err);
      throw err;
    });
  }

  /** Controlla e ripulisce il payload del sentiment reale. */
  function checkSentimentPayload(payload) {
    if (!payload || payload.ok === false) {
      throw new Error((payload && payload.error) || 'sentiment reale non disponibile');
    }
    const cot = payload.cot;
    if (!cot || !cot.ok || !cot.contracts) {
      throw new Error('report CFTC mancante o illeggibile');
    }
    const out = { cot: cot, vix: null, dxy: null };
    // il COT resta integro: le righe sono gia' numeri interi con date crescenti
    for (const cur in cot.contracts) {
      const rows = (cot.contracts[cur] || {}).rows || [];
      if (rows.length < 52) throw new Error('storico COT insufficiente per ' + cur);
      for (const r of rows) {
        if (!isFinitePositive(r.oi)) throw new Error('open interest illeggibile nel COT di ' + cur);
      }
    }
    out.cot.asOf = cot.asOf || '';
    out.cot.weeks = cot.weeks || 0;
    if (payload.vix && payload.vix.ok && Array.isArray(payload.vix.candles) &&
        payload.vix.candles.length >= 60) {
      out.vix = {
        level: Number(payload.vix.level),
        asOf: payload.vix.asOf || '',
        candles: payload.vix.candles
          .map(function (c) { return { time: Number(c.time), close: Number(c.close) }; })
          .filter(function (c) { return isFinite(c.time) && isFinite(c.close) && c.close > 0; }),
        symbol: payload.vix.symbol || ''
      };
      if (out.vix.candles.length < 60) out.vix = null;
    }
    if (payload.dxy && payload.dxy.ok && Array.isArray(payload.dxy.candles) &&
        payload.dxy.candles.length >= 60) {
      out.dxy = {
        level: Number(payload.dxy.level),
        asOf: payload.dxy.asOf || '',
        candles: payload.dxy.candles
          .map(function (c) { return { time: Number(c.time), close: Number(c.close) }; })
          .filter(function (c) { return isFinite(c.time) && isFinite(c.close) && c.close > 0; }),
        symbol: payload.dxy.symbol || ''
      };
      if (out.dxy.candles.length < 60) out.dxy = null;
    }
    out.stale = !!payload.stale;
    out.fetchedAt = payload.fetchedAt || Date.now();
    out.provider = payload.provider || '';
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Notizie e calendario                                               */
  /* ------------------------------------------------------------------ */
  /**
   * Notizie e calendario economico dal ponte (RSS ForexLive/FXStreet/Fed/BCE
   * + calendario ForexFactory filtrato per EUR/USD). Cache del ponte: 5 min.
   * @param {Object} opts  {force}
   * @returns {Promise<Object>} payload {news, calendar, feeds, ...}
   */
  function loadNews(opts) {
    opts = opts || {};
    return probe().then(function (status) {
      if (!status) throw new Error(state.lastError || 'server locale non raggiungibile');
      const url = state.base + '/api/news' + (opts.force ? '?force=1' : '');
      return fetchJson(url, LOAD_TIMEOUT);
    }).then(function (payload) {
      if (!payload || payload.ok === false) {
        throw new Error((payload && payload.error) || 'notizie non disponibili');
      }
      const now = Date.now();
      payload.news = (payload.news || []).filter(function (n) {
        return typeof n.time === 'number' && isFinite(n.time) &&
               typeof n.title === 'string' && n.title.trim();
      });
      payload.calendar = (payload.calendar || []).filter(function (e) {
        return typeof e.time === 'number' && isFinite(e.time) &&
               typeof e.title === 'string' && e.title.trim();
      });
      payload.fetchedAt = payload.fetchedAt || now;
      payload.stale = !!payload.stale;
      payload.feeds = Array.isArray(payload.feeds) ? payload.feeds : [];
      return payload;
    }).catch(function (err) {
      state.lastError = err && err.message ? err.message : String(err);
      throw err;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Aggiornamento periodico                                            */
  /* ------------------------------------------------------------------ */
  function startPolling(tf, opts, onUpdate, onError) {
    stopPolling();
    state.polling = true;
    state.onUpdate = onUpdate;
    state.onError = onError || null;

    function poll(force) {
      if (!state.polling) return;
      load(tf(), opts()).then(function (series) {
        if (!state.polling) return;
        if (onUpdate) onUpdate(series, state.lastMeta);
      }).catch(function (err) {
        if (!state.polling) return;
        if (onError) onError(err);
      });
    }

    state.timer = setInterval(function () { poll(false); }, POLL_MS);
    return state.timer;
  }

  function stopPolling() {
    state.polling = false;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function msToNextPoll() {
    if (!state.polling) return null;
    const elapsed = Date.now() - state.lastFetch;
    return Math.max(0, POLL_MS - elapsed);
  }

  /** Nota sulla profondita' storica disponibile per un timeframe. */
  function historyNote(tf) {
    if (state.status && state.status.timeframes && state.status.timeframes[tf]) {
      return state.status.timeframes[tf].history || '';
    }
    return (TF_FALLBACK[tf] || {}).history || '';
  }

  global.ForexFeed = {
    POLL_MS: POLL_MS,
    TF_FALLBACK: TF_FALLBACK,
    probe: probe,
    load: load,
    loadSentiment: loadSentiment,
    loadNews: loadNews,
    startPolling: startPolling,
    stopPolling: stopPolling,
    msToNextPoll: msToNextPoll,
    historyNote: historyNote,
    sanitizeCandles: sanitizeCandles,
    seriesFromPayload: seriesFromPayload,
    candidateBases: candidateBases,
    status: function () {
      return {
        base: state.base,
        online: !!state.status,
        lastMeta: state.lastMeta,
        lastError: state.lastError,
        lastFetch: state.lastFetch,
        polling: state.polling,
        info: state.status
      };
    }
  };
})(window);
