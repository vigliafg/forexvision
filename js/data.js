/* =========================================================================
 * data.js - Generatore di serie storiche di mercato forex
 * -------------------------------------------------------------------------
 * L'applicazione funziona completamente offline: le serie OHLC vengono
 * sintetizzate con un modello stocastico che riproduce alcune proprieta'
 * statistiche dei prezzi reali:
 *   - moto browniano geometrico per il prezzo
 *   - regimi di trend persistenti (drift che cambia lentamente)
 *   - clustering di volatilita' (volatilita' mean-reverting)
 *   - code grasse (shock occasionali)
 *   - volumi correlati all'ampiezza della candela
 * Il seed e' deterministico (coppia + timeframe) cosi' i risultati sono
 * riproducibili, ma il tasto "Aggiorna" cambia il seed e produce un nuovo
 * scenario, simulando l'arrivo di nuove barre.
 * ========================================================================= */
(function (global) {
  'use strict';

  /* ---------- PRNG deterministico (mulberry32) ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rand) {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---------- Strumenti negoziabili ----------
   * volatility = parametro di volatilita' per barra. E' calibrato in modo che
   *   l'ATR giornaliero generato corrisponda ai valori tipici di mercato
   *   riportati qui sotto (in % del prezzo), verificati da tests/calibration.html
   *   e controllati automaticamente da tests/selfcheck.html:
   *     EUR/USD 0,62  GBP/USD 0,75  USD/JPY 0,70  USD/CHF 0,58  AUD/USD 0,85
   *     USD/CAD 0,62  NZD/USD 0,90  EUR/GBP 0,48  EUR/JPY 0,85  GBP/JPY 1,05
   *     AUD/JPY 1,05  EUR/AUD 0,75  XAU/USD 1,35  XAG/USD 2,20
   * pipDecimals = decimali che compongono un pip: 4 per le coppie a 5 decimali
   *   (1 pip = 0,0001), 2 per le coppie in yen (1 pip = 0,01), 2 per l'oro
   *   (1 pip = 0,01 USD), 3 per l'argento (1 pip = 0,001 USD).
   * spread = spread tipico in pip.                                              */
  const INSTRUMENTS = [
    { symbol: 'EUR/USD', base: 1.0865, pipDecimals: 4, digits: 5, volatility: 0.212, spread: 0.6, type: 'major' },
    { symbol: 'GBP/USD', base: 1.2680, pipDecimals: 4, digits: 5, volatility: 0.247, spread: 0.9, type: 'major' },
    { symbol: 'USD/JPY', base: 149.35, pipDecimals: 2, digits: 3, volatility: 0.231, spread: 0.7, type: 'major' },
    { symbol: 'USD/CHF', base: 0.8860, pipDecimals: 4, digits: 5, volatility: 0.206, spread: 1.0, type: 'major' },
    { symbol: 'AUD/USD', base: 0.6560, pipDecimals: 4, digits: 5, volatility: 0.281, spread: 1.0, type: 'major' },
    { symbol: 'USD/CAD', base: 1.3590, pipDecimals: 4, digits: 5, volatility: 0.217, spread: 1.1, type: 'major' },
    { symbol: 'NZD/USD', base: 0.5985, pipDecimals: 4, digits: 5, volatility: 0.323, spread: 1.4, type: 'major' },
    { symbol: 'EUR/GBP', base: 0.8575, pipDecimals: 4, digits: 5, volatility: 0.161, spread: 1.2, type: 'cross' },
    { symbol: 'EUR/JPY', base: 162.30, pipDecimals: 2, digits: 3, volatility: 0.296, spread: 1.3, type: 'cross' },
    { symbol: 'GBP/JPY', base: 189.45, pipDecimals: 2, digits: 3, volatility: 0.355, spread: 2.1, type: 'cross' },
    { symbol: 'AUD/JPY', base: 97.950, pipDecimals: 2, digits: 3, volatility: 0.354, spread: 1.8, type: 'cross' },
    { symbol: 'EUR/AUD', base: 1.6560, pipDecimals: 4, digits: 5, volatility: 0.240, spread: 1.9, type: 'cross' },
    { symbol: 'XAU/USD', base: 2342.50, pipDecimals: 2, digits: 2, volatility: 0.443, spread: 25.0, type: 'metal' },
    { symbol: 'XAG/USD', base: 29.450, pipDecimals: 3, digits: 3, volatility: 0.695, spread: 30.0, type: 'metal' }
  ];

  /* ---------- Timeframe: minuti per candela e barre generate ---------- */
  const TIMEFRAMES = {
    M5:  { minutes: 5,    bars: 420 },
    M10: { minutes: 10,   bars: 420 },
    M15: { minutes: 15,   bars: 420 },
    H1:  { minutes: 60,   bars: 440 },
    H4:  { minutes: 240,  bars: 420 },
    D1:  { minutes: 1440, bars: 400 }
  };

  const SESSION_PROFILE = [ // attivita' relativa per ora UTC (0-23)
    0.55, 0.45, 0.40, 0.42, 0.50, 0.62, 0.78, 0.95, 1.20, 1.35, 1.25, 1.05,
    0.95, 1.15, 1.45, 1.55, 1.40, 1.15, 0.95, 0.80, 0.70, 0.65, 0.58, 0.55
  ];

  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * Genera una serie OHLC.
   * @param {string} symbol  es. "EUR/USD"
   * @param {string} tf      "M5" | "M15" | "H1" | "H4" | "D1"
   * @param {number} salt    variazione del seed (tasto Aggiorna)
   * @returns {{instrument:Object, timeframe:string, candles:Array}}
   */
  function generateSeries(symbol, tf, salt) {
    const instrument = INSTRUMENTS.find(function (i) { return i.symbol === symbol; });
    if (!instrument) throw new Error('Strumento sconosciuto: ' + symbol);
    const config = TIMEFRAMES[tf] || TIMEFRAMES.H1;
    salt = salt || 0;

    const rand = mulberry32(hashSeed(symbol + '|' + tf + '|' + salt));
    const n = config.bars;
    const candles = [];

    // Volatilita' per barra: la volatilita' giornaliera viene ripartita sul
    // numero di barre della giornata (scaling con la radice del tempo).
    const barsPerDay = 1440 / config.minutes;
    const baseVol = (instrument.volatility / 100) / Math.sqrt(barsPerDay);

    let price = instrument.base * (1 - (rand() - 0.5) * 0.04);
    let vol = baseVol;
    let drift = 0;
    let regimeLeft = 0;

    // Ora di partenza: n barre indietro rispetto ad adesso, arrotondata
    const now = new Date();
    const stepMs = config.minutes * 60000;
    let t0 = Math.floor(now.getTime() / stepMs) * stepMs - (n - 1) * stepMs;

    for (let i = 0; i < n; i++) {
      // --- cambio di regime ---
      if (regimeLeft <= 0) {
        regimeLeft = 30 + Math.floor(rand() * 70);
        // Sui cambi il drift e' molto piccolo rispetto alla volatilita'
        // (i mercati valutari sono vicini a un random walk): questo mantiene
        // l'ADX e i risultati del backtest su livelli credibili.
        drift = (rand() - 0.5) * baseVol * 0.26;
        // occasionalmente un trend piu' direzionale
        if (rand() < 0.22) drift *= 1.7;
      }
      regimeLeft--;

      // --- volatilita' mean-reverting con clustering ---
      // Il processo oscilla attorno a baseVol: il pavimento evita volatilita'
      // nulla e il tetto impedisce shock irrealistici (oltre ~2,5 volte la
      // volatilita' tipica l'ATR non deve schizzare).
      const volShock = gaussian(rand) * baseVol * 0.15;
      vol = vol * 0.93 + baseVol * 0.07 + volShock;
      if (rand() < 0.010) vol *= 1.5 + rand() * 0.6;     // shock di volatilita'
      vol = Math.max(baseVol * 0.40, Math.min(baseVol * 2.6, vol));

      const open = price;
      const ret = drift + gaussian(rand) * vol;
      let close = open * (1 + ret);

      // --- ombre high/low realistiche ---
      const body = Math.abs(close - open);
      const wickBase = Math.max(body, open * vol * 0.65);
      const upper = wickBase * (0.35 + rand() * 1.15);
      const lower = wickBase * (0.35 + rand() * 1.15);
      let high = Math.max(open, close) + upper;
      let low = Math.min(open, close) - lower;

      // --- volume correlato al movimento e alla sessione ---
      const date = new Date(t0 + i * stepMs);
      const hourFactor = SESSION_PROFILE[date.getUTCHours()] || 0.8;
      const moveFactor = Math.abs(ret) / baseVol;
      const volume = Math.round(
        (900 + 2600 * Math.min(3.5, moveFactor)) * hourFactor * (0.7 + rand() * 0.6)
      );

      close = round(close, instrument.digits);
      high = round(Math.max(high, close, open), instrument.digits);
      low = round(Math.min(low, close, open), instrument.digits);

      candles.push({
        time: t0 + i * stepMs,
        open: round(open, instrument.digits),
        high: high,
        low: low,
        close: close,
        volume: volume
      });

      price = close;
    }

    return { instrument: instrument, timeframe: tf, candles: candles };
  }

  function round(value, digits) {
    const f = Math.pow(10, digits);
    return Math.round(value * f) / f;
  }

  function pipSize(instrument) {
    return Math.pow(10, -instrument.pipDecimals);
  }

  function formatPrice(value, instrument) {
    return Number(value).toFixed(instrument ? instrument.digits : 5);
  }

  /** Variazione in pip fra due prezzi. */
  function pipsBetween(a, b, instrument) {
    return (b - a) / pipSize(instrument);
  }

  global.ForexData = {
    INSTRUMENTS: INSTRUMENTS,
    TIMEFRAMES: TIMEFRAMES,
    generateSeries: generateSeries,
    pipSize: pipSize,
    formatPrice: formatPrice,
    round: round,
    pipsBetween: pipsBetween,
    instrumentBySymbol: function (s) {
      return INSTRUMENTS.find(function (i) { return i.symbol === s; });
    }
  };
})(window);
