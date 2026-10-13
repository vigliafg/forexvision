/* =========================================================================
 * help.js - Ogni card spiega se stessa
 * -------------------------------------------------------------------------
 * Registro delle spiegazioni mostrate dalla finestra di aiuto. Per ciascuna
 * card (e per ciascun grafico) ci sono tre parti:
 *
 *   1. general  - che cosa mostra la card, in generale e senza numeri;
 *   2. reading  - come si legge quello che c'e' dentro, quale valore e'
 *                 normale e quale invece merita attenzione;
 *   3. now(ctx) - i dati presenti in quel momento: legge lo stato corrente
 *                 dell'app e restituisce le righe da mostrare. Ogni riga e'
 *                 calcolata adesso, quindi la spiegazione non invecchia.
 *
 * Le funzioni `now` sono difensive: se un dato non e' ancora calcolato (prima
 * analisi, ponte non raggiungibile) la riga viene omessa invece di stampare
 * "undefined" o andare in errore.
 *
 * Il testo viene reso con le stesse classi del report divulgativo (rep-h2,
 * rep-p, rep-ul, rep-callout), cosi' la finestra di aiuto ha la stessa
 * leggibilita' del report senza duplicare il foglio di stile.
 * ========================================================================= */
(function (global) {
  'use strict';

  /* ------------------------------ utilità ------------------------------ */

  function n(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  function digits(ctx) { return ctx && ctx.digits != null ? ctx.digits : 5; }

  /** Prezzo con i decimali dello strumento, oppure null se assente. */
  function px(v, ctx) {
    const d = n(v);
    return d == null ? null : d.toFixed(digits(ctx));
  }

  /** Numero con segno esplicito: +1,20 / -0,35. */
  function sg(v, dec) {
    const d = n(v);
    if (d == null) return null;
    return (d >= 0 ? '+' : '') + d.toFixed(dec == null ? 2 : dec);
  }

  /**
   * Perdita media e discesa dal picco: il backtest le calcola come magnitudini,
   * la card le mostra col segno meno. Qui si presentano allo stesso modo,
   * altrimenti la spiegazione direbbe "+72,3 R" dove la card dice
   * "\u221272,33 R".
   */
  function neg(v, dec) {
    const d = n(v);
    if (d == null) return null;
    return '-' + Math.abs(d).toFixed(dec == null ? 2 : dec);
  }

  /** Percentuale: 62,4%. */
  function pc(v, dec) {
    const d = n(v);
    if (d == null) return null;
    return (d * 100).toFixed(dec == null ? 0 : dec) + '%';
  }

  /** Differenza in pip fra due prezzi. */
  function pip(a, b, ctx) {
    const x = n(a), y = n(b);
    if (x == null || y == null || !ctx || !ctx.inst) return null;
    const size = ctx.inst.pip || 0.0001;
    return ((x - y) / size);
  }

  function arr(v) { return Array.isArray(v) ? v : []; }

  /** Ultimo valore non nullo di una serie di indicatori. */
  function last(arrLike) {
    const a = arr(arrLike);
    for (let i = a.length - 1; i >= 0; i--) if (n(a[i]) != null) return a[i];
    return null;
  }

  function valAt(arrLike, i) {
    const a = arr(arrLike);
    if (n(i) == null || i < 0 || i >= a.length) return null;
    return n(a[i]);
  }

  function up(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /** Differenza di prezzo espressa in pip. */
  function pips(v, ctx) {
    const d = n(v);
    if (d == null || !ctx || !ctx.inst) return null;
    return d / (ctx.inst.pip || 0.0001);
  }

  /**
   * Direzione in parole, con le stesse etichette mostrate dall'interfaccia.
   * I moduli non usano la stessa convenzione: il motore tecnico parla di
   * BUY/SELL/NEUTRAL, lo studio SMC usa 1 / -1 (o LONG / SHORT). Qui si
   * traduce tutto nel vocabolario del verdetto.
   */
  function dirLabel(d) {
    if (d === 'BUY' || d === 'LONG' || d === 1) return 'ACQUISTO';
    if (d === 'SELL' || d === 'SHORT' || d === -1) return 'VENDITA';
    if (d === 'NEUTRAL' || d === 'NEUTRO' || d === 0) return 'NEUTRO';
    return d == null ? 'n.d.' : String(d);
  }

  /**
   * Regime di trend in parole. Il motore lo calcola come numero da 0 (laterale)
   * a 1 (direzionale) e la card lo traduce con le stesse soglie: qui si usano
   * gli stessi valori, cosi' la spiegazione e la card non possono divergere.
   */
  function regimeLabel(r) {
    const v = n(r);
    if (v != null) return v > 0.6 ? 'tendenza' : v < 0.3 ? 'laterale' : 'misto';
    if (r === 'trend') return 'tendenza';
    if (r === 'range') return 'laterale';
    return r ? String(r) : null;
  }

  /** Le sessioni di contrattazione aperte a una certa ora UTC. */
  function sessionsAt(h) {
    const out = [];
    if (h >= 21 || h < 6) out.push('Sydney');
    if (h >= 0 && h < 9) out.push('Tokyo');
    if (h >= 7 && h < 16) out.push('Londra');
    if (h >= 12 && h < 21) out.push('New York');
    return out;
  }

  /** Quanti elementi mostra un pannello adesso (fornito dall'app che li disegna). */
  function shown(ctx, name) {
    const s = ctx && ctx.shown;
    const v = s ? n(s[name]) : null;
    return v == null ? null : v;
  }

  /**
   * Le righe della griglia di trend e inversione. La griglia e' la stessa sotto
   * il grafico (scheda Grafici) e nella scheda di analisi tecnica: le due
   * spiegazioni mostrano lo stesso pannello, quindi citano le stesse letture.
   * Scritte una volta sola, non possono divergere fra loro.
   */
  function trendGridLines(ctx) {
    const out = [];
    const a = ctx.analysis;
    if (!a || !a.indicators) return ['Indicatori non ancora calcolati.'];
    const ind = a.indicators;

    // 1. SuperTrend: linea e direzione sono serie, servono i loro ultimi valori
    const st = ind.superTrend;
    const stLine = st ? last(st.line) : null;
    const stDir = st ? last(st.dir) : null;
    if (n(stDir) != null) {
      out.push('SuperTrend: ' + (stDir > 0 ? 'rialzista' : 'ribassista') +
        (px(stLine, ctx) ? ', linea a ' + px(stLine, ctx) : '') + '.');
    }

    // 2. Parabolic SAR
    const ps = last(ind.psar);
    if (n(ps) != null) {
      out.push('Parabolic SAR ' + px(ps, ctx) + ': ' + (ps < ctx.price
        ? 'punti sotto il prezzo, lettura rialzista' : 'punti sopra il prezzo, lettura ribassista') + '.');
    }

    // 3. Ichimoku: il bordo alto e quello basso della nuvola
    if (ind.ichimoku && n(last(ind.ichimoku.spanA)) != null && n(last(ind.ichimoku.spanB)) != null) {
      const top = Math.max(last(ind.ichimoku.spanA), last(ind.ichimoku.spanB));
      const bot = Math.min(last(ind.ichimoku.spanA), last(ind.ichimoku.spanB));
      out.push('Prezzo ' + (ctx.price > top ? 'sopra' : ctx.price < bot ? 'sotto' : 'dentro') +
        ' la nuvola di Ichimoku (fra ' + px(bot, ctx) + ' e ' + px(top, ctx) + ').');
    }

    // 4. DMI: +DI contro -DI
    if (n(last(ind.plusDI)) != null && n(last(ind.minusDI)) != null) {
      out.push('DMI: +DI ' + last(ind.plusDI).toFixed(1) + ' contro -DI ' + last(ind.minusDI).toFixed(1) +
        ' (' + (last(ind.plusDI) > last(ind.minusDI) ? 'prevalenza di acquisti' : 'prevalenza di vendite') + ').');
    }

    // 5. ADX e Choppiness: quanto la tendenza e' definita
    const adx = last(ind.adx);
    if (n(adx) != null) {
      out.push('ADX ' + adx.toFixed(1) + ': ' + (adx >= 25 ? 'tendenza definita'
        : adx >= 20 ? 'tendenza debole' : 'nessuna tendenza chiara') + '.');
    }
    const ch = last(ind.choppiness);
    if (n(ch) != null) {
      out.push('Choppiness ' + ch.toFixed(1) + ': ' + (ch > 62 ? 'mercato laterale'
        : ch < 38 ? 'mercato in tendenza' : 'zona intermedia') + '.');
    }

    // 6. Aroon: da quante barre il massimo e il minimo sono recenti
    const upVal = last(ind.aroon && ind.aroon.up);
    const downVal = last(ind.aroon && ind.aroon.down);
    if (n(upVal) != null || n(downVal) != null) {
      out.push('Aroon: massimo recente ' + (n(upVal) != null ? upVal.toFixed(0) : 'n.d.') +
        '%, minimo recente ' + (n(downVal) != null ? downVal.toFixed(0) : 'n.d.') + '%.');
    }

    // 7. CCI
    const cci = last(ind.cci);
    if (n(cci) != null) {
      out.push('CCI ' + cci.toFixed(1) + ': ' + (cci > 100 ? 'sopra la soglia di ipercomprato'
        : cci < -100 ? 'sotto la soglia di ipervenduto' : 'in area neutra') + '.');
    }

    // 8. Stochastic RSI
    const sk = last(ind.stochRsi && ind.stochRsi.k);
    if (n(sk) != null) {
      out.push('Stochastic RSI ' + sk.toFixed(1) + ': ' + (sk >= 80 ? 'zona di ipercomprato'
        : sk <= 20 ? 'zona di ipervenduto' : 'nessun estremo') + '.');
    }

    // 9. Keltner: i due bordi del canale e lo squeeze con Bollinger
    if (ind.keltner && n(last(ind.keltner.upper)) != null) {
      const ku = last(ind.keltner.upper), kl = last(ind.keltner.lower);
      const squeeze = ind.bb && n(last(ind.bb.upper)) != null &&
        ku < last(ind.bb.upper) && kl > last(ind.bb.lower);
      out.push('Keltner (20 \u00b7 2 ATR): canale ' + px(kl, ctx) + ' - ' + px(ku, ctx) + ' \u00b7 ' + (squeeze
        ? 'compressione in corso (squeeze): la volatilita\u0300 e\u0300 pronta a espandersi.'
        : 'nessuna compressione: la volatilita\u0300 e\u0300 gia\u0300 espansa.'));
    }

    return out;
  }

  /* --------------------------- contenuto delle card --------------------------- */
  /* Ogni voce: {title, general: [], reading: [], now: function(ctx) -> []} */

  const EXPLAIN = {};

  /* ---------------------------- DASHBOARD ---------------------------- */

  EXPLAIN.dashVerdict = {
    title: 'Tre modelli a confronto',
    general: [
      'La card mette fianco a fianco i tre studi indipendenti dell\'applicazione: il motore tecnico (indicatori classici e di tendenza), lo studio SMC (struttura di mercato, order block, liquidita\u0300) e lo studio del sentiment (forza delle valute, posizionamento, regime di rischio).',
      'Ognuno produce un punteggio nella stessa scala da -1 (ribasso pieno) a +1 (rialzo pieno). Il verdetto in basso non e\u0300 la media dei tre: pesa solo i modelli che in quel momento hanno un universo dati completo, e dichiara esplicitamente quelli che restano fuori.'
    ],
    reading: [
      'I tre quadranti sono indicatori sintetici: l\'ago al centro significa neutralita\u0300, verso i bordi un\'inclinazione piu\u0300 marcata.',
      'Il numero sotto il verdetto (ad esempio "2/3 modelli concordi") conta quanti studi vanno nella stessa direzione: due o tre modelli d\'accordo valgono piu\u0300 di un punteggio alto ma isolato.',
      'Un modello escluso (in grigio, con il motivo scritto sotto) non e\u0300 un errore: e\u0300 un modello che su questi dati non aggiungerebbe informazione indipendente. Il verdetto senza di lui resta valido.'
    ],
    now: function (ctx) {
      const out = [];
      const cf = ctx.confluence;
      const comps = [
        ['Motore tecnico', ctx.analysis && ctx.analysis.score, ctx.analysis && ctx.analysis.direction, ctx.analysis && ctx.analysis.confidence],
        ['Studio SMC', ctx.smc && ctx.smc.score, ctx.smc && ctx.smc.direction, ctx.smc && ctx.smc.confidence],
        ['Sentiment', ctx.sentiment && ctx.sentiment.score, ctx.sentiment && ctx.sentiment.direction, ctx.sentiment && ctx.sentiment.confidence]
      ];
      comps.forEach(function (c) {
        const sc = n(c[1]);
        if (sc == null) { out.push(c[0] + ': non ancora calcolato.'); return; }
        out.push(c[0] + ': punteggio ' + sg(sc, 2) + ' (' + dirLabel(c[2]) + ')' +
          (n(c[3]) != null ? ', confidenza ' + pc(c[3]) : '') + '.');
      });
      if (cf) {
        out.push('Verdetto complessivo: ' + dirLabel(cf.direction) + ' con ' +
          (cf.count != null ? cf.count + ' modello/i concordi' : 'confluenza parziale') +
          (n(cf.confidence) != null ? ' e confidenza ' + pc(cf.confidence) : '') +
          (n(cf.score) != null ? ' (punteggio combinato ' + sg(cf.score, 3) + ')' : '') + '.');
        if (arr(cf.excluded).length) {
          out.push({ callout: true, tone: 'flat', text: 'Esclusi dal verdetto: ' + arr(cf.excluded).join(', ') + '. ' + (cf.excludedReason || '') });
        }
      }
      return out;
    }
  };

  EXPLAIN.dashPrice = {
    title: 'Prezzo e moto recente',
    general: [
      'La striscia e\u0300 una mini-serie delle ultime 40 chiusure: serve a vedere a colpo d\'occhio la direzione del tratto piu\u0300 recente, senza aprire il grafico grande.',
      'I quattro riquadri sotto riassumono prezzo, variazione sulle ultime 20 candele, volatilita\u0300 in percentuale (ATR%) e regime di mercato riconosciuto dal motore.'
    ],
    reading: [
      'La variazione a 20 candele dice quanto si e\u0300 mosso il prezzo in poco tempo: un valore molto piu\u0300 grande del solito ATR segnala movimento rapido, non necessariamente destinato a durare.',
      'ATR% e\u0300 la volatilita\u0300 media per candela in percentuale del prezzo: sotto l\'1% il mercato e\u0300 tranquillo, sopra il 2% i movimenti sono ampi e gli stop troppo stretti vengono colpiti.',
      'Il regime distingue una tendenza da un mercato laterale: lo stesso segnale vale molto di piu\u0300 in tendenza.'
    ],
    now: function (ctx) {
      const out = [];
      const a = ctx.analysis;
      if (!a) return ['Analisi non ancora disponibile.'];
      const c = n(ctx.price);
      out.push('Ultima chiusura: ' + (px(c, ctx) || 'n.d.') + ' su ' + ctx.pair + ' (' + ctx.tfLabel + ').');
      const candles = arr(ctx.series && ctx.series.candles);
      if (candles.length > 20) {
        const ref = candles[candles.length - 21].close;
        if (n(ref)) out.push('Variazione sulle ultime 20 candele: ' + sg((c - ref) / ref * 100, 2) + '%.');
      }
      out.push('Volatilita\u0300: ATR ' + (px(a.atr, ctx) || 'n.d.') + ' per candela, pari al ' + (n(a.atrPct) != null ? a.atrPct.toFixed(2) : 'n.d.') + '% del prezzo.');
      if (regimeLabel(a.trendRegime)) out.push('Regime riconosciuto: ' + regimeLabel(a.trendRegime) + '.');
      return out;
    }
  };

  EXPLAIN.dashLadder = {
    title: 'Scala operativa',
    general: [
      'La scala orizzontale mette sullo stesso asse i livelli che contano per un\'operazione: prezzo attuale, stop e obiettivi, presi dal piano del motore tecnico e da quello SMC.',
      'Serve a vedere la distanza fra i livelli e a giudicare se il rapporto fra rischio e obiettivo e\u0300 accettabile prima di aprire qualunque cosa.'
    ],
    reading: [
      'Il segno bianco e\u0300 il prezzo di riferimento; i pallini verdi sono gli obiettivi, quello rosso lo stop.',
      'Piu\u0300 sono distanti i livelli, piu\u0300 l\'operazione chiede tempo e volatilita\u0300: con un ATR piccolo un obiettivo a 3 ATR puo\u0300 richiedere molte candele.',
      'Se lo stop del piano tecnico e quello SMC cadono vicini, il livello e\u0300 piu\u0300 robusto: due letture indipendenti indicano la stessa zona di invalidazione.'
    ],
    now: function (ctx) {
      const out = [];
      const a = ctx.analysis, s = ctx.smc;
      if (!a) return ['Piano non ancora disponibile.'];
      out.push('Prezzo di riferimento: ' + (px(a.price, ctx) || 'n.d.') + '.');
      if (px(a.target, ctx)) out.push('Obiettivo tecnico: ' + px(a.target, ctx) + ' (' + sg(pip(a.target, a.price, ctx), 1) + ' pip dal prezzo).');
      if (px(a.stop, ctx)) out.push('Stop tecnico: ' + px(a.stop, ctx) + ' (' + sg(pip(a.stop, a.price, ctx), 1) + ' pip dal prezzo).');
      if (n(a.rr) != null) out.push('Rapporto rischio/obiettivo: ' + a.rr.toFixed(2) + ' a 1.');
      if (s && s.plan) {
        const p = s.plan;
        const bits = [];
        if (px(p.marketEntry, ctx)) bits.push('ingresso a mercato ' + px(p.marketEntry, ctx));
        if (px(p.limitEntry, ctx)) bits.push('ingresso limite ' + px(p.limitEntry, ctx));
        if (px(p.stop, ctx)) bits.push('stop ' + px(p.stop, ctx));
        if (px(p.tp1, ctx)) bits.push('primo obiettivo ' + px(p.tp1, ctx));
        if (bits.length) out.push('Piano SMC: ' + bits.join(', ') + '.');
        if (s.plan.targetLiquidity) {
          out.push('Obiettivo naturale del movimento: ' + px(s.plan.targetLiquidity.price, ctx) +
            ' (' + s.plan.targetLiquidity.members + ' livelli di liquidita\u0300 uguali).');
        }
      }
      return out;
    }
  };

  EXPLAIN.dashEvent = {
    title: 'Prossimo evento ad alto impatto',
    general: [
      'Mostra il prossimo appuntamento del calendario economico che puo\u0300 muovere EUR/USD: comunicati su tassi, inflazione e occupazione dei paesi le cui valute formano la coppia.',
      'Il conto alla rovescia serve a decidere se e\u0300 il caso di aprire un\'operazione adesso o di aspettare che il dato sia uscito.'
    ],
    reading: [
      'Un evento ad alto impatto puo\u0300 produrre uno scatto di decine di pip in pochi secondi: gli stop vicini al prezzo vengono colpiti anche se la direzione generale resta corretta.',
      'Dopo l\'uscita del dato la volatilita\u0300 resta alta per qualche minuto: e\u0300 il momento in cui lo spread si allarga e i segnali sono meno affidabili.'
    ],
    now: function (ctx) {
      const out = [];
      const cal = arr(ctx.calendar);
      if (!cal.length) {
        out.push('Nessun evento pertinente in calendario per questa settimana: il pannello lo dichiara invece di inventare una voce.');
        return out;
      }
      const next = cal[0];
      out.push('Prossimo evento: ' + (next.title || 'n.d.') + (next.country ? ' (' + next.country + ')' : '') +
        (next.impact ? ' \u00b7 impatto ' + next.impact : '') + '.');
      if (next.time) out.push('Orario previsto: ' + new Date(next.time).toLocaleString('it-IT') + '.');
      out.push('Eventi in calendario per questa settimana: ' + cal.length + '.');
      return out;
    }
  };

  EXPLAIN.dashWatchlist = {
    title: 'Watchlist',
    general: [
      'I 14 strumenti seguiti dall\'applicazione (major, cross e metalli), ordinati per punteggio del motore tecnico.',
      'Serve a rispondere a una domanda semplice: dove il quadro e\u0300 piu\u0300 chiaro in questo momento?'
    ],
    reading: [
      'Il punteggio e\u0300 lo stesso score del motore tecnico, da -1 a +1: vicino a zero significa nessuna inclinazione, non "sicuro".',
      'Con i dati reali attivi solo EUR/USD usa prezzi veri: le altre coppie portano l\'etichetta sim e vanno lette come scenario, non come mercato.'
    ],
    now: function (ctx) {
      const out = [];
      const list = arr(ctx.market);
      if (!list.length) return ['Classifica non ancora disponibile.'];
      const sorted = list.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      const top = sorted[0], bottom = sorted[sorted.length - 1];
      if (top) out.push('Quadro piu\u0300 rialzista: ' + top.symbol + ' con punteggio ' + sg(top.score, 2) + '.');
      if (bottom) out.push('Quadro piu\u0300 ribassista: ' + bottom.symbol + ' con punteggio ' + sg(bottom.score, 2) + '.');
      const idx = sorted.findIndex(function (x) { return x.symbol === ctx.pair; });
      if (idx >= 0) {
        out.push('La coppia aperta (' + ctx.pair + ') e\u0300 al posto ' + (idx + 1) + ' su ' + sorted.length +
          ' con punteggio ' + sg(sorted[idx].score, 2) + '.');
      }
      const shownRows = shown(ctx, 'watchlist');
      out.push('Strumenti in classifica: ' + sorted.length +
        (shownRows != null ? ' (voci in elenco: ' + shownRows + ')' : '') + '.');
      return out;
    }
  };

  /* ---------------------------- GRAFICO ---------------------------- */

  EXPLAIN.chart = {
    title: 'Il grafico a candele',
    general: [
      'Ogni candela riassume un intervallo di tempo del timeframe scelto: il corpo va dall\'apertura alla chiusura, le due sottili linee (ombre) segnano il massimo e il minimo toccati nella stessa finestra.',
      'Corpo verde significa chiusura sopra l\'apertura, corpo rosso il contrario. Le sovrapposizioni accese dai pulsanti in alto disegnano sul grafico i livelli e gli studi calcolati dall\'applicazione: medie, Bollinger, volumi, struttura SMC, premio/sconto, proiezione, SuperTrend, Parabolic SAR, Ichimoku, divergenze e pivot point.'
    ],
    reading: [
      'Le ombre raccontano il rifiuto: un\'ombra lunga sopra il corpo dice che i prezzi sono stati respinti da quel livello.',
      'Una zona con molte candele piccole e sovrapposte e\u0300 compressione: il movimento successivo tende a essere piu\u0300 deciso del solito.',
      'Passando il mouse su una candela si apre la lettura con apertura, massimo, minimo e chiusura esatti.'
    ],
    now: function (ctx) {
      const out = [];
      if (!ctx.analysis) return ['Grafico non ancora calcolato.'];
      out.push('Coppia e timeframe: ' + ctx.pair + ' \u00b7 ' + ctx.tfLabel + '.');
      out.push('Ultima chiusura: ' + (px(ctx.price, ctx) || 'n.d.') +
        (n(ctx.changePct) != null ? ' (' + sg(ctx.changePct, 2) + '% nell\'ultima candela)' : '') + '.');
      const act = arr(ctx.activeLayers);
      out.push('Sovrapposizioni accese: ' + (act.length ? act.join(', ') : 'nessuna') + '.');
      const candles = arr(ctx.series && ctx.series.candles);
      if (candles.length) {
        const c = candles[candles.length - 1];
        out.push('Ultima candela disegnata: apertura ' + px(c.open, ctx) + ', massimo ' + px(c.high, ctx) +
          ', minimo ' + px(c.low, ctx) + ', chiusura ' + px(c.close, ctx) + '.');
        out.push('Candele in memoria: ' + candles.length + '.');
      }
      if (n(ctx.analysis.atr) != null) {
        out.push('Ampiezza tipica di una candela (ATR): ' + px(ctx.analysis.atr, ctx) +
          ': una candela alta il doppio dell\'ATR e\u0300 un movimento fuori dalla norma.');
      }
      return out;
    }
  };

  EXPLAIN.trendChart = {
    title: 'Indicatori di trend e inversione',
    general: [
      'Dieci letture direzionali calcolate sulle stesse candele del grafico. Servono a rispondere a due domande diverse: da che parte va il mercato (trend) e se quel movimento sta per esaurirsi (inversione).',
      'Del primo gruppo fanno parte SuperTrend, Parabolic SAR, Ichimoku, Aroon, Vortex e DMI/ADX; del secondo CCI, Stochastic RSI e Choppiness. Keltner, confrontato con Bollinger, misura invece la compressione di volatilita\u0300.'
    ],
    reading: [
      'Ogni riquadro mostra la lettura in parole (RIALZO, RIBASSO, NEUTRO) e il valore che l\'ha prodotta: il valore conta piu\u0300 dell\'etichetta quando si confrontano due momenti diversi.',
      'Choppiness sotto 38 dice mercato in tendenza, sopra 62 mercato laterale: e\u0300 il filtro che decide se fidarsi degli indicatori direzionali.',
      'Quando Keltner finisce dentro le bande di Bollinger c\'e\u0300 compressione: la stessa cosa detta da due strumenti diversi, quindi piu\u0300 attendibile.'
    ],
    now: trendGridLines
  };


  EXPLAIN.divChart = {
    title: 'Divergenze e livelli di riferimento',
    general: [
      'Due letture diverse nella stessa card. Le divergenze confrontano i punti di swing del prezzo con gli oscillatori (RSI e istogramma MACD): dicono se il movimento sta perdendo forza o se sta solo ricaricando.',
      'I pivot point sono invece livelli di prezzo calcolati su massimo, minimo e chiusura del periodo di contrattazione precedente (il giorno per i timeframe brevi, la settimana per il giornaliero): sono i riferimenti che molti operatori guardano per primi.'
    ],
    reading: [
      'Divergenza regolare rialzista: il prezzo fa un minimo piu\u0300 basso mentre l\'oscillatore fa un minimo piu\u0300 alto - la spinta vende sta esaurendosi. Regolare ribassista e\u0300 il caso speculare.',
      'Divergenza nascosta: il prezzo corregge ma l\'oscillatore resta piu\u0300 forte, quindi il movimento sta solo ricaricando nella direzione principale.',
      'Nei pivot il livello centrale (Pivot) separa la parte alta (R1-R3, resistenze) da quella bassa (S1-S3, supporti): il prezzo sopra il pivot e\u0300 nel lato rialzista del periodo.',
      'La sezione ripiegata "efficacia storica" e\u0300 la parte piu\u0300 importante della card: dice quante volte, in passato e su questi dati, il segnale ha funzionato davvero. Se l\'intervallo di confidenza contiene lo zero, l\'applicazione scrive che non c\'e\u0300 vantaggio misurabile, e in quel caso la divergenza va letta come contesto, non come istruzione.'
    ],
    now: function (ctx) {
      const out = [];
      const div = ctx.divergence, piv = ctx.pivots, study = ctx.divStudy;
      if (div) {
        out.push('Divergenze attive: ' + div.items.length + ' (' + div.bull + ' rialziste, ' + div.bear + ' ribassiste).');
        if (div.items.length) {
          const it = div.items[0];
          out.push('La piu\u0300 recente: ' + it.osc + ' ' + (it.kind === 'regular' ? 'regolare' : 'nascosta') + ' ' +
            (it.dir > 0 ? 'rialzista' : 'ribassista') + ', fra ' + px(it.from.price, ctx) + ' e ' + px(it.to.price, ctx) +
            ' (' + it.age + ' candele fa).');
        } else {
          out.push('Nessuna divergenza rilevata nella finestra recente.');
        }
      }
      if (piv && piv.classic) {
        const p = piv.classic.p;
        out.push('Pivot point del periodo ' + piv.period +
          (shown(ctx, 'pivots') != null ? ' (' + shown(ctx, 'pivots') + ' livelli in griglia)' : '') +
          ': Pivot ' + px(p, ctx) + ', R1 ' + px(piv.classic.r1, ctx) +
          ', S1 ' + px(piv.classic.s1, ctx) + '.');
        if (n(ctx.price) != null && n(p) != null) {
          out.push('Il prezzo e\u0300 ' + (ctx.price >= p ? 'sopra' : 'sotto') + ' il pivot (' +
            sg(pip(ctx.price, p, ctx), 1) + ' pip).');
        }
        const cam = piv.camarilla || {};
        if (px(cam.r3, ctx)) out.push('Camarilla: R3 ' + px(cam.r3, ctx) + ', S3 ' + px(cam.s3, ctx) + '.');
      }
      if (study && study.count) {
        const all = study.all;
        out.push('Studio di efficacia: ' + study.count + ' casi misurati nelle ultime ' + study.window +
          ' candele, esito valutato a ' + study.horizon + ' candele.');
        out.push('Esiti a favore: ' + (all.hitRate * 100).toFixed(1) + '% \u00b7 rendimento medio ' + sg(all.avgR, 2) +
          ' ATR per segnale \u00b7 profit factor ' + (all.profitFactor === Infinity ? 'infinito' : all.profitFactor.toFixed(2)) + '.');
        out.push(all.significant
          ? 'Il margine supera l\u2019incertezza statistica: su questo campione il vantaggio e\u0300 misurabile.'
          : 'Il margine non supera l\u2019incertezza statistica: su questo campione non c\u2019e\u0300 vantaggio misurabile (' +
            sg(all.avgR, 2) + ' \u00b1 ' + Math.abs(all.ci95).toFixed(2) + ' ATR).');
      } else if (study) {
        out.push('Studio di efficacia: nessun caso misurabile nella finestra di ' + study.window + ' candele.');
      } else {
        out.push('Studio di efficacia: ancora in calcolo.');
      }
      return out;
    }
  };

  EXPLAIN.forecast = {
    title: 'Proiezione probabilistica',
    general: [
      'Il motore combina otto famiglie di segnali tecnici con pesi adattivi e traduce il risultato in probabilita\u0300: quanta parte del quadro appoggia il rialzo e quanta il ribasso.',
      'Sotto la sintesi ci sono i livelli: per ciascun multiplo di ATR (2, 1,5, 1 e 0,5) l\'applicazione stima la probabilita\u0300 di toccare il livello sopra e quello sotto entro l\'orizzonte scelto.'
    ],
    reading: [
      'Le probabilita\u0300 vanno lette come quote, non come certezze: 60% significa che su dieci scenari simili sei andavano in quella direzione, non che succedera\u0300.',
      'La differenza fra la probabilita\u0300 di toccare il livello a 0,5 ATR e quella del livello a 2 ATR dice quanto e\u0300 "largo" il movimento atteso: se le due sono simili, il mercato e\u0300 indeciso.',
      'Una confidenza alta con un regime laterale vale meno di una confidenza media in tendenza: il regime e\u0300 scritto accanto al punteggio.'
    ],
    now: function (ctx) {
      const out = [];
      const a = ctx.analysis;
      if (!a) return ['Proiezione non ancora calcolata.'];
      out.push('Probabilita\u0300 rialzista ' + pc(a.probabilityUp, 1) + ' contro ' + pc(a.probabilityDown, 1) + ' ribassista, su un orizzonte di ' + a.horizon + ' candele.');
      out.push('Inclinazione complessiva: score ' + sg(a.score, 3) + ' (' + dirLabel(a.direction) + '), confidenza ' + pc(a.confidence) + '.');
      if (n(a.expectedMove) != null) {
        out.push('Movimento atteso: ' + sg(pips(a.expectedMove, ctx), 1) + ' pip, cioe\u0300 ' +
          (n(a.atr) && a.atr > 0 ? Math.abs(a.expectedMove / a.atr).toFixed(2) : 'n.d.') + ' ATR.');
      }
      if (px(a.target, ctx)) out.push('Livello obiettivo del piano: ' + px(a.target, ctx) + ' (rapporto ' + (n(a.rr) != null ? a.rr.toFixed(2) : 'n.d.') + ' a 1).');
      arr(a.levels).forEach(function (lv) {
        out.push('Toccare ' + lv.multiple + ' ATR: ' + pc(lv.pUp) + ' verso l\u2019alto a ' + px(lv.up, ctx) +
          ', ' + pc(lv.pDn) + ' verso il basso a ' + px(lv.down, ctx) + '.');
      });
      return out;
    }
  };

  EXPLAIN.backtest = {
    title: 'Backtest storico',
    general: [
      'Il motore viene fatto girare all\'indietro sulle ultime 250 candele, senza usare informazioni future: per ogni candela valuta il segnale come lo avrebbe visto allora e misura che cosa e\u0300 successo dopo.',
      'Il risultato riassume quanti scambi sono stati simulati, quante volte sono andati a buon fine e quanto hanno reso in multipli di R (una unita\u0300 di rischio). La curva sotto mostra il capitale cumulato in punti R.'
    ],
    reading: [
      'Hit rate vicino al 50% e\u0300 la norma sui mercati reali: da solo non dice se un sistema guadagna, perche\u0300 conta il rapporto fra guadagni e perdite medie.',
      'Il drawdown massimo e\u0300 la discesa peggiore della curva: e\u0300 il numero che dice se sopporteresti il sistema dal punto di vista psicologico.',
      'Questa curva nasce su serie simulate, che contengono regimi di tendenza piu\u0300 puliti del reale: i valori vanno letti come ordine di grandezza, non come previsione.'
    ],
    now: function (ctx) {
      const out = [];
      const bt = ctx.backtest;
      if (!bt || !bt.count) return ['Backtest non ancora calcolato.'];
      out.push('Scambi simulati: ' + bt.count + ' sulle ultime 250 candele.');
      out.push('Esiti positivi: ' + pc(bt.winRate, 1) + ' \u00b7 guadagno medio ' + sg(bt.avgWin, 2) +
        ' R \u00b7 perdita media ' + neg(bt.avgLoss, 2) + ' R \u00b7 risultato medio per scambio ' + sg(bt.avgR, 2) + ' R.');
      out.push('Risultato cumulato: ' + sg(bt.totalR, 1) + ' R, con una discesa massima di ' + neg(bt.maxDrawdown, 1) + ' R.');
      out.push('Profit factor ' + (bt.profitFactor === Infinity ? 'infinito' : n(bt.profitFactor) != null ? bt.profitFactor.toFixed(2) : 'n.d.') +
        ' (guadagni totali diviso perdite totali).');
      return out;
    }
  };

  EXPLAIN.equity = {
    title: 'La curva del backtest',
    general: [
      'Il grafico e\u0300 la somma progressiva dei risultati degli scambi simulati, espressa in multipli di R: ogni gradino in su e\u0300 uno scambio chiuso in guadagno, ogni gradino in giu\u0300 una perdita.',
      'Non e\u0300 il saldo di un conto: e\u0300 la forma della sequenza, cioe\u0300 come il sistema si comporta mentre il tempo passa.'
    ],
    reading: [
      'Una curva che sale a scala e\u0300 normale; una che sale a picchi isolati segnala che il risultato dipende da pochi scambi fortunati.',
      'Il tratto in cui scende piu\u0300 a lungo e\u0300 il drawdown: va confrontato con i guadagni per capire se il rapporto vale la fatica.',
      'La pendenza finale e\u0300 un riassunto: piu\u0300 e\u0300 regolare, piu\u0300 il comportamento del sistema e\u0300 prevedibile.'
    ],
    now: function (ctx) {
      const out = [];
      const bt = ctx.backtest;
      if (!bt || !bt.count) return ['Curva non ancora disponibile.'];
      out.push('Risultato cumulato: ' + sg(bt.totalR, 1) + ' R su ' + bt.count + ' scambi.');
      out.push('Discesa massima dal picco: ' + neg(bt.maxDrawdown, 1) + ' R.');
      const perTrade = bt.count ? bt.totalR / bt.count : null;
      if (n(perTrade) != null) out.push('Media per scambio: ' + sg(perTrade, 3) + ' R.');
      return out;
    }
  };

  EXPLAIN.context = {
    title: 'Contesto di mercato',
    general: [
      'Sei informazioni di sfondo che non producono segnali ma cambiano il modo in cui i segnali vanno letti: sessioni di contrattazione aperte, volatilita\u0300 rispetto alla norma, posizione del prezzo nella giornata e ora di riferimento.',
      'Sono le condizioni al contorno: un segnale identico non vale lo stesso in sessione asiatica tranquilla e all\'apertura di Londra.'
    ],
    reading: [
      'Quando due sessioni si sovrappongono (Londra e New York) i volumi sono piu\u0300 alti e i movimenti tendono a essere piu\u0300 continui.',
      'Il rapporto di volatilita\u0300 e\u0300 l\'ATR attuale diviso la media delle ultime 50 candele: sopra 1,3 il pannello parla di espansione, sotto 0,75 di compressione, in mezzo di stabilit\u00e0.',
      'La posizione nel range dice se il prezzo e\u0300 vicino ai massimi o ai minimi delle ultime 100 barre, cioe\u0300 dell\'intervallo che il pannello mostra accanto: comprare sui massimi di quel tratto significa pagare il prezzo peggiore.'
    ],
    now: function (ctx) {
      const out = [];
      const a = ctx.analysis;
      // I numeri del pannello, non una finestra calcolata qui: la spiegazione
      // deve descrivere quello che si vede accanto, non una lettura parallela.
      const c = ctx.context || null;
      const now = new Date();
      const h = c && n(c.hourUtc) != null ? c.hourUtc : now.getUTCHours();
      const sessions = c && arr(c.sessions).length ? arr(c.sessions) : sessionsAt(h);
      out.push('Ora di riferimento: ' + now.toLocaleTimeString('it-IT') + ' (UTC ' + h + ':00).');
      out.push('Sessioni aperte: ' + (sessions.length ? sessions.join(', ') : 'nessuna') + '.');
      const volBars = c && n(c.volBars) != null ? c.volBars : 50;
      let ratio = c ? n(c.volRatio) : null;
      let label = c ? c.volLabel : null;
      if (ratio == null && a && a.indicators) {
        const series = arr(a.indicators.atr).slice(-volBars).filter(function (v) { return n(v) != null; });
        if (series.length) {
          const avg = series.reduce(function (x, y) { return x + y; }, 0) / series.length;
          if (avg > 0 && n(a.atr) != null) ratio = a.atr / avg;
        }
      }
      if (n(ratio) != null) {
        out.push('Volatilita\u0300 attuale ' + ratio.toFixed(2) + ' volte la media delle ultime ' + volBars +
          ' candele: ' + (label || (ratio > 1.3 ? 'espansione' : ratio < 0.75 ? 'compressione' : 'stabile')) + '.');
      }
      const rangeBars = c && n(c.rangeBars) != null ? c.rangeBars : 100;
      const lo = c ? n(c.rangeLow) : null;
      const hi = c ? n(c.rangeHigh) : null;
      const pos = c ? n(c.rangePosition) : null;
      if (n(pos) != null && n(lo) != null && n(hi) != null) {
        out.push('Posizione nel range delle ultime ' + rangeBars + ' barre: al ' + pos.toFixed(0) + '% (' +
          px(lo, ctx) + ' - ' + px(hi, ctx) + ').');
      }
      // La riga ADX e' una delle voci del pannello: la spiegazione la cita.
      const adx = c && n(c.adx) != null ? c.adx : (a && n(a.adx) != null ? a.adx : null);
      if (n(adx) != null) {
        out.push('ADX ' + adx.toFixed(1) + ': ' + (adx > 25 ? 'tendenza definita'
          : adx < 18 ? 'mercato laterale' : 'direzione incerta') + '.');
      }
      return out;
    }
  };

  /* ---------------------------- ANALISI TECNICA ---------------------------- */

  EXPLAIN.signal = {
    title: 'Segnale operativo',
    general: [
      'E\u0300 il piano concreto che nasce dal motore tecnico: direzione suggerita (o neutralita\u0300), confidenza del modello, prezzo, obiettivo, stop, stop dinamico del SuperTrend, rapporto fra rischio e obiettivo e movimento atteso.',
      'Sotto, in linguaggio naturale, ci sono le motivazioni: quali componenti del modello spingono in una direzione e con quanta forza.'
    ],
    reading: [
      'La direzione da sola non basta: senza confidenza e senza un rapporto rischio/obiettivo almeno vicino a 1,5 a 1, un\'operazione ha poco senso.',
      'Lo stop dinamico del SuperTrend si sposta con il trend: partirne sopra o sotto e\u0300 normale, indica che il trend sta cambiando lato.',
      'Le motivazioni in fondo spiegano il "perche\u0301": se due o tre componenti forti dicono la stessa cosa, il segnale e\u0300 piu\u0300 solido di un punteggio alto ma sostenuto da una sola.'
    ],
    now: function (ctx) {
      const out = [];
      const a = ctx.analysis;
      if (!a) return ['Segnale non ancora calcolato.'];
      out.push('Direzione ' + dirLabel(a.direction) + ' con confidenza ' + pc(a.confidence) + ' (score ' + sg(a.score, 3) + ').');
      out.push('Prezzo ' + px(a.price, ctx) + ' \u00b7 obiettivo ' + px(a.target, ctx) + ' \u00b7 stop ' + px(a.stop, ctx) +
        ' \u00b7 rapporto ' + (n(a.rr) != null ? a.rr.toFixed(2) : 'n.d.') + ' a 1.');
      /* L'ATR della scala operativa: senza, il rapporto rischio/obiettivo non
       * si puo' tradurre in distanza percorribile. */
      if (px(a.atr, ctx)) {
        out.push('ATR ' + px(a.atr, ctx) + (n(a.atrPct) != null ? ' (' + a.atrPct.toFixed(2) + '% del prezzo)' : '') +
          ': e\u0300 la distanza che il prezzo percorre in media in una candela, il metro con cui leggere questi livelli.');
      }
      const st = a.indicators && a.indicators.superTrend;
      const stLine = st ? last(st.line) : null;
      const stDir = st ? last(st.dir) : null;
      if (px(stLine, ctx)) {
        const same = (a.direction === 'BUY' && stDir > 0) || (a.direction === 'SELL' && stDir < 0);
        out.push('Stop mobile dal SuperTrend: ' + px(stLine, ctx) + (same ? ', dalla stessa parte dello scenario.' : ', contro lo scenario attuale.'));
      }
      if (n(a.expectedMove) != null) {
        out.push('Movimento atteso su ' + a.horizon + ' candele: ' + sg(pips(a.expectedMove, ctx), 1) + ' pip.');
      }
      arr(a.reasons).slice(0, 3).forEach(function (r) { if (r && r.text) out.push(r.text); });
      return out;
    }
  };

  EXPLAIN.trendTech = {
    title: 'Trend e inversione',
    general: [
      'La stessa griglia di indicatori direzionali che si trova sotto il grafico, ripetuta nella scheda di analisi tecnica per averla accanto al segnale operativo.',
      'Serve a verificare se il segnale suggerito va d\'accordo con la struttura: un acquisto in un mercato in tendenza ribassista e\u0300 un contro-trend, e va trattato come tale.'
    ],
    reading: [
      'Cerca la concordanza: piu\u0300 riquadri puntano nella stessa direzione, piu\u0300 la lettura e\u0300 robusta.',
      'Choppiness alto smorza il valore di tutti gli indicatori direzionali: in laterale si muovono a zig-zag e generano falsi segnali.',
      'Aroon in alto su entrambe le linee significa che il movimento e\u0300 recente, non che sia forte.'
    ],
    // Stesso pannello, stesse righe: la griglia e' identica a quella della
    // scheda Grafici, cambia solo il posto in cui la si guarda.
    now: trendGridLines
  };

  EXPLAIN.divTech = {
    title: 'Divergenze e livelli di riferimento',
    general: [
      'Le stesse due letture della scheda Grafici, ripetute qui accanto al segnale operativo: le divergenze fra prezzo e oscillatori e i pivot point del periodo precedente.',
      'La sezione ripiegata in fondo misura l\'efficacia storica delle divergenze su questa serie e questo orizzonte, dichiarando quanti casi sono stati osservati.'
    ],
    reading: [
      'Una divergenza e\u0300 un\'indicazione di contesto: non dice quando entrare, dice che la spinta sta cambiando.',
      'Nel pannello dei pivot, il prezzo sopra il livello centrale lavora nella meta\u0300 alta del periodo, che e\u0300 quella dei venditori; sotto, il contrario.',
      'Guarda sempre la riga di verdetto dello studio: se dichiara che non c\u2019e\u0300 vantaggio misurabile, la divergenza va pesata come informazione, non come segnale operativo.'
    ],
    now: EXPLAIN.divChart.now
  };

  EXPLAIN.indTech = {
    title: 'Indicatori tecnici',
    general: [
      'La griglia raccoglie le letture classiche: medie mobili, oscillatori (RSI, Stochastic RSI, CCI), ampiezza (ATR), struttura delle bande e volumi.',
      'Il dettaglio numerico ripiegato elenca sotto ogni riga il valore esatto e la posizione del prezzo rispetto al livello, per chi vuole il numero e non l\'etichetta.'
    ],
    reading: [
      'RSI sopra 70 segnala ipercomprato e sotto 30 ipervenduto, ma in tendenza forte puo\u0300 restare estremo a lungo: da solo non e\u0300 un segnale di inversione.',
      'Prezzo sopra la pila delle medie mobili significa che tutte le medie sono in ordine rialzista: e\u0300 la definizione operativa di trend sano.',
      'Volumi in aumento confermano il movimento; volumi in calo mentre il prezzo sale sono un avvertimento.'
    ],
    now: function (ctx) {
      const out = [];
      const a = ctx.analysis;
      if (!a || !a.indicators) return ['Indicatori non ancora calcolati.'];
      const ind = a.indicators;
      const rsi = last(ind.rsi);
      if (n(rsi) != null) out.push('RSI ' + rsi.toFixed(1) + ': ' + (rsi >= 70 ? 'ipercomprato' : rsi <= 30 ? 'ipervenduto' : 'in area neutra') + '.');
      const hist = ind.macd && last(ind.macd.histogram);
      if (n(hist) != null) out.push('Istogramma MACD ' + sg(hist, null).slice(0, 12) + ': ' + (hist >= 0 ? 'slancio rialzista' : 'slancio ribassista') + '.');
      // Stochastic (14,3): la riga %K / %D del dettaglio numerico
      const sk = last(ind.stoch && ind.stoch.k);
      if (n(sk) != null) {
        const sd = last(ind.stoch && ind.stoch.d);
        out.push('%K ' + sk.toFixed(1) + (n(sd) != null ? ' / %D ' + sd.toFixed(1) : '') + ': ' +
          (sk >= 80 ? 'zona di ipercomprato' : sk <= 20 ? 'zona di ipervenduto' : 'nessun estremo') + '.');
      }
      const e = [['EMA 9', last(ind.ema9)], ['EMA 21', last(ind.ema21)], ['EMA 50', last(ind.ema50)], ['SMA 200', last(ind.sma200)]];
      const valid = e.filter(function (x) { return n(x[1]) != null; });
      if (valid.length && n(ctx.price) != null) {
        const above = valid.filter(function (x) { return ctx.price >= x[1]; }).length;
        out.push('Prezzo sopra ' + above + ' medie su ' + valid.length + ' calcolate: ' +
          (above === valid.length ? 'struttura pienamente rialzista' : above === 0 ? 'struttura pienamente ribassista' : 'struttura mista') + '.');
        // il valore di ogni media, com'e' scritto nel dettaglio numerico
        out.push(valid.map(function (x) { return x[0] + ' ' + px(x[1], ctx); }).join(' \u00b7 ') + '.');
      }
      if (n(a.atrPct) != null) out.push('Ampiezza media per candela: ' + a.atrPct.toFixed(2) + '% del prezzo.');
      // I cambi valutari reali non hanno volumi: in quel caso la riga va
      // omessa invece di mostrare un rapporto senza significato (0/0).
      const vol = last(ind.volumeSma);
      if (n(vol) != null && vol > 0 && n(ctx.lastVolume) != null && ctx.lastVolume > 0) {
        out.push('Volumi dell\u2019ultima candela ' + (ctx.lastVolume / vol).toFixed(2) + ' volte la media recente.');
      } else {
        out.push('Volumi non disponibili per questa coppia: il fornitore dei dati reali non li pubblica, quindi la card li mostra come n.d.');
      }
      return out;
    }
  };

  /* ---------------------------- SMC ---------------------------- */

  EXPLAIN.smc = {
    title: 'SMC (Smart Money Concepts)',
    general: [
      'Lo studio legge il mercato come una successione di movimenti istituzionali: dove sono i blocchi di ordini ancora intatti (order block), quali squilibri di prezzo non sono stati ricoperti (fair value gap), dove si accumula la liquidita\u0300 (massimi e minimi uguali) e in quale meta\u0300 del range ci si trova (premio o sconto).',
      'Il riquadro "struttura" dichiara se l\'ultimo evento e\u0300 una continuazione (BOS) o un cambio di carattere (CHoCH); la scala operativa sotto propone ingresso, stop e obiettivi su queste basi.'
    ],
    reading: [
      'Il prezzo in zona di sconto e\u0300 la meta\u0300 in cui comprare ha senso per la logica SMC; in zona di premio, viceversa per vendere. La fascia fra 61,8% e 79% del ritracciamento e\u0300 l\'area OTE.',
      'Order block "freschi" (mai ritestati) hanno piu\u0300 valore di quelli gia\u0300 consumati; la card marca lo stato di ciascuno.',
      'CHoCH recente segnala un cambio di direzione, BOS una continuazione: leggere l\'evento sbagliato porta a entrare contro il movimento principale.',
      'La mappa della liquidita\u0300 mostra quali livelli sono ancora intatti, quali sono stati toccati e quali spazzati: i livelli intatti sono i calamita del prezzo.'
    ],
    now: function (ctx) {
      const out = [];
      const s = ctx.smc;
      if (!s) return ['Studio SMC non ancora calcolato.'];
      out.push('Struttura ' + (s.biasLabel || '').toLowerCase() + ', punteggio ' + sg(s.score, 2) + ', confidenza ' + pc(s.confidence) + '.');
      const ms = s.structure || {};
      const ev = ms.event || ms.lastEvent;
      if (ev && ev.type) out.push('Ultimo evento di struttura: ' + ev.type + (px(ev.price, ctx) ? ' a ' + px(ev.price, ctx) : '') + '.');
      if (s.range) {
        const r = s.range;
        if (n(r.low) != null && n(r.high) != null && n(ctx.price) != null && r.high > r.low) {
          out.push('Range di riferimento ' + px(r.low, ctx) + ' - ' + px(r.high, ctx) + ': il prezzo e\u0300 al ' +
            pc((ctx.price - r.low) / (r.high - r.low)) + (r.mid != null ? ', equilibrio a ' + px(r.mid, ctx) : '') + '.');
        }
      }
      // Ogni elenco mostra solo una parte di quello che lo studio individua:
      // si dichiarano entrambi i numeri, cosi' la spiegazione non contraddice
      // l'elenco che l'utente ha davanti.
      const obs = arr(s.orderBlocks);
      const validOb = obs.filter(function (o) { return o.status !== 'invalidated'; });
      const freshOb = obs.filter(function (o) { return o.status === 'fresh'; });
      out.push('Order block: ' + validOb.length + ' ancora validi su ' + obs.length + ' individuati' +
        (obs.length ? ' (' + freshOb.length + ' mai ritestati)' : '') +
        (shown(ctx, 'ob') != null ? '; il pannello mostra i ' + shown(ctx, 'ob') + ' piu\u0300 recenti.' : '.'));
      const fv = arr(s.fvgs);
      const validFv = fv.filter(function (g) { return g.status !== 'invalidated'; });
      out.push('Fair value gap: ' + validFv.length + ' aperti su ' + fv.length + ' individuati' +
        (shown(ctx, 'fvg') != null ? '; il pannello mostra i ' + shown(ctx, 'fvg') + ' piu\u0300 recenti.' : '.'));
      const liq = arr(s.liquidity);
      if (liq.length) {
        // lo stato "intatta" e' quello senza prelievo registrato (sweptAt):
        // controllare un campo inesistente conterebbe come intatte anche le
        // liquidita gia' prelevate
        const intact = liq.filter(function (l) { return !l.taken && l.sweptAt == null; });
        out.push('Livelli di liquidita\u0300: ' + liq.length + ' individuati, ' + intact.length + ' ancora intatti' +
          (shown(ctx, 'liq') != null ? '; il pannello ne mostra ' + shown(ctx, 'liq') + '.' : '.'));
      }
      if (s.plan) {
        const p = s.plan;
        const bits = [];
        if (px(p.limitEntry, ctx)) bits.push('ingresso limite ' + px(p.limitEntry, ctx));
        if (px(p.stop, ctx)) bits.push('stop ' + px(p.stop, ctx));
        if (px(p.tp1, ctx)) bits.push('primo obiettivo ' + px(p.tp1, ctx));
        if (px(p.tp2, ctx)) bits.push('secondo obiettivo ' + px(p.tp2, ctx));
        if (bits.length) out.push('Piano SMC con ' + (p.inZone ? 'prezzo gia\u0300 nella zona di ingresso' : 'attesa del prezzo nella zona di ingresso') + ': ' + bits.join(', ') + '.');
      }
      return out;
    }
  };

  /* ---------------------------- SENTIMENT ---------------------------- */

  EXPLAIN.sentiment = {
    title: 'Sentiment di mercato',
    general: [
      'Lo studio guarda fuori dal grafico: quanto e\u0300 forte ciascuna valuta rispetto alle altre, che posizione ha il pubblico retail, se il contesto e\u0300 di propensione o di avversione al rischio e dove sono posizionati gli operatori istituzionali.',
      'Con i dati reali la forza delle valute e il regime arrivano dai prezzi, il posizionamento istituzionale dal report COT della CFTC e il regime di rischio dal VIX; il posizionamento retail resta simulato e dichiarato.'
    ],
    reading: [
      'La forza relativa dice quale delle due valute della coppia ha il vento a favore: comprare la piu\u0300 forte contro la piu\u0300 debole e\u0300 la parte piu\u0300 solida della lettura.',
      'Il posizionamento retail viene letto in modo contrarian: quando il pubblico e\u0300 schiacciato su un lato, quel lato e\u0300 affollato e piu\u0300 fragile.',
      'Il badge in alto e\u0300 la sintesi: direzione, forza della lettura e motivo. Nel verdetto generale pesa solo se ha un universo dati completo.'
    ],
    now: function (ctx) {
      const out = [];
      const s = ctx.sentiment;
      if (!s) return ['Studio del sentiment non ancora calcolato.'];
      // la card mostra `bias` ("RIBASSO", "FORTE RIALZO"...): si usa quello,
      // cosi' badge e spiegazione dicono la stessa parola
      if (s.bias || s.direction) {
        const read = s.bias || (s.direction === 'BUY' ? 'RIALZO' : s.direction === 'SELL' ? 'RIBASSO' : 'NEUTRO');
        out.push('Lettura complessiva: ' + read + (n(s.score) != null ? ' (punteggio ' + sg(s.score, 2) + ')' : '') +
          (n(s.confidence) != null ? ', confidenza ' + pc(s.confidence) : '') + '.');
      }
      // la forza arriva come {list: [...]}: leggere l'oggetto come se fosse un
      // array lascerebbe fuori tutta la classifica
      const raw = s.strength && (s.strength.list || s.strength);
      const st = (Array.isArray(raw) ? raw.slice() : [])
        .filter(function (x) { return n(x.score) != null || n(x.medium) != null; })
        .map(function (x) { return { currency: x.currency, rank: n(x.score) != null ? x.score : x.medium }; })
        .sort(function (a, b) { return b.rank - a.rank; });
      if (st.length) {
        const fmt = function (x) {
          return Math.round(x.rank) + (n(x.rank) != null && Math.abs(x.rank) <= 100 ? ' su 100' : '');
        };
        out.push('Valuta piu\u0300 forte: ' + st[0].currency + ' (forza ' + fmt(st[0]) + '), piu\u0300 debole: ' +
          st[st.length - 1].currency + ' (forza ' + fmt(st[st.length - 1]) + ').');
        const b = s.pair && s.pair.base, q = s.pair && s.pair.quote;
        const bIdx = st.findIndex(function (x) { return x.currency === b; });
        const qIdx = st.findIndex(function (x) { return x.currency === q; });
        if (bIdx >= 0 && qIdx >= 0) {
          out.push(b + ' e\u0300 al posto ' + (bIdx + 1) + ' e ' + q + ' al posto ' + (qIdx + 1) +
            ' su ' + st.length + ': ' + (bIdx < qIdx ? 'il vento favorisce il rialzo della coppia.' : 'il vento favorisce il ribasso della coppia.') );
        }
      }
      if (s.retail && n(s.retail.longPct) != null) {
        out.push('Posizionamento retail' + (s.retail.simulated ? ' (simulato)' : '') + ': ' +
          s.retail.longPct.toFixed(0) + '% lungo contro ' + s.retail.shortPct.toFixed(0) + '% corto' +
          (s.retail.extremeText ? ' \u2014 ' + s.retail.extremeText : '') + '.');
        if (s.retail.contrarianText) out.push('Lettura contraria: ' + s.retail.contrarianText + '.');
      }
      const risk = s.risk;
      if (risk && n(risk.score) != null) {
        out.push('Regime di rischio: ' + risk.label + ' (indice ' + risk.score.toFixed(0) + ' su 100' +
          (n(risk.vix) != null ? ', VIX ' + risk.vix.toFixed(1) : '') + ').');
        if (risk.volLabel) {
          out.push('Volatilita\u0300 di riferimento: ' + risk.volLabel +
            (n(risk.volRatio) != null ? ' (' + risk.volRatio.toFixed(2) + ' volte la media)' : '') + '.');
        }
      }
      const inst = s.institutional;
      if (inst && inst.crowded) {
        out.push('Posizionamento istituzionale: la divisa piu\u0300 affollata e\u0300 ' + inst.crowded.currency +
          ' (' + sg(inst.crowded.net, 0) + '% netto)' + (inst.lightest ? ', la piu\u0300 leggera ' + inst.lightest.currency + '.' : '.'));
      }
      const sc = s.scope;
      if (sc && sc.realSentiment) {
        out.push('Fonti: report COT della CFTC' + (sc.cotAsOf ? ' al ' + sc.cotAsOf : '') + ', VIX e indice del dollaro. Universo ridotto a ' +
          (sc.realPairs || 1) + ' coppia reale.');
      } else if (sc) {
        out.push('Fonti: modello simulato su ' + ((sc.realPairs || 0) + (sc.simulatedPairs || 0)) + ' coppie.');
      }
      return out;
    }
  };

  EXPLAIN.news = {
    title: 'Notizie e calendario',
    general: [
      'Le due fonti informative esterne al mercato: il calendario economico filtrato sugli eventi che riguardano EUR/USD e i titoli delle agenzie di stampa specializzate.',
      'Servono a dare un contesto a un movimento che il grafico mostra ma non spiega.'
    ],
    reading: [
      'Un titolo non e\u0300 un segnale operativo: e\u0300 il motivo per cui il mercato potrebbe comportarsi diversamente dal solito, e va letto insieme al calendario.',
      'Il tag di impatto del calendario (alto, medio, basso) misura quanto quel dato ha storicamente mosso i prezzi.',
      'La riga sotto il titolo "Notizie" dichiara quante fonti sono attive: se una non risponde, l\'applicazione lo scrive invece di far finta che non ci sia.'
    ],
    now: function (ctx) {
      const out = [];
      const news = arr(ctx.news);
      const cal = arr(ctx.calendar);
      const shownNews = shown(ctx, 'news');
      out.push('Titoli ricevuti: ' + news.length +
        (shownNews != null ? ' (in elenco: ' + shownNews + ')' : '') +
        ' \u00b7 eventi in calendario per questa settimana: ' + cal.length + '.');
      if (news.length) out.push('Titolo piu\u0300 recente: ' + (news[0].title || 'n.d.') + (news[0].source ? ' (' + news[0].source + ')' : '') + '.');
      if (cal.length) {
        const e = cal[0];
        out.push('Primo evento pertinente: ' + (e.title || 'n.d.') + (e.country ? ' \u00b7 ' + e.country : '') +
          (e.impact ? ' \u00b7 impatto ' + e.impact : '') + '.');
      } else {
        out.push('Il calendario non segnala eventi pertinenti in questa settimana.');
      }
      if (ctx.newsSources) out.push('Fonti attive: ' + ctx.newsSources + '.');
      return out;
    }
  };

  /* ---------------------------- REGISTRO ---------------------------- */

  EXPLAIN.journal = {
    title: 'Registro operazioni virtuali',
    general: [
      'Un quaderno di bordo: quando premi "Registra trade virtuale" l\'applicazione salva coppia, timeframe, direzione, ingresso, obiettivo, stop e confidenza del momento. Il registro resta salvato nel browser.',
      'Serve a misurare le proprie decisioni, non quelle del modello: la colonna esito va compilata a mano quando l\'operazione si chiude.'
    ],
    reading: [
      'Il riassunto in alto conta quante operazioni sono aperte e quante chiuse, con l\'esito complessivo.',
      'Il confronto fra la confidenza dichiarata dall\'applicazione e l\'esito reale e\u0300 la parte utile: se le operazioni a confidenza alta chiudono spesso in perdita, il modello non e\u0300 affidabile su questo strumento.',
      'Compilare l\'esito anche quando fa male e\u0300 l\'unico modo perche\u0300 questi numeri dicano qualcosa.'
    ],
    now: function (ctx) {
      const out = [];
      const j = arr(ctx.journal);
      if (!j.length) return ['Il registro e\u0300 vuoto: nessuna operazione salvata su questo browser.'];
      const open = j.filter(function (t) { return !t.outcome || t.outcome === 'open' || t.outcome === 'aperta'; });
      const closed = j.filter(function (t) { return t.outcome && t.outcome !== 'open' && t.outcome !== 'aperta'; });
      const shownRows = shown(ctx, 'journal');
      out.push('Operazioni registrate: ' + j.length + ' (' + open.length + ' ancora aperte, ' + closed.length + ' chiuse)' +
        (shownRows != null ? ', ' + shownRows + ' righe in tabella.' : '.'));
      if (closed.length) {
        const wins = closed.filter(function (t) { return t.outcome === 'win' || t.outcome === 'vincente'; }).length;
        out.push('Esiti chiusi: ' + wins + ' positivi su ' + closed.length + ' (' + pc(wins / closed.length) + ').');
      }
      const lastOne = j[j.length - 1];
      if (lastOne) {
        out.push('Ultima registrata: ' + (lastOne.symbol || lastOne.pair || 'n.d.') + ' ' + (lastOne.tf || '') + ' ' +
          (lastOne.direction || lastOne.dir || '') + ' a ' + (px(lastOne.entry, ctx) || 'n.d.') + '.');
      }
      return out;
    }
  };

  /* ---------------------------- GRAFICI MINORI ---------------------------- */

  EXPLAIN.spark = {
    title: 'La striscia del moto recente',
    general: [
      'Una mini-serie delle ultime 40 chiusure, senza assi ne\u0301 scala: serve a cogliere la forma del tratto recente, non i valori.',
      'E\u0300 il grafico che si guarda per primo quando si vuole capire se il mercato sta accelerando o perdendo spinta.'
    ],
    reading: [
      'Una linea che si piega sempre nella stessa direzione e\u0300 una tendenza breve in corso; un saliscendi fitto e\u0300 laterale.',
      'Un tratto quasi piatto seguito da uno scatto segnala compressione che si scarica: e\u0300 lo stesso fenomeno che il pannello Keltner misura in numeri.'
    ],
    now: function (ctx) {
      const out = [];
      const candles = arr(ctx.series && ctx.series.candles).slice(-40);
      if (candles.length < 2) return ['Striscia non ancora disegnata.'];
      const first = candles[0].close, lastOne = candles[candles.length - 1].close;
      const hi = Math.max.apply(null, candles.map(function (c) { return c.high; }));
      const lo = Math.min.apply(null, candles.map(function (c) { return c.low; }));
      out.push('Ultime ' + candles.length + ' candele: da ' + px(first, ctx) + ' a ' + px(lastOne, ctx) +
        ' (' + sg((lastOne - first) / first * 100, 2) + '%).');
      out.push('Massimo ' + px(hi, ctx) + ' e minimo ' + px(lo, ctx) + ' del tratto, ampiezza ' + px(hi - lo, ctx) + '.');
      const a = ctx.analysis;
      if (a && n(a.atr) != null && a.atr > 0) {
        out.push('Ampiezza del tratto: ' + ((hi - lo) / a.atr).toFixed(1) + ' volte l\u2019ATR corrente.');
      }
      return out;
    }
  };

  /* ------------------------------ rendering ------------------------------ */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function bullets(lines) {
    const items = arr(lines).map(function (l) {
      if (l && typeof l === 'object' && l.callout) return null;
      return '<li>' + esc(l) + '</li>';
    }).filter(Boolean);
    return items.length ? '<ul class="rep-ul">' + items.join('') + '</ul>' : '';
  }

  function callouts(lines) {
    return arr(lines).filter(function (l) { return l && typeof l === 'object' && l.callout; })
      .map(function (l) {
        return '<div class="rep-callout ' + (l.tone || '') + '">' + esc(l.text) + '</div>';
      }).join('');
  }

  function paragraphs(list) {
    return arr(list).map(function (t) { return '<p class="rep-p">' + esc(t) + '</p>'; }).join('');
  }

  /** Riga di contesto comune: dati in uso adesso. */
  function contextLine(ctx) {
    if (!ctx) return '';
    const bits = [];
    if (ctx.pair) bits.push(ctx.pair);
    if (ctx.tfLabel) bits.push(ctx.tfLabel);
    if (ctx.source === 'real') bits.push('dati reali');
    else bits.push('dati simulati');
    if (ctx.newsSources) bits.push(ctx.newsSources + ' fonti notizie');
    return bits.join(' \u00b7 ');
  }

  /**
   * Spiegazione pronta da mostrare.
   * @returns {Object|null} {key, title, subtitle, html}
   */
  function explain(key, ctx) {
    const e = EXPLAIN[key];
    if (!e) return null;
    let now = [];
    try {
      now = e.now ? arr(e.now(ctx || {})) : [];
    } catch (err) {
      now = ['Dati non disponibili in questo momento (' + (err && err.message ? err.message : 'errore') + ').'];
    }
    const html =
      '<h3 class="rep-h2">Che cosa mostra questa card</h3>' + paragraphs(e.general) +
      '<h3 class="rep-h2">Come si legge</h3>' + bullets(e.reading) +
      '<h3 class="rep-h2">In questo momento</h3>' + bullets(now) + callouts(now);
    return { key: key, title: e.title, subtitle: contextLine(ctx || {}), html: html };
  }

  function keys() { return Object.keys(EXPLAIN); }

  function has(key) { return !!EXPLAIN[key]; }

  global.CardHelp = { explain: explain, keys: keys, has: has, EXPLAIN: EXPLAIN };
})(window);
