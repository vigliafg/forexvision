/* =========================================================================
 * indicators.js - Libreria di indicatori tecnici
 * Ogni funzione accetta array di numeri e restituisce un array allineato
 * (con null nelle posizioni non ancora calcolabili).
 * ========================================================================= */
(function (global) {
  'use strict';

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let prev = null;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) { sum += values[i]; continue; }
      if (i === period - 1) {
        sum += values[i];
        prev = sum / period;
        out[i] = prev;
        continue;
      }
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function stdev(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      let mean = 0;
      for (let j = i - period + 1; j <= i; j++) mean += values[j];
      mean /= period;
      let acc = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const d = values[j] - mean;
        acc += d * d;
      }
      out[i] = Math.sqrt(acc / period);
    }
    return out;
  }

  /** RSI di Wilder. */
  function rsi(values, period) {
    period = period || 14;
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  /** MACD: {macd, signal, histogram} */
  function macd(values, fast, slow, signalPeriod) {
    fast = fast || 12; slow = slow || 26; signalPeriod = signalPeriod || 9;
    const emaFast = ema(values, fast);
    const emaSlow = ema(values, slow);
    const macdLine = values.map(function (_, i) {
      return (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null;
    });
    // EMA della linea MACD, calcolata solo sui valori validi
    const firstIdx = macdLine.findIndex(function (v) { return v != null; });
    const dense = firstIdx === -1 ? [] : macdLine.slice(firstIdx);
    const sigDense = ema(dense, signalPeriod);
    const signal = new Array(values.length).fill(null);
    if (firstIdx !== -1) {
      for (let i = 0; i < sigDense.length; i++) {
        if (sigDense[i] != null) signal[firstIdx + i] = sigDense[i];
      }
    }
    const histogram = values.map(function (_, i) {
      return (macdLine[i] != null && signal[i] != null) ? macdLine[i] - signal[i] : null;
    });
    return { macd: macdLine, signal: signal, histogram: histogram };
  }

  /** Bande di Bollinger: {upper, middle, lower, percentB, bandwidth} */
  function bollinger(values, period, mult) {
    period = period || 20; mult = mult || 2;
    const middle = sma(values, period);
    const sd = stdev(values, period);
    const upper = new Array(values.length).fill(null);
    const lower = new Array(values.length).fill(null);
    const percentB = new Array(values.length).fill(null);
    const bandwidth = new Array(values.length).fill(null);
    for (let i = 0; i < values.length; i++) {
      if (middle[i] == null || sd[i] == null) continue;
      upper[i] = middle[i] + mult * sd[i];
      lower[i] = middle[i] - mult * sd[i];
      const span = upper[i] - lower[i];
      percentB[i] = span === 0 ? 0.5 : (values[i] - lower[i]) / span;
      bandwidth[i] = middle[i] === 0 ? 0 : span / middle[i];
    }
    return { upper: upper, middle: middle, lower: lower, percentB: percentB, bandwidth: bandwidth };
  }

  /** Stochastic oscillator: {k, d} */
  function stochastic(highs, lows, closes, kPeriod, dPeriod) {
    kPeriod = kPeriod || 14; dPeriod = dPeriod || 3;
    const k = new Array(closes.length).fill(null);
    for (let i = kPeriod - 1; i < closes.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) {
        if (highs[j] > hh) hh = highs[j];
        if (lows[j] < ll) ll = lows[j];
      }
      const span = hh - ll;
      k[i] = span === 0 ? 50 : ((closes[i] - ll) / span) * 100;
    }
    // %D = media mobile di %K, calcolata solo sui valori validi di %K
    const firstK = k.findIndex(function (v) { return v != null; });
    const d = new Array(k.length).fill(null);
    if (firstK !== -1) {
      const denseD = sma(k.slice(firstK), dPeriod);
      for (let i = 0; i < denseD.length; i++) {
        if (denseD[i] != null) d[firstK + i] = denseD[i];
      }
    }
    return { k: k, d: d };
  }

  /** ATR di Wilder (in unita' di prezzo). */
  function atr(highs, lows, closes, period) {
    period = period || 14;
    const tr = new Array(closes.length).fill(null);
    for (let i = 1; i < closes.length; i++) {
      tr[i] = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
    }
    const out = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return out;
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr[i];
    let prev = sum / period;
    out[period] = prev;
    for (let i = period + 1; i < closes.length; i++) {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
    return out;
  }

  /** ADX semplificato (forza del trend, 0-100). */
  function adx(highs, lows, closes, period) {
    period = period || 14;
    const n = closes.length;
    const plusDM = new Array(n).fill(0);
    const minusDM = new Array(n).fill(0);
    const tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const up = highs[i] - highs[i - 1];
      const dn = lows[i - 1] - lows[i];
      plusDM[i] = (up > dn && up > 0) ? up : 0;
      minusDM[i] = (dn > up && dn > 0) ? dn : 0;
      tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }
    const smoothPlus = ema(plusDM, period);
    const smoothMinus = ema(minusDM, period);
    const smoothTr = ema(tr, period);
    const dx = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (smoothTr[i] == null || smoothTr[i] === 0) continue;
      const pdi = 100 * smoothPlus[i] / smoothTr[i];
      const mdi = 100 * smoothMinus[i] / smoothTr[i];
      const sum = pdi + mdi;
      dx[i] = sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum;
    }
    const first = dx.findIndex(function (v) { return v != null; });
    const adxLine = new Array(n).fill(null);
    if (first !== -1) {
      const dense = ema(dx.slice(first).map(function (v) { return v == null ? 0 : v; }), period);
      for (let i = 0; i < dense.length; i++) if (dense[i] != null) adxLine[first + i] = dense[i];
    }
    return adxLine;
  }

  /** Calcola l'intero set di indicatori su una serie di candele. */
  function computeAll(candles) {
    const closes = candles.map(function (c) { return c.close; });
    const highs = candles.map(function (c) { return c.high; });
    const lows = candles.map(function (c) { return c.low; });
    const volumes = candles.map(function (c) { return c.volume; });

    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const ema50 = ema(closes, 50);
    const sma200 = sma(closes, 200);
    const volumeSma = sma(volumes, 20);
    const stoch = stochastic(highs, lows, closes, 14, 3);
    const bb = bollinger(closes, 20, 2);
    const macdRes = macd(closes, 12, 26, 9);
    const rsi14 = rsi(closes, 14);
    const atr14 = atr(highs, lows, closes, 14);
    const adx14 = adx(highs, lows, closes, 14);

    // Momentum su piu' orizzonti
    function pctChange(period) {
      const out = new Array(closes.length).fill(null);
      for (let i = period; i < closes.length; i++) {
        out[i] = (closes[i] - closes[i - period]) / closes[i - period];
      }
      return out;
    }
    const roc5 = pctChange(5);
    const roc20 = pctChange(20);

    // Pendenza della SMA50 in % per barra
    const slope50 = new Array(closes.length).fill(null);
    for (let i = 5; i < closes.length; i++) {
      if (ema50[i] != null && ema50[i - 5] != null && ema50[i - 5] !== 0) {
        slope50[i] = (ema50[i] - ema50[i - 5]) / ema50[i - 5] / 5;
      }
    }

    return {
      closes: closes, highs: highs, lows: lows, volumes: volumes,
      ema9: ema9, ema21: ema21, ema50: ema50, sma200: sma200,
      rsi: rsi14, macd: macdRes, bb: bb, stoch: stoch,
      atr: atr14, adx: adx14, volumeSma: volumeSma,
      roc5: roc5, roc20: roc20, slope50: slope50
    };
  }

  function last(arr) {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  }

  global.Indicators = {
    sma: sma, ema: ema, stdev: stdev, rsi: rsi, macd: macd,
    bollinger: bollinger, stochastic: stochastic, atr: atr, adx: adx,
    computeAll: computeAll, last: last
  };
})(window);
