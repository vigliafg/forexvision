#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ForexVision - avvio rapido, pensato per essere raggiungibile dalla home
#
#   ~/forex.sh              avvia l'app sulla porta 8199 (raggiungibile anche
#                           dalla rete locale) e apre il browser
#   ~/forex.sh --stop       ferma il server avviato da qui
#   ~/forex.sh --host 127.0.0.1   avvia solo su questa macchina
#   ~/forex.sh -h           mostra le opzioni
#
# La porta si puo' cambiare con la variabile PORTA:
#   PORTA=9000 ~/forex.sh
#
# Tutta la logica di avvio (attesa che il ponte risponda, pidfile, log,
# apertura del browser) sta in avvia.sh dentro il progetto: qui c'e' solo la
# scorciatoia con la porta fissa. Il file e' un collegamento a
# ~/Documenti/forex/forex.sh, che e' la copia versionata.
# ---------------------------------------------------------------------------
set -u

APP_DIR="$HOME/Documenti/forex"
AVVIATORE="$APP_DIR/avvia.sh"
PORTA="${PORTA:-8199}"

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  cat <<FINE
Uso: ~/forex.sh [opzioni]

  (nessuna)        avvia l'app sulla porta $PORTA e apre il browser
  --lan            mette l'app a disposizione della rete locale (predefinito)
  --host INDIRIZZO ascolta solo su un indirizzo (per esempio 127.0.0.1)
  --port NUMERO    usa un'altra porta
  --file           apre index.html da file:// (solo dati simulati)
  --stop           ferma il server avviato da questo script
  -h, --help       questo aiuto

Variabili: PORTA (porta predefinita, ora $PORTA), FOREXVISION_PORT, FOREXVISION_HOST.
Il progetto sta in $APP_DIR.
FINE
  exit 0
fi

if [ ! -x "$AVVIATORE" ]; then
  echo "Non trovo l'avviatore del progetto: $AVVIATORE" >&2
  echo "Controlla che la cartella $APP_DIR contenga avvia.sh." >&2
  exit 1
fi

exec "$AVVIATORE" --port "$PORTA" --lan "$@"
