#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ForexVision - avvio della webapp
#
# Uso:  ./avvia.sh                  avvia il server locale (con dati reali) e apre l'app
#       ./avvia.sh --lan            rende l'app raggiungibile dalla rete locale
#       ./avvia.sh --port 8199      usa una porta precisa (errore se è occupata)
#       ./avvia.sh --host 0.0.0.0   come --lan, con un indirizzo scelto a mano
#       ./avvia.sh --file           forza l'apertura diretta del file (file://)
#       ./avvia.sh --stop           ferma il server locale avviato in precedenza
#
# Il server (server.py) serve i file e, attraverso /api/candles, porta i
# prezzi reali di EUR/USD da Yahoo Finance. Senza rete l'app ripiega da sola
# sulla modalità simulata, dichiarandolo in alto a destra.
#
# Con --lan il ponte ascolta su tutte le interfacce (rete locale e Tailscale):
# utile per usare l'app dal telefono o da un altro computer. L'app non chiede
# password: apri la porta solo su reti di cui ti fidi.
# ---------------------------------------------------------------------------
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8901}"
PIDFILE_BASE="/tmp/forexvision"
HOST="${FOREXVISION_HOST:-127.0.0.1}"
OPZIONE=""
PORTA_FISSA=""

# --- opzioni --------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --lan)     HOST="0.0.0.0"; shift ;;
    --host)    HOST="${2:-}"; shift 2 ;;
    --host=*)  HOST="${1#*=}"; shift ;;
    --port)    PORTA_FISSA="${2:-}"; shift 2 ;;
    --port=*)  PORTA_FISSA="${1#*=}"; shift ;;
    *)         [ -z "$OPZIONE" ] && OPZIONE="$1"; shift ;;
  esac
done

if [ -n "$PORTA_FISSA" ] && ! [ "$PORTA_FISSA" -ge 1 ] 2>/dev/null; then
  echo "Porta non valida: $PORTA_FISSA"
  exit 2
fi

case "$OPZIONE" in
  ""|--file|--stop) ;;
  *) echo "Opzione non riconosciuta: $OPZIONE"; echo "Uso: ./avvia.sh [--lan|--port N|--host INDIRIZZO|--file|--stop]"; exit 2 ;;
esac

# --- utilita' -------------------------------------------------------------

# porta_libera PORTA -> stampa "ok" oppure "busy"
porta_libera() {
  python3 - "$1" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
    print("ok")
except OSError:
    print("busy")
finally:
    s.close()
PY
}

apri() {
  local target="$1"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$target" >/dev/null 2>&1 &
  elif command -v firefox >/dev/null 2>&1; then
    firefox "$target" >/dev/null 2>&1 &
  else
    echo "Apri manualmente: $target"
  fi
}

# --- stop -----------------------------------------------------------------

if [ "$OPZIONE" = "--stop" ]; then
  fermato=0
  for f in "${PIDFILE_BASE}"-*.pid; do
    [ -f "$f" ] || continue
    porta="$(basename "$f" .pid | sed 's/.*-//')"
    pid="$(cat "$f")"
    if kill "$pid" 2>/dev/null; then
      # il server puo' impiegare un istante a mollare la porta
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.3
      done
      kill -9 "$pid" 2>/dev/null
      echo "Server locale fermato (pid $pid, porta $porta)."
      fermato=1
    else
      echo "Nessun processo attivo per la porta $porta (pidfile vecchio: $pid)."
    fi
    rm -f "$f"
  done
  [ "$fermato" = 1 ] || echo "Nessun server locale in esecuzione."
  exit 0
fi

# --- apertura diretta del file -------------------------------------------

if [ "$OPZIONE" = "--file" ] || ! command -v python3 >/dev/null 2>&1; then
  echo "Apertura diretta del file."
  apri "file://$DIR/index.html"
  echo "Percorso: $DIR/index.html"
  exit 0
fi

# --- scelta della porta ---------------------------------------------------

scelta=""
if [ -n "$PORTA_FISSA" ]; then
  # porta imposta: niente ripieghi silenziosi, se e' occupata lo si dice
  scelta="$PORTA_FISSA"
  pidfile_fissa="${PIDFILE_BASE}-${scelta}.pid"
  nostro=0
  if [ -f "$pidfile_fissa" ] && kill -0 "$(cat "$pidfile_fissa")" 2>/dev/null; then
    nostro=1
  fi
  if [ "$nostro" != 1 ] && [ "$(porta_libera "$scelta")" != "ok" ]; then
    echo "La porta $scelta e' occupata da un altro processo."
    echo "Chi la occupa: $(ss -ltnp 2>/dev/null | grep -m1 ":$scelta " | sed 's/^ *//' || echo 'non identificato')"
    echo "Fermalo oppure avvia con un'altra porta (--port N)."
    exit 1
  fi
else
  for p in $(seq "$PORT" $((PORT + 40))); do
    if [ "$(porta_libera "$p")" = "ok" ]; then scelta="$p"; break; fi
  done
fi

if [ -z "$scelta" ]; then
  echo "Nessuna porta libera fra $PORT e $((PORT + 40)): apertura diretta del file."
  apri "file://$DIR/index.html"
  echo "Percorso: $DIR/index.html"
  exit 0
fi

PIDFILE="${PIDFILE_BASE}-${scelta}.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Server gia' attivo sulla porta $scelta."
else
  # `exec` fa diventare la sottoshell il processo del server: cosi' il pid
  # salvato e' quello vero di python e `--stop` lo ferma davvero (senza exec
  # si registrava la sottoshell, e il server restava vivo e in ascolto).
  ( cd "$DIR" && exec nohup python3 "$DIR/server.py" --port "$scelta" --host "$HOST" --no-browser \
      >"/tmp/forexvision-server-$scelta.log" 2>&1 ) &
  echo $! > "$PIDFILE"
  # attesa che il server risponda (max ~5 secondi)
  pronta=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    if (exec 3<>/dev/tcp/127.0.0.1/"$scelta") 2>/dev/null; then
      exec 3<&- 3>&-
      pronta=1
      break
    fi
  done
  if [ "$pronta" != 1 ]; then
    echo "Il server locale non ha risposto: apro direttamente il file."
    rm -f "$PIDFILE"
    apri "file://$DIR/index.html"
    echo "Percorso: $DIR/index.html"
    exit 0
  fi
  echo "Server locale attivo su http://127.0.0.1:$scelta"
  echo "Log: /tmp/forexvision-server-$scelta.log (fermalo con: ./avvia.sh --stop)"
  if [ "$HOST" != "127.0.0.1" ]; then
    # il server ha gia' stampato gli indirizzi con cui e' raggiungibile
    grep -E "dalla rete|attenzione: la porta" "/tmp/forexvision-server-$scelta.log" 2>/dev/null | sed 's/^/  /'
  fi
fi

apri "http://127.0.0.1:$scelta/index.html"
echo "Percorso: $DIR/index.html"
