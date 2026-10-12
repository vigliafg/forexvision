#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ForexVision - server locale con dati di mercato reali.

Il server fa tre cose:

  1. serve i file dell'applicazione (cosi' la pagina viene aperta in http://
     invece che da file://, senza problemi di sicurezza del browser);
  2. espone /api/candles, che scarica le candele reali da Yahoo Finance e le
     converte nel formato usato dal motore di analisi dell'app;
  3. tiene una cache di breve durata per non tempestare il fornitore e per
     continuare a funzionare se la rete cade (in quel caso serve l'ultima
     copia disponibile, dichiarandola "non aggiornata").

Perche' serve un server: il browser non puo' chiedere i dati direttamente a
Yahoo (il fornitore non autorizza le richieste provenienti da altre pagine) e
comunque i dati vanno normalizzati e, per alcuni timeframe, ricostruiti.

Uso:
    python3 server.py                  # porta automatica, apre il browser
    python3 server.py --port 8901
    python3 server.py --no-browser
    python3 server.py --test-sink FILE # riceve i report dei test su POST /report
"""

import argparse
import ipaddress
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "forexvision")
DEFAULT_PORT = 8901
TTL_SECONDS = 60          # durata della cache: il polling dell'app e' a 60 s
MAX_BARS = 1500           # candele massime passate al motore di analisi
HTTP_TIMEOUT = 20

# Il fornitore accetta solo intestazioni che iniziano con "Mozilla/5.0" e
# risponde 429 (troppe richieste) a quelle che si dichiarano browser completi o
# strumenti da riga di comando. Si provano in ordine e si ricorda quale
# funziona, cosi' il ponte resiste anche se la regola cambia.
UA_CANDIDATES = (
    "Mozilla/5.0 (X11; Linux x86_64)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Mozilla/5.0",
)
MIN_REQUEST_INTERVAL = 0.7     # secondi fra due richieste al fornitore

# ---------------------------------------------------------------------------
# Strumenti disponibili sul fornitore.
# L'applicazione usa di default solo EUR/USD: gli altri restano mappati perche'
# il ponte e' generico, ma nessuno viene scaricato se non richiesto.
# ---------------------------------------------------------------------------
REAL_PAIRS = {
    "EUR/USD": "EURUSD=X",
    "GBP/USD": "GBPUSD=X",
    "USD/JPY": "USDJPY=X",
    "USD/CHF": "USDCHF=X",
    "AUD/USD": "AUDUSD=X",
    "USD/CAD": "USDCAD=X",
    "NZD/USD": "NZDUSD=X",
    "EUR/GBP": "EURGBP=X",
    "EUR/JPY": "EURJPY=X",
    "GBP/JPY": "GBPJPY=X",
    "AUD/JPY": "AUDJPY=X",
    "EUR/AUD": "EURAUD=X",
    "XAU/USD": "GC=F",
    "XAG/USD": "SI=F",
}
DEFAULT_SYMBOL = "EUR/USD"

# ---------------------------------------------------------------------------
# Timeframe dell'applicazione -> intervallo del fornitore.
#
# Yahoo Finance non offre la candela a 10 minuti: quella dell'app viene
# ricostruita raggruppando due candele a 5 minuti. Lo stesso vale per le 4 ore,
# ricostruite da quelle orarie.
#
# La profondita' storica dipende dal fornitore e non e' uniforme:
#   5 / 10 / 15 minuti -> 60 giorni
#   1 ora / 4 ore      -> circa 2 anni
#   giornaliero        -> 5 anni (la profondita' richiesta dall'utente)
# ---------------------------------------------------------------------------
TF_MAP = {
    "M5": {
        "interval": "5m", "range": "60d", "group": 1, "minutes": 5,
        "history": "60 giorni (limite del fornitore per i 5 minuti)",
    },
    "M10": {
        "interval": "5m", "range": "60d", "group": 2, "minutes": 10,
        "history": "60 giorni; Yahoo non fornisce i 10 minuti, "
                   "le candele sono ricostruite da quelle a 5 minuti",
    },
    "M15": {
        "interval": "15m", "range": "60d", "group": 1, "minutes": 15,
        "history": "60 giorni (limite del fornitore per i 15 minuti)",
    },
    "H1": {
        "interval": "60m", "range": "730d", "group": 1, "minutes": 60,
        "history": "circa 2 anni (limite del fornitore per le candele orarie)",
    },
    "H4": {
        "interval": "60m", "range": "730d", "group": 4, "minutes": 240,
        "history": "circa 2 anni; le candele sono ricostruite da quelle orarie",
    },
    "D1": {
        "interval": "1d", "range": "5y", "group": 1, "minutes": 1440,
        "history": "5 anni",
    },
}

HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")


class FeedError(Exception):
    """Errore nel recupero o nella conversione dei dati."""


# ---------------------------------------------------------------------------
# Scaricamento da Yahoo Finance
# ---------------------------------------------------------------------------
def _http_json(url, user_agent):
    req = urllib.request.Request(url, headers={
        "User-Agent": user_agent,
        "Accept": "application/json,text/plain,*/*",
    })
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        raw = resp.read()
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise FeedError("risposta non leggibile dal fornitore")


_pace_lock = threading.Lock()
_last_request = [0.0]


def _pace():
    """Distanzia le richieste al fornitore per non farsi bloccare."""
    with _pace_lock:
        wait = MIN_REQUEST_INTERVAL - (time.time() - _last_request[0])
        if wait > 0:
            time.sleep(wait)
        _last_request[0] = time.time()


def yahoo_download(yahoo_symbol, interval, yrange):
    """Scarica le candele grezze provando intestazioni e host disponibili."""
    errors = []
    uas = (_working_ua[0],) + tuple(u for u in UA_CANDIDATES if u != _working_ua[0])
    for ua in uas:
        for host in HOSTS:
            url = ("https://%s/v8/finance/chart/%s?interval=%s&range=%s"
                   "&includePrePost=false"
                   % (host, urllib.parse.quote(yahoo_symbol), interval, yrange))
            _pace()
            try:
                data = _http_json(url, ua)
            except urllib.error.HTTPError as exc:
                errors.append("%s su %s: HTTP %s" % (ua[:24], host, exc.code))
                continue
            except Exception as exc:                   # rete, timeout, DNS...
                errors.append("%s su %s: %s" % (ua[:24], host, exc))
                continue

            chart = data.get("chart") or {}
            if chart.get("error"):
                descr = (chart["error"] or {}).get("description") or "errore del fornitore"
                errors.append("%s su %s: %s" % (ua[:24], host, descr))
                continue
            results = chart.get("result") or []
            if not results:
                errors.append("%s su %s: nessun dato restituito" % (ua[:24], host))
                continue

            _working_ua[0] = ua
            return results[0], host

    raise FeedError("; ".join(errors[:4]) if errors else "fornitore non raggiungibile")


_working_ua = [UA_CANDIDATES[0]]


def _round(value, digits):
    if value is None:
        return None
    return round(float(value) + 0.0, digits)


def candles_from_yahoo(result, digits):
    """Trasforma la risposta del fornitore in una lista di candele pulite.

    Le candele con prezzi mancanti (le pause di mercato: notti, fine settimana,
    festivita') vengono scartate: il fornitore le restituisce come righe vuote
    con la sola data.
    """
    stamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []

    out = []
    skipped = 0
    for i, stamp in enumerate(stamps):
        o = opens[i] if i < len(opens) else None
        h = highs[i] if i < len(highs) else None
        l = lows[i] if i < len(lows) else None
        c = closes[i] if i < len(closes) else None
        if o is None or h is None or l is None or c is None:
            skipped += 1
            continue
        if not (o > 0 and h > 0 and l > 0 and c > 0):
            skipped += 1
            continue
        v = volumes[i] if i < len(volumes) else None
        # i prezzi arrivano con rumore di virgola mobile: si arrotondano alle
        # cifre della coppia, come fa il resto dell'applicazione
        o, h, l, c = (_round(o, digits), _round(h, digits),
                      _round(l, digits), _round(c, digits))
        h = max(h, o, c, l)
        l = min(l, o, c, h)
        out.append({
            "time": int(stamp) * 1000,
            "open": o, "high": h, "low": l, "close": c,
            "volume": int(v) if v else 0,
        })

    # ordine crescente e nessun duplicato
    out.sort(key=lambda x: x["time"])
    cleaned = []
    for candle in out:
        if cleaned and candle["time"] <= cleaned[-1]["time"]:
            continue
        cleaned.append(candle)
    return cleaned, skipped


def group_candles(candles, group, minutes):
    """Raggruppa n candele in una sola (usato per i 10 minuti e le 4 ore).

    Apertura = prima apertura, chiusura = ultima chiusura, massimo e minimo
    dell'intervallo, volume sommato. L'ultimo gruppo puo' essere incompleto:
    viene segnalato come "in formazione".
    """
    if group <= 1:
        return candles
    bucket_ms = minutes * 60000
    buckets = []
    current = None
    for candle in candles:
        key = candle["time"] // bucket_ms
        if current is None or key != current["key"]:
            current = {
                "key": key, "time": key * bucket_ms,
                "open": candle["open"], "high": candle["high"],
                "low": candle["low"], "close": candle["close"],
                "volume": candle["volume"], "count": 1,
            }
            buckets.append(current)
        else:
            current["high"] = max(current["high"], candle["high"])
            current["low"] = min(current["low"], candle["low"])
            current["close"] = candle["close"]
            current["volume"] += candle["volume"]
            current["count"] += 1

    merged = []
    for b in buckets:
        merged.append({
            "time": b["time"], "open": b["open"], "high": b["high"],
            "low": b["low"], "close": b["close"], "volume": b["volume"],
            "partial": b["count"] < group,
        })
    return merged


def build_payload(symbol, tf, force=False):
    """Costruisce la risposta per /api/candles (con cache)."""
    spec = TF_MAP.get(tf)
    if spec is None:
        raise FeedError("timeframe non supportato: %s" % tf)
    yahoo_symbol = REAL_PAIRS.get(symbol)
    if yahoo_symbol is None:
        raise FeedError("strumento non collegato ai dati reali: %s" % symbol)

    key = "%s|%s" % (symbol, tf)
    now = time.time()
    with CACHE_LOCK:
        entry = CACHE.get(key)
        if entry and not force:
            age = now - entry["fetched_at"]
            last_bar = (entry["payload"] or {}).get("lastBarTime")
            # A mercato chiuso (fine settimana, ferie) i dati non cambiano:
            # basta ricontrollare ogni poche ore invece che ogni minuto.
            market_closed = bool(last_bar and now * 1000 - last_bar > 12 * 3600 * 1000)
            ttl = 6 * 3600 if market_closed else TTL_SECONDS
            if age < ttl:
                payload = dict(entry["payload"])
                payload["fromCache"] = True
                payload["cacheAgeSeconds"] = round(age, 1)
                return payload

    digits = 3 if symbol.endswith("JPY") else 2 if symbol.startswith("X") else 5

    try:
        result, host = yahoo_download(yahoo_symbol, spec["interval"], spec["range"])
        rows, skipped = candles_from_yahoo(result, digits)
        if len(rows) < 30:
            raise FeedError("dati insufficienti dal fornitore (%d candele)" % len(rows))
        rows = group_candles(rows, spec["group"], spec["minutes"])
        rows = rows[-MAX_BARS:]
        meta = result.get("meta") or {}
        has_volume = any(c["volume"] > 0 for c in rows)
        tf_ms = spec["minutes"] * 60000
        last = rows[-1]
        # L'ultima candela e' "in formazione" se il suo intervallo non e' ancora
        # finito oppure se il fornitore l'ha consegnata incompleta da poco (i
        # dati arrivano con qualche minuto di ritardo). Se invece e' incompleta
        # perche' il mercato ha chiuso, non lo e': e' semplicemente l'ultima.
        end_ms = last["time"] + tf_ms
        now_ms = now * 1000
        last["forming"] = bool(
            end_ms > now_ms or (last.get("partial") and now_ms - end_ms < tf_ms)
        )
        for c in rows[:-1]:
            c.pop("partial", None)
    except Exception as exc:
        # il fornitore non risponde: si prova a servire l'ultima copia salvata
        stale = load_disk_cache(key)
        if stale:
            payload = dict(stale)
            payload.update({
                "ok": True, "stale": True, "fromCache": True,
                "cacheAgeSeconds": round(now - payload.get("fetchedAt", now), 1),
                "error": str(exc),
            })
            return payload
        raise

    payload = {
        "ok": True,
        "source": "yahoo-finance",
        "provider": "Yahoo Finance",
        "providerUrl": "https://finance.yahoo.com/quote/%s" % yahoo_symbol,
        "symbol": symbol,
        "yahooSymbol": yahoo_symbol,
        "timeframe": tf,
        "interval": spec["interval"],
        "requestedRange": spec["range"],
        "history": spec["history"],
        "aggregated": spec["group"] > 1,
        "bars": len(rows),
        "skippedEmpty": skipped,
        "hasVolume": has_volume,
        "fetchedAt": int(now * 1000),
        "stale": False,
        "fromCache": False,
        "cacheAgeSeconds": 0.0,
        "lastBarTime": rows[-1]["time"],
        "firstBarTime": rows[0]["time"],
        "marketState": meta.get("marketState") or "",
        "exchangeTimezone": meta.get("exchangeTimezoneName") or "",
        "providerPrice": meta.get("regularMarketPrice"),
        "candles": rows,
    }

    with CACHE_LOCK:
        CACHE[key] = {"fetched_at": now, "payload": payload}
    save_disk_cache(key, payload)
    return payload


# ---------------------------------------------------------------------------
# Cache su disco (per continuare a funzionare se la rete cade)
# ---------------------------------------------------------------------------
CACHE = {}
CACHE_LOCK = threading.Lock()


def _cache_path(key):
    safe = re.sub(r"[^A-Za-z0-9]+", "_", key)
    return os.path.join(CACHE_DIR, "candles_%s.json" % safe)


def save_disk_cache(key, payload):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(_cache_path(key), "w") as fh:
            json.dump(payload, fh)
    except Exception:
        pass  # la cache su disco e' un di piu', non un requisito


def load_disk_cache(key):
    try:
        with open(_cache_path(key)) as fh:
            return json.load(fh)
    except Exception:
        return None


def _json_safe(obj):
    """Rende un oggetto serializzabile: i valori non numerici diventano null.

    Serve a non spedire mai al browser un JSON non valido (NaN e infiniti non
    esistono in JSON e farebbero fallire la lettura nella pagina).
    """
    if isinstance(obj, float):
        return obj if obj == obj and obj not in (float("inf"), float("-inf")) else None
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


class FeedHandler(SimpleHTTPRequestHandler):
    test_sink = None

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        path = self.path.split("?")[0]
        # Ritardo artificiale per i test: serve a riprodurre un ponte lento,
        # cioe' la finestra in cui l'app ha gia' i timer attivi ma non ha
        # ancora ricevuto la prima serie di prezzi.
        delay = getattr(self.server, "delay_ms", 0)
        if delay and path.startswith("/api/"):
            time.sleep(delay / 1000.0)
        if path == "/api/status":
            return self.api_status()
        if path == "/api/candles":
            return self.api_candles()
        return SimpleHTTPRequestHandler.do_GET(self)

    def send_header(self, keyword, value):
        if keyword.lower() == "cache-control":
            self.cache_header_sent = True
        return SimpleHTTPRequestHandler.send_header(self, keyword, value)

    def end_headers(self):
        # I file dell'app sono in continuo sviluppo: senza questo header il browser
        # puo' riusare una copia vecchia basandosi sulla sola Last-Modified (la
        # regola del 10% usata da Firefox), e una suite verde puo' essere stata
        # eseguita su codice ormai superato. "no-cache" obbliga a rivalidare
        # (304 se il file non e' cambiato): sempre aggiornati, comunque veloce.
        if not getattr(self, "cache_header_sent", False):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.cache_header_sent = False
        return SimpleHTTPRequestHandler.end_headers(self)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if self.path.startswith("/report") and self.test_sink:
            try:
                with open(self.test_sink, "wb") as fh:
                    fh.write(body)
            except Exception:
                pass
        self._send_bytes(b"ok", "text/plain")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    # -------------------------------------------------------------- helpers
    def _send_bytes(self, data, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(self, obj, status=200):
        data = json.dumps(_json_safe(obj), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _query(self):
        parsed = urllib.parse.urlparse(self.path)
        return {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}

    # ------------------------------------------------------------ endpoints
    def api_status(self):
        with CACHE_LOCK:
            cache_state = {
                key: {"ageSeconds": round(time.time() - val["fetched_at"], 1),
                      "bars": val["payload"].get("bars")}
                for key, val in CACHE.items()
            }
        self._send_json({
            "ok": True,
            "service": "forexvision-feed",
            "provider": "Yahoo Finance",
            "note": "ponte locale: l'applicazione non contatta mai il fornitore direttamente",
            "defaultSymbol": DEFAULT_SYMBOL,
            "symbols": sorted(REAL_PAIRS.keys()),
            "enabledSymbols": [DEFAULT_SYMBOL],
            "timeframes": {tf: {"history": s["history"],
                                "interval": s["interval"],
                                "range": s["range"],
                                "groupedFrom": ("%s min" % (s["minutes"] // s["group"]))
                                               if s["group"] > 1 else None}
                           for tf, s in TF_MAP.items()},
            "ttlSeconds": TTL_SECONDS,
            "maxBars": MAX_BARS,
            "cache": cache_state,
            "serverTime": int(time.time() * 1000),
        })

    def api_candles(self):
        q = self._query()
        symbol = q.get("symbol") or DEFAULT_SYMBOL
        tf = q.get("tf") or "H1"
        force = q.get("force") in ("1", "true", "yes")
        try:
            payload = build_payload(symbol, tf, force=force)
        except FeedError as exc:
            return self._send_json({
                "ok": False, "error": str(exc), "symbol": symbol, "timeframe": tf,
            }, status=503)
        except Exception as exc:                      # pragma: no cover
            return self._send_json({
                "ok": False, "error": "errore interno: %s" % exc,
                "symbol": symbol, "timeframe": tf,
            }, status=500)
        self._send_json(payload)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("feed  %s\n" % (args[0] if args else fmt))


# ---------------------------------------------------------------------------
# Avvio
# ---------------------------------------------------------------------------
def free_port(preferred, host="127.0.0.1"):
    for port in [preferred] + list(range(preferred + 1, preferred + 20)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit("nessuna porta libera disponibile")


def local_addresses():
    """Indirizzi IPv4 con cui questa macchina e' raggiungibile dall'esterno.

    Elenca tutte le interfacce configurate (rete locale, Tailscale, ...) tenendo
    fuori loopback, indirizzi di link-local e reti interne di Docker, che non
    servono a nessuno per aprire l'app.
    """
    found = []

    def useful(ip):
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        if addr.is_loopback or addr.is_link_local:
            return False
        return addr not in ipaddress.ip_network("172.16.0.0/12")  # reti Docker

    def add(ip):
        if ip and ip not in found and useful(ip):
            found.append(ip)

    try:
        # connessione UDP verso un indirizzo di test: non parte nessun pacchetto,
        # serve solo a far scegliere al sistema l'indirizzo di uscita principale
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("192.0.2.1", 9))
            add(sock.getsockname()[0])
    except OSError:
        pass

    try:
        import fcntl
        import struct
        for _, name in socket.if_nameindex():
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    request = struct.pack("256s", name.encode()[:15])
                    # SIOCGIFADDR: indirizzo IPv4 assegnato all'interfaccia
                    add(socket.inet_ntoa(fcntl.ioctl(sock.fileno(), 0x8915, request)[20:24]))
            except OSError:
                continue
    except (ImportError, OSError, AttributeError):
        pass

    return found


def main():
    parser = argparse.ArgumentParser(description="ForexVision - server dati reali")
    parser.add_argument("--port", type=int, default=int(os.environ.get("FOREXVISION_PORT", DEFAULT_PORT)))
    parser.add_argument("--host", default=os.environ.get("FOREXVISION_HOST", "127.0.0.1"),
                        help="indirizzo di ascolto: 127.0.0.1 (solo questa macchina, "
                             "predefinito) oppure 0.0.0.0 (tutta la rete locale e Tailscale)")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--test-sink", default=None,
                        help="file dove salvare i report inviati dai test (POST /report)")
    parser.add_argument("--delay-ms", type=int, default=0,
                        help="ritarda di N millisecondi le risposte /api/ (serve ai test "
                             "per riprodurre un ponte lento)")
    args = parser.parse_args()

    # Le stampe di avvio finiscono in un file di log quando il server gira in
    # background: senza riga per riga resterebbero nel buffer e lo script di
    # avvio non potrebbe mostrare gli indirizzi di rete.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    port = free_port(args.port, args.host)
    FeedHandler.test_sink = args.test_sink
    if args.test_sink:
        try:
            open(args.test_sink, "w").close()
        except Exception:
            pass

    server = ThreadingHTTPServer((args.host, port), partial(FeedHandler, directory=ROOT))
    server.delay_ms = max(0, args.delay_ms)
    url = "http://127.0.0.1:%d/index.html" % port
    print("ForexVision in ascolto su http://%s:%d" % (args.host, port))
    if args.host not in ("127.0.0.1", "localhost"):
        addresses = local_addresses()
        if addresses:
            print("  da questo computer : http://127.0.0.1:%d/index.html" % port)
            for address in addresses:
                print("  dalla rete         : http://%s:%d/index.html" % (address, port))
        print("  attenzione: la porta e' aperta a chi raggiunge questa macchina "
              "(l'app non chiede password)")
    print("  dati reali : http://127.0.0.1:%d/api/candles?tf=M10&symbol=EUR%%2FUSD" % port)
    print("  stato      : http://127.0.0.1:%d/api/status" % port)
    if server.delay_ms:
        print("  test       : risposte /api/ rallentate di %d ms" % server.delay_ms)
    print("  (Ctrl+C per chiudere)")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nchiuso")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
