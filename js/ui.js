/* =========================================================================
 * ui.js - navigazione a tab e componenti grafici leggeri
 *
 * Contiene solo costruttori di presentazione: nessun calcolo di analisi.
 *   Tabs       navigazione tra pannelli (attiva la classe .active e
 *              notifica al chiamante per ridisegnare i canvas);
 *   dialSvg    gauge a semicerchio in SVG puro con zone colorate;
 *   ladder     scala visiva entry / stop / obiettivi;
 *   spark      mini-grafico a linea su canvas;
 *   histogram  istogramma bidirezionale su canvas (MACD);
 *   levelMap   mappa dei livelli di liquidita' sopra/sotto il prezzo;
 *   timeline   sequenza di eventi di struttura su finestra di barre.
 * ========================================================================= */
(function (global) {
  'use strict';

  const doc = () => global.document;

  /* ---------------------------------------------------------------- Tabs */
  const Tabs = {
    init(onSwitch) {
      const bar = doc().getElementById('tabbar');
      if (!bar) return;
      let saved = null;
      try { saved = global.localStorage.getItem('forexvision.tab'); } catch (e) { /* no storage */ }
      bar.addEventListener('click', function (e) {
        const btn = e.target.closest('.tab');
        if (btn) Tabs.show(btn.dataset.panel, true);
      });
      let wanted = saved && bar.querySelector('.tab[data-panel="' + saved + '"]')
        ? saved : 'tab-dash';
      const urlTab = /(?:\?|&)tab=([\w-]+)/.exec((global.location && global.location.search) || '');
      if (urlTab) {
        const w = urlTab[1].indexOf('tab-') === 0 ? urlTab[1] : 'tab-' + urlTab[1];
        if (bar.querySelector('.tab[data-panel="' + w + '"]')) wanted = w;
      }
      Tabs.show(wanted, false);
      if (onSwitch) Tabs.onSwitch = onSwitch;
    },
    show(id, save) {
      const panels = doc().querySelectorAll('.tab-panel');
      for (let i = 0; i < panels.length; i++) {
        panels[i].classList.toggle('active', panels[i].id === id);
      }
      const bar = doc().getElementById('tabbar');
      if (bar) {
        const tabs = bar.querySelectorAll('.tab');
        for (let i = 0; i < tabs.length; i++) {
          tabs[i].classList.toggle('active', tabs[i].dataset.panel === id);
        }
      }
      try { if (save) global.localStorage.setItem('forexvision.tab', id); } catch (e) { /* no storage */ }
      if (Tabs.onSwitch) Tabs.onSwitch(id);
    },
    onSwitch: null
  };

  /* ---------------------------------------------------- helpers di scala */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function pct(v, min, max) {
    const span = max - min;
    return span <= 0 ? 0.5 : (v - min) / span;
  }

  /* ----------------------------------------------------------- dial SVG */
  /**
   * Gauge a semicerchio con zone colorate e ago sul valore.
   * @param {number} value   valore attuale
   * @param {number} min     minimo della scala
   * @param {number} max     massimo della scala
   * @param {Array}  zones   [{from, to, color}] segmenti sulla stessa scala
   * @returns {string} markup SVG
   */
  const DIAL_CX = 60, DIAL_CY = 58, DIAL_R = 44;
  function polar(deg) {
    const rad = deg * Math.PI / 180;
    return {
      x: DIAL_CX + DIAL_R * Math.cos(rad),
      y: DIAL_CY + DIAL_R * Math.sin(rad)
    };
  }
  const dialArc = (d0, d1, r) => {
    r = r === undefined ? DIAL_R : r;
    const a = polar(d0), b = polar(d1);
    return 'M' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
      ' A' + r + ' ' + r + ' 0 0 1 ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
  };
  function dialSvg(value, min, max, zones, color) {
    const angle = (v) => 180 + clamp(pct(v, min, max), 0, 1) * 180;
    let arcs = '<path d="' + dialArc(180, 360) + '" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="9" stroke-linecap="round"/>';
    (zones || []).forEach(function (z) {
      const a0 = angle(clamp(z.from, min, max)), a1 = angle(clamp(z.to, min, max));
      if (a1 - a0 < 0.4) return;
      arcs += '<path d="' + dialArc(a0, a1, DIAL_R) + '" fill="none" stroke="' +
        (z.color || 'rgba(120,150,200,.6)') + '" stroke-width="9" opacity=".55"/>';
    });
    const tip = polar(angle(value));
    arcs += '<path d="' + dialArc(180, angle(value), DIAL_R) + '" fill="none" stroke="' +
      (color || '#5a8fd0') + '" stroke-width="9" stroke-linecap="round"/>';
    arcs += '<line x1="' + DIAL_CX + '" y1="' + DIAL_CY + '" x2="' + (DIAL_CX + (tip.x - DIAL_CX) * 0.52).toFixed(1) +
      '" y2="' + (DIAL_CY + (tip.y - DIAL_CY) * 0.52).toFixed(1) +
      '" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="' + DIAL_CX + '" cy="' + DIAL_CY + '" r="3" fill="#fff"/>';
    return '<svg viewBox="0 0 120 70" role="img">' + arcs + '</svg>';
  }
  function dialTile(valueText, label, svg, tag, tagClass) {
    return '<div class="gauge-tile">' + svg +
      '<div class="gt-v">' + valueText + '</div>' +
      '<div class="gt-l">' + label + '</div>' +
      (tag ? '<span class="tag ' + (tagClass || 'neu') + '">' + tag + '</span>' : '') +
      '</div>';
  }

  /* ------------------------------------------------- scala lineare a zone */
  /** Barra orizzontale: zone di sfondo + cursore sul valore. */
  function meter(fillHtml, center) {
    return '<div class="meter">' +
      '<span class="meter-zone">' + fillHtml + '</span>' +
      (center ? '<span class="meter-center"></span>' : '') +
      '</div>';
  }

  /* ------------------------------------------------------------- ladder */
  /**
   * Scala verticale: prezzo/ingresso al centro, zona perdita (rosso) verso lo
   * stop, zona guadagno (verde) verso l'obiettivo.
   * @param {HTMLElement} el  contenitore
   * @param {Array} items     [{price,label,text,cls}]
   * @param {Object} [zones]  {risk:[p1,p2], gain:[p1,p2]} coppie di estremi
   */
  function ladder(el, items, zones, orientation) {
    if (!el) return;
    zones = zones || {};
    const H = orientation === 'h';
    const all = items.map(function (i) { return i.price; })
      .concat(zones.risk || [], zones.gain || []);
    let min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    const pad = (max - min) * 0.06 || max * 0.0008;
    min -= pad; max += pad;
    const y = (p) => clamp(pct(p, min, max), 0.02, 0.98) * 100;

    let html = '';
    if (H) {
      html += '<div class="rail"></div>';
      html += zoneHtmlH(y, zones.risk, 'stop-zone');
      html += zoneHtmlH(y, zones.gain, 'gain-zone');
      const sorted = items.slice().sort(function (a, b) { return a.price - b.price; });
      sorted.forEach(function (i, idx) {
        const x = clamp(pct(i.price, min, max), 0.04, 0.96) * 100;
        html += '<div class="h-dot ' + (i.cls || 'extra') + '" style="left:' + x.toFixed(1) + '%"></div>' +
          '<div class="h-lab ' + (i.cls || 'extra') + ' ' + (idx % 2 ? 'lo' : 'hi') + '" style="left:' + x.toFixed(1) + '%">' +
          '<span class="s-lab">' + (i.label || '') + '</span>' +
          '<span class="s-price">' + (i.text != null ? i.text : '') + '</span>' +
          '</div>';
      });
      el.innerHTML = html;
      el.classList.add('ladder');
      el.classList.add('h-l');
      return;
    }
    html += '<div class="rail"></div>';
    html += zoneHtml(y, zones.risk, 'stop-zone');
    html += zoneHtml(y, zones.gain, 'gain-zone');
    html += items.map(function (i) {
      return '<div class="step ' + (i.cls || 'extra') + '" style="top:' + y(i.price).toFixed(1) + '%">' +
        '<span class="s-lab">' + (i.label || '') + '</span>' +
        '<span class="s-dot"></span>' +
        '<span class="s-price">' + (i.text != null ? i.text : '') + '</span>' +
        '</div>';
    }).join('');
    el.innerHTML = html;
    el.classList.add('ladder');
  }
  function zoneHtml(y, pair, cls) {
    if (!pair || !isFinite(pair[0]) || !isFinite(pair[1])) return '';
    const a = y(pair[0]), b = y(pair[1]);
    return '<div class="' + cls + '" style="top:' + Math.min(a, b).toFixed(1) +
      '%;height:' + Math.abs(b - a).toFixed(1) + '%"></div>';
  }
  function zoneHtmlH(y, pair, cls) {
    if (!pair || !isFinite(pair[0]) || !isFinite(pair[1])) return '';
    const a = y(pair[0]), b = y(pair[1]);
    const left = Math.min(a, b), w = Math.abs(b - a);
    return '<div class="' + cls + '" style="left:' + left.toFixed(1) +
      '%;width:' + w.toFixed(1) + '%"></div>';
  }

  /* ------------------------------------------------------------ spark */
  /** Mini-grafico a linea (serie di chiusure recenti) */
  function spark(canvas, values, color) {
    if (!canvas || !values || values.length < 2) return;
    const dpr = global.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 300, cssH = canvas.clientHeight || 64;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    let min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    if (max - min < 1e-9) { min -= 1e-9; max += 1e-9; }
    const px = (i) => i / (values.length - 1) * (cssW - 6) + 3;
    const py = (v) => (1 - (v - min) / (max - min)) * (cssH - 10) + 5;
    ctx.beginPath();
    values.forEach(function (v, i) {
      if (i === 0) ctx.moveTo(px(i), py(v)); else ctx.lineTo(px(i), py(v));
    });
    ctx.strokeStyle = color || '#5a8fd0';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo(px(values.length - 1), cssH);
    ctx.lineTo(px(0), cssH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(90,143,208,.16)';
    ctx.fill();
    const lastY = py(values[values.length - 1]), lastX = px(values.length - 1);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = color || '#fff';
    ctx.fill();
  }

  /* ------------------------------------------------------- histogram */
  /** Istogramma bidirezionale attorno allo zero (es. MACD). */
  function histogram(canvas, values, colorUp, colorDn) {
    if (!canvas || !values || !values.length) return;
    const dpr = global.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 260, cssH = canvas.clientHeight || 56;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    let maxAbs = 0;
    values.forEach(function (v) { if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v); });
    if (!maxAbs) maxAbs = 1e-9;
    const zero = cssH / 2;
    const half = cssH / 2 - 4;
    const bw = Math.max(2, cssW / values.length - 2);
    values.forEach(function (v, i) {
      const h = Math.abs(v) / maxAbs * half;
      const x = i * (cssW / values.length) + 1;
      ctx.fillStyle = v >= 0 ? (colorUp || 'rgba(24,201,138,.75)') : (colorDn || 'rgba(242,85,90,.75)');
      ctx.fillRect(x, v >= 0 ? zero - h : zero, bw, h);
    });
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillRect(0, zero - 0.5, cssW, 1);
  }

  /* -------------------------------------------------------- levelMap */
  /**
   * Mappa dei livelli (liquidita') sopra e sotto il prezzo: sopra il prezzo i
   * piu' lontani in alto, sotto i piu' lontani in basso (come una scala).
   * @param {Array} levels [{price, kind, taken, sweptAt, members}]
   */
  function levelMap(el, levels, price, digits) {
    if (!el) return;
    const rows = (levels || []).filter(function (l) {
      return isFinite(l.price) && l.price !== price;
    }).map(function (l) {
      return { l: l, d: l.price - price };
    });
    if (!rows.length) { el.innerHTML = '<div class="note small">nessun pool di liquidita\u0300 rilevato</div>'; return; }
    let maxAbs = 0;
    rows.forEach(function (r) { if (Math.abs(r.d) > maxAbs) maxAbs = Math.abs(r.d); });
    maxAbs = maxAbs || 1e-9;
    const width = function (d) {
      return Math.round((0.12 + 0.36 * Math.abs(d) / maxAbs) * 100) + '%';
    };
    const row = function (r) {
      const up = r.d > 0;
      const state = r.l.sweptAt != null ? 'swept' : (r.l.taken ? 'taken' : '');
      return '<div class="liq-row ' + (up ? 'up' : 'dn') + '">' +
        '<span class="d">' + (up ? '+' : '') + r.d.toFixed(digits || 4) + '</span>' +
        '<span class="b"><i class="' + state + '" style="width:' + width(r.d) + '"></i></span>' +
        '<span class="lv">' + r.l.price.toFixed(digits || 4) +
        ' <small>' + r.l.members + 'x' +
        (r.l.sweptAt != null ? ' - sweep' : r.l.taken ? ' - presa' : '') + '</small></span>' +
        '</div>';
    };
    const above = rows.filter(function (r) { return r.d > 0; }).sort(function (a, b) { return b.d - a.d; });
    const below = rows.filter(function (r) { return r.d < 0; }).sort(function (a, b) { return b.d - a.d; });
    el.innerHTML =
      above.map(row).join('') +
      '<div class="liq-price-line">prezzo attuale</div>' +
      below.map(row).join('');
  }

  /* --------------------------------------------------------- timeline */
  /**
   * Eventi di struttura su una finestra di barre (il piu' recente a destra).
   * @param {Array} events [{index, type, dir, level}]
   */
  function timeline(el, events, lastIndex, windowBars) {
    if (!el) return;
    windowBars = windowBars || 50;
    const shown = (events || []).filter(function (e) {
      return lastIndex - e.index <= windowBars;
    });
    let html = '';
    shown.forEach(function (e) {
      const x = (1 - (lastIndex - e.index) / windowBars) * 100;
      const cls = (e.type === 'CHoCH' ? 'choch' : (e.dir === 1 ? 'bos' : 'bear'));
      html += '<span class="ev ' + cls + '" style="left:' + x.toFixed(1) + '%" title="' +
        e.type + ' su ' + e.level + '"></span>';
    });
    html += '<span class="axl"><span>-' + windowBars + ' barre</span><span>adesso</span></span>';
    el.innerHTML = html;
  }

  global.Ui = {
    Tabs: Tabs,
    clamp: clamp,
    meter: meter,
    dialSvg: dialSvg,
    dialTile: dialTile,
    ladder: ladder,
    spark: spark,
    histogram: histogram,
    levelMap: levelMap,
    timeline: timeline
  };
})(window);
