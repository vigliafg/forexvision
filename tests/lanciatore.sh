#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# tests/lanciatore.sh - verifica dei lanciatori (avvia.sh / avvia.bat)
#
# Controlla, sulla porta predefinita 8199, il patto che i lanciatori fanno con
# l'utente:
#   1. la porta e' quella e basta: se e' occupata il lanciatore lo dice ed esce,
#      senza spostarsi in silenzio su un'altra;
#   2. il lanciatore apre l'app nel browser di sistema, con l'indirizzo giusto
#      (porta 8199 e token di chiusura);
#   3. chiudere la finestra ferma il ponte e fa uscire il lanciatore, anche se
#      una richiesta di dati e' in volo proprio in quel momento;
#   4. un ricaricamento non ferma niente (il segnale di chiusura arriva, ma poi
#      la pagina si ricarica);
#   5. `--stop` ferma un ponte rimasto attivo.
#
# Uso:   bash tests/lanciatore.sh
# Nota:  la porta 8199 deve essere libera. Se e' occupata la suite lo dice e si
#        ferma, per non toccare un ponte che sta usando qualcun altro.
#        Windows non e' verificabile da qui: su Windows il lanciatore e' il
#        .bat, che passa al server gli stessi argomenti (porta, --strict-port,
#        --close-token) e lascia a lui l'apertura dell'app e lo spegnimento.
# ---------------------------------------------------------------------------
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8199
PIDFILE="/tmp/forexvision-$PORT.pid"
LOG="/tmp/forexvision-server-$PORT.log"
PY="${FOREXVISION_PYTHON:-python3}"
GRACE=8                       # CLOSE_GRACE_SECONDS di server.py

STUB="/tmp/forexvision-browser-$$.sh"
URLFILE="/tmp/forexvision-url-$$.txt"   # dove il finto browser scrive l'indirizzo
RUNLOG="/tmp/forexvision-lanciatore-$$.log"
OCCUPANTE=""
LANCIATORE=""
PASS=0
FAIL=0

passa() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fallisce() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
titolo() { printf '\n%s\n' "$1"; }

# ------------------------------------------------------------------ pulizia
pulisci() {
  [ -n "$LANCIATORE" ] && kill "$LANCIATORE" 2>/dev/null
  if [ -f "$PIDFILE" ]; then
    pid="$(cut -d' ' -f1 <"$PIDFILE" 2>/dev/null || true)"
    [ -n "${pid:-}" ] && kill -9 "$pid" 2>/dev/null
    rm -f "$PIDFILE"
  fi
  [ -n "$OCCUPANTE" ] && kill -9 "$OCCUPANTE" 2>/dev/null
  rm -f "$STUB" "$URLFILE" "$RUNLOG"
}
trap pulisci EXIT INT TERM

# ------------------------------------------------------------- utilita'
porta_in_ascolto() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# GET/POST con python3: nessuna dipendenza da curl
http() { # http METHOD url
  "$PY" - "$1" "$2" <<'PY' 2>/dev/null
import sys, urllib.request
method, url = sys.argv[1], sys.argv[2]
try:
    with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=8) as r:
        print(r.status)
except Exception:
    print("errore")
PY
}

attendi_ponte() { # attendi_ponte [secondi]
  local fine=$((SECONDS + ${1:-15}))
  while [ $SECONDS -lt $fine ]; do
    [ "$(http GET "http://127.0.0.1:$PORT/api/status")" = "200" ] && return 0
    sleep 0.5
  done
  return 1
}

pid_del_ponte() { cut -d' ' -f1 <"$PIDFILE" 2>/dev/null || true; }
token_del_ponte() { cut -d' ' -f2 <"$PIDFILE" 2>/dev/null || true; }

avvia_lanciatore() { # avvia_lanciatore: avvia avvia.sh in background
  rm -f "$RUNLOG" "$URLFILE"
  FOREXVISION_BROWSER="$STUB" "$ROOT/avvia.sh" >"$RUNLOG" 2>&1 &
  LANCIATORE=$!
  attendi_ponte 20
}

# --------------------------------------------------------------- premessa
# Finto browser: al posto di aprirsi scrive l'indirizzo che il lanciatore gli
# passa. Serve a leggere l'indirizzo che l'utente vedrebbe aprirsi.
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$1" >> "%s"\n' "$URLFILE" >"$STUB"
chmod +x "$STUB"

printf 'Suite dei lanciatori - porta %s\n' "$PORT"
if porta_in_ascolto "$PORT"; then
  printf 'La porta %s e'\'' gia' occupata: chiudi l'\''app e riprova.\n' "$PORT"
  exit 2
fi

# 1. porta fissa: se e' occupata il lanciatore non parte e non ripiega
titolo "1. porta fissa: occupata -> nessun ripiego"
rm -f "$PIDFILE"          # la porta e' libera: nessun ponte puo' essere in corso
# finto ponte: ascolta sulla porta e chiude subito le connessioni, cosi' la
# porta risulta occupata senza lasciare in coda i tentativi di connessione
# (una coda piena bloccherebbe il controllo del lanciatore)
"$PY" -c "
import socket, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', $PORT)); s.listen(16); s.settimeout(0.2)
fine = time.time() + 45
while time.time() < fine:
    try:
        c, _ = s.accept(); c.close()
    except socket.timeout:
        pass
" &
OCCUPANTE=$!
for _ in $(seq 1 20); do porta_in_ascolto "$PORT" && break; sleep 0.3; done

if porta_in_ascolto "$PORT"; then
  FOREXVISION_BROWSER="$STUB" "$ROOT/avvia.sh" >"$RUNLOG" 2>&1
  esito=$?
  if [ "$esito" -ne 0 ]; then passa "esce con errore ($esito) invece di spostarsi di porta"
  else fallisce "e' uscito con esito 0 con la porta occupata"; fi
  if grep -q "$PORT" "$RUNLOG" && grep -qi "occupata" "$RUNLOG"; then
    passa "lo dice chiaramente: $(head -1 "$RUNLOG")"
  else
    fallisce "il messaggio non spiega che la porta $PORT e' occupata"
  fi
  [ -f "$PIDFILE" ] && fallisce "ha lasciato un pidfile" || passa "nessun pidfile lasciato"
else
  fallisce "non sono riuscito a occupare la porta $PORT per la prova"
fi
kill -9 "$OCCUPANTE" 2>/dev/null; OCCUPANTE=""
for _ in 1 2 3 4 5 6 7 8 9 10; do porta_in_ascolto "$PORT" || break; sleep 0.3; done

# 2. avvio: porta 8199 nei fatti, app aperta nel browser di sistema
titolo "2. avvio: porta $PORT e apertura dell'app"
if avvia_lanciatore; then
  passa "il ponte risponde sulla porta $PORT"
else
  fallisce "il ponte non risponde su $PORT"
  sed 's/^/       /' "$RUNLOG" | tail -5
fi
pid="$(pid_del_ponte)"; token="$(token_del_ponte)"
[ -n "$pid" ] && [ -n "$token" ] && passa "pidfile con processo e token" \
  || fallisce "pidfile assente o incompleto"
atteso="http://127.0.0.1:$PORT/index.html?chiudi=$token"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$URLFILE" ] && break; sleep 0.3; done
aperto="$(head -1 "$URLFILE" 2>/dev/null || true)"
if [ "$aperto" = "$atteso" ]; then
  passa "ha aperto l'app: $aperto"
else
  fallisce "indirizzo aperto \"$aperto\", atteso \"$atteso\""
fi
grep -q "ForexVision sulla porta $PORT" "$RUNLOG" && passa "l'avviso a schermo cita la porta $PORT" \
  || fallisce "l'avviso a schermo non cita la porta $PORT"

# 3. ricaricamento: il segnale di chiusura da solo non ferma il ponte
titolo "3. ricaricamento: non ferma il ponte"
http POST "http://127.0.0.1:$PORT/api/chiudi?token=$token" >/dev/null
http GET "http://127.0.0.1:$PORT/index.html" >/dev/null       # la pagina si ricarica
sleep $((GRACE + 4))
if kill -0 "$pid" 2>/dev/null; then passa "dopo un ricaricamento il ponte e' ancora attivo"
else fallisce "il ponte si e' fermato nonostante il ricaricamento"; fi

# 4. chiusura vera, con una richiesta in volo proprio in quel momento
titolo "4. chiusura: ferma il ponte (anche con una richiesta in volo)"
http POST "http://127.0.0.1:$PORT/api/chiudi?token=$token" >/dev/null
http GET "http://127.0.0.1:$PORT/api/candles?tf=M10&symbol=EUR%2FUSD" >/dev/null
fermo=0
for _ in $(seq 1 $((GRACE + 10))); do
  if ! kill -0 "$pid" 2>/dev/null; then fermo=1; break; fi
  sleep 1
done
[ "$fermo" = 1 ] && passa "il ponte si e' fermato entro $((GRACE + 10)) secondi" \
  || fallisce "il ponte e' ancora attivo dopo la chiusura della finestra"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$LANCIATORE" 2>/dev/null || break
  sleep 0.5
done
kill -0 "$LANCIATORE" 2>/dev/null && fallisce "il lanciatore e' rimasto in attesa" \
  || passa "il lanciatore e' uscito"
[ -f "$PIDFILE" ] && fallisce "il pidfile e' rimasto" || passa "pidfile rimosso"
porta_in_ascolto "$PORT" && fallisce "la porta $PORT e' ancora occupata" \
  || passa "porta $PORT libera"
LANCIATORE=""

# 5. --stop: ferma un ponte rimasto attivo
titolo "5. --stop: ferma un ponte rimasto attivo"
if avvia_lanciatore; then
  pid="$(pid_del_ponte)"
  "$ROOT/avvia.sh" --stop >"$RUNLOG" 2>&1
  [ "$(http GET "http://127.0.0.1:$PORT/api/status")" != "200" ] \
    && passa "--stop ferma il ponte" || fallisce "--stop non ha fermato il ponte"
  [ -f "$PIDFILE" ] && fallisce "pidfile rimasto dopo --stop" || passa "pidfile rimosso"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$LANCIATORE" 2>/dev/null || break
    sleep 0.5
  done
  kill -0 "$LANCIATORE" 2>/dev/null && fallisce "il lanciatore resta in attesa dopo --stop" \
    || passa "anche il lanciatore esce"
  LANCIATORE=""
else
  fallisce "il ponte non e' ripartito per la prova di --stop"
fi

# ------------------------------------------------------------------ esito
printf '\n%d controlli superati, %d falliti\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
