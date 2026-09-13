#!/usr/bin/env python3
"""strategy_scan.py — a daily-timeframe technical scorecard over the NSE universe,
matching the discretionary checklist this dashboard's owner trades:

  1. Trend & price structure   (close above a rising 50-DMA)
  2. 20/50/100/200 SMA stack    (price > 20 > 50 > 100 > 200, graded)
  3. RSI(14) & MACD(12,26,9)    (momentum up, not exhausted)
  4. Volume contribution        (today's volume vs the 50-day average)
  5. VCP                         (ATR% of the last 10 days < the prior 10)
  6. Breakout structure         (at/near the 60-day base high)
  7. Nearby resistance           (headroom to the next resistance above)
  8. Room toward R4              (monthly floor-trader pivots; % to R4)
  9. Risk / reward               ((target - entry) / (entry - stop))

It produces a 0-100 composite plus a per-criterion breakdown so the setups can be
JUDGED, not blindly trusted. This is a DESCRIPTIVE screen of a mechanical rule —
NOT a signal engine, price target, or investment advice. Backtest before trusting.

    ./venv/Scripts/python.exe strategy_scan.py            # top setups today
    ./venv/Scripts/python.exe strategy_scan.py --top 40
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
PANEL = HERE / "data" / "panel.parquet"
RS_CR = 1e7
ETF_RE = r"(?:BEES|ETF|IETF|LIQUID|GOLD|SILVER|NIFTY|SENSEX|GSEC|SDL|GILT|BOND|MAFANG)"


def _rsi(s: pd.Series, n: int = 14) -> pd.Series:
    d = s.diff()
    up = d.clip(lower=0)
    dn = (-d).clip(lower=0)
    au = up.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    ad = dn.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = au / ad.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def compute(df: pd.DataFrame) -> pd.DataFrame:
    """Attach daily indicator columns (per symbol, oldest→newest)."""
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    g = df.groupby("symbol", observed=True)

    for w in (20, 50, 100, 200):
        df[f"sma{w}"] = g["close"].transform(lambda s, w=w: s.rolling(w, min_periods=w).mean())
    df["sma50_prev"] = g["sma50"].shift(21)                       # ~1 month ago

    df["rsi"] = g["close"].transform(_rsi)
    ema12 = g["close"].transform(lambda s: s.ewm(span=12, adjust=False).mean())
    ema26 = g["close"].transform(lambda s: s.ewm(span=26, adjust=False).mean())
    df["macd"] = ema12 - ema26
    df["macd_sig"] = df.groupby("symbol", observed=True)["macd"].transform(
        lambda s: s.ewm(span=9, adjust=False).mean())

    prev_close = g["close"].shift(1)
    tr = np.maximum.reduce([
        (df["high"] - df["low"]).to_numpy(),
        (df["high"] - prev_close).abs().to_numpy(),
        (df["low"] - prev_close).abs().to_numpy(),
    ])
    df["trn"] = tr / df["close"].replace(0, np.nan)
    gg = df.groupby("symbol", observed=True)
    df["atr_recent"] = gg["trn"].transform(lambda s: s.rolling(10, min_periods=10).mean())
    df["atr_prev"] = gg["atr_recent"].shift(10)

    df["volavg50"] = gg["volume"].transform(lambda s: s.shift(1).rolling(50, min_periods=20).mean())
    df["base_high"] = gg["high"].transform(lambda s: s.shift(1).rolling(60, min_periods=30).max())
    df["swing_low"] = gg["low"].transform(lambda s: s.shift(1).rolling(20, min_periods=10).min())
    df["med_turnover"] = gg["turnover"].transform(lambda s: s.rolling(20, min_periods=10).median())
    return df


def monthly_pivots(df: pd.DataFrame) -> pd.DataFrame:
    """Classic floor-trader pivots from each row's PRIOR calendar month H/L/C.
    Returns df with pivot/R1..R4/S1..S4 columns merged on symbol+month."""
    d = df.copy()
    d["ym"] = d["date"].dt.to_period("M")
    mo = d.groupby(["symbol", "ym"], observed=True).agg(
        mh=("high", "max"), ml=("low", "min"), mc=("close", "last")).reset_index()
    for c in ("mh", "ml", "mc"):
        mo[c] = mo.groupby("symbol", observed=True)[c].shift(1)      # PRIOR month
    P = (mo["mh"] + mo["ml"] + mo["mc"]) / 3
    rng = mo["mh"] - mo["ml"]
    mo["pivot"] = P
    mo["R1"] = 2 * P - mo["ml"]
    mo["R2"] = P + rng
    mo["R3"] = mo["mh"] + 2 * (P - mo["ml"])
    mo["R4"] = mo["R3"] + rng
    mo["S1"] = 2 * P - mo["mh"]
    keep = ["symbol", "ym", "pivot", "R1", "R2", "R3", "R4", "S1"]
    return d.merge(mo[keep], on=["symbol", "ym"], how="left")


def score_latest(df: pd.DataFrame, cfg) -> pd.DataFrame:
    """Take the newest bar per symbol, gate the universe, and score the setup."""
    last = df.groupby("symbol", observed=True).tail(1).copy()
    last = last[
        (last["sma200"].notna())
        & (last["close"] >= cfg.min_price)
        & (last["med_turnover"] >= cfg.min_turnover_cr * RS_CR)
    ].copy()
    if last.empty:
        return last

    last = add_scores(last, cfg.min_rr)

    # nearby resistance = nearest level ABOVE price (the immediate obstacle) —
    # display only, so computed on the small live snapshot rather than history.
    def _nearby(row):
        ups = [row[k] for k in ("base_high", "R1", "R2", "R3", "R4")
               if pd.notna(row[k]) and row[k] > row["close"]]
        return min(ups) if ups else (row["R4"] if pd.notna(row["R4"]) else row["close"] * 1.1)
    last["target_near"] = last.apply(_nearby, axis=1)
    last["reward_near_pct"] = (last["target_near"] / last["close"] - 1) * 100

    last["symbol"] = last["symbol"].str.replace(".NS", "", regex=False).str.replace(".BO", "", regex=False)
    return last.sort_values("score", ascending=False)


def add_scores(f: pd.DataFrame, min_rr: float = 2.0) -> pd.DataFrame:
    """Vectorised checklist gates + the 0-100 composite, for ANY set of rows
    (the live snapshot or full history). Single source of truth for the score,
    so the backtest measures exactly what the scanner shows."""
    c = f["close"]
    f["trend_ok"] = (c > f["sma50"]) & (f["sma50"] > f["sma50_prev"])
    align_bits = ((c > f["sma20"]).astype(int) + (f["sma20"] > f["sma50"]).astype(int)
                  + (f["sma50"] > f["sma100"]).astype(int) + (f["sma100"] > f["sma200"]).astype(int))
    f["align_bits"] = align_bits                                # 0..4
    f["aligned"] = align_bits == 4
    f["rsi_ok"] = f["rsi"].between(50, 78)
    f["macd_ok"] = (f["macd"] > f["macd_sig"]) & (f["macd"] > 0)
    f["vol_ratio"] = (f["volume"] / f["volavg50"]).replace([np.inf, -np.inf], np.nan)
    f["vol_ok"] = f["vol_ratio"] >= 1.0
    f["vcp_ok"] = f["atr_recent"] < f["atr_prev"]
    f["breakout_ok"] = c >= f["base_high"] * 0.985
    f["ext_above_base_pct"] = (c / f["base_high"] - 1) * 100

    # R4 = the monthly extension target (the swing goal); R:R is scored on R4.
    f["target_r4"] = np.where(f["R4"].notna() & (f["R4"] > c), f["R4"], c * 1.1)
    stop = np.where(f["swing_low"] < c, f["swing_low"], f["sma50"])
    f["stop"] = np.minimum(stop, c * 0.999)                     # stop must sit below price
    f["risk_pct"] = (c / f["stop"] - 1) * 100
    f["room_to_r4_pct"] = (f["target_r4"] / c - 1) * 100
    f["rr"] = (f["room_to_r4_pct"] / f["risk_pct"]).replace([np.inf, -np.inf], np.nan)
    f["rr_ok"] = f["rr"] >= min_rr

    rr = f["rr"].clip(lower=0).fillna(0)
    vr = f["vol_ratio"].clip(lower=0).fillna(0)
    f["score"] = (
        18 * f["trend_ok"]
        + 18 * (align_bits / 4)
        + 8 * f["rsi_ok"] + 8 * f["macd_ok"]
        + 10 * (vr.clip(upper=2) / 2)
        + 10 * f["vcp_ok"]
        + 15 * f["breakout_ok"]
        + 13 * (rr.clip(upper=3) / 3)
    ).round(1)
    return f


def build(cfg) -> pd.DataFrame:
    df = pd.read_parquet(PANEL, columns=["date", "symbol", "sector", "open",
                                         "high", "low", "close", "volume", "turnover"])
    df = df[~df["symbol"].str.contains(ETF_RE, na=False)]
    cutoff = df["date"].max() - pd.Timedelta(days=cfg.window_days)
    df = df[df["date"] >= cutoff]
    df = compute(df)
    df = monthly_pivots(df)
    return score_latest(df, cfg)


# --------------------------------------------------------------------------- #
# Variant: "EMA turnaround" (a Chartink-style scan shared by the owner)
# --------------------------------------------------------------------------- #
def add_turnaround(df: pd.DataFrame) -> pd.DataFrame:
    """Chartink-style scan — a FRESH weekly turnaround with a daily entry trigger.

    Weekly structure (last completed week, point-in-time):
      - weekly EMA20 rising: now > 5w ago > 10w > 15w > 20w > 25w ago
      - weekly EMA50 rising: same 25-week chain
      - weekly EMA200 rising: now > 5w > 10w > 15w ago
      - AND 30 weeks ago EMA20 < EMA200  (it was in a downtrend then: an early
        Stage-2 turnaround, not an old leader)
    Daily trigger, any one of:
      - EMA20 crosses above EMA50 today
      - pullback: low touches EMA20 and close finishes back above it
      - EMA50 crosses above EMA200 today (golden cross)

    Caveat: panel.parquet starts ~2022, so the WEEKLY EMA200 is not fully
    warmed (needs ~600 weeks to converge). It is a long-window smoother here,
    faithful in shape, not in level — the scan only compares it to itself.
    """
    from weekly_momentum import to_weekly
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    g = df.groupby("symbol", observed=True)
    for w in (20, 50, 200):
        df[f"ema{w}"] = g["close"].transform(lambda s, w=w: s.ewm(span=w, adjust=False).mean())
    gg = df.groupby("symbol", observed=True)
    e20p, e50p, e200p = gg["ema20"].shift(1), gg["ema50"].shift(1), gg["ema200"].shift(1)
    cross_20_50 = (df["ema20"] > df["ema50"]) & (e20p <= e50p)
    cross_50_200 = (df["ema50"] > df["ema200"]) & (e50p <= e200p)
    pull20 = (df["low"] <= df["ema20"]) & (df["close"] > df["ema20"])
    df["ta_trigger"] = np.select([cross_20_50, cross_50_200, pull20],
                                 ["cross20/50", "cross50/200", "pullback20"], None)

    # ---- weekly EMA structure on completed weekly bars ----------------------
    wk = to_weekly(df[["date", "symbol", "open", "high", "low", "close", "volume", "turnover"]].copy())
    wg = wk.groupby("symbol", observed=True)
    for w in (20, 50, 200):
        wk[f"w{w}"] = wg["close"].transform(lambda s, w=w: s.ewm(span=w, adjust=False).mean())
    wk["n_weeks"] = wg.cumcount() + 1
    wg = wk.groupby("symbol", observed=True)
    L = lambda col, k: wg[col].shift(k)
    r20 = ((wk["w20"] > L("w20", 5)) & (L("w20", 5) > L("w20", 10)) & (L("w20", 10) > L("w20", 15))
           & (L("w20", 15) > L("w20", 20)) & (L("w20", 20) > L("w20", 25)))
    r50 = ((wk["w50"] > L("w50", 5)) & (L("w50", 5) > L("w50", 10)) & (L("w50", 10) > L("w50", 15))
           & (L("w50", 15) > L("w50", 20)) & (L("w50", 20) > L("w50", 25)))
    r200 = ((wk["w200"] > L("w200", 5)) & (L("w200", 5) > L("w200", 10)) & (L("w200", 10) > L("w200", 15))
            & (L("w20", 30) < L("w200", 30)))
    wk["ta_weekly_ok"] = (r20 & r50 & r200 & (wk["n_weeks"] >= 60)).fillna(False)
    wk["ta_weekly_prev"] = wg["ta_weekly_ok"].shift(1).fillna(False).astype(bool)

    # map to daily rows point-in-time: a week's structure is known at its LAST
    # session (Chartink's "weekly" on that day); earlier in the week use the
    # prior completed week.
    df["week"] = df["date"].dt.to_period("W-FRI")
    m = df.merge(wk[["symbol", "week", "week_end", "ta_weekly_ok", "ta_weekly_prev", "w20", "w50", "w200"]],
                 on=["symbol", "week"], how="left")
    is_last = (m["date"] == m["week_end"]).to_numpy()
    df["ta_weekly"] = np.where(is_last, m["ta_weekly_ok"].fillna(False), m["ta_weekly_prev"].fillna(False)).astype(bool)
    for w in (20, 50, 200):
        df[f"w{w}"] = m[f"w{w}"].to_numpy()
    df["ta_raw"] = df["ta_weekly"] & df["ta_trigger"].notna()
    return df


def build_turnaround(cfg) -> pd.DataFrame:
    """Live scan: today's EMA-turnaround signals over the liquid universe, with
    the same stop / R4 target / R:R fields as the checklist scanner so the
    paper book can size and track them identically."""
    df = pd.read_parquet(PANEL, columns=["date", "symbol", "sector", "open",
                                         "high", "low", "close", "volume", "turnover"])
    df = df[~df["symbol"].str.contains(ETF_RE, na=False)]
    df = compute(df)                 # full history: the weekly EMAs need it
    df = monthly_pivots(df)
    df = add_turnaround(df)
    last = df.groupby("symbol", observed=True).tail(1).copy()
    last = last[last["ta_raw"] & (last["close"] >= cfg.min_price)
                & (last["med_turnover"] >= cfg.min_turnover_cr * RS_CR)].copy()
    if last.empty:
        return last
    last = add_scores(last, cfg.min_rr)
    last["symbol"] = last["symbol"].str.replace(".NS", "", regex=False).str.replace(".BO", "", regex=False)
    return last.sort_values("score", ascending=False)


# --------------------------------------------------------------------------- #
# Variant: "earnings drift" - the one input with a measured edge (earnings_drift.py)
# --------------------------------------------------------------------------- #
def build_earnings(cfg, lookback: int = 2, min_react: float = 3.0) -> pd.DataFrame:
    """Live scan: stocks whose quarterly RESULTS reaction just completed.

    reaction = close(first session after the results date) / close(last session
    before it) - 1, a 2-session window. A signal is a reaction >= min_react%
    whose reaction session was within the last `lookback` sessions (so today's
    close is, or nearly is, the reaction close and the entry is the next open -
    exactly the setup earnings_drift.py measured: +1.6-1.8% vs the universe at
    20-40 sessions for reactions of +3% and above, stronger with volume).

    Seasonal by nature: outside the four results windows this list is empty.
    Needs nse_results_dates.json kept current (nse_results_dates.py --refresh,
    ~9 min for the cached names; run it after each results season)."""
    from weekly_momentum import load_results_map
    df = pd.read_parquet(PANEL, columns=["date", "symbol", "sector", "open",
                                         "high", "low", "close", "volume", "turnover"])
    df = df[~df["symbol"].str.contains(ETF_RE, na=False)]
    df = compute(df)
    df = monthly_pivots(df)
    rmap = load_results_map()
    last_day = df["date"].max().date()
    recent_cut = last_day - pd.Timedelta(days=lookback * 3 + 10)   # cheap pre-filter on dates
    by_sym = {s: g for s, g in df.groupby("symbol", observed=True)}
    rows = []
    for sym, dates in rmap.items():
        g = by_sym.get(f"{sym}.NS")
        if g is None:
            continue
        cand = [D for D in dates if D >= recent_cut]
        if not cand:
            continue
        d = g["date"].dt.date.to_numpy()
        cl, vol, va = g["close"].to_numpy(), g["volume"].to_numpy(), g["volavg50"].to_numpy()
        n = len(d)
        for D in cand:
            b = np.searchsorted(d, D, side="left") - 1             # last session BEFORE D
            a = np.searchsorted(d, D, side="right")                # first session AFTER D
            if b < 0 or a >= n or a - b > 6:
                continue                                           # not reacted yet / data gap
            # CALENDAR guard: a suspended stock's rows look adjacent even across a
            # months-long gap, which would book the whole gap move as the "reaction".
            if (d[a] - D).days > 7 or (D - d[b]).days > 7:
                continue
            days_since = (n - 1) - a                               # sessions since the reaction close
            if days_since > lookback - 1:
                continue
            react = (cl[a] / cl[b] - 1) * 100
            if react < min_react:
                continue
            vr = (vol[b + 1:a + 1].mean() / va[b]) if (np.isfinite(va[b]) and va[b] > 0) else np.nan
            row = g.iloc[-1].to_dict()                             # today's bar + indicators
            row.update(results_date=str(D), reaction_pct=round(float(react), 2),
                       vol_ratio_react=(round(float(vr), 2) if np.isfinite(vr) else None),
                       days_since=int(days_since),
                       band=("big UP" if react > 8 else "up"))
            rows.append(row)
    last = pd.DataFrame(rows)
    if last.empty:
        return last
    last = last[(last["close"] >= cfg.min_price) & (last["med_turnover"] >= cfg.min_turnover_cr * RS_CR)].copy()
    if last.empty:
        return last
    last = add_scores(last, cfg.min_rr)
    last["symbol"] = last["symbol"].str.replace(".NS", "", regex=False).str.replace(".BO", "", regex=False)
    return last.sort_values("reaction_pct", ascending=False)


class Cfg:
    def __init__(self, top=25, min_price=30.0, min_turnover_cr=2.0, min_rr=2.0, window_days=520):
        self.top, self.min_price, self.min_turnover_cr = top, min_price, min_turnover_cr
        self.min_rr, self.window_days = min_rr, window_days


def main():
    p = argparse.ArgumentParser(description="Daily technical-setup scorecard over the NSE universe.")
    p.add_argument("--top", type=int, default=25)
    p.add_argument("--min-price", type=float, default=30.0)
    p.add_argument("--min-turnover-cr", type=float, default=2.0)
    p.add_argument("--min-rr", type=float, default=2.0)
    a = p.parse_args()
    cfg = Cfg(a.top, a.min_price, a.min_turnover_cr, a.min_rr)
    res = build(cfg)
    asof = pd.read_parquet(PANEL, columns=["date"])["date"].max().date()
    print(f"As of {asof}  |  {len(res)} stocks scored, showing top {cfg.top}\n")
    cols = ["symbol", "score", "close", "align_bits", "rsi", "vol_ratio",
            "vcp_ok", "breakout_ok", "target_near", "target_r4", "stop", "rr",
            "reward_near_pct", "room_to_r4_pct"]
    show = res.head(cfg.top)[cols].copy()
    for c in ("close", "rsi", "vol_ratio", "target_near", "target_r4", "stop", "rr",
              "reward_near_pct", "room_to_r4_pct"):
        show[c] = show[c].round(2)
    print(show.to_string(index=False))
    print("\nNOT investment advice — a mechanical scorecard. Backtest before trusting.")


if __name__ == "__main__":
    main()
