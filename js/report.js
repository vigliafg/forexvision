/* =========================================================================
 * report.js - Generatore del report divulgativo
 * -------------------------------------------------------------------------
 * Trasforma lo stato dei tre motori (analisi tecnica, Smart Money Concepts e
 * sentiment) in un documento leggibile da chi non e' un professionista:
 *
 *  - linguaggio semplice, frasi corte, nessun gergo senza spiegazione;
 *  - ogni termine tecnico usato nel testo e' spiegato fra parentesi la prima
 *    volta e comunque presente nel glossario finale;
 *  - numeri sempre accompagnati dal significato pratico ("21 pip, cioe' lo
 *    0,20% del prezzo");
 *  - il report si puo' copiare, scaricare come file di testo o stampare.
 *
 * Il modulo non tocca il DOM: produce una struttura di blocchi che
 * tests/selfcheck.html verifica (sezioni presenti, glossario completo rispetto
 * ai termini usati, frasi non troppo lunghe, numeri coerenti con i dati).
 * ========================================================================= */
(function (global) {
  'use strict';

  const TF_NAMES = {
    M5: '5 minuti', M10: '10 minuti', M15: '15 minuti', H1: '1 ora', H4: '4 ore', D1: '1 giorno'
  };

  /* ------------------------------------------------------------------ */
  /* Glossario: i termini tecnici usati nel report, spiegati in breve.   */
  /* ------------------------------------------------------------------ */
  const GLOSSARY = [
    { term: 'COT', text: 'Commitments of Traders: il report settimanale della CFTC, il regolatore USA dei mercati a termine. Dichiarà quante posizioni lunghe e corte tengono le diverse categorie di operatori (fra cui gli operatori finanziari non-commerciali).' },
    { term: 'VIX', text: 'Indice che misura quanto costa proteggersi dalle oscillazioni dell\'indice S&P 500: quando sale, il mercato ha paura. Serve da termometro del rischio (risk-on / risk-off).' },
    { term: 'Indice del dollaro (DXY)', text: 'Il valore del dollaro USA misurato contro un paniere di altre valute importanti. Se sale, il dollaro è forte rispetto al paniere.' },
    { term: 'ATR', text: 'Average True Range: l\'ampiezza media dei movimenti di una candela. Serve a capire se il mercato si muove molto o poco rispetto al solito.' },
    { term: 'ADX', text: 'Indicatore da 0 a 100 che misura quanto è forte una tendenza, non in quale direzione va. Sopra 25 il movimento è direzionale, sotto 20 il mercato è incerto.' },
    { term: 'RSI', text: 'Indicatore da 0 a 100 che confronta la forza dei rialzi con quella dei ribassi. Sopra 70 il mercato è "surriscaldato", sotto 30 è "scarico".' },
    { term: 'MACD', text: 'Confronta una media veloce e una lenta del prezzo: dice se la spinta del movimento sta aumentando o esaurendosi.' },
    { term: 'Media mobile (EMA)', text: 'La media dei prezzi delle ultime candele. Se il prezzo sta sopra, in media chi compra ha il controllo; se sta sotto, ha il controllo chi vende.' },
    { term: 'Bande di Bollinger', text: 'Una fascia disegnata attorno al prezzo: si allarga quando il mercato si agita e si stringe quando è calmo. Serve a capire se il prezzo è "stirato".' },
    { term: 'Stochastic', text: 'Come l\'RSI, misura se il prezzo è vicino ai massimi o ai minimi delle ultime candele.' },
    { term: 'Struttura di mercato', text: 'La sequenza di massimi e minimi che il prezzo disegna. Serve a capire la direzione di fondo, al di là del rumore quotidiano.' },
    { term: 'BOS', text: 'Break of Structure, rottura della struttura. Si ha quando il prezzo supera il massimo (o il minimo) precedente più importante: conferma che la direzione sta proseguendo.' },
    { term: 'CHoCH', text: 'Change of Character, cambio di carattere. È la prima rottura nella direzione opposta: segnala che il mercato sta forse cambiando passo.' },
    { term: 'Order block', text: 'Una zona di prezzo dove in precedenza sono passati ordini importanti di acquisto o di vendita. Quando il prezzo ci torna, tende a reagire.' },
    { term: 'Fair value gap', text: 'Una fascia di prezzo attraversata troppo in fretta, senza scambi equilibrati (si chiama anche squilibrio). Spesso il prezzo torna a "riempirla".' },
    { term: 'Mitigato', text: 'Una zona che il prezzo ha già visitato almeno una volta: la sua forza è ridotta.' },
    { term: 'Liquidità', text: 'La concentrazione di ordini di chiusura (gli stop) attorno a massimi o minimi uguali. Sono i punti dove si trova più facilmente controparte.' },
    { term: 'Sweep', text: 'Detto anche caccia allo stop: il prezzo supera di poco un livello, prende gli ordini fermi lì e poi torna indietro.' },
    { term: 'Premio / sconto', text: 'La metà alta (premio) e la metà bassa (sconto) dell\'intervallo di prezzo recente. In genere si compra in sconto e si vende in premio.' },
    { term: 'OTE', text: 'Optimal Trade Entry: la fascia fra il 62% e il 79% del ritracciamento di un movimento, considerata una buona zona di ingresso.' },
    { term: 'Sentiment', text: 'L\'umore del mercato: quali valute sono forti, che cosa stanno facendo gli investitori e se l\'ambiente favorisce o no il rischio.' },
    { term: 'Risk-on / risk-off', text: 'Risk-on significa che gli investitori accettano il rischio e preferiscono le valute legate alla crescita (dollaro australiano, neozelandese). Risk-off significa che cercano protezione (yen, franco svizzero, oro).' },
    { term: 'Lettura contraria', text: 'Quando la maggior parte degli operatori è schierata tutta da una parte, spesso il prezzo va dall\'altra. È il motivo per cui il posizionamento dei piccoli investitori si legge al contrario.' },
    { term: 'Stop loss', text: 'Il livello a cui si chiude l\'operazione in perdita, per non farla crescere troppo.' },
    { term: 'Obiettivo (take profit)', text: 'Il livello a cui si incassa il guadagno.' },
    { term: 'Rapporto rischio/rendimento', text: 'Quanto si rischia rispetto a quanto si punta a guadagnare. "2 a 1" significa rischiare 1 per provare a guadagnare 2.' },
    { term: 'Confluenza', text: 'Quando analisi diverse indicano la stessa cosa. Un segnale condiviso da più metodi è in genere più affidabile di uno isolato.' },
    { term: 'Volatilità', text: 'Quanto si muove il prezzo. Volatilità alta significa movimenti ampi ma anche più rischio.' },
    { term: 'Pip', text: 'La più piccola variazione normalmente quotata di un cambio. Per EUR/USD vale 0,0001; per le coppie in yen vale 0,01.' },
    { term: 'Candela', text: 'Il rettangolo che riassume il movimento del prezzo in un periodo: apertura, chiusura, massimo e minimo.' },
    { term: 'Candela in formazione', text: 'L\'ultima candela della serie: il suo intervallo non è ancora chiuso, quindi i suoi prezzi possono ancora cambiare.' },
    { term: 'Fonte dei dati', text: 'Il fornitore da cui arrivano i prezzi analizzati. In questa applicazione è Yahoo Finance, raggiunto attraverso un piccolo server locale: la pagina non parla mai direttamente con il fornitore.' },
    { term: 'Dati non aggiornati', text: 'Quando il fornitore non risponde, l\'app mostra l\'ultima copia scaricata dei dati reali: i numeri sono veri, ma possono essere fermi al momento del guasto.' },
    { term: 'Orizzonte', text: 'Quante candele in avanti si spinge la previsione. Più lungo è l\'orizzonte, maggiore è l\'incertezza.' },
    { term: 'Backtest', text: 'La simulazione delle regole su dati passati, per vedere come si sarebbero comportate.' },
    { term: 'Hit rate', text: 'La percentuale di operazioni chiuse in guadagno nella simulazione.' },
    { term: 'Drawdown', text: 'La perdita massima rispetto al punto di massimo guadagno: serve a capire il momento peggiore attraversato.' }
  ];

  // Termini che, se compaiono nel testo, devono avere una voce di glossario
  const TRACKED_TERMS = [
    'ATR', 'ADX', 'RSI', 'MACD', 'Bollinger', 'Stochastic', 'BOS', 'CHoCH',
    'order block', 'fair value gap', 'liquidità', 'sweep', 'premio', 'sconto',
    'OTE', 'sentiment', 'risk-on', 'risk-off', 'stop loss', 'obiettivo',
    'rischio/rendimento', 'confluenza', 'volatilità', 'pip', 'candela',
    'orizzonte', 'backtest', 'hit rate', 'drawdown', 'struttura',
    'COT', 'VIX', 'dollaro'
  ];

  /* ------------------------------------------------------------------ */
  /* Utilità di formattazione                                            */
  /* ------------------------------------------------------------------ */
  function build(ctx) {
    const D = global.ForexData;
    const inst = ctx.instrument;
    const a = ctx.analysis;
    const s = ctx.smc;
    const sen = ctx.sentiment;
    const c = ctx.confluence;
    const candles = ctx.candles;
    const digits = inst.digits;
    const last = candles[candles.length - 1];

    const px = function (v) { return Number(v).toFixed(digits); };
    const sign = function (v, d) { return (v >= 0 ? '+' : '') + Number(v).toFixed(d === undefined ? 1 : d); };
    const pipOf = function (v) { return D.pipsBetween(0, v, inst); };
    const sgn = function (v) { return v >= 0 ? 'sopra' : 'sotto'; };

    const tfName = TF_NAMES[ctx.tf] || ctx.tf;
    const tfMinutes = D.TIMEFRAMES[ctx.tf].minutes;
    const horizonHours = ctx.horizon * tfMinutes / 60;
    const horizonTxt = horizonHours >= 48
      ? (horizonHours / 24).toFixed(1).replace('.', ',') + ' giorni'
      : horizonHours.toFixed(0) + ' ore';
    const barTxt = tfMinutes >= 1440
      ? (tfMinutes / 1440) + ' giorno' + (tfMinutes > 1440 ? 'i' : '')
      : tfMinutes + ' minuti';

    // movimento recente su 20 candele
    const back = Math.min(20, candles.length - 1);
    const refClose = candles[candles.length - 1 - back].close;
    const chgPct = (last.close - refClose) / refClose * 100;
    const recentTxt = tfMinutes >= 1440
      ? back + ' giorni'
      : (back * tfMinutes / 60) >= 24 ? (back * tfMinutes / 60 / 24).toFixed(1) + ' giorni' : (back * tfMinutes / 60).toFixed(0) + ' ore';

    const blocks = [];
    const push = function (b) { blocks.push(b); };

    /* ================= 1. Il quadro in breve ================= */
    const dirWord = c.direction === 'BUY' ? 'rialzista' : c.direction === 'SELL' ? 'ribassista' : 'incerto';
    push({
      type: 'callout',
      tone: c.direction === 'BUY' ? 'bull' : c.direction === 'SELL' ? 'bear' : 'flat',
      title: 'Il quadro in breve',
      text: 'Su ' + ctx.pair + ' (' + tfName + ' per candela) il prezzo è ' + px(last.close) + '. ' +
        'Le tre analisi messe insieme danno un orientamento ' + dirWord +
        ' con confidenza ' + (c.confidence * 100).toFixed(0) + '%: ' + c.text
    });

    /* ================= 2. Che cosa sta facendo il mercato ================= */
    push({ type: 'h2', text: '1. Che cosa sta facendo il mercato adesso' });
    push({
      type: 'p',
      text: 'Stiamo osservando il cambio ' + ctx.pair + ' con candele da ' + barTxt +
        ': ogni candela (il rettangolo che riassume apertura, chiusura, massimo e minimo) ' +
        'racconta quello che è successo in ' + barTxt + '. Il prezzo attuale è ' + px(last.close) +
        ', mentre ' + recentTxt + ' fa era ' + px(refClose) + ', quindi nel periodo il prezzo è ' +
        (chgPct >= 0 ? 'salito' : 'sceso') + ' del ' + Math.abs(chgPct).toFixed(2) + '% (' +
        sign(pipOf(last.close - refClose), 0) + ' pip).'
    });

    const structureWord = a.score > 0.08 ? 'in salita' : a.score < -0.08 ? 'in discesa' : 'senza una direzione netta';
    push({
      type: 'p',
      text: 'Nel complesso il mercato si muove ' + structureWord + '. La forza del movimento si misura con l\'ADX ' +
        '(un indicatore da 0 a 100 che dice quanto la tendenza è solida): ora vale ' + a.adx.toFixed(0) +
        ', che significa ' + (a.adx > 25 ? 'una tendenza ben definita' : a.adx < 20 ? 'un mercato indeciso, che tende a tornare sui suoi passi' : 'una tendenza ancora debole') + '.'
    });
    push({
      type: 'p',
      text: 'I movimenti sono ' + (a.atrPct > 0.5 ? 'ampi' : a.atrPct < 0.15 ? 'contenuti' : 'nella media') +
        ': la candela tipica misura ' + px(a.atr) + ' di ampiezza, cioè lo ' + a.atrPct.toFixed(2) +
        '% del prezzo (questo valore si chiama ATR, l\'ampiezza media dei movimenti). ' +
        'Il prezzo si trova al ' + (s.range.position * 100).toFixed(0) + '% dell\'intervallo recente ' +
        px(s.range.low) + ' - ' + px(s.range.high) + ', quindi ' +
        (s.range.inDiscount ? 'nella metà bassa dello stesso' : 'nella metà alta dello stesso') + '.'
    });

    /* ================= 3. Analisi tecnica ================= */
    push({ type: 'h2', text: '2. Analisi tecnica: che cosa dicono i numeri' });
    push({
      type: 'p',
      text: 'L\'analisi tecnica studia i prezzi passati con formule matematiche chiamate indicatori. ' +
        'Nessuno di loro prevede il futuro: misurano cose diverse e vanno letti insieme. Ecco i principali.'
    });

    const ind = a.indicators;
    const i = a.index;
    const rows = [];
    const num = function (v, d) { return v == null ? 'n.d.' : Number(v).toFixed(d === undefined ? 1 : d); };

    rows.push(['Medie mobili (EMA 9, 21, 50)',
      'Il prezzo medio delle ultime candele: se il prezzo sta sopra, in media comanda chi compra.',
      ind.ema21[i] == null ? 'dati insufficienti'
        : (last.close > ind.ema21[i]
          ? 'il prezzo è sopra la media: ' + (a.score > 0 ? 'leggera prevalenza dei compratori' : 'ma senza grande convinzione')
          : 'il prezzo è sotto la media: ' + (a.score < 0 ? 'prevalenza dei venditori' : 'ma senza grande convinzione'))]);
    rows.push(['RSI (14)',
      'Confronta la forza dei rialzi con quella dei ribassi, da 0 a 100.',
      num(ind.rsi[i]) + '  ' + (ind.rsi[i] >= 70 ? '(mercato surriscaldato, possibile pausa)' : ind.rsi[i] <= 30 ? '(mercato scarico, possibile rimbalzo)' : '(nessuno dei due estremi)')]);
    rows.push(['MACD (12,26,9)',
      'Confronta una media veloce e una lenta: dice se la spinta sta aumentando o esaurendosi.',
      num(ind.macd.histogram[i] != null ? ind.macd.histogram[i] * Math.pow(10, inst.pipDecimals) : null) + ' pip  ' + (a.score > 0 ? '(spinta a favore dei rialzi)' : a.score < 0 ? '(spinta a favore dei ribassi)' : '(spinta debole)')]);
    rows.push(['Bande di Bollinger (20,2)',
      'Una fascia attorno al prezzo: quando il prezzo tocca un bordo, tende a essere "stirato".',
      '%B ' + num(ind.bb.percentB[i], 2) + '  ' + (ind.bb.percentB[i] > 0.95 ? '(sopra la banda superiore)' : ind.bb.percentB[i] < 0.05 ? '(sotto la banda inferiore)' : '(dentro la fascia)')]);
    rows.push(['Stochastic (14,3)',
      'Come l\'RSI, dice se il prezzo è vicino ai massimi o ai minimi recenti.',
      num(ind.stoch.k[i]) + (ind.stoch.k[i] >= 80 ? '  (vicino ai massimi)' : ind.stoch.k[i] <= 20 ? '  (vicino ai minimi)' : '  (zona centrale)')]);
    rows.push(['ADX (14)',
      'La forza della tendenza, non la sua direzione.',
      num(ind.adx[i]) + '  ' + (ind.adx[i] > 25 ? '(tendenza definita)' : ind.adx[i] < 20 ? '(nessuna tendenza)' : '(tendenza debole)')]);
    rows.push(['ATR (14)',
      'L\'ampiezza media di una candela: serve a scegliere uno stop adeguato.',
      px(a.atr) + ' (' + a.atrPct.toFixed(2) + '% del prezzo)']);
    push({ type: 'table', head: ['Indicatore', 'Che cosa misura', 'Valore e lettura'], rows: rows });

    const label = a.direction === 'BUY' ? 'ACQUISTO' : a.direction === 'SELL' ? 'VENDITA' : 'NEUTRO';
    push({
      type: 'callout',
      tone: a.direction === 'BUY' ? 'bull' : a.direction === 'SELL' ? 'bear' : 'flat',
      title: 'Verdetto dell\'analisi tecnica: ' + label,
      text: 'Confidenza ' + (a.confidence * 100).toFixed(0) + '% su 100. ' +
        'In parole semplici: la bilancia pende ' +
        (a.direction === 'BUY' ? 'dalla parte dei compratori' : a.direction === 'SELL' ? 'dalla parte dei venditori' : 'senza una direzione chiara') +
        ', con una forza ' + (Math.abs(a.score) > 0.45 ? 'marcata' : Math.abs(a.score) > 0.22 ? 'moderata' : 'debole') + '.'
    });

    push({
      type: 'p',
      text: 'Se il quadro restasse questo, in ' + horizonTxt + ' (' + ctx.horizon + ' candele) il modello si aspetta un movimento di ' +
        sign(pipOf(a.expectedMove), 1) + ' pip, portando il prezzo attorno a ' + px(a.price + a.expectedMove) + '. ' +
        'Attenzione: non è una promessa, è la stima centrale. La fascia di incertezza ragionevole va da ' +
        px(a.projection[a.projection.length - 1].lower) + ' a ' + px(a.projection[a.projection.length - 1].upper) +
        ', quindi il prezzo può finire ben lontano da quel valore. La probabilità di chiudere più in alto è del ' +
        (a.probabilityUp * 100).toFixed(0) + '%, quella di chiudere più in basso del ' + (a.probabilityDown * 100).toFixed(0) + '%.'
    });

    push({
      type: 'p',
      text: 'Se si volesse impostare un\'operazione seguendo questa lettura, i livelli sarebbero: ingresso ' + px(a.price) +
        ', obiettivo ' + px(a.target) + ' (' + sign(pipOf(a.target - a.price), 1) + ' pip) e stop loss ' +
        px(a.stop) + ' (' + sign(pipOf(a.stop - a.price), 1) + ' pip). Il rapporto rischio/rendimento è ' +
        a.rr.toFixed(2) + ' a 1: si rischia 1 per provare a guadagnare ' + a.rr.toFixed(2) + '.'
    });
    push({
      type: 'p',
      text: 'L\'analisi tecnica cambierebbe idea se il prezzo ' + (a.direction === 'SELL' ? 'risalisse oltre ' + px(a.stop) : 'scendesse sotto ' + px(a.stop)) +
        ', cioè se superasse in chiusura il livello che regge lo scenario.'
    });

    /* ================= 4. Smart Money Concepts ================= */
    push({ type: 'h2', text: '3. Smart Money Concepts: dove si muovono i grandi operatori' });
    push({
      type: 'p',
      text: 'Questa tecnica (in inglese Smart Money Concepts, cioè "le mosse dei soldi intelligenti") ' +
        'non usa formule: guarda dove il prezzo accelera, rallenta e lascia tracce, per capire dove banche e fondi ' +
        'potrebbero aver comprato o venduto. L\'idea di fondo è che i grandi operatori abbiano bisogno di molta ' +
        'controparte, e quindi cerchino le zone dove ci sono tanti ordini fermi.'
    });

    const ev = s.structure.lastEvent;
    push({
      type: 'callout',
      tone: s.score > 0 ? 'bull' : s.score < 0 ? 'bear' : 'flat',
      title: 'Struttura: ' + s.biasLabel + '   (punteggio ' + sign(s.score, 2) + ')',
      text: ev
        ? 'L\'ultimo evento importante è stato un ' + ev.type + ' (' + (ev.type === 'BOS' ? 'rottura della struttura in continuità' : 'cambio di carattere, cioè inversione') +
          ') ' + (ev.dir === 1 ? 'verso l\'alto' : 'verso il basso') + ' sul livello ' + px(ev.level) +
          ', avvenuto ' + (s.lastIndex - ev.index) + ' candele fa. Da quel momento il mercato ha ' +
          (s.structure.consecutive > 1 ? s.structure.consecutive + ' conferme consecutive nella stessa direzione.' : 'una sola conferma, quindi la direzione è ancora giovane.')
        : 'Non ci sono ancora rotture di struttura sufficientemente chiare: il mercato è in una fase di attesa.'
    });

    // Le zone si distinguono fra quelle a favore dello scenario e quelle
    // contrarie: le prime servono a entrare, le seconde a capire dove il
    // movimento potrebbe rallentare. La narrazione segue questa distinzione.
    const long = s.plan.direction === 1;
    const dirKind = long ? 'bullish' : 'bearish';
    const validObs = s.orderBlocks.filter(function (z) { return z.status !== 'invalidated'; });
    const obsFavor = validObs.filter(function (z) { return z.kind === dirKind; }).slice(-2).reverse();
    const obsAgainst = validObs.filter(function (z) { return z.kind !== dirKind; }).slice(-1).reverse();
    const obText = [];
    obsFavor.forEach(function (z) {
      obText.push('Zona di possibile ' + (long ? 'acquisto' : 'vendita') + ' fra ' + px(z.bottom) + ' e ' + px(z.top) +
        ': è l\u2019ultima area in cui la parte opposta ha perso il controllo prima della spinta' +
        (long ? ' verso l\u2019alto' : ' verso il basso') + ' (si chiama order block). ' +
        'Stato: ' + (z.status === 'fresh'
          ? 'non ancora visitata, quindi teoricamente ancora valida'
          : 'già visitata una volta, quindi più debole') + ', formata ' + z.age + ' candele fa.');
    });
    obsAgainst.forEach(function (z) {
      obText.push('Zona di possibile ostacolo fra ' + px(z.bottom) + ' e ' + px(z.top) +
        ': è un\u2019area di segno opposto allo scenario, dove il prezzo potrebbe rallentare. ' +
        (long ? 'Si trova sopra il prezzo' : 'Si trova sotto il prezzo') +
        (z.status === 'fresh' ? ' e non è ancora stata toccata.' : ' ed è già stata toccata una volta.'));
    });
    if (!obsFavor.length) {
      obText.push('In direzione dello scenario non ci sono zone di ingresso ancora valide: il riferimento per ' +
        'l\u2019ingresso diventa la metà dell\u2019intervallo di prezzo (' + px(s.range.equilibrium) + '), ' +
        'il livello che divide la zona di sconto da quella di premio.');
    }
    if (obText.length) push({ type: 'ul', items: obText });

    const validFvgs = s.fvgs.filter(function (z) { return z.status !== 'invalidated'; });
    const fvgsOpen = validFvgs.filter(function (z) { return !z.filled; });
    const fvgText = [];
    fvgsOpen.slice(-2).reverse().forEach(function (z) {
      fvgText.push('Fascia attraversata troppo in fretta fra ' + px(z.bottom) + ' e ' + px(z.top) +
        ' (si chiama fair value gap o squilibrio: il prezzo è passato senza scambi equilibrati). ' +
        'Il prezzo tende a tornarci: ' + (z.kind === dirKind
          ? 'è quindi un possibile punto di ingresso a favore dello scenario.'
          : 'se il prezzo ci arriva, potrebbe muoversi in fretta.'));
    });
    if (!fvgText.length && validFvgs.length) {
      fvgText.push('Gli squilibri recenti sono già stati tutti richiusi dal prezzo: in questo momento non ci sono ' +
        'fasce attraversate troppo in fretta a cui fare riferimento.');
    }
    if (fvgText.length) push({ type: 'ul', items: fvgText });

    const above = s.liquidity.filter(function (l) { return l.price > s.price; }).slice(0, 2);
    const below = s.liquidity.filter(function (l) { return l.price < s.price; }).slice(-2).reverse();
    const liqText = [];
    above.forEach(function (l) {
      liqText.push('Sopra il prezzo, a ' + px(l.price) + ', ci sono ' + l.members + ' massimi quasi uguali: ' +
        'è lì che si accumulano gli ordini di chiusura di chi ha venduto (la "liquidità' + '").' +
        (l.taken ? ' Quel livello è stato raggiunto e gli ordini sono stati presi.' : l.sweptAt != null ? ' Il livello è stato toccato con un falso superamento (sweep).' : ' Il livello non è ancora stato toccato.'));
    });
    below.forEach(function (l) {
      liqText.push('Sotto il prezzo, a ' + px(l.price) + ', ci sono ' + l.members + ' minimi quasi uguali: ' +
        'sono gli ordini di chi ha comprato a protezione delle proprie posizioni.' +
        (l.taken ? ' Quel livello è stato raggiunto.' : l.sweptAt != null ? ' Il livello è stato toccato con una finta rottura.' : ' Il livello non è ancora stato toccato.'));
    });
    if (liqText.length) push({ type: 'ul', items: liqText });

    push({
      type: 'p',
      text: 'Il prezzo si trova al ' + (s.range.position * 100).toFixed(0) + '% dell\'intervallo ' + px(s.range.low) + ' - ' + px(s.range.high) +
        ': la metà bassa si chiama "sconto" e la metà alta "premio". ' +
        (s.range.inDiscount ? 'Essendo in sconto, la zona è statisticamente più adatta agli acquisti che alle vendite.' : 'Essendo in premio, la zona è statisticamente più adatta alle vendite che agli acquisti.') +
        (s.range.inOte ? ' Il prezzo è dentro la fascia OTE, considerata una delle migliori per entrare.' : '')
    });

    const p = s.plan;
    push({
      type: 'callout',
      tone: p.direction === 1 ? 'bull' : 'bear',
      title: 'Scenario operativo SMC: ' + (p.direction === 1 ? 'rialzista (comprare)' : 'ribassista (vendere)'),
      text: 'Il piano prevede di entrare ' + (p.direction === 1 ? 'in acquisto' : 'in vendita') +
        (p.inZone
          ? ' al prezzo attuale, che si trova già dentro la zona di interesse'
          : Math.abs(p.limitEntry - p.marketEntry) <= a.atr * 0.35
            ? ' al prezzo attuale: il livello di ingresso calcolato (' + px(p.limitEntry) + ') è praticamente coincidente con il prezzo'
            : ' solo se il prezzo torna nella zona, con un ordine limite a ' + px(p.limitEntry)) +
        '. Lo stop loss sta a ' + px(p.stop) + ' (' + sign(Math.abs(pipOf(p.stop - p.marketEntry)), 1) + ' pip di distanza): oltre quel livello la lettura è sbagliata. ' +
        'Il primo obiettivo è ' + px(p.tp1) + ' (' + sign(pipOf(p.tp1 - p.marketEntry), 1) + ' pip), il secondo è ' + px(p.tp2) +
        (p.targetLiquidity ? ', dove si concentra la liquidità sopra/sotto il prezzo' : '') +
        '. Il rapporto rischio/rendimento è ' + p.rr.toFixed(2) + ' a 1.'
    });

    /* ================= 5. Sentiment ================= */
    push({ type: 'h2', text: '4. Sentiment: che cosa pensa il mercato' });
    push({
      type: 'p',
      text: 'Il sentiment (l\'umore del mercato) si legge da quattro cose: quali valute sono forti e quali deboli, ' +
        'che cosa stanno facendo i piccoli investitori, che cosa fanno gli investitori istituzionali e se l\'ambiente ' +
        'favorisce il rischio o la prudenza.'
    });

    if (sen.real) {
      /* ---- sezione sentiment su dati reali (CFTC COT + VIX + DXY) ---- */
      push({
        type: 'p',
        text: 'Questo studio di sentiment usa fonti reali e autorevoli: il posizionamento degli operatori ' +
          'finanziari dal report COT della CFTC (il regolatore degli futures USA; dati del ' + sen.scope.cotAsOf +
          '), l\'indice della paura VIX (dato del ' + (sen.risk && sen.risk.asOf ? sen.risk.asOf : '') +
          ') e l\'indice del dollaro DXY. Il pannello retail resta un modello simulato dichiarato ' +
          'ed è escluso dal punteggio.'
      });

      const basePos = sen.strength.byCurrency[sen.pair.base];
      const quotePos = sen.strength.byCurrency[sen.pair.quote];
      if (basePos && quotePos) {
        push({
          type: 'p',
          text: 'Posizionamento reale: ' + sen.pair.base + ' è al percentile ' + basePos.score.toFixed(0) +
            '/100 della sua storia di posizionamento a 5 anni' +
            (basePos.basis === 'COT' ? ' (netto ' + basePos.net.toFixed(1) + '% dell\'open interest)' : '') +
            ', mentre ' + sen.pair.quote + ' è al percentile ' + quotePos.score.toFixed(0) +
            (quotePos.basis === 'DXY' ? ' secondo l\'indice del dollaro' : ' (netto ' + quotePos.net.toFixed(1) + '% dell\'open interest)') +
            '. ' + (basePos.score > quotePos.score
              ? 'Il posizionamento di ' + sen.pair.base + ' è relativamente meno corto del solito: non pesa sulle quotazioni.'
              : 'Il posizionamento di ' + sen.pair.quote + ' è relativamente meno corto del solito e questo pesa su ' + sen.pair.base + '.')
        });
        push({
          type: 'p',
          text: 'I flussi della settimana COT: il posizionamento netto su ' + sen.pair.base +
            (basePos.change >= 0 ? ' è aumentato' : ' si è ridotto') + ' di ' +
            Math.abs(basePos.change).toFixed(1) + ' punti, un segnale ' +
            (basePos.change > 0.5 ? 'di acquisto istituzionale' : basePos.change < -0.5 ? 'di dismissione istituzionale' : 'sostanzialmente fermo') + '.'
        });
      }
      if (sen.risk) {
        push({
          type: 'p',
          text: 'L\'ambiente generale è "' + sen.risk.label + '" (' + sen.risk.score.toFixed(0) + '/100): il VIX vale ' +
            sen.risk.vix.toFixed(1) + ', cioè il percentile ' + sen.risk.vixPercentile.toFixed(0) +
            ' della sua distribuzione annua. ' + sen.risk.text +
            ' La volatilità misurata è ' + sen.risk.volLabel + ' (VIX ' +
            sen.risk.volRatio.toFixed(2) + ' volte la sua media delle ultime 50 sedute).'
        });
      }
      const instReal = sen.institutional;
      if (instReal && instReal.crowded && instReal.lightest) {
        push({
          type: 'p',
          text: 'Posizionamento istituzionale reale (COT): la divisa con il posizionamento più esteso è ' +
            instReal.crowded.currency + ' (percentile ' + instReal.crowded.net.toFixed(0) + ')' +
            (instReal.crowded.extreme ? ', zona estrema: lettura contraria probabilmente favorevole a ' + sen.pair.base : '') +
            '; la meno affollata è ' + instReal.lightest.currency + ' (percentile ' +
            instReal.lightest.net.toFixed(0) + ').'
        });
      }
    } else {
      const st = sen.strength.list;
      // Universo ridotto o misto: la classifica della forza va dichiarata per
      // ciò che è. La condizione autorevole è l'esclusione dal verdetto
      // (confluence.excluded), non il solo conteggio delle coppie reali:
      // in modalità simulata completa il sentiment pesa comunque.
      const sentimentExcluded = !!(c.excluded && c.excluded.indexOf('Sentiment') !== -1);
      const mixedScope = !sentimentExcluded && sen.scope &&
        sen.scope.realPairs >= 1 && sen.scope.simulatedPairs >= 1;
      let strengthIntro;
      if (sentimentExcluded) {
        strengthIntro = 'Nota: il confronto di forza usa solo le coppie con dati reali (' +
          sen.scope.realPairs + (sen.scope.realPairs === 1 ? ' coppia' : ' coppie') +
          ' su ' + (sen.scope.realPairs + sen.scope.simulatedPairs) +
          '), quindi la classifica è incompleta, le posizioni di mezzo sono parità ' +
          'e il sentiment è escluso dal verdetto finale. Le valute risultate più forti sono ';
      } else if (mixedScope) {
        strengthIntro = 'Nota: il confronto di forza usa tutte le coppie, di cui ' +
          sen.scope.realPairs + ' con dati reali e ' + sen.scope.simulatedPairs +
          ' simulate. Le valute più forti sono ';
      } else {
        strengthIntro = 'Guardando tutte le coppie disponibili, le valute più forti sono ';
      }
      push({
        type: 'p',
        text: strengthIntro +
          st.slice(0, 3).map(function (x) { return x.currency + ' (' + x.score.toFixed(0) + '/100)'; }).join(', ') +
          ', mentre le più deboli sono ' + st.slice(-3).map(function (x) { return x.currency + ' (' + x.score.toFixed(0) + '/100)'; }).join(', ') +
          '. Per il cambio che stiamo guardando conta il confronto fra le due valute che lo compongono: ' +
          sen.pair.base + ' è a ' + sen.strength.byCurrency[sen.pair.base].score.toFixed(0) + '/100 e ' +
          sen.pair.quote + ' a ' + sen.strength.byCurrency[sen.pair.quote].score.toFixed(0) + '/100, quindi ' +
          (sen.strength.byCurrency[sen.pair.base].score > sen.strength.byCurrency[sen.pair.quote].score
            ? 'la prima è più forte della seconda e questo sostiene le quotazioni.'
            : 'la seconda è più forte della prima e questo pesa sulle quotazioni.') +
          ' La forza è misurata sui movimenti delle ultime 5, 20 e 60 candele.'
      });

      if (sen.retail) {
        push({
          type: 'p',
          text: 'Dalla parte dei piccoli investitori risulta il ' + sen.retail.longPct.toFixed(0) + '% di posizioni al rialzo e il ' +
            sen.retail.shortPct.toFixed(0) + '% al ribasso (su circa ' + sen.retail.accounts.toLocaleString('it-IT') + ' conti). ' +
            'Quando la folla è molto sbilanciata da una parte si legge al contrario, perché di solito la maggioranza ha torto: ' +
            sen.retail.contrarianText + '. Nota: questo dato è un modello simulato, non arriva da un broker reale.'
        });
      }

      push({
        type: 'p',
        text: 'L\'ambiente generale è "' + sen.risk.label + '" (' + sen.risk.score.toFixed(0) + '/100). ' + sen.risk.text + ' ' +
          'La volatilità del mercato è ' + sen.risk.volLabel + ': le candele sono ' + sen.risk.volRatio.toFixed(2) +
          ' volte la loro ampiezza media recente. ' +
          'Gli investitori istituzionali risultano più esposti su ' + sen.institutional.crowded.currency +
          ' (' + sen.institutional.crowded.net.toFixed(0) + '% di posizioni lunghe) e più leggeri su ' +
          sen.institutional.lightest.currency + ' (' + sen.institutional.lightest.net.toFixed(0) + '%). Anche questo è un modello simulato.'
      });
    }

    push({
      type: 'callout',
      tone: sen.direction === 'BUY' ? 'bull' : sen.direction === 'SELL' ? 'bear' : 'flat',
      title: 'Verdetto del sentiment: ' + sen.bias,
      text: 'Punteggio ' + sign(sen.score, 2) + ' su una scala da -1 a +1, confidenza ' + (sen.confidence * 100).toFixed(0) + '%. ' +
        'Il sentiment cambia lentamente: non dà indicazioni di ingresso precise, serve soprattutto a capire se il vento soffia ' +
        'a favore o contro l\'operazione che si sta valutando.'
    });

    /* ================= 6. Mettere insieme i tre studi ================= */
    push({ type: 'h2', text: '5. I tre studi a confronto' });
    push({
      type: 'table',
      head: ['Studio', 'Orientamento', 'Punteggio', 'Confidenza'],
      rows: [
        ['Analisi tecnica (indicatori)', a.direction === 'BUY' ? 'rialzista' : a.direction === 'SELL' ? 'ribassista' : 'neutro', sign(a.score, 2), (a.confidence * 100).toFixed(0) + '%'],
        ['Smart Money Concepts (struttura e zone)', s.signal === 'BUY' ? 'rialzista' : s.signal === 'SELL' ? 'ribassista' : 'neutro', sign(s.score, 2), (s.confidence * 100).toFixed(0) + '%'],
        ['Sentiment (umore del mercato)', sen.direction === 'BUY' ? 'rialzista' : sen.direction === 'SELL' ? 'ribassista' : 'neutro', sign(sen.score, 2), (sen.confidence * 100).toFixed(0) + '%']
      ]
    });
    push({
      type: 'callout',
      tone: c.direction === 'BUY' ? 'bull' : c.direction === 'SELL' ? 'bear' : 'flat',
      title: 'Sintesi: ' + (c.direction === 'BUY' ? 'orientamento rialzista' : c.direction === 'SELL' ? 'orientamento ribassista' : 'nessuna indicazione operativa'),
      text: c.text + ' Punteggio complessivo ' + sign(c.score, 2) + ' con confidenza ' + (c.confidence * 100).toFixed(0) + '%. ' +
        (c.aligned
          ? 'Quando i tre studi dicono la stessa cosa, la lettura è più solida: si parla di confluenza.'
          : 'Con i tre studi non allineati è prudente aspettare che si accordino, oppure ridurre la dimensione dell\'operazione.')
    });

    push({
      type: 'p',
      text: 'Che cosa guardare per cambiare idea: l\'analisi tecnica verrebbe annullata oltre ' + px(a.stop) +
        ', lo scenario SMC oltre ' + px(p.stop) + '. Il sentiment invece non si annulla con un livello preciso: ' +
        (sen.real
          ? 'si aggiorna con il report COT della CFTC (ogni venerdì, dati di martedì) e con il regime del VIX.'
          : 'cambia quando la forza dell\'' + (sen.pair.base === 'USD' ? 'euro' : sen.pair.base) +
            ' smette di prevalere su quella della valuta opposta.')
    });

    /* ================= 6. La fonte dei dati ================= */
    const src = ctx.source || null;
    const srcInfo = src && src.info;
    if (srcInfo || (src && src.error)) {
      push({ type: 'h2', text: '6. La fonte dei dati' });
      if (srcInfo) {
        push({
          type: 'p',
          text: 'Questo report usa i prezzi reali di ' + ctx.pair + ' forniti da ' +
            (srcInfo.provider || 'Yahoo Finance') + ' (' + (srcInfo.yahooSymbol || '') + '), ' +
            'raggiunto attraverso il ponte locale: la pagina non contatta mai il fornitore direttamente.'
        });
        const lastBarTxt = new Date(srcInfo.lastBarTime || last.time).toLocaleString('it-IT');
        const items = [
          'Timeframe ' + tfName + ': candele ' + (srcInfo.interval || '') +
            (srcInfo.aggregated ? ' ricostruite dalle candele più piccole del fornitore' : '') + '.',
          'Storico disponibile: ' + (srcInfo.history || 'quello fornito dal fornitore') + '.',
          'L\u2019analisi usa le ultime ' + srcInfo.bars + ' candele; l\u2019ultima è delle ' + lastBarTxt + '.'
        ];
        if (srcInfo.forming) {
          items.push('L\u2019ultima candela è ancora in formazione: i suoi prezzi possono ancora cambiare ' +
            'prima della chiusura del suo intervallo.');
        }
        if (srcInfo.stale) {
          items.push('Dati non aggiornati: il fornitore non risponde adesso e l\u2019app mostra l\u2019ultima ' +
            'copia scaricata (' + (srcInfo.note || 'errore di rete') + ').');
        }
        push({ type: 'ul', items: items });
      } else {
        push({
          type: 'callout',
          tone: 'flat',
          title: 'Attenzione: questo report usa dati simulati',
          text: 'Il ponte dati non è raggiungibile (' + (src.error || 'nessuna informazione') + '): ' +
            'l\u2019analisi è calcolata su una storia finta che riproduce le proprietà statistiche dei ' +
            'prezzi reali. I numeri qui dentro servono per esercitarsi e capire lo strumento, non per operare davvero.'
        });
      }
    }

    /* ================= 7. Glossario ================= */
    push({ type: 'h2', text: '7. Glossario dei termini usati' });
    push({
      type: 'p',
      text: 'Qui sotto ci sono, in ordine alfabetico, tutte le espressioni tecniche che compaiono nel report, spiegate in una riga.'
    });
    push({ type: 'glossary', items: GLOSSARY });

    return {
      pair: ctx.pair,
      tf: ctx.tf,
      tfName: tfName,
      generatedAt: new Date(),
      price: last.close,
      direction: c.direction,
      // modalità dati: serve al piede del testo (i prezzi dichiarati simulati
      // o reali devono coincidere con la sezione "La fonte dei dati")
      sourceMode: (ctx.source && ctx.source.mode) || 'sim',
      blocks: blocks,
      glossary: GLOSSARY,
      trackedTerms: TRACKED_TERMS
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rendering in testo semplice (copia e download)                      */
  /* ------------------------------------------------------------------ */
  function toText(r) {
    const D = global.ForexData;
    const lines = [];
    const rule = '='.repeat(72);
    lines.push(rule);
    lines.push('REPORT DI MERCATO - ' + r.pair + ' su candele da ' + r.tfName);
    lines.push('Generato il ' + r.generatedAt.toLocaleString('it-IT'));
    lines.push(rule);
    lines.push('');

    r.blocks.forEach(function (b) {
      if (b.type === 'h2') {
        lines.push('');
        lines.push(b.text.toUpperCase());
        lines.push('-'.repeat(Math.min(72, b.text.length + 4)));
        lines.push('');
      } else if (b.type === 'p') {
        lines.push(b.text);
        lines.push('');
      } else if (b.type === 'ul') {
        b.items.forEach(function (it) { lines.push('  - ' + it); });
        lines.push('');
      } else if (b.type === 'callout') {
        lines.push('>> ' + b.title);
        lines.push('   ' + b.text);
        lines.push('');
      } else if (b.type === 'table') {
        b.rows.forEach(function (row) {
          lines.push('  ' + row.join(' | '));
        });
        lines.push('');
      } else if (b.type === 'glossary') {
        b.items.forEach(function (g) {
          lines.push('  * ' + g.term + ': ' + g.text);
        });
        lines.push('');
      }
    });

    lines.push(rule);
    lines.push('Avvertenza: report a scopo didattico e dimostrativo. ' +
      (r.sourceMode === 'real'
        ? 'I prezzi sono reali, forniti da un servizio non ufficiale che può avere'
        : 'I prezzi sono simulati e le prestazioni mostrate dal backtest non'));
    lines.push(r.sourceMode === 'real'
      ? 'ritardi o interruzioni. Nessuna indicazione qui contenuta è una consulenza'
      : 'sono rappresentative di un conto reale. Nessuna indicazione qui');
    lines.push('finanziaria o una promessa di guadagno. Il trading comporta il');
    lines.push('rischio di perdere il capitale.');
    lines.push(rule);
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* Rendering in HTML (finestra del report)                             */
  /* ------------------------------------------------------------------ */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function toHtml(r) {
    const parts = [];
    r.blocks.forEach(function (b) {
      if (b.type === 'h2') {
        parts.push('<h3 class="rep-h2">' + esc(b.text) + '</h3>');
      } else if (b.type === 'p') {
        parts.push('<p class="rep-p">' + esc(b.text) + '</p>');
      } else if (b.type === 'ul') {
        parts.push('<ul class="rep-ul">' + b.items.map(function (it) {
          return '<li>' + esc(it) + '</li>';
        }).join('') + '</ul>');
      } else if (b.type === 'callout') {
        parts.push('<div class="rep-callout ' + b.tone + '">' +
          '<div class="rep-callout-title">' + esc(b.title) + '</div>' +
          '<div>' + esc(b.text) + '</div></div>');
      } else if (b.type === 'table') {
        parts.push('<table class="rep-table"><thead><tr>' +
          b.head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          b.rows.map(function (row) {
            return '<tr>' + row.map(function (cell, k) {
              return '<td' + (k === 0 ? ' class="rep-first"' : '') + '>' + esc(cell) + '</td>';
            }).join('') + '</tr>';
          }).join('') + '</tbody></table>');
      } else if (b.type === 'glossary') {
        parts.push('<dl class="rep-glossary">' + b.items.map(function (g) {
          return '<dt>' + esc(g.term) + '</dt><dd>' + esc(g.text) + '</dd>';
        }).join('') + '</dl>');
      }
    });
    return parts.join('');
  }

  global.Report = {
    build: build,
    toText: toText,
    toHtml: toHtml,
    GLOSSARY: GLOSSARY,
    TRACKED_TERMS: TRACKED_TERMS,
    TF_NAMES: TF_NAMES
  };
})(window);
