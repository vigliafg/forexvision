# Report di verifica della correttezza — ForexVision

*Verifica eseguita il 12/10/2026 su dati reali EUR/USD timeframe giornaliero (D1).*
*Metodo: esecuzione dei moduli JS in Node.js su dati scaricati dal ponte reale,
confronto con un'implementazione di riferimento indipendente (Python/NumPy,
scritta da zero dalle definizioni standard) e test di causalità su serie troncate.*

---

## Sintesi

| Area | Verdetto |
|---|---|
| 1. Analizza dati reali | **CONFERMATO** — prezzi veri di Yahoo Finance, cross-verified con la BCE |
| 2. Calcoli degli indicatori reali e corretti | **CONFERMATI** su 10/11 indicatori (differenza max ~1e-13); ADX è una variante semplificata dichiarata ma sistematicamente più alta dello standard Wilder |
| Causalità / assenza di look-ahead | **CONFERMATO** — 92 confronti su serie troncate, 0 violazioni |
| Difetti trovati | 1 difetto reale nel punteggio SMC (segno OB/FVG nel ramo ribassista, con narrazione contraddittoria) + 3 rilievi minori — **corretti e riverificati, vedi §8** |

---

## 1. Il programma analizza dati reali? — SÌ

Il ponte `server.py` scarica le candele dall'endpoint non ufficiale Yahoo Finance
(`EURUSD=X`), le ripulisce e le consegna al motore di analisi. Verifiche eseguite:

**a) Scaricamento reale funziona.** `/api/candles?tf=D1&symbol=EUR/USD` ha
restituito **1300 candele giornaliere** (2021-10-11 → 2026-10-12), 0 candele
scartate, 0 violazioni OHLC (`high ≥ max(open,close) ≥ min(open,close) ≥ low > 0`),
ordine cronologico senza duplicati, ultima candela marcata `forming`.
5 anni × ~260 sedute = ~1300: la serie è completa e le pause di mercato sono
state effettivamente escluse.

**b) I prezzi sono veri, non inventati.** Confronto indipendente con i tassi
ufficiali di riferimento della **BCE** (fonte Frankfurter, indipendente da Yahoo):

- 23 giorni sovrapposti (2021, 2022, 2026): differenza media **38,7 pip**, tutte
  compatibili con l'orario diverso della fix BCE (16:00 CET) rispetto alla
  chiusura della seduta Yahoo;
- la serie riproduce la storia vera di EUR/USD: minimo delle chiusure **0,95962**
  (settembre 2022, era della parità — minimo intraday reale 0,9536 il 28/9/2022,
  giorno in cui la differenza con la fix BCE è massima, 143 pip, perché la fix
  cadde a metà del crollo prima del violento recupero intraday di quella seduta);
- volatilità giornaliera misurata dai dati: **0,475%**, nella norma reale di
  EUR/USD (~0,5%).

**c) Il motore di analisi usa davvero questi dati.** L'analisi calcolata in
Node sui dati del ponte produce valori coerenti con il mercato reale (vedi §4).
La modalità di fallback simulata esiste ma è esplicitamente dichiarata dal badge;
solo EUR/USD è collegata al reale, le altre 13 coppie portano l'etichetta `sim`.

**d) Ricostruzione M10 verificata** (timeframe predefinito dell'app): 1500 candele
tutte allineate al bordo dei 10 minuti, OHLC coerenti, 0 scarti — la
ricostruzione ×2 dalle candele a 5 minuti è corretta.

---

## 2. Gli indicatori sono reali e corretti? — SÌ (con una riserva su ADX)

Confronto puntuale sui **dati reali D1** tra la libreria `js/indicators.js`
(eseguita in Node) e un'implementazione di riferimento indipendente in
Python/NumPy scritta dalle definizioni standard:

| Indicatore | Valore JS (ultima barra) | Riferimento | Differenza max (ultime 30 barre) |
|---|---|---|---|
| EMA(9) | 1,125527 | 1,125527 | 0,00e+00 |
| EMA(21) | 1,134695 | 1,134695 | 0,00e+00 |
| EMA(50) | 1,144032 | 1,144032 | 0,00e+00 |
| SMA(200) | 1,159642 | 1,159642 | 1,3e-15 |
| RSI(14) Wilder | 22,532624 | 22,532624 | 0,00e+00 |
| ATR(14) Wilder | 0,006310 | 0,006310 | 0,00e+00 |
| MACD line (12,26) | -0,009157 | -0,009157 | 0,00e+00 |
| MACD signal (9) | -0,007707 | -0,007707 | 0,00e+00 |
| Bollinger(20,2) up/mid/low | 1,158596 / 1,135923 / 1,113250 | identici | ~1,1e-15 |
| Stochastic %K(14) | 11,577123 | 11,577123 | 7,1e-15 |
| Stochastic %D(3) | 13,073475 | 13,073475 | 1,1e-13 |
| **ADX(14)** | **69,7** | **49,8** | **sistematica, vedi sotto** |

**Le differenze dell'ordine di 1e-13 sono rumore di virgola mobile**: gli
indicatori sono implementati **esattamente** secondo le definizioni standard
(seed dell'EMA = SMA dei primi `p` valori, smoothing di Wilder per RSI e ATR,
TR a tre rami, allineamento senza off-by-one nel MACD e nello Stochastic).

Punti di dettaglio verificati e corretti:

- **RSI**: inizializzazione di Wilder (media dei primi 14 delta) + smoothing
  `(prev*(p-1)+x)/p` — formula standard, combacia a 0.
- **ATR**: media di Wilder corretta, parte da TR[1] (primo TR disponibile).
- **MACD**: l'EMA del signal è calcolata sul segmento denso della linea MACD
  (indici validi), senza disallineamenti.
- **Bollinger**: deviazione standard **popolazionale** (÷n), la convenzione di
  TradingView e delle piattaforme di trading (chi si aspetta la variante
  campionaria di pandas vedrà bande leggermente più larghe: differenza ~2%).
- **`normalCdf`** (probabilità di tocco dei livelli): approssimazione di
  Abramowitz & Stegun 7.1.26, errore max verificato **7e-8** — corretta per l'uso.

### ADX: variante semplificata, sistematicamente più alta

*Corretto successivamente: vedi §8 — ora è l'ADX standard di Wilder.*

`js/indicators.js` dichiara nel commento «ADX semplificato» e usa **EMA** al
posto dello smoothing di Wilder sia per i DM/TR sia per l'ADX della DX. Risultato
sugli stessi dati reali: ultime 30 barre, media **46,2 (JS) contro 33,2 (Wilder)**.
L'effetto pratico è che il regime «direzionale» del motore previsionale
(`trendRegime = (ADX-18)/22`) si attiva più spesso e più presto: nelle ultime 30
sedute giornaliere il regime JS è a fondo scala in 16 giorni contro 7 dello
standard, e in 13 giorni su 30 i pesi adattivi risultano diversi (>0,2 di
differenza). **Non è un errore di calcolo** (la formula fa quello che dichiara)
ma una calibrazione diversa dallo standard: chi confronta l'ADX dell'app con
TradingView/MetaTrader troverà numeri sensibilmente più alti. Il README non lo
dichiara («ADX(14)» generico).

---

## 3. Causalità (no look-ahead) — CONFERMATA

Test su dati reali: ricalcolo con la serie **troncata** alla barra i e confronto
con il valore prodotto dalla serie completa. 92 confronti (4 barre di test,
14 indicatori/serie ciascuno, più MACD/Stoch/Bollinger), **0 violazioni**:

- indicatori alla barra i: invariati (1 e 2);
- `scoreAtIndex(ind, i)` del motore previsionale: invariato;
- eventi di struttura SMC (BOS/CHoCH): identici sulla serie troncata — gli swing
  usano la conferma frattale (`confirmedAt = i + lookback`) e il loop della
  struttura li rende disponibili solo dopo la conferma: causale;
- backtest walk-forward verificato per ricostruzione sezionale del trade:
  `entry = close[i] ± spread`, `exit = close[i+h]`, `R = (exit-entry)·dir/ATR[i]`,
  ultimo trade ammesso solo se `i + h < length`. **Nessun accesso al futuro.**

---

## 4. Test su EUR/USD D1 reale — risultati dell'analisi

Situazione al 12/10/2026 (prezzo 1,11957):

**Analisi tecnica** (motore previsionale): verdetto **SELL**, score **-0,533**,
confidenza 73,7%, probabilità rialzista 12,8%, movimento atteso -65,9 pip su 10
giorni, ATR(14) 63,1 pip (0,56%). Le otto componenti sono **coerenti con il
mercato reale**: prezzo sotto SMA200 di 630 pip, stack EMA ribassista, RSI 22,5
(ipercomprato → smorzato dal codice), ADX alto, tutte le componenti ribassiste
tranne Bollinger (+0,72, ritorno alla media) che il regime direzionale riduce a
peso 0,050. Lettura corretta del quadro: **forte trend ribassista con prezzo
iperesteso**.

**SMC**: struttura ribassista (ultimo CHoCH ribassista 19 barre fa su 1,15670),
249 swing, 103 eventi di struttura (54 BOS, 49 CHoCH), 22 order block, 235 FVG
di cui 9 freschi, liquidità target a 1,10705 (2 minimi uguali). Piano operativo
internamente coerente (ingresso limite, stop oltre la zona, TP1 equilibrio,
TP2 liquidità, R:R 3,37) — ma con i difetti narrativi descritti in §5.

**Backtest walk-forward** (ultime 250 sedute, orizzonte 5 giorni): 180 trade,
hit rate 47,2%, R medio **-0,072**, profit factor 0,88, max drawdown 41,9 R.
Un segnale di **correttezza**: senza look-ahead e con lo spread a carico, il
modello mostra onestamente di **non avere un vantaggio statisticamente
significativo** sul giornaliero — un motore truccato restituirebbe curve tutte
positive.

---

## 5. Difetti e incoerenze trovati

### D1 — Segno del punteggio OB/FVG nel ramo ribassista di SMC (difetto reale, gravità media)

*Corretto successivamente: vedi §8.*

In `js/smc.js`, i punteggi di order block e fair value gap sono una **qualità
positiva** (0…1) che non riceve mai il segno della bias:

```js
obScore  = z.status === 'fresh' ? 1 : 0.6;   // sempre ≥ 0
fvgScore = (fresh ? 1 : 0.55) * (1 - dist/6) + 0.1;  // sempre ≥ 0
```

In bias **ribassista** la zona trovata è sopra il prezzo (OB/FVG ribassista,
zona di ritracciamento da vendere), ma il contributo resta **positivo**, cioè
rialzista: la presenza della zona spinge il verdetto **contro** la tesi di
struttura. Sul dato reale di oggi: `structure -0,68` e `range -0,86`, ma
`ob +0,22` e `fvg +0,86` con FVG trovato ribassista a 1,1285-1,1329 (sopra il
prezzo). Con il segno corretto il punteggio SMC sarebbe ≈ **-0,50** invece di
**-0,21**: l'impatto sul verdetto non è trascurabile (peso combinato OB+FVG = 30%).

### D2 — Narrazione SMC contraddittoria nel ramo ribassista (stesso root cause)

*Corretto successivamente: OB/FVG in §8, range in §9.*

Evidenza dai dati reali di oggi (output reale del modulo):

```
[bear] Premium / Discount: Prezzo in premio: area di vendita istituzionale
       — 7% del range 1.11623 - 1.16537 (sconto).
[bull] Order Block: Order block rialzista non mitigato sotto il prezzo
       — OB ribassista 1.15275 - 1.15527 (tested, a 5.3 ATR).
[bull] Fair Value Gap: Squilibrio rialzista ancora da colmare
       — FVG 1.12853 - 1.13293 (aperto).
```

Il tono (`tone`) è scelto dal segno del punteggio, i testi `bull`/`bear`
descrivono la dottrina classica: nel ramo ribassista il risultato è che il
testo dice «premio» mentre i dati dicono «sconto (7%)», e un OB «rialzista
sotto il prezzo» mentre il dettaglio dice «OB ribassista ... sopra». Nel ramo
rialzista i testi invece combaciano. Nota anche la prima riga di range: «zona di
sconto, favorevole agli acquisti» con tono bear — messaggio misto per il lettore.

### D3 — ADX semplificato (già trattato in §2)

Dichiarato nel sorgente ma non nel README; produce regimi direzionali più
frequenti del consueto e quindi pesi adattivi diversi da un'implementazione
Wilder.

### D4 — Storia intraday dichiarata ma troncata a 1500 barre (minore)

`MAX_BARS = 1500` in `server.py`: il M10 dichiara «60 giorni di storia» ma il
motore riceve solo le ultime ~10 sedute (1500 barre × 10 min). Il D1 non è
toccati (1300 < 1500). L'etichetta di profondità andrebbe coerenziata o il
limite alzato per gli intraday.

### D5 — R:R del piano tecnico strutturalmente < 1 (nota di design)

`tpDistance = max(|move|, 1,15·ATR)` e `slDistance = max(1,45·ATR, …)`: col
valore tipico il rapporto esce ~0,79 **per costruzione** (verificato: TP -72,6
pip, SL +91,5 pip, R:R 0,79). Non è un bug di calcolo, ma il piano tecnico
 compensa solo se l'hit rate supera ~55%: va saputo, e il backtest reale
(47,2%) dice che oggi non lo fa.

### D6 — Limiti dichiarati del backtest (onesti)

Trade sovrapposti una barra sì e una no (statistiche non indipendenti), esito
valutato solo alla chiusura di h barre dopo (nessuno stop intrabar). Il codice
lo dichiara; le statistiche restano descriptive.

### Punti minori

- Candele D1 datate alle 23:00 UTC (convenzione Yahoo per il forex): solo
  cosmetica.
- Volumi assenti per EUR/USD su Yahoo: gestiti correttamente (`hasVolume=false`,
  «n.d.», nessun NaN — verificato su 1300 candele).
- I pool di liquidità comprendono swing dell'intera storia di 5 anni: livelli
  molto vecchi restano candidati come TP2 (per costruzione, ma conviene saperlo).
- Lo stop dell'ultima candela D1 reale usa `forming=true`: corretto.

---

## 6. Cosa è invece solido

- **Pipeline dati**: pulizia, arrotondamento alle cifre della coppia, ordinamento,
  deduplicazione, raggruppamento M10/H4 con flag `partial`, cache con TTL
  adattivo (60 s aperto / 6 h chiuso), cache su disco con marcatura `stale`,
  protezione JSON da NaN/Infinity (`_json_safe`), disegno della candela
  coerente (`high = max(...)` prima di `low = min(...)`).
- **Doppia validazione**: il server pulisce e il client ri-pulisce
  (`sanitizeCandles` in `feed.js`), con rifiuto di serie sotto le 50 candele.
- **Indicatori**: implementazione corretta e misurabilmente identica allo
  standard (tranne ADX, variante documentata in codice).
- **Causalità**: verifica sistematica passata su tutti i moduli; il test
  `tests/selfcheck.html` della suite interna copre gli stessi temi.
- **Onestà del backtest**: costi sempre a carico, esito valutato a orizzonte
  fisso, risultati negativi mostrati senza trucco.

---

## 7. Conclusione

Il programma **analizza dati reali** (confermato da doppia fonte: Yahoo Finance
incrociata con i tassi BCE) e **gli indicatori tecnici sono calcolati in modo
reale e corretto** secondo le definizioni standard — la differenza massima
riscontrata contro un'implementazione indipendente è il rumore di virgola
mobile (~1e-13), con l'unica eccezione dell'ADX, una variante semplificata
dichiarata che legge sistematicamente trend più forti dello standard Wilder.

La causalità è rispettata ovunque e il backtest, sul giornaliero reale di
EUR/USD, restituisce onestamente statistiche senza vantaggio (PF 0,88) — segno
che non c'è trucco.

L'unico difetto funzionale trovato è nel **punteggio SMC**: nel ramo ribassista
i componenti Order Block e Fair Value Gap contribuiscono con segno rialzista
anche quando la zona trovata è ribassista (e le frasi di narrazione si
contraddicono tra loro). Raccomandazione: moltiplicare `obScore` e `fvgScore`
per il segno del bias (`dirSign`) prima di inserirli nelle componenti, e
rivedere i testi `bull`/`bear` del componente range; quindi rieseguire
`tests/selfcheck.html` e `tests/live.html`. Correzione stimata: poche righe in
`js/smc.js` (componenti) e le stringhe narrative.

**Aggiornamento**: le correzioni ADX e OB/FVG sono state applicate e la verifica
completa rieseguita con esito positivo — vedi §8.

---

### Appendice — prove riproducibili

- `server.py --no-browser --port 8905` → `GET /api/candles?tf=D1&symbol=EUR/USD`
  (1300 candele reali, cache disattivata con `force=1` se serve).
- Implementazione di riferimento: EMA/SMA/RSI/ATR/MACD/Bollinger/Stoch/ADX
  scritte da zero in NumPy (`verify.py`), confronto sull'ultima barra e sulle
  ultime 30.
- Test di causalità (`causality.js`): serie troncate a N-1, N-10, N-100, N-500,
  confronto di 14 serie di indicatori + score + eventi SMC.
- Confronto prezzi: `api.frankfurter.dev` (tassi BCE) su 23 sedute sovrapposte.

---

## 8. Verifica dopo correzione (12/10/2026)

Applicate le due correzioni raccomandate e rieseguita l'intera verifica.

### Correzione A — ADX portato allo standard Wilder (`js/indicators.js`)

Sostituito lo smoothing con EMA con lo **smoothing di Wilder** vero: primo valore
= media dei primi `period` incrementi, poi ricorsione `prev - prev/period + nuovo`,
sia per i DM/TR sia per l'ADX della DX (seed = media dei primi `period` DX,
poi stessa ricorsione). Risultato sui dati reali D1:

| | Prima (EMA) | Dopo (Wilder) | Riferimento indipendente |
|---|---|---|---|
| ADX(14) ultima barra | 69,71 | **49,82** | 49,82 — **diff 0,00e+00** |
| ADX media ultime 30 barre | 46,2 | **33,2** | 33,2 — diff max su 30 barre: **0,00e+00** |
| ADX definito da | indice 13 | indice 27 (2·14−1, corretto) | 27 |

Conseguenze verificate: ADX causale (0 violazioni su serie troncate), nessun NaN,
i valori ora sono confrontabili con le soglie standard usate dall'interfaccia
(>25 tendenza definita, <20 laterale) e con TradingView/MetaTrader.

### Correzione B — Segno OB/FVG nel punteggio SMC (`js/smc.js`)

`obScore` e `fvgScore` ricevono ora il segno del bias (`× bias`): la presenza di
una zona in direzione della struttura sostiene la tesi invece di contrastarla.

Dati reali EUR/USD D1, confronto prima/dopo:

| | Prima | Dopo |
|---|---|---|
| componenti OB / FVG | +0,224 / +0,863 (contradi tesi ribassista) | **-0,222 / -0,860** (sostiene la tesi) |
| punteggio SMC | -0,2106 | **-0,4987** |
| narrazione OB | «[bull] Order block rialzista … — OB ribassista sopra» | **«[bear] Order block ribassista non mitigato sopra il prezzo — OB ribassista»** coerente |
| narrazione FVG | «[bull] Squilibrio rialzista … — FVG sopra» | **«[bear] Squilibrio ribassista ancora da colmare»** coerente |

Controprova sul ramo rialzista (serie sintetica in trend su): OB/FVG in direzione
restano positivi e coerenti con i testi — la correzione è simmetrica.

Analisi dopo correzione (EUR/USD D1 reale, 12/10/2026): SMC **SELL** score
-0,4987, confidenza 65,2% (prima: score -0,2106, confidenza 32,8%); analisi
tecnica invariata nei valori chiave (SELL, score -0,5339) perché l'ADX Wilder
(49,8) resta sopra la soglia di regime pieno come prima (69,7). Backtest
walk-forward riverificato: 171 trade, hit rate 44,4%, R medio -0,100 — onesto,
nessuna regressione.

### Suite interne rieseguite (Chrome headless, ponte attivo)

| Suite | Esito |
|---|---|
| `tests/selfcheck.html` | **TUTTI I TEST SUPERATI: 102/102** |
| `tests/live.html` (dati reali) | **LIVE TEST SUPERATO: 26/26** |
| `tests/smoke.html` | **SMOKE TEST SUPERATO: 105/105** |

### Esiti residui (non corretti, fuori dal perimetro richiesto)

- **D2 parziale**: nel ramo ribassista il testo del componente *range* resta
  incoerente con i dati («Prezzo in premio: area di vendita…» con dettaglio
  «(sconto)»): la correzione del segno non tocca quel componente, che è un
  interprete momentum deliberato («vendi in sconto nel ribasso»); i suoi testi
  `bull`/`bear` andrebbero riscritti per descrivere la lettura momentum.
- D4 (MAX_BARS=1500 tronca la storia intraday dichiarata), D5 (R:R tecnico
  strutturalmente <1), D6 (limiti dichiarati del backtest): invariati.

---

## 9. Verifica dopo correzione C — allineamento del componente range (12/10/2026)

### Il problema residuo

Dopo le correzioni A e B restava incoerente il componente *Premium / Discount*:
i suoi testi (`bull`: «Prezzo in sconto: area di acquisto istituzionale»),
il glossario del report («si compra in sconto e si vende in premio») e la
sezione SMC del report («in sconto la zona è statisticamente più adatta agli
acquisti») dichiarano una dottrina **indipendente dal bias strutturale**, ma la
formula la implementava solo nel ramo rialzista: nel ramo ribassista
`posScore = (position - 0.5) * 2` la invertiva (sconto → punteggio negativo,
premio → positivo), generando il messaggio misto «[bear] Prezzo in premio:
area di vendita — … (sconto)».

### Correzione applicata (`js/smc.js`)

- `posScore` reso indipendente dal bias, come dichiarano i testi stessi:
  `posScore = (0.5 - range.position) * 2` — sconto → positivo (acquisto
  istituzionale), premio → negativo (vendita istituzionale), in entrambi i rami.
- La riga narrativa «Prezzo al N% del range…» ora prende il tono dalla posizione
  nel range (`inDiscount ? 'bull' : 'bear'`) e non più dalla struttura, così
  tono, testo e dettaglio dicono sempre la stessa cosa.

### Verifica su dati reali EUR/USD D1 (12/10/2026, prezzo al 7% del range = sconto)

| | Prima (C) | Dopo (C) |
|---|---|---|
| componente range | -0,869 (tono bear, testo «in sconto: acquisti», dettaglio «(sconto)») | **+0,864** — tono bull, testo e dettaglio coerenti |
| narrazione range | «[bear] Prezzo in premio: area di vendita… — 7% … (sconto)» | **«[bull] Prezzo in sconto: area di acquisto istituzionale — 7% … (sconto)»** |
| punteggio SMC | -0,4987 | **-0,1875**, segnale SELL, confidenza 38,8% |

Il punteggio SMC torna più vicino al neutro perché, a struttura ribassista, il
prezzo esteso in sconto ora pesa come area di acquisto (dottrina dichiarata):
la lettura resta SELL ma attenuata — coerente con la dottrina del programma e
con il piano operativo, che comunque prevede l'ingresso limite sulla zona di
retracciamento (OB sopra il prezzo), non a mercato.

Controprova sul ramo opposto (sintetica, prezzo al 100% del range): range
-1,000, tono bear, «zona di premio, favorevole alle vendite» — coerente.

### Regressioni: nessuna

- Indicatori vs riferimento indipendente: invariati (ADX Wilder 49,82 = 49,82,
  diff 0; tutte le altre differenze ~1e-13).
- Causalità: 92 confronti, 0 violazioni; determinismo OK; nessun NaN.
- Suite interne (Chrome headless, ponte attivo): **selfcheck 102/102,
  live 26/26, smoke 105/105**.

### Stato dei difetti del report originario

| Difetto | Stato |
|---|---|
| D1 — segno OB/FVG nel ramo ribassista | **CORRETTO** (§8) |
| D2 — narrazione SMC contraddittoria | **CORRETTO** (§8 OB/FVG, §9 range) |
| D3 — ADX semplificato | **CORRETTO** (§8, standard Wilder) |
| D4 — storia intraday troncata a MAX_BARS | aperto (etichetta di profondità) |
| D5 — R:R tecnico strutturale <1 | aperto (nota di design) |
| D6 — limiti dichiarati del backtest | aperto (documentato) |

---

## 10. Analisi del report narrativo (`js/report.js`, 12/10/2026)

Verifica dedicata al report divulgativo: generato in Node con lo stesso flusso
di `app.js` (analisi tecnica + SMC + sentiment a universo ridotto + confluenza)
su dati reali EUR/USD D1, poi confronto **puntuale di ogni numero citato nel
testo** con i valori interni dei motori.

### 10.1 Coerenza con i dati — 62/62 controlli passati

Tutti i numeri del report combaciano con i dati a errore di arrotondamento
nullo (i prezzi sono mostrati a 5 decimali, le differenze misurate sono ≤
mezzo ultimo decimo):

- **Sezione 1**: prezzo attuale, chiusura di 20 sedute fa (1,15939), variazione
  (-3,43% = -398 pip), ADX 50 (=49,8 arrotondato), ATR 0,00631 (0,56%),
  intervallo SMC 1,11623-1,16537 e posizione al 7% con metà dichiarata coerente.
- **Sezione 2 (tabella indicatori)**: RSI 22,5, MACD -14,5 pip (=istogramma ×
  10^pipDecimals), %B 0,14, Stochastic 11,6, ADX 49,8, ATR — tutti esatti;
  le letture testuali (sotto la media, mercato scarico, vicino ai minimi,
  tendenza definita, dentro la fascia) corrispondono alle soglie del codice.
- **Verdetto tecnico**: VENDITA, confidenza 74% (=73,73), movimento atteso
  -65,9 pip → prezzo previsto 1,11298 (=prezzo + drift), fascia 1,09103-1,13493
  (=estremi della proiezione), probabilità 13%/87% (sommano a 100), livelli
  operativi con distanze in pip esatte e R:R 0,79 ripetuto coerentemente nella
  stessa frase.
- **Sezione 3 (SMC)**: punteggio -0,19 (=valore corretto post-fix), ultimo
  evento CHoCH ribassista su 1,15670 di 19 candele fa, «una sola conferma»
  (=consecutive 1), le due zone OB citate (1,15275-1,15527 e 1,17231-1,17799,
  con età 19 e 109 candele) coincidono con le ultime due OB valide in
  direzione, i due FVG aperti citati coincidono, i quattro livelli di liquidità
  citati (1,12271 e 1,12670 sopra; 1,11520 e 1,11395 sotto) coincidono con i
  due più vicini sopra/sotto e con il loro stato sweep; piano operativo
  (limite 1,15275, stop 1,16632 a 467,5 pip, TP1 -31,6 pip, TP2 1,10705,
  R:R 3,37) esatto.
- **Sezioni 4-5**: punteggi e confidenze dei tre studi nella tabella (-0,53/74%,
  -0,19/39%, -0,81/85%) e punteggio/confidenza della confluenza (-0,35, 61%)
  tutti esatti; gli stop citati nel «che cosa guardare per cambiare idea»
  coincidono con i due stop dei motori.
- **Sezione 6**: provider Yahoo Finance (EURUSD=X), 1300 candele, storico
  «5 anni» — coerenti con il payload del ponte.
- **Glossario**: tutti i termini tracciati compaiono nel testo e hanno la voce
  nel glossario finale (nessun termine orfano).

### 10.2 È generato da un LLM? — NO

Il report è **procedurale**: `Report.build()` è codice di template puro
(concatenazione di stringhe su blocchi tipizzati: `h2`, `p`, `ul`, `callout`,
`table`, `glossary`) che legge solo lo stato dei tre motori e le candele.
Verifiche:

- nessuna chiamata di rete in `report.js` (zero `fetch`, `XMLHttpRequest`,
  `WebSocket`); nessun riferimento a servizi AI/API a pagamento in tutto il
  progetto (nessuna chiave, nessun endpoint LLM);
- nessun `Math.random` in `report.js`: **deterministico** — verificato
  empiricamente generando il report due volte con lo stesso input: il testo è
  identico carattere per carattere (unica differenza: la riga «Generato il …»);
- ogni frase numerica è una formula sul dato (`sign()`, `px()`, `pipOf()`), non
  testo libero: se il dato cambia, la frase cambia con lui; non può inventare
  nulla che non sia nei motori.

### 10.3 Incoerenze narrative trovate (testo, non numeri)

- **N1 — Piede del report contraddittorio in modalità reale** (gravità media):
  `toText()`, usato per copia/scarica/stampa, chiude sempre con «I prezzi sono
  simulati e nessuna indicazione qui contenuta è una consulenza finanziaria».
  Con i dati reali questo **contraddice la sezione 6** («Questo report usa i
  prezzi reali di EUR/USD forniti da Yahoo Finance»). Il piede andrebbe
  condizionato alla modalità: «prezzi simulati» se `source.mode === 'sim'`,
  «prezzi reali di fornitore non ufficiale, con ritardi possibili» se `real`.
- **N2 — Sezione sentiment a universo ridotto senza avvertenza interna**
  (gravità media): con i dati reali il calcolo della forza valute usa **una
  sola coppia vera su 14** (`scope.partial = true`): la classifica «USD
  (100/100), GBP (50/100), JPY (50/100)…» è un artefatto (GBP «seconda più
  forte» solo per ordine di parità a 50). Il testo dice «Guardando tutte le
  coppie disponibili», che in modalità reale è falso. L'esclusione dal
  verdetto è dichiarata nella sintesi («Il sentiment è escluso perché usa dati
  reali di una sola coppia»), ma la sezione sentiment stessa non lo ripete e
  presenta la classifica come completa. Nota: retail e istituzionale sono
  invece correttamente dichiarati «modello simulato» nel testo.
- **N3 — Refuso «contro-ario»** (cosmetico): `sentiment.js` righe 161-162
  produce «segnale contro-ario ribassista/rialzista», che nel report esce come
  «segnale contro-ario» (si legge «contrario» o «contro-tendenza»).

Tutte le altre parti del report (7 sezioni, glossario, avvertenza SMC/tecnica,
disclosure retail/istituzionale) sono coerenti con i dati e con l'interfaccia.

---

## 11. Verifica dopo correzioni N1-N3 (12/10/2026)

### N1 — Piede del report condizionato alla modalità (`js/report.js`)

`Report.build()` ora include `sourceMode` e `toText()` chiude con un piede
coerente con la sezione «La fonte dei dati»:

- modalità reale: «I prezzi sono reali, forniti da un servizio non ufficiale
  che può avere ritardi o interruzioni…»;
- modalità simulata: «I prezzi sono simulati e le prestazioni mostrate dal
  backtest non sono rappresentative di un conto reale…» (invariato).

Verificato in entrambe le modalità: nessuna contraddizione più.

### N2 — Nota di universo ridotto/misto nella sezione sentiment (`js/report.js`)

La nota usa la condizione **autorevole** dell'esclusione dal verdetto
(`confluence.excluded`), non il solo conteggio delle coppie reali:

- sentiment escluso (dati reali, universo ridotto): «Nota: il confronto di
  forza usa solo le coppie con dati reali (1 coppia su 14), quindi la
  classifica è incompleta, le posizioni di mezzo sono parità e il sentiment è
  escluso dal verdetto finale.» — la frase «Guardando tutte le coppie
  disponibili» non compare più;
- universo misto (dati reali + contesto simulato attivo): nota di mescolanza
  («di cui N con dati reali e M simulate»);
- universo completo simulato (modalità sim): nessuna nota — l'introduzione
  standard resta e l'universo è davvero completo; il piede e la sezione
  «La fonte dei dati» dichiarano comunque la simulazione.

Verificato su tutte e tre le configurazioni con controprove.

### N3 — Refuso corretto (`js/sentiment.js`, `tests/selfcheck.html`)

«segnale contro-ario» → «segnale contrario» (e «contro-aria» → «contraria»
nelle etichette dei test, allineate al glossario «Lettura contraria»). Nessuna
occorrenza residua nel progetto.

### Regressioni: nessuna

- Verifica numerica del report su dati reali: **NESSUN DISACCORDO** (62/62).
- Determinismo: OK; nessuna chiamata di rete nel report.
- Suite interne (Chrome headless, ponte attivo): **selfcheck 102/102,
  live 26/26, smoke 105/105**.

### Stato complessivo dei difetti

| Difetto | Stato |
|---|---|
| D1 — segno OB/FVG nel ramo ribassista | **CORRETTO** (§8) |
| D2 — narrazione SMC contraddittoria | **CORRETTO** (§8, §9) |
| D3 — ADX semplificato | **CORRETTO** (§8, standard Wilder) |
| N1 — piede «prezzi simulati» anche a dati reali | **CORRETTO** (§11) |
| N2 — sentiment a universo ridotto senza nota interna | **CORRETTO** (§11) |
| N3 — refuso «contro-ario» | **CORRETTO** (§11) |
| D4 — storia intraday troncata a MAX_BARS | aperto (etichetta di profondità) |
| D5 — R:R tecnico strutturale <1 | aperto (nota di design) |
| D6 — limiti dichiarati del backtest | aperto (documentato) |

Restano aperti solo i tre rilievi documentali/di design (D4, D5, D6), nessun
difetto funzionale noto.

---

## 12. Sentiment reale su fonti autorevoli (12/10/2026)

Sostituiti i componenti simulati del sentiment con **dati veri** per la coppia
EUR/USD (estendibile alle altre coppie del ponte). Nessuna chiave API richiesta.

### Fonti verificate e usate

| Fonte | Che cosa fornisce | Autorità / stabilità |
|---|---|---|
| **CFTC — Commitments of Traders** | posizionamento netto non-commerciale per divisa, settimanale, storico 5 anni (262 settimane) | regolatore USA, API ufficiale Socrata (`publicreporting.cftc.gov`, dataset 6dca-aqww), nessuna chiave |
| **VIX** (^VIX, Yahoo) | regime risk-on/risk-off, livello vs distribuzione annua | standard di mercato |
| **Indice del dollaro** (DX-Y.NYB, Yahoo) | forza reale del USD (per la gamba quotata) | indice di mercato reale |
| **Candele EUR/USD** (Yahoo, già presenti) | momentum reale della coppia | già verificato in §1 |

Codici contratto COT verificati empiricamente: EUR **099741** (l'IP-labeled
096741 è il vecchio contratto ECU, terminato nel 1988), CHF **092741**, JPY
097741, GBP 096742, CAD 090741, AUD 232741, NZD 112741, oro 088691, argento
084691. Dati più recenti al momento della verifica: report del **2026-10-06**.

### Architettura

- `server.py`: nuovo endpoint **`/api/sentiment?symbol=…`** — una sola
  richiesta CFTC per tutti i 9 contratti (con `$query` Socrata, solo colonne
  necessarie), più VIX e DXY giornalieri; cache COT a 6 ore con copia su disco
  (settimanale non ha bisogno di più), VIX/DXY con la stessa logica
  aperto/chiuso delle candele; fallback stale marcato; pacing condiviso.
- `js/feed.js`: `loadSentiment()` con validazione (COT obbligatorio con ≥52
  settimane e open interest leggibile; VIX/DXY opzionali).
- `js/sentiment.js`: nuovo **`analyzeReal(payload, candles, instrument, opts)`**
  con la stessa interfaccia di `analyze()` (pannelli e report invariati):
  quattro componenti **tutte reali** — posizionamento COT 0,35 (percentile
  5 anni, netto % open interest), flussi settimanali 0,15, momentum prezzi
  veri 0,30, regime VIX 0,20; USD misurato via DXY. Il pannello **retail resta
  simulato, dichiarato e fuori dal punteggio** (`excludedFromScore`).
- `js/app.js`: il sentiment reale arriva dopo le candele, sostituisce quello
  a universo ridotto e **rientra nel verdetto di confluenza** (3 modelli).
  Risolto un bug di wiring trovato durante l'integrazione: tre punti
  (`tick`, intervallo 30 s, listener spunta contesto) ricalcolavano lo studio
  simulato sovrascrivendo quello reale; ora un unico helper
  `recomputeSentiment()` preserva il reale e riapplica il payload alle candele
  fresche. Il catch del fetch logga ora la causa in console.
- `js/report.js`: sezione sentiment con ramo reale (fonti dichiarate con date
  COT/VIX, posizionamento in contratti e % open interest, percentile,
  flussi), glossario arricchito (COT, VIX, indice del dollaro), e l'aggiornamento
  del «che cosa guardare per cambiare idea» (rilascio COT del venerdì).
- Test: `selfcheck.html` +10 controlli su `analyzeReal` (payload sintetico
  deterministico: validità, determinismo, percentile ai due estremi, retail
  escluso, degradazione senza VIX/DXY, righe corrotte senza NaN, istituzionale
  COT ordinato); `live.html` aggiornato all'atteso nuovo (sentiment reale
  incluso o, se la fonte manca, escluso e dichiarato; report che cita la CFTC).

### Risultati sui dati reali (12/10/2026)

- EUR: posizionamento non-commerciale **netto corto di 99.332 contratti**
  (-11,4% dell'open interest), **percentile 1 su 5 anni** → short estremo reale,
  variazione settimanale -4,0 punti (dismissione).
- USD: DXY 102,3, trend al **percentile 97** annuo → dollaro forte reale.
- VIX 15,45, percentile 20 → **Risk-on** (contrasto interessante col trend:
  Dollaro forte a mercato azionario quieto).
- Verdetto sentiment: **FORTE RIBASSO, score -0,50, confidenza 73%**;
  confluenza finale **3/3 modelli concordi, SELL -0,39** (63%).
- Coerenza indipendente: i numeri del report ricalcolati in Python direttamente
  dall'API CFTC grezza combaciano **5/5** (percentile EUR/XAU/GBP, netto % OI,
  variazione settimanale).
- Suite: **selfcheck 112/112, live 27/27, smoke 105/105**; nessun errore JS.

### Note di onestà

- Il posizionamento COT è un dato **ritardato** (martedì → venerdì) e copre i
  futures gestiti negli USA: è il riferimento standard, ma non descrive il
  contante forex. Il report lo dice implicitamente con le date.
- Il retail simulato è sempre marcato come tale e non pesa nel punteggio.
- Il fallback resta completo: senza CFTC/VIX/DXY l'app torna allo studio
  simulato a universo ridotto con l'esclusione dal verdetto dichiarata.

---

## 13. Feed notizie e calendario affiancati al sentiment (12/10/2026)

Come richiesto: pannello **"Notizie e calendario"** visualizzato **side-by-side**
con la scheda sentiment, con fonti raggiungibili senza chiavi API verificate
empiricamente prima dell'integrazione.

### Fonti verificate (12/10/2026)

| Fonte | Verifica | Ritmo | Autorità |
|---|---|---|---|
| ForexLive RSS | OK, 25 notizie fresche (di oggi) | continue | testata forex specializzata |
| FXStreet RSS | OK, 30 notizie fresche (di oggi) | continue | testata forex specializzata |
| Federal Reserve RSS | OK, 20 comunicati | settimanale | **fonte primaria, banche centrali** |
| BCE RSS | OK, 15 comunicati | settimanale | **fonte primaria, banche centrali** |
| Calendario ForexFactory (mirror faireconomy.media) | OK, 109 eventi settimana con impatto/forecast/previous | settimanale | calendario di uso comune (mirror non ufficiale, dichiarato) |
| ~~DailyFX RSS~~ | HTTP 403 — bloccato | — | scartata |

### Come è costruito

- `server.py` — **`/api/news`**: scarica i 4 RSS e il calendario **lato server**
  (il browser non può, per CORS), ripulisce i titoli (nessun HTML residuo),
  marca la pertinenza EUR/USD per parole chiave (i comunicati Fed/BCE sono
  sempre pertinenti: sono le fonti delle decisioni di tasso), filtra il
  calendario su eventi EUR/USD/ALL con impatto medio-alto (più ogni evento
  High di qualunque divisa), deduplica, ordina; cache 5 minuti con copia su
  disco e fallback stale; lo stato delle fonti è nel payload (`feeds`).
- `js/feed.js` — **`loadNews()`** con validazione dei allegati ( tempi e titoli
  leggibili).
- `js/app.js` — pannello e layout: la card **sentiment e la card notizie
  condividono una banda full-width affiancata** (`.news-band`, due colonne
  autodimensionate fino a ~1150px, impilate sotto); polling ogni 5 minuti con
  rate-limit client e retry a 60s su errore. Il calendario mostra **tag di
  impatto** (High/Medium), divisa, dato atteso/precedente e **countdown** sul
  prossimo evento; le notizie portano badge fonte (comunicati bancari
  evidenziati) e orario, titoli collegati alla fonte originale in nuova
  scheda; le voci pertinenti EUR/USD sono marcate e primeggiano.
- Etichetta del pannello istituzionale ora dinamica: «COT CFTC del 2026-10-06
  (percentile 5 anni, reale)» con i dati veri, «(COT-style, simulato)» nel
  fallback.
- Test: `live.html` +5 controlli (popolamento pannello, calendario valorizzato,
  dichiarazione fonti, tag impatto, link titoli); `selfcheck.html` +1
  (l'API `loadSentiment`/`loadNews` presente).

### Risultato sui dati reali (qui sopra lo screenshot)

- Calendario filtrato: 17 eventi pertinenti, primo in arrivo «ECB President
  Lagarde Speaks» con countdown «tra 39h 58m», gli **4 eventi CPI USA ad alto
  impatto** del 14/10 con atteso/precedente (es. Core CPI y/y atteso 2,5%,
  precedente 2,4%).
- 70 notizie dalle 5 fonti attive, 49 marcate pertinenti EUR/USD, prime in
  lista con badge.
- Affiancato al sentiment reale (COT del 06/10, EUR percentile 1/100) la lettura
  operativa è immediata: **posizionamento corto estremo + CPI USA ad alto
  impatto in agenda** — il caso d'uso del layout richiesto.

### Suite

**selfcheck 113/113, live 32/32, smoke 105/105** — nessun errore JavaScript.
