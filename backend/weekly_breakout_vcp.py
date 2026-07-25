#!/usr/bin/env python3
"""
weekly_breakout_vcp.py — Weinstein Stage-2 / VCP weekly-breakout screen, with a
closed-trade evaluation harness (rule return, MFE/MAE) benchmarked against the
equal-weight forward return of the gate-passing universe.

This is a PRECISELY-DEFINED HYPOTHESIS, not a promised edge. Judge it on
`avg_rule_pct_closed` and the MFE/MAE distribution vs the universe benchmark —
NOT on win rate. Breakout expectancy concentrates in a minority of trades; the
median trade is expected to be a small loser even if the strategy is fine.

    ./venv/Scripts/python.exe weekly_breakout_vcp.py            # this week's signals
    ./venv/Scripts/python.exe weekly_breakout_vcp.py --backtest # score it on history

THE RULES  (all on weekly bars resampled from daily bhavcopy)
------------------------------------------------------------
Universe gates (a stock must pass to be a candidate OR count in the benchmark):
  - median weekly traded value over last 12 weeks >= Rs 2 cr
  - price >= Rs 30
  - listed >= 60 weeks
  - close > 30-week SMA, and the 30-week SMA is higher than it was 4 weeks ago
    (Weinstein Stage-2: uptrend, not a dead-cat pop)

Base (window = the prior `--base-len` weeks, default 40, excluding this week):
  - base high  = highest weekly high in the window
  - base depth = (base_high - lowest low)/base_high <= 35%   (not a broken stock)
  - contraction: mean weekly true range of the LAST 4 weeks of the base
    < mean true range of the FIRST 4 weeks of the base   (VCP, one inequality)
  - flat-topped, not a V: >= 2 weeks in the base had a high within 25% of the
    base high  [interpretation of "price actually spent time near the ceiling";
    tune with --near-high-frac / --min-ceiling-touches]

Trigger (on the week's Friday close):
  - weekly close > base high
  - weekly volume >= 1.5x its trailing 20-week average
  - close in the top 40% of the week's range   (the level HELD into the close)
  - close <= 1.25x base high                    (not already blown off the pivot)

Evaluation (for scoring the signal, NOT trade advice):
  - entry : next week's open  (i.e. the Monday after the Friday trigger)
  - exit  : earlier of (a) a later weekly close < the entry week's low
            ("failed breakout" stop), or (b) 12 weeks elapsed
  - benchmark: equal-weight ~12-week forward return (next-open to +12w close) of
    EVERY universe-gate-passing stock that same week

NOT INVESTMENT ADVICE.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from weekly_momentum import ETF_RE, to_weekly

HERE = Path(__file__).parent
PANEL = HERE / "data" / "panel.parquet"

RS_CR = 1e7            # 1 crore in rupees
HORIZON_W = 12         # holding horizon in weeks


# --------------------------------------------------------------------------- #
# Vectorised weekly features shared by the screen and the benchmark
# --------------------------------------------------------------------------- #
def add_features(wk: pd.DataFrame) -> pd.DataFrame:
    g = wk.groupby("symbol", observed=True)

    wk["n_weeks"] = g.cumcount() + 1

    # Weekly true range (Wilder), on weekly bars.
    prev_close = g["close"].shift(1)
    wk["tr"] = np.maximum.reduce([
        (wk["high"] - wk["low"]).to_numpy(),
        (wk["high"] - prev_close).abs().to_numpy(),
        (wk["low"] - prev_close).abs().to_numpy(),
    ])

    # Price-normalised true range (ATR%). The VCP contraction test must be on a
    # unitless basis: raw TR rises with price level, so an upward-drifting base
    # (the textbook Weinstein base) would be spuriously flagged as EXPANDING
    # volatility and rejected. tr/close removes that bias.
    wk["trn"] = wk["tr"] / wk["close"].replace(0, np.nan)

    rng = (wk["high"] - wk["low"]).replace(0, np.nan)
    wk["close_strength"] = ((wk["close"] - wk["low"]) / rng).clip(0, 1)

    wk["sma30"] = g["close"].transform(lambda s: s.rolling(30, min_periods=30).mean())
    wk["sma30_prev4"] = g["sma30"].shift(4)

    wk["med_turnover"] = g["turnover"].transform(
        lambda s: s.rolling(12, min_periods=8).median())

    # trailing 20-week avg volume, EXCLUDING the current (possibly surging) week
    wk["volavg20"] = g["volume"].transform(
        lambda s: s.shift(1).rolling(20, min_periods=10).mean())

    # ~12-week forward return, entering next week's open (matches the eval entry)
    nxt_open = g["open"].shift(-1)
    fwd_close = g["close"].shift(-HORIZON_W)
    wk["fwd_hold"] = (fwd_close / nxt_open - 1) * 100

    return wk


def universe_mask(wk: pd.DataFrame, cfg) -> pd.Series:
    m = (
        (wk["med_turnover"] >= cfg.min_turnover_cr * RS_CR)
        & (wk["close"] >= cfg.min_price)
        & (wk["n_weeks"] >= cfg.min_weeks)
        & (wk["close"] > wk["sma30"])
        & (wk["sma30"] > wk["sma30_prev4"])
    )
    return m.fillna(False)


# --------------------------------------------------------------------------- #
# Per-symbol base detection, trigger, and trade simulation
# --------------------------------------------------------------------------- #
def scan_symbol(arr, cfg):
    """arr: dict of numpy columns for ONE symbol, ordered oldest->newest.
    Returns (signal_rows, trade_rows). A signal is a triggered breakout; a trade
    is that signal simulated forward (only where forward data exists)."""
    wk = arr["week"]
    hi, lo, cl, op = arr["high"], arr["low"], arr["close"], arr["open"]
    vol, tr, cs = arr["volume"], arr["tr"], arr["close_strength"]
    volavg20, upass = arr["volavg20"], arr["universe_pass"]
    n = len(cl)
    L = cfg.base_len
    signals, trades = [], []

    for t in range(n):
        if not upass[t] or t < L:
            continue

        win_hi = hi[t - L:t]
        win_lo = lo[t - L:t]
        bh = win_hi.max()
        bl = win_lo.min()
        if not np.isfinite(bh) or bh <= 0:
            continue

        # base shape
        depth = (bh - bl) / bh
        if depth > cfg.max_base_depth:
            continue
        trn = arr["trn"]
        tr_last4 = trn[t - 4:t].mean()                       # ATR% basis
        tr_first4 = trn[t - L:t - L + 4].mean()
        if not (tr_last4 < tr_first4):                       # VCP contraction
            continue
        touches = int((win_hi >= cfg.near_high_frac * bh).sum())
        if touches < cfg.min_ceiling_touches:                # flat top, not a V
            continue

        # trigger (on this week's close)
        va = volavg20[t]
        if not (
            cl[t] > bh
            and np.isfinite(va) and va > 0 and vol[t] >= cfg.min_vol_mult * va
            and np.isfinite(cs[t]) and cs[t] >= cfg.min_close_strength
            and cl[t] <= cfg.max_ext_mult * bh
        ):
            continue

        row = {
            "symbol": arr["symbol"], "week": str(wk[t]),
            "close": round(float(cl[t]), 2), "base_high": round(float(bh), 2),
            "base_depth_pct": round(float(depth) * 100, 1),
            "ext_above_pivot_pct": round((cl[t] / bh - 1) * 100, 1),
            "vol_mult": round(float(vol[t] / va), 2),
            "close_strength": round(float(cs[t]), 2),
            "ceiling_touches": touches,
            "tr_contraction": round(float(tr_last4 / tr_first4), 2),
            "adtv_cr": round(float(arr["med_turnover"][t] / RS_CR), 2),
        }
        signals.append(row)

        # ---- simulate forward (entry = next week's open) -------------------
        if t + 1 >= n:
            continue                       # fresh signal, no entry bar yet
        entry = op[t + 1]
        entry_low = lo[t + 1]
        if not np.isfinite(entry) or entry <= 0:
            continue

        last_possible = min(t + HORIZON_W, n - 1)
        exit_idx, stopped = None, False
        for k in range(t + 2, last_possible + 1):
            if cl[k] < entry_low:
                exit_idx, stopped = k, True
                break
        if exit_idx is None:
            reached_horizon = (t + HORIZON_W) <= (n - 1)
            exit_idx = t + HORIZON_W if reached_horizon else n - 1
            closed = reached_horizon
        else:
            closed = True

        held_hi = hi[t + 1:exit_idx + 1]
        held_lo = lo[t + 1:exit_idx + 1]
        rule_pct = (cl[exit_idx] / entry - 1) * 100
        mfe = (held_hi.max() / entry - 1) * 100
        mae = (held_lo.min() / entry - 1) * 100
        hold12 = ((cl[t + HORIZON_W] / entry - 1) * 100
                  if (t + HORIZON_W) <= (n - 1) else np.nan)

        trades.append({
            "symbol": arr["symbol"], "week": str(wk[t]),
            "closed": closed, "stopped": stopped,
            "weeks_held": int(exit_idx - t),
            "rule_pct": round(float(rule_pct), 2),
            "mfe_pct": round(float(mfe), 2),
            "mae_pct": round(float(mae), 2),
            "hold12_pct": round(float(hold12), 2) if np.isfinite(hold12) else np.nan,
        })

    return signals, trades


def scan_all(wk: pd.DataFrame, cfg):
    cols = ["high", "low", "close", "open", "volume", "tr", "trn", "close_strength",
            "volavg20", "universe_pass", "med_turnover"]
    all_sig, all_trd = [], []
    for sym, grp in wk.groupby("symbol", observed=True):
        arr = {c: grp[c].to_numpy() for c in cols}
        arr["week"] = grp["week"].to_numpy()
        arr["symbol"] = sym.replace(".NS", "")
        s, t = scan_symbol(arr, cfg)
        all_sig.extend(s)
        all_trd.extend(t)
    return pd.DataFrame(all_sig), pd.DataFrame(all_trd)


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #
def print_backtest(trades: pd.DataFrame, benchmark_by_week: pd.Series):
    closed = trades[trades["closed"]].copy()
    print("\n" + "=" * 66)
    print("BACKTEST — VCP/Stage-2 weekly breakout, closed-trade summary")
    print("=" * 66)
    n_weeks = closed["week"].nunique()
    print(f"  signals (all)          : {len(trades)}")
    print(f"  closed trades          : {len(closed)}   "
          f"(open/unresolved: {len(trades) - len(closed)})")
    print(f"  distinct signal weeks  : {n_weeks}   <-- the real sample size")
    if closed.empty:
        print("  no closed trades to evaluate.")
        return

    # WEEK-CLUSTERED: average within each week first, then across weeks. Trades
    # in the same week share market conditions, so the effective N is the number
    # of weeks, not the number of trades — the trade count flatters confidence.
    wk_rule = closed.groupby("week")["rule_pct"].mean()
    rp = closed["rule_pct"]
    print(f"\n  avg_rule_pct (by week) : {wk_rule.mean():+.2f}%   <-- headline (clustered)")
    print(f"  avg_rule_pct (by trade): {rp.mean():+.2f}%   (overstates certainty)")
    print(f"  median trade rule_pct  : {rp.median():+.2f}%   (expected small loss)")
    print(f"  win rate (trades)      : {(rp > 0).mean() * 100:.0f}%   "
          f"(low is normal for breakouts)")
    print(f"  stopped out            : {closed['stopped'].mean() * 100:.0f}% of closed")
    print(f"  avg weeks held         : {closed['weeks_held'].mean():.1f}")
    print(f"  best / worst rule_pct  : {rp.max():+.1f}% / {rp.min():+.1f}%")

    print(f"\n  MFE (max favourable)   : mean {closed['mfe_pct'].mean():+.1f}%  "
          f"median {closed['mfe_pct'].median():+.1f}%  "
          f"p90 {closed['mfe_pct'].quantile(.9):+.1f}%")
    print(f"  MAE (max adverse)      : mean {closed['mae_pct'].mean():+.1f}%  "
          f"median {closed['mae_pct'].median():+.1f}%  "
          f"p10 {closed['mae_pct'].quantile(.1):+.1f}%")

    # benchmark: equal-weight 12w forward return of universe-passers that week,
    # ALSO week-clustered so the edge test carries the same honest sample size.
    bh = closed.dropna(subset=["hold12_pct"]).copy()
    bh["bench"] = bh["week"].map(benchmark_by_week)
    bh = bh.dropna(subset=["bench"])
    if not bh.empty:
        bh["excess"] = bh["hold12_pct"] - bh["bench"]
        wk = bh.groupby("week").agg(sig=("hold12_pct", "mean"),
                                    bench=("bench", "mean"),
                                    exc=("excess", "mean"))
        print(f"\n  --- vs universe benchmark (12w buy-hold, week-clustered) ---")
        print(f"  signal 12w hold return : {wk['sig'].mean():+.2f}%")
        print(f"  universe 12w benchmark : {wk['bench'].mean():+.2f}%")
        print(f"  average EDGE           : {wk['exc'].mean():+.2f}%   "
              f"over {len(wk)} weeks")
        print(f"  weeks beating bench    : {(wk['exc'] > 0).mean() * 100:.0f}%")

    print("\n  Read this soberly: the rule has a stop (caps losers, caps horizon);")
    print("  the benchmark is 12w buy-hold, so the EDGE line is the fair test. A")
    print("  positive avg_rule_pct with a bad win rate is the expected shape IF it")
    print("  works at all. Numbers before conviction.")
    print("\n  Survivorship: panel.parquet holds currently-listed NSE names, so both")
    print("  the signals and the benchmark are computed on survivors. The EDGE is a")
    print("  difference of two equally-biased legs, so it is roughly unbiased — but")
    print("  the absolute return levels are optimistic (delisted losers are absent).")


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
        df = df[~df["symbol"].str.contains(ETF_RE, na=False)]

    wk = to_weekly(df)
    wk = add_features(wk)
    wk["universe_pass"] = universe_mask(wk, cfg)

    weeks = wk["week"].drop_duplicates().sort_values()
    target = weeks.iloc[-1]
    tsnap = wk[wk["week"] == target]
    days = int(tsnap["days"].max())
    if days < 5 and cfg.complete_weeks_only and len(weeks) > 1:
        target = weeks.iloc[-2]
        tsnap = wk[wk["week"] == target]
        days = int(tsnap["days"].max())
    partial = days < 5
    wk_end = tsnap["week_end"].max().date()

    print(f"  {df['symbol'].nunique():,} symbols, weekly through {wk_end} "
          f"({days} trading days{'  ** PARTIAL **' if partial else ''})")
    print(f"  universe (this week)   : {int(tsnap['universe_pass'].sum())} stocks "
          f"pass the gates")
    if partial:
        print("  WARNING: latest week is incomplete — its close/high/low are not the")
        print("  real weekly values, so the Friday trigger is provisional. Re-run at")
        print("  week close, or pass --complete-weeks-only.")

    signals, trades = scan_all(wk, cfg)

    # ---- this week's fresh signals ----------------------------------------
    cfg.outdir.mkdir(parents=True, exist_ok=True)
    this_week = (signals[signals["week"] == str(target)].copy()
                 if not signals.empty else pd.DataFrame())
    tag = "partial" if partial else "full"
    out_path = cfg.outdir / f"breakout_vcp_{wk_end}_{tag}.csv"
    if not this_week.empty:
        this_week = this_week.sort_values("adtv_cr", ascending=False)
        this_week.insert(2, "week_ending", str(wk_end))
        this_week.to_csv(out_path, index=False)
    else:
        pd.DataFrame(columns=["symbol", "week", "close"]).to_csv(out_path, index=False)

    print(f"\nThis week ({wk_end}): {len(this_week)} VCP/Stage-2 breakout signals")
    print(f"-> {out_path}")
    if not this_week.empty:
        show = this_week[["symbol", "close", "base_high", "ext_above_pivot_pct",
                          "base_depth_pct", "vol_mult", "close_strength",
                          "ceiling_touches", "tr_contraction", "adtv_cr"]]
        print(show.to_string(index=False))

    # ---- backtest ----------------------------------------------------------
    if cfg.backtest:
        if trades.empty:
            print("\nNo simulated trades in history — loosen the gates.")
            return
        bench = (wk[wk["universe_pass"]]
                 .assign(week=lambda d: d["week"].astype(str))
                 .groupby("week")["fwd_hold"].mean())
        print_backtest(trades, bench)
        tr_path = cfg.outdir / "breakout_vcp_trades.csv"
        trades.sort_values("week").to_csv(tr_path, index=False)
        print(f"\n  all {len(trades)} simulated trades -> {tr_path}")


def main():
    p = argparse.ArgumentParser(description="VCP / Weinstein Stage-2 weekly breakout screen + backtest.")
    p.add_argument("--backtest", action="store_true", help="Evaluate the rule on all history and exit-summarise.")
    p.add_argument("--min-turnover-cr", type=float, default=2.0, help="Min median weekly traded value, Rs cr (default 2).")
    p.add_argument("--min-price", type=float, default=30.0, help="Min close price (default 30).")
    p.add_argument("--min-weeks", type=int, default=60, help="Min weeks listed (default 60).")
    p.add_argument("--base-len", type=int, default=20, help="Base lookback window in weeks, 8-40 per spec "
                   "(default 20: 40 clears too rarely to be useful; the no-edge verdict holds across the range).")
    p.add_argument("--max-base-depth", type=float, default=0.35, help="Max base depth as fraction (default 0.35).")
    p.add_argument("--near-high-frac", type=float, default=0.75, help="'Near the ceiling' = high >= this x base high (default 0.75).")
    p.add_argument("--min-ceiling-touches", type=int, default=2, help="Min base weeks near the ceiling (default 2).")
    p.add_argument("--min-vol-mult", type=float, default=1.5, help="Breakout volume vs 20w avg (default 1.5).")
    p.add_argument("--min-close-strength", type=float, default=0.6, help="Close position in weekly range, 0-1 (default 0.6).")
    p.add_argument("--max-ext-mult", type=float, default=1.25, help="Max close as multiple of base high (default 1.25).")
    p.add_argument("--complete-weeks-only", action="store_true", help="Skip the latest week if it has < 5 trading days.")
    p.add_argument("--include-etfs", action="store_true", help="Do not exclude ETFs/index funds.")
    p.add_argument("--outdir", type=Path, default=HERE / "data", help="Output directory.")
    run(p.parse_args())


if __name__ == "__main__":
    main()
