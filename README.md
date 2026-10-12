# ForexVision

Webapp **HTML + CSS + JavaScript** (nessuna dipendenza esterna, nessun build step) per
l'analisi del mercato forex su tre fronti: **analisi tecnica**, **Smart Money Concepts**
e **sentiment di mercato**, con un verdetto di confluenza che li combina.

Ha due modalità di dati:

- **dati reali**: se è in esecuzione il server locale (`server.py`), l'app mostra i
  prezzi veri di **EUR/USD** scaricati da Yahoo Finance, con 5 anni di storia
  giornaliera e candele a 10 minuti ricostruite da quelle a 5 minuti (aggiornamento
  automatico ogni minuto);
- **simulata**: senza server (o senza rete) l'app continua a funzionare generando serie
  sintetiche calibrate su valori di mercato reali, e in alto a destra lo dichiara sempre.

In entrambi i casi nessuna chiave API è necessaria.

## Avvio

```bash
cd ~/Documenti/forex
./avvia.sh              # avvia server.py (file + dati reali) e apre il browser
./avvia.sh --file       # apre direttamente index.html (file://): solo dati simulati
./avvia.sh --stop       # ferma il server locale
```

Il server `server.py` serve i file **e** espone `/api/candles`, che scarica i prezzi
reali da Yahoo Finance, li ripulisce e li riconverte nel formato dell'app. Se il server
non è in esecuzione (apertura diretta da `file://`, niente rete, fornitore irraggiungibile)
l'app ripiega **da sola** sulla modalità simulata e lo segnala nel badge in alto.

## Struttura

```
forex/
├── index.html            interfaccia (layout a due colonne + registro)
├── css/styles.css        tema scuro da terminale di trading
├── server.py             ponte dati locale: file statici (senza cache) + /api/candles (Yahoo Finance)
├── js/
│   ├── data.js           generatore di serie OHLC sintetiche
│   ├── indicators.js     libreria di indicatori tecnici
│   ├── forecast.js       motore previsionale + backtest walk-forward
│   ├── smc.js            motore Smart Money Concepts
│   ├── sentiment.js      studio del sentiment (forza valute, posizionamento, rischio)
│   ├── feed.js           lettura e controllo dei dati reali dal ponte
│   ├── report.js         report divulgativo in linguaggio semplice
│   ├── chart.js          renderer del grafico a candele su canvas
│   └── app.js            controller e collegamento all'interfaccia
├── tests/
│   ├── selfcheck.html    test automatici sui moduli
│   ├── smoke.html        test end-to-end sull'interfaccia (modalità simulata)
│   ├── live.html         test end-to-end con i dati reali del ponte
│   └── calibration.html  misura della calibrazione di volatilità
└── avvia.sh              script di avvio
```

## Cosa fa l'applicazione

- **Grafico a candele** con medie esponenziali (9/21/50), bande di Bollinger, volumi,
  overlay SMC (order block, fair value gap, BOS/CHoCH, pool di liquidità, premio/sconto),
  crosshair con tooltip OHLC e zoom con la rotella del mouse.
- **Confluenza dei modelli**: i punteggi di analisi tecnica, SMC e sentiment in un unico
  verdetto, con il numero di modelli concordi e il livello di confidenza.
- **Segnale tecnico** (ACQUISTO / VENDITA / NEUTRO) con punteggio in [-1, +1],
  percentuale di confidenza e spiegazione testuale delle motivazioni.
- **Studio SMC (Smart Money Concepts)**: struttura di mercato (BOS/CHoCH), order block,
  fair value gap, pool di liquidità con sweep, range premio/sconto con zona OTE e
  scenario operativo completo (ingresso limite, stop, due obiettivi, R:R).
- **Report divulgativo**: un documento in linguaggio semplice che spiega il quadro
  attuale e le previsioni dei tre studi, con glossario di tutti i termini tecnici
  usati, copiabile, scaricabile come file di testo o stampabile.
- **Studio del sentiment**: forza relativa delle 10 divise (0-100) su tre orizzonti,
  posizionamento della folla con lettura contro-aria, regime risk-on/risk-off,
  indice di volatilità di mercato e posizionamento istituzionale per divisa.
- **Piano operativo tecnico**: prezzo di ingresso, obiettivo (TP), stop loss, rapporto R:R,
  movimento atteso in pip e volatilità ATR.
- **Proiezione probabilistica**: traiettoria attesa su N candele con banda a 1σ,
  probabilità di chiusura rialzista/ribassista e probabilità di toccare livelli
  multipli di ATR.
- **Pannello indicatori**: EMA, SMA200, RSI(14), Stochastic(14,3), MACD(12,26,9),
  Bollinger(20,2), ATR(14), ADX(14) e volumi relativi, ciascuno con un giudizio.
- **Watchlist** sui 14 strumenti (major, cross e metalli) ordinata per punteggio.
- **Backtest walk-forward** senza look-ahead bias: hit rate, R medi, profit factor,
  drawdown massimo e curva equity in punti R.
- **Registro operazioni virtuali** salvato in `localStorage`, con esito manuale e
  hit rate complessivo.
- **Flusso "live"**: le candele si aggiornano da sole ogni 2,5 secondi per simulare
  l'arrivo dei tick.

## Come funziona il motore previsionale

Otto famiglie di segnali tecnici vengono combinate con **pesi adattivi**:

| Segnale | Peso base | Note |
|---|---|---|
| Struttura delle medie (EMA 9/21/50) | 0,20 | normalizzato su ATR |
| Bias di lungo periodo (SMA200) | 0,08 | distanza in ATR |
| Pendenza EMA50 | 0,09 | variazione % per barra |
| MACD (12,26,9) | 0,16 | istogramma / ATR, corretto dalla sua deriva |
| RSI (14) | 0,12 | smorzato agli estremi |
| Stochastic (14,3) | 0,08 | smorzato agli estremi |
| Bollinger (20,2) | 0,10 | componente di ritorno alla media |
| Momentum (ROC 5 e 20) | 0,12 | normalizzato su ATR |

In **regime direzionale** (ADX alto) i pesi dei segnali di trend aumentano e quelli di
ritorno alla media si riducono; in **regime laterale** accade l'opposto. Il punteggio
finale viene convertito in probabilità con una funzione logistica, e la confidenza
combina forza del segnale, concordanza interna e forza del trend.

Il backtest è **walk-forward**: ogni decisione usa solo i dati disponibili a quella
barra e l'esito viene valutato *h* barre dopo, con il costo dello spread sempre a
carico dell'operazione. Non esiste quindi alcun look-ahead bias.

## Come funziona lo studio SMC (Smart Money Concepts)

Il modulo `js/smc.js` implementa i concetti SMC in modo algoritmico e **causale**,
cioe' senza mai usare informazioni future:

| Elemento | Definizione usata |
|---|---|
| Swing point | massimo/minimo frattale su `lookback` barre, con indice di conferma |
| BOS / CHoCH | chiusura oltre uno swing confermato: *BOS* se prosegue la struttura, *CHoCH* se la inverte |
| Order block | ultima candela di colore opposto prima dell'impulso che rompe la struttura |
| Fair value gap | squilibrio su tre candele (candela 1 e candela 3 non sovrapposte), filtrato su ATR |
| Liquidità | massimi/minimi uguali (pool di ordini) e relativi *sweep* (superamento con chiusura di ritorno) |
| Premio / sconto | range dell'ultimo impulso, equilibrio al 50%, zona OTE fra 61,8% e 79% |

Il punteggio SMC combina sei componenti pesate: struttura (0,28), posizione nel range
(0,18), order block (0,18), fair value gap (0,12), sweep di liquidità (0,14) e CHoCH
recente (0,10). Da qui nasce lo scenario operativo: **ingresso limite sulla zona**
(una zona di domanda deve stare sotto il prezzo, una di offerta sopra), **stop oltre
l'origine dello scenario**, **TP1 sull'equilibrio** e **TP2 sulla liquidità non ancora
presa**, con rapporto R:R calcolato.

Sul grafico l'overlay SMC mostra zone di order block e FVG, linee di rottura BOS/CHoCH,
pool di liquidità con gli sweep, i punti di swing e le bande premio/sconto (attivabili
dai pulsanti sopra il grafico).

## Dati reali (Yahoo Finance)

Con il server locale in esecuzione l'app analizza i **prezzi veri di EUR/USD** delle
ultime sedute. Il ponte (`server.py`) scarica le serie da Yahoo Finance, le ripulisce
(candele vuote delle pause di mercato escluse, prezzi arrotondati alle cifre della
coppia, ordine cronologico garantito) e le consegna al motore di analisi **nello stesso
identico formato** delle serie simulate: gli studi funzionano senza modifiche.

Profondità storica e ricostruzione per timeframe (sono i limiti del fornitore):

| Timeframe | Intervallo del fornitore | Storico disponibile |
|---|---|---|
| M5 | 5 min | 60 giorni |
| **M10** | 5 min, ricostruito ×2 | 60 giorni |
| M15 | 15 min | 60 giorni |
| H1 | 60 min | ~2 anni |
| H4 | 60 min, ricostruito ×4 | ~2 anni |
| **D1** | 1 giorno | **5 anni** |

Il 10 minuti è il timeframe predefinito. Yahoo non fornisce la candela a 10 minuti:
il ponte la ricostruisce raggruppando due candele a 5, e lo dichiara nell'interfaccia.
Il giornaliero copre i **5 anni** richiesti; per l'intraday il fornitore concede al
massimo 60 giorni (5-15 minuti) o 2 anni (1-4 ore).

L'app richiede i dati al ponte **ogni 60 secondi**; il ponte tiene una cache di 60
secondi (6 ore a mercato chiuso, per non disturbare il fornitore durante il weekend)
e, se la rete cade, continua a servire l'ultima copia scaricata marcandola come *dati
non aggiornati*. Fra un aggiornamento e l'altro l'app **non inventa movimenti**: la
candela resta la vera, con la scritta "ultimo aggiornamento hh:mm:ss".

### Limiti dichiarati

- È collegata **solo EUR/USD** (come richiesto). Le altre 13 coppie della watchlist
  restano simulate e portano l'etichetta `sim`; selezionandole il badge in alto cambia
  in **DATI SIMULATI** spiegando il perché.
- Il cambi valute di Yahoo per EUR/USD **non include i volumi**: il pannello volumi
  del grafico rimane vuoto e la riga "Volumi vs media" mostra `n.d.`.
- L'ultima candela della serie è ancora **in formazione** (il suo intervallo non è
  chiuso) e viene segnalata come tale.
- Lo studio di **sentiment** confronta più cambi: con un solo cambio reale mostrerebbe
  la forza di EUR solo contro USD, che non aggiunge informazione indipendente. Quindi
  con i dati reali il verdetto finale si appoggia ad **analisi tecnica e SMC** (la
  scheda lo spiega), mentre il `sentiment` resta disponibile in modalità simulata o con
  la spunta "includi il contesto simulato". Nel pannello di confluenza i tre studi
  restano **sempre** in vista: quello che non pesa nel verdetto è marcato «escluso dal
  verdetto» con il motivo, così nessuno studio sparisce dall'interfaccia.
- Gli endpoint di Yahoo Finance usati sono **non ufficiali**: possono cambiare o
  rispondere con liste d'attesa (HTTP 429). Il ponte gestisce entrambi i casi ripiegando
  sulla cache o sulla modalità simulata.

## Il report in linguaggio semplice

Il pulsante **Report** nella barra in alto (o **Leggi il report completo** sotto la
scheda di confluenza) apre un documento pensato per chi non è un professionista.
Si apre anche direttamente con il collegamento `index.html#report`.

Il report contiene sette sezioni:

1. **Il quadro in breve** - il verdetto dei tre studi in tre righe.
2. **Che cosa sta facendo il mercato adesso** - il prezzo e la sua variazione, la forza
   della tendenza e l'ampiezza dei movimenti, in parole semplici.
3. **Analisi tecnica: che cosa dicono i numeri** - una tabella con ogni indicatore, che
   cosa misura e come si legge adesso, il verdetto, il movimento atteso con la sua fascia
   di incertezza e i livelli operativi.
4. **Smart Money Concepts: dove si muovono i grandi operatori** - la struttura, le zone
   di interesse, gli squilibri, la liquidità e lo scenario operativo spiegati con esempi
   concreti (chi compra, chi vende, dove sta lo stop).
5. **Sentiment: che cosa pensa il mercato** - le valute più forti e più deboli, il
   posizionamento della folla, l'ambiente di rischio e i flussi istituzionali.
6. **La fonte dei dati** - se il ponte è attivo dichiara il fornitore (Yahoo Finance),
   la profondità storica del timeframe e se l'ultima candela è in formazione o i dati
   sono fermi; se il ponte manca, avvisa che il report è calcolato su dati simulati.
7. **I tre studi a confronto** e **Glossario dei termini usati**: i punteggi dei tre
   modelli, la sintesi e la spiegazione di **tutti** i termini tecnici che compaiono nel
   testo (spiegazioni in ordine alfabetico).

Ogni termine tecnico è spiegato fra parentesi la prima volta che compare e comunque
ripreso nel glossario finale: il test automatico `tests/selfcheck.html` verifica che
nessun termine usato resti senza spiegazione, che le frasi restino brevi (media 11
parole) e che i numeri citati coincidano con quelli dei modelli.

Dalla finestra del report si può **copiare** il testo, **scaricarlo** come file `.txt`
e **stamparlo** (o salvarlo in PDF: il foglio di stile di stampa mostra solo il report,
in bianco e nero leggibile).

## Come funziona lo studio del sentiment

Il modulo `js/sentiment.js` incrocia quattro analisi, di cui le prime due sono calcolate
dai prezzi e le altre due sono modelli dichiaratamente simulati:

1. **Forza delle valute (calcolata)** - ogni divisa viene valutata sui rendimenti di
   tutte le coppie in cui compare (segno + se base, - se quotata) su 5, 20 e 60 barre,
   normalizzata in una scala 0-100 e ordinata in classifica. E' il modo standard di
   misurare il sentiment relativo di una divisa.
2. **Propensione al rischio (calcolata)** - confronto fra divise pro-cicliche
   (AUD, NZD, CAD, argento) e rifugio (JPY, CHF, oro), piu' un indice di volatilita'
   di mercato dato dall'ATR corrente di tutte le coppie rispetto alla propria media.
3. **Posizionamento della folla (simulato)** - la percentuale di posizioni long riproduce
   il comportamento contro-tendenza tipico del retail (compra i ribassi, media in perdita)
   e viene letta in chiave contraria agli estremi.
4. **Posizionamento istituzionale (simulato, COT-style)** - posizione netta per divisa
   derivata dalla forza di medio periodo con reversione agli estremi, variazione
   settimanale e segnalazione delle divise piu' affollate.

Il punteggio di sentiment combina i quattro contributi (forza 0,45; folla 0,22; rischio
0,18; istituzionale 0,15) e confluisce con gli altri due motori nel verdetto finale.

## Realismo dei dati e calibrazione

Il generatore (`js/data.js`) riproduce diverse proprietà statistiche dei prezzi reali:

- moto browniano geometrico con **regimi di tendenza persistenti**;
- **clustering di volatilità** (processo mean-reverting con shock occasionali);
- **code grasse** e volumi correlati all'ampiezza della candela e all'ora del giorno;
- volatilità per barra derivata dalla volatilità giornaliera con **scaling √t** secondo
  il timeframe (M5, M10, M15, H1, H4, D1).

La calibrazione è verificata empiricamente con `tests/calibration.html`, che confronta
l'ATR giornaliero generato con i valori tipici di mercato. La misura corrente (10 seed,
media sull'intera serie) dà uno **scarto medio inferiore al 15%** su tutte le coppie,
con dimensioni del pip corrette (0,0001 per EUR/USD, 0,01 per USD/JPY, 0,01 USD per l'oro).

## Test automatici

I test girano in un browser e funzionano anche aperti direttamente da `file://`
(la pagina mostra PASS/FAIL a schermo):

- `tests/selfcheck.html` — 102 controlli: indicatori su serie costruite a mano, validità
  delle serie OHLC, ordine cronologico, motore previsionale e backtest, assenza di NaN
  su 84 combinazioni strumento × timeframe (ora anche M10), realismo della volatilità,
  **SMC** (swing, BOS/CHoCH, order block, FVG, liquidità, range/OTE, coerenza dello
  scenario, assenza di look-ahead, determinismo), **sentiment** (forza delle valute e
  sua coerenza con i prezzi, posizionamento, regime di rischio, confluenza, universo
  ridotto con dati reali), **feed** (pulizia delle candele, costruzione della serie dal
  payload del ponte, rifiuto di serie troppo corte, confluenza ridotta senza sentiment)
  e **report** (sezioni presenti, glossario completo rispetto ai termini usati, frasi
  brevi, numeri coerenti con i dati, sezione "La fonte dei dati" nei due casi: reale e
  simulata).
- `tests/smoke.html` — 92 controlli end-to-end sull'interfaccia in modalità simulata
  (deterministica) più 13 controlli sul ponte dei dati reali quando il server è attivo
  (105 totali): caricamento dei moduli, popolamento di tutte le sezioni (comprese
  confluenza, SMC, sentiment e report), rendering del canvas e dei livelli SMC,
  apertura/chiusura/copia del report, cambio coppia e timeframe, registrazione e
  chiusura di un trade virtuale, assenza di errori JavaScript.
- `tests/live.html` — 26 controlli end-to-end con il ponte dei dati reali attivo:
  badge e ora di aggiornamento, prezzo EUR/USD reale, analisi calcolate sui prezzi veri,
  i tre studi sempre visibili con il sentiment marcato «escluso dal verdetto» e il
  verdetto che pesa solo i modelli con un universo completo,
  report con la sezione "La fonte dei dati", passaggio a GBP/JPY (badge che torna
  simulato) e ritorno a EUR/USD, storia giornaliera di 5 anni dichiarata
  nell'interfaccia, assenza di errori JavaScript.

### Eseguirli senza farsi ingannare dalla cache

Il ponte risponde ai file dell'app con `Cache-Control: no-cache`, quindi una pagina
ricaricata usa sempre la versione aggiornata; se il file non è cambiato risponde
`304 Not Modified` e resta veloce. Serve perché senza quell'header il browser può riusare
una copia vecchia basandosi sulla sola `Last-Modified`: Firefox la considera "fresca" per
un decimo del tempo passato dall'ultima modifica, cioè anche per parecchi minuti, e una
suite verde finisce per misurare codice già superato. Negli script di test conviene
comunque forzare il ricaricamento (in Firefox `Ctrl+Maiusc+R`, oppure un profilo con la
cache disattivata) o aprire le pagine direttamente da `file://`, che non ha cache.

## Avvertenza

Strumento **didattico e dimostrativo**. Senza il server locale i prezzi sono
**simulati**, e le prestazioni mostrate dal backtest non sono rappresentative di un
conto reale. Con i dati reali i prezzi arrivano da un **servizio non ufficiale di
Yahoo Finance** che può avere ritardi, interruzioni o modifiche; i modelli di
sentiment retail/istituzionale restano comunque simulati. Nulla qui costituisce
consulenza finanziaria né raccomandazione di investimento. Il trading sul forex
comporta un elevato rischio di perdita del capitale.
