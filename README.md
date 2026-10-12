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
./avvia.sh --lan        # come sopra, ma raggiungibile anche dalla rete locale
./avvia.sh --port 8199  # porta precisa (se è occupata lo dice e non ripiega)
./avvia.sh --file       # apre direttamente index.html (file://): solo dati simulati
./avvia.sh --stop       # ferma il server locale
```

Dalla home c'è anche la scorciatoia: `~/forex.sh`

Il server `server.py` serve i file **e** espone `/api/candles` (prezzi veri da
Yahoo Finance), `/api/sentiment` (CFTC COT + VIX + indice del dollaro) e
`/api/news` (RSS ForexLive/FXStreet/Fed/BCE + calendario ForexFactory), consegnati
ripuliti e in cache nel formato dell'app. Se il server
non è in esecuzione (apertura diretta da `file://`, niente rete, fornitore irraggiungibile)
l'app ripiega **da sola** sulla modalità simulata e lo segnala nel badge in alto.

### Usare l'app da un altro dispositivo

Per impostazione predefinita il ponte ascolta **solo su `127.0.0.1`**, cioè è
raggiungibile unicamente da questa macchina. Per aprirlo alla rete locale (telefono,
tablet, un altro computer, o la rete Tailscale se è attiva):

```bash
./avvia.sh --lan                # ascolta su tutte le interfacce
./avvia.sh --host 192.168.1.124 # solo su un indirizzo scelto
```

All'avvio il ponte elenca gli indirizzi con cui è raggiungibile, per esempio
`http://192.168.1.124:8901/index.html`. Lo stesso si ottiene direttamente da
`server.py` con `--host 0.0.0.0` (o con la variabile `FOREXVISION_HOST`).

Non serve toccare il firewall: se `ufw`, `firewalld` o regole `nft`/`iptables` non sono
presenti, la porta in ingresso non è filtrata (qui la catena `INPUT` ha politica
`ACCEPT`, con le sole regole aggiunte da Tailscale). Se in futuro si installa un
firewall, va aperta la porta scelta (`sudo ufw allow 8901/tcp` e simili).

Attenzione: l'app **non chiede password**. Chi raggiunge quella porta vede l'app,
i dati di mercato e gli endpoint del ponte. Va usata su reti di cui ci si fida
(casa, VPN Tailscale), non su reti pubbliche, e l'opzione è volutamente esplicita:
senza `--lan` o `--host` il ponte resta chiuso su `127.0.0.1`.

### Scorciatoia dalla home (porta 8199)

`~/forex.sh` avvia l'app sulla **porta 8199**, raggiungibile anche dalla rete
locale, e apre il browser:

```bash
~/forex.sh                    # avvia e apri l'app su http://127.0.0.1:8199
~/forex.sh --stop             # ferma il server avviato così
~/forex.sh --host 127.0.0.1   # solo questa macchina
PORTA=9000 ~/forex.sh         # un'altra porta
```

Se la porta è già occupata da un altro processo lo script **non ripiega in
silenzio**: dice chi la occupa ed esce con codice diverso da zero. Se invece il
server è già stato avviato da lì, lo riconosce e apre solo il browser.

Il file `~/forex.sh` è un collegamento al `forex.sh` versionato dentro il
progetto, che a sua volta passa le opzioni ad `avvia.sh`: la logica di avvio
(attesa che il ponte risponda, pidfile, log, apertura del browser) resta in un
posto solo. Per ricreare il collegamento su un'altra macchina:

```bash
ln -sfn ~/Documenti/forex/forex.sh ~/forex.sh
```

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
│   ├── feed.js           lettura e controllo dei dati reali, sentiment e notizie dal ponte
│   ├── report.js         report divulgativo in linguaggio semplice
│   ├── chart.js          renderer del grafico a candele su canvas
│   └── app.js            controller e collegamento all'interfaccia
├── tests/
│   ├── selfcheck.html    test automatici sui moduli
│   ├── smoke.html        test end-to-end sull'interfaccia (modalità simulata)
│   ├── live.html         test end-to-end con i dati reali del ponte
│   ├── slowstart.html    avvio con il ponte lento (corse all'avvio)
│   └── calibration.html  misura della calibrazione di volatilità
├── forex.sh              scorciatoia di avvio (porta 8199, linkato in ~/forex.sh)
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
- **Notizie e calendario** affiancate al sentiment: comunicati ufficiali di Fed e BCE
  (RSS), notizie forex di ForexLive e FXStreet e calendario economico filtrato per
  EUR/USD con tag di impatto, previsione e countdown sul prossimo evento.
- **Studio del sentiment**: forza relativa delle divise su scala 0-100 e posizionamento
  istituzionale **reali** (CFTC Commitments of Traders + VIX + indice del dollaro),
  regime risk-on/risk-off dal VIX, momentum della coppia dai prezzi veri. Il
  pannello retail resta un modello simulato dichiarato, fuori dal punteggio.
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
- **Studi di sentiment**: con i dati reali il posizionamento istituzionale arriva
  dal **report COT della CFTC** (settimanale, dati di martedì rilasciati venerdì),
  il regime di rischio dal **VIX reale** e la forza del dollaro dall'**indice DXY**;
  il pannello retail resta simulato e dichiarato, fuori dal punteggio. Senza le
  fonti il sentiment ripiega sul modello simulato e viene escluso dal verdetto.
- Gli endpoint di Yahoo Finance e della CFTC usati sono **ufficiali/non ufficiali
  rispettivamente**: la CFTC è il regolatore stesso (dati pubblici, stabili), mentre
  Yahoo può cambiare o rispondere con liste d'attesa (HTTP 429). Il ponte gestisce
  entrambi i casi ripiegando sulla cache o sulla modalità simulata.

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

Il modulo `js/sentiment.js` ha **due motori**: uno reale, costruito su fonti
autorevoli, e uno simulato dichiarato per quando le fonti non rispondono.

**Sentiment reale (modalità dati reali, `js/sentiment.js: analyzeReal`)** —
quattro componenti, tutte su dati veri:

1. **Posizionamento CFTC (COT)** — il report settimanale *Commitments of
   Traders* del regolatore USA (API ufficiale `publicreporting.cftc.gov`,
   nessuna chiave): posizionamento netto non-commerciale in % dell'open
   interest, letto come **percentile della storia a 5 anni** (contratti CME:
   EUR 099741, JPY, GBP, CHF, CAD, AUD, NZD; oro e argento COMEX). Peso 0,35.
2. **Flussi settimanali COT** — variazione del posizionamento netto rispetto
   alla settimana precedente. Peso 0,15.
3. **Momentum del prezzo reale** — ROC 5/20 barre della coppia (candele vere),
   normalizzato su ATR. Peso 0,30.
4. **Regime di rischio dal VIX reale** — livello del VIX come percentile della
   distribuzione annua; in risk-on favorisce le divise pro-cicliche, in
   risk-off i rifugi. Peso 0,20.

La forza del dollaro (per la gamba USD) è misurata dall'**indice DXY reale**
(percentile del trend a 20 sedute). Il pannello retail resta un modello
simulato dichiarato ed è **escluso dal punteggio**. Con tutti i dati reali il
sentiment **rientra nel verdetto di confluenza** a pieno titolo.

**Sentiment simulato (fallback)** — quando il ponte o le fonti non rispondono
lo studio torna all'originale a quattro voci: forza valute calcolata sui
prezzi disponibili (con un solo cambio reale la classifica è dichiarata
incompleta e il sentiment è escluso dal verdetto), propensione al rischio e i
due modelli dichiaratamente simulati (retail e istituzionale).

Il punteggio di sentiment confluisce con gli altri due motori nel verdetto finale.

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

- `tests/selfcheck.html` — 113 controlli: indicatori su serie costruite a mano, validità
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
- `tests/live.html` — 32 controlli end-to-end con il ponte dei dati reali attivo:
  badge e ora di aggiornamento, prezzo EUR/USD reale, analisi calcolate sui prezzi veri,
  i tre studi sempre visibili con il sentiment marcato «escluso dal verdetto» e il
  verdetto che pesa solo i modelli con un universo completo,
  report con la sezione "La fonte dei dati", passaggio a GBP/JPY (badge che torna
  simulato) e ritorno a EUR/USD, storia giornaliera di 5 anni dichiarata
  nell'interfaccia, assenza di errori JavaScript.
- `tests/slowstart.html` — 10 controlli sull'avvio con il ponte **lento**. Il ponte di
  prova (`server.py --delay-ms 3200`) ritarda di tre secondi le risposte `/api/`: nei
  primi secondi l'app ha già i timer attivi (il tick "live" scatta ogni 2,5 s) ma non ha
  ancora ricevuto la prima serie di prezzi. La suite verifica che quella finestra passi
  senza errori JavaScript, che il crosshair sul grafico vuoto non rompa niente, che i
  dati arrivino e che il ritardo ci sia davvero (altrimenti il test non proverebbe
  nulla). Serve a coprire le corse all'avvio: una versione precedente dell'app lanciava
  un'eccezione ogni 2,5 s finché i dati non arrivavano.

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
