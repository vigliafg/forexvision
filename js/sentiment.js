/* =========================================================================
 * sentiment.js - Studio del sentiment del mercato forex
 * -------------------------------------------------------------------------
 * Quattro analisi distinte, combinate in un punteggio unico:
 *
 *  1. FORZA DELLE VALUTE (calcolata dai prezzi, non simulata)
 *     Ogni divisa viene valutata sui rendimenti di tutte le coppie in cui
 *     compare (segno + se base, - se quotata), su tre orizzonti (breve, medio,
 *     lungo) e normalizzata in una scala 0-100 con classifiche. E' il modo
 *     standard di misurare il sentiment relativo di una divisa.
 *
 *  2. POSIZIONAMENTO DELLA Folla (modello simulato)
 *     Il posizionamento retail e' tipicamente contro-tendenza: la folla tende
 *     a comprare i ribassi e a vendere i rialzi, con posizioni che restano
 *     aperte in perdita. Il modello riproduce questo comportamento (la
 *     percentuale di long dipende in modo inverso al movimento recente) e ne
 *     deriva una lettura CONTRO-ARIA agli estremi.
 *     Nota: non essendo disponibile una fonte dati reale offline, questa e'
 *     una simulazione dichiarata, non un dato di broker.
 *
 *  3. PROPENSIONE AL RISCHIO (risk-on / risk-off, calcolata dai prezzi)
 *     Confronto fra divise sensibili al rischio (AUD, NZD, CAD) e divise
 *     rifugio (JPY, CHF) piu' un indice di volatilita' di mercato ottenuto
 *     dall'ATR di tutte le coppie rispetto alla propria media.
 *
 *  4. POSIZIONAMENTO ISTITUZIONALE (COT-style, modello simulato)
 *     Posizione netta per divisa derivata dalla forza di medio periodo con
 *     reversione agli estremi, variazione settimanale e segnalazione delle
 *     divise piu' affollate.
 * ========================================================================= */
(function (global) {
  'use strict';

  const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'XAU', 'XAG'];

  // Affinita' al rischio: positivo = valuta pro-ciclica, negativo = rifugio
  const RISK_AFFINITY = {
    AUD: 1.0, NZD: 1.0, CAD: 0.6, XAG: 0.3,
    JPY: -1.0, CHF: -1.0, USD: -0.5, XAU: -0.5,
    EUR: 0.0, GBP: 0.0
  };

  const WINDOWS = { short: 5, medium: 20, long: 60 };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function isNum(v) { return v != null && isFinite(v); }

  function parsePair(symbol) {
    const parts = symbol.split('/');
    return { base: parts[0], quote: parts[1] };
  }

  /* PRNG deterministico per i modelli simulati: lo stesso strumento e lo
   * stesso seed danno sempre lo stesso valore, cosi' i numeri non "ballano"
   * a ogni ridisegno della pagina. */
  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function noise(str, salt) {
    let a = (hashSeed(str) + (salt || 0) * 2654435761) >>> 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* ------------------------------------------------------------------ */
  /* 1. Forza delle valute                                              */
  /* ------------------------------------------------------------------ */
  function currencyStrength(cache) {
    const acc = {};
    CURRENCIES.forEach(function (c) {
      acc[c] = { currency: c, short: [], medium: [], long: [], pairs: [] };
    });

    cache.forEach(function (entry) {
      const p = parsePair(entry.symbol);
      const c = entry.candles;
      const last = c.length - 1;
      Object.keys(WINDOWS).forEach(function (key) {
        const w = WINDOWS[key];
        if (last - w < 0) return;
        const roc = (c[last].close - c[last - w].close) / c[last - w].close;
        if (acc[p.base]) { acc[p.base][key].push(roc); acc[p.base].pairs.push(entry.symbol); }
        if (acc[p.quote]) { acc[p.quote][key].push(-roc); acc[p.quote].pairs.push(entry.symbol); }
      });
    });

    function mean(arr) {
      if (!arr.length) return 0;
      return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
    }

    const list = CURRENCIES.map(function (c) {
      const a = acc[c];
      return {
        currency: c,
        short: mean(a.short) * 100,
        medium: mean(a.medium) * 100,
        long: mean(a.long) * 100,
        pairs: a.pairs.length
      };
    });

    // normalizzazione min-max per orizzonte (0-100)
    ['short', 'medium', 'long'].forEach(function (key) {
      const vals = list.map(function (x) { return x[key]; });
      const min = Math.min.apply(null, vals);
      const max = Math.max.apply(null, vals);
      list.forEach(function (x) {
        x[key + 'Score'] = max - min < 1e-9 ? 50 : (x[key] - min) / (max - min) * 100;
      });
    });

    list.forEach(function (x) {
      x.score = x.shortScore * 0.45 + x.mediumScore * 0.35 + x.longScore * 0.20;
      x.change = x.short;   // variazione % grezza a 5 barre
    });
    list.sort(function (a, b) { return b.score - a.score; });
    list.forEach(function (x, i) { x.rank = i + 1; });

    const byCurrency = {};
    list.forEach(function (x) { byCurrency[x.currency] = x; });
    return { list: list, byCurrency: byCurrency };
  }

  /* ------------------------------------------------------------------ */
  /* 2. Posizionamento della folla (modello dichiaratamente simulato)    */
  /* ------------------------------------------------------------------ */
  function retailPositioning(symbol, candles) {
    const last = candles.length - 1;
    if (last < 20) return null;
    const close = candles[last].close;
    const c20 = candles[last - 20].close;
    const c5 = candles[last - 5].close;
    const chg20 = (close - c20) / c20 * 100;
    const chg5 = (close - c5) / c5 * 100;

    // inclinazione strutturale della coppia (stabile nel tempo)
    const bias = (noise(symbol, 1) - 0.5) * 18;
    // la folla segue il movimento in ritardo e media in perdita: correlazione
    // negativa con il movimento di medio periodo
    let longPct = 50 - chg20 * 22 + chg5 * 6 + bias;
    longPct = clamp(longPct, 6, 94);

    const extreme = longPct >= 75 ? 'long' : longPct <= 25 ? 'short' : null;
    // lettura contro-aria: folla long = pressione ribassista potenziale
    const contrarianScore = clamp(-(longPct - 50) / 40, -1, 1);

    const accounts = 12000 + Math.round(noise(symbol, 2) * 48000);
    return {
      longPct: longPct,
      shortPct: 100 - longPct,
      accounts: accounts,
      extreme: extreme,
      extremeText: extreme === 'long' ? 'folla sbilanciata al rialzo'
        : extreme === 'short' ? 'folla sbilanciata al ribasso' : 'posizionamento equilibrato',
      contrarianScore: contrarianScore,
      contrarianText: contrarianScore < -0.4 ? 'segnale contro-ario ribassista (squeeze possibile)'
        : contrarianScore > 0.4 ? 'segnale contro-ario rialzista (squeeze possibile)'
          : 'nessuna lettura contro-aria significativa',
      simulated: true
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Propensione al rischio e volatilita' di mercato                  */
  /* ------------------------------------------------------------------ */
  function riskAppetite(strength, cache) {
    const s = strength.byCurrency;
    function avg(names) {
      const vals = names.map(function (n) { return s[n] ? s[n].score : 50; });
      return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    }
    const riskCurrencies = avg(['AUD', 'NZD', 'CAD', 'XAG']);
    const havens = avg(['JPY', 'CHF', 'XAU']);
    const diff = riskCurrencies - havens;
    const score = clamp(50 + diff * 0.9, 0, 100);

    // indice di volatilita': ATR corrente rispetto alla propria media storica,
    // mediato su tutte le coppie disponibili (0-100, 50 = nella norma)
    let sum = 0, n = 0;
    cache.forEach(function (entry) {
      const atr = entry.ind.atr;
      const last = entry.candles.length - 1;
      if (!isNum(atr[last])) return;
      const from = Math.max(0, last - 50);
      let acc = 0, cnt = 0;
      for (let i = from; i <= last; i++) if (isNum(atr[i])) { acc += atr[i]; cnt++; }
      const avgAtr = cnt ? acc / cnt : atr[last];
      if (avgAtr > 0) { sum += atr[last] / avgAtr; n++; }
    });
    const volRatio = n ? sum / n : 1;
    const volIndex = clamp(50 + (volRatio - 1) * 120, 0, 100);

    const label = score >= 62 ? 'Risk-on' : score <= 38 ? 'Risk-off' : 'Neutro';
    const volLabel = volIndex >= 65 ? 'elevata' : volIndex <= 35 ? 'compressa' : 'nella norma';

    return {
      score: score,
      label: label,
      riskCurrencies: riskCurrencies,
      havens: havens,
      diff: diff,
      volIndex: volIndex,
      volRatio: volRatio,
      volLabel: volLabel,
      text: score >= 62
        ? 'Gli investitori privilegiano le valute pro-cicliche: ambiente favorevole ad AUD, NZD e CAD.'
        : score <= 38
          ? 'Flussi verso le valute rifugio: ambiente favorevole a JPY, CHF e oro.'
          : 'Nessuna preferenza netta fra valute pro-cicliche e rifugio.'
    };
  }

  /* ------------------------------------------------------------------ */
  /* 4. Posizionamento istituzionale (COT-style, modello simulato)       */
  /* ------------------------------------------------------------------ */
  function institutionalPositioning(strength) {
    const list = strength.list.map(function (c) {
      const base = 50 + (c.mediumScore - 50) * 1.15 + (noise(c.currency, 3) - 0.5) * 10;
      const net = clamp(base, 5, 95);
      const prev = clamp(net - (c.shortScore - c.mediumScore) * 0.5 - (noise(c.currency, 4) - 0.5) * 6, 5, 95);
      return {
        currency: c.currency,
        net: net,
        change: net - prev,
        extreme: net >= 78 ? 'long' : net <= 22 ? 'short' : null,
        simulated: true
      };
    });
    list.sort(function (a, b) { return b.net - a.net; });
    const byCurrency = {};
    list.forEach(function (x) { byCurrency[x.currency] = x; });
    return { list: list, byCurrency: byCurrency, crowded: list[0], lightest: list[list.length - 1] };
  }

  /* ------------------------------------------------------------------ */
  /* Analisi di sentiment per la coppia selezionata                      */
  /* ------------------------------------------------------------------ */
  function analyze(cache, symbol, instrument, opts) {
    opts = opts || {};
    // In modalità dati reali lo studio può limitarsi alle coppie veramente
    // collegate al fornitore: le altre, contrassegnate con `simulated`, vengono
    // escluse dal confronto di forza fra valute e chiaramente dichiarate.
    const includeSimulated = !!opts.includeSimulated;
    const universe = includeSimulated
      ? cache
      : cache.filter(function (e) { return !e.simulated; });
    const realPairs = cache.filter(function (e) { return !e.simulated; }).length;
    const simulatedPairs = cache.length - realPairs;
    const scope = {
      realPairs: realPairs,
      simulatedPairs: simulatedPairs,
      partial: realPairs < 4
    };

    const usable = universe.length ? universe : cache;
    const strength = currencyStrength(usable);
    const pair = parsePair(symbol);
    const entry = cache.filter(function (e) { return e.symbol === symbol; })[0] || cache[0];
    const retail = entry ? retailPositioning(symbol, entry.candles) : null;
    const risk = riskAppetite(strength, usable);
    const inst = institutionalPositioning(strength);

    const sBase = strength.byCurrency[pair.base] || { score: 50, currency: pair.base, rank: '-' };
    const sQuote = strength.byCurrency[pair.quote] || { score: 50, currency: pair.quote, rank: '-' };
    const strengthDiff = (sBase.score - sQuote.score) / 100;   // [-1, 1]

    // inclinazione legata al regime di rischio
    const aBase = RISK_AFFINITY[pair.base] || 0;
    const aQuote = RISK_AFFINITY[pair.quote] || 0;
    const riskTilt = clamp((aBase - aQuote) * ((risk.score - 50) / 50), -1, 1);

    const retailScore = retail ? retail.contrarianScore : 0;
    const iBase = inst.byCurrency[pair.base] ? inst.byCurrency[pair.base].net : 50;
    const iQuote = inst.byCurrency[pair.quote] ? inst.byCurrency[pair.quote].net : 50;
    const instScore = clamp((iBase - iQuote) / 100, -1, 1);

    const components = [
      {
        key: 'strength', label: 'Forza relativa delle valute', weight: 0.45,
        score: clamp(strengthDiff * 1.6, -1, 1),
        detail: pair.base + ' ' + sBase.score.toFixed(0) + '/100 (#' + sBase.rank + ') vs ' +
          pair.quote + ' ' + sQuote.score.toFixed(0) + '/100 (#' + sQuote.rank + ')'
      },
      {
        key: 'retail', label: 'Posizionamento della folla', weight: 0.22,
        score: retailScore,
        detail: retail ? retail.longPct.toFixed(0) + '% long / ' + retail.shortPct.toFixed(0) + '% short \u2014 ' + retail.extremeText : 'dati insufficienti'
      },
      {
        key: 'risk', label: 'Regime di rischio', weight: 0.18,
        score: clamp(riskTilt, -1, 1),
        detail: risk.label + ' (' + risk.score.toFixed(0) + '/100) \u2014 ' + pair.base + ' ' +
          (aBase > 0 ? 'pro-ciclica' : aBase < 0 ? 'rifugio' : 'neutrale al rischio')
      },
      {
        key: 'institutional', label: 'Posizionamento istituzionale', weight: 0.15,
        score: instScore,
        detail: pair.base + ' ' + iBase.toFixed(0) + '% netto long vs ' + pair.quote + ' ' + iQuote.toFixed(0) + '%'
      }
    ];

    let wSum = 0, total = 0, concordance = 0;
    components.forEach(function (c) {
      wSum += c.weight;
      total += c.score * c.weight;
      concordance += Math.sign(c.score) * c.weight;
    });
    total /= wSum;
    concordance /= wSum;
    const score = clamp(total, -1, 1);
    const agreement = Math.abs(concordance);

    const bias = score > 0.35 ? 'FORTE RIALZO' : score > 0.12 ? 'RIALZO'
      : score < -0.35 ? 'FORTE RIBASSO' : score < -0.12 ? 'RIBASSO' : 'NEUTRO';
    const direction = score > 0.12 ? 'BUY' : score < -0.12 ? 'SELL' : 'NEUTRAL';
    const confidence = clamp(0.5 * Math.abs(score) + 0.3 * agreement + 0.2, 0.05, 0.95);

    const reasons = [];
    reasons.push({
      tone: direction === 'BUY' ? 'bull' : direction === 'SELL' ? 'bear' : 'flat',
      text: 'Lettura complessiva ' + bias.toLowerCase() + ' sull\u2019incrocio: ' + pair.base + ' in classifica #' +
        sBase.rank + ' (' + sBase.score.toFixed(0) + '/100) contro ' + pair.quote + ' #' + sQuote.rank +
        ' (' + sQuote.score.toFixed(0) + '/100).'
    });
    reasons.push({
      tone: risk.score >= 62 ? 'bull' : risk.score <= 38 ? 'bear' : 'flat',
      text: 'Regime ' + risk.label + ': ' + risk.text + ' Volatilita\u0300 ' + risk.volLabel +
        ' (' + risk.volRatio.toFixed(2) + 'x la media delle ultime 50 barre).'
    });
    if (retail) {
      reasons.push({
        tone: retail.contrarianScore > 0.1 ? 'bull' : retail.contrarianScore < -0.1 ? 'bear' : 'flat',
        text: 'Posizionamento retail ' + retail.longPct.toFixed(0) + '% long su circa ' +
          retail.accounts.toLocaleString('it-IT') + ' conti: ' + retail.contrarianText + '.'
      });
    }
    reasons.push({
      tone: inst.byCurrency[pair.base] && inst.byCurrency[pair.base].change > 0 ? 'bull' : 'bear',
      text: 'Flussi istituzionali: ' + pair.base + ' ' + iBase.toFixed(0) + '% e ' + pair.quote + ' ' +
        iQuote.toFixed(0) + '% di posizionamento netto; la divisa piu\u0300 affollata e\u0300 ' +
        inst.crowded.currency + ' (' + inst.crowded.net.toFixed(0) + '%), la piu\u0300 leggera ' +
        inst.lightest.currency + ' (' + inst.lightest.net.toFixed(0) + '%).'
    });

    return {
      symbol: symbol,
      pair: pair,
      scope: scope,
      strength: strength,
      retail: retail,
      risk: risk,
      institutional: inst,
      components: components,
      score: score,
      agreement: agreement,
      bias: bias,
      direction: direction,
      confidence: confidence,
      reasons: reasons
    };
  }

  /* ------------------------------------------------------------------ */
  /* Confluenza dei tre modelli (tecnico, SMC, sentiment)                */
  /* ------------------------------------------------------------------ */
  function confluence(technicalScore, smcScore, sentimentScore, opts) {
    opts = opts || {};
    // In modalità dati reali ridotta il sentiment studia una sola coppia:
    // non aggiunge informazione indipendente, quindi il verdetto si appoggia
    // ai due modelli affidabili (tecnico e SMC) rinormalizzando i pesi.
    const dropSentiment = opts.sentimentReliable === false;
    const parts = dropSentiment
      ? [
          { name: 'Tecnico', score: technicalScore, weight: 0.34 },
          { name: 'SMC', score: smcScore, weight: 0.38 }
        ]
      : [
          { name: 'Tecnico', score: technicalScore, weight: 0.34 },
          { name: 'SMC', score: smcScore, weight: 0.38 },
          { name: 'Sentiment', score: sentimentScore, weight: 0.28 }
        ];
    let wSum = 0, total = 0;
    parts.forEach(function (p) { wSum += p.weight; total += p.score * p.weight; });
    const score = clamp(total / wSum, -1, 1);

    const signs = parts.map(function (p) { return Math.sign(p.score); }).filter(function (s) { return s !== 0; });
    const bullish = signs.filter(function (s) { return s > 0; }).length;
    const bearish = signs.filter(function (s) { return s < 0; }).length;
    const n = parts.length;
    const aligned = n >= 2 && (bullish === n || bearish === n);

    const direction = score > 0.10 ? 'BUY' : score < -0.10 ? 'SELL' : 'NEUTRAL';
    const confidence = clamp(0.45 * Math.abs(score) + (aligned ? 0.35 : 0.12) + 0.1, 0.05, 0.95);

    let text;
    if (dropSentiment) {
      text = aligned
        ? 'Tecnico e SMC concordano su un orientamento ' + (score > 0 ? 'rialzista' : 'ribassista') +
          ': confluenza piena. Il sentiment è escluso perché usa dati reali di una sola coppia.'
        : bullish > bearish
          ? 'Prevalenza rialzista fra tecnico e SMC ma con un modello in disaccordo: attendere conferme.'
          : bearish > bullish
            ? 'Prevalenza ribassista fra tecnico e SMC ma con un modello in disaccordo: attendere conferme.'
            : 'Tecnico e SMC non concordano: nessuna confluenza operativa per ora.';
    } else {
      text = aligned
        ? 'I tre modelli concordano su un orientamento ' + (score > 0 ? 'rialzista' : 'ribassista') +
          ': confluenza piena.'
        : bearish > bullish
          ? 'Prevalenza ribassista ma con ' + bullish + ' modello/i in disaccordo: attendere conferme prima di operare.'
          : bullish > bearish
            ? 'Prevalenza rialzista ma con ' + bearish + ' modello/i in disaccordo: attendere conferme prima di operare.'
            : 'Segnali in conflitto fra i tre modelli: nessuna confluenza operativa.'
    }

    return {
      parts: parts,
      score: score,
      direction: direction,
      aligned: aligned,
      count: Math.max(bullish, bearish),
      confidence: confidence,
      excluded: dropSentiment ? ['Sentiment'] : [],
      // Motivo breve mostrato sotto il riquadro dello studio escluso: l'app tiene
      // visibili i tre studi e dichiara perché uno non pesa nel verdetto.
      excludedReason: dropSentiment
        ? 'Fuori dal verdetto: con i dati reali misura una sola coppia, non aggiunge informazione indipendente.'
        : '',
      text: text
    };
  }

  global.Sentiment = {
    analyze: analyze,
    confluence: confluence,
    currencyStrength: currencyStrength,
    retailPositioning: retailPositioning,
    riskAppetite: riskAppetite,
    institutionalPositioning: institutionalPositioning,
    CURRENCIES: CURRENCIES,
    RISK_AFFINITY: RISK_AFFINITY
  };
})(window);
