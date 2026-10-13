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
./avvia.sh              # avvia il ponte sulla porta 8199 e apre l'app nel browser di sistema
./avvia.sh --stop       # ferma un ponte rimasto attivo
./avvia.sh --lan        # raggiungibile anche dalla rete locale
./avvia.sh --port 9000  # un'altra porta (predefinita: 8199)
./avvia.sh --host 127.0.0.1
```

Su Windows c'è lo stesso lanciatore in versione `.bat` (doppio clic, oppure
`avvia.bat --stop` dalla riga di comando).

I due lanciatori fanno la stessa cosa:

1. avviano il ponte sulla porta **8199**; se è occupata da un altro processo lo dicono
   e non partono: nessun ripiego silenzioso su un'altra porta;
2. aspettano che il ponte risponda e aprono l'app nel **browser di sistema**;
3. quando chiudi la **finestra dell'app** fermano il ponte ed escono. Anche `Ctrl+C`
   o la chiusura della finestra del terminale fermano tutto, senza lasciare processi appesi.

La chiusura funziona perché la pagina tiene aperta una connessione col ponte
(`/api/sessione`): quando la finestra sparisce, la connessione cade e il server si ferma.
Un ricaricamento non chiude niente (la pagina ricaricata si ricollega subito) e il permesso
di chiudere è un token che genera il lanciatore: un ponte avviato a mano (`python3
server.py`) non si spegne **mai** da solo.

Aprire `index.html` direttamente da `file://` resta possibile: in quel caso l'app cerca il
ponte sulle porte 8199-8208 e, se non lo trova, ripiega sulla modalità simulata.

Il server `server.py` serve i file **e** espone `/api/candles` (prezzi veri da
Yahoo Finance), `/api/sentiment` (CFTC COT + VIX + indice del dollaro) e
`/api/news` (RSS ForexLive/FXStreet/Fed/BCE + calendario ForexFactory), consegnati
ripuliti e in cache nel formato dell'app. A questi si aggiungono i due indirizzi che
servono alla chiusura automatica: `/api/sessione` (la finestra dell'app resta collegata
finché è aperta) e `/api/chiudi` (il segnale di chiusura, solo col token del lanciatore).
Le opzioni `--strict-port` e `--close-token` servono ai lanciatori; `python3 server.py`
da solo resta un ponte normale, che non si spegne mai da solo. Se il server
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
`http://192.168.1.124:8199/index.html`. Lo stesso si ottiene direttamente da
`server.py` con `--host 0.0.0.0` (o con la variabile `FOREXVISION_HOST`).

Non serve toccare il firewall: se `ufw`, `firewalld` o regole `nft`/`iptables` non sono
presenti, la porta in ingresso non è filtrata (qui la catena `INPUT` ha politica
`ACCEPT`, con le sole regole aggiunte da Tailscale). Se in futuro si installa un
firewall, va aperta la porta scelta (`sudo ufw allow 8199/tcp` e simili).

Attenzione: l'app **non chiede password**. Chi raggiunge quella porta vede l'app,
i dati di mercato e gli endpoint del ponte. Va usata su reti di cui ci si fida
(casa, VPN Tailscale), non su reti pubbliche, e l'opzione è volutamente esplicita:
senza `--lan` o `--host` il ponte resta chiuso su `127.0.0.1`.

### Porta, log e pidfile

La porta è **8199** per tutti e tre i lanciatori (`.sh`, `.bat` e `python3 server.py`);
si cambia con `--port N` o con la variabile `FOREXVISION_PORT`, ma l'indirizzo da
ricordare resta uno. Se la porta è occupata lo script **non ripiega in silenzio**: dice
chi la occupa ed esce con codice diverso da zero. Se il ponte sulla 8199 è già stato
avviato da lì, lo riconosce (pidfile e token) e apre soltanto la finestra dell'app.

Il log del ponte finisce in `/tmp/forexvision-server-8199.log`; su Windows l'output resta
nella finestra del `.bat`. Il pidfile (`/tmp/forexvision-8199.pid`) serve a `--stop` e al
riconoscimento del ponte già attivo.

## Struttura

```
forex/
├── index.html            interfaccia (6 aree a tab: dashboard, grafici, tecnica, SMC, sentiment+notizie, registro)
├── css/styles.css        tema scuro da terminale di trading
├── server.py             ponte dati locale: file statici (senza cache) + /api/candles, /api/sentiment, /api/news
├── js/
│   ├── data.js           generatore di serie OHLC sintetiche
│   ├── indicators.js     libreria di indicatori tecnici
│   ├── forecast.js       motore previsionale + backtest walk-forward
│   ├── smc.js            motore Smart Money Concepts
│   ├── divergence.js     divergenze prezzo/oscillatori (RSI e MACD) + studio di efficacia
│   ├── sentiment.js      studio del sentiment (forza valute, posizionamento, rischio)
│   ├── feed.js           lettura e controllo dei dati reali, sentiment e notizie dal ponte
│   ├── report.js         report divulgativo in linguaggio semplice
│   ├── help.js           spiegazione di ogni card, con i dati del momento
│   ├── chart.js          renderer del grafico a candele su canvas
│   ├── ui.js             navigazione a tab e componenti grafici (dial, ladder, mappe)
│   └── app.js            controller e collegamento all'interfaccia
├── tests/
│   ├── expected.js       tabella dei valori attesi, generata dai dati (riferimento dei test)
│   ├── selfcheck.html    test automatici sui moduli
│   ├── smoke.html        test end-to-end sull'interfaccia (modalità simulata)
│   ├── live.html         test end-to-end con i dati reali del ponte
│   ├── slowstart.html    avvio con il ponte lento (corse all'avvio)
│   ├── calibration.html  misura della calibrazione di volatilità
│   └── lanciatore.sh     verifica dei lanciatori (porta 8199, browser, spegnimento)
├── avvia.sh              lanciatore Linux/macOS: porta 8199, browser, stop alla chiusura
└── avvia.bat             lanciatore Windows: stesso comportamento (doppio clic)
```

## Cosa fa l'applicazione

L'interfaccia è organizzata in **6 aree a tab** per non mescolare letture di scala diversa:
**Dashboard** (verdetto combinato, scala operativa, tre modelli a confronto, prossimo evento,
watchlist), **Grafici** (candele, indicatori di trend e inversione, divergenze e livelli, proiezione,
backtest, contesto), **Analisi tecnica** (segnale operativo, gauge e divergenze), **SMC** (struttura, mappa liquidità,
scala ed eventi), **Sentiment e notizie** (banda affiancata) e **Registro**. In ogni tab
restano i dettagli numerici (con il dettaglio tabellare ripiegato nell'analisi tecnica).

- **Grafico a candele** con medie esponenziali (9/21/50), bande di Bollinger, volumi,
  overlay SMC (order block, fair value gap, BOS/CHoCH, pool di liquidità, premio/sconto),
  crosshair con tooltip OHLC e zoom con la rotella del mouse. Cinque sovrapposizioni in più,
  attivabili dai pulsanti sopra il grafico: **SuperTrend**, **Parabolic SAR**,
  **Ichimoku** (nuvola, Tenkan/Kijun), **divergenze** (i due swing collegati con la
  freccia sul più recente) e **pivot point** (i sette livelli del periodo precedente).
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
- **Indicatori di trend e di inversione**, in un blocco identico in **due punti**: subito
  sotto il grande grafico (tab Grafici) e nella tab Analisi tecnica.
  *Trend*: SuperTrend (ATR 10 × 3), Ichimoku 9/26/52 (nuvola, Tenkan/Kijun e conferma
  del ritardo), +DI/−DI (DMI 14), ADXR (la tendenza si rafforza o si spegne), Aroon (25),
  Vortex (14) e canale di regressione lineare (50) con il suo R².
  *Inversione*: Parabolic SAR (0,02/0,2), CCI (20), Stochastic RSI (14) e Choppiness
  Index (14) per distinguere il mercato di tendenza da quello laterale, con i canali di
  Keltner (20 · 2 ATR) confrontati con Bollinger per segnalare lo *squeeze* di volatilità.
  Tutti entrano anche nel **dettaglio numerico** ripiegato della tab Analisi tecnica, con
  la stessa lettura (RIALZO / RIBASSO / NEUTRO) delle altre gauge.
- **Divergenze e livelli di riferimento** (`js/divergence.js`): confronta i punti di swing
  del prezzo (gli stessi dello studio SMC) con RSI e istogramma MACD e riconosce i quattro
  casi classici — divergenza *regolare* rialzista o ribassista (il movimento perde forza)
  e *nascosta* (il movimento sta solo ricaricando). Insieme ai **pivot point** (classici e
  Camarilla, calcolati su massimo, minimo e chiusura del periodo di contrattazione
  precedente) forma un pannello mostrato sia sotto il grafico sia nella tab Analisi
  tecnica. Il rilevatore considera solo swing già confermati alla barra in esame: nessun
  look-ahead. Nello stesso pannello è ripiegato lo **studio di efficacia**: quanti casi
  sono stati misurati nella finestra, quante volte il movimento è andato davvero nel verso
  del segnale e il rendimento medio in multipli di ATR, con l'incertezza dell'intervallo di
  confidenza al 95% e il profit factor. Il verdetto dichiara un vantaggio **solo se il
  margine supera l'incertezza statistica**: sui dati di prova non lo fa, e lo dice
  esplicitamente (vedi «Cosa non promette»).
- **Stop mobile dal SuperTrend**: nel piano operativo compare il livello che il trend
  offre come stop dinamico, con la distanza in pip e l'indicazione se è dalla stessa parte
  dello scenario o contro.
- **Watchlist** sui 14 strumenti (major, cross e metalli) ordinata per punteggio.
- **Backtest walk-forward** senza look-ahead bias: hit rate, R medi, profit factor,
  drawdown massimo e curva equity in punti R.
- **Registro operazioni virtuali** salvato in `localStorage`, con esito manuale e
  hit rate complessivo.
- **Aiuto delle card** (`js/help.js`): ogni card e ogni grafico hanno un bottone con il
  punto interrogativo che apre una finestra con tre sezioni — che cosa mostra la card in
  generale, come si legge il contenuto, e i dati presenti **in quel momento** — con testo
  scorrevole e bottone di chiusura (funzionano anche Esc e il clic sullo sfondo). La
  spiegazione si rigenera a ogni apertura e, se la finestra resta aperta mentre arrivano
  candele nuove, si aggiorna da sola con i dati appena ricalcolati. Il testo sta in un
  modulo separato dalla logica e le funzioni che leggono i dati sono difensive: prima
  della prima analisi, o senza il ponte dati, la finestra mostra comunque la spiegazione
  completa invece di errori.
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

### Cosa non promette (misurato, non dichiarato)

Lo studio di efficacia delle divergenze esiste per **ridurre** le promesse, non per
aggiungerne. Il verdetto si basa sul margine rispetto all'incertezza: un segnale è
"utile" solo se il rendimento medio supera l'intervallo di confidenza al 95%.

| Campione | Casi | A favore | R medio (ATR) | Intervallo 95% |
|---|---|---|---|---|
| Tutte le divergenze | 1461 | 47,6% | +0,008 | ± 0,065 |
| Regolari | 723 | 46,3% | ‑0,034 | ± 0,092 |
| Nascoste | 738 | 48,9% | +0,049 | ± 0,093 |
| Solo RSI | 718 | 47,4% | ‑0,006 | ± 0,092 |
| Solo MACD | 743 | 47,9% | +0,021 | ± 0,093 |

Il campione sono 90 serie simulate da 420 barre (generatore dell'app, seed diverso),
con orizzonte di 10 barre e ogni esito normalizzato con l'ATR del momento del segnale.
Su questi dati **il segnale non mostra alcun vantaggio distinguibile dal caso**, e
l'interfaccia lo dichiara riga per riga. La finestra mostrata nell'app (300 barre)
contiene tipicamente 15–35 casi: abbastanza per leggere una tendenza, troppo pochi per
concludere. Non è una svista del calcolo: è il risultato, e resta visibile in chiaro.

**Ho provato anche a segmentare per regime**, per vedere se il segnale funziona almeno in
un contesto specifico. Non succede: sui 1461 casi, ADX < 20 porta R +0,017 ± 0,083 e
ADX ≥ 25 porta R ‑0,013 ± 0,135; Choppiness > 61,8 (mercato laterale) porta
R ‑0,022 ± 0,082; R² del canale sotto 0,5 porta R ‑0,000 ± 0,109. Nemmeno un sottogruppo
supera l'incertezza statistica. Per questo la dimensione del regime **non è stata portata
nel pannello**: aggiungerebbe rumore a un campione già piccolo (15–35 casi per finestra)
senza aggiungere informazione. La misura resta qui, insieme al motivo della decisione.

Limite dichiarato: il generatore di serie sintetiche produceva un solo livello di
volatilità (ATR/EA sempre sopra 0,05%), quindi la segmentazione per volatilità non è
informativa su questo campione; un test su dati reali richiederebbe più storia di quella
che il ponte espone per singola coppia.

Anche gli altri indicatori aggiunti (SuperTrend, Ichimoku, Aroon, Vortex, CCI, Parabolic
SAR, Choppiness, Keltner, pivot point) sono **informativi**: non entrano nel punteggio
previsionale, per non alterare le prestazioni del backtest documentate in
«Realismo dei dati e calibrazione».

## Il report in linguaggio semplice

Il pulsante **Report** nella barra in alto (o **Leggi il report completo** sotto la
scheda di confluenza) apre un documento pensato per chi non è un professionista.
Si apre anche direttamente con il collegamento `index.html#report`.

Il report contiene sette sezioni:

1. **Il quadro in breve** - il verdetto dei tre studi in tre righe.
2. **Che cosa sta facendo il mercato adesso** - il prezzo e la sua variazione, la forza
   della tendenza e l'ampiezza dei movimenti, in parole semplici.
3. **Analisi tecnica: che cosa dicono i numeri** - una tabella con ogni indicatore (compresi
   SuperTrend, Ichimoku, divergenze e pivot point), che cosa misura e come si legge adesso,
   il verdetto, il movimento atteso con la sua fascia di incertezza, i livelli operativi e
   il livello dello stop mobile.
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

- `tests/selfcheck.html` — 202 controlli: indicatori su serie costruite a mano, validità
  delle serie OHLC, ordine cronologico, motore previsionale e backtest, assenza di NaN
  su 84 combinazioni strumento × timeframe (ora anche M10), realismo della volatilità,
  **indicatori di trend e inversione** (SuperTrend e Parabolic SAR dal lato giusto rispetto
  al prezzo, Aroon agli estremi su una serie monotona, Vortex e DMI concordi col verso,
  ADXR e ichimoku senza look-ahead, Choppiness basso sul trend e alto sul laterale,
  Keltner in ordine, R² della regressione alto su una retta e basso su una serie che
  oscilla, nessun NaN su tutte le nuove serie), **divergenze** (rilevate su una serie a
  doppio minimo, ogni voce conforme alla propria definizione, ordine per recenza,
  causalità, determinismo), **studio di efficacia delle divergenze** (casi misurati
  sulla serie, esito che parte dalla barra di conferma dello swing, nessun dato futuro
  usato all'ingresso, ogni esito normalizzato con l'ATR del segnale e non con quello
  finale, tasso di successo coerente con i casi, media e intervallo di confidenza
  ricalcolati a mano, vantaggio dichiarato solo oltre l'incertezza, ripartizione per
  tipo e per oscillatore che copre tutti i casi, riproducibilità, serie troppo corta
  gestita, verdetto prudente quando l'intervallo contiene lo zero) e **pivot point**
  (ordine dei livelli classici e Camarilla, calcolo sull'ultimo periodo chiuso, serie
  troppo corte respinte),
  **SMC** (swing, BOS/CHoCH, order block, FVG, liquidità, range/OTE, coerenza dello
  scenario, assenza di look-ahead, determinismo), **sentiment** (forza delle valute e
  sua coerenza con i prezzi, posizionamento, regime di rischio, confluenza, universo
  ridotto con dati reali), **feed** (pulizia delle candele, costruzione della serie dal
  payload del ponte, rifiuto di serie troppo corte, confluenza ridotta senza sentiment)
  e **report** (sezioni presenti, glossario completo rispetto ai termini usati, frasi
  brevi, numeri coerenti con i dati, sezione "La fonte dei dati" nei due casi: reale e
  simulata). Una parte copre le **spiegazioni delle card** (`js/help.js`): testo di base,
  lettura e parte «in questo momento» per tutte e 21, letture difensive quando i dati non
  ci sono ancora, e le **regressioni sui quattro casi in cui il testo divergeva dalla
  card** (regime di trend numerico stampato grezzo, perdita media e discesa massima senza
  il segno meno, classifica delle valute letta come array invece che come `{list: [...]}`,
  conteggi delle voci in elenco diversi da quelli mostrati dai pannelli). Una parte
  verifica poi la **tabella dei valori attesi** (`tests/expected.js`) su un contesto
  sintetico: etichette delle letture uniche, **i contratti derivati dal markup vero
  dell'app** (`index.html` letto dal file, senza aprire l'app) con ogni promessa che
  punta a una lettura esistente, nessun pannello orfano e nessun numero inventato né
  promessa disattesa sui dati generati, **una prova dell'algoritmo di derivazione su un
  markup minimo** (quale card prende quale lettura, un valore mostrato in due pannelli
  che entra in entrambi, un grafico minore col suo riquadro, un pannello vuoto che non
  promette niente), la lettura di date, orari e voci separate da virgola, il confronto
  con una card di prova (che passa coi valori giusti e segnala quello sbagliato) e due
  prove di mutazione: un conteggio e un prezzo falsati devono essere intercettati,
  mentre il testo corretto passa.
- `tests/smoke.html` — controlli end-to-end sull'interfaccia in modalità simulata
  (deterministica) più i controlli sul ponte dei dati reali quando il server è attivo
  (**160 totali**): caricamento dei moduli, popolamento di tutte le sezioni (comprese
  le due griglie di indicatori di trend e inversione, i due pannelli di divergenze e
  pivot con lo studio di efficacia numerico e coincidente nelle due sedi, lo stop
  mobile del SuperTrend e le undici sovrapposizioni del grafico), **bottoni di aiuto**
  (uno su ogni card e su ogni grafico, ognuno con una spiegazione esistente, tre
  sezioni, righe sufficienti e nessun valore senza senso su tutte e 21 le finestre,
  didascalia che dichiara coppia e natura dei dati, lettura che combacia con le
  sovrapposizioni accese in quel momento, **controllo incrociato dai dati** (vedi
  «Tabella dei valori attesi» qui sotto), testo scorrevole su uno schermo normale e
  chiusura con bottone, Esc e clic sullo sfondo),
  confluenza, SMC, sentiment e report), rendering del canvas e dei livelli SMC,
  apertura/chiusura/copia del report, cambio coppia e timeframe, registrazione e
  chiusura di un trade virtuale, assenza di errori JavaScript.
- `tests/live.html` — 38 controlli end-to-end con il ponte dei dati reali attivo:
  badge e ora di aggiornamento, prezzo EUR/USD reale, analisi calcolate sui prezzi veri,
  i tre studi sempre visibili con il sentiment marcato «escluso dal verdetto» e il
  verdetto che pesa solo i modelli con un universo completo,
  report con la sezione "La fonte dei dati", passaggio a GBP/JPY (badge che torna
  simulato) e ritorno a EUR/USD, storia giornaliera di 5 anni dichiarata
  nell'interfaccia, **la stessa tabella dei valori attesi applicata ai dati veri**
  (numeri citati, promesse delle spiegazioni, date di calendario e CFTC, valori delle
  card), assenza di errori JavaScript.

### Tabella dei valori attesi (`tests/expected.js`)

I controlli sulle spiegazioni non elencano a mano i numeri da confrontare: leggono i
dati che l'app usa in quel momento, con lo stesso contesto che alimenta le spiegazioni
(`window.ForexApp.context()`, di sola lettura) e pretendono che il testo citi quelli.
Le regole sono tre, tutte sui dati:

1. **Nessun numero inventato.** Ogni cifra scritta nella parte «In questo momento» deve
   corrispondere a un valore dei dati, arrotondato alla precisione con cui è scritta
   (il confronto è fra stringhe `toFixed`, quindi severo: `1.11908` non passa per
   `1.11907`). Le date e gli orari si leggono prima dei numeri, così `14/10/2026,
   04:10:00` non diventa una fila di numeri sciolti.
2. **Le costanti di formula sono dichiarate.** Periodi e soglie (EMA 9, finestra del
   backtest a 250 candele, scala 0-100) non vengono dai dati: stanno in una lista con
   il motivo scritto accanto e sono l'unica eccezione ammessa.
3. **Le card mostrano gli stessi valori.** Per ogni grandezza la tabella dice dove la
   card la disegna (selettore, decimali, percentuali, voci di elenco, o più pannelli
   insieme): il valore atteso viene dai dati, non dal testo, quindi un numero sbagliato
   in due posti si vede.

### Che cosa promette una spiegazione: derivato dai pannelli

Ogni spiegazione ha un **contratto**, cioè l'elenco delle grandezze che promette di
mostrare, e serve a distinguere un numero giusto da un numero giusto *al posto sbagliato*
(un prezzo che cita il valore della EMA 9). Quell'elenco **non è scritto a mano**: si
legge dal markup dell'app.

- ogni card dichiara la chiave della sua spiegazione (`data-help`), e i grafici minori
  hanno un bottone `data-help-key` accanto al disegno: sono i **pannelli**;
- ogni lettura dichiara dove il pannello la disegna;
- il contratto di una spiegazione è l'insieme delle letture i cui selettori cadono dentro
  il suo pannello.

Quindi la promessa non può divergere dai pannelli: se un pannello comincia a mostrare una
grandezza, quella entra nel contratto da sola (e la sua spiegazione deve citarla, o il
test fallisce); se smette, esce. Un valore mostrato in due sedi — la griglia di trend
sotto il grafico e quella della scheda tecnica, le divergenze e i pivot nelle due
schermate, la scala della dashboard e quella del piano — appartiene al contratto di
entrambe, senza che nessuno debba ricordarselo. Un valore che nessun pannello mostra
(una serie calcolata, un numero che finisce solo nel report) non entra in nessun
contratto: resta coperto dalla prima regola, che gli impedisce comunque di essere
inventato.

Due casi particolari hanno una regola sola, sempre presa dai pannelli:

- **il disegno conta come mostra**. Il grafico, la striscia del moto recente e la curva
  del backtest mostrano i loro valori disegnandoli: quei valori fanno parte del contratto
  (la spiegazione deve citarli) ma non si confrontano con un numero scritto, perché non
  c'è;
- **un pannello vuoto non promette niente**. La promessa di un valore disegnato o scritto
  in una forma non numerica vale solo quando il pannello ha davvero dei numeri sullo
  schermo: il registro vuoto o un calendario senza eventi non pretendono una frase che
  parli di numeri che non ci sono.

Date e orari non fanno eccezione: entrano nel contratto e si verificano confrontando
gli istanti citati nel testo con quelli dei dati.

Nel primo giro la tabella ha trovato tre difetti reali: la riga del SuperTrend non veniva
mai scritta (linea e direzione arrivano come serie, non come numeri, quindi il confronto
di direzione era sempre falso), i quadranti della dashboard restavano sul punteggio di
sentiment precedente quando il sentiment reale si aggiornava senza ridisegnarli, e la
spiegazione del contesto descriveva una finestra di 24 candele mentre il pannello ne
mostrava 100: ora le spiegazioni leggono le stesse cifre che disegna il pannello.

Passando ai contratti derivati sono emersi altri due difetti, della stessa famiglia: due
letture non avevano **mai** un valore perché leggevano come serie due oggetti
(`ind.stochRsi` e `ind.linreg`), quindi la riga dello Stochastic RSI nella spiegazione
citava un numero che non apparteneva a nessuna lettura, e la promessa dello Stochastic
RSI restava vuota per sempre. Le spiegazioni delle due griglie di trend sono ora scritte
una volta sola (`trendGridLines`), perché descrivono lo stesso pannello: prima
divergevano, e una citava indicatori che l'altra ignorava.
- `tests/slowstart.html` — 10 controlli sull'avvio con il ponte **lento**. Il ponte di
  prova (`server.py --delay-ms 3200`) ritarda di tre secondi le risposte `/api/`: nei
  primi secondi l'app ha già i timer attivi (il tick "live" scatta ogni 2,5 s) ma non ha
  ancora ricevuto la prima serie di prezzi. La suite verifica che quella finestra passi
  senza errori JavaScript, che il crosshair sul grafico vuoto non rompa niente, che i
  dati arrivino e che il ritardo ci sia davvero (altrimenti il test non proverebbe
  nulla). Serve a coprire le corse all'avvio: una versione precedente dell'app lanciava
  un'eccezione ogni 2,5 s finché i dati non arrivavano.

- `tests/lanciatore.sh` — 15 controlli sui lanciatori, con la porta 8199 libera
  (`bash tests/lanciatore.sh`): la porta occupata fa uscire il lanciatore senza ripieghi
  silenziosi, l'app viene aperta sull'indirizzo giusto (porta 8199 e token di chiusura),
  un ricaricamento non ferma il ponte, chiudere la finestra lo ferma anche con una
  richiesta in volo proprio in quel momento, e `--stop` funziona. Il `.bat` non è
  eseguibile da qui: su Windows il lanciatore passa al server gli stessi argomenti
  (`--port 8199 --strict-port --close-token`) e lascia a lui l'apertura dell'app e lo
  spegnimento, cioè gli stessi percorsi di codice che la suite prova.

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
