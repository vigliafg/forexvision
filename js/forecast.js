/* =========================================================================
 * forecast.js - Motore previsionale
 * -------------------------------------------------------------------------
 * Il modello combina in modo adattivo otto famiglie di segnali tecnici:
 *   trend (allineamento EMA), bias di lungo periodo (SMA200), pendenza,
 *   MACD, RSI, Stochastic, Bollinger (%B come mean-reversion), momentum.
 *
 * I pesi non sono fissi: in regime direzionale (ADX alto) aumenta il peso
 * dei segnali di trend e si riduce quello dei segnali di ritorno alla media;
 * in regime laterale avviene l'opposto. Il punteggio finale e' in [-1, +1]
 * e viene convertito in probabilita' con una funzione logistica.
 * ========================================================================= */
(function (global) {
  'use strict';

  const I = global.Indicators;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function isNum(v) { return v != null && isFinite(v); }
  function logistic(x) { return 1 / (1 + Math.exp(-x)); }

  /** Approssimazione della funzione di ripartizione normale standard. */
  function normalCdf(z) {
    // Abramowitz & Stegun 7.1.26
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const cdf = 1 - (Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)) * poly;
    return z >= 0 ? cdf : 1 - cdf;
  }

  /* ---------------------------------------------------------------------
   * Punteggio al singolo indice: usato sia per l'analisi corrente sia per
   * il backtest (non guarda mai il futuro -> nessun look-ahead bias).
   * ------------------------------------------------------------------- */
  function scoreAtIndex(ind, i) {
    const close = ind.closes[i];
    const atr = isNum(ind.atr[i]) ? ind.atr[i] : Math.abs(close) * 0.005;
    const components = [];

    function add(key, label, score, weight, detail, bullText, bearText) {
      if (score == null || !isFinite(score)) return;
      components.push({
        key: key, label: label, score: clamp(score, -1, 1),
        weight: weight, detail: detail,
        bullText: bullText, bearText: bearText
      });
    }

    // 1. Allineamento delle medie esponenziali
    let trendScore = null, trendDetail = '\u2014';
    if (isNum(ind.ema9[i]) && isNum(ind.ema21[i]) && isNum(ind.ema50[i])) {
      const t1 = (ind.ema9[i] - ind.ema21[i]) / atr;
      const t2 = (ind.ema21[i] - ind.ema50[i]) / atr;
      trendScore = (t1 * 0.6 + t2 * 0.4) / 1.2;
      if (trendScore > 0.35) trendDetail = 'EMA 9 > 21 > 50: struttura rialzista';
      else if (trendScore < -0.35) trendDetail = 'EMA 9 < 21 < 50: struttura ribassista';
      else trendDetail = 'Medie compresse: nessuna struttura netta';
    }
    add('trend', 'Struttura medie', trendScore, 0.20, trendDetail,
      'Le medie esponenziali sono allineate al rialzo',
      'Le medie esponenziali sono allineate al ribasso');

    // 2. Bias di lungo periodo rispetto alla SMA200
    let biasScore = null, biasDetail = 'SMA200 non disponibile';
    if (isNum(ind.sma200[i])) {
      const dist = (close - ind.sma200[i]) / atr;
      biasScore = dist / 4;
      biasDetail = (dist >= 0 ? 'Prezzo sopra la SMA200 (+' : 'Prezzo sotto la SMA200 (') +
        dist.toFixed(2) + ' ATR)';
    }
    add('bias', 'Bias SMA200', biasScore, 0.08, biasDetail,
      'Il prezzo opera sopra la media di lungo periodo',
      'Il prezzo opera sotto la media di lungo periodo');

    // 3. Pendenza della media veloce
    let slopeScore = null, slopeDetail = '\u2014';
    if (isNum(ind.slope50[i])) {
      slopeScore = ind.slope50[i] / 0.0012 * 0.6;
      slopeDetail = 'Pendenza ' + (ind.slope50[i] >= 0 ? '+' : '') +
        (ind.slope50[i] * 100).toFixed(3) + '% per barra';
    }
    add('slope', 'Pendenza EMA50', slopeScore, 0.09, slopeDetail,
      'La media a 50 periodi sale con decisione',
      'La media a 50 periodi scende con decisione');

    // 4. MACD
    let macdScore = null, macdDetail = '\u2014';
    if (isNum(ind.macd.histogram[i])) {
      macdScore = ind.macd.histogram[i] / (atr * 0.9);
      const rising = i > 0 && isNum(ind.macd.histogram[i - 1]) && ind.macd.histogram[i] > ind.macd.histogram[i - 1];
      macdDetail = 'Istogramma ' + (macdScore >= 0 ? 'positivo' : 'negativo') +
        (rising ? ' e in aumento' : ' e in calo');
      macdScore = macdScore * (rising ? 1.1 : 0.9);
    }
    add('macd', 'MACD (12,26,9)', macdScore, 0.16, macdDetail,
      'Il MACD sostiene la pressione rialzista',
      'Il MACD conferma la pressione ribassista');

    // 5. RSI
    let rsiScore = null, rsiDetail = '\u2014';
    if (isNum(ind.rsi[i])) {
      rsiScore = (ind.rsi[i] - 50) / 50;
      if (ind.rsi[i] >= 70 || ind.rsi[i] <= 30) rsiScore *= 0.55; // estremi: rischio di ritorno
      rsiDetail = 'RSI(14) = ' + ind.rsi[i].toFixed(1) +
        (ind.rsi[i] >= 70 ? ' (ipercomprato)' : ind.rsi[i] <= 30 ? ' (ipervenduto)' : '');
    }
    add('rsi', 'RSI (14)', rsiScore, 0.12, rsiDetail,
      'RSI in area di forza senza estremi',
      'RSI in area di debolezza senza estremi');

    // 6. Stochastic
    let stochScore = null, stochDetail = '\u2014';
    if (isNum(ind.stoch.k[i])) {
      stochScore = (ind.stoch.k[i] - 50) / 35;
      if (ind.stoch.k[i] >= 85 || ind.stoch.k[i] <= 15) stochScore *= 0.5;
      stochDetail = '%K = ' + ind.stoch.k[i].toFixed(1) +
        (isNum(ind.stoch.d[i]) ? ' / %D = ' + ind.stoch.d[i].toFixed(1) : '');
    }
    add('stoch', 'Stochastic (14,3)', stochScore, 0.08, stochDetail,
      'Lo stochastic segnala slancio acquisti',
      'Lo stochastic segnala slancio vendite');

    // 7. Bollinger: componente di ritorno alla media
    let bbScore = null, bbDetail = '\u2014';
    if (isNum(ind.bb.percentB[i])) {
      bbScore = -(ind.bb.percentB[i] - 0.5) * 2;
      bbDetail = '%B = ' + ind.bb.percentB[i].toFixed(2) +
        (ind.bb.percentB[i] > 1 ? ' (sopra la banda superiore)' :
          ind.bb.percentB[i] < 0 ? ' (sotto la banda inferiore)' : ' (dentro le bande)');
    }
    add('bb', 'Bollinger (20,2)', bbScore, 0.10, bbDetail,
      'Il prezzo e\u0300 compresso verso la banda inferiore',
      'Il prezzo e\u0300 esteso verso la banda superiore');

    // 8. Momentum multiplo
    let momScore = null, momDetail = '\u2014';
    if (isNum(ind.roc5[i]) && isNum(ind.roc20[i])) {
      const unit = atr / close;
      momScore = (ind.roc5[i] / (unit * 3)) * 0.6 + (ind.roc20[i] / (unit * 8)) * 0.4;
      momDetail = 'ROC 5 barre ' + (ind.roc5[i] * 100).toFixed(2) + '%, 20 barre ' +
        (ind.roc20[i] * 100).toFixed(2) + '%';
    }
    add('momentum', 'Momentum', momScore, 0.12, momDetail,
      'Il momentum su piu\u0300 orizzonti e\u0300 positivo',
      'Il momentum su piu\u0300 orizzonti e\u0300 negativo');

    /* ---- pesi adattivi in base al regime di forza del trend ---- */
    const adxVal = isNum(ind.adx[i]) ? ind.adx[i] : 20;
    const trendRegime = clamp((adxVal - 18) / 22, 0, 1); // 0 = laterale, 1 = direzionale
    components.forEach(function (c) {
      if (c.key === 'bb' || c.key === 'stoch') {
        c.weight *= (1.45 - 0.95 * trendRegime);   // mean-reversion in laterale
      }
      if (c.key === 'trend' || c.key === 'slope' || c.key === 'macd') {
        c.weight *= (0.75 + 0.55 * trendRegime);   // trend-following in direzionale
      }
    });

    let wSum = 0, total = 0, concordance = 0;
    components.forEach(function (c) {
      wSum += c.weight;
      total += c.score * c.weight;
      concordance += Math.sign(c.score) * c.weight;
    });
    if (wSum === 0) return { score: 0, components: components, adx: adxVal, atr: atr, trendRegime: trendRegime };

    total /= wSum;
    concordance /= wSum;

    return {
      score: clamp(total, -1, 1),
      agreement: Math.abs(concordance),
      components: components,
      adx: adxVal,
      atr: atr,
      trendRegime: trendRegime
    };
  }

  /* ---------------------------------------------------------------------
   * Analisi completa
   * ------------------------------------------------------------------- */
  function analyze(candles, instrument, horizon) {
    const ind = I.computeAll(candles);
    const i = candles.length - 1;
    const close = candles[i].close;
    const s = scoreAtIndex(ind, i);
    const atr = s.atr;

    const score = s.score;
    const direction = score > 0.08 ? 'BUY' : (score < -0.08 ? 'SELL' : 'NEUTRAL');
    // In caso di segnale neutro il piano operativo segue comunque il segno
    // dello score, così TP e SL restano coerenti e il rapporto R:R calcolabile.
    const dirSign = direction === 'BUY' ? 1 : direction === 'SELL' ? -1 : (score >= 0 ? 1 : -1);

    // Probabilita' rialzista
    const probabilityUp = logistic(score * 3.6);
    const adxNorm = clamp((s.adx - 12) / 30, 0, 1);

    // Confidenza: forza del segnale + consenso interno + forza del trend
    let confidence = 0.50 * Math.abs(score) + 0.30 * s.agreement + 0.20 * adxNorm;
    confidence = clamp(confidence * 0.92 + 0.06, 0.04, 0.96);
    if (direction === 'NEUTRAL') confidence = Math.min(confidence, 0.55);

    // Volatilita' relativa (ATR in % del prezzo) -> attendibilita' minore se troppo alta
    const atrPct = atr / close * 100;
    const volPenalty = atrPct > 1.6 ? 0.9 : 1;
    confidence = clamp(confidence * volPenalty, 0.03, 0.96);

    // Movimento atteso: drift proporzionale al segnale, scala con sqrt(orizzonte)
    const sqH = Math.sqrt(horizon);
    const expectedMove = score * atr * sqH * 0.62;

    const entry = close;
    const tpDistance = Math.max(Math.abs(expectedMove), atr * 1.15);
    const slDistance = Math.max(atr * 1.45, Math.abs(expectedMove) * 0.85 + atr * 0.4);
    const target = entry + dirSign * tpDistance;
    const stop = entry - dirSign * slDistance;
    const rr = slDistance === 0 ? 0 : tpDistance / slDistance;

    // Traiettoria proiettata con banda di incertezza a 1 sigma
    const projection = [];
    for (let k = 1; k <= horizon; k++) {
      const sk = Math.sqrt(k);
      const mid = entry + score * atr * sk * 0.62;
      const band = atr * sk * 1.10;
      projection.push({ step: k, mid: mid, upper: mid + band, lower: mid - band });
    }

    // Probabilita' di toccare livelli multipli di ATR entro l'orizzonte.
    // La distribuzione del prezzo finale e' centrata su (entry + muH):
    // muH e' un delta di prezzo, non un livello assoluto.
    const sigmaH = atr * sqH;
    const muH = score * atr * sqH * 0.62;
    const center = entry + muH;
    const levelMultiples = [2, 1.5, 1, 0.5];
    const levels = [];
    levelMultiples.forEach(function (m) {
      const upLevel = entry + m * atr;
      const dnLevel = entry - m * atr;
      const pUp = clamp(2 * (1 - normalCdf((upLevel - center) / sigmaH)), 0.01, 0.97);
      const pDn = clamp(2 * normalCdf((dnLevel - center) / sigmaH), 0.01, 0.97);
      levels.push({ multiple: m, up: upLevel, down: dnLevel, pUp: pUp, pDn: pDn });
    });

    // Motivazioni leggibili
    const reasons = buildReasons(s, direction, score, atr, atrPct, close, instrument, probabilityUp);

    return {
      index: i,
      price: close,
      time: candles[i].time,
      score: score,
      agreement: s.agreement,
      direction: direction,
      confidence: confidence,
      probabilityUp: probabilityUp,
      probabilityDown: 1 - probabilityUp,
      atr: atr,
      atrPct: atrPct,
      adx: s.adx,
      trendRegime: s.trendRegime,
      components: s.components,
      expectedMove: expectedMove,
      target: target,
      stop: stop,
      rr: rr,
      horizon: horizon,
      projection: projection,
      levels: levels,
      reasons: reasons,
      indicators: ind
    };
  }

  function buildReasons(s, direction, score, atr, atrPct, close, instrument, probUp) {
    const out = [];
    const sorted = s.components.slice().sort(function (a, b) {
      return Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight);
    });

    // Sintesi d'insieme
    const strength = Math.abs(score);
    const label = strength > 0.45 ? 'marcata' : strength > 0.22 ? 'moderata' : 'debole';
    out.push({
      tone: direction === 'BUY' ? 'bull' : direction === 'SELL' ? 'bear' : 'flat',
      text: 'Inclinazione complessiva ' + label + ' verso ' +
        (direction === 'BUY' ? 'il rialzo' : direction === 'SELL' ? 'il ribasso' : 'la neutralita\u0300') +
        ' (score ' + (score >= 0 ? '+' : '') + score.toFixed(3) + ').'
    });

    sorted.slice(0, 4).forEach(function (c) {
      if (Math.abs(c.score) < 0.12) return;
      const tone = c.score > 0 ? 'bull' : 'bear';
      out.push({
        tone: tone,
        text: c.label + ': ' + (tone === 'bull' ? c.bullText : c.bearText) + ' \u2014 ' + c.detail + '.'
      });
    });

    // Contesto di volatilita'
    out.push({
      tone: 'flat',
      text: 'ATR(14) pari a ' + atr.toFixed(instrument.digits) + ' (' + atrPct.toFixed(2) +
        '% del prezzo): ' + (atrPct > 1.1 ? 'volatilita\u0300 elevata, ridurre la size' :
          atrPct < 0.35 ? 'volatilita\u0300 contenuta, movimenti potenzialmente lenti' :
            'volatilita\u0300 nella norma storica') + '.'
    });

    // Regime
    const trendTxt = s.trendRegime > 0.6 ? 'di tendenza (ADX ' + s.adx.toFixed(1) + ')' :
      s.trendRegime < 0.3 ? 'laterale (ADX ' + s.adx.toFixed(1) + ')' :
        'misto (ADX ' + s.adx.toFixed(1) + ')';
    out.push({
      tone: 'flat',
      text: 'Regime di mercato ' + trendTxt + ': ' +
        (s.trendRegime > 0.6 ? 'i segnali direzionali hanno peso maggiore.' :
          'i segnali di ritorno alla media hanno peso maggiore.')
    });

    out.push({
      tone: probUp > 0.5 ? 'bull' : 'bear',
      text: 'Probabilita\u0300 stimata di chiusura rialzista sull\u2019orizzonte: ' +
        (probUp * 100).toFixed(1) + '% contro ' + ((1 - probUp) * 100).toFixed(1) + '% ribassista.'
    });

    return out;
  }

  /* ---------------------------------------------------------------------
   * Backtest walk-forward senza look-ahead: le decisioni usano solo dati
   * disponibili alla barra i, l'esito e' valutato h barre dopo.
   * ------------------------------------------------------------------- */
  function backtest(candles, instrument, horizon, opts) {
    opts = opts || {};
    const startAt = Math.max(210, candles.length - (opts.window || 250));
    const ind = I.computeAll(candles);
    // Costo di transazione espresso in unità di prezzo (spread in pip x valore del pip)
    const cost = global.ForexData.pipSize(instrument) * (instrument.spread || 1);
    const trades = [];

    for (let i = startAt; i + horizon < candles.length; i++) {
      if (!isNum(ind.atr[i])) continue;
      const s = scoreAtIndex(ind, i);
      if (Math.abs(s.score) < 0.08) continue;

      const dir = s.score > 0 ? 1 : -1;
      const entry = ind.closes[i] + dir * cost;      // il costo si paga sempre
      const exit = ind.closes[i + horizon];
      const rMove = (exit - entry) * dir;
      // risultato espresso in multipli di ATR (R normalizzato)
      const rMultiple = rMove / s.atr;
      trades.push({
        index: i,
        time: candles[i].time,
        dir: dir,
        entry: entry,
        exit: exit,
        r: rMultiple,
        win: rMultiple > 0
      });
    }

    const wins = trades.filter(function (t) { return t.win; });
    const losses = trades.filter(function (t) { return !t.win; });
    const grossWin = wins.reduce(function (a, t) { return a + t.r; }, 0);
    const grossLoss = Math.abs(losses.reduce(function (a, t) { return a + t.r; }, 0));
    const expectancy = trades.length ? trades.reduce(function (a, t) { return a + t.r; }, 0) / trades.length : 0;

    // Curva equity in punti R cumulati
    let cum = 0;
    const equity = trades.map(function (t) { cum += t.r; return cum; });
    const peak = { max: 0, value: 0 };
    let runningPeak = 0, maxDd = 0;
    equity.forEach(function (v) {
      if (v > runningPeak) runningPeak = v;
      const dd = runningPeak - v;
      if (dd > maxDd) maxDd = dd;
    });
    peak.max = maxDd;

    return {
      trades: trades,
      count: trades.length,
      winRate: trades.length ? wins.length / trades.length : 0,
      avgR: expectancy,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? grossLoss / losses.length : 0,
      profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss,
      totalR: cum,
      maxDrawdown: maxDd,
      equity: equity
    };
  }

  global.Forecast = {
    analyze: analyze,
    backtest: backtest,
    scoreAtIndex: scoreAtIndex,
    normalCdf: normalCdf
  };
})(window);
