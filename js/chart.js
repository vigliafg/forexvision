/* =========================================================================
 * chart.js - Renderer del grafico a candele su canvas (nessuna dipendenza)
 * Disegna: candele OHLC, medie mobili, bande di Bollinger, volumi,
 * fan di previsione probabilistica, crosshair con tooltip e assi.
 * ========================================================================= */
(function (global) {
  'use strict';

  const COLORS = {
    bg: '#0d1420',
    grid: 'rgba(34,48,74,.55)',
    gridStrong: 'rgba(34,48,74,.95)',
    text: '#8fa3bf',
    up: '#18c98a',
    down: '#f2555a',
    upFill: 'rgba(24,201,138,.85)',
    downFill: 'rgba(242,85,90,.85)',
    ema9: '#ffcc55',
    ema21: '#63b3ff',
    ema50: '#c77dff',
    bb: 'rgba(120,150,200,.55)',
    bbFill: 'rgba(80,110,170,.10)',
    fc: '#3d8bfd',
    fcFill: 'rgba(61,139,253,.16)',
    fcEdge: 'rgba(61,139,253,.55)',
    cross: 'rgba(200,220,255,.55)',
    vol: 'rgba(90,120,170,.55)',
    // --- SMC ---
    obBull: 'rgba(24,201,138,.13)',
    obBullEdge: 'rgba(24,201,138,.6)',
    obBear: 'rgba(242,85,90,.13)',
    obBearEdge: 'rgba(242,85,90,.6)',
    fvgBull: 'rgba(61,139,253,.12)',
    fvgBullEdge: 'rgba(61,139,253,.45)',
    fvgBear: 'rgba(199,125,255,.12)',
    fvgBearEdge: 'rgba(199,125,255,.45)',
    bos: '#18c98a',
    bosDown: '#f2555a',
    choch: '#f0b429',
    liq: '#c77dff',
    sweep: '#ffcc55',
    smcPlan: '#ffcc55',
    pdDiscount: 'rgba(24,201,138,.055)',
    pdPremium: 'rgba(242,85,90,.055)',
    pdEquilibrium: 'rgba(200,220,255,.35)',
    pdOte: 'rgba(255,204,85,.06)',
    // --- indicatori di trend e inversione ---
    stUp: '#18c98a',
    stDown: '#f2555a',
    psar: '#ffcc55',
    ichiCloudUp: 'rgba(24,201,138,.13)',
    ichiCloudDown: 'rgba(242,85,90,.13)',
    ichiLine: 'rgba(120,150,200,.8)',
    ichiBase: '#c77dff',
    // --- divergenze e pivot point ---
    pivotRes: 'rgba(242,85,90,.55)',
    pivotSup: 'rgba(24,201,138,.55)',
    pivotMid: 'rgba(200,220,255,.55)'
  };

  function ForexChart(canvas, tooltipEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltipEl;
    this.series = null;
    this.analysis = null;
    this.smc = null;
    this.layers = { ma: true, bb: false, forecast: false, volume: true, smc: true, pd: false, st: false, psar: false, ichimoku: false, div: false, pivot: false };
    this.visibleCount = 150;
    this.hover = null;
    this.instrument = null;
    this._bind();
  }

  ForexChart.prototype._bind = function () {
    const self = this;
    this.canvas.addEventListener('mousemove', function (e) {
      const rect = self.canvas.getBoundingClientRect();
      self.hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      self.draw();
      self._updateTooltip();
    });
    this.canvas.addEventListener('mouseleave', function () {
      self.hover = null;
      self.draw();
      if (self.tooltip) self.tooltip.classList.add('hidden');
      if (self.onLeave) self.onLeave();
    });
    this.canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      const step = e.deltaY > 0 ? 12 : -12;
      self.visibleCount = Math.max(40, Math.min(400, self.visibleCount + step));
      self.draw();
    }, { passive: false });
  };

  ForexChart.prototype.setData = function (series, analysis, instrument, smc) {
    this.series = series;
    this.analysis = analysis;
    this.instrument = instrument;
    this.smc = smc || null;
    this.draw();
  };

  /** Divergenze e pivot point: dati extra che non dipendono dallo studio SMC. */
  ForexChart.prototype.setExtras = function (divergence, pivots) {
    this.divergence = divergence || null;
    this.pivots = pivots || null;
    this.draw();
  };

  ForexChart.prototype.setLayer = function (name, on) {
    this.layers[name] = !!on;
    this.draw();
  };

  /* ---------------- geometria ---------------- */
  ForexChart.prototype._layout = function () {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 800;
    const cssH = this.canvas.clientHeight || 420;
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const axisW = 66, timeH = 20;
    const padTop = 12, padLeft = 8;
    const volH = this.layers.volume ? 54 : 0;
    const forecastW = this.layers.forecast && this.analysis
      ? Math.min(250, Math.max(120, cssW * 0.26)) : 0;

    return {
      cssW: cssW, cssH: cssH,
      axisW: axisW, timeH: timeH,
      left: padLeft,
      right: cssW - axisW - forecastW,
      fcLeft: cssW - axisW - forecastW,
      fcRight: cssW - axisW,
      top: padTop,
      priceBottom: cssH - timeH - (volH ? volH + 8 : 0),
      volTop: cssH - timeH - volH,
      volBottom: cssH - timeH - 2,
      hasForecast: forecastW > 0
    };
  };

  /* ---------------- draw ---------------- */
  ForexChart.prototype.draw = function () {
    if (!this.series || !this.series.candles.length) return;
    const ctx = this.ctx;
    const L = this._layout();
    const candles = this.series.candles;
    const inst = this.instrument;
    const digits = inst ? inst.digits : 5;

    ctx.clearRect(0, 0, L.cssW, L.cssH);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, L.cssW, L.cssH);
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';

    // --- finestra visibile ---
    const count = Math.min(this.visibleCount, candles.length);
    const startIdx = candles.length - count;
    const view = candles.slice(startIdx);

    // --- range di prezzo (include la proiezione) ---
    let min = Infinity, max = -Infinity;
    view.forEach(function (c) {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
    });
    const ind = this.analysis ? this.analysis.indicators : null;
    if (this.layers.bb && ind) {
      for (let i = startIdx; i < candles.length; i++) {
        if (ind.bb.upper[i] != null) max = Math.max(max, ind.bb.upper[i]);
        if (ind.bb.lower[i] != null) min = Math.min(min, ind.bb.lower[i]);
      }
    }
    if (this.layers.forecast && this.analysis) {
      this.analysis.projection.forEach(function (p) {
        max = Math.max(max, p.upper);
        min = Math.min(min, p.lower);
      });
    }
    // i livelli di pivot vicini entrano nella scala, quelli lontani restano
    // fuori dal disegno per non schiacciare il grafico
    if (this.layers.pivot && this.pivots) {
      const span = max - min;
      const pc = this.pivots.classic;
      [pc.p, pc.r1, pc.r2, pc.r3, pc.s1, pc.s2, pc.s3].forEach(function (v) {
        if (v >= min - span * 1.2 && v <= max + span * 1.2) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      });
    }

    // gli indicatori sovrapposti devono restare dentro l'area di prezzo
    if (ind && (this.layers.st || this.layers.psar || this.layers.ichimoku)) {
      const sets = [];
      if (this.layers.st && ind.superTrend) sets.push(ind.superTrend.line);
      if (this.layers.psar) sets.push(ind.psar);
      if (this.layers.ichimoku) sets.push(ind.ichimoku.spanA, ind.ichimoku.spanB, ind.ichimoku.tenkan, ind.ichimoku.kijun);
      sets.forEach(function (arr) {
        if (!arr) return;
        for (let i = startIdx; i < candles.length; i++) {
          const v = arr[i];
          if (v == null) continue;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      });
    }
    const pad = (max - min) * 0.06 || max * 0.002;
    min -= pad; max += pad;

    const plotW = L.right - L.left;
    const plotH = L.priceBottom - L.top;
    const xOf = (i) => L.left + ((i - startIdx + 0.5) / count) * plotW;
    const yOf = (p) => L.top + (max - p) / (max - min) * plotH;

    // --- griglia e asse prezzi ---
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.text;
    ctx.lineWidth = 1;
    const steps = 6;
    for (let s = 0; s <= steps; s++) {
      const price = min + (max - min) * s / steps;
      const y = Math.round(yOf(price)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(L.left, y);
      ctx.lineTo(L.right, y);
      ctx.stroke();
      if (L.hasForecast) {
        ctx.beginPath();
        ctx.setLineDash([2, 4]);
        ctx.moveTo(L.right, y);
        ctx.lineTo(L.fcRight, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.text;
      ctx.fillText(price.toFixed(digits), L.fcRight + 6, y);
    }

    // --- separatore area previsione ---
    if (L.hasForecast) {
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.setLineDash([3, 5]);
      ctx.moveTo(L.right, L.top);
      ctx.lineTo(L.right, L.priceBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(61,139,253,.65)';
      ctx.textAlign = 'center';
      ctx.fillText('PREVISIONE', (L.right + L.fcRight) / 2, L.top + 8);
    }

    // --- livelli di riferimento: pivot point del periodo precedente ---
    if (this.layers.pivot && this.pivots) {
      const pc = this.pivots.classic;
      const rows = [
        ['R3', pc.r3, COLORS.pivotRes], ['R2', pc.r2, COLORS.pivotRes], ['R1', pc.r1, COLORS.pivotRes],
        ['P', pc.p, COLORS.pivotMid],
        ['S1', pc.s1, COLORS.pivotSup], ['S2', pc.s2, COLORS.pivotSup], ['S3', pc.s3, COLORS.pivotSup]
      ];
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      rows.forEach(function (r) {
        const y = yOf(r[1]);
        if (y < L.top - 2 || y > L.priceBottom + 2) return;
        ctx.strokeStyle = r[2];
        ctx.lineWidth = r[0] === 'P' ? 1.4 : 1;
        ctx.setLineDash(r[0] === 'P' ? [6, 4] : [2, 5]);
        ctx.beginPath();
        ctx.moveTo(L.left, y);
        ctx.lineTo(L.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = r[2];
        ctx.fillText(r[0] + ' ' + r[1].toFixed(digits), L.right - 4, y - 6);
      });
      ctx.textAlign = 'left';
    }

    // --- premio / sconto (SMC) ---
    if (this.layers.pd && this.smc) this._drawPremiumDiscount(L, yOf, digits);

    // --- volumi ---
    if (this.layers.volume) {
      let vmax = 0;
      view.forEach(function (c) { if (c.volume > vmax) vmax = c.volume; });
      // alcuni fornitori non spediscono il volume (es. le valute): la scala
      // non deve mai dividere per zero
      if (vmax <= 0) vmax = 1;
      const barW = Math.max(1, plotW / count - 1);
      ctx.fillStyle = COLORS.vol;
      view.forEach(function (c, k) {
        const h = (c.volume / vmax) * (L.volBottom - L.volTop);
        const x = xOf(startIdx + k) - barW / 2;
        ctx.fillStyle = c.close >= c.open ? 'rgba(24,201,138,.42)' : 'rgba(242,85,90,.42)';
        ctx.fillRect(x, L.volBottom - h, barW, h);
      });
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.fillText('VOL', L.left + 2, L.volTop + 6);
    }

    // --- zone SMC (order block e fair value gap) ---
    if (this.layers.smc && this.smc) this._drawSmcZones(L, xOf, yOf, startIdx, digits);

    // --- Bollinger ---
    if (this.layers.bb && ind) {
      const pts = [];
      for (let i = startIdx; i < candles.length; i++) {
        if (ind.bb.upper[i] != null) pts.push({ x: xOf(i), u: yOf(ind.bb.upper[i]), l: yOf(ind.bb.lower[i]), m: yOf(ind.bb.middle[i]) });
      }
      if (pts.length > 1) {
        ctx.beginPath();
        pts.forEach(function (p, k) { k ? ctx.lineTo(p.x, p.u) : ctx.moveTo(p.x, p.u); });
        for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k].x, pts[k].l);
        ctx.closePath();
        ctx.fillStyle = COLORS.bbFill;
        ctx.fill();
        ctx.strokeStyle = COLORS.bb;
        ctx.lineWidth = 1;
        ctx.beginPath();
        pts.forEach(function (p, k) { k ? ctx.lineTo(p.x, p.u) : ctx.moveTo(p.x, p.u); });
        ctx.stroke();
        ctx.beginPath();
        pts.forEach(function (p, k) { k ? ctx.lineTo(p.x, p.l) : ctx.moveTo(p.x, p.l); });
        ctx.stroke();
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        pts.forEach(function (p, k) { k ? ctx.lineTo(p.x, p.m) : ctx.moveTo(p.x, p.m); });
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // --- nuvola di Ichimoku (dietro le candele) ---
    if (this.layers.ichimoku && ind && ind.ichimoku) {
      const ic = ind.ichimoku;
      let seg = [], segBull = null;
      const flush = function () {
        if (seg.length > 1) {
          ctx.beginPath();
          seg.forEach(function (p, k) { k ? ctx.lineTo(p.x, p.a) : ctx.moveTo(p.x, p.a); });
          for (let k = seg.length - 1; k >= 0; k--) ctx.lineTo(seg[k].x, seg[k].b);
          ctx.closePath();
          ctx.fillStyle = segBull ? COLORS.ichiCloudUp : COLORS.ichiCloudDown;
          ctx.fill();
        }
        seg = [];
      };
      for (let i = startIdx; i < candles.length; i++) {
        if (ic.spanA[i] == null || ic.spanB[i] == null) { flush(); segBull = null; continue; }
        const bull = ic.spanA[i] >= ic.spanB[i];
        if (segBull !== null && bull !== segBull) flush();
        segBull = bull;
        seg.push({ x: xOf(i), a: yOf(ic.spanA[i]), b: yOf(ic.spanB[i]) });
      }
      flush();
    }

    // --- candele ---
    const bodyW = Math.max(1.5, plotW / count * 0.66);
    const wickW = Math.max(1, bodyW / 6);
    view.forEach(function (c, k) {
      const i = startIdx + k;
      const x = xOf(i);
      const up = c.close >= c.open;
      const col = up ? COLORS.upFill : COLORS.downFill;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      // ombra
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, yOf(c.high));
      ctx.lineTo(Math.round(x) + 0.5, yOf(c.low));
      ctx.lineWidth = wickW;
      ctx.stroke();
      // corpo
      const yO = yOf(c.open), yC = yOf(c.close);
      const top = Math.min(yO, yC);
      let h = Math.abs(yC - yO);
      if (h < 1) h = 1;
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);
    });

    // --- medie mobili ---
    if (this.layers.ma && ind) {
      const sets = [
        { arr: ind.ema9, color: COLORS.ema9 },
        { arr: ind.ema21, color: COLORS.ema21 },
        { arr: ind.ema50, color: COLORS.ema50 }
      ];
      sets.forEach(function (s) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        let started = false;
        for (let i = startIdx; i < candles.length; i++) {
          if (s.arr[i] == null) { started = false; continue; }
          const x = xOf(i), y = yOf(s.arr[i]);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      });
    }

    // --- SuperTrend: linea colorata dal verso della tendenza ---
    if (this.layers.st && ind && ind.superTrend) {
      const stLine = ind.superTrend.line, stDir = ind.superTrend.dir;
      ctx.lineWidth = 1.7;
      for (let i = startIdx + 1; i < candles.length; i++) {
        if (stLine[i] == null || stLine[i - 1] == null) continue;
        ctx.strokeStyle = stDir[i] === 1 ? COLORS.stUp : COLORS.stDown;
        ctx.beginPath();
        ctx.moveTo(xOf(i - 1), yOf(stLine[i - 1]));
        ctx.lineTo(xOf(i), yOf(stLine[i]));
        ctx.stroke();
      }
    }

    // --- Parabolic SAR: punti di inversione ---
    if (this.layers.psar && ind && ind.psar) {
      ctx.fillStyle = COLORS.psar;
      for (let i = startIdx; i < candles.length; i++) {
        if (ind.psar[i] == null) continue;
        ctx.beginPath();
        ctx.arc(xOf(i), yOf(ind.psar[i]), 1.6, 0, 6.2832);
        ctx.fill();
      }
    }

    // --- Ichimoku: linee della nuvola, Tenkan/Kijun ---
    if (this.layers.ichimoku && ind && ind.ichimoku) {
      const ic = ind.ichimoku;
      [
        [ic.spanA, COLORS.ichiLine, 1], [ic.spanB, COLORS.ichiLine, 1],
        [ic.tenkan, COLORS.ema9, 1.2], [ic.kijun, COLORS.ichiBase, 1.2]
      ].forEach(function (set) {
        ctx.strokeStyle = set[1];
        ctx.lineWidth = set[2];
        ctx.beginPath();
        let started = false;
        for (let i = startIdx; i < candles.length; i++) {
          const v = set[0][i];
          if (v == null) { started = false; continue; }
          const x = xOf(i), y = yOf(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      });
    }

    // --- divergenze: i due swing collegati e la freccia sul piu' recente ---
    if (this.layers.div && this.divergence && this.divergence.items) {
      ctx.font = '9px "JetBrains Mono", monospace';
      this.divergence.items.forEach(function (it) {
        if (it.to.index < startIdx || it.from.index >= candles.length) return;
        const x1 = xOf(Math.max(it.from.index, startIdx)), x2 = xOf(it.to.index);
        const y1 = yOf(it.from.price), y2 = yOf(it.to.price);
        if (y1 < L.top - 30 || y1 > L.priceBottom + 30 || y2 < L.top - 30 || y2 > L.priceBottom + 30) return;
        const col = it.dir > 0 ? COLORS.stUp : COLORS.stDown;
        const verso = it.dir > 0 ? 1 : -1;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(x2, y2 + verso * 10);
        ctx.lineTo(x2 - 4, y2 + verso * 19);
        ctx.lineTo(x2 + 4, y2 + verso * 19);
        ctx.closePath();
        ctx.fill();
        ctx.textAlign = 'center';
        ctx.fillText('DIV ' + it.osc + (it.kind === 'hidden' ? ' nasc.' : ''), x2, y2 + verso * 27);
        ctx.textAlign = 'left';
      });
    }

    // --- fan di previsione ---
    if (this.layers.forecast && this.analysis) {
      const a = this.analysis;
      const fcW = L.fcRight - L.right;
      const n = a.projection.length;
      const xAt = (k) => L.right + (k / n) * fcW;
      const lastX = xOf(candles.length - 1);
      const lastY = yOf(a.price);

      // banda di confidenza
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      a.projection.forEach(function (p) { ctx.lineTo(xAt(p.step), yOf(p.upper)); });
      for (let k = n - 1; k >= 0; k--) ctx.lineTo(xAt(a.projection[k].step), yOf(a.projection[k].lower));
      ctx.closePath();
      ctx.fillStyle = COLORS.fcFill;
      ctx.fill();

      // bordi 1 sigma
      ctx.strokeStyle = COLORS.fcEdge;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      [ 'upper', 'lower' ].forEach(function (key) {
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        a.projection.forEach(function (p) { ctx.lineTo(xAt(p.step), yOf(p[key])); });
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // traiettoria centrale
      const traj = { BUY: COLORS.up, SELL: COLORS.down, NEUTRAL: COLORS.fc }[a.direction];
      ctx.strokeStyle = traj;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      a.projection.forEach(function (p) { ctx.lineTo(xAt(p.step), yOf(p.mid)); });
      ctx.stroke();

      // bersaglio e stop
      const endX = xAt(n);
      [[a.target, COLORS.up, 'TP'], [a.stop, COLORS.down, 'SL']].forEach(function (pair) {
        const y = yOf(pair[0]);
        ctx.strokeStyle = pair[1];
        ctx.lineWidth = 1.2;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.moveTo(lastX, y);
        ctx.lineTo(endX, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = pair[1];
        ctx.textAlign = 'left';
        ctx.fillText(pair[2] + ' ' + pair[0].toFixed(digits), L.right + 4, y - 7);
      });

      // marker finale
      ctx.fillStyle = traj;
      ctx.beginPath();
      ctx.arc(endX - 3, yOf(a.projection[n - 1].mid), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- struttura, liquidita' e piano SMC ---
    if (this.layers.smc && this.smc) this._drawSmcStructure(L, xOf, yOf, startIdx, digits);

    // --- ultimo prezzo ---
    const last = candles[candles.length - 1];
    const lastY = yOf(last.close);
    ctx.strokeStyle = last.close >= last.open ? COLORS.up : COLORS.down;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(L.left, lastY);
    ctx.lineTo(L.fcRight, lastY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = last.close >= last.open ? COLORS.up : COLORS.down;
    ctx.fillRect(L.fcRight, lastY - 8, L.axisW, 16);
    ctx.fillStyle = '#08121f';
    ctx.textAlign = 'left';
    ctx.font = 'bold 10px "JetBrains Mono", Consolas, monospace';
    ctx.fillText(last.close.toFixed(digits), L.fcRight + 5, lastY);
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';

    // --- asse tempo ---
    ctx.strokeStyle = COLORS.gridStrong;
    ctx.beginPath();
    ctx.moveTo(L.left, L.priceBottom + 0.5);
    ctx.lineTo(L.fcRight, L.priceBottom + 0.5);
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    const labelEvery = Math.max(1, Math.floor(count / 7));
    const tfMinutes = global.ForexData.TIMEFRAMES[this.series.timeframe].minutes;
    for (let k = 0; k < count; k += labelEvery) {
      const c = view[k];
      const d = new Date(c.time);
      const lbl = tfMinutes >= 1440
        ? d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })
        : d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      // le etichette non devono uscire dai bordi dell'area disegnata
      const lx = Math.max(L.left + 18, Math.min(L.fcRight - 18, xOf(startIdx + k)));
      ctx.fillText(lbl, lx, L.priceBottom + 11);
    }

    // --- legenda ---
    ctx.textAlign = 'left';
    const legend = [];
    if (this.layers.ma) {
      legend.push(['EMA9', COLORS.ema9], ['EMA21', COLORS.ema21], ['EMA50', COLORS.ema50]);
    }
    if (this.layers.smc && this.smc) {
      legend.push(['OB', COLORS.obBullEdge], ['FVG', COLORS.fvgBullEdge],
        ['LIQ', COLORS.liq], ['BOS', COLORS.bos], ['CHoCH', COLORS.choch]);
    }
    if (this.layers.st) legend.push(['SuperTrend', COLORS.stUp]);
    if (this.layers.psar) legend.push(['SAR', COLORS.psar]);
    if (this.layers.ichimoku) legend.push(['Ichimoku', COLORS.ichiBase]);
    if (this.layers.div) legend.push(['Divergenze', COLORS.stUp]);
    if (this.layers.pivot) legend.push(['Pivot', COLORS.pivotMid]);
    let lx = L.left + 4;
    legend.forEach(function (item) {
      ctx.fillStyle = item[1];
      ctx.fillRect(lx, L.top + 2, 10, 2);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(item[0], lx + 13, L.top + 5);
      lx += 54;
    });

    // --- crosshair ---
    if (this.hover && this.hover.x > L.left && this.hover.x < L.fcRight &&
        this.hover.y > L.top && this.hover.y < L.priceBottom) {
      ctx.strokeStyle = COLORS.cross;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(this.hover.x) + 0.5, L.top);
      ctx.lineTo(Math.round(this.hover.x) + 0.5, L.priceBottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(L.left, Math.round(this.hover.y) + 0.5);
      ctx.lineTo(L.fcRight, Math.round(this.hover.y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const price = max - (this.hover.y - L.top) / plotH * (max - min);
      ctx.fillStyle = '#2a3a55';
      ctx.fillRect(L.fcRight, this.hover.y - 8, L.axisW, 16);
      ctx.fillStyle = '#e6edf7';
      ctx.fillText(price.toFixed(digits), L.fcRight + 5, this.hover.y);
    }

    this._geom = { L: L, startIdx: startIdx, count: count, xOf: xOf, yOf: yOf };
  };

  ForexChart.prototype._hoveredIndex = function () {
    if (!this.hover || !this._geom) return null;
    const g = this._geom;
    if (this.hover.x < g.L.left || this.hover.x > g.L.fcRight) return null;
    if (this.hover.y < g.L.top || this.hover.y > g.L.priceBottom) return null;
    const ratio = (this.hover.x - g.L.left) / (g.L.right - g.L.left);
    const idx = g.startIdx + Math.floor(ratio * g.count);
    if (idx < g.startIdx || idx >= this.series.candles.length) return null;
    return idx;
  };

  ForexChart.prototype._updateTooltip = function () {
    const idx = this._hoveredIndex();
    if (idx == null || !this.tooltip) {
      if (this.tooltip) this.tooltip.classList.add('hidden');
      return;
    }
    const c = this.series.candles[idx];
    const inst = this.instrument;
    const d = new Date(c.time);
    const tf = this.series.timeframe;
    const when = tf === 'D1'
      ? d.toLocaleDateString('it-IT')
      : d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const chg = (c.close - c.open) / c.open * 100;
    const txt =
      when + '\n' +
      'Apertura ' + c.open.toFixed(inst.digits) + '\n' +
      'Massimo  ' + c.high.toFixed(inst.digits) + '\n' +
      'Minimo   ' + c.low.toFixed(inst.digits) + '\n' +
      'Chiusura ' + c.close.toFixed(inst.digits) + '\n' +
      'Variaz.  ' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%\n' +
      'Volumi   ' + c.volume.toLocaleString('it-IT');

    this.tooltip.textContent = txt;
    this.tooltip.classList.remove('hidden');
    const wrap = this.canvas.parentElement.getBoundingClientRect();
    let x = this.hover.x + 16, y = this.hover.y + 14;
    const tw = this.tooltip.offsetWidth, th = this.tooltip.offsetHeight;
    if (x + tw > wrap.width - 6) x = this.hover.x - tw - 16;
    if (y + th > wrap.height - 6) y = Math.max(4, this.hover.y - th - 14);
    this.tooltip.style.left = x + 'px';
    this.tooltip.style.top = y + 'px';

    if (this.onHover) this.onHover(idx);
  };

  /* ---------------- SMC: banda premio / sconto ---------------- */
  ForexChart.prototype._drawPremiumDiscount = function (L, yOf, digits) {
    const ctx = this.ctx;
    const r = this.smc.range;
    const plotH = L.priceBottom - L.top;
    if (!(r.span > 0) || plotH <= 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(L.left, L.top, L.right - L.left, plotH);
    ctx.clip();

    const yHigh = yOf(r.high), yLow = yOf(r.low), yEq = yOf(r.equilibrium);
    const w = L.right - L.left;

    // zona di premio (sopra l'equilibrio) e di sconto (sotto)
    ctx.fillStyle = COLORS.pdPremium;
    ctx.fillRect(L.left, yHigh, w, Math.max(0, yEq - yHigh));
    ctx.fillStyle = COLORS.pdDiscount;
    ctx.fillRect(L.left, yEq, w, Math.max(0, yLow - yEq));

    // zona OTE
    const yOteTop = yOf(r.ote.top), yOteBot = yOf(r.ote.bottom);
    ctx.fillStyle = COLORS.pdOte;
    ctx.fillRect(L.left, Math.min(yOteTop, yOteBot), w, Math.abs(yOteBot - yOteTop));

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // equilibrio 50%
    ctx.strokeStyle = COLORS.pdEquilibrium;
    ctx.lineWidth = 1;
    ctx.setLineDash([7, 4]);
    ctx.beginPath();
    ctx.moveTo(L.left, yEq);
    ctx.lineTo(L.right, yEq);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(200,220,255,.7)';
    ctx.fillText('EQ 50% ' + r.equilibrium.toFixed(digits), L.left + 4, yEq - 7);

    // bordi OTE
    ctx.strokeStyle = 'rgba(255,204,85,.55)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(L.left, yOteTop); ctx.lineTo(L.right, yOteTop);
    ctx.moveTo(L.left, yOteBot); ctx.lineTo(L.right, yOteBot);
    ctx.stroke();
    ctx.setLineDash([]);

    // estremi del range
    ctx.fillStyle = 'rgba(143,163,191,.85)';
    ctx.fillText('HIGH ' + r.high.toFixed(digits), L.left + 4, yHigh + 9);
    ctx.fillText('LOW ' + r.low.toFixed(digits), L.left + 4, yLow - 9);

    ctx.restore();
  };

  /* ---------------- SMC: order block e fair value gap ---------------- */
  ForexChart.prototype._drawSmcZones = function (L, xOf, yOf, startIdx, digits) {
    const ctx = this.ctx;
    const smc = this.smc;
    const lastIdx = this.series.candles.length - 1;
    const plotH = L.priceBottom - L.top;
    if (plotH <= 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(L.left, L.top, L.right - L.left, plotH);
    ctx.clip();
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';

    function drawZone(z, fill, edge, label, dashed) {
      const x1 = xOf(Math.max(z.formedAt, startIdx));
      const x2 = xOf(z.invalidatedAt != null ? z.invalidatedAt : lastIdx) + 2;
      if (x2 <= L.left || x1 >= L.right) return;
      const yT = yOf(z.top), yB = yOf(z.bottom);
      const top = Math.min(yT, yB), h = Math.max(1, Math.abs(yB - yT));
      ctx.fillStyle = fill;
      ctx.fillRect(x1, top, Math.max(1, x2 - x1), h);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1;
      if (dashed) ctx.setLineDash([3, 3]);
      ctx.strokeRect(x1 + 0.5, top + 0.5, Math.max(1, x2 - x1 - 1), Math.max(1, h - 1));
      ctx.setLineDash([]);
      if (label) {
        ctx.fillStyle = edge;
        ctx.textAlign = 'left';
        const ty = z.kind === 'bullish' ? top + h + 8 : top - 8;
        if (ty > L.top + 6 && ty < L.priceBottom - 4) ctx.fillText(label, x1 + 3, ty);
      }
    }

    // order block non invalidati piu' recenti
    smc.orderBlocks
      .filter(function (z) { return z.status !== 'invalidated' && z.formedAt >= startIdx - 40; })
      .slice(-6)
      .forEach(function (z) {
        drawZone(z,
          z.kind === 'bullish' ? COLORS.obBull : COLORS.obBear,
          z.kind === 'bullish' ? COLORS.obBullEdge : COLORS.obBearEdge,
          'OB ' + z.sizeAtr.toFixed(1) + 'x', false);
      });

    // fair value gap non chiusi
    smc.fvgs
      .filter(function (z) { return z.status !== 'invalidated' && z.formedAt >= startIdx - 10; })
      .slice(-6)
      .forEach(function (z) {
        drawZone(z,
          z.kind === 'bullish' ? COLORS.fvgBull : COLORS.fvgBear,
          z.kind === 'bullish' ? COLORS.fvgBullEdge : COLORS.fvgBearEdge,
          'FVG', true);
      });

    ctx.restore();
  };

  /* ---------------- SMC: struttura, liquidita' e piano ---------------- */
  ForexChart.prototype._drawSmcStructure = function (L, xOf, yOf, startIdx, digits) {
    const ctx = this.ctx;
    const smc = this.smc;
    const candles = this.series.candles;
    const lastIdx = candles.length - 1;

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';

    function inPlot(y) { return y > L.top - 2 && y < L.priceBottom + 2; }
    function hline(y, x1, x2, color, dash, width) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width || 1;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 1. swing point confermati
    smc.swings.forEach(function (s) {
      if (s.index < startIdx) return;
      const y = yOf(s.price);
      if (!inPlot(y)) return;
      ctx.fillStyle = 'rgba(143,163,191,.55)';
      ctx.beginPath();
      ctx.arc(xOf(s.index), y, 1.7, 0, 6.2832);
      ctx.fill();
    });

    // 2. eventi di struttura (BOS / CHoCH)
    smc.structure.events
      .filter(function (e) { return e.index >= startIdx - 5; })
      .slice(-8)
      .forEach(function (e) {
        const y = yOf(e.level);
        if (!inPlot(y)) return;
        const color = e.type === 'CHoCH' ? COLORS.choch : (e.dir === 1 ? COLORS.bos : COLORS.bosDown);
        const x1 = xOf(Math.max(e.swingIndex, startIdx));
        const x2 = Math.min(L.right, xOf(e.index) + 16);
        hline(y, x1, x2, color, [4, 3], 1.2);
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.fillText(e.type + (e.dir === 1 ? ' \u2191' : ' \u2193'), x1 + 3, y + (e.dir === 1 ? -7 : 8));
      });

    // 3. liquidita' (massimi/minimi uguali) e sweep
    smc.liquidity.forEach(function (l) {
      const y = yOf(l.price);
      if (!inPlot(y)) return;
      const x1 = xOf(Math.max(l.firstIndex, startIdx));
      hline(y, x1, L.right - 2, COLORS.liq, [1, 3], 1);
      ctx.fillStyle = COLORS.liq;
      ctx.textAlign = 'right';
      ctx.fillText('LIQ x' + l.members + (l.taken ? ' presa' : l.sweptAt != null ? ' sweep' : ''),
        L.right - 4, y + (l.kind === 'buy-side' ? -7 : 8));

      if (l.sweptAt != null && l.sweptAt >= startIdx) {
        const xs = xOf(l.sweptAt);
        const c = candles[l.sweptAt];
        const ys = yOf(l.kind === 'buy-side' ? c.high : c.low);
        if (!inPlot(ys)) return;
        ctx.fillStyle = COLORS.sweep;
        ctx.beginPath();
        if (l.kind === 'buy-side') {
          ctx.moveTo(xs, ys - 3); ctx.lineTo(xs - 3.5, ys - 10); ctx.lineTo(xs + 3.5, ys - 10);
        } else {
          ctx.moveTo(xs, ys + 3); ctx.lineTo(xs - 3.5, ys + 10); ctx.lineTo(xs + 3.5, ys + 10);
        }
        ctx.closePath();
        ctx.fill();
      }
    });

    // 4. piano operativo SMC (etichette sul bordo sinistro, opposto a quelle
    //    della previsione tecnica che stanno a destra)
    const p = smc.plan;
    if (p) {
      const levels = [
        ['SMC ENTRY', p.limitEntry, COLORS.smcPlan, [7, 3]],
        ['SMC TP2', p.tp2, COLORS.liq, [3, 4]],
        ['SMC TP1', p.tp1, 'rgba(143,163,191,.9)', [3, 4]],
        ['SMC STOP', p.stop, COLORS.down, [3, 4]]
      ];
      // livelli visibili ordinati dall'alto verso il basso; le etichette che
      // finirebbero una sull'altra vengono sfasate verticalmente
      const vis = levels
        .map(function (lv) { return { lv: lv, y: yOf(lv[1]) }; })
        .filter(function (v) { return inPlot(v.y); })
        .sort(function (a, b) { return a.y - b.y; });
      const used = [];
      vis.forEach(function (v) {
        hline(v.y, L.left + 2, L.right, v.lv[2], v.lv[3], 1);
        let ly = v.y - 6;
        while (used.some(function (u) { return Math.abs(u - ly) < 9; })) ly -= 9;
        used.push(ly);
        ctx.fillStyle = v.lv[2];
        ctx.textAlign = 'left';
        ctx.fillText(v.lv[0] + ' ' + v.lv[1].toFixed(digits), L.left + 5, ly);
      });
    }
  };

  /* Mini grafico per la curva equity del backtest */
  function drawEquity(canvas, equity, color) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300, h = canvas.clientHeight || 92;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(9,14,22,.6)';
    ctx.fillRect(0, 0, w, h);

    if (!equity || equity.length < 2) {
      ctx.fillStyle = '#8fa3bf';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Dati insufficienti per il backtest', w / 2, h / 2);
      return;
    }

    let min = Math.min(0, Math.min.apply(null, equity));
    let max = Math.max(0, Math.max.apply(null, equity));
    if (max - min < 1e-6) { max += 1; min -= 1; }
    const pad = 6;
    const xOf = (i) => pad + (i / (equity.length - 1)) * (w - pad * 2);
    const yOf = (v) => pad + (max - v) / (max - min) * (h - pad * 2);

    // zero line
    ctx.strokeStyle = 'rgba(34,48,74,.9)';
    ctx.beginPath();
    ctx.moveTo(pad, yOf(0));
    ctx.lineTo(w - pad, yOf(0));
    ctx.stroke();

    // riempimento
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(0));
    equity.forEach(function (v, i) { ctx.lineTo(xOf(i), yOf(v)); });
    ctx.lineTo(xOf(equity.length - 1), yOf(0));
    ctx.closePath();
    ctx.fillStyle = color === COLORS.up ? 'rgba(24,201,138,.16)' : 'rgba(242,85,90,.16)';
    ctx.fill();

    // linea
    ctx.beginPath();
    equity.forEach(function (v, i) { i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v)); });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    ctx.fillStyle = '#8fa3bf';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('R cumulati', pad + 2, 11);
  }

  global.ForexChart = ForexChart;
  global.drawEquityCurve = drawEquity;
})(window);
