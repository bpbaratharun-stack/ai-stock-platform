#!/usr/bin/env python3
"""
weekly_momentum.py — weekly momentum screener: price action rising, on a
volume surge, confirmed by trend / relative-strength / breakout factors.

Reads data/panel.parquet (daily NSE OHLCV from ingest_bhavcopy.py), resamples
to weekly bars, and ranks stocks that are going up *for reasons that tend to
persist* rather than one-week noise.

    ./venv/Scripts/python.exe weekly_momentum.py
    ./venv/Scripts/python.exe weekly_momentum.py --top 50 --min-turnover 10
    ./venv/Scripts/python.exe weekly_momentum.py --complete-weeks-only
    ./venv/Scripts/python.exe weekly_momentum.py --relaxed        # gates as score only

THE LOGIC
---------
Momentum works when a real move is backed by participation and trend, so the
screen is layered rather than a single sort.

Hard gates (a candidate must pass ALL):
  1. Weekly return > 0                     price actually rose this week
  2. Volume surge >= 1.5x                  avg DAILY volume this week vs its
                                           own 10-week median (per-day, so
                                           holiday-short weeks compare fairly)
  3. Close strength >= 0.6                 closed in the top 40% of the weekly
                                           range — buyers held into the close
                                           instead of the rally fading
  4. Close > 10-week MA and 10w MA > 30w   short-term trend above long-term:
                                           an uptrend, not a bounce in a downtrend
  5. 4-week and 12-week return > 0         the week fits an existing advance
  6. Within 25% of the 52-week high        breakout character, not bottom-fishing
  7. Relative strength > 0                 4-week return beats the market's
                                           median 4-week return (peer-relative)

Sanity exclusions (screen out the untradeable / already-blown-off):
  - weekly return > 40%      circuit-locked or news-spike; you can't get filled
  - 4-week return > 100%     parabolic, late-stage risk
  - price < Rs 20            penny-stock noise
  - illiquid                 median daily turnover below --min-turnover (Rs cr)
  - ETFs / index funds       different animal; excluded by symbol pattern

Composite score (0-100) ranks survivors by percentile-blending:
    weekly return 20% | volume surge 20% | relative strength 20%
    12-week momentum 15% | close strength 15% | proximity to 52w high 10%

Ranking is percentile-based (not raw z-scores) so one extreme outlier cannot
dominate the blend.

NOT INVESTMENT ADVICE. This is a mechanical screen. Momentum reverses, and a
volume surge cuts both ways — verify news and liquidity before acting.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
PANEL = HERE / "data" / "panel.parquet"

# ETFs, index funds and money-market instruments: they surge on flows, not on
# company momentum, so they pollute a stock screen.
ETF_RE = re.compile(
    r"(?:BEES|ETF|IETF|LIQUID|GOLD|SILVER|NIFTY|SENSEX|BSE500|MOM100|MOMENTUM|"
    r"GILT|SDL|GSEC|BOND|CPSE|PSUBNK|MAFANG|HNGSNG|MID150|SML250|ALPHA|LOWVOL|"
    r"VALUE|QUAL|EQUAL|TOP10|TOP20|DIVOPP|CONSUM|INFRA|PHARMABEES)",
    re.I,
)


# --------------------------------------------------------------------------- #
# Weekly bars
# --------------------------------------------------------------------------- #
def to_weekly(df: pd.DataFrame) -> pd.DataFrame:
    """Daily OHLCV -> weekly bars (week ending Friday).

    W-FRI buckets Sat..Fri; with no weekend trading a Mon-Fri session block maps
    cleanly onto the week ending that Friday. `days` records how many sessions
    actually landed in the bucket, so a truncated latest week is detectable.
    """
    df = df.sort_values(["symbol", "date"])
    df["week"] = df["date"].dt.to_period("W-FRI")

    wk = df.groupby(["symbol", "week"], observed=True).agg(
        week_end=("date", "max"),
        days=("date", "size"),
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
        turnover=("turnover", "sum"),
    ).reset_index()

    return wk.sort_values(["symbol", "week"])


# --------------------------------------------------------------------------- #
# Features
# --------------------------------------------------------------------------- #
def add_features(wk: pd.DataFrame) -> pd.DataFrame:
    g = wk.groupby("symbol", observed=True)

    wk["ret_1w"] = g["close"].pct_change() * 100
    wk["ret_4w"] = g["close"].pct_change(4) * 100
    wk["ret_12w"] = g["close"].pct_change(12) * 100
    wk["ret_26w"] = g["close"].pct_change(26) * 100

    # Volume surge vs the stock's OWN recent norm.
    #
    # Compared PER TRADING DAY, not per week: Indian weeks are frequently
    # holiday-shortened (and the newest week may be mid-flight), so raw weekly
    # totals would understate a 4-day week's surge by ~20% purely from the
    # missing session. Median, not mean, so one prior spike doesn't raise the
    # bar and mask a genuine new surge.
    wk["adv"] = wk["volume"] / wk["days"]          # average daily volume in week
    med_adv_10 = g["adv"].transform(lambda s: s.shift(1).rolling(10, min_periods=5).median())
    wk["vol_surge"] = wk["adv"] / med_adv_10.replace(0, np.nan)

    # Accumulation: recent volume base rising vs the longer base (also per-day).
    avg_adv_4 = g["adv"].transform(lambda s: s.rolling(4, min_periods=2).mean())
    avg_adv_10 = g["adv"].transform(lambda s: s.rolling(10, min_periods=5).mean())
    wk["vol_trend"] = avg_adv_4 / avg_adv_10.replace(0, np.nan)

    # Where in the weekly range did it close? 1.0 = at the high, 0 = at the low.
    rng = (wk["high"] - wk["low"]).replace(0, np.nan)
    wk["close_strength"] = ((wk["close"] - wk["low"]) / rng).clip(0, 1)

    # Trend structure (weekly MAs ~ the 50d / 150d equivalents).
    wk["ma_10w"] = g["close"].transform(lambda s: s.rolling(10, min_periods=10).mean())
    wk["ma_30w"] = g["close"].transform(lambda s: s.rolling(30, min_periods=30).mean())

    # 52-week context.
    wk["high_52w"] = g["high"].transform(lambda s: s.rolling(52, min_periods=30).max())
    wk["low_52w"] = g["low"].transform(lambda s: s.rolling(52, min_periods=30).min())
    wk["pct_from_52w_high"] = (wk["close"] / wk["high_52w"] - 1) * 100
    wk["pct_above_52w_low"] = (wk["close"] / wk["low_52w"] - 1) * 100

    # Liquidity: typical DAILY turnover in Rs crore (how traders size positions).
    wk["adtv_cr"] = (wk["turnover"] / wk["days"]) / 1e7
    wk["med_turnover_cr"] = g["adtv_cr"].transform(
        lambda s: s.rolling(10, min_periods=5).median()
    )

    wk["n_weeks"] = g.cumcount() + 1
    return wk


def add_relative_strength(snap: pd.DataFrame) -> pd.DataFrame:
    """Excess 4-week return vs the median liquid stock that same week.

    Peer-relative, so a broad market rally doesn't make everything look strong.
    """
    liquid = snap[snap["med_turnover_cr"] >= 1.0]
    mkt_4w = liquid["ret_4w"].median()
    mkt_12w = liquid["ret_12w"].median()
    snap = snap.copy()
    snap["mkt_ret_4w"] = mkt_4w
    snap["rs_4w"] = snap["ret_4w"] - mkt_4w
    snap["rs_12w"] = snap["ret_12w"] - mkt_12w
    return snap


# --------------------------------------------------------------------------- #
# Screen
# --------------------------------------------------------------------------- #
def apply_gates(s: pd.DataFrame, cfg) -> pd.DataFrame:
    """Attach one boolean column per rule, plus `passes_all`."""
    s = s.copy()
    s["g_price_up"] = s["ret_1w"] > 0
    s["g_vol_surge"] = s["vol_surge"] >= cfg.min_vol_surge
    s["g_close_strong"] = s["close_strength"] >= cfg.min_close_strength
    s["g_uptrend"] = (s["close"] > s["ma_10w"]) & (s["ma_10w"] > s["ma_30w"])
    s["g_momentum"] = (s["ret_4w"] > 0) & (s["ret_12w"] > 0)
    s["g_near_high"] = s["pct_from_52w_high"] >= -cfg.max_below_high
    s["g_rel_strength"] = s["rs_4w"] > 0

    # sanity exclusions
    s["g_not_spike"] = s["ret_1w"] <= cfg.max_week_gain
    s["g_not_parabolic"] = s["ret_4w"] <= cfg.max_4w_gain

    gate_cols = [c for c in s.columns if c.startswith("g_")]
    s["gates_passed"] = s[gate_cols].sum(axis=1)
    s["passes_all"] = s[gate_cols].all(axis=1)
    return s


def score(s: pd.DataFrame) -> pd.DataFrame:
    """Percentile-blend composite (0-100). Rank-based so outliers can't dominate."""
    s = s.copy()

    def pct(col, ascending=True):
        return s[col].rank(pct=True, ascending=ascending) * 100

    s["score"] = (
        0.20 * pct("ret_1w")
        + 0.20 * pct("vol_surge")
        + 0.20 * pct("rs_4w")
        + 0.15 * pct("ret_12w")
        + 0.15 * pct("close_strength")
        + 0.10 * pct("pct_from_52w_high")   # closer to high = higher percentile
    ).round(1)
    return s


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #
def run(cfg):
    if not PANEL.exists():
        sys.exit(f"{PANEL} not found — run ingest_bhavcopy.py first.")

    print(f"Loading {PANEL.name} ...")
    df = pd.read_parquet(PANEL, columns=["date", "symbol", "open", "high",
                                         "low", "close", "volume", "turnover"])

    if not cfg.include_etfs:
        before = df["symbol"].nunique()
        df = df[~df["symbol"].str.contains(ETF_RE, na=False)]
        print(f"  excluded {before - df['symbol'].nunique()} ETF/index symbols")

    print(f"  {len(df):,} daily rows, {df['symbol'].nunique():,} symbols, "
          f"through {df['date'].max().date()}")

    wk = to_weekly(df)
    wk = add_features(wk)

    if cfg.backtest:
        backtest(cfg, wk)
        return

    # --- pick the week to screen -------------------------------------------
    weeks = wk["week"].drop_duplicates().sort_values()
    target = weeks.iloc[-1]
    snap = wk[wk["week"] == target]
    days = int(snap["days"].max())

    if days < 5 and cfg.complete_weeks_only:
        target = weeks.iloc[-2]
        snap = wk[wk["week"] == target]
        days = int(snap["days"].max())
        print(f"  (skipping partial week as requested)")

    partial = days < 5
    wk_end = snap["week_end"].max().date()
    print(f"\nScreening week {target}  (ends {wk_end}, {days} trading days"
          f"{'  ** PARTIAL **' if partial else ''})")
    if partial:
        print("  WARNING: this week is incomplete - the last session(s) are not in")
        print("  the data yet. Volume surge is per-trading-day so it compares fairly,")
        print("  but the close / high / low are NOT the final weekly values: a stock")
        print("  can still give the move back on the missing day(s). Re-run once the")
        print("  week closes, or pass --complete-weeks-only.")

    # --- universe filters ---------------------------------------------------
    n0 = len(snap)
    snap = snap[snap["n_weeks"] >= cfg.min_history]
    snap = snap[snap["close"] >= cfg.min_price]
    snap = snap[snap["med_turnover_cr"] >= cfg.min_turnover]
    snap = snap.dropna(subset=["ret_12w", "ma_30w", "vol_surge", "high_52w"])
    print(f"\nUniverse: {n0:,} -> {len(snap):,} after history/price/liquidity filters")
    print(f"  (price >= Rs {cfg.min_price}, median daily turnover >= Rs {cfg.min_turnover} cr,"
          f" >= {cfg.min_history} weeks history)")

    if snap.empty:
        sys.exit("Nothing left after filters - loosen --min-turnover / --min-price.")

    snap = add_relative_strength(snap)
    snap = apply_gates(snap, cfg)
    snap = score(snap)

    print(f"  market median 4w return this week: {snap['mkt_ret_4w'].iloc[0]:+.2f}%")

    # gate funnel — shows which rule is binding
    print("\nGate funnel (candidates passing each rule):")
    labels = {
        "g_price_up": "price up this week",
        "g_vol_surge": f"volume surge >= {cfg.min_vol_surge}x",
        "g_close_strong": f"closed in top {(1-cfg.min_close_strength)*100:.0f}% of range",
        "g_uptrend": "close > 10w MA > 30w MA",
        "g_momentum": "4w & 12w returns > 0",
        "g_near_high": f"within {cfg.max_below_high}% of 52w high",
        "g_rel_strength": "beats market 4w return",
        "g_not_spike": f"weekly gain <= {cfg.max_week_gain}%",
        "g_not_parabolic": f"4w gain <= {cfg.max_4w_gain}%",
    }
    for c, lab in labels.items():
        print(f"  {snap[c].sum():>5} / {len(snap):<5}  {lab}")

    hits = snap[snap["passes_all"]] if not cfg.relaxed else snap
    hits = hits.sort_values("score", ascending=False)
    qualified = len(hits)
    if cfg.top:
        hits = hits.head(cfg.top)

    label = "RELAXED (ranked, gates advisory)" if cfg.relaxed else "PASSED ALL GATES"
    trunc = f", showing top {len(hits)}" if len(hits) < qualified else ""
    print(f"\n{label}: {qualified} stocks{trunc}")

    # --- export -------------------------------------------------------------
    out = pd.DataFrame({
        "Symbol": hits["symbol"].str.replace(".NS", "", regex=False),
        "Score": hits["score"],
        "Close": hits["close"].round(2),
        "Week Return %": hits["ret_1w"].round(2),
        "Vol Surge (x)": hits["vol_surge"].round(2),
        "Close Strength": hits["close_strength"].round(2),
        "4W Return %": hits["ret_4w"].round(2),
        "12W Return %": hits["ret_12w"].round(2),
        "RS vs Mkt 4W %": hits["rs_4w"].round(2),
        "% From 52W High": hits["pct_from_52w_high"].round(2),
        "Above 52W Low %": hits["pct_above_52w_low"].round(1),
        "Vol Trend (4w/10w)": hits["vol_trend"].round(2),
        "ADTV (Rs cr/day)": hits["med_turnover_cr"].round(1),
        "Gates Passed": hits["gates_passed"].astype(int).astype(str) + "/9",
        "Week Ending": str(wk_end),
        "Days In Week": hits["days"].astype(int),
    })

    cfg.outdir.mkdir(parents=True, exist_ok=True)
    tag = "partial" if partial else "full"
    path = cfg.outdir / f"weekly_momentum_{wk_end}_{tag}.csv"
    out.to_csv(path, index=False)
    print(f"-> {path}")

    if len(out):
        show = out.head(min(20, len(out)))
        print()
        print(show.drop(columns=["Week Ending", "Above 52W Low %",
                                 "Vol Trend (4w/10w)"]).to_string(index=False))
    return out


def backtest(cfg, wk: pd.DataFrame):
    """Does the screen actually beat the market? Re-runs the gates on every
    historical week and compares picks' forward 4-week return against the
    market median that same week.

    Honest by construction:
      - ENTRY at next week's OPEN (open[t+1]), not the signal-week close we screen
        on — you cannot get filled at a price you are still computing from.
      - MEDIAN-to-MEDIAN: the screen's median pick vs the universe's median that
        same week. Comparing a mean (right-skewed) to a median flatters the screen
        for free; matching the statistic removes that artefact.
    """
    g = wk.groupby("symbol", observed=True)
    wk = wk.copy()
    # 4-week hold, entered at next week's open, exited at the +4w close.
    wk["fwd_4w"] = (g["close"].shift(-4) / g["open"].shift(-1) - 1) * 100

    u = wk[(wk["n_weeks"] >= cfg.min_history)
           & (wk["close"] >= cfg.min_price)
           & (wk["med_turnover_cr"] >= cfg.min_turnover)].dropna(
        subset=["ret_12w", "ma_30w", "vol_surge", "high_52w", "fwd_4w"])

    rows = []
    for w, snap in u.groupby("week", observed=True):
        if len(snap) < 100:
            continue
        s = apply_gates(add_relative_strength(snap), cfg)
        sel = s[s["passes_all"]]
        if len(sel) < 3:
            continue
        rows.append((str(w), len(sel), sel["fwd_4w"].median(),
                     sel["fwd_4w"].mean(), s["fwd_4w"].median()))

    if not rows:
        print("Not enough history to backtest.")
        return
    r = pd.DataFrame(rows, columns=["week", "n", "screen_med", "screen_mean", "market_med"])
    r["excess"] = r["screen_med"] - r["market_med"]        # median-to-median

    print("\n" + "=" * 62)
    print("BACKTEST - fwd 4w return, next-open entry, median-vs-median")
    print("=" * 62)
    print(f"  weeks tested            : {len(r)}  (avg {r['n'].mean():.0f} picks/week)")
    print(f"  screen MEDIAN pick      : {r['screen_med'].mean():+.2f}%   <-- headline")
    print(f"  market MEDIAN           : {r['market_med'].mean():+.2f}%")
    print(f"  average EDGE (med-med)  : {r['excess'].mean():+.2f}%")
    print(f"  weeks beating market    : {(r['excess'] > 0).mean() * 100:.0f}%")
    print(f"  worst / best week edge  : {r['excess'].min():+.2f}% / {r['excess'].max():+.2f}%")
    print(f"  (screen MEAN pick, for reference: {r['screen_mean'].mean():+.2f}% — "
          f"skew gap {r['screen_mean'].mean() - r['screen_med'].mean():+.2f}%)")
    print("\n  Median-to-median at a tradeable next-open fill is the fair test. If the")
    print("  edge survives here it is the most defensible result the platform has; if")
    print("  it evaporated vs the earlier mean-vs-median number, that gap WAS the")
    print("  artefact. Still before costs; momentum crashes hard at reversals.")


def main():
    p = argparse.ArgumentParser(description="Weekly momentum + volume surge screener (NSE).")
    p.add_argument("--top", type=int, default=40, help="Max rows to export (default 40; 0 = all).")
    p.add_argument("--min-turnover", type=float, default=5.0,
                   help="Min median DAILY turnover in Rs crore (default 5).")
    p.add_argument("--min-price", type=float, default=20.0, help="Min close price (default 20).")
    p.add_argument("--min-history", type=int, default=40, help="Min weeks of history (default 40).")
    p.add_argument("--min-vol-surge", type=float, default=1.5, help="Volume vs 10w median (default 1.5).")
    p.add_argument("--min-close-strength", type=float, default=0.6,
                   help="Close position in weekly range, 0-1 (default 0.6).")
    p.add_argument("--max-below-high", type=float, default=25.0,
                   help="Max %% below 52w high (default 25).")
    p.add_argument("--max-week-gain", type=float, default=40.0,
                   help="Reject weekly gains above this %% as untradeable spikes (default 40).")
    p.add_argument("--max-4w-gain", type=float, default=100.0,
                   help="Reject 4-week gains above this %% as parabolic (default 100).")
    p.add_argument("--complete-weeks-only", action="store_true",
                   help="Skip the latest week if it has fewer than 5 trading days.")
    p.add_argument("--relaxed", action="store_true",
                   help="Rank everything by score instead of requiring all gates.")
    p.add_argument("--include-etfs", action="store_true", help="Do not exclude ETFs/index funds.")
    p.add_argument("--backtest", action="store_true",
                   help="Validate the gates on history (forward 4w return vs market) and exit.")
    p.add_argument("--outdir", type=Path, default=HERE / "data", help="Output directory.")
    cfg = p.parse_args()
    if cfg.top == 0:
        cfg.top = None
    run(cfg)


if __name__ == "__main__":
    main()
