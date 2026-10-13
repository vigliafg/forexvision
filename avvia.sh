#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ForexVision - avvio dell'applicazione (Linux, macOS)
#
#   ./avvia.sh                avvia il ponte sulla porta 8199 e apre l'app nel
#                             browser di sistema; quando chiudi la finestra
#                             dell'app il ponte si ferma e lo script esce
#   ./avvia.sh --stop         ferma un ponte rimasto attivo sulla porta
#   ./avvia.sh --lan          rende l'app raggiungibile dalla rete locale
#   ./avvia.sh --port 9000    usa un'altra porta (predefinita: 8199)
#   ./avvia.sh --host IND     indirizzo di ascolto esplicito
#
# La porta e' sempre la stessa e non c'e' ripiego silenzioso: se e' occupata lo
# script lo dice e non parte. Il ponte si spegne da solo quando la pagina segnala
# la chiusura della finestra (e il token che lo autorizza lo genera questo
# script, quindi un ponte avviato a mano non si spegne mai da solo).
#
# Variabili utili:
#   FOREXVISION_PORT      porta da usare al posto di 8199
#   FOREXVISION_PYTHON    interprete da usare (predefinito: python3)
#   FOREXVISION_BROWSER   comando con cui aprire l'app (serve anche ai test:
#                         deve accettare l'indirizzo come primo argomento)
# ---------------------------------------------------------------------------
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${FOREXVISION_PORT:-8199}"
HOST="127.0.0.1"
PY="${FOREXVISION_PYTHON:-python3}"
PIDFILE_BASE="/tmp/forexvision"
AZIONE="avvia"

# --- opzioni --------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --stop)    AZIONE="stop"; shift ;;
    --lan)     HOST="0.0.0.0"; shift ;;
    --host)    HOST="${2:-}"; shift 2 ;;
    --host=*)  HOST="${1#*=}"; shift ;;
    --port)    PORT="${2:-}"; shift 2 ;;
    --port=*)  PORT="${1#*=}"; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         echo "Opzione non riconosciuta: $1"; echo "Uso: ./avvia.sh [--lan|--port N|--host INDIRIZZO|--stop]"; exit 2 ;;
  esac
done

if ! [ "$PORT" -ge 1 ] 2>/dev/null; then
  echo "Porta non valida: $PORT"
  exit 2
fi

PIDFILE="$PIDFILE_BASE-$PORT.pid"

# --- stop -----------------------------------------------------------------
# Ferma il ponte di questa porta: prima quello che ha scritto questo script
# (pidfile), poi, se serve, qualunque altro processo che occupi la porta.
if [ "$AZIONE" = "stop" ]; then
  fermato=0
  if [ -f "$PIDFILE" ]; then
    pid="$(cut -d' ' -f1 <"$PIDFILE" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null; then
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.3
      done
      kill -9 "$pid" 2>/dev/null
      echo "Ponte fermato (pid $pid, porta $PORT)."
      fermato=1
    fi
    rm -f "$PIDFILE"
  fi
  # pidfile di altre porte lasciati da avvii precedenti
  for f in "$PIDFILE_BASE"-*.pid; do
    [ -f "$f" ] || continue
    pid="$(cut -d' ' -f1 <"$f" 2>/dev/null || true)"
    [ -n "${pid:-}" ] || { rm -f "$f"; continue; }
    if kill "$pid" 2>/dev/null; then
      sleep 0.3
      kill -9 "$pid" 2>/dev/null
      echo "Ponte fermato (pid $pid, porta $(basename "$f" .pid | sed 's/.*-//'))."
      fermato=1
    fi
    rm -f "$f"
  done
  [ "$fermato" = 1 ] || echo "Nessun ponte attivo da fermare."
  exit 0
fi

# --- utilita' -------------------------------------------------------------

porta_occupata() {
  (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null
}

# Il ponte risponde? Non basta la porta aperta: serve una risposta HTTP dell'app.
ponte_pronto() {
  "$PY" - "$PORT" <<'PY' 2>/dev/null
import sys, urllib.request
port = sys.argv[1]
try:
    with urllib.request.urlopen("http://127.0.0.1:%s/index.html" % port, timeout=2) as r:
        sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
PY
}

apri_app() {
  local url="$1"
  if [ -n "${FOREXVISION_BROWSER:-}" ]; then
    "$FOREXVISION_BROWSER" "$url" >/dev/null 2>&1 &
    return 0
  fi
  case "$(uname -s)" in
    Darwin)
      open "$url" >/dev/null 2>&1 && return 0 ;;
    Linux)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url" >/dev/null 2>&1 && return 0
      fi
      for b in firefox firefox-esr chromium chromium-browser google-chrome brave-browser microsoft-edge; do
        if command -v "$b" >/dev/null 2>&1; then
          "$b" "$url" >/dev/null 2>&1 &
          return 0
        fi
      done ;;
  esac
  return 1
}

# --- il ponte e' gia' attivo? --------------------------------------------
SERVER_PID=""
TOKEN=""
AVVIATO_DA_ME=0

if porta_occupata 127.0.0.1 "$PORT"; then
  if [ -f "$PIDFILE" ]; then
    pid="$(cut -d' ' -f1 <"$PIDFILE" 2>/dev/null || true)"
    tok="$(cut -d' ' -f2 <"$PIDFILE" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null && [ -n "${tok:-}" ]; then
      SERVER_PID="$pid"
      TOKEN="$tok"
      echo "Il ponte era gia' attivo sulla porta $PORT (pid $pid): riapro la finestra dell'app."
    fi
  fi
  if [ -z "$TOKEN" ]; then
    echo "La porta $PORT e' gia' occupata da un altro processo."
    echo "Chi la occupa: $(ss -ltnp 2>/dev/null | grep -m1 ":$PORT " | sed 's/^ *//' || echo 'non identificato')"
    echo "Fermalo, oppure ferma il ponte con: ./avvia.sh --stop"
    exit 1
  fi
fi

# --- avvio ----------------------------------------------------------------
LOG="/tmp/forexvision-server-$PORT.log"

if [ -z "$TOKEN" ]; then
  TOKEN="$("$PY" -c 'import secrets; print(secrets.token_urlsafe(12))' 2>/dev/null || echo "$$-$(date +%s)")"
  : >"$LOG"
  "$PY" "$DIR/server.py" --port "$PORT" --host "$HOST" --no-browser \
      --strict-port --close-token "$TOKEN" >>"$LOG" 2>&1 &
  SERVER_PID=$!
  AVVIATO_DA_ME=1
  echo "$SERVER_PID $TOKEN" >"$PIDFILE"

  pronta=0
  for _ in $(seq 1 40); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
    if ponte_pronto; then pronta=1; break; fi
    sleep 0.5
  done
  if [ "$pronta" != 1 ]; then
    echo "Il ponte non ha risposto sulla porta $PORT."
    sed 's/^/  /' "$LOG" | tail -5
    kill "$SERVER_PID" 2>/dev/null
    rm -f "$PIDFILE"
    exit 1
  fi
fi

URL="http://127.0.0.1:$PORT/index.html?chiudi=$TOKEN"

echo "ForexVision sulla porta $PORT (pid $SERVER_PID)"
echo "  app   : $URL"
if [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "localhost" ]; then
  echo "  rete  : raggiungibile da questa macchina sulla rete locale (nessuna password)"
fi
echo "  log   : $LOG"

if [ "${FOREXVISION_NO_BROWSER:-0}" = "1" ]; then
  echo "  apri l'indirizzo qui sopra nel browser (apertura automatica disattivata)."
elif apri_app "$URL"; then
  echo "  aperta nel browser di sistema."
else
  echo "  non ho trovato un browser da avviare: apri l'indirizzo qui sopra."
fi
echo "Chiudi la finestra dell'app per fermare il ponte (oppure Ctrl+C)."
echo

# --- attesa ---------------------------------------------------------------
# Il ponte esce da solo quando la finestra si chiude; Ctrl+C, SIGHUP (chiusura
# della finestra del terminale) e SIGTERM fermano tutto e tolgono il pidfile.
pulisci() {
  if [ "$AVVIATO_DA_ME" = 1 ] && [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$SERVER_PID" 2>/dev/null
    echo
    echo "Ponte fermato."
  fi
  [ "$AVVIATO_DA_ME" = 1 ] && rm -f "$PIDFILE"
}
trap 'pulisci; exit 0' INT TERM HUP

if [ "$AVVIATO_DA_ME" = 1 ]; then
  # `wait` torna anche quando arriva un segnale gestito dal trap
  wait "$SERVER_PID" 2>/dev/null
  rm -f "$PIDFILE" 2>/dev/null
else
  # ponte di un avvio precedente: non e' figlio di questa shell, quindi si
  # guarda se e' ancora vivo (finche' c'e', la finestra resta aperta)
  while kill -0 "$SERVER_PID" 2>/dev/null; do sleep 0.5; done
fi
echo "Fine: il ponte non e' piu' attivo."
