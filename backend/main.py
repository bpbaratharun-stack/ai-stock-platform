"""
NSE FACTOR SCREENER & RESEARCH TERMINAL  (backend)
==================================================
Honest factor screener — NOT a signal engine. Serves descriptive momentum/
technical factor rankings (no buy/sell, no confidence, no price targets).
Includes an optional Gemini-powered plain-English explainer with hard-locked
honesty guardrails.

Reads data/scores.parquet (written by score_universe.py).
Set GEMINI_API_KEY in the environment to enable /explain.
"""

import os
import re
import glob
import json
import logging
from contextlib import asynccontextmanager

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Optional Gemini — server still runs if the package/key is absent
try:
    from google import genai
    from google.genai import types
    _GENAI_OK = True
except Exception:
    _GENAI_OK = False

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler()])
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DISCLAIMER = ("Factor rankings are descriptive screening metrics, not buy/sell "
              "advice or return forecasts. Independent backtesting found no "
              "return-predictive edge in these signals. Do your own research.")

# Locate data/scores.parquet whether main.py is in backend/ or backend/api/.
_HERE = os.path.dirname(os.path.abspath(__file__))
SCORES_PATH = os.environ.get("SCORES_PATH") or next(
    (p for p in (os.path.join(_HERE, "data", "scores.parquet"),
                 os.path.join(os.path.dirname(_HERE), "data", "scores.parquet"))
     if os.path.exists(p)),
    os.path.join(_HERE, "data", "scores.parquet"))

# holdings.json lives alongside scores.parquet in data/
HOLDINGS_PATH = os.environ.get("HOLDINGS_PATH") or next(
    (p for p in (os.path.join(_HERE, "data", "holdings.json"),
                 os.path.join(os.path.dirname(_HERE), "data", "holdings.json"))
     if os.path.exists(p)),
    os.path.join(_HERE, "data", "holdings.json"))

TTL_VIX, TTL_NIFTY, TTL_PX = 300, 300, 300
FALLBACK_VIX = 16.0
FALLBACK_USDINR = 86.0
MIN_HISTORY_BARS = 65
_SYMBOL_RE = re.compile(r"^[A-Z0-9]{1,20}(\.(NS|BO))?$")

INDEX_MAPPINGS: dict[str, list[str]] = {
    "NIFTY50": ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS",
                "BHARTIARTL.NS", "SBIN.NS", "LTIM.NS", "ITC.NS", "HINDUNILVR.NS"],
    "BANKNIFTY": ["HDFCBANK.NS", "ICICIBANK.NS", "SBIN.NS", "KOTAKBANK.NS", "AXISBANK.NS",
                  "PNB.NS", "BANKBARODA.NS", "FEDERALBNK.NS", "INDUSINDBK.NS", "IDFCFIRSTB.NS"],
}
UNIVERSE_SCAN_LIMIT = 1500   # return the full ranked universe; the UI filters/sorts client-side

# Gemini explainer
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
_gemini = genai.Client(api_key=GEMINI_API_KEY) if (_GENAI_OK and GEMINI_API_KEY) else None
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
_explain_cache: dict = {}   # (symbol, scored_date) -> text
GEMINI_SYSTEM = (
    "You explain technical/momentum factor data for an NSE stock screener to a "
    "non-expert, in plain English. STRICT RULES: never give buy/sell/hold advice; "
    "never predict price or returns; never call a stock a good or bad investment; "
    "never imply the ranking forecasts performance. These are descriptive screening "
    "metrics with no proven predictive edge. Keep it to 3-4 short, neutral sentences. "
    "End with: 'Descriptive only - not advice.'"
)


# ---------------------------------------------------------------------------
# Tiny cache
# ---------------------------------------------------------------------------
class _SimpleCache:
    def __init__(self): self._s = {}
    def get(self, k, ttl):
        import time
        e = self._s.get(k)
        if e and time.time() - e[0] <= ttl:
            return True, e[1]
        return False, None
    def set(self, k, v):
        import time
        self._s[k] = (time.time(), v)

CACHE = _SimpleCache()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _flatten(df):
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    return df

def safe_scalar(s):
    if isinstance(s, pd.DataFrame): return float(s.iloc[:, 0].dropna().iloc[-1])
    if isinstance(s, pd.Series):    return float(s.dropna().iloc[-1])
    return float(s)

def _validate_symbol(symbol: str) -> str:
    sym = symbol.strip().upper()
    if not _SYMBOL_RE.match(sym):
        raise HTTPException(400, f"Invalid symbol '{symbol}'.")
    return sym


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """Indicators for the chart overlay + display only (model runs offline)."""
    df = df.copy()
    df["Return"] = df["Close"].pct_change().fillna(0)
    delta = df["Close"].diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    df["RSI"] = 100 - (100 / (1 + gain / (loss + 1e-9)))
    df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
    df["EMA50"] = df["Close"].ewm(span=50, adjust=False).mean()
    df.dropna(inplace=True)
    return df


# ---------------------------------------------------------------------------
# Scores store
# ---------------------------------------------------------------------------
class ScoreStore:
    REQUIRED = {"date", "symbol", "name", "sector", "exchange",
                "price", "rsi", "ret_3m", "score", "rank_pct"}

    def __init__(self, path):
        self.path = path
        self.df = None
        self.scored_date = None
        self.reload()

    def reload(self):
        if not os.path.exists(self.path):
            log.warning("Scores file not found at %s — store empty.", self.path)
            self.df, self.scored_date = None, None
            return
        try:
            df = pd.read_parquet(self.path)
            missing = self.REQUIRED - set(df.columns)
            if missing:
                raise ValueError(f"scores.parquet missing: {sorted(missing)}")
            df["date"] = pd.to_datetime(df["date"])
            latest = df["date"].max()
            df = df[df["date"] == latest].copy()
            df["symbol"] = df["symbol"].str.upper()
            self.df = df.reset_index(drop=True)
            self.scored_date = latest.strftime("%Y-%m-%d")
            log.info("Factor data loaded: %d symbols as of %s.", len(self.df), self.scored_date)
        except Exception as exc:
            log.error("Failed to load scores: %s", exc)
            self.df, self.scored_date = None, None

    @property
    def ready(self): return self.df is not None and len(self.df) > 0
    def get(self, sym):
        if not self.ready: return None
        r = self.df[self.df["symbol"] == sym.upper()]
        return None if r.empty else r.iloc[0].to_dict()
    def members(self, syms):
        if not self.ready: return pd.DataFrame()
        return self.df[self.df["symbol"].isin([s.upper() for s in syms])].copy()
    def top(self, limit):
        if not self.ready: return pd.DataFrame()
        return self.df.sort_values("rank_pct", ascending=False).head(limit).copy()
    def search(self, q, k=10):
        if not self.ready: return []
        q = q.upper()
        m = self.df[self.df["symbol"].str.contains(q, na=False)
                    | self.df["name"].str.upper().str.contains(q, na=False)]
        return [{"symbol": r["symbol"], "name": r["name"]} for _, r in m.head(k).iterrows()]

STORE: ScoreStore | None = None


# ---------------------------------------------------------------------------
# VIX / NIFTY (descriptive market context)
# ---------------------------------------------------------------------------
def fetch_vix():
    hit, v = CACHE.get("vix", TTL_VIX)
    if hit: return v
    try:
        raw = _flatten(yf.download("^INDIAVIX", period="5d", progress=False, timeout=5, auto_adjust=False))
        cur, prev = safe_scalar(raw["Close"].iloc[-1:]), safe_scalar(raw["Close"].iloc[-2:-1])
        res = {"current": round(cur, 2), "change_pct": round((cur - prev) / prev * 100, 2),
               "is_fallback": False}
    except Exception as exc:
        log.warning("VIX fetch failed (%s)", exc)
        res = {"current": FALLBACK_VIX, "change_pct": 0.0, "is_fallback": True}
    CACHE.set("vix", res)
    return res

def fetch_nifty_3m():
    hit, v = CACHE.get("nifty3m", TTL_NIFTY)
    if hit: return v
    try:
        raw = _flatten(yf.download("^NSEI", period="3mo", progress=False, timeout=5, auto_adjust=False))
        roi = (safe_scalar(raw["Close"].iloc[-1:]) - safe_scalar(raw["Close"].iloc[:1])) \
              / safe_scalar(raw["Close"].iloc[:1]) * 100
        res = (round(roi, 2), False)
    except Exception as exc:
        log.warning("Nifty 3m fetch failed (%s)", exc)
        res = (5.85, True)
    CACHE.set("nifty3m", res)
    return res


def fetch_usdinr():
    """Live USD→INR rate for converting US holdings into the INR base."""
    hit, v = CACHE.get("usdinr", TTL_PX)
    if hit: return v
    try:
        raw = _flatten(yf.download("USDINR=X", period="5d", progress=False, timeout=5, auto_adjust=False))
        res = {"rate": round(safe_scalar(raw["Close"].iloc[-1:]), 4), "is_fallback": False}
    except Exception as exc:
        log.warning("USDINR fetch failed (%s)", exc)
        res = {"rate": FALLBACK_USDINR, "is_fallback": True}
    CACHE.set("usdinr", res)
    return res


def fetch_last_prices(symbols: list[str]) -> dict:
    """{symbol: {"last", "prev", "spark"}} from one cached batch download.
    'spark' is up to ~22 recent daily closes for a per-holding sparkline."""
    syms = sorted({s.upper() for s in symbols})
    if not syms: return {}
    key = "px:" + ",".join(syms)
    hit, v = CACHE.get(key, TTL_PX)
    if hit: return v

    out: dict = {}
    try:
        multi = len(syms) > 1
        raw = yf.download(syms, period="1mo", progress=False, timeout=15,
                          group_by="ticker" if multi else "column", auto_adjust=False)
        for s in syms:
            try:
                closes = (raw[s]["Close"] if multi else _flatten(raw)["Close"]).dropna()
                last = float(closes.iloc[-1])
                prev = float(closes.iloc[-2]) if len(closes) >= 2 else last
                spark = [round(float(x), 2) for x in closes.iloc[-22:].tolist()]
                out[s] = {"last": last, "prev": prev, "spark": spark}
            except Exception:
                out[s] = None
    except Exception as exc:
        log.warning("Price batch fetch failed: %s", exc)
        out = {s: None for s in syms}
    CACHE.set(key, out)
    return out


# Mechanical post-breakout rule + live-state thresholds (all disclosed in the UI)
BREAKOUT_HORIZON_TD = 20      # fixed-horizon exit: next-day open held ~4 weeks
STATE_FAIL_PCT = -5.0         # NOW this far below the breakout close -> FAILED
STATE_EXT_PCT = 10.0          # NOW this far above the breakout close -> EXTENDED


def fetch_ohlc_since(symbols: list[str], since_date: str) -> dict:
    """Per-symbol post-breakout stats from since_date: the high, the first
    session's open (mechanical next-day entry) and the daily close path
    (for a fixed-horizon exit). One cached batch download."""
    syms = sorted({s.upper() for s in symbols})
    if not syms: return {}
    key = f"ohlc:{since_date}:" + ",".join(syms)
    hit, v = CACHE.get(key, TTL_PX)
    if hit: return v

    out: dict = {}
    try:
        multi = len(syms) > 1
        raw = yf.download(syms, start=since_date, progress=False, timeout=20,
                          group_by="ticker" if multi else "column", auto_adjust=False)
        for s in syms:
            try:
                d = raw[s] if multi else _flatten(raw)
                o, h, c = d["Open"].dropna(), d["High"].dropna(), d["Close"].dropna()
                out[s] = {
                    "high": round(float(h.max()), 2) if len(h) else None,
                    "entry_open": round(float(o.iloc[0]), 2) if len(o) else None,
                    "closes": [round(float(x), 2) for x in c.tolist()],
                }
            except Exception:
                out[s] = None
    except Exception as exc:
        log.warning("OHLC-since fetch failed: %s", exc)
        out = {s: None for s in syms}
    CACHE.set(key, out)
    return out


# ---------------------------------------------------------------------------
# Descriptive band (NO buy/sell, NO confidence)
# ---------------------------------------------------------------------------
def market_regime(vix):
    if vix <= 14.0: return "LOW_VOLATILITY"
    if vix > 17.5:  return "HIGH_VOLATILITY"
    return "NORMAL_VOLATILITY"

def derive_band(rank_pct: float) -> dict:
    pct = round(rank_pct * 100, 1)
    if   rank_pct >= 0.80: band = "TOP QUINTILE"
    elif rank_pct >= 0.60: band = "UPPER"
    elif rank_pct >= 0.40: band = "MIDDLE"
    elif rank_pct >= 0.20: band = "LOWER"
    else:                  band = "BOTTOM QUINTILE"
    return {"band": band, "percentile": pct}

def factor_trend(row: dict) -> str:
    d = row.get("rank_delta")
    if d is not None and not pd.isna(d):
        return "RISING" if float(d) >= 0 else "FALLING"
    return "RISING" if float(row.get("rank_pct", 0.5)) >= 0.5 else "FALLING"


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app):
    global STORE
    STORE = ScoreStore(SCORES_PATH)
    yield

app = FastAPI(title="NSE Factor Screener", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


@app.post("/admin/reload")
def admin_reload():
    if STORE is None: raise HTTPException(503, "Store not initialized.")
    STORE.reload()
    return {"reloaded": True, "scored_date": STORE.scored_date,
            "symbols": 0 if STORE.df is None else len(STORE.df)}


def compute_factor_breakdown(df: pd.DataFrame) -> list[dict]:
    """Component momentum/technical readings for ONE stock, from its own price
    history. Descriptive — shows what underlies the composite. No predictions."""
    close = df["Close"]
    n = len(close)

    def chg(k):
        return None if n <= k else round((float(close.iloc[-1]) / float(close.iloc[-1 - k]) - 1) * 100, 1)

    ret_21, mom_63 = chg(21), chg(63)
    rsi = round(float(df["RSI"].iloc[-1]), 1) if "RSI" in df.columns else None
    dist_high = round((float(close.iloc[-1]) / float(close.iloc[-63:].max()) - 1) * 100, 1) if n >= 63 else None
    if "Volume" in df.columns and n >= 20:
        va = float(df["Volume"].iloc[-20:].mean())
        vol_chg = round((float(df["Volume"].iloc[-1]) / va - 1) * 100, 1) if va > 0 else None
    else:
        vol_chg = None
    px_ma50 = round((float(close.iloc[-1]) / float(close.iloc[-50:].mean()) - 1) * 100, 1) if n >= 50 else None

    sign = lambda v: "pos" if (v is not None and v >= 0) else "neg"
    rsi_tone = "neutral" if rsi is None else ("neg" if rsi > 70 else ("pos" if rsi < 30 else "neutral"))
    return [
        {"label": "1M RETURN",      "value": ret_21,   "unit": "%", "tone": sign(ret_21),  "hint": "1-month price change"},
        {"label": "3M MOMENTUM",    "value": mom_63,   "unit": "%", "tone": sign(mom_63),  "hint": "3-month price change"},
        {"label": "RSI (14)",       "value": rsi,      "unit": "",  "tone": rsi_tone,       "hint": "overbought >70 · oversold <30"},
        {"label": "BELOW 63D HIGH", "value": dist_high, "unit": "%", "tone": "neutral",     "hint": "distance from recent peak"},
        {"label": "VOLUME vs 20D",  "value": vol_chg,  "unit": "%", "tone": sign(vol_chg),  "hint": "today's volume vs 20-day average"},
        {"label": "PRICE vs 50D MA", "value": px_ma50, "unit": "%", "tone": sign(px_ma50),  "hint": "distance from 50-day moving average"},
    ]


@app.get("/profile/{symbol}")
def profile(symbol: str):
    sym = _validate_symbol(symbol)
    vix_data = fetch_vix()
    row = STORE.get(sym) if STORE else None
    in_universe = row is not None

    if in_universe:
        prof = derive_band(float(row["rank_pct"]))
        prof["composite_score"] = round(float(row["score"]), 4)
        meta_rsi, store_price = round(float(row["rsi"]), 2), float(row["price"])
        ret_3m, trend = round(float(row["ret_3m"]), 2), factor_trend(row)
    else:
        prof = {"band": "NOT RANKED", "percentile": None, "composite_score": None}
        meta_rsi, store_price, ret_3m, trend = None, None, None, "—"

    ohlc, comparison, current_close = [], [], store_price
    breakdown = []
    try:
        raw = _flatten(yf.download(sym, period="1y", progress=False, timeout=5, auto_adjust=False))
        if not raw.empty and len(raw) >= MIN_HISTORY_BARS:
            df = engineer_features(pd.DataFrame({
                "Open": raw["Open"].squeeze(), "High": raw["High"].squeeze(),
                "Low": raw["Low"].squeeze(), "Close": raw["Close"].squeeze(),
                "Volume": raw["Volume"].squeeze()}, index=raw.index))
            current_close = safe_scalar(df["Close"])
            if meta_rsi is None: meta_rsi = round(safe_scalar(df["RSI"]), 2)
            breakdown = compute_factor_breakdown(df)
            ohlc = [{"x": int(df.index[i].timestamp() * 1000),
                     "y": [round(float(df["Open"].iloc[i]), 2), round(float(df["High"].iloc[i]), 2),
                           round(float(df["Low"].iloc[i]), 2), round(float(df["Close"].iloc[i]), 2)],
                     "ema20": round(float(df["EMA20"].iloc[i]), 2),
                     "ema50": round(float(df["EMA50"].iloc[i]), 2)} for i in range(-45, 0)]
            comparison = [{"timestamp": int(df.index[i].timestamp() * 1000),
                           "close": round(float(df["Close"].iloc[i]), 2),
                           "rsi": round(float(df["RSI"].iloc[i]), 1)} for i in range(-45, 0)]
    except Exception as exc:
        log.warning("Chart fetch failed %s: %s", sym, exc)

    if current_close is None:
        if not in_universe:
            raise HTTPException(404, f"{sym} is not in the ranked universe and live data is unavailable.")
        current_close = store_price

    return {
        "symbol": sym,
        "meta": {"current_price": round(current_close, 2), "rsi": meta_rsi,
                 "market_regime": market_regime(vix_data["current"]),
                 "factor_trend": trend, "in_universe": in_universe},
        "factor_profile": {**prof, "scored_date": STORE.scored_date if STORE else None},
        "factors": {"rsi": meta_rsi, "ret_3m_pct": ret_3m},
        "factor_breakdown": breakdown,
        "vix_snapshot": vix_data,
        "analytics": {"ohlc": ohlc, "comparison": comparison},
        "disclaimer": DISCLAIMER,
    }


def _rows(df, nifty_3m, is_fb):
    out = []
    for _, r in df.iterrows():
        row = r.to_dict()
        b = derive_band(float(row["rank_pct"]))
        out.append({
            "symbol": str(row["symbol"]).replace(".NS", "").replace(".BO", ""),
            "sector": str(row.get("sector", "UNKNOWN")),
            "price": round(float(row["price"]), 2),
            "rsi": round(float(row["rsi"]), 1),
            "band": b["band"], "percentile": b["percentile"],
            "factor_trend": factor_trend(row),
            "relative_strength": round(float(row.get("ret_3m", 0.0)) - nifty_3m, 2),
            "nifty_benchmark_fallback": is_fb,
        })
    out.sort(key=lambda x: x["percentile"], reverse=True)
    return out


@app.get("/screener/{index_name}")
def screener(index_name: str, limit: int = Query(default=UNIVERSE_SCAN_LIMIT, ge=1, le=2000)):
    idx = index_name.strip().upper()
    if STORE is None or not STORE.ready:
        raise HTTPException(503, "Factor data empty. Run the scorer, then POST /admin/reload.")
    if idx == "UNIVERSE":       df = STORE.top(limit)
    elif idx in INDEX_MAPPINGS: df = STORE.members(INDEX_MAPPINGS[idx])
    else: raise HTTPException(404, f"Unknown index '{index_name}'. Use a named index or 'UNIVERSE'.")
    if df.empty: raise HTTPException(404, f"No ranked symbols for '{idx}'.")

    nifty_3m, is_fb = fetch_nifty_3m()
    results = _rows(df, nifty_3m, is_fb)
    pcts = [r["percentile"] for r in results]

    return {
        "index": idx, "scored_date": STORE.scored_date,
        "summary": {
            "names": len(results),
            "top_quintile": sum(1 for r in results if r["percentile"] >= 80),
            "median_percentile": round(float(np.median(pcts)), 1),
            "overbought_rsi": sum(1 for r in results if r["rsi"] > 70),
            "nifty_3m_return": nifty_3m, "nifty_is_fallback": is_fb,
        },
        "results": results,
        "disclaimer": DISCLAIMER,
    }


@app.get("/sector-factors")
def sector_factors():
    if STORE is None or not STORE.ready:
        raise HTTPException(503, "Factor data empty. Run the scorer, then POST /admin/reload.")
    agg = STORE.df.groupby("sector")["rank_pct"].agg(["mean", "count"]).reset_index()
    out = []
    for _, r in agg.iterrows():
        avg = round(float(r["mean"]) * 100, 1)
        tilt = "ABOVE AVERAGE" if avg >= 58 else ("BELOW AVERAGE" if avg <= 43 else "AVERAGE")
        out.append({"sector": r["sector"], "tilt": tilt,
                    "avg_percentile": avg, "n_tickers": int(r["count"])})
    out.sort(key=lambda x: x["avg_percentile"], reverse=True)
    return {"sectors": out, "scored_date": STORE.scored_date, "disclaimer": DISCLAIMER}


def load_holdings() -> dict:
    """Read user positions from holdings.json. Raises 404 if absent/malformed."""
    if not os.path.exists(HOLDINGS_PATH):
        raise HTTPException(404, f"No holdings file at {HOLDINGS_PATH}. Create data/holdings.json.")
    try:
        with open(HOLDINGS_PATH, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        positions = doc.get("positions", [])
        if not isinstance(positions, list):
            raise ValueError("'positions' must be a list")
        return {"base_currency": (doc.get("base_currency") or "INR").upper(),
                "positions": positions}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Could not parse holdings.json: {exc}")


def save_holdings(doc: dict) -> None:
    """Atomically rewrite holdings.json (temp file + os.replace)."""
    tmp = HOLDINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)
    os.replace(tmp, HOLDINGS_PATH)


def _normalize_holding_symbol(sym: str, exch: str) -> str:
    """NSE positions carry a .NS suffix; US positions are the bare ticker."""
    s = sym.strip().upper()
    if not _SYMBOL_RE.match(s):
        raise HTTPException(400, f"Invalid symbol '{sym}'.")
    if exch == "US":
        return s.replace(".NS", "").replace(".BO", "")
    return s if s.endswith((".NS", ".BO")) else s + ".NS"


class PositionIn(BaseModel):
    symbol: str
    exchange: str = "NSE"
    qty: float
    avg_price: float


@app.post("/portfolio/positions")
def add_position(pos: PositionIn):
    """Add a holding (or accumulate into an existing one at a weighted-average
    cost). Validates the ticker by requiring a live price before saving."""
    exch = pos.exchange.strip().upper()
    if exch not in ("NSE", "US"):
        raise HTTPException(400, "exchange must be 'NSE' or 'US'.")
    if pos.qty <= 0 or pos.avg_price <= 0:
        raise HTTPException(400, "qty and avg_price must be positive.")
    sym = _normalize_holding_symbol(pos.symbol, exch)

    if fetch_last_prices([sym]).get(sym) is None:
        raise HTTPException(422, f"No live price found for '{sym}'. Check the ticker "
                                 f"(NSE uses the yfinance NSE name, US uses the plain ticker).")

    doc = load_holdings()
    for p in doc["positions"]:
        if (str(p["symbol"]).upper() == sym
                and str(p.get("exchange", "NSE")).upper() == exch):
            oq, oa = float(p["qty"]), float(p["avg_price"])
            nq = oq + pos.qty
            p["avg_price"] = round((oq * oa + pos.qty * pos.avg_price) / nq, 4)
            p["qty"] = round(nq, 4)
            break
    else:
        doc["positions"].append({"symbol": sym, "exchange": exch,
                                 "qty": pos.qty, "avg_price": pos.avg_price})
    save_holdings(doc)
    return {"ok": True, "symbol": sym, "positions": doc["positions"]}


@app.delete("/portfolio/positions/{symbol}")
def remove_position(symbol: str, exchange: str = Query(default=None)):
    """Remove a holding by display symbol (suffix-insensitive), optionally
    scoped to an exchange when the same ticker exists on both."""
    target = symbol.strip().upper().replace(".NS", "").replace(".BO", "")

    def matches(p):
        ps = str(p["symbol"]).upper().replace(".NS", "").replace(".BO", "")
        if ps != target:
            return False
        return not exchange or str(p.get("exchange", "NSE")).upper() == exchange.upper()

    doc = load_holdings()
    kept = [p for p in doc["positions"] if not matches(p)]
    if len(kept) == len(doc["positions"]):
        raise HTTPException(404, f"No position matching '{symbol}'.")
    doc["positions"] = kept
    save_holdings(doc)
    return {"ok": True, "removed": target, "positions": kept}


class PositionEdit(BaseModel):
    qty: float
    avg_price: float
    exchange: str | None = None


@app.put("/portfolio/positions/{symbol}")
def edit_position(symbol: str, body: PositionEdit):
    """Replace an existing holding's quantity and average buy price outright
    (unlike POST, which accumulates). Optionally scoped by exchange."""
    if body.qty <= 0 or body.avg_price <= 0:
        raise HTTPException(400, "qty and avg_price must be positive.")
    target = symbol.strip().upper().replace(".NS", "").replace(".BO", "")

    doc = load_holdings()
    updated = None
    for p in doc["positions"]:
        ps = str(p["symbol"]).upper().replace(".NS", "").replace(".BO", "")
        if ps != target:
            continue
        if body.exchange and str(p.get("exchange", "NSE")).upper() != body.exchange.upper():
            continue
        p["qty"] = round(body.qty, 4)
        p["avg_price"] = round(body.avg_price, 4)
        updated = p
        break
    if updated is None:
        raise HTTPException(404, f"No position matching '{symbol}'.")
    save_holdings(doc)
    return {"ok": True, "updated": updated, "positions": doc["positions"]}


@app.get("/portfolio")
def portfolio():
    """Live P&L across NSE + US holdings, rolled up into an INR base using USDINR.
    Descriptive reporting only — your entered cost basis vs. latest market price."""
    doc = load_holdings()
    positions = doc["positions"]
    if not positions:
        return {"holdings": [], "summary": {}, "fx": fetch_usdinr(),
                "allocation": {}, "disclaimer": DISCLAIMER}

    fx = fetch_usdinr()
    rate = float(fx["rate"])
    prices = fetch_last_prices([p["symbol"] for p in positions])

    holdings, stale = [], []
    tot_inv = tot_val = tot_day = 0.0
    alloc = {"NSE": 0.0, "US": 0.0}

    for p in positions:
        sym = str(p["symbol"]).upper()
        exch = str(p.get("exchange", "NSE")).upper()
        is_us = exch == "US"
        qty = float(p.get("qty", 0))
        avg = float(p.get("avg_price", 0))
        ccy = "USD" if is_us else "INR"
        fxm = rate if is_us else 1.0            # native → INR multiplier

        px = prices.get(sym)
        if px is None:
            last = prev = avg                   # fall back to cost basis; flag it
            spark = []
            stale.append(sym)
        else:
            last, prev, spark = px["last"], px["prev"], px.get("spark", [])

        invested_inr = qty * avg * fxm
        value_inr = qty * last * fxm
        pnl_inr = value_inr - invested_inr
        day_inr = qty * (last - prev) * fxm

        tot_inv += invested_inr
        tot_val += value_inr
        tot_day += day_inr
        alloc["US" if is_us else "NSE"] += value_inr

        holdings.append({
            "symbol": sym.replace(".NS", "").replace(".BO", ""),
            "exchange": exch, "currency": ccy, "qty": round(qty, 4),
            "avg_price": round(avg, 2), "last_price": round(last, 2),
            "invested_inr": round(invested_inr, 2), "value_inr": round(value_inr, 2),
            "pnl_inr": round(pnl_inr, 2),
            "pnl_pct": round((last / avg - 1) * 100, 2) if avg else 0.0,
            "day_change_pct": round((last / prev - 1) * 100, 2) if prev else 0.0,
            "day_change_inr": round(day_inr, 2),
            "spark": spark,
            "stale": px is None,
        })

    holdings.sort(key=lambda h: h["value_inr"], reverse=True)
    winners = [h for h in holdings if h["pnl_pct"] is not None]
    best = max(winners, key=lambda h: h["pnl_pct"], default=None)
    worst = min(winners, key=lambda h: h["pnl_pct"], default=None)
    tv = tot_val or 1.0

    return {
        "holdings": holdings,
        "summary": {
            "invested_inr": round(tot_inv, 2),
            "value_inr": round(tot_val, 2),
            "pnl_inr": round(tot_val - tot_inv, 2),
            "pnl_pct": round((tot_val / tot_inv - 1) * 100, 2) if tot_inv else 0.0,
            "day_change_inr": round(tot_day, 2),
            "day_change_pct": round(tot_day / (tot_val - tot_day) * 100, 2) if (tot_val - tot_day) else 0.0,
            "n_holdings": len(holdings),
            "best": {"symbol": best["symbol"], "pnl_pct": best["pnl_pct"]} if best else None,
            "worst": {"symbol": worst["symbol"], "pnl_pct": worst["pnl_pct"]} if worst else None,
        },
        "allocation": {"NSE": round(alloc["NSE"] / tv * 100, 1),
                       "US": round(alloc["US"] / tv * 100, 1)},
        "fx": {**fx, "pair": "USDINR"},
        "stale_symbols": stale,
        "disclaimer": DISCLAIMER,
    }


def _weekly_files():
    """(week_ending, path) for each weekly_momentum_YYYY-MM-DD_full.csv, newest first."""
    data_dir = os.path.dirname(SCORES_PATH)
    out = []
    for f in glob.glob(os.path.join(data_dir, "weekly_momentum_*_full.csv")):
        m = re.search(r"weekly_momentum_(\d{4}-\d{2}-\d{2})_full\.csv$", os.path.basename(f))
        if m:
            out.append((m.group(1), f))
    out.sort(key=lambda x: x[0], reverse=True)
    return out


def _f(v, d=None):
    try:
        f = float(v)
        return d if pd.isna(f) else f
    except Exception:
        return d


@app.get("/weekly-breakouts")
def weekly_breakouts(week: str = Query(default=None),
                     limit: int = Query(default=60, ge=1, le=300)):
    """This week's momentum-breakout screen, with each name's live performance
    since its breakout (current price vs. the breakout-week close). Descriptive."""
    files = _weekly_files()
    if not files:
        raise HTTPException(404, "No weekly breakout files found (data/weekly_momentum_*_full.csv).")
    weeks = [w for w, _ in files]
    chosen = week if (week and week in weeks) else weeks[0]
    path = dict(files)[chosen]

    try:
        df = pd.read_csv(path).head(limit)
    except Exception as exc:
        raise HTTPException(500, f"Could not read {os.path.basename(path)}: {exc}")
    if "Symbol" not in df.columns or "Close" not in df.columns:
        raise HTTPException(500, f"{os.path.basename(path)} missing expected columns.")

    symbols = [f"{str(s).strip().upper()}.NS" for s in df["Symbol"].tolist()]
    prices = fetch_last_prices(symbols)
    since_date = (pd.to_datetime(chosen) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    hist = fetch_ohlc_since(symbols, since_date)

    rows = []
    for _, r in df.iterrows():
        sym = str(r["Symbol"]).strip().upper()
        px = prices.get(f"{sym}.NS")
        bclose = _f(r.get("Close"))
        cur = px["last"] if px else None
        since = round((cur / bclose - 1) * 100, 2) if (cur and bclose) else None

        h = hist.get(f"{sym}.NS")
        peak = h["high"] if h else None

        # Mechanical rule: buy the first session's open after the breakout, hold a
        # fixed horizon; if the horizon hasn't elapsed yet, mark to the latest close.
        rule_pct, rule_open = None, None
        if h and h.get("entry_open") and h.get("closes"):
            entry, closes = h["entry_open"], h["closes"]
            if len(closes) >= BREAKOUT_HORIZON_TD:
                exit_px, rule_open = closes[BREAKOUT_HORIZON_TD - 1], False
            else:
                exit_px, rule_open = closes[-1], True
            rule_pct = round((exit_px / entry - 1) * 100, 2)

        # Live state, keyed off NOW vs the breakout close (thresholds disclosed).
        state = None
        if since is not None:
            state = ("FAILED" if since <= STATE_FAIL_PCT
                     else "EXTENDED" if since >= STATE_EXT_PCT else "ACTIVE")

        rows.append({
            "symbol": sym,
            "score": _f(r.get("Score")),
            "breakout_close": round(bclose, 2) if bclose else None,
            "week_return_pct": _f(r.get("Week Return %")),
            "vol_surge": _f(r.get("Vol Surge (x)")),
            "ret_4w": _f(r.get("4W Return %")),
            "ret_12w": _f(r.get("12W Return %")),
            "rs_4w": _f(r.get("RS vs Mkt 4W %")),
            "from_52w_high": _f(r.get("% From 52W High")),
            "adtv": _f(r.get("ADTV (Rs cr/day)")),
            "gates": str(r.get("Gates Passed", "")),
            "current_price": round(cur, 2) if cur else None,
            "since_pct": since,
            "high_since": peak,
            "state": state,
            "rule_pct": rule_pct,
            "rule_open": rule_open,
            "spark": px.get("spark", []) if px else [],
            "stale": px is None,
        })

    tracked = [x["since_pct"] for x in rows if x["since_pct"] is not None]
    states = [x["state"] for x in rows if x["state"]]
    return {
        "week_ending": chosen,
        "available_weeks": weeks,
        "summary": {
            "n": len(rows),
            "avg_since_pct": round(sum(tracked) / len(tracked), 2) if tracked else None,
            "winners": sum(1 for x in tracked if x > 0),
            "losers": sum(1 for x in tracked if x < 0),
            "active": states.count("ACTIVE"),
            "extended": states.count("EXTENDED"),
            "failed": states.count("FAILED"),
        },
        "rule": {
            "entry": "first session open after the breakout week",
            "horizon_td": BREAKOUT_HORIZON_TD,
            "state_fail_pct": STATE_FAIL_PCT,
            "state_ext_pct": STATE_EXT_PCT,
            "note": "RULE % is marked to the latest close until the horizon elapses; "
                    "SCORE and GATES are as-of the breakout scan, not re-evaluated live.",
        },
        "breakouts": rows,
        "disclaimer": DISCLAIMER,
    }


def _vcp_files():
    """(week_ending, path) for each breakout_vcp_YYYY-MM-DD_full.csv, newest first."""
    data_dir = os.path.dirname(SCORES_PATH)
    out = []
    for f in glob.glob(os.path.join(data_dir, "breakout_vcp_*_full.csv")):
        m = re.search(r"breakout_vcp_(\d{4}-\d{2}-\d{2})_full\.csv$", os.path.basename(f))
        if m:
            out.append((m.group(1), f))
    out.sort(key=lambda x: x[0], reverse=True)
    return out


# The VCP/Stage-2 screen was backtested and did NOT beat its own universe.
# This verdict travels with every response so the UI can never present it as a signal.
VCP_VERDICT = (
    "Backtest 2022–2026 (price-normalised contraction, clustered by week): NO edge "
    "over its own gate-passing universe — average 12-week edge about −1.5% across "
    "144 weeks, and only 44% of weeks beat the equal-weight benchmark. The flattering "
    "+3.6%/trade average collapses to +0.9%/week once same-week trades are clustered. "
    "Research/transparency only: a precisely-defined filter with no proven "
    "forward-return edge, not a buy list."
)


@app.get("/vcp-breakouts")
def vcp_breakouts(week: str = Query(default=None),
                  limit: int = Query(default=60, ge=1, le=300)):
    """VCP / Weinstein Stage-2 weekly breakout screen (weekly_breakout_vcp.py),
    enriched with live price since the breakout close. Research view — the
    backtest verdict (no edge) rides along in every response."""
    files = _vcp_files()
    if not files:
        raise HTTPException(404, "No VCP breakout files found (data/breakout_vcp_*_full.csv). "
                                 "Run weekly_breakout_vcp.py first.")
    weeks = [w for w, _ in files]
    chosen = week if (week and week in weeks) else weeks[0]
    path = dict(files)[chosen]

    try:
        df_full = pd.read_csv(path)
    except Exception as exc:
        raise HTTPException(500, f"Could not read {os.path.basename(path)}: {exc}")
    total_signals = len(df_full)               # summary counts the WHOLE file...
    df = df_full.head(limit)                    # ...only the display is limited

    rows = []
    if "symbol" in df.columns and not df.empty:
        symbols = [f"{str(s).strip().upper()}.NS" for s in df["symbol"].tolist()]
        prices = fetch_last_prices(symbols)
        for _, r in df.iterrows():
            sym = str(r["symbol"]).strip().upper()
            px = prices.get(f"{sym}.NS")
            bclose = _f(r.get("close"))
            cur = px["last"] if px else None
            since = round((cur / bclose - 1) * 100, 2) if (cur and bclose) else None
            rows.append({
                "symbol": sym,
                "breakout_close": round(bclose, 2) if bclose else None,
                "base_high": _f(r.get("base_high")),
                "ext_above_pivot_pct": _f(r.get("ext_above_pivot_pct")),
                "base_depth_pct": _f(r.get("base_depth_pct")),
                "vol_mult": _f(r.get("vol_mult")),
                "close_strength": _f(r.get("close_strength")),
                "tr_contraction": _f(r.get("tr_contraction")),
                "adtv": _f(r.get("adtv_cr")),
                "near_results": {"True": True, "False": False}.get(
                    str(r.get("near_results")).strip()),
                "current_price": round(cur, 2) if cur else None,
                "since_pct": since,
                "spark": px.get("spark", []) if px else [],
                "stale": px is None,
            })

    tracked = [x["since_pct"] for x in rows if x["since_pct"] is not None]
    return {
        "week_ending": chosen,
        "available_weeks": weeks,
        "summary": {
            "n": total_signals,
            "shown": len(rows),
            "avg_since_pct": round(sum(tracked) / len(tracked), 2) if tracked else None,
        },
        "verdict": VCP_VERDICT,
        "breakouts": rows,
        "disclaimer": DISCLAIMER,
    }


@app.get("/explain/{symbol}")
def explain(symbol: str):
    sym = _validate_symbol(symbol)
    if _gemini is None:
        raise HTTPException(503, "Gemini not configured. Install google-genai, set GEMINI_API_KEY, restart.")
    if STORE is None or not STORE.ready:
        raise HTTPException(503, "Factor data not loaded.")
    row = STORE.get(sym)
    if row is None:
        raise HTTPException(404, f"{sym} is not in the ranked universe.")

    key = (sym, STORE.scored_date)
    if key in _explain_cache:
        return {"symbol": sym, "explanation": _explain_cache[key], "cached": True}

    # Compute the same factor breakdown /profile shows, so Gemini cites real numbers.
    breakdown = []
    try:
        raw = _flatten(yf.download(sym, period="1y", progress=False, timeout=5, auto_adjust=False))
        if not raw.empty and len(raw) >= MIN_HISTORY_BARS:
            bdf = engineer_features(pd.DataFrame({
                "Open": raw["Open"].squeeze(), "High": raw["High"].squeeze(),
                "Low": raw["Low"].squeeze(), "Close": raw["Close"].squeeze(),
                "Volume": raw["Volume"].squeeze()}, index=raw.index))
            breakdown = compute_factor_breakdown(bdf)
    except Exception as exc:
        log.warning("Explain breakdown fetch failed %s: %s", sym, exc)

    b = derive_band(float(row["rank_pct"]))
    factor_lines = "\n".join(
        f"- {f['label']}: {f['value']}{f['unit']} ({f['hint']})"
        for f in breakdown if f["value"] is not None
    ) or "- (component readings unavailable)"

    prompt = (
        f"Stock: {row.get('name', sym)} ({sym}). As of {STORE.scored_date}, on a "
        f"cross-sectional momentum/technical ranking of the NSE universe:\n"
        f"- Factor percentile: {b['percentile']} (band: {b['band']})\n"
        f"- RSI(14): {round(float(row['rsi']), 1)}\n"
        f"- Trailing 3-month return: {round(float(row['ret_3m']), 1)}%\n"
        f"Component factor readings:\n{factor_lines}\n\n"
        f"Explain in plain English what this descriptive profile means. Reference the "
        f"specific component readings that most explain where it sits (e.g. strong "
        f"momentum, fading volume, distance from its high)."
    )
    try:
        resp = _gemini.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=GEMINI_SYSTEM, temperature=0.3, max_output_tokens=600,
                thinking_config=types.ThinkingConfig(thinking_budget=0)),
        )
        text = (resp.text or "").strip()
    except Exception as exc:
        log.error("Gemini explain failed: %s", exc)
        raise HTTPException(502, "Explanation service unavailable.")

    _explain_cache[key] = text
    return {"symbol": sym, "explanation": text, "cached": False}


@app.get("/stocks/search")
def search_stocks(q: str = Query(default="", max_length=50)):
    if not q.strip() or STORE is None: return []
    return STORE.search(q.strip())


@app.get("/health")
def health():
    return {"status": "ok", "data_loaded": bool(STORE and STORE.ready),
            "scored_date": STORE.scored_date if STORE else None,
            "gemini_enabled": _gemini is not None,
            "universe_size": 0 if (STORE is None or STORE.df is None) else len(STORE.df)}
