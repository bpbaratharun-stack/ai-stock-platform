#!/usr/bin/env python3
"""
nse_results_dates.py — fetch historical quarterly-RESULTS board-meeting dates
per NSE symbol, so the breakout scanners can flag whether a breakout coincided
with an earnings announcement.

The question this answers: is whatever edge a breakout screen shows just
earnings drift wearing a technical costume? Every hand-checked chart this week
had a results marker next to the move. A "breakout week within +/-1 week of a
results date" flag lets the backtests split signals and find out.

Source: NSE's public corporate-board-meetings API (no login; needs a cookie
primed from the homepage first). Stdlib only. Results are cached to
data/nse_results_dates.json so this is a one-time cost per symbol.

    ./venv/Scripts/python.exe nse_results_dates.py            # fetch for all breakout symbols
    ./venv/Scripts/python.exe nse_results_dates.py --symbols RELIANCE TCS
    ./venv/Scripts/python.exe nse_results_dates.py --refresh  # re-fetch even if cached

BE POLITE: sequential, delay between calls, cookie re-prime + backoff on error.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).parent
DATA = HERE / "data"
CACHE = DATA / "nse_results_dates.json"

BASE = "https://www.nseindia.com"
API = BASE + "/api/corporate-board-meetings"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
FROM_DATE = "01-01-2022"                     # panel starts 2022-01

_MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def _opener():
    """A urllib opener with a cookie jar, primed by hitting the NSE homepage —
    NSE's API 403s without the cookies the homepage sets."""
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    op.addheaders = [
        ("User-Agent", UA),
        ("Accept", "application/json, text/plain, */*"),
        ("Accept-Language", "en-US,en;q=0.9"),
        ("Referer", BASE + "/companies-listing/corporate-filings-board-meetings"),
    ]
    try:
        op.open(BASE + "/", timeout=20).read(2048)   # prime cookies
    except Exception:
        pass
    return op


def _parse_date(s):
    """'27-Oct-2023' -> '2023-10-27' (ISO), or None."""
    try:
        d, mon, y = s.strip().split("-")
        return date(int(y), _MONTHS[mon[:3].title()], int(d)).isoformat()
    except Exception:
        return None


def fetch_symbol(op, symbol, delay):
    """Return sorted ISO dates of 'Financial Results' board meetings since 2022."""
    to_date = date.today().strftime("%d-%m-%Y")
    qs = urllib.parse.urlencode({
        "index": "equities", "symbol": symbol, "issuer": "",
        "from_date": FROM_DATE, "to_date": to_date,
    })
    url = f"{API}?{qs}"
    for attempt in range(4):
        try:
            req = urllib.request.Request(url)
            raw = op.open(req, timeout=25).read().decode("utf-8", "replace")
            rows = json.loads(raw)
            dates = set()
            for r in rows:
                blob = f"{r.get('bm_purpose','')} {r.get('bm_desc','')}".lower()
                if "financial result" in blob or "financial results" in blob:
                    iso = _parse_date(r.get("bm_date", ""))
                    if iso:
                        dates.add(iso)
            time.sleep(delay)
            return sorted(dates)
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError,
                TimeoutError) as e:
            if attempt == 0:
                op = _opener()                      # re-prime cookies once
            time.sleep(3 * (attempt + 1))
    return None                                     # failed


def load_cache():
    if CACHE.exists():
        return json.loads(CACHE.read_text(encoding="utf-8"))
    return {}


def save_cache(c):
    CACHE.write_text(json.dumps(c, indent=0), encoding="utf-8")


def breakout_symbols():
    """Union of symbols across the breakout / momentum output CSVs."""
    import csv
    syms = set()
    for f in DATA.glob("breakout_vcp_*_full.csv"):
        syms |= _col(f, "symbol")
    if (DATA / "breakout_vcp_trades.csv").exists():
        syms |= _col(DATA / "breakout_vcp_trades.csv", "symbol")
    for f in DATA.glob("weekly_momentum_*_full.csv"):
        syms |= _col(f, "Symbol")
    return sorted(s for s in syms if s and s.upper() != "NAN")


def _col(path, name):
    import csv
    out = set()
    with open(path, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            v = (row.get(name) or "").strip()
            if v:
                out.add(v)
    return out


def main():
    ap = argparse.ArgumentParser(description="Fetch NSE quarterly-results board-meeting dates.")
    ap.add_argument("--symbols", nargs="+", help="Specific symbols (default: all breakout-output symbols).")
    ap.add_argument("--refresh", action="store_true", help="Re-fetch even if already cached.")
    ap.add_argument("--delay", type=float, default=0.6, help="Seconds between NSE calls (default 0.6).")
    cfg = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)
    cache = load_cache()
    symbols = cfg.symbols or breakout_symbols()
    todo = [s for s in symbols if cfg.refresh or s not in cache]
    print(f"{len(symbols)} symbols; {len(todo)} to fetch "
          f"(~{len(todo) * cfg.delay / 60:.1f} min), {len(symbols) - len(todo)} cached.")

    op = _opener()
    ok = fail = 0
    for i, sym in enumerate(todo, 1):
        dates = fetch_symbol(op, sym, cfg.delay)
        if dates is None:
            cache[sym] = cache.get(sym, {"results_dates": [], "error": True})
            fail += 1
        else:
            cache[sym] = {"results_dates": dates}
            ok += 1
        if i % 25 == 0:
            save_cache(cache)
            print(f"  [{i}/{len(todo)}] ok={ok} fail={fail}")
    save_cache(cache)
    print(f"Done. fetched ok={ok} fail={fail}. cache -> {CACHE}")
    # quick sanity
    sample = next((s for s in symbols if cache.get(s, {}).get("results_dates")), None)
    if sample:
        print(f"  e.g. {sample}: {cache[sample]['results_dates'][-4:]}")


if __name__ == "__main__":
    main()
