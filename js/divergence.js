/* =========================================================================
 * divergence.js - Rilevatore di divergenze (regolari e nascoste)
 * -------------------------------------------------------------------------
 * Confronta i punti di swing del prezzo con un oscillatore (RSI e istogramma
 * MACD) e cerca i quattro casi classici:
 *
 *   regolare rialzista  - prezzo fa un minimo piu' basso, oscillatore un
 *                         minimo piu' alto: il ribasso perde forza.
 *   nascosta rialzista  - prezzo fa un minimo piu' alto, oscillatore un
 *                         minimo piu' basso: il rialzo riprende fiato.
 *   regolare ribassista - prezzo fa un massimo piu' alto, oscillatore un
 *                         massimo piu' basso: il rialzo perde forza.
 *   nascosta ribassista - prezzo fa un massimo piu' basso, oscillatore un
 *                         massimo piu' alto: il ribasso riprende fiato.
 *
 * I punti di swing arrivano dal motore frattale di js/smc.js (stessa
 * definizione usata dallo studio SMC) e sono considerati solo se gia'
 * confermati alla barra in esame: anche questo modulo e' quindi causale,
 * senza look-ahead bias.
 *
 * Due funzioni pubbliche:
 *   analyze()   - lettura corrente, usata da pannello e grafico;
 *   backtest()  - studio di efficacia: per ogni divergenza gia' confermata
 *                 misura che cosa e' successo nelle candele successive. Il
 *                 segnale si considera noto alla barra di conferma dello swing
 *                 e l'esito si misura dopo, quindi nemmeno lo studio guarda
 *                 avanti; le divergenze troppo vicine alla fine della serie
 *                 (esito non ancora noto) vengono escluse.
 *
 * Il modulo non tocca il DOM: restituisce strutture che app.js disegna e che
 * tests/selfcheck.html verifica.
 * ========================================================================= */
(function (global) {
  'use strict';

  const SMC = global.SMC;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function isNum(v) { return v != null && isFinite(v); }

  /** Parametri di rilevamento, con i valori di default in un posto solo. */
  function params(opts) {
    opts = opts || {};
    return {
      lookback: opts.lookback || 3,   // barre per lato dei punti di swing
      maxSpan: opts.maxSpan || 60,    // distanza massima fra i due swing
      maxAge: opts.maxAge || 45,      // oltre questa eta' lo swing non e' piu' operativo
      maxItems: opts.maxItems || 4    // quante divergenze mostrare nel pannello
    };
  }

  /* Oscillatori usati, con la soglia minima di differenza che rende il
   * segnale significativo (sotto quella soglia si tratta di rumore) e la
   * scala che definisce una divergenza "piena". */
  function sources(indicators, atr) {
    const out = [];
    if (indicators.rsi) out.push({ label: 'RSI', arr: indicators.rsi, min: 2, full: 15, zone: 35 });
    // l'istogramma MACD e' espresso in unita' di prezzo: senza ATR non c'e'
    // modo di stabilire una soglia sensata, quindi si ripiega sul solo RSI
    if (isNum(atr) && atr > 0 && indicators.macd && indicators.macd.histogram) {
      out.push({ label: 'MACD', arr: indicators.macd.histogram, min: atr * 0.08, full: atr * 0.6, zone: null });
    }
    return out;
  }

  /**
   * Nucleo del rilevatore: per ciascun oscillatore e ciascun lato restituisce
   * la divergenza piu' recente visibile alla barra `lastIndex`.
   * @returns {Array} voci {index, osc, side, kind, dir, from, to, age, ...}
   */
  function detect(indicators, swings, srcList, lastIndex, p) {
    const confirmed = swings.filter(function (s) { return s.confirmedAt <= lastIndex; });
    const highs = confirmed.filter(function (s) { return s.kind === 'high'; });
    const lows = confirmed.filter(function (s) { return s.kind === 'low'; });
    const items = [];

    srcList.forEach(function (src) {
      [{ list: highs, kind: 'high' }, { list: lows, kind: 'low' }].forEach(function (group) {
        const list = group.list;
        for (let k = list.length - 1; k >= 1; k--) {
          const b = list[k], a = list[k - 1];          // b e' lo swing piu' recente
          if (b.index - a.index > p.maxSpan) continue;
          if (lastIndex - b.index > p.maxAge) break;    // troppo vecchio: inutile continuare
          const oa = src.arr[a.index], ob = src.arr[b.index];
          if (!isNum(oa) || !isNum(ob)) continue;
          const dPrice = b.price - a.price;
          const dOsc = ob - oa;
          if (Math.abs(dOsc) < src.min) continue;

          let dir = 0, kind = null;
          if (group.kind === 'low') {
            if (dPrice < 0 && dOsc > 0) { dir = 1; kind = 'regular'; }
            else if (dPrice > 0 && dOsc < 0) { dir = 1; kind = 'hidden'; }
          } else {
            if (dPrice > 0 && dOsc < 0) { dir = -1; kind = 'regular'; }
            else if (dPrice < 0 && dOsc > 0) { dir = -1; kind = 'hidden'; }
          }
          if (!dir) continue;

          const age = lastIndex - b.index;
          const freshness = clamp(1 - age / p.maxAge, 0, 1);
          const strength = src.full ? clamp(Math.abs(dOsc) / src.full, 0, 1) : 0.5;
          // un estremo dell'oscillatore rende la divergenza piu' affidabile
          const extreme = (src.zone != null && group.kind === 'low' && ob <= src.zone) ||
            (src.zone != null && group.kind === 'high' && ob >= 100 - src.zone);
          const qual = (0.55 + 0.45 * strength) * (0.75 + 0.25 * freshness) * (extreme ? 1.15 : 1);

          items.push({
            index: b.index,
            osc: src.label,
            side: group.kind,             // 'high' | 'low'
            kind: kind,                   // 'regular' | 'hidden'
            dir: dir,                     // 1 rialzista, -1 ribassista
            from: { index: a.index, price: a.price, osc: oa },
            to: { index: b.index, price: b.price, osc: ob },
            deltaPrice: dPrice,
            deltaOsc: dOsc,
            age: age,
            extreme: extreme,
            score: clamp(dir * qual, -1, 1)
          });
          break;                          // per ogni oscillatore e lato solo la piu' recente
        }
      });
    });

    return items;
  }

  /**
   * Lettura corrente.
   * @param {Array}  candles     serie OHLC
   * @param {Object} indicators  risultato di Indicators.computeAll
   * @param {Object} instrument  strumento (per i decimali)
   * @param {Object} opts        {lookback, maxSpan, maxAge, maxItems, lastIndex, atr, swings}
   * @returns {Object} {items, score, bull, bear, text, lookback}
   */
  function analyze(candles, indicators, instrument, opts) {
    opts = opts || {};
    const p = params(opts);
    const lastIndex = opts.lastIndex != null ? opts.lastIndex : candles.length - 1;
    const atr = isNum(opts.atr) ? opts.atr : lastNumber(indicators.atr);

    const empty = { items: [], score: 0, bull: 0, bear: 0, lookback: p.lookback, text: 'nessuna divergenza rilevata' };
    if (!SMC || !candles || candles.length < p.lookback * 2 + 5) return empty;

    // i punti di swing sono gli stessi dello studio SMC (li riusa quando
    // glieli passa il chiamante)
    const swings = opts.swings || SMC.findSwings(candles, p.lookback);
    const items = detect(indicators, swings, sources(indicators, atr), lastIndex, p);

    items.sort(function (x, y) { return y.index - x.index; });
    const kept = items.slice(0, p.maxItems);

    // lettura complessiva: l'ultima divergenza per ciascun verso, le due si
    // compensano se convivono
    let score = 0;
    [1, -1].forEach(function (dir) {
      const first = kept.filter(function (i) { return i.dir === dir; })[0];
      if (first) score += first.score;
    });
    score = clamp(score, -1, 1);

    const bull = kept.filter(function (i) { return i.dir > 0; }).length;
    const bear = kept.filter(function (i) { return i.dir < 0; }).length;

    let text = 'nessuna divergenza fra prezzo e oscillatori';
    if (kept.length) {
      const first = kept[0];
      const verso = first.dir > 0 ? 'rialzista' : 'ribassista';
      const tipo = first.kind === 'regular' ? 'regolare' : 'nascosta';
      text = 'divergenza ' + tipo + ' ' + verso + ' su ' + first.osc +
        ' (' + first.age + ' barre fa)' + (first.extreme ? ', in zona estrema' : '');
      if (kept.length > 1) text += '; ' + (kept.length - 1) + ' altra/e nella finestra recente';
    }

    return { items: kept, score: score, bull: bull, bear: bear, lookback: p.lookback, text: text };
  }

  /* Statistiche di un gruppo di casi: quante volte il movimento e' andato nel
   * verso indicato dalla divergenza entro l'orizzonte. */
  function statsOf(list) {
    if (!list.length) {
      return { count: 0, hitRate: 0, avgR: 0, stdR: 0, ci95: 0, significant: false,
        avgMfe: 0, avgMae: 0, profitFactor: 0 };
    }
    const wins = list.filter(function (t) { return t.win; });
    const losses = list.filter(function (t) { return !t.win; });
    const grossWin = wins.reduce(function (a, t) { return a + t.r; }, 0);
    const grossLoss = Math.abs(losses.reduce(function (a, t) { return a + t.r; }, 0));
    const n = list.length;
    const avgR = list.reduce(function (a, t) { return a + t.r; }, 0) / n;
    // scarto tipo campionario e intervallo di confidenza al 95% sulla media:
    // se l'intervallo contiene lo zero il vantaggio non e' distinguibile dal caso
    let varR = 0;
    if (n > 1) {
      varR = list.reduce(function (a, t) { return a + (t.r - avgR) * (t.r - avgR); }, 0) / (n - 1);
    }
    const stdR = Math.sqrt(varR);
    const ci95 = n > 1 ? 1.96 * stdR / Math.sqrt(n) : Infinity;
    return {
      count: n,
      hitRate: wins.length / n,
      avgR: avgR,
      stdR: stdR,
      ci95: ci95,
      // margine positivo e oltre l'incertezza statistica
      significant: n > 1 && avgR - ci95 > 0,
      avgMfe: list.reduce(function (a, t) { return a + t.mfe; }, 0) / n,
      avgMae: list.reduce(function (a, t) { return a + t.mae; }, 0) / n,
      profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss
    };
  }

  /**
   * Studio di efficacia. Per ogni divergenza confermata nella finestra misura
   * il movimento successivo: esito in multipli di ATR, escursione massima a
   * favore e contraria.
   * @param {Object} opts {horizon, window, lookback, maxSpan, maxAge, swings, atr}
   * @returns {Object} {horizon, window, count, all, byKind, byOsc, trades}
   */
  function backtest(candles, indicators, instrument, opts) {
    opts = opts || {};
    const p = params(opts);
    const horizon = opts.horizon || 10;
    const window = opts.window || 300;
    const atr = isNum(opts.atr) ? opts.atr : lastNumber(indicators.atr);
    const empty = { horizon: horizon, window: window, count: 0, all: statsOf([]), byKind: {}, byOsc: {}, trades: [] };
    if (!SMC || !candles || candles.length < p.lookback * 2 + 5 || !isNum(atr) || atr <= 0) return empty;

    const srcList = sources(indicators, atr);
    if (!srcList.length) return empty;
    const swings = opts.swings || SMC.findSwings(candles, p.lookback);
    const n = candles.length;
    const startAt = Math.max(p.lookback * 2 + 5, n - 1 - window);
    const trades = [];
    const seen = {};

    for (let t = startAt; t < n - horizon; t++) {
      detect(indicators, swings, srcList, t, p).forEach(function (it) {
        const key = it.osc + '|' + it.side + '|' + it.to.index;
        if (seen[key]) return;
        seen[key] = true;                       // ogni divergenza si conta una volta sola
        const entryIdx = it.to.index + p.lookback;   // barra di conferma dello swing
        if (entryIdx > t || entryIdx + horizon >= n) return;   // esito non ancora noto
        const entry = candles[entryIdx].close;
        const exit = candles[entryIdx + horizon].close;
        let mfe = 0, mae = 0;
        for (let k = entryIdx + 1; k <= entryIdx + horizon; k++) {
          const fav = (candles[k].close - entry) * it.dir;
          if (fav > mfe) mfe = fav;
          if (-fav > mae) mae = -fav;
        }
        // ogni esito si misura nell'ATR del momento del segnale, non in quello
        // finale: altrimenti i casi vecchi verrebbero normalizzati con la
        // volatilita' di oggi
        const unit = isNum(indicators.atr && indicators.atr[entryIdx])
          ? indicators.atr[entryIdx] : atr;
        const r = ((exit - entry) * it.dir) / unit;
        trades.push({
          osc: it.osc, kind: it.kind, side: it.side, dir: it.dir,
          index: it.to.index, entryIdx: entryIdx, unit: unit,
          r: r, mfe: mfe / unit, mae: mae / unit, win: r > 0
        });
      });
    }

    const byKind = {
      regular: statsOf(trades.filter(function (t) { return t.kind === 'regular'; })),
      hidden: statsOf(trades.filter(function (t) { return t.kind === 'hidden'; }))
    };
    const byOsc = {};
    srcList.forEach(function (src) {
      byOsc[src.label] = statsOf(trades.filter(function (t) { return t.osc === src.label; }));
    });

    return {
      horizon: horizon, window: window, count: trades.length,
      all: statsOf(trades), byKind: byKind, byOsc: byOsc, trades: trades
    };
  }

  function lastNumber(arr) {
    if (!arr) return null;
    for (let i = arr.length - 1; i >= 0; i--) if (isNum(arr[i])) return arr[i];
    return null;
  }

  /*
   * Lettura sintetica dello studio. Il verdetto e' volutamente prudente:
   * un risultato positivo viene dichiarato tale solo se il margine e' anche
   * maggiore dell'incertezza statistica (intervallo di confidenza al 95%).
   * @returns {Object} {level: 'pos'|'neg'|'flat', text}
   */
  function verdictOf(st) {
    if (!st || !st.count) return { level: 'flat', text: 'campionamento non disponibile' };
    const r = (st.avgR >= 0 ? '+' : '') + st.avgR.toFixed(2);
    if (st.significant) {
      return { level: 'pos', text: 'vantaggio misurabile: ' + r + ' ATR medi per segnale' };
    }
    if (st.avgR + st.ci95 < 0) {
      return { level: 'neg', text: 'esito medio negativo: ' + r + ' ATR per segnale' };
    }
    return {
      level: 'flat',
      text: 'nessun vantaggio misurabile (' + r + ' \u00b1 ' + Math.abs(st.ci95).toFixed(2) +
        ' ATR: l\u2019intervallo contiene lo zero)'
    };
  }

  global.Divergence = {
    analyze: analyze, backtest: backtest, params: params, sources: sources, verdictOf: verdictOf
  };
})(window);
