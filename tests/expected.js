/* =========================================================================
 * expected.js - Tabella dei valori attesi, generata dai dati
 * -------------------------------------------------------------------------
 * I test delle spiegazioni non elencano a mano che cosa confrontare: leggono i
 * dati che l'app usa in quel momento (window.ForexApp.context()) e pretendono
 * che il testo citi proprio quelli. Le regole sono tre, tutte sui dati:
 *
 *   A. nessun numero inventato - ogni numero scritto nella parte «In questo
 *      momento» deve corrispondere a un valore dei dati, arrotondato alla
 *      precisione con cui e' scritto (un decimale di troppo non conta);
 *   B. le costanti di formula sono dichiarate - periodi e soglie (20 candele,
 *      EMA 9, media a 50 candele, finestra del backtest) non sono dati: stanno
 *      in STRUCT, con il motivo scritto accanto. Sono l'unica eccezione;
 *   C. le card mostrano gli stessi numeri - per le grandezze principali la
 *      tabella dichiara dove la card le disegna: il valore atteso viene dai
 *      dati, non dal testo, quindi un numero sbagliato in due posti si vede.
 *
 * La tabella e' una sola per tutte le suite: selfcheck la usa su dati
 * sintetici, smoke e live sui dati veri dell'app.
 *
 * Nota sulle scritture: l'app formatta con toFixed, quindi il confronto e'
 * un'uguaglianza fra stringhe alla stessa precisione. E' severo (1.11908 non
 * passa per 1.11907) ed e' esente dagli errori di arrotondamento binario.
 * ========================================================================= */
(function (root) {
  'use strict';

  /* ------------------------------ utilità ------------------------------ */

  function n(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function lastIn(list) {
    const a = arr(list);
    for (let i = a.length - 1; i >= 0; i--) if (n(a[i]) != null) return a[i];
    return null;
  }
  function sum(list) { return arr(list).reduce(function (a, b) { return a + b; }, 0); }
  function avg(list) {
    const a = arr(list).filter(function (x) { return n(x) != null; });
    return a.length ? sum(a) / a.length : null;
  }
  function div(a, b) { return n(a) != null && n(b) ? a / b : null; }
  function sub(a, b) { return n(a) != null && n(b) != null ? a - b : null; }
  function candles(ctx) { return arr(ctx && ctx.series && ctx.series.candles); }
  function pip(ctx) { return (ctx && ctx.inst && ctx.inst.pip) || 0.0001; }
  function digits(ctx) { return ctx && ctx.digits != null ? ctx.digits : 5; }
  function pick(list, fn) {
    const out = arr(list).filter(function (x) { return fn(x); });
    return out.length ? out[0] : null;
  }

  /* ---------------------- B. costanti di formula ---------------------- */
  /* Numeri che non vengono dai dati ma dalla formula che li produce: sono
   * dichiarati qui, con il motivo, e restano l'unico vocabolario ammesso. */

  const STRUCT = [
    { v: 9, why: 'periodo della EMA 9, citato nel confronto fra le medie' },
    { v: 21, why: 'periodo della EMA 21, citato nel confronto fra le medie' },
    { v: 50, why: 'media delle ultime 50 candele nel rapporto di volatilita' },
    { v: 20, why: 'finestra di 20 candele della variazione di prezzo' },
    { v: 24, why: 'finestra di 24 candele della posizione del prezzo' },
    { v: 40, why: 'candele della striscia del moto recente' },
    { v: 250, why: 'candele su cui gira il backtest' },
    { v: 200, why: 'periodo della media mobile semplice SMA 200' },
    { v: 100, why: 'scala 0-100 di punteggi, percentili e probabilita' },
    { v: 14, why: 'periodo di RSI, Stochastic e ATR' },
    { v: 3, why: 'smoothing dello Stochastic e barre per lato degli swing' },
    { v: 1, why: 'denominatore del rapporto rischio/obiettivo e multiplo di ATR' }
  ];

  /* ------------------------------ letture ------------------------------ */
  /* La tabella: ogni voce dice da dove viene un valore e in che unita' e'.
   * `get(v, ctx)` legge la vista dati costruita da view(). */

  const READS = [];
  /**
   * Una lettura dichiarata. `card` puo' essere un selettore oppure
   * Un valore puo' essere disegnato in piu' pannelli: `card` accetta anche una
   * lista di collegamenti.
   *
   * {sel, dec, scale, count, neg, drawn}:
   *   dec   - decimali con cui la card scrive il numero (default: per unita');
   *   scale - fattore fra il dato e il numero scritto (100 per le percentuali);
   *   count - il valore e' quante voci la lista contiene, non un numero scritto;
   *   neg   - la card scrive una magnitudine col segno meno (perdita media);
   *   shown - il pannello mostra il valore in una forma che non si confronta
   *           numero per numero (un disegno, una data, un'etichetta): fa parte
   *           del contratto ma non del confronto con il testo della pagina.
   */
  function oneCard(card) {
    if (typeof card === 'string') return { sel: card, dec: null, scale: 1, count: false, neg: false, shown: false };
    return {
      sel: card.sel, dec: card.dec != null ? card.dec : null,
      scale: card.scale == null ? 1 : card.scale, count: !!card.count,
      neg: !!card.neg, shown: !!card.shown
    };
  }
  function normalizeCard(card) {
    if (!card) return [];
    return (Array.isArray(card) ? card : [card]).map(oneCard);
  }
  function read(label, unit, get, card) {
    READS.push({ label: label, unit: unit, get: get, card: normalizeCard(card) });
  }

  /* La vista dati: una volta sola, tutte le grandezze che le card citano,
   * derivate dai dati grezzi con le stesse formule che usano le card. */
  function view(ctx) {
    ctx = ctx || {};
    const v = {};
    const a = ctx.analysis || {};
    const s = ctx.smc || {};
    const ind = a.indicators || {};
    const b = ctx.backtest || {};
    const st = ctx.divStudy || {};
    const sAll = st.all || {};
    const sen = ctx.sentiment || {};
    const piv = ctx.pivots || {};
    const classic = piv.classic || {};
    const cam = piv.camarilla || {};
    const plan = s.plan || {};
    const range = s.range || {};
    const ms = s.structure || {};
    const ev = ms.event || ms.lastEvent || {};
    const dv = ctx.divergence || {};
    const items = arr(dv.items);
    const cs = candles(ctx);
    const bar = ctx.series && ctx.series.info ? ctx.series.info : {};
    const P = pip(ctx);

    /* --- serie e candele --- */
    v.bars = cs.length;
    v.last = cs.length ? cs[cs.length - 1] : null;
    v.open = v.last ? n(v.last.open) : null;
    v.high = v.last ? n(v.last.high) : null;
    v.low = v.last ? n(v.last.low) : null;
    v.close = v.last ? n(v.last.close) : null;
    v.volume = v.last ? n(v.last.volume) : null;
    v.price = n(ctx.price);
    v.change1 = n(ctx.changePct);
    if (cs.length > 20 && n(v.price) != null) {
      const ref = n(cs[cs.length - 21].close);
      v.change20 = ref ? (v.price - ref) / ref * 100 : null;
    }
    const c40 = cs.slice(-40);
    if (c40.length > 1) {
      const f = n(c40[0].close);
      const l = n(c40[c40.length - 1].close);
      v.sparkBars = c40.length;
      v.sparkFrom = f;
      v.sparkTo = l;
      v.sparkPct = f ? (l - f) / f * 100 : null;
      v.sparkHi = Math.max.apply(null, c40.map(function (c) { return n(c.high); }).filter(function (x) { return x != null; }));
      v.sparkLo = Math.min.apply(null, c40.map(function (c) { return n(c.low); }).filter(function (x) { return x != null; }));
      v.sparkWidth = sub(v.sparkHi, v.sparkLo);
    }
    const c24 = cs.slice(-24);
    if (c24.length) {
      const hi = Math.max.apply(null, c24.map(function (c) { return n(c.high); }).filter(function (x) { return x != null; }));
      const lo = Math.min.apply(null, c24.map(function (c) { return n(c.low); }).filter(function (x) { return x != null; }));
      v.hi24 = hi;
      v.lo24 = lo;
      v.pos24 = hi > lo && n(v.price) != null ? (v.price - lo) / (hi - lo) * 100 : null;
    }

    /* --- motore tecnico --- */
    v.atr = n(a.atr);
    v.atrPct = n(a.atrPct);
    v.score = n(a.score);
    v.confidence = n(a.confidence);
    v.probUp = n(a.probabilityUp);
    v.probDown = n(a.probabilityDown);
    v.adx = n(a.adx);
    v.rr = n(a.rr);
    v.target = n(a.target);
    v.stop = n(a.stop);
    v.expectedMove = n(a.expectedMove);
    v.horizon = n(a.horizon);
    v.trendRegime = n(a.trendRegime);
    v.entry = n(a.price);
    v.lastVolume = n(ctx.lastVolume);
    v.expectedPips = div(v.expectedMove, P);
    v.expectedAtr = div(v.expectedMove, v.atr);
    v.targetPips = div(sub(v.target, v.entry), P);
    v.stopPips = div(sub(v.stop, v.entry), P);
    v.aboveMedie = null;
    v.medieCount = null;
    const medie = [['ema9', lastIn(ind.ema9)], ['ema21', lastIn(ind.ema21)],
      ['ema50', lastIn(ind.ema50)], ['sma200', lastIn(ind.sma200)]]
      .filter(function (x) { return n(x[1]) != null; });
    if (medie.length && n(v.price) != null) {
      v.medieCount = medie.length;
      v.aboveMedie = medie.filter(function (x) { return v.price >= x[1]; }).length;
    }
    v.atrAvg50 = avg(arr(ind.atr).slice(-50));
    v.volRatio = div(v.atr, v.atrAvg50);
    v.volRatioLast = div(v.lastVolume, lastIn(ind.volumeSma));

    /* --- indicatori (ultimo valore di ogni serie) --- */
    v.rsi = lastIn(ind.rsi);
    v.macdHist = ind.macd ? lastIn(ind.macd.histogram) : null;
    v.sma200 = lastIn(ind.sma200);
    v.ema9 = lastIn(ind.ema9);
    v.ema21 = lastIn(ind.ema21);
    v.ema50 = lastIn(ind.ema50);
    v.plusDI = lastIn(ind.plusDI);
    v.minusDI = lastIn(ind.minusDI);
    v.stochK = ind.stoch ? lastIn(ind.stoch.k) : null;
    v.stochD = ind.stoch ? lastIn(ind.stoch.d) : null;
    v.percentB = ind.bb ? lastIn(ind.bb.percentB) : null;
    v.bandwidth = ind.bb ? lastIn(ind.bb.bandwidth) : null;
    v.roc5 = ind.roc5 ? lastIn(ind.roc5) * 100 : null;
    v.roc20 = ind.roc20 ? lastIn(ind.roc20) * 100 : null;
    v.slope50 = ind.slope50 ? lastIn(ind.slope50) * 100 : null;
    v.cci = lastIn(ind.cci);
    v.choppiness = lastIn(ind.choppiness);
    /* lo Stochastic RSI è un oggetto {k, d}: leggerlo come serie darebbe
     * sempre null e la riga %K del pannello resterebbe senza valore */
    v.stochRsi = ind.stochRsi ? lastIn(ind.stochRsi.k) : null;
    v.superTrendLine = ind.superTrend ? lastIn(ind.superTrend.line) : null;
    v.superTrendDir = ind.superTrend ? lastIn(ind.superTrend.dir) : null;
    v.psar = lastIn(ind.psar);
    v.aroonUp = ind.aroon ? lastIn(ind.aroon.up) : null;
    v.aroonDown = ind.aroon ? lastIn(ind.aroon.down) : null;
    v.bbUpper = ind.bb ? lastIn(ind.bb.upper) : null;
    v.bbLower = ind.bb ? lastIn(ind.bb.lower) : null;
    v.keltnerUpper = ind.keltner ? lastIn(ind.keltner.upper) : null;
    v.keltnerLower = ind.keltner ? lastIn(ind.keltner.lower) : null;
    v.ichiTop = ind.ichimoku ? Math.max(lastIn(ind.ichimoku.spanA) || -Infinity, lastIn(ind.ichimoku.spanB) || -Infinity) : null;
    v.ichiBot = ind.ichimoku ? Math.min(lastIn(ind.ichimoku.spanA) || Infinity, lastIn(ind.ichimoku.spanB) || Infinity) : null;
    if (!isFinite(v.ichiTop)) v.ichiTop = null;
    if (!isFinite(v.ichiBot)) v.ichiBot = null;
    /* anche la regressione è un oggetto {slope, r2}: si legge la pendenza */
    v.linreg = ind.linreg ? lastIn(ind.linreg.slope) : null;
    /* Distanze dalle medie e dai livelli, le stesse che citano le motivazioni
     * del motore: sono dati derivati, non numeri di comodo. */
    v.sma200DistAtr = div(sub(v.price, v.sma200), v.atr);
    v.ema9DistAtr = div(sub(v.price, v.ema9), v.atr);
    v.psarDistAtr = div(sub(v.price, v.psar), v.atr);
    v.superTrendDistAtr = div(sub(v.price, v.superTrendLine), v.atr);
    v.bbUpperDistAtr = div(sub(v.bbUpper, v.price), v.atr);
    v.bbLowerDistAtr = div(sub(v.price, v.bbLower), v.atr);

    /* --- livelli della proiezione (probabilita' di toccare) --- */
    v.levels = arr(a.levels);

    /* --- SMC --- */
    v.smcScore = n(s.score);
    v.smcConfidence = n(s.confidence);
    v.smcPrice = n(s.price);
    v.smcAtr = n(s.atr);
    v.rangeLow = n(range.low);
    v.rangeHigh = n(range.high);
    v.rangeMid = n(range.mid) != null ? n(range.mid) : n(range.equilibrium);
    v.rangePos = n(range.position) != null ? n(range.position) * 100
      : (n(v.price) != null && n(v.rangeLow) != null && n(v.rangeHigh) != null && v.rangeHigh > v.rangeLow
        ? (v.price - v.rangeLow) / (v.rangeHigh - v.rangeLow) * 100 : null);
    v.smcEntry = n(plan.marketEntry);
    v.smcLimit = n(plan.limitEntry);
    v.smcStop = n(plan.stop);
    v.smcTp1 = n(plan.tp1);
    v.smcTp2 = n(plan.tp2);
    v.liqPrice = plan.targetLiquidity ? n(plan.targetLiquidity.price) : null;
    v.liqMembers = plan.targetLiquidity ? n(plan.targetLiquidity.members) : null;
    v.obAll = arr(s.orderBlocks).length;
    v.obValid = arr(s.orderBlocks).filter(function (o) { return o.status !== 'invalidated'; }).length;
    v.obFresh = arr(s.orderBlocks).filter(function (o) { return o.status === 'fresh'; }).length;
    v.fvgAll = arr(s.fvgs).length;
    v.fvgValid = arr(s.fvgs).filter(function (g) { return g.status !== 'invalidated'; }).length;
    v.liqAll = arr(s.liquidity).length;
    v.liqIntact = arr(s.liquidity).filter(function (l) { return !l.taken && l.sweptAt == null; }).length;
    v.evIndex = n(ev.index);
    v.evLevel = n(ev.level);

    /* --- motore previsionale e backtest --- */
    v.btCount = n(b.count);
    v.btWinRate = n(b.winRate);
    v.btAvgWin = n(b.avgWin);
    v.btAvgLoss = n(b.avgLoss);
    v.btAvgR = n(b.avgR);
    v.btTotalR = n(b.totalR);
    v.btDrawdown = n(b.maxDrawdown);
    v.btProfitFactor = n(b.profitFactor);
    v.btPerTrade = div(v.btTotalR, v.btCount);
    v.btWinPct = v.btWinRate != null ? v.btWinRate * 100 : null;

    /* --- divergenze e studio di efficacia --- */
    v.divCount = items.length;
    v.divBull = n(dv.bull);
    v.divBear = n(dv.bear);
    v.divLookback = n(dv.lookback);
    v.divFrom = items.length ? n(items[0].from && items[0].from.price) : null;
    v.divTo = items.length ? n(items[0].to && items[0].to.price) : null;
    v.divAge = items.length ? n(items[0].age) : null;
    v.studyCount = n(st.count);
    v.studyWindow = n(st.window);
    v.studyHorizon = n(st.horizon);
    v.studyHit = n(sAll.hitRate);
    v.studyAvgR = n(sAll.avgR);
    v.studyCi = n(sAll.ci95);
    v.studyPf = n(sAll.profitFactor);
    v.studyHitPct = v.studyHit != null ? v.studyHit * 100 : null;

    /* --- pivot --- */
    v.pivotPeriod = piv.period || null;
    v.pivot = n(classic.p);
    v.r1 = n(classic.r1);
    v.r2 = n(classic.r2);
    v.r3 = n(classic.r3);
    v.s1 = n(classic.s1);
    v.s2 = n(classic.s2);
    v.s3 = n(classic.s3);
    v.camR3 = n(cam.r3);
    v.camS3 = n(cam.s3);
    v.pivotHigh = n(piv.high);
    v.pivotLow = n(piv.low);
    v.pivotPips = div(sub(v.price, v.pivot), P);

    /* --- sentiment --- */
    v.sentScore = n(sen.score);
    v.sentConfidence = n(sen.confidence);
    v.sentBias = sen.bias || null;
    const strength = sen.strength ? (sen.strength.list || (Array.isArray(sen.strength) ? sen.strength : [])) : [];
    const ranked = arr(strength).filter(function (x) { return n(x.score) != null; })
      .slice().sort(function (x, y) { return y.score - x.score; });
    v.strengthTop = ranked.length ? ranked[0] : null;
    v.strengthBottom = ranked.length ? ranked[ranked.length - 1] : null;
    v.strengthCount = ranked.length;
    v.strengthTopScore = ranked.length ? n(ranked[0].score) : null;
    v.strengthBottomScore = ranked.length ? n(ranked[ranked.length - 1].score) : null;
    v.strengthTopRank = ranked.length ? n(ranked[0].rank) : null;
    const sPair = sen.pair || {};
    v.baseRank = (pick(ranked, function (x) { return x.currency === sPair.base; }) || {}).rank || null;
    v.quoteRank = (pick(ranked, function (x) { return x.currency === sPair.quote; }) || {}).rank || null;
    const retail = sen.retail || {};
    v.retailLong = n(retail.longPct);
    v.retailShort = n(retail.shortPct);
    v.retailAccounts = n(retail.accounts);
    const risk = sen.risk || {};
    v.riskScore = n(risk.score);
    v.vix = n(risk.vix);
    v.vixPercentile = n(risk.vixPercentile);
    v.riskVolRatio = n(risk.volRatio);
    const inst = sen.institutional || {};
    v.instNet = inst.crowded ? n(inst.crowded.net) : null;
    v.instCount = arr(inst.list).length;
    const scope = sen.scope || {};
    v.scopeRealPairs = n(scope.realPairs);
    v.scopeSimPairs = n(scope.simulatedPairs);
    v.sentReal = !!(sen.real || scope.realSentiment);
    v.cotAsOf = scope.cotAsOf || (inst.asOf || null);
    v.sentSources = n(ctx.newsSources);
    v.sentSourceList = arr(sen.sources).length;

    /* --- confluence (verdetto) --- */
    const cf = ctx.confluence || {};
    v.confScore = n(cf.score);
    v.confConfidence = n(cf.confidence);
    v.confCount = n(cf.count);
    v.confAligned = n(cf.aligned);

    /* --- notizie, calendario, registro, classifica --- */
    v.newsCount = arr(ctx.news).length;
    v.newsFirstTitle = arr(ctx.news).length ? (arr(ctx.news)[0].title || null) : null;
    v.calCount = arr(ctx.calendar).length;
    v.calTime = arr(ctx.calendar).length ? n(arr(ctx.calendar)[0].time) : null;
    v.journalCount = arr(ctx.journal).length;
    v.journalOpen = arr(ctx.journal).filter(function (t) {
      return !t.outcome || t.outcome === 'open' || t.outcome === 'aperta';
    }).length;
    v.journalClosed = arr(ctx.journal).filter(function (t) {
      return t.outcome && t.outcome !== 'open' && t.outcome !== 'aperta';
    }).length;
    v.journalEntry = arr(ctx.journal).length ? n(arr(ctx.journal)[arr(ctx.journal).length - 1].entry) : null;
    const mk = arr(ctx.market);
    const sorted = mk.slice().sort(function (x, y) { return (y.score || 0) - (x.score || 0); });
    v.marketCount = sorted.length;
    v.marketTop = sorted.length ? n(sorted[0].score) : null;
    v.marketBottom = sorted.length ? n(sorted[sorted.length - 1].score) : null;
    const idx = sorted.findIndex(function (x) { return x.symbol === ctx.pair; });
    v.marketRank = idx >= 0 ? idx + 1 : null;
    v.marketScore = idx >= 0 ? n(sorted[idx].score) : null;
    v.marketTopBars = sorted.length ? n(sorted[0].candles ? sorted[0].candles.length : null) : null;

    /* --- conteggi degli elenchi mostrati a schermo --- */
    const shown = ctx.shown || {};
    v.shownOb = n(shown.ob);
    v.shownFvg = n(shown.fvg);
    v.shownLiq = n(shown.liq);
    v.shownDiv = n(shown.divergences);
    v.shownPivots = n(shown.pivots);
    v.shownNews = n(shown.news);
    v.shownCalendar = n(shown.calendar);
    v.shownWatchlist = n(shown.watchlist);
    v.shownJournal = n(shown.journal);

    /* --- serie di dati del ponte --- */
    v.infoBars = n(bar.bars);
    v.infoDropped = n(bar.dropped);

    /* --- pannello "Contesto di mercato": le cifre che disegna lui --- */
    const cx = ctx.context || {};
    v.ctxSessions = arr(cx.sessions);
    v.ctxHourUtc = n(cx.hourUtc);
    v.ctxVolRatio = n(cx.volRatio);
    v.ctxVolBars = n(cx.volBars);
    v.ctxRangeBars = n(cx.rangeBars);
    v.ctxRangeLow = n(cx.rangeLow);
    v.ctxRangeHigh = n(cx.rangeHigh);
    v.ctxRangePos = n(cx.rangePosition);
    v.ctxSpread = n(cx.spread);
    v.ctxAdx = n(cx.adx);

    /* --- orologio --- */
    v.now = Date.now();
    return v;
  }

  /* --------------------- A. letture dichiarate --------------------- */
  /* [etichetta, unita', lettura, selettore della card che la mostra] */

  read('ultima chiusura', 'price', function (v) { return v.price; }, '#lastPrice');
  read('variazione nell\'ultima candela', 'pct', function (v) { return v.change1; }, '#lastChange');
  read('variazione su 20 candele', 'pct', function (v) { return v.change20; }, '#dashPriceKpi');
  /* Il grafico mostra la candela in corso due volte: la disegna e la scrive nel
   * riquadro sotto il grafico (apertura, massimo, minimo, chiusura). */
  read('apertura dell\'ultima candela', 'price', function (v) { return v.open; }, '#ohlcReadout');
  read('massimo dell\'ultima candela', 'price', function (v) { return v.high; }, '#ohlcReadout');
  read('minimo dell\'ultima candela', 'price', function (v) { return v.low; }, '#ohlcReadout');
  read('chiusura dell\'ultima candela', 'price', function (v) { return v.close; }, '#ohlcReadout');
  read('candele in memoria', 'bar', function (v) { return v.bars; }, { sel: '#chart', shown: true });
  read('candele dichiarate dal ponte', 'bar', function (v) { return v.infoBars; });
  read('candele scartate dal ponte', 'bar', function (v) { return v.infoDropped; });

  /* La scala operativa della dashboard mette gli stessi livelli del piano su un
   * asse di prezzo: gli stessi valori, in due pannelli. */
  read('prezzo dell\'analisi', 'price', function (v) { return v.entry; }, ['#dashPriceKpi', '#dashLadder']);
  read('ATR per candela', 'price', function (v) { return v.atr; }, '#planAtr');
  read('ATR in percentuale', 'pct', function (v) { return v.atrPct; }, '#dashPriceKpi');
  read('obiettivo tecnico', 'price', function (v) { return v.target; }, ['#planTp', '#dashLadder']);
  read('stop tecnico', 'price', function (v) { return v.stop; }, ['#planSl', '#dashLadder']);
  read('rapporto rischio/obiettivo', 'ratio01', function (v) { return v.rr; }, { sel: '#planRr', dec: 2 });
  read('movimento atteso in pip', 'price', function (v) { return v.expectedPips; }, { sel: '#planExp', dec: 1 });
  read('movimento atteso in ATR', 'atr', function (v) { return v.expectedAtr; });
  read('obiettivo in pip dal prezzo', 'price', function (v) { return v.targetPips; });
  read('stop in pip dal prezzo', 'price', function (v) { return v.stopPips; });
  read('punteggio del motore tecnico', 'score', function (v) { return v.score; }, '#dashDials');
  read('confidenza del motore tecnico', 'ratio01', function (v) { return v.confidence; }, { sel: '#signalBadge', dec: 0, scale: 100 });
  read('probabilita rialzista', 'ratio01', function (v) { return v.probUp; }, { sel: '#fcSummary', dec: 1, scale: 100 });
  read('probabilita ribassista', 'ratio01', function (v) { return v.probDown; }, { sel: '#fcSummary', dec: 1, scale: 100 });
  read('orizzonte in candele', 'bar', function (v) { return v.horizon; });
  read('ADX', 'pct', function (v) { return v.adx; }, [
    { sel: '#contextList', dec: 1 }, { sel: '#trendBlock', dec: 1 }, { sel: '#trendBlockTech', dec: 1 }]);
  read('regime di trend', 'ratio01', function (v) { return v.trendRegime; });
  read('ATR di riferimento per la volatilita', 'price', function (v) { return v.atr; });
  /* Il pannello "Contesto di mercato": le stesse cifre che disegna lui, cosi'
   * la spiegazione descrive la finestra che si vede accanto. */
  read('volatilita rispetto alla media', 'ratio01', function (v) {
    return v.ctxVolRatio != null ? v.ctxVolRatio : v.volRatio;
  }, { sel: '#contextList', dec: 2 });
  read('candele del confronto di volatilita', 'bar', function (v) { return v.ctxVolBars; }, { sel: '#contextList', count: false, dec: 0 });
  read('barre del range del contesto', 'bar', function (v) { return v.ctxRangeBars; });
  read('massimo del range del contesto', 'price', function (v) { return v.ctxRangeHigh; }, '#contextList');
  read('minimo del range del contesto', 'price', function (v) { return v.ctxRangeLow; }, '#contextList');
  read('posizione nel range del contesto', 'pct', function (v) { return v.ctxRangePos; }, { sel: '#contextList', dec: 0 });
  read('volumi dell\'ultima candela', 'ratio01', function (v) { return v.volRatioLast; });
  read('massimo delle ultime 24 candele', 'price', function (v) { return v.hi24; });
  read('minimo delle ultime 24 candele', 'price', function (v) { return v.lo24; });
  read('posizione del prezzo nelle ultime 24 candele', 'pct', function (v) { return v.pos24; });
  read('medie calcolate', 'bar', function (v) { return v.medieCount; });
  read('medie sotto il prezzo', 'bar', function (v) { return v.aboveMedie; });

  read('RSI', 'pct', function (v) { return v.rsi; }, { sel: '#indTable', dec: 1 });
  read('istogramma MACD', 'atr', function (v) { return v.macdHist; }, { sel: '#indTable', dec: 2 });
  read('EMA 9', 'price', function (v) { return v.ema9; }, '#indTable');
  read('EMA 21', 'price', function (v) { return v.ema21; }, '#indTable');
  read('EMA 50', 'price', function (v) { return v.ema50; }, '#indTable');
  read('SMA 200', 'price', function (v) { return v.sma200; }, '#indTable');
  read('+DI', 'pct', function (v) { return v.plusDI; }, [
    { sel: '#trendBlock', dec: 1 }, { sel: '#trendBlockTech', dec: 1 }]);
  read('-DI', 'pct', function (v) { return v.minusDI; }, [
    { sel: '#trendBlock', dec: 1 }, { sel: '#trendBlockTech', dec: 1 }]);
  read('%K dello stochastic', 'pct', function (v) { return v.stochK; }, { sel: '#indTable', dec: 1 });
  read('%D dello stochastic', 'pct', function (v) { return v.stochD; }, { sel: '#indTable', dec: 1 });
  read('CCI', 'pct', function (v) { return v.cci; }, [
    { sel: '#trendBlock', dec: 1 }, { sel: '#trendBlockTech', dec: 1 }]);
  read('Choppiness', 'pct', function (v) { return v.choppiness; }, [
    { sel: '#trendBlock', dec: 1 }, { sel: '#trendBlockTech', dec: 1 }]);    read('Stochastic RSI', 'pct', function (v) { return v.stochRsi; }, [
      { sel: '#trendBlock', dec: 1 }, { sel: '#trendBlockTech', dec: 1 }]);
  /* La griglia di trend e inversione e' la stessa in due pannelli (sotto il
   * grafico e nella scheda di analisi tecnica): le letture valgono per entrambi. */
  const TREND = [
    { sel: '#trendBlock', dec: null }, { sel: '#trendBlockTech', dec: null }
  ];
  read('linea del SuperTrend', 'price', function (v) { return v.superTrendLine; }, TREND);
  read('direzione del SuperTrend', 'score', function (v) { return v.superTrendDir; });
  read('Parabolic SAR', 'price', function (v) { return v.psar; }, TREND);
  read('Aroon massimo recente', 'pct', function (v) { return v.aroonUp; }, [
    { sel: '#trendBlock', dec: 0 }, { sel: '#trendBlockTech', dec: 0 }]);
  read('Aroon minimo recente', 'pct', function (v) { return v.aroonDown; }, [
    { sel: '#trendBlock', dec: 0 }, { sel: '#trendBlockTech', dec: 0 }]);
  read('banda di Bollinger superiore', 'price', function (v) { return v.bbUpper; });
  read('banda di Bollinger inferiore', 'price', function (v) { return v.bbLower; });
  read('canale di Keltner superiore', 'price', function (v) { return v.keltnerUpper; }, TREND);
  read('canale di Keltner inferiore', 'price', function (v) { return v.keltnerLower; }, TREND);
  read('nuvola di Ichimoku, estremo alto', 'price', function (v) { return v.ichiTop; }, TREND);
  read('nuvola di Ichimoku, estremo basso', 'price', function (v) { return v.ichiBot; }, TREND);    read('regressione lineare', 'price', function (v) { return v.linreg; });
    read('%B di Bollinger', 'ratio01', function (v) { return v.percentB; });
    read('larghezza delle bande di Bollinger', 'pct', function (v) { return v.bandwidth; });
    read('variazione a 5 barre', 'pct', function (v) { return v.roc5; });
    read('variazione a 20 barre', 'pct', function (v) { return v.roc20; });
    read('pendenza della EMA 50 per barra', 'pct', function (v) { return v.slope50; });
    read('distanza dalla SMA 200 in ATR', 'atr', function (v) { return v.sma200DistAtr; });
    read('distanza dalla EMA 9 in ATR', 'atr', function (v) { return v.ema9DistAtr; });
    read('distanza dal Parabolic SAR in ATR', 'atr', function (v) { return v.psarDistAtr; });
    read('distanza dalla linea del SuperTrend in ATR', 'atr', function (v) { return v.superTrendDistAtr; });
    read('distanza dalla banda alta di Bollinger in ATR', 'atr', function (v) { return v.bbUpperDistAtr; });
    read('distanza dalla banda bassa di Bollinger in ATR', 'atr', function (v) { return v.bbLowerDistAtr; });

  /* La striscia non ha assi: il pannello e' il disegno, quindi queste letture
   * fanno parte del contratto ma non si confrontano con un testo. */
  const SPARK = { sel: '#dashSpark', shown: true };
  read('striscia: prima chiusura', 'price', function (v) { return v.sparkFrom; }, SPARK);
  read('striscia: ultima chiusura', 'price', function (v) { return v.sparkTo; }, SPARK);
  read('striscia: variazione', 'pct', function (v) { return v.sparkPct; }, SPARK);
  read('striscia: massimo', 'price', function (v) { return v.sparkHi; }, SPARK);
  read('striscia: minimo', 'price', function (v) { return v.sparkLo; }, SPARK);
  read('striscia: ampiezza', 'price', function (v) { return v.sparkWidth; }, SPARK);
  read('striscia: ampiezza in ATR', 'atr', function (v) { return div(v.sparkWidth, v.atr); }, SPARK);
  read('candele della striscia', 'bar', function (v) { return v.sparkBars; }, SPARK);

  read('punteggio SMC', 'score', function (v) { return v.smcScore; }, '#dashDials');
  read('confidenza SMC', 'ratio01', function (v) { return v.smcConfidence; });
  read('prezzo usato da SMC', 'price', function (v) { return v.smcPrice; });
  read('ATR usato da SMC', 'price', function (v) { return v.smcAtr; });
  read('minimo del range SMC', 'price', function (v) { return v.rangeLow; }, '#pdText');
  read('massimo del range SMC', 'price', function (v) { return v.rangeHigh; }, '#pdText');
  read('equilibrio del range SMC', 'price', function (v) { return v.rangeMid; });
  read('posizione del prezzo nel range SMC', 'pct', function (v) { return v.rangePos; }, { sel: '#pdText', dec: 0 });
  read('ingresso a mercato SMC', 'price', function (v) { return v.smcEntry; }, '#planEntry');
  read('ingresso limite SMC', 'price', function (v) { return v.smcLimit; }, '#smcLadder');
  read('stop SMC', 'price', function (v) { return v.smcStop; }, ['#smcLadder', '#dashLadder']);
  read('primo obiettivo SMC', 'price', function (v) { return v.smcTp1; }, '#dashLadder');
  read('secondo obiettivo SMC', 'price', function (v) { return v.smcTp2; }, ['#smcLadder', '#dashLadder']);
  read('prezzo del livello di liquidita', 'price', function (v) { return v.liqPrice; }, '#smcLadder');
  read('livelli uguali raggruppati', 'bar', function (v) { return v.liqMembers; });
  read('order block individuati', 'bar', function (v) { return v.obAll; });
  read('order block ancora validi', 'bar', function (v) { return v.obValid; });
  read('order block mai ritestati', 'bar', function (v) { return v.obFresh; });
  read('order block in elenco', 'bar', function (v) { return v.shownOb; }, { sel: '#obList li:not(.empty)', count: true });
  read('fair value gap individuati', 'bar', function (v) { return v.fvgAll; });
  read('fair value gap aperti', 'bar', function (v) { return v.fvgValid; });
  read('fair value gap in elenco', 'bar', function (v) { return v.shownFvg; }, { sel: '#fvgList li:not(.empty)', count: true });
  read('livelli di liquidita individuati', 'bar', function (v) { return v.liqAll; });
  read('livelli di liquidita intatti', 'bar', function (v) { return v.liqIntact; });
  read('livelli di liquidita in elenco', 'bar', function (v) { return v.shownLiq; }, { sel: '#liqList li:not(.empty)', count: true });
  read('indice dell\'ultimo evento di struttura', 'bar', function (v) { return v.evIndex; });
  read('livello dell\'ultimo evento di struttura', 'price', function (v) { return v.evLevel; });

  read('scambi simulati', 'bar', function (v) { return v.btCount; }, '#btStats');
  read('esiti positivi del backtest', 'pct', function (v) { return v.btWinPct; }, { sel: '#btStats', dec: 1 });
  read('guadagno medio', 'atr', function (v) { return v.btAvgWin; }, { sel: '#btStats', dec: 2 });
  read('perdita media', 'atr', function (v) { return v.btAvgLoss; }, { sel: '#btStats', dec: 2, neg: true });
  read('risultato medio per scambio', 'atr', function (v) { return v.btAvgR; }, { sel: '#btStats', dec: 3 });
  /* La curva del backtest e' la somma progressiva dei risultati: la disegna, non
   * la scrive. Nella card del backtest gli stessi valori sono anche in chiaro. */
  const EQUITY = { sel: '#equity', shown: true };
  read('risultato cumulato', 'atr', function (v) { return v.btTotalR; }, [{ sel: '#btStats', dec: 2 }, EQUITY]);
  read('discesa massima', 'atr', function (v) { return v.btDrawdown; }, [
    { sel: '#btStats', dec: 2, neg: true }, EQUITY]);
  read('media per scambio della curva', 'atr', function (v) { return v.btPerTrade; }, { sel: '#btStats', dec: 3 });
  read('profit factor del backtest', 'ratio01', function (v) { return v.btProfitFactor; }, { sel: '#btStats', dec: 2 });

  /* Divergenze, pivot ed efficacia sono lo stesso blocco in due pannelli: la
   * scheda sotto il grafico e quella di analisi tecnica. */
  const DIV = function (sel, opts) {
    const a = Object.assign({ sel: sel }, opts || {});
    const twin = Object.assign({}, a, { sel: sel.replace(/^#([\w-]+)/, '#$1Chart') });
    return [a, twin];
  };
  read('divergenze attive', 'bar', function (v) { return v.divCount; }, DIV('#divList li:not(.empty)', { count: true }));
  read('divergenze rialziste', 'bar', function (v) { return v.divBull; }, DIV('#divBlock', { dec: 0 }));
  read('divergenze ribassiste', 'bar', function (v) { return v.divBear; }, DIV('#divBlock', { dec: 0 }));
  read('candele per lato delle divergenze', 'bar', function (v) { return v.divLookback; }, DIV('#divScope', { dec: 0 }));
  read('prezzo di partenza della divergenza', 'price', function (v) { return v.divFrom; }, DIV('#divList'));
  read('prezzo di arrivo della divergenza', 'price', function (v) { return v.divTo; }, DIV('#divList'));
  read('eta della divergenza', 'bar', function (v) { return v.divAge; }, DIV('#divList'));
  read('casi misurati dallo studio', 'bar', function (v) { return v.studyCount; }, DIV('#divStudyScope', { dec: 0 }));
  read('finestra dello studio', 'bar', function (v) { return v.studyWindow; }, DIV('#divStudyScope', { dec: 0 }));
  read('orizzonte dello studio', 'bar', function (v) { return v.studyHorizon; }, DIV('#divStudyScope', { dec: 0 }));
  read('esiti a favore misurati', 'pct', function (v) { return v.studyHitPct; }, DIV('#divStudy', { dec: 0 }));
  read('rendimento medio misurato', 'atr', function (v) { return v.studyAvgR; }, DIV('#divStudy', { dec: 2 }));
  read('margine dello studio', 'atr', function (v) { return v.studyCi; }, DIV('#divStudy', { dec: 2 }));
  read('profit factor dello studio', 'ratio01', function (v) { return v.studyPf; }, DIV('#divStudy', { dec: 2 }));

  read('pivot centrale', 'price', function (v) { return v.pivot; }, DIV('#pivotGrid'));
  read('prima resistenza', 'price', function (v) { return v.r1; }, DIV('#pivotGrid'));
  read('seconda resistenza', 'price', function (v) { return v.r2; }, DIV('#pivotGrid'));
  read('terza resistenza', 'price', function (v) { return v.r3; }, DIV('#pivotGrid'));
  read('primo supporto', 'price', function (v) { return v.s1; }, DIV('#pivotGrid'));
  read('secondo supporto', 'price', function (v) { return v.s2; }, DIV('#pivotGrid'));
  read('terzo supporto', 'price', function (v) { return v.s3; }, DIV('#pivotGrid'));
  read('camarilla R3', 'price', function (v) { return v.camR3; });
  read('camarilla S3', 'price', function (v) { return v.camS3; });
  read('massimo del periodo dei pivot', 'price', function (v) { return v.pivotHigh; }, DIV('#pivotStamp'));
  read('minimo del periodo dei pivot', 'price', function (v) { return v.pivotLow; }, DIV('#pivotStamp'));
  read('scostamento dal pivot in pip', 'price', function (v) { return v.pivotPips; }, DIV('#divBlock', { dec: 1 }));
  read('pivot in griglia', 'bar', function (v) { return v.shownPivots; }, DIV('#pivotGrid .kpi', { count: true }));
  read('data del periodo dei pivot', 'date', function (v) { return v.pivotPeriod; }, DIV('#pivotStamp'));

  /* I livelli della proiezione sono dati: quante righe ci sono, tante ne
   * dichiara la tabella. Nessun caso scritto a mano. */
  for (let i = 0; i < 8; i++) {
    (function (idx) {
      const at = function (v, field) {
        const lv = v.levels[idx];
        return lv ? n(lv[field]) : null;
      };
      const lab = 'livello ' + (idx + 1) + ' della proiezione';
      read(lab + ': multiplo di ATR', 'atr', function (v) { return at(v, 'multiple'); }, { sel: '#fcLevels', dec: 1 });
      read(lab + ': probabilita verso l\'alto', 'ratio01', function (v) { return at(v, 'pUp'); }, { sel: '#fcLevels', dec: 0, scale: 100 });
      read(lab + ': prezzo verso l\'alto', 'price', function (v) { return at(v, 'up'); }, '#fcLevels');
      read(lab + ': probabilita verso il basso', 'ratio01', function (v) { return at(v, 'pDn'); }, { sel: '#fcLevels', dec: 0, scale: 100 });
      read(lab + ': prezzo verso il basso', 'price', function (v) { return at(v, 'down'); }, '#fcLevels');
    })(i);
  }

  read('punteggio sentiment', 'score', function (v) { return v.sentScore; }, '#dashDials');
  read('punteggio sentiment nel badge', 'score', function (v) { return v.sentScore; }, { sel: '#sentBadge', dec: 3 });
  read('confidenza sentiment', 'ratio01', function (v) { return v.sentConfidence; }, { sel: '#sentBadge', dec: 0, scale: 100 });
  read('lettura del sentiment', 'text', function (v) { return v.sentBias; }, '#sentBadge');
  read('forza della valuta piu forte', 'pct', function (v) { return v.strengthTopScore; }, { sel: '#strengthList', dec: 0 });
  read('forza della valuta piu debole', 'pct', function (v) { return v.strengthBottomScore; }, { sel: '#strengthList', dec: 0 });
  read('valute confrontate', 'bar', function (v) { return v.strengthCount; });
  read('posto della valuta base', 'bar', function (v) { return v.baseRank; });
  read('posto della valuta quotata', 'bar', function (v) { return v.quoteRank; });
  read('posizionamento retail lungo', 'pct', function (v) { return v.retailLong; }, { sel: '#retailLabel', dec: 0 });
  read('posizionamento retail corto', 'pct', function (v) { return v.retailShort; }, { sel: '#retailLabel', dec: 0 });
  read('conti retail stimati', 'bar', function (v) { return v.retailAccounts; });
  read('indice di propensione al rischio', 'pct', function (v) { return v.riskScore; }, { sel: '#riskList', dec: 0 });
  read('livello del VIX', 'pct', function (v) { return v.vix; }, { sel: '#riskList', dec: 1 });
  read('percentile del VIX', 'pct', function (v) { return v.vixPercentile; }, { sel: '#riskList', dec: 0 });
  read('volatilita dichiarata dal regime', 'ratio01', function (v) { return v.riskVolRatio; }, { sel: '#riskList', dec: 2 });
  read('posizionamento istituzionale piu affollato', 'pct', function (v) { return v.instNet; }, { sel: '#instList', dec: 0 });
  read('valute del posizionamento istituzionale', 'bar', function (v) { return v.instCount; });
  read('coppie con dati reali nel sentiment', 'bar', function (v) { return v.scopeRealPairs; });
  read('coppie simulate nel sentiment', 'bar', function (v) { return v.scopeSimPairs; });
  /* Con lo studio reale la spiegazione dichiara le coppie reali, con quello
   * simulato l'intero universo: la lettura segue la stessa regola. */
  read('coppie dichiarate dal sentiment', 'bar', function (v) {
    return v.sentReal ? v.scopeRealPairs : (n(v.scopeRealPairs) != null && n(v.scopeSimPairs) != null
      ? v.scopeRealPairs + v.scopeSimPairs : null);
  });
  read('data del report COT', 'date', function (v) { return v.cotAsOf; });
  read('fonti attive delle notizie', 'bar', function (v) { return v.sentSources; }, '#newsSourceNote');

  read('punteggio del verdetto', 'score', function (v) { return v.confScore; }, { sel: '#confVerdict', dec: 2 });
  read('confidenza del verdetto', 'ratio01', function (v) { return v.confConfidence; }, { sel: '#confVerdict', dec: 0, scale: 100 });
  read('modelli concordi', 'bar', function (v) { return v.confCount; }, '#confVerdict');

  read('titoli ricevuti', 'bar', function (v) { return v.newsCount; });
  read('titoli in elenco', 'bar', function (v) { return v.shownNews; }, { sel: '#newsList li', count: true });
  read('eventi in calendario', 'bar', function (v) { return v.calCount; }, { sel: '#calendarList li', count: true });
  /* La card dell'evento mostra titolo, impatto, data e conto alla rovescia:
   * l'orario si promette solo quando c'e' un evento da mostrare. */
  read('orario del primo evento', 'time', function (v) { return v.calTime; }, { sel: '#dashEvent', shown: true });
  read('eventi in elenco nel calendario', 'bar', function (v) { return v.shownCalendar; }, { sel: '#calendarList li', count: true });

  /* Il riepilogo del registro compare solo quando ci sono operazioni salvate. */
  read('operazioni registrate', 'bar', function (v) { return v.journalCount; }, { sel: '#journalSummary', shown: true });
  read('operazioni aperte', 'bar', function (v) { return v.journalOpen; });
  read('operazioni chiuse', 'bar', function (v) { return v.journalClosed; });
  read('righe in tabella nel registro', 'bar', function (v) { return v.shownJournal; }, { sel: '#journalBody tr:not(.empty-row)', count: true });
  read('ingresso dell\'ultima operazione', 'price', function (v) { return v.journalEntry; }, '#journalBody');

  read('strumenti in classifica', 'bar', function (v) { return v.marketCount; }, { sel: '#watchlist li', count: true });
  read('strumenti in elenco', 'bar', function (v) { return v.shownWatchlist; }, { sel: '#watchlist li', count: true });
  read('punteggio migliore della classifica', 'score', function (v) { return v.marketTop; }, { sel: '#watchlist', dec: 2 });
  read('punteggio peggiore della classifica', 'score', function (v) { return v.marketBottom; }, { sel: '#watchlist', dec: 2 });
  read('posto della coppia in classifica', 'bar', function (v) { return v.marketRank; });
  read('punteggio della coppia aperta', 'score', function (v) { return v.marketScore; }, { sel: '#watchlist', dec: 2 });
  read('candele per strumento della classifica', 'bar', function (v) { return v.marketTopBars; });

  read('ora corrente', 'time', function (v) { return v.now; });

  /* --------------------------- contratti derivati --------------------------- */
  /*
   * Che cosa ogni spiegazione promette di mostrare non e' un elenco scritto a
   * mano: si legge dal markup dell'app. Ogni card dichiara la chiave della
   * propria spiegazione con `data-help`, ogni lettura dichiara dove il pannello
   * la disegna, e il contratto di una spiegazione e' l'insieme delle letture i
   * cui selettori cadono dentro la sua card.
   *
   * Cosi' la promessa non puo' divergere dai pannelli: se un pannello comincia a
   * mostrare una grandezza, quella entra nel contratto da sola; se smette, esce.
   * E' la regola che distingue un numero giusto da un numero giusto *al posto
   * sbagliato*: se la spiegazione del prezzo citasse il valore della EMA 9, il
   * numero sarebbe comunque un dato, ma non quello che il pannello promette.
   */

  /** Le card che spiegano ogni chiave, lette dal markup. */
  function owners(doc) {
    const out = {};
    [].slice.call(doc.querySelectorAll('[data-help]')).forEach(function (el) {
      const k = el.getAttribute('data-help');
      if (!k) return;
      (out[k] = out[k] || []).push(el);
    });
    /* I grafici minori non hanno una card con data-help, ma un bottone accanto
     * al disegno: il loro pannello e' la riga che contiene il disegno e il
     * bottone (non tutta la card, che mostra anche altro). */
    const boxes = chartBoxes(doc);
    Object.keys(boxes).forEach(function (k) { if (!out[k]) out[k] = [boxes[k]]; });
    return out;
  }

  /** I riquadri dei grafici minori: la riga con il disegno e il suo bottone. */
  function chartBoxes(doc) {
    const out = {};
    [].slice.call(doc.querySelectorAll('[data-help-key]')).forEach(function (b) {
      const k = b.getAttribute('data-help-key');
      const row = k ? b.closest('.chart-help-row') : null;
      if (k && row) out[k] = row;
    });
    return out;
  }

  /** Il grafico minore a cui appartiene un elemento disegnato (striscia, curva).
   *  Si guardano solo i riquadri dei grafici: la card che li contiene e' piu'
   *  ampia e non dice a quale dei due disegni appartiene il valore. */
  function chartOwner(el, doc) {
    const boxes = chartBoxes(doc);
    const found = Object.keys(boxes).filter(function (k) { return boxes[k].contains(el); });
    return found.length ? found[0] : null;
  }

  /**
   * Il pannello sta mostrando qualcosa? Un valore disegnato (grafico, curva) o
   * scritto in una forma non numerica si promette solo se il pannello ha davvero
   * dei numeri sullo schermo: un pannello vuoto non promette niente.
   */
  function showing(el) {
    if (/(\d)/.test(el.textContent || '')) return true;
    const card = el.closest('[data-help]');
    return !!(card && /(\d)/.test(card.textContent || ''));
  }

  /**
   * I contratti: per ogni chiave, le letture che la sua card mostra. Un valore
   * mostrato in due pannelli appartiene al contratto di entrambi; un valore che
   * nessun pannello mostra non entra in nessun contratto (resta comunque
   * coperto dalla prima regola: non puo' essere inventato).
   */
  function contracts(doc) {
    const own = owners(doc);
    const out = {};
    Object.keys(own).forEach(function (k) { out[k] = []; });
    READS.forEach(function (r) {
      /* Le parole non si confrontano come numeri (hanno il loro confronto a
       * parte); date e orari entrano nel contratto, ma si verificano
       * confrontando gli istanti citati nel testo. */
      if (!r.card.length || r.unit === 'text') return;
      r.card.forEach(function (c) {
        const el = doc.querySelector(c.sel);
        if (!el) return;
        if (c.shown && !showing(el)) return;
        const card = el.closest('[data-help]');
        const key = chartOwner(el, doc) || (card ? card.getAttribute('data-help') : null);
        if (!key || !out[key]) return;
        if (out[key].indexOf(r.label) < 0) out[key].push(r.label);
      });
    });
    return out;
  }

  /* -------------------------- scritture ammesse -------------------------- */

  /** Un numero come lo scrive l'app: fixed, con lo zero negativo normalizzato. */
  function fmt(value, dec) {
    const s = Number(value).toFixed(dec);
    return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
  }

  /** Lo zero negativo non e' una quantita': -0.00 e 0.00 sono lo stesso
   *  numero, e la spiegazione puo' scriverlo in entrambe le forme. */
  function normZero(s) {
    return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
  }

  /**
   * Le forme legittime di un valore: il valore stesso, la sua percentuale (o la
   * sua frazione), il suo valore assoluto col segno, la distanza in pip.
   * Un valore citato senza segno corrisponde anche alla magnitudine: la card
   * scrive "−72,33 R" dove il dato e' 72.33.
   */
  function variants(value, unit, ctx) {
    const out = [value];
    if (unit === 'price') {
      const P = pip(ctx);
      if (P) out.push(value / P);
      out.push(value * 100);
    } else if (unit === 'pct' || unit === 'score' || unit === 'ratio01') {
      out.push(value * 100);
      out.push(value / 100);
    } else if (unit === 'atr') {
      /* nessuna trasformazione: i multipli di ATR sono gia' numeri puri */
    } else if (unit === 'bar' || unit === 'count') {
      /* idem */
    }
    out.push(Math.abs(value));
    out.push(-Math.abs(value));
    return out;
  }

  /** La tabella dei valori attesi: una voce per ogni lettura con un valore. */
  function table(ctx) {
    const v = view(ctx);
    const rows = [];
    READS.forEach(function (r) {
      if (r.unit === 'text') { rows.push({ label: r.label, text: r.get(v, ctx), card: r.card, unit: 'text' }); return; }
      if (r.unit === 'date') { rows.push({ label: r.label, text: r.get(v, ctx), card: r.card, unit: 'date' }); return; }
      const value = n(r.get(v, ctx));
      if (value == null) return;
      rows.push({ label: r.label, value: value, unit: r.unit, card: r.card });
    });
    return rows;
  }

  function pool(ctx) {
    const out = [];
    table(ctx).forEach(function (row) {
      if (row.value == null) return;
      variants(row.value, row.unit, ctx).forEach(function (x) {
        if (n(x) != null) out.push({ value: x, label: row.label, unit: row.unit });
      });
    });
    STRUCT.forEach(function (s) { out.push({ value: s.v, label: 'formula: ' + s.why, unit: 'struct' }); });
    return out;
  }

  /* --------------------------- numeri citati --------------------------- */

  const STAMP_RES = [
    /(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})/g,
    /(\d{4})-(\d{2})-(\d{2})/g,
    /(\d{2})\/(\d{2})\/(\d{4})/g,
    /(\d{2}):(\d{2}):(\d{2})/g,
    /(\d{1,2}):(\d{2})/g
  ];

  /**
   * Date e orari scritti in un testo. Vengono letti prima dei numeri, cosi'
   * "14/10/2026, 04:10:00" non diventa una fila di numeri sciolti, e tolti dal
   * testo perche' non devono essere confrontati come quantita'.
   */
  function stamps(text) {
    let t = String(text);
    const found = [];
    STAMP_RES.forEach(function (re) {
      t = t.replace(re, function (all, a, b, c, d, e, f) {
        found.push({ raw: all, kind: all.indexOf(',') >= 0 ? 'datetime'
          : all.indexOf('/') >= 0 ? 'local-date'
            : all.indexOf('-') >= 0 ? 'iso-date' : all.length <= 5 ? 'hhmm' : 'hms',
          parts: [a, b, c, d, e, f] });
        return ' ';
      });
    });
    return { stamps: found, rest: t };
  }

  /** Data e ora locale di un istante, nelle forme che l'app scrive. */
  function stampOf(ms) {
    const d = new Date(ms);
    const p2 = function (x) { return (x < 10 ? '0' : '') + x; };
    const local = {
      day: p2(d.getDate()), month: p2(d.getMonth() + 1), year: String(d.getFullYear()),
      hour: p2(d.getHours()), minute: p2(d.getMinutes()), second: p2(d.getSeconds())
    };
    const utcHour = p2(d.getUTCHours());
    return {
      local: local,
      text: local.day + '/' + local.month + '/' + local.year,
      iso: local.year + '-' + local.month + '-' + local.day,
      seconds: Number(local.hour) * 3600 + Number(local.minute) * 60 + Number(local.second),
      utcSeconds: Number(utcHour) * 3600 + Number(local.minute) * 60 + Number(local.second),
      utcTick: Number(utcHour) * 3600,          // come lo scrive il contesto: "UTC 10:00"
      ms: ms
    };
  }

  /** Tolleranza sugli orari: la spiegazione puo' essere stata rigenerata
   *  qualche secondo prima di essere letta. */
  const TIME_TOL = 90;

  /** L'istante (o la data) a cui corrisponde una riga della tabella. */
  function stampRow(r) {
    if (r.unit === 'time') return stampOf(n(r.value) != null ? r.value : r.text);
    const parts = String(r.text || '').split('-');
    return parts.length === 3 ? { iso: r.text, local: { day: parts[2], month: parts[1], year: parts[0] },
      seconds: null, utcSeconds: null, text: parts[2] + '/' + parts[1] + '/' + parts[0] } : null;
  }

  function stampMatches(written, allowed) {
    return allowed.some(function (st) {
      if (!st) return false;
      const p = written.parts;
      const hasDate = written.kind === 'datetime' || written.kind === 'local-date';
      if (hasDate) {
        if (p[0] !== st.local.day || p[1] !== st.local.month || p[2] !== st.local.year) return false;
        if (written.kind !== 'datetime') return true;
        const secs = Number(p[3]) * 3600 + Number(p[4]) * 60 + Number(p[5]);
        return Math.abs(secs - st.seconds) <= TIME_TOL;
      }
      if (written.kind === 'iso-date') return st.iso === written.raw;
      /* sola ora: hh:mm:ss o hh:mm, locale oppure UTC */
      const secs = Number(p[0]) * 3600 + Number(p[1]) * 60 + (written.kind === 'hms' ? Number(p[2]) : 0);
      return Math.abs(secs - st.seconds) <= TIME_TOL ||
        Math.abs(secs - st.utcSeconds) <= TIME_TOL ||
        (n(st.utcTick) != null && Math.abs(secs - st.utcTick) <= TIME_TOL);
    });
  }

  /** I numeri scritti in un testo, con la precisione con cui sono scritti. */
  function cited(text) {
    const split = stamps(text);
    const clean = split.rest
      .replace(/[\u2212\u2013\u2014]/g, '-')   // meno tipografico e trattini
      .replace(/[\u00a0\u202f]/g, ' ');        // spazi unificatori
    /* L'app scrive i numeri con il punto (toFixed): una virgola separa voci
     * diverse, come le sigle "(14,3)" dello Stochastic, non i decimali. */
    const numbers = [];
    const re = /-?\d+(?:\.\d+)?/g;
    let m;
    while ((m = re.exec(clean))) {
      const raw = m[0];
      const dot = raw.indexOf('.');
      const dec = dot < 0 ? 0 : raw.length - dot - 1;
      numbers.push({ raw: raw, text: raw, value: Number(raw), dec: dec });
    }
    return { numbers: numbers, stamps: split.stamps };
  }

  /**
   * Il controllo di una spiegazione contro i dati.
   * @param {Array} contract le letture che quella spiegazione promette (derivate
   *   dai pannelli: vedi `contracts`).
   * @returns {Object} {ok, key, cited, resolved, unresolved, stamps, unresolvedStamps, pool}
   */
  function check(key, ctx, text, contract) {
    const rows = table(ctx);
    const values = pool(ctx);
    const got = cited(text);
    const unresolved = [];
    let resolved = 0;
    /* Quali letture la spiegazione ha davvero citato, e con quale numero. */
    const matched = {};
    const numeric = rows.filter(function (r) { return r.value != null; });
    got.numbers.forEach(function (c) {
      const want = normZero(c.text);
      const hits = values.filter(function (p) { return fmt(p.value, c.dec) === want; });
      if (hits.length) resolved++; else unresolved.push(c);
      numeric.forEach(function (r) {
        variants(r.value, r.unit, ctx).some(function (x) {
          if (n(x) == null) return false;
          if (fmt(x, c.dec) !== want) return false;
          matched[r.label] = true;
          return true;
        });
      });
    });
    /* Un istante e' il valore di una riga di tipo "time", una data quello di
     * una riga di tipo "date": il testo delle spiegazioni puo' scriverli in
     * piu' formati (locale, UTC, ISO) e devono corrispondere tutti ai dati. */
    const allowedStamps = rows.filter(function (r) {
      return r.unit === 'time' || r.unit === 'date';
    }).map(stampRow).filter(Boolean);
    const unresolvedStamps = got.stamps.filter(function (s) { return !stampMatches(s, allowedStamps); });
    /* Il contratto: le grandezze che questa spiegazione promette di mostrare,
     * derivate dai pannelli che le disegnano. Un istante o una data si
     * promettono come i numeri: la spiegazione deve citarne uno che corrisponde
     * al dato. Una lettura senza valore in quel momento (assente) non viene
     * pretesa. */
    const wanted = arr(contract);
    /* Le promesse che hanno davvero un valore in questo momento: sono quelle che
     * la spiegazione deve citare. Se il dato non c'e', la promessa tace. */
    const live = wanted.filter(function (label) {
      const row = rows.filter(function (r) { return r.label === label; })[0];
      if (!row) return false;
      if (row.unit === 'time' || row.unit === 'date') return !!stampRow(row);
      return row.value != null;
    });
    const missing = wanted.filter(function (label) {
      const row = rows.filter(function (r) { return r.label === label; })[0];
      if (!row) return false;
      if (row.unit === 'time' || row.unit === 'date') {
        const st = stampRow(row);
        if (!st) return false;
        return !got.stamps.some(function (s) { return stampMatches(s, [st]); });
      }
      return row.value != null && !matched[label];
    });
    return {
      key: key, ok: !unresolved.length && !unresolvedStamps.length && !missing.length,
      cited: got.numbers.length, resolved: resolved, values: values.length,
      unresolved: unresolved, unresolvedStamps: unresolvedStamps, missing: missing,
      stamps: got.stamps, contract: wanted.length, promised: live.length
    };
  }

  /**
   * Le righe che la card deve mostrare: solo le letture con un selettore, una
   * riga per pannello che le disegna. Il valore atteso viene dai dati, non dal
   * testo della spiegazione.
   */
  function cardRows(ctx) {
    const rows = [];
    table(ctx).forEach(function (r) {
      if (!r.card.length || r.value == null) return;
      r.card.forEach(function (c) {
        if (c.shown) return;               // disegnato o non numerico: niente testo da confrontare
        const value = r.value * c.scale;
        rows.push({
          label: r.label, value: c.neg ? -Math.abs(value) : value, unit: r.unit,
          selector: c.sel, count: c.count, tol: c.count ? 0 : tolerance(r.unit, ctx, c.dec)
        });
      });
    });
    return rows;
  }

  /** Quanto puo' differire il numero scritto nella card dal dato. */
  function tolerance(unit, ctx, dec) {
    if (dec != null) return 0.51 * Math.pow(10, -dec);
    if (unit === 'price' || unit === 'atr') return 0.5 * Math.pow(10, -digits(ctx)) + 1e-9;
    if (unit === 'pct' || unit === 'ratio01') return 0.11;
    if (unit === 'score') return 0.011;
    return 0.51;                                   // conteggi
  }

  /* ---------------------------- lettura del DOM ---------------------------- */

  /**
   * Il testo della sola sezione «In questo momento» di una finestra di aiuto:
   * le sezioni generali contengono i numeri della formula (61,8%, 38) e non
   * sono dati del momento.
   */
  function nowText(body) {
    if (!body) return '';
    const kids = [].slice.call(body.children);
    const at = kids.findIndex(function (el) { return /In questo momento/.test(el.textContent); });
    if (at < 0) return '';
    return kids.slice(at + 1).map(function (el) { return el.textContent; }).join(' . ');
  }

  /**
   * I numeri scritti in un elemento. Si legge l'HTML togliendo i tag perche' i
   * valori stanno in celle diverse: con il solo testo "R1" e "1.0874" si
   * fonderebbero in "R11.0874". Il meno tipografico diventa un meno normale.
   */
  function domNumbers(el) {
    if (!el) return null;
    return (String(el.innerHTML).replace(/<[^>]*>/g, ' ')
      .replace(/[\u2212\u2013\u2014]/g, '-').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  }

  /**
   * Confronta le righe della tabella con la pagina: restituisce gli scarti e i
   * selettori assenti. `doc` e' il documento dell'app (quello dell'iframe).
   */
  function compareCards(ctx, doc) {
    const bad = [], missing = [];
    cardRows(ctx).forEach(function (row) {
      if (row.count) {
        /* Per i conteggi il selettore sono le voci; se il contenitore non
         * esiste affatto parliamo di un collegamento mancante, non di una
         * lista vuota. */
        const container = String(row.selector).split(/[\s>]/)[0];
        if (!doc.querySelector(container)) { missing.push(container); return; }
        const visible = doc.querySelectorAll(row.selector).length;
        if (visible !== row.value) bad.push(row.label + ': ' + row.value + ' dichiarate, ' + visible + ' visibili');
        return;
      }
      const el = doc.querySelector(row.selector);
      const ns = domNumbers(el);
      if (ns === null) { missing.push(row.selector); return; }
      if (!ns.some(function (x) { return Math.abs(x - row.value) <= row.tol; })) {
        bad.push(row.label + ' = ' + row.value + ' non in ' + row.selector);
      }
    });
    return { checked: cardRows(ctx).length, bad: bad, missing: missing };
  }

  /** La tabella in forma stampabile, per il referto dei test. */
  function render(ctx) {
    const rows = table(ctx);
    const width = Math.max.apply(null, rows.map(function (r) { return r.label.length; })) || 0;
    return rows.map(function (r) {
      const val = r.value != null ? String(r.value) : String(r.text);
      const where = r.card.length ? r.card.map(function (c) {
        return c.shown ? c.sel + ' (mostrato)' : c.sel;
      }).join(' + ') : (r.unit === 'text' ? 'testo' : '-');
      return (r.label + new Array(Math.max(1, width - r.label.length + 2)).join(' ')) +
        val + '   ' + where;
    }).join('\n');
  }

  root.ExpectedValues = {
    build: function (ctx) { return { rows: table(ctx), values: pool(ctx) }; },
    table: table,
    pool: pool,
    view: view,
    check: check,
    owners: owners,
    contracts: contracts,
    cardRows: cardRows,
    nowText: nowText,
    domNumbers: domNumbers,
    compareCards: compareCards,
    cited: cited,
    render: render,
    STRUCT: STRUCT,
    READS: READS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.ExpectedValues;
})(typeof window !== 'undefined' ? window : this);
