#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ForexVision - avvio della webapp
#
# Uso:  ./avvia.sh          avvia il server locale (con dati reali) e apre l'app
#       ./avvia.sh --file   forza l'apertura diretta del file (file://)
#       ./avvia.sh --stop   ferma il server locale avviato in precedenza
#
# Il server (server.py) serve i file e, attraverso /api/candles, porta i
# prezzi reali di EUR/USD da Yahoo Finance. Senza rete l'app ripiega da sola
# sulla modalità simulata, dichiarandolo in alto a destra.
# ---------------------------------------------------------------------------
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8901}"
PIDFILE_BASE="/tmp/forexvision"

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

if [ "${1:-}" = "--stop" ]; then
  fermato=0
  for f in "${PIDFILE_BASE}"-*.pid; do
    [ -f "$f" ] || continue
    pid="$(cat "$f")"
    if kill "$pid" 2>/dev/null; then
      echo "Server locale fermato (pid $pid, porta $(basename "$f" .pid | sed 's/.*-//'))."
      fermato=1
    fi
    rm -f "$f"
  done
  [ "$fermato" = 1 ] || echo "Nessun server locale in esecuzione."
  exit 0
fi

# --- apertura diretta del file -------------------------------------------

if [ "${1:-}" = "--file" ] || ! command -v python3 >/dev/null 2>&1; then
  echo "Apertura diretta del file."
  apri "file://$DIR/index.html"
  echo "Percorso: $DIR/index.html"
  exit 0
fi

# --- scelta di una porta libera ------------------------------------------

scelta=""
for p in $(seq "$PORT" $((PORT + 40))); do
  if [ "$(porta_libera "$p")" = "ok" ]; then scelta="$p"; break; fi
done

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
  ( cd "$DIR" && nohup python3 "$DIR/server.py" --port "$scelta" --no-browser \
      >"/tmp/forexvision-server-$scelta.log" 2>&1 & echo $! > "$PIDFILE" )
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
fi

apri "http://127.0.0.1:$scelta/index.html"
echo "Percorso: $DIR/index.html"
