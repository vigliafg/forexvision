/* =========================================================================
 * smc.js - Smart Money Concepts
 * -------------------------------------------------------------------------
 * Implementazione dei concetti SMC applicati a una serie di candele:
 *
 *  1. Swing point          - massimi/minimi frattali (lookback configurabile),
 *                            ciascuno con l'indice di conferma (causalita').
 *  2. Struttura di mercato - eventi BOS (Break of Structure, continuazione) e
 *                            CHoCH (Change of Character, inversione) generati
 *                            dalla rottura in chiusura di uno swing confermato.
 *  3. Order Block (OB)     - ultima candela di colore opposto prima dell'impulso
 *                            che rompe la struttura; zona fra minimo e massimo
 *                            di quella candela, con stato fresh/tested/consumato.
 *  4. Fair Value Gap (FVG)- squilibrio su tre candele (candela 1 e candela 3 che
 *                            non si sovrappongono), filtrato per dimensione su ATR.
 *  5. Liquidita'           - massimi/minimi uguali (EQH/EQL) come pool di ordini
 *                            e relativi "sweep" (caccia allo stop) quando il
 *                            prezzo supera il livello ma chiude al di sotto.
 *  6. Premium/Discount     - range di riferimento (ultimo impulso), equilibrio al
 *                            50%, zona di sconto, premio e OTE (61,8%-79%).
 *  7. Punteggio e scenario - combinazione pesata di struttura, posizione nel
 *                            range, OB/FVG freschi, sweep e CHoCH recenti, con
 *                            piano operativo (ingresso, stop, target su liquidita').
 *
 * Tutto il calcolo e' causale: ogni evento usa solo informazioni disponibili
 * alla barra in cui viene rilevato (nessun look-ahead bias). Il test
 * tests/selfcheck.html verifica questa proprieta' oltre alle invarianti
 * geometriche di ogni struttura.
 * ========================================================================= */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function isNum(v) { return v != null && isFinite(v); }

  /* ------------------------------------------------------------------ */
  /* 1. Swing point                                                      */
  /* ------------------------------------------------------------------ */
  function findSwings(candles, lookback) {
    lookback = lookback || 3;
    const out = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles[j].high >= candles[i].high) isHigh = false;
        if (candles[j].low <= candles[i].low) isLow = false;
      }
      if (isHigh) {
        out.push({ index: i, price: candles[i].high, kind: 'high', confirmedAt: i + lookback });
      } else if (isLow) {
        out.push({ index: i, price: candles[i].low, kind: 'low', confirmedAt: i + lookback });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 2. Struttura di mercato: BOS e CHoCH                                */
  /* ------------------------------------------------------------------ */
  function marketStructure(candles, swings) {
    const events = [];
    const confirmed = [];
    let si = 0;
    let refHigh = null, refLow = null;
    let bias = 0;                 // 1 rialzista, -1 ribassista, 0 non definito
    let consecutive = 0;          // BOS consecutivi nella stessa direzione
    let lastOrigin = null;        // swing che ha originato l'ultimo impulso
    let brokenHighs = 0, brokenLows = 0;

    for (let i = 0; i < candles.length; i++) {
      // rendo disponibili gli swing la cui conferma e' avvenuta entro questa barra
      while (si < swings.length && swings[si].confirmedAt <= i) {
        const s = swings[si];
        confirmed.push(s);
        if (s.kind === 'high' && (refHigh === null || s.index > refHigh.index)) refHigh = s;
        if (s.kind === 'low' && (refLow === null || s.index > refLow.index)) refLow = s;
        si++;
      }

      const c = candles[i];

      if (refHigh && c.close > refHigh.price) {
        const type = bias === -1 ? 'CHoCH' : 'BOS';
        events.push({
          index: i,
          type: type,
          dir: 1,
          level: refHigh.price,
          swingIndex: refHigh.index,
          swingConfirmedAt: refHigh.confirmedAt,
          originIndex: refLow ? refLow.index : null,
          originPrice: refLow ? refLow.price : null
        });
        consecutive = (bias === 1 && type === 'BOS') ? consecutive + 1 : 1;
        bias = 1;
        lastOrigin = refLow;
        brokenHighs++;
        refHigh = null;
      } else if (refLow && c.close < refLow.price) {
        const type = bias === 1 ? 'CHoCH' : 'BOS';
        events.push({
          index: i,
          type: type,
          dir: -1,
          level: refLow.price,
          swingIndex: refLow.index,
          swingConfirmedAt: refLow.confirmedAt,
          originIndex: refHigh ? refHigh.index : null,
          originPrice: refHigh ? refHigh.price : null
        });
        consecutive = (bias === -1 && type === 'BOS') ? consecutive + 1 : 1;
        bias = -1;
        lastOrigin = refHigh;
        brokenLows++;
        refLow = null;
      }
    }

    return {
      events: events,
      bias: bias,
      consecutive: consecutive,
      swings: confirmed,
      refHigh: refHigh,
      refLow: refLow,
      lastOrigin: lastOrigin,
      brokenHighs: brokenHighs,
      brokenLows: brokenLows,
      lastEvent: events.length ? events[events.length - 1] : null
    };
  }

  /* ------------------------------------------------------------------ */
  /* Stato di una zona (OB o FVG): fresh / tested / invalidated          */
  /* ------------------------------------------------------------------ */
  function updateZoneStatus(zones, candles) {
    zones.forEach(function (z) {
      let status = 'fresh', testedAt = null, invalidatedAt = null, filled = false, penetration = 0;
      for (let k = z.formedAt + 1; k < candles.length; k++) {
        const c = candles[k];
        if (z.kind === 'bullish') {
          if (c.low <= z.top) {
            if (testedAt === null) { testedAt = k; status = 'tested'; }
            filled = filled || c.low <= z.bottom;
            penetration = Math.max(penetration, clamp((z.top - c.low) / (z.top - z.bottom), 0, 1));
          }
          if (c.close < z.bottom) { invalidatedAt = k; status = 'invalidated'; break; }
        } else {
          if (c.high >= z.bottom) {
            if (testedAt === null) { testedAt = k; status = 'tested'; }
            filled = filled || c.high >= z.top;
            penetration = Math.max(penetration, clamp((c.high - z.bottom) / (z.top - z.bottom), 0, 1));
          }
          if (c.close > z.top) { invalidatedAt = k; status = 'invalidated'; break; }
        }
      }
      z.status = status;
      z.testedAt = testedAt;
      z.invalidatedAt = invalidatedAt;
      z.filled = filled;
      z.penetration = penetration;
      z.age = candles.length - 1 - z.formedAt;
    });
    return zones;
  }

  /* ------------------------------------------------------------------ */
  /* 3. Order Block                                                      */
  /* ------------------------------------------------------------------ */
  function orderBlocks(candles, events, atrSeries) {
    const zones = [];
    events.forEach(function (ev) {
      const from = ev.originIndex == null ? Math.max(0, ev.index - 40) : ev.originIndex;
      let idx = null;
      for (let j = ev.index; j > from; j--) {
        const c = candles[j];
        const opposite = ev.dir === 1 ? c.close < c.open : c.close > c.open;
        if (opposite) { idx = j; break; }
      }
      if (idx === null) return;
      const c = candles[idx];
      const atr = isNum(atrSeries[ev.index]) ? atrSeries[ev.index] : Math.abs(c.close) * 0.002;
      zones.push({
        kind: ev.dir === 1 ? 'bullish' : 'bearish',
        formedAt: idx,
        eventIndex: ev.index,
        eventType: ev.type,
        top: c.high,
        bottom: c.low,
        bodyTop: Math.max(c.open, c.close),
        bodyBottom: Math.min(c.open, c.close),
        mid: (c.high + c.low) / 2,
        size: c.high - c.low,
        sizeAtr: (c.high - c.low) / atr,
        time: c.time
      });
    });
    return updateZoneStatus(zones, candles);
  }

  /* ------------------------------------------------------------------ */
  /* 4. Fair Value Gap (squilibrio su tre candele)                       */
  /* ------------------------------------------------------------------ */
  function fairValueGaps(candles, atrSeries, minAtr) {
    minAtr = minAtr || 0.15;
    const zones = [];
    for (let i = 2; i < candles.length; i++) {
      const a = candles[i - 2], c = candles[i];
      const atr = isNum(atrSeries[i]) ? atrSeries[i] : Math.abs(c.close) * 0.002;
      const minSize = atr * minAtr;
      if (c.low - a.high > minSize) {
        zones.push({
          kind: 'bullish', formedAt: i, top: c.low, bottom: a.high,
          size: c.low - a.high, sizeAtr: (c.low - a.high) / atr, time: c.time
        });
      } else if (a.low - c.high > minSize) {
        zones.push({
          kind: 'bearish', formedAt: i, top: a.low, bottom: c.high,
          size: a.low - c.high, sizeAtr: (a.low - c.high) / atr, time: c.time
        });
      }
    }
    return updateZoneStatus(zones, candles);
  }

  /* ------------------------------------------------------------------ */
  /* 5. Liquidita': massimi/minimi uguali e sweep                        */
  /* ------------------------------------------------------------------ */
  function liquidityLevels(candles, swings, atrSeries) {
    const last = candles.length - 1;
    const atr = isNum(atrSeries[last]) ? atrSeries[last] : Math.abs(candles[last].close) * 0.002;
    const tolerance = atr * 0.15;
    const levels = [];

    ['high', 'low'].forEach(function (kind) {
      const pool = swings.filter(function (s) { return s.kind === kind; });
      const used = new Array(pool.length).fill(false);
      for (let i = 0; i < pool.length; i++) {
        if (used[i]) continue;
        const members = [pool[i]];
        for (let j = i + 1; j < pool.length; j++) {
          if (used[j]) continue;
          if (Math.abs(pool[j].price - pool[i].price) <= tolerance) { members.push(pool[j]); used[j] = true; }
        }
        used[i] = true;
        if (members.length < 2) continue;
        const price = kind === 'high'
          ? Math.max.apply(null, members.map(function (m) { return m.price; }))
          : Math.min.apply(null, members.map(function (m) { return m.price; }));
        const confirmedAt = Math.max.apply(null, members.map(function (m) { return m.confirmedAt; }));
        const level = {
          kind: kind === 'high' ? 'buy-side' : 'sell-side',
          price: price,
          members: members.length,
          firstIndex: members[0].index,
          lastIndex: members[members.length - 1].index,
          confirmedAt: confirmedAt,
          taken: false,
          sweptAt: null,
          distanceAtr: (price - candles[last].close) / atr
        };
        // sweep: superamento del livello con chiusura di ritorno
        for (let k = Math.max(0, confirmedAt); k <= last; k++) {
          const c = candles[k];
          if (level.kind === 'buy-side') {
            if (c.high > price + tolerance * 0.4) {
              if (c.close < price) { level.sweptAt = k; break; }
              level.taken = true;
            }
          } else {
            if (c.low < price - tolerance * 0.4) {
              if (c.close > price) { level.sweptAt = k; break; }
              level.taken = true;
            }
          }
        }
        levels.push(level);
      }
    });

    levels.sort(function (a, b) { return a.price - b.price; });
    return levels;
  }

  /* ------------------------------------------------------------------ */
  /* 6. Premium / Discount / OTE                                         */
  /* ------------------------------------------------------------------ */
  function dealingRange(candles, ms) {
    const last = candles.length - 1;
    // Il range di riferimento parte dall'origine dell'ultimo impulso; se non
    // disponibile si usa una finestra mobile di 60 barre.
    let start = ms.lastOrigin ? ms.lastOrigin.index : Math.max(0, last - 60);
    if (last - start < 20) start = Math.max(0, last - 60);

    let high = -Infinity, low = Infinity, highIndex = start, lowIndex = start;
    for (let i = start; i <= last; i++) {
      if (candles[i].high > high) { high = candles[i].high; highIndex = i; }
      if (candles[i].low < low) { low = candles[i].low; lowIndex = i; }
    }
    const span = high - low;
    const equilibrium = (high + low) / 2;
    const close = candles[last].close;
    // direzione del range: dalla sua origine verso l'estremo piu' recente
    const legUp = highIndex > lowIndex;
    const position = span === 0 ? 0.5 : (close - low) / span;

    // OTE: ritracciamento fra 61,8% e 79% del leg in corso
    const ote = legUp
      ? { top: high - span * 0.618, bottom: high - span * 0.79 }
      : { top: low + span * 0.79, bottom: low + span * 0.618 };

    return {
      start: start,
      high: high,
      low: low,
      highIndex: highIndex,
      lowIndex: lowIndex,
      span: span,
      equilibrium: equilibrium,
      position: position,
      legUp: legUp,
      inDiscount: close < equilibrium,
      inPremium: close > equilibrium,
      premium: { top: high, bottom: equilibrium },
      discount: { top: equilibrium, bottom: low },
      ote: ote,
      inOte: close <= ote.top && close >= ote.bottom
    };
  }

  /* ------------------------------------------------------------------ */
  /* 7. Punteggio, scenario e narrazione                                 */
  /* ------------------------------------------------------------------ */
  function distanceToZone(price, zone) {
    if (zone.bottom <= price && price <= zone.top) return 0;
    return price > zone.top ? price - zone.top : zone.bottom - price;
  }

  /**
   * Zona piu' vicina al prezzo fra quelle valide.
   * @param {string} side 'below' = la zona deve stare sotto il prezzo (zona di
   *                      domanda per un acquisto), 'above' = sopra (offerta per
   *                      una vendita), null = indifferente.
   * Una zona che contiene gia' il prezzo e' sempre ammessa (distanza 0).
   */
  function nearestZone(zones, kind, price, atr, maxAtr, side) {
    let best = null, bestDist = Infinity;
    zones.forEach(function (z) {
      if (z.kind !== kind || z.status === 'invalidated') return;
      if (side === 'below' && z.bottom > price) return;   // zona interamente sopra il prezzo
      if (side === 'above' && z.top < price) return;      // zona interamente sotto il prezzo
      const d = distanceToZone(price, z) / atr;
      if (d < bestDist && d <= (maxAtr || 6)) { bestDist = d; best = z; }
    });
    return best ? { zone: best, distAtr: bestDist } : null;
  }

  function analyze(candles, ind, instrument, opts) {
    opts = opts || {};
    const lookback = opts.lookback || 3;
    const last = candles.length - 1;
    const price = candles[last].close;
    const atr = isNum(ind.atr[last]) ? ind.atr[last] : Math.abs(price) * 0.002;

    const swings = findSwings(candles, lookback);
    const ms = marketStructure(candles, swings);
    const obs = orderBlocks(candles, ms.events, ind.atr);
    const fvgs = fairValueGaps(candles, ind.atr, 0.15);
    const liquidity = liquidityLevels(candles, swings, ind.atr);
    const range = dealingRange(candles, ms);

    const bias = ms.bias === 0 ? (range.legUp ? 1 : -1) : ms.bias;
    const dirKind = bias === 1 ? 'bullish' : 'bearish';

    /* --- componenti del punteggio --- */
    const components = [];

    // struttura
    const structScore = bias * Math.min(1, 0.5 + 0.18 * ms.consecutive);
    const lastEv = ms.lastEvent;
    components.push({
      key: 'structure', label: 'Struttura di mercato', score: structScore, weight: 0.28,
      detail: lastEv
        ? (lastEv.type === 'BOS' ? 'BOS ' : 'CHoCH ') + (lastEv.dir === 1 ? 'rialzista' : 'ribassista') +
          ' ' + (last - lastEv.index) + ' barre fa su ' + lastEv.level.toFixed(instrument.digits)
        : 'nessun evento di struttura rilevato',
      bull: 'La struttura conferma il rialzo', bear: 'La struttura conferma il ribasso'
    });

    // posizione nel range: comprare in sconto, vendere in premio
    const posScore = range.span === 0 ? 0 : (bias === 1 ? (0.5 - range.position) * 2 : (range.position - 0.5) * 2);
    components.push({
      key: 'range', label: 'Premium / Discount', score: clamp(posScore, -1, 1), weight: 0.18,
      detail: (range.position * 100).toFixed(0) + '% del range ' + range.low.toFixed(instrument.digits) +
        ' - ' + range.high.toFixed(instrument.digits) +
        (range.inDiscount ? ' (sconto)' : ' (premio)') + (range.inOte ? ', dentro l\u2019OTE' : ''),
      bull: 'Prezzo in sconto: area di acquisto istituzionale', bear: 'Prezzo in premio: area di vendita istituzionale'
    });

    // order block fresco in direzione, sul lato corretto rispetto al prezzo
    // (una zona di domanda deve stare sotto il prezzo, una di offerta sopra)
    const side = bias === 1 ? 'below' : 'above';
    const obNear = nearestZone(obs, dirKind, price, atr, 6, side);
    let obScore = 0;
    if (obNear) {
      const z = obNear.zone;
      obScore = z.status === 'fresh' ? 1 : 0.6;
      obScore *= (1 - Math.min(1, obNear.distAtr / 6));
      obScore += 0.15;
      obScore = clamp(obScore, 0, 1);
    }
    components.push({
      key: 'ob', label: 'Order Block', score: obScore, weight: 0.18,
      detail: obNear
        ? 'OB ' + (dirKind === 'bullish' ? 'rialzista' : 'ribassista') + ' ' + obNear.zone.bottom.toFixed(instrument.digits) +
          ' - ' + obNear.zone.top.toFixed(instrument.digits) + ' (' + obNear.zone.status +
          ', a ' + obNear.distAtr.toFixed(1) + ' ATR)'
        : 'nessun order block utile in direzione',
      bull: 'Order block rialzista non mitigato sotto il prezzo', bear: 'Order block ribassista non mitigato sopra il prezzo'
    });

    // fair value gap fresco in direzione
    const fvgNear = nearestZone(fvgs, dirKind, price, atr, 6, side);
    let fvgScore = 0;
    if (fvgNear) {
      fvgScore = (fvgNear.zone.status === 'fresh' ? 1 : 0.55) * (1 - Math.min(1, fvgNear.distAtr / 6)) + 0.1;
      fvgScore = clamp(fvgScore, 0, 1);
    }
    components.push({
      key: 'fvg', label: 'Fair Value Gap', score: fvgScore, weight: 0.12,
      detail: fvgNear
        ? 'FVG ' + fvgNear.zone.bottom.toFixed(instrument.digits) + ' - ' + fvgNear.zone.top.toFixed(instrument.digits) +
          ' (' + (fvgNear.zone.filled ? 'parzialmente riempito' : 'aperto') + ')'
        : 'nessuno squilibrio aperto in direzione',
      bull: 'Squilibrio rialzista ancora da colmare', bear: 'Squilibrio ribassista ancora da colmare'
    });

    // sweep recente di liquidita'
    const recentSweeps = liquidity.filter(function (l) {
      return l.sweptAt != null && last - l.sweptAt <= 20;
    });
    let sweepScore = 0, sweepDetail = 'nessuno sweep recente di liquidita\u0300';
    if (recentSweeps.length) {
      // uno sweep dei minimi e' rialzista (stop hunt prima della risalita)
      const best = recentSweeps[recentSweeps.length - 1];
      sweepScore = (best.kind === 'sell-side' ? 1 : -1) * (1 - (last - best.sweptAt) / 25);
      sweepDetail = 'sweep di ' + (best.kind === 'sell-side' ? 'minimi (sell-side)' : 'massimi (buy-side)') +
        ' a ' + best.price.toFixed(instrument.digits) + ' ' + (last - best.sweptAt) + ' barre fa';
    }
    components.push({
      key: 'sweep', label: 'Caccia alla liquidita\u0300', score: clamp(sweepScore, -1, 1), weight: 0.14,
      detail: sweepDetail,
      bull: 'Stop hunt sui minimi seguito da recupero', bear: 'Stop hunt sui massimi seguito da rifiuto'
    });

    // CHoCH recente
    let chochScore = 0, chochDetail = 'nessun cambio di carattere recente';
    for (let i = ms.events.length - 1; i >= 0; i--) {
      const ev = ms.events[i];
      if (ev.type === 'CHoCH' && last - ev.index <= 25) {
        chochScore = ev.dir * (1 - (last - ev.index) / 30);
        chochDetail = 'CHoCH ' + (ev.dir === 1 ? 'rialzista' : 'ribassista') + ' ' + (last - ev.index) + ' barre fa';
        break;
      }
    }
    components.push({
      key: 'choch', label: 'Cambio di carattere', score: clamp(chochScore, -1, 1), weight: 0.10,
      detail: chochDetail,
      bull: 'Inversione di struttura a favore del rialzo', bear: 'Inversione di struttura a favore del ribasso'
    });

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

    const direction = bias;                       // direzione strutturale
    const dirSign = bias === 1 ? 1 : -1;
    const signal = score > 0.08 ? 'BUY' : score < -0.08 ? 'SELL' : 'NEUTRAL';

    // chiarezza della struttura per la confidenza
    const clarity = clamp((ms.consecutive * 0.25) + (lastEv ? Math.max(0, 1 - (last - lastEv.index) / 60) : 0), 0, 1);
    const confidence = clamp(0.5 * Math.abs(score) + 0.3 * agreement + 0.2 * clarity, 0.04, 0.95);

    /* --- piano operativo SMC --- */
    const entryZone = obNear ? obNear.zone : (fvgNear ? fvgNear.zone : null);
    const inZone = entryZone && price >= entryZone.bottom && price <= entryZone.top;
    const limitEntry = entryZone
      ? (bias === 1 ? entryZone.top : entryZone.bottom)
      : (bias === 1 ? Math.min(range.equilibrium, price) : Math.max(range.equilibrium, price));
    const marketEntry = price;

    // stop: oltre l'origine dello scenario (estremo della zona o swing protetto)
    let stopRef = bias === 1 ? (entryZone ? entryZone.bottom : range.ote.bottom) : (entryZone ? entryZone.top : range.ote.top);
    if (bias === 1 && ms.refLow && ms.refLow.price < stopRef) stopRef = ms.refLow.price;
    if (bias === -1 && ms.refHigh && ms.refHigh.price > stopRef) stopRef = ms.refHigh.price;
    const stop = stopRef - dirSign * atr * 0.15;

    // target: prima la liquidita' non ancora presa, poi l'estremo del range
    const targets = liquidity.filter(function (l) {
      return !l.taken && l.sweptAt == null &&
        (bias === 1 ? l.kind === 'buy-side' && l.price > price : l.kind === 'sell-side' && l.price < price);
    }).sort(function (a, b) {
      return bias === 1 ? a.price - b.price : b.price - a.price;
    });
    // TP1: ritorno all'equilibrio del range, ma sempre oltre il prezzo corrente
    const tp1 = bias === 1
      ? Math.max(range.equilibrium, price + atr * 0.5)
      : Math.min(range.equilibrium, price - atr * 0.5);
    const tp2 = targets.length ? targets[0].price : (bias === 1 ? range.high : range.low);
    const riskFrom = inZone ? price : limitEntry;
    const rr = Math.abs(stop - riskFrom) < 1e-12 ? 0 : Math.abs(tp2 - riskFrom) / Math.abs(stop - riskFrom);

    /* --- narrazione --- */
    const reasons = [];
    reasons.push({
      tone: score > 0.08 ? 'bull' : score < -0.08 ? 'bear' : 'flat',
      text: (ms.bias === 0 ? 'Struttura non ancora definita' :
        'Struttura ' + (bias === 1 ? 'rialzista' : 'ribassista')) +
        (lastEv ? ': ultimo ' + lastEv.type + ' ' + (lastEv.dir === 1 ? 'rialzista' : 'ribassista') + ' su ' +
          lastEv.level.toFixed(instrument.digits) + ' (' + (last - lastEv.index) + ' barre fa), ' +
          ms.consecutive + ' rotture consecutive nella stessa direzione.' : '.')
    });
    reasons.push({
      tone: bias === 1 ? 'bull' : 'bear',
      text: 'Prezzo al ' + (range.position * 100).toFixed(0) + '% del range di riferimento ' +
        range.low.toFixed(instrument.digits) + ' - ' + range.high.toFixed(instrument.digits) +
        ': ' + (range.inDiscount ? 'zona di sconto, favorevole agli acquisti' : 'zona di premio, favorevole alle vendite') +
        ' (equilibrio ' + range.equilibrium.toFixed(instrument.digits) + ').'
    });
    components.forEach(function (c) {
      if (Math.abs(c.score) < 0.2) return;
      reasons.push({
        tone: c.score > 0 ? 'bull' : 'bear',
        text: c.label + ': ' + (c.score > 0 ? c.bull : c.bear) + ' \u2014 ' + c.detail + '.'
      });
    });
    if (targets.length) {
      reasons.push({
        tone: 'flat',
        text: 'Liquidita\u0300 in attesa ' + (bias === 1 ? 'sopra' : 'sotto') + ' a ' +
          targets[0].price.toFixed(instrument.digits) + ' (' + targets[0].members + ' ' +
          (targets[0].kind === 'buy-side' ? 'massimi' : 'minimi') + ' uguali): obiettivo naturale del movimento.'
      });
    }
    reasons.push({
      tone: 'flat',
      text: 'Scenario invalidato ' + (bias === 1 ? 'sotto' : 'sopra') + ' ' + stop.toFixed(instrument.digits) +
        ' (chiusura oltre il livello annulla la tesi SMC).'
    });

    return {
      swings: swings,
      structure: ms,
      orderBlocks: obs,
      fvgs: fvgs,
      liquidity: liquidity,
      range: range,
      components: components,
      score: score,
      agreement: agreement,
      signal: signal,
      direction: direction,
      biasLabel: bias === 1 ? 'Rialzista' : 'Ribassista',
      confidence: confidence,
      atr: atr,
      price: price,
      lastIndex: last,
      plan: {
        direction: direction,
        inZone: inZone,
        marketEntry: marketEntry,
        limitEntry: limitEntry,
        entryZone: entryZone,
        stop: stop,
        tp1: tp1,
        tp2: tp2,
        rr: rr,
        targetLiquidity: targets.length ? targets[0] : null
      },
      reasons: reasons
    };
  }

  global.SMC = {
    analyze: analyze,
    findSwings: findSwings,
    marketStructure: marketStructure,
    orderBlocks: orderBlocks,
    fairValueGaps: fairValueGaps,
    liquidityLevels: liquidityLevels,
    dealingRange: dealingRange,
    updateZoneStatus: updateZoneStatus
  };
})(window);
