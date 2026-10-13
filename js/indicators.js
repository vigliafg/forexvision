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

  /** DMI di Wilder: direzione (+DI / -DI) e forza (ADX) in un solo passaggio.
   *  Restituisce {plusDI, minusDI, adx}: tre array allineati alle candele. */
  function dmi(highs, lows, closes, period) {
    period = period || 14;
    const n = closes.length;
    const plusDI = new Array(n).fill(null);
    const minusDI = new Array(n).fill(null);
    const out = new Array(n).fill(null);
    if (n < period * 2 + 1) return { plusDI: plusDI, minusDI: minusDI, adx: out };
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
    // Smoothing di Wilder: primo valore = media dei primi `period` incrementi,
    // poi ricorsione arr[i] = arr[i-1] - arr[i-1]/period + nuovo.
    function wilder(values, firstIdx, p) {
      const arr = new Array(values.length).fill(null);
      let sum = 0;
      for (let i = firstIdx; i < firstIdx + p; i++) sum += values[i];
      arr[firstIdx + p - 1] = sum / p;
      for (let i = firstIdx + p; i < values.length; i++) {
        arr[i] = arr[i - 1] - arr[i - 1] / p + values[i];
      }
      return arr;
    }
    const smoothPlus = wilder(plusDM, 1, period);
    const smoothMinus = wilder(minusDM, 1, period);
    const smoothTr = wilder(tr, 1, period);
    const dx = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (smoothTr[i] == null || smoothTr[i] === 0) continue;
      const pdi = 100 * smoothPlus[i] / smoothTr[i];
      const mdi = 100 * smoothMinus[i] / smoothTr[i];
      plusDI[i] = pdi;
      minusDI[i] = mdi;
      const sum = pdi + mdi;
      dx[i] = sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum;
    }
    // ADX di Wilder: primo valore = media dei primi `period` DX, poi ricorsione.
    const first = 2 * period - 1;             // primo indice con DX definito
    if (first + period - 1 >= n) return { plusDI: plusDI, minusDI: minusDI, adx: out };
    let dxSum = 0;
    for (let i = first - period + 1; i <= first; i++) dxSum += dx[i];
    out[first] = dxSum / period;
    for (let i = first + 1; i < n; i++) {
      out[i] = (out[i - 1] * (period - 1) + dx[i]) / period;
    }
    return { plusDI: plusDI, minusDI: minusDI, adx: out };
  }

  /** ADX di Wilder (forza del trend, 0-100). */
  function adx(highs, lows, closes, period) {
    return dmi(highs, lows, closes, period).adx;
  }

  /** ADXR: media fra l'ADX corrente e quello di `period` barre fa. Dice se la
   *  tendenza si sta rafforzando (ADX > ADXR) o spegnendo (ADX < ADXR). */
  function adxr(adxArr, period) {
    period = period || 14;
    const out = new Array(adxArr.length).fill(null);
    for (let i = period; i < adxArr.length; i++) {
      if (adxArr[i] != null && adxArr[i - period] != null) {
        out[i] = (adxArr[i] + adxArr[i - period]) / 2;
      }
    }
    return out;
  }

  /** SuperTrend: {line, dir}. dir = 1 tendenza rialzista, -1 ribassista; la
   *  linea e' il livello che fa da sostegno (rialzo) o resistenza (ribasso). */
  function supertrend(highs, lows, closes, period, mult) {
    period = period || 10; mult = mult || 3;
    const n = closes.length;
    const atrArr = atr(highs, lows, closes, period);
    const line = new Array(n).fill(null);
    const dir = new Array(n).fill(null);
    let prevUpper = null, prevLower = null, prevDir = 1, started = false;
    for (let i = 0; i < n; i++) {
      if (atrArr[i] == null) continue;
      const mid = (highs[i] + lows[i]) / 2;
      const basicUpper = mid + mult * atrArr[i];
      const basicLower = mid - mult * atrArr[i];
      if (!started) {
        started = true;
        prevUpper = basicUpper; prevLower = basicLower;
        prevDir = closes[i] >= mid ? 1 : -1;
        line[i] = prevDir === 1 ? prevLower : prevUpper;
        dir[i] = prevDir;
        continue;
      }
      // le bande si stringono solo, non si allargano, finche' il prezzo non
      // le rompe: e' la regola che rende il SuperTrend un trailing stop
      const upper = (basicUpper < prevUpper || closes[i - 1] > prevUpper) ? basicUpper : prevUpper;
      const lower = (basicLower > prevLower || closes[i - 1] < prevLower) ? basicLower : prevLower;
      let d = prevDir;
      if (prevDir === 1 && closes[i] < prevLower) d = -1;
      else if (prevDir === -1 && closes[i] > prevUpper) d = 1;
      prevUpper = upper; prevLower = lower; prevDir = d;
      line[i] = d === 1 ? lower : upper;
      dir[i] = d;
    }
    return { line: line, dir: dir };
  }

  /** Parabolic SAR di Wilder (punti di inversione). */
  function psar(highs, lows, step, max) {
    step = step || 0.02; max = max || 0.2;
    const n = highs.length;
    const out = new Array(n).fill(null);
    if (n < 3) return out;
    let isLong = highs[1] >= highs[0];
    let af = step;
    let ep = isLong ? highs[0] : lows[0];       // punto estremo
    let sar = isLong ? lows[0] : highs[0];
    out[0] = sar;
    for (let i = 1; i < n; i++) {
      const j = i > 1 ? i - 2 : i - 1;
      let next = sar + af * (ep - sar);
      if (isLong) {
        next = Math.min(next, lows[i - 1], lows[j]);
        if (lows[i] < next) { isLong = false; next = ep; ep = lows[i]; af = step; }
        else if (highs[i] > ep) { ep = highs[i]; af = Math.min(max, af + step); }
      } else {
        next = Math.max(next, highs[i - 1], highs[j]);
        if (highs[i] > next) { isLong = true; next = ep; ep = highs[i]; af = step; }
        else if (lows[i] < ep) { ep = lows[i]; af = Math.min(max, af + step); }
      }
      sar = next;
      out[i] = sar;
    }
    return out;
  }

  /** Aroon: {up, down, osc}. Misura da quante barre il massimo (o il minimo)
   *  del periodo e' il piu' recente: 100 = appena fatto, 0 = mai. */
  function aroon(highs, lows, period) {
    period = period || 25;
    const n = highs.length;
    const up = new Array(n).fill(null);
    const down = new Array(n).fill(null);
    const osc = new Array(n).fill(null);
    for (let i = period; i < n; i++) {
      let hh = -Infinity, ll = Infinity, hi = i, li = i;
      for (let j = i - period; j <= i; j++) {
        if (highs[j] >= hh) { hh = highs[j]; hi = j; }
        if (lows[j] <= ll) { ll = lows[j]; li = j; }
      }
      up[i] = 100 * (period - (i - hi)) / period;
      down[i] = 100 * (period - (i - li)) / period;
      osc[i] = up[i] - down[i];
    }
    return { up: up, down: down, osc: osc };
  }

  /** Vortex: {plus, minus}. L'incrocio delle due linee segnala il cambio di
   *  direzione; a differenza dell'ADX (che misura solo la forza) dice il verso. */
  function vortex(highs, lows, closes, period) {
    period = period || 14;
    const n = closes.length;
    const plus = new Array(n).fill(null);
    const minus = new Array(n).fill(null);
    if (n < period + 1) return { plus: plus, minus: minus };
    const vp = new Array(n).fill(0), vm = new Array(n).fill(0), tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      vp[i] = Math.abs(highs[i] - lows[i - 1]);
      vm[i] = Math.abs(lows[i] - highs[i - 1]);
      tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }
    let sPlus = 0, sMinus = 0, sTr = 0;
    for (let i = period; i < n; i++) {
      if (i === period) {
        for (let j = 1; j <= period; j++) { sPlus += vp[j]; sMinus += vm[j]; sTr += tr[j]; }
      } else {
        sPlus += vp[i] - vp[i - period];
        sMinus += vm[i] - vm[i - period];
        sTr += tr[i] - tr[i - period];
      }
      if (sTr === 0) continue;
      plus[i] = sPlus / sTr;
      minus[i] = sMinus / sTr;
    }
    return { plus: plus, minus: minus };
  }

  /** CCI di Lambert (20): oscillatore di inversione attorno a +/-100. */
  function cci(highs, lows, closes, period) {
    period = period || 20;
    const n = closes.length;
    const out = new Array(n).fill(null);
    const tp = new Array(n);
    for (let i = 0; i < n; i++) tp[i] = (highs[i] + lows[i] + closes[i]) / 3;
    for (let i = period - 1; i < n; i++) {
      let mean = 0;
      for (let j = i - period + 1; j <= i; j++) mean += tp[j];
      mean /= period;
      let dev = 0;
      for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - mean);
      dev /= period;
      out[i] = dev === 0 ? 0 : (tp[i] - mean) / (0.015 * dev);
    }
    return out;
  }

  /** Media mobile semplice su una serie che inizia con null, riallineata. */
  function smaFrom(arr, period) {
    const out = new Array(arr.length).fill(null);
    const first = arr.findIndex(function (v) { return v != null; });
    if (first === -1) return out;
    const dense = sma(arr.slice(first), period);
    for (let i = 0; i < dense.length; i++) {
      if (dense[i] != null) out[first + i] = dense[i];
    }
    return out;
  }

  /** Stochastic RSI: {k, d}. Lo Stocastico applicato all'RSI: piu' reattivo
   *  dello Stocastico classico sugli estremi. */
  function stochRsi(closes, rsiPeriod, stochPeriod, kPeriod, dPeriod) {
    rsiPeriod = rsiPeriod || 14; stochPeriod = stochPeriod || 14;
    kPeriod = kPeriod || 3; dPeriod = dPeriod || 3;
    const r = rsi(closes, rsiPeriod);
    const raw = new Array(closes.length).fill(null);
    for (let i = rsiPeriod + stochPeriod - 1; i < closes.length; i++) {
      let hh = -Infinity, ll = Infinity, bad = false;
      for (let j = i - stochPeriod + 1; j <= i; j++) {
        if (r[j] == null) { bad = true; break; }
        if (r[j] > hh) hh = r[j];
        if (r[j] < ll) ll = r[j];
      }
      if (bad) continue;
      raw[i] = hh === ll ? 50 : (r[i] - ll) / (hh - ll) * 100;
    }
    return { k: smaFrom(raw, kPeriod), d: smaFrom(smaFrom(raw, kPeriod), dPeriod) };
  }

  /** Choppiness Index (14): 0-38 tendenza, 62-100 laterale. Distingue il
   *  regime meglio dell'ADX, che e' in ritardo sul cambio di carattere. */
  function choppiness(highs, lows, closes, period) {
    period = period || 14;
    const n = closes.length;
    const out = new Array(n).fill(null);
    if (n < period + 1) return out;
    const tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }
    const logP = Math.log10(period);
    for (let i = period; i < n; i++) {
      let sum = 0, hh = -Infinity, ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        sum += tr[j];
        if (highs[j] > hh) hh = highs[j];
        if (lows[j] < ll) ll = lows[j];
      }
      const span = hh - ll;
      if (span <= 0) { out[i] = 100; continue; }
      if (sum <= 0) { out[i] = 0; continue; }
      out[i] = Math.max(0, Math.min(100, 100 * Math.log10(sum / span) / logP));
    }
    return out;
  }

  /** Canali di Keltner: {upper, middle, lower} (media esponenziale +/- ATR). */
  function keltner(highs, lows, closes, emaPeriod, atrPeriod, mult) {
    emaPeriod = emaPeriod || 20; atrPeriod = atrPeriod || 10; mult = mult || 2;
    const middle = ema(closes, emaPeriod);
    const atrArr = atr(highs, lows, closes, atrPeriod);
    const n = closes.length;
    const upper = new Array(n).fill(null);
    const lower = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (middle[i] == null || atrArr[i] == null) continue;
      upper[i] = middle[i] + mult * atrArr[i];
      lower[i] = middle[i] - mult * atrArr[i];
    }
    return { upper: upper, middle: middle, lower: lower };
  }

  /** Ichimoku Kinko Hyo: {tenkan, kijun, spanA, spanB, chikou}.
   *  spanA/spanB sono la nuvola *alla barra corrente* (calcolata `kijun` barre
   *  prima), quindi l'analisi resta causale; chikou e' la distanza fra la
   *  chiusura attuale e quella di `kijun` barre fa (conferma del ritardo). */
  function ichimoku(highs, lows, closes, tenkanP, kijunP, senkouBP) {
    tenkanP = tenkanP || 9; kijunP = kijunP || 26; senkouBP = senkouBP || 52;
    const n = closes.length;
    function midRange(period) {
      const arr = new Array(n).fill(null);
      for (let i = period - 1; i < n; i++) {
        let hh = -Infinity, ll = Infinity;
        for (let j = i - period + 1; j <= i; j++) {
          if (highs[j] > hh) hh = highs[j];
          if (lows[j] < ll) ll = lows[j];
        }
        arr[i] = (hh + ll) / 2;
      }
      return arr;
    }
    const tenkan = midRange(tenkanP);
    const kijun = midRange(kijunP);
    const bRaw = midRange(senkouBP);
    const spanA = new Array(n).fill(null);
    const spanB = new Array(n).fill(null);
    const chikou = new Array(n).fill(null);
    for (let i = kijunP; i < n; i++) {
      if (tenkan[i - kijunP] != null && kijun[i - kijunP] != null) {
        spanA[i] = (tenkan[i - kijunP] + kijun[i - kijunP]) / 2;
      }
      spanB[i] = bRaw[i - kijunP];
      chikou[i] = closes[i] - closes[i - kijunP];
    }
    return { tenkan: tenkan, kijun: kijun, spanA: spanA, spanB: spanB, chikou: chikou };
  }

  /** Canale di regressione lineare: {mid, slope, r2, upper, lower}.
   *  R2 misura quanto la tendenza e' "pulita" (1 = retta perfetta). */
  function linreg(values, period) {
    period = period || 50;
    const n = values.length;
    const mid = new Array(n).fill(null);
    const slope = new Array(n).fill(null);
    const r2 = new Array(n).fill(null);
    const upper = new Array(n).fill(null);
    const lower = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let k = 0; k < period; k++) {
        const y = values[i - period + 1 + k];
        sx += k; sy += y; sxx += k * k; sxy += k * y;
      }
      const denom = period * sxx - sx * sx;
      if (denom === 0) continue;
      const b = (period * sxy - sx * sy) / denom;
      const a = (sy - b * sx) / period;
      const mean = sy / period;
      let ssTot = 0, ssRes = 0;
      for (let k = 0; k < period; k++) {
        const y = values[i - period + 1 + k];
        const fit = a + b * k;
        ssTot += (y - mean) * (y - mean);
        ssRes += (y - fit) * (y - fit);
      }
      slope[i] = b;
      mid[i] = a + b * (period - 1);
      r2[i] = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
      const sd = Math.sqrt(ssRes / period);
      upper[i] = mid[i] + 2 * sd;
      lower[i] = mid[i] - 2 * sd;
    }
    return { mid: mid, slope: slope, r2: r2, upper: upper, lower: lower };
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
    const dmi14 = dmi(highs, lows, closes, 14);
    const adx14 = dmi14.adx;

    // --- indicatori di trend e di inversione ---
    const adxr14 = adxr(adx14, 14);
    const superTrend = supertrend(highs, lows, closes, 10, 3);
    const psar14 = psar(highs, lows, 0.02, 0.2);
    const aroon25 = aroon(highs, lows, 25);
    const vortex14 = vortex(highs, lows, closes, 14);
    const cci20 = cci(highs, lows, closes, 20);
    const stochRsiRes = stochRsi(closes, 14, 14, 3, 3);
    const chop14 = choppiness(highs, lows, closes, 14);
    const keltner20 = keltner(highs, lows, closes, 20, 10, 2);
    const ichimokuRes = ichimoku(highs, lows, closes, 9, 26, 52);
    const linreg50 = linreg(closes, 50);

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
      roc5: roc5, roc20: roc20, slope50: slope50,
      plusDI: dmi14.plusDI, minusDI: dmi14.minusDI, adxr: adxr14,
      superTrend: superTrend, psar: psar14, aroon: aroon25, vortex: vortex14,
      cci: cci20, stochRsi: stochRsiRes, choppiness: chop14,
      keltner: keltner20, ichimoku: ichimokuRes, linreg: linreg50
    };
  }

  function last(arr) {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  }

  /** Chiave del periodo di contrattazione di una candela, in UTC:
   *  il giorno per i timeframe infragiornalieri, la settimana per il
   *  giornaliero (i pivot settimanali sono i piu' usati sul daily). */
  function periodKey(time, tfMinutes) {
    const d = new Date(time);
    if (tfMinutes >= 1440) {
      // lunedi' della settimana ISO, in UTC
      const day = (d.getUTCDay() + 6) % 7;
      const week = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
      return week.getUTCFullYear() + '-' + (week.getUTCMonth() + 1) + '-' + week.getUTCDate();
    }
    return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
  }

  /** Pivot point classici e Camarilla dell'ultimo periodo chiuso.
   *  Servono livelli oggettivi di riferimento per l'intraday: si usano il
   *  massimo, il minimo e la chiusura del periodo precedente, quindi il
   *  calcolo non guarda mai la candela in formazione.
   *  @returns {Object|null} {period, high, low, close, classic:{...}, camarilla:{...}} */
  function pivotPoints(candles, tfMinutes) {
    if (!candles || candles.length < 3) return null;
    const periods = [];              // [{key, high, low, close}]
    let cur = null;
    for (let i = 0; i < candles.length; i++) {
      const key = periodKey(candles[i].time, tfMinutes || 60);
      if (!cur || cur.key !== key) {
        cur = { key: key, high: candles[i].high, low: candles[i].low, close: candles[i].close };
        periods.push(cur);
      } else {
        if (candles[i].high > cur.high) cur.high = candles[i].high;
        if (candles[i].low < cur.low) cur.low = candles[i].low;
        cur.close = candles[i].close;
      }
    }
    if (periods.length < 2) return null;
    // l'ultimo periodo e' quello in corso: i pivot si calcolano sul precedente
    const p = periods[periods.length - 2];
    const high = p.high, low = p.low, close = p.close;
    const range = high - low;
    const base = (high + low + close) / 3;
    const classic = {
      p: base,
      r1: 2 * base - low,
      s1: 2 * base - high,
      r2: base + range,
      s2: base - range,
      r3: high + 2 * (base - low),
      s3: low - 2 * (high - base)
    };
    const c = range * 1.1;
    const camarilla = {
      r4: close + c / 2, r3: close + c / 4, r2: close + c / 6, r1: close + c / 12,
      s1: close - c / 12, s2: close - c / 6, s3: close - c / 4, s4: close - c / 2
    };
    return {
      period: p.key, high: high, low: low, close: close,
      classic: classic, camarilla: camarilla
    };
  }

  global.Indicators = {
    sma: sma, ema: ema, stdev: stdev, rsi: rsi, macd: macd,
    bollinger: bollinger, stochastic: stochastic, atr: atr, adx: adx,
    dmi: dmi, adxr: adxr, supertrend: supertrend, psar: psar, aroon: aroon,
    vortex: vortex, cci: cci, stochRsi: stochRsi, choppiness: choppiness,
    keltner: keltner, ichimoku: ichimoku, linreg: linreg,
    pivotPoints: pivotPoints, periodKey: periodKey,
    computeAll: computeAll, last: last
  };
})(window);
