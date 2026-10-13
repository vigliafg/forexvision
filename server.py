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
    python3 server.py --port 8199
    python3 server.py --no-browser
    python3 server.py --test-sink FILE # riceve i report dei test su POST /report
"""

import argparse
import email.utils
import ipaddress
import itertools
import json
import os
import re
import secrets
import select
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "forexvision")
# La porta dell'app. La usa il server quando non gliene si dice un'altra, e i
# lanciatori (avvia.sh, avvia.bat) la impongono: sempre la stessa, cosi'
# l'indirizzo da aprire e da ricordare e' uno solo.
DEFAULT_PORT = 8199

# Chiusura automatica quando il server e' avviato dal lanciatore (avvia.sh /
# avvia.bat): la pagina manda il segnale quando la finestra si chiude, il ponte
# aspetta CLOSE_GRACE_SECONDS prima di spegnersi (per non confondere un
# ricaricamento con una chiusura) e CLOSE_IDLE_SECONDS senza richieste sono la
# rete di sicurezza se il segnale non arriva proprio (browser chiuso a forza).
CLOSE_GRACE_SECONDS = 8
CLOSE_IDLE_SECONDS = 300

# La finestra dell'app tiene aperta una connessione col ponte (/api/sessione):
# quando la finestra o il browser si chiudono e' il sistema operativo a chiudere
# la connessione, quindi il ponte se ne accorge subito. Il commento periodico
# tiene viva la connessione (event-stream) senza mandare dati.
SESSION_HEARTBEAT_SECONDS = 15
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

# ---------------------------------------------------------------------------
# Sentiment reale: fonti autorevoli.
#
#  - CFTC / Commitments of Traders: API ufficiale Socrata del regolatore USA
#    (publicreporting.cftc.gov, nessuna chiave necessaria). Il report esce una
#    volta a settimana (dati di martedi', rilascio venerdi'). Per ogni divisa
#    si usa il contratto futures "legacy" corrispondente.
#  - VIX (^VIX su Yahoo): l'indice della volatilita' implicita dell'S&P 500,
#    riferimento standard per il regime risk-on / risk-off.
#  - Indice del dollaro (DX-Y.NYB su Yahoo): forza del USD misurata dal
#    mercato reale su un paniere di valute.
# ---------------------------------------------------------------------------
CFTC_DATASET = "6dca-aqww"          # COT "Legacy Futures Only" (Socrata)
COT_CODES = {
    "EUR": "099741",   # Euro FX (CME)
    "JPY": "097741",   # Japanese Yen (CME)
    "GBP": "096742",   # British Pound (CME)
    "CHF": "092741",   # Swiss Franc (CME)
    "CAD": "090741",   # Canadian Dollar (CME)
    "AUD": "232741",   # Australian Dollar (CME)
    "NZD": "112741",   # New Zealand Dollar (CME)
    "XAU": "088691",   # Gold (COMEX)
    "XAG": "084691",   # Silver (COMEX)
}
COT_WEEKS = 262                     # ~5 anni di storia, come le candele D1
COT_TTL = 6 * 3600                  # il report COT e' settimanale: cache lunga
AUX_TTL = TTL_SECONDS               # VIX/DXY: stessa caduta dei candele
SENTIMENT_SYMBOLS = {               # simboli ausiliari Yahoo
    "vix": "^VIX",
    "dxy": "DX-Y.NYB",
}

# ---------------------------------------------------------------------------
# Notizie e calendario: fonti pubblicamente raggiungibili, senza chiavi.
#
#  - RSS di ForexLive e FXStreet: notizie di mercato forex (aggregatori);
#  - RSS ufficiali di Federal Reserve e BCE: comunicati delle banche centrali,
#    fonti primarie (sempre pertinenti per EUR/USD);
#  - calendario economico ForexFactory (mirror JSON di faireconomy.media,
#    dichiaratamente non ufficiale ma di uso comune): eventi con impatto,
#    previsione e dato precedente.
#
# Il browser non puo' contattare queste fonti (CORS): le scarica e ripulisce
# il ponte, che le ripulisce e le consegna in un JSON compatto con cache di
# 5 minuti e copia su disco per i guasti di rete.
# ---------------------------------------------------------------------------
NEWS_FEEDS = (
    ("ForexLive", "https://www.forexlive.com/feed/news", "wire"),
    ("FXStreet", "https://www.fxstreet.com/rss/news", "wire"),
    ("Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml", "bank"),
    ("BCE", "https://www.ecb.europa.eu/rss/press.html", "bank"),
)
NEWS_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
NEWS_TTL = 300                 # cache in memoria: 5 minuti
NEWS_MAX_ITEMS = 70            # notizie complessive consegnate al client
NEWS_MAX_PER_FEED = 25
NEWS_CALENDAR_MAX = 40
# parole chiave per la pertinenza EUR/USD dei notiziari generalisti
EURUSD_KEYWORDS = (
    "eur", "euro", "ecb", "lagarde", "fed", "fomc", "powell", "dollar",
    "dollaro", "usd", "cpi", "inflation", "inflazione", "nfp", "payroll",
    "gdp", "rate", "tassi", "tariff", "yields", "bonds", "parity", "parità",
    "fx", "forex", "currency", "valuta", "eurozone", "germany", "france",
    "euro area", "boe", "ecb", "bundesbank", "boj", "boj", "snb", "boc",
    "rba", "rnz", "draghi", "merz", "government shutdown", "debt",
)


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


# ---------------------------------------------------------------------------
# Sentiment reale: scaricamento e cache
# ---------------------------------------------------------------------------
def _http_json_retry(url, errors):
    """Prova le intestazioni candidate e restituisce il JSON, o raccoglie errori."""
    uas = (_working_ua[0],) + tuple(u for u in UA_CANDIDATES if u != _working_ua[0])
    for ua in uas:
        _pace()
        try:
            return _http_json(url, ua), ua
        except urllib.error.HTTPError as exc:
            errors.append("%s: HTTP %s" % (ua[:24], exc.code))
        except Exception as exc:                       # rete, timeout, DNS...
            errors.append("%s: %s" % (ua[:24], exc))
    raise FeedError("; ".join(errors[:3]) if errors else "fonte non raggiungibile")


def fetch_cot(force=False):
    """Scarica lo storico COT (CFTC) dei contratti valute e metalli.

    Unica richiesta per tutti i contratti: il report esce una volta a
    settimana, quindi la cache dura 6 ore. A fonte irraggiungibile si serve
    l'ultima copia su disco marcandola "stale".
    """
    key = "cot"
    with CACHE_LOCK:
        entry = CACHE.get(key)
        if entry and not force and time.time() - entry["fetched_at"] < COT_TTL:
            payload = dict(entry["payload"])
            payload["fromCache"] = True
            payload["cacheAgeSeconds"] = round(time.time() - entry["fetched_at"], 1)
            return payload

    codes = list(COT_CODES.values())
    query = (
        "select report_date_as_yyyy_mm_dd, cftc_contract_market_code, "
        "noncomm_positions_long_all, noncomm_positions_short_all, "
        "comm_positions_long_all, comm_positions_short_all, open_interest_all "
        "where cftc_contract_market_code in (%s) "
        "order by report_date_as_yyyy_mm_dd desc limit %d"
        % (",".join("'%s'" % c for c in codes), len(codes) * (COT_WEEKS + 12))
    )
    url = ("https://publicreporting.cftc.gov/resource/%s.json?$query=%s"
           % (CFTC_DATASET, urllib.parse.quote(query)))
    try:
        rows, _ua = _http_json_retry(url, [])
        if not isinstance(rows, list):
            raise FeedError("risposta inattesa dalla CFTC")
        by_code = {}
        for row in rows:
            code = row.get("cftc_contract_market_code")
            try:
                rec = {
                    "t": _cot_stamp(row["report_date_as_yyyy_mm_dd"]),
                    "nl": int(row["noncomm_positions_long_all"]),
                    "ns": int(row["noncomm_positions_short_all"]),
                    "cl": int(row["comm_positions_long_all"]),
                    "cs": int(row["comm_positions_short_all"]),
                    "oi": int(row["open_interest_all"]),
                }
            except (KeyError, ValueError, TypeError):
                continue
            by_code.setdefault(code, []).append(rec)

        contracts = {}
        latest = ""
        for cur, code in COT_CODES.items():
            hist = by_code.get(code) or []
            if len(hist) < 52:
                raise FeedError("storico COT insufficiente per %s (%d settimane)"
                                % (cur, len(hist)))
            hist.sort(key=lambda r: r["t"])
            hist = hist[-COT_WEEKS:]
            contracts[cur] = {"code": code, "rows": hist}
            stamp = hist[-1]["t"]
            date_txt = time.strftime("%Y-%m-%d", time.gmtime(stamp / 1000))
            if date_txt > latest:
                latest = date_txt

        payload = {
            "ok": True,
            "source": "cftc-cot",
            "provider": "CFTC - Commitments of Traders",
            "providerUrl": "https://publicreporting.cftc.gov/",
            "asOf": latest,
            "weeks": min(len(c["rows"]) for c in contracts.values()),
            "contracts": contracts,
            "fetchedAt": int(time.time() * 1000),
            "stale": False,
        }
    except Exception as exc:
        stale = load_disk_cache("sent_" + key)
        if stale and stale.get("ok"):
            stale = dict(stale)
            stale.update({"fromCache": True, "stale": True, "error": str(exc)})
            return stale
        raise

    with CACHE_LOCK:
        CACHE[key] = {"fetched_at": time.time(), "payload": payload}
    save_disk_cache("sent_" + key, payload)
    return payload


def _cot_stamp(date_text):
    """'2026-10-06T00:00:00.000' -> millisecondi Unix (UTC)."""
    import calendar
    y = int(date_text[:4]); m = int(date_text[5:7]); d = int(date_text[8:10])
    return calendar.timegm((y, m, d, 0, 0, 0)) * 1000


def fetch_close_series(slot, force=False):
    """Serie giornaliera di chiusura per VIX o indice del dollaro (Yahoo)."""
    key = "sent_" + slot
    sym = SENTIMENT_SYMBOLS[slot]
    with CACHE_LOCK:
        entry = CACHE.get(key)
        if entry and not force:
            age = time.time() - entry["fetched_at"]
            payload0 = entry["payload"]
            market_closed = _market_closed(payload0)
            ttl = 6 * 3600 if market_closed else AUX_TTL
            if age < ttl:
                payload = dict(payload0)
                payload["fromCache"] = True
                payload["cacheAgeSeconds"] = round(age, 1)
                return payload

    try:
        result, _host = yahoo_download(sym, "1d", "1y")
        candles, _skipped = candles_from_yahoo(result, 2)
        if len(candles) < 60:
            raise FeedError("serie insufficiente da Yahoo (%s: %d barre)"
                            % (sym, len(candles)))
        closes = [{"time": c["time"], "close": c["close"]} for c in candles[-400:]]
        payload = {
            "ok": True,
            "symbol": sym,
            "provider": "Yahoo Finance",
            "candles": closes,
            "level": closes[-1]["close"],
            "asOf": time.strftime("%Y-%m-%d", time.gmtime(closes[-1]["time"] / 1000)),
            "lastBarTime": closes[-1]["time"],
            "stale": False,
        }
    except Exception as exc:
        stale = load_disk_cache(key)
        if stale and stale.get("ok"):
            stale = dict(stale)
            stale.update({"fromCache": True, "stale": True, "error": str(exc)})
            return stale
        raise

    with CACHE_LOCK:
        CACHE[key] = {"fetched_at": time.time(), "payload": payload}
    save_disk_cache(key, payload)
    return payload


def _market_closed(payload):
    last_bar = (payload or {}).get("lastBarTime")
    return bool(last_bar and time.time() * 1000 - last_bar > 12 * 3600 * 1000)


def build_sentiment_payload(symbol, force=False):
    """Costruisce la risposta per /api/sentiment (posizionamento COT + VIX + DXY)."""
    yahoo_symbol = REAL_PAIRS.get(symbol)
    if yahoo_symbol is None:
        raise FeedError("strumento non collegato ai dati reali: %s" % symbol)

    # il COT e' indispensabile: senza, il sentiment reale non esiste
    cot = fetch_cot(force)
    if not cot.get("ok"):
        raise FeedError("report CFTC non disponibile")

    # VIX e DXY arricchiscono il quadro: se mancano, il client calcola
    # il punteggio con le sole fonti presenti
    try:
        vix = fetch_close_series("vix", force)
    except Exception as exc:                       # pragma: no cover - rete
        vix = {"ok": False, "error": str(exc)}
    try:
        dxy = fetch_close_series("dxy", force)
    except Exception as exc:                       # pragma: no cover - rete
        dxy = {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "source": "cftc-cot+yahoo",
        "provider": "CFTC (Commitments of Traders) + Yahoo Finance",
        "symbol": symbol,
        "yahooSymbol": yahoo_symbol,
        "cot": cot,
        "vix": vix,
        "dxy": dxy,
        "fetchedAt": int(time.time() * 1000),
        "stale": bool(cot.get("stale") or vix.get("stale") or dxy.get("stale")),
    }


# ---------------------------------------------------------------------------
# Notizie e calendario: scaricamento, ripulitura e cache
# ---------------------------------------------------------------------------
def _rss_time_to_ms(date_text):
    """pubDate RSS (RFC 822 o ISO) -> millisecondi Unix."""
    text = (date_text or "").strip()
    if not text:
        return None
    try:
        dt = email.utils.parsedate_to_datetime(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000
    except (TypeError, ValueError, IndexError):
        pass
    try:                                 # ISO con offset ("-04:00")
        clean = text[:-1] + "+00:00" if text.endswith("Z") else text
        dt = datetime.fromisoformat(clean)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000
    except (ValueError, TypeError):
        return None


def _clean_title(text):
    """Toglie tag HTML residui e spazi di troppo dai titoli dei RSS."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", (text or ""))).strip()


def _fetch_rss_feed(name, url):
    """Scarica e ripulisce un RSS: lista di {time, title, link}."""
    _pace()
    req = urllib.request.Request(url, headers={
        "User-Agent": _working_ua[0],
        "Accept": "application/rss+xml,application/xml,text/xml,*/*",
    })
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        raw = resp.read(800000)
    root = ET.fromstring(raw)
    out = []
    for item in root.iter("item"):
        if len(out) >= NEWS_MAX_PER_FEED:
            break
        title = _clean_title(item.findtext("title"))
        if not title:
            continue
        ts = _rss_time_to_ms(item.findtext("pubDate") or "")
        if ts is None:
            continue
        out.append({
            "time": int(ts),
            "title": title,
            "link": (item.findtext("link") or "").strip(),
        })
    return out


def _fetch_calendar():
    """Calendario economico ForexFactory (mirror JSON) ripulito e filtrato.

    Restano gli eventi pertinenti a EUR/USD: divise EUR/USD/ALL con impatto
    medio o alto, di qualunque divisa con impatto alto.
    """
    _pace()
    req = urllib.request.Request(NEWS_CALENDAR_URL, headers={
        "User-Agent": _working_ua[0],
        "Accept": "application/json,text/plain,*/*",
    })
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        data = json.loads(resp.read(600000).decode("utf-8", "replace"))
    out = []
    for ev in data:
        ts = _rss_time_to_ms(ev.get("date") or "")
        impact = ev.get("impact") or ""
        country = ev.get("country") or ""
        relevant = (
            (country in ("EUR", "USD", "ALL") and impact in ("High", "Medium"))
            or (impact == "High")
        )
        if ts is None or not relevant:
            continue
        out.append({
            "time": int(ts),
            "country": country,
            "impact": impact,
            "title": _clean_title(ev.get("title")),
            "forecast": ev.get("forecast") or "",
            "previous": ev.get("previous") or "",
        })
    out.sort(key=lambda e: e["time"])
    return out[:NEWS_CALENDAR_MAX]


def build_news_payload(force=False):
    """Costruisce la risposta per /api/news (con cache di 5 minuti)."""
    key = "news"
    with CACHE_LOCK:
        entry = CACHE.get(key)
        if entry and not force and time.time() - entry["fetched_at"] < NEWS_TTL:
            payload = dict(entry["payload"])
            payload["fromCache"] = True
            payload["cacheAgeSeconds"] = round(time.time() - entry["fetched_at"], 1)
            return payload

    feeds_status = []
    news = []
    errors = []
    news_lower_seen = set()
    for name, url, kind in NEWS_FEEDS:
        try:
            items = _fetch_rss_feed(name, url)
        except Exception as exc:          # fonte fuori servizio: le altre bastano
            errors.append("%s: %s" % (name, exc))
            feeds_status.append({"name": name, "ok": False, "items": 0})
            continue
        feeds_status.append({"name": name, "ok": True, "items": len(items)})
        for it in items:
            title_l = it["title"].lower()
            dedup = title_l[:70]
            if dedup in news_lower_seen:
                continue
            news_lower_seen.add(dedup)
            # le comunicati di banche centrali sono sempre pertinenti; per i
            # notiziari la pertinenza EUR/USD si marca per parole chiave
            relevant = kind == "bank" or any(k in title_l for k in EURUSD_KEYWORDS)
            news.append({
                "time": it["time"], "source": name, "kind": kind,
                "title": it["title"], "link": it["link"], "eurusd": relevant,
            })

    try:
        calendar = _fetch_calendar()
        feeds_status.append({"name": "Calendario", "ok": True,
                             "items": len(calendar)})
    except Exception as exc:
        errors.append("calendario: %s" % exc)
        feeds_status.append({"name": "Calendario", "ok": False, "items": 0})
        calendar = []

    news.sort(key=lambda n: n["time"], reverse=True)
    news = news[:NEWS_MAX_ITEMS]

    if not news and not calendar:
        # nessuna fonte risponde: si prova a servire l'ultima copia su disco
        stale = load_disk_cache("news")
        if stale and stale.get("ok"):
            stale = dict(stale)
            stale.update({
                "fromCache": True, "stale": True,
                "cacheAgeSeconds": round(time.time() - stale.get("fetchedAt", 0) / 1000, 1),
                "error": "; ".join(errors[:3]),
            })
            return stale
        raise FeedError("; ".join(errors[:3]) if errors else "nessuna fonte notizie raggiungibile")

    ok_feeds = sum(1 for f in feeds_status if f["ok"])
    payload = {
        "ok": True,
        "source": "rss+calendar",
        "provider": "ForexLive - FXStreet - Federal Reserve - BCE - ForexFactory (faireconomy.media)",
        "feeds": feeds_status,
        "sourcesOk": ok_feeds,
        "news": news,
        "calendar": calendar,
        "fetchedAt": int(time.time() * 1000),
        "stale": False,
    }

    with CACHE_LOCK:
        CACHE[key] = {"fetched_at": time.time(), "payload": payload}
    save_disk_cache("news", payload)
    return payload


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


# Le sessioni aperte: una per finestra dell'app collegata al ponte.
_SESSIONI = set()
_SESSIONI_LOCK = threading.Lock()
_SESSIONE_ID = itertools.count(1)


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
        if path == "/api/chiudi":
            # il segnale di chiusura arriva da navigator.sendBeacon, cioe' in POST:
            # una GET sullo stesso indirizzo e' quasi sempre un errore di chi chiama
            return self._send_json({"ok": False, "error": "usa POST: e' il segnale di "
                                    "chiusura della finestra"}, status=405)
        self._touch(path)
        if path == "/api/sessione":
            return self.api_sessione()
        if path == "/api/status":
            return self.api_status()
        if path == "/api/candles":
            return self.api_candles()
        if path == "/api/sentiment":
            return self.api_sentiment()
        if path == "/api/news":
            return self.api_news()
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
        path = self.path.split("?")[0]
        if path == "/api/chiudi":
            return self.api_chiudi()
        self._touch(path)
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
    def _touch(self, path):
        """Segna che qualcuno sta usando l'app.

        Serve alla chiusura automatica. Annulla un'attesa di spegnimento solo
        una pagina che si sta caricando (index.html, o la radice): quella e' una
        finestra viva, ed e' il caso del ricaricamento, dove il segnale di
        chiusura arriva ma la finestra resta. Le richieste di dati non
        annullano niente: la pagina le manda anche mentre si chiude, e se
        l'ultima arriva dopo il segnale l'attesa deve restare in piedi (una
        richiesta in volo al momento della chiusura rimandava lo spegnimento
        fino alla rete di sicurezza dei %d secondi).
        """ % CLOSE_IDLE_SECONDS
        srv = self.server
        srv.last_request = time.time()
        if path.endswith(".html") or path in ("", "/"):
            srv.app_seen = True
            srv.close_deadline = None

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
            "sentiment": {
                "endpoint": "/api/sentiment",
                "sources": ["CFTC Commitments of Traders (COT)", "Yahoo ^VIX", "Yahoo DX-Y.NYB (indice del dollaro)"],
                "cotWeeks": COT_WEEKS,
                "cotContracts": sorted(COT_CODES.keys()),
            },
            "news": {
                "endpoint": "/api/news",
                "rss": [f[0] for f in NEWS_FEEDS],
                "calendar": "ForexFactory (faireconomy.media, mirror non ufficiale)",
                "ttlSeconds": NEWS_TTL,
            },
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

    def api_sentiment(self):
        q = self._query()
        symbol = q.get("symbol") or DEFAULT_SYMBOL
        force = q.get("force") in ("1", "true", "yes")
        try:
            payload = build_sentiment_payload(symbol, force=force)
        except FeedError as exc:
            return self._send_json({
                "ok": False, "error": str(exc), "symbol": symbol,
            }, status=503)
        except Exception as exc:                      # pragma: no cover
            return self._send_json({
                "ok": False, "error": "errore interno: %s" % exc, "symbol": symbol,
            }, status=500)
        self._send_json(payload)

    def api_sessione(self):
        """La finestra dell'app resta collegata al ponte finche' e' aperta.

        E' il segnale piu' affidabile per la chiusura automatica: quando la
        finestra (o il browser) si chiude, la connessione viene chiusa dal
        sistema operativo e qui ci se ne accorge subito, senza dipendere da
        quello che la pagina fa in tempo a mandare. Attiva solo su un ponte
        avviato dal lanciatore (token).
        """
        token = getattr(self.server, "close_token", None)
        if not token:
            return self._send_json({"ok": False, "error": "ponte non avviato dal "
                                    "lanciatore: nessuna sessione da seguire"}, status=409)
        if self._query().get("token") != token:
            return self._send_json({"ok": False, "error": "token non valido"}, status=403)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.server.app_seen = True
        self.server.close_deadline = None            # la finestra c'e': nessuna chiusura in corso
        sid = next(_SESSIONE_ID)
        with _SESSIONI_LOCK:
            _SESSIONI.add(sid)
        sys.stderr.write("finestra dell'app collegata\n")
        try:
            while not getattr(self.server, "stopping", False):
                pronti, _, _ = select.select([self.connection], [], [], SESSION_HEARTBEAT_SECONDS)
                if pronti:
                    # EventSource non manda nulla: qualunque cosa arrivi (dati o
                    # fine della connessione) significa che la finestra non c'e'
                    # piu'.
                    self.connection.recv(1024)
                    break
                self.wfile.write(b": attivo\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        except Exception:                             # pragma: no cover
            pass
        finally:
            with _SESSIONI_LOCK:
                _SESSIONI.discard(sid)
                aperte = len(_SESSIONI)
            if not aperte and not getattr(self.server, "stopping", False):
                sys.stderr.write("finestra dell'app chiusa: fermo il ponte fra %d secondi\n"
                                 % getattr(self.server, "close_grace", CLOSE_GRACE_SECONDS))
                self.server.close_deadline = time.time() + getattr(self.server, "close_grace",
                                                                  CLOSE_GRACE_SECONDS)

    def api_chiudi(self):
        """La finestra dell'app si e' chiusa: prepara lo spegnimento del ponte.

        Attivo solo quando il server e' stato avviato dal lanciatore (che passa
        un token): cosi' un ponte avviato a mano non si spegne mai da solo e una
        pagina qualsiasi non puo' fermarlo senza conoscere il token.
        """
        token = getattr(self.server, "close_token", None)
        if not token:
            return self._send_json({"ok": False, "error": "ponte non avviato dal "
                                    "lanciatore: nessuna chiusura automatica"}, status=409)
        if self._query().get("token") != token:
            return self._send_json({"ok": False, "error": "token non valido"}, status=403)
        grace = getattr(self.server, "close_grace", CLOSE_GRACE_SECONDS)
        self.server.close_deadline = time.time() + grace
        sys.stderr.write("finestra dell'app chiusa: fermo il ponte fra %d secondi\n" % grace)
        self._send_json({"ok": True, "chiusuraFraSecondi": grace})

    def api_news(self):
        force = self._query().get("force") in ("1", "true", "yes")
        try:
            payload = build_news_payload(force=force)
        except FeedError as exc:
            return self._send_json({"ok": False, "error": str(exc)}, status=503)
        except Exception as exc:                      # pragma: no cover
            return self._send_json({"ok": False, "error": "errore interno: %s" % exc}, status=500)
        self._send_json(payload)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("feed  %s\n" % (args[0] if args else fmt))


# ---------------------------------------------------------------------------
# Avvio
# ---------------------------------------------------------------------------
def free_port(preferred, host="127.0.0.1", strict=False):
    """La porta su cui ascoltare.

    Con `strict` la porta richiesta e' obbligatoria: se e' occupata il server si
    ferma invece di spostarsi in silenzio su un'altra. Lo usa il lanciatore, che
    promette all'utente sempre lo stesso indirizzo.
    """
    if strict:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, preferred))
                return preferred
            except OSError:
                raise SystemExit("la porta %d su %s e' gia' occupata: ferma quello che "
                                 "la usa, oppure avvia con --port N" % (preferred, host))
    for port in [preferred] + list(range(preferred + 1, preferred + 20)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise SystemExit("nessuna porta libera disponibile")


def watch_app_window(httpd):
    """Ferma il ponte quando la finestra dell'app non c'e' piu'.

    Due strade. La prima e' il segnale esplicito della pagina (`/api/chiudi`, su
    `pagehide`): si aspetta qualche secondo, cosi' un ricaricamento - che manda lo
    stesso segnale - non spegne niente, perche' la pagina ricaricata annulla
    l'attesa con le sue prime richieste. La seconda e' una rete di sicurezza per
    quando il segnale non arriva (browser chiuso a forza): nessuna richiesta
    dall'app per CLOSE_IDLE_SECONDS significa che la finestra non c'e' piu'.
    """
    while True:
        time.sleep(1.0)
        deadline = getattr(httpd, "close_deadline", None)
        if deadline is not None and time.time() >= deadline:
            sys.stderr.write("\nchiusura: fermo il ponte\n")
            httpd.stopping = True
            httpd.shutdown()
            return
        idle = time.time() - getattr(httpd, "last_request", time.time())
        if getattr(httpd, "app_seen", False) and idle > CLOSE_IDLE_SECONDS:
            sys.stderr.write("\nnessuna richiesta dall'app per %d secondi: fermo il ponte\n"
                             % CLOSE_IDLE_SECONDS)
            httpd.stopping = True
            httpd.shutdown()
            return


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
    parser.add_argument("--strict-port", action="store_true",
                        help="la porta richiesta e' obbligatoria: se e' occupata il server "
                             "si ferma invece di spostarsi su un'altra (lo usa il lanciatore, "
                             "che promette sempre lo stesso indirizzo)")
    parser.add_argument("--close-token", nargs="?", const="",
                        default=os.environ.get("FOREXVISION_CLOSE_TOKEN"),
                        help="il server si ferma quando la finestra dell'app si chiude. Con un "
                             "valore usa quel token (lo fa avvia.sh, che apre la pagina da solo); "
                             "senza valore ne genera uno e apre l'app con ?chiudi=... "
                             "(e' quello che fa avvia.bat su Windows)")
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

    port = free_port(args.port, args.host, strict=args.strict_port)
    FeedHandler.test_sink = args.test_sink
    if args.test_sink:
        try:
            open(args.test_sink, "w").close()
        except Exception:
            pass

    # Il token protegge la chiusura automatica: senza, una pagina qualsiasi
    # potrebbe fermare il ponte. Generato qui quando il lanciatore non lo passa
    # (avvia.bat): cosi' il server sa gia' con quale indirizzo aprire l'app.
    close_token = args.close_token
    if close_token == "":
        close_token = secrets.token_urlsafe(12)

    server = ThreadingHTTPServer((args.host, port), partial(FeedHandler, directory=ROOT))
    server.delay_ms = max(0, args.delay_ms)
    server.close_token = close_token or None
    server.close_grace = CLOSE_GRACE_SECONDS
    server.close_deadline = None
    server.last_request = time.time()
    server.app_seen = False
    server.stopping = False
    url = "http://127.0.0.1:%d/index.html" % port
    app_url = url + ("?chiudi=%s" % close_token if close_token else "")
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
    if close_token:
        print("  app        : %s" % app_url)
        print("  chiusura   : il ponte si ferma quando chiudi la finestra dell'app")
    else:
        print("  (Ctrl+C per chiudere)")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(app_url)).start()
    if close_token:
        threading.Thread(target=watch_app_window, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nchiuso")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
