#!/usr/bin/env python3
"""dma_exit_backtest.py — does "SELL after N consecutive daily closes below the
50-day moving average" actually protect you, or just whipsaw you out?

Honest by construction (same standard as the momentum/VCP backtests):
  - ENTRY (the sell) at the NEXT session's OPEN, not the signal-day close you
    compute the signal from.
  - FORWARD return over a fixed horizon (default 20 trading days ~ 4 weeks).
  - MEDIAN-to-MEDIAN: the signalled names' median forward return vs the whole
    liquid universe's median that same week (comparing like statistics).
  - CLUSTERED by week: many breakdowns in one week are one correlated bet, so we
    take the weekly median, then average across weeks.

Reading the result: the signal identifies stocks about to SELL. If those names
go on to UNDERPERFORM the universe (positive EDGE = universe_median - signal_median),
selling avoided weakness — the rule has protective value. If EDGE ~ 0 or negative,
the breakdown mostly recovered and the exit is a whipsaw.

    ./venv/Scripts/python.exe dma_exit_backtest.py
    ./venv/Scripts/python.exe dma_exit_backtest.py --dma 20 --n 1 2 3 5 --horizon 20

NOT ADVICE. A mechanical study of one exit rule on past data.
"""
from __future__ import annotations
import argparse
import re
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
PANEL = HERE / "data" / "panel.parquet"
ETF_RE = re.compile(r"(?:BEES|ETF|IETF|LIQUID|GOLD|SILVER|NIFTY|SENSEX|GSEC|SDL|GILT|BOND)", re.I)


def _streaks(below: np.ndarray) -> np.ndarray:
    """Consecutive-True run length ending at each position (resets on False)."""
    out = np.zeros(len(below), dtype=np.int32)
    c = 0
    for i, v in enumerate(below):
        c = c + 1 if v else 0
        out[i] = c
    return out


def run(cfg):
    if not PANEL.exists():
        raise SystemExit(f"{PANEL} not found — run ingest_bhavcopy.py first.")
    print(f"Loading {PANEL.name} ...")
    df = pd.read_parquet(PANEL, columns=["date", "symbol", "open", "close", "turnover"])
    df = df[~df["symbol"].str.contains(ETF_RE, na=False)]
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    g = df.groupby("symbol", group_keys=False)

    print(f"  {len(df):,} rows, {df['symbol'].nunique():,} stocks, "
          f"through {df['date'].max().date()}. Computing {cfg.dma} DMA + forward returns...")
    df["dma"] = g["close"].transform(lambda s: s.rolling(cfg.dma).mean())
    df["adtv_cr"] = g["turnover"].transform(
        lambda s: s.rolling(20, min_periods=10).median()) / 1e7
    df["below"] = df["close"] < df["dma"]
    df["streak"] = g["below"].transform(lambda s: _streaks(s.to_numpy()))
    df["week"] = df["date"].dt.to_period("W-FRI")

    print(f"\n{'='*72}\nSELL RULE: close < {cfg.dma} DMA for N consecutive sessions  "
          f"(entry = next open, hold {cfg.horizon}td)\n{'='*72}")
    print(f"  universe filter: price >= Rs {cfg.min_price}, median daily turnover >= "
          f"Rs {cfg.min_turnover} cr\n")
    print(f"  {'N':>2}  {'signals':>8} {'weeks':>6}  {'sell_med%':>9} {'univ_med%':>9} "
          f"{'EDGE%':>7} {'wks+':>5}  read")

    for n in cfg.n:
        # forward return from the SELL fill (next open) to +horizon close
        df["fwd"] = (g["close"].shift(-cfg.horizon) / g["open"].shift(-1) - 1) * 100
        u = df[(df["close"] >= cfg.min_price) & (df["adtv_cr"] >= cfg.min_turnover)]
        u = u.dropna(subset=["dma", "fwd"])

        rows = []
        for w, snap in u.groupby("week", observed=True):
            if len(snap) < cfg.min_names:
                continue
            sig = snap[snap["streak"] == n]          # the confirmation session
            if len(sig) < cfg.min_signals:
                continue
            rows.append((len(sig), sig["fwd"].median(), snap["fwd"].median()))
        if not rows:
            print(f"  {n:>2}  (not enough signals)")
            continue
        r = pd.DataFrame(rows, columns=["k", "sig", "univ"])
        edge = (r["univ"] - r["sig"]).mean()          # protective value of selling
        sig_med, univ_med = r["sig"].mean(), r["univ"].mean()
        wks_pos = (r["univ"] > r["sig"]).mean() * 100
        read = ("protective" if edge > 0.75 else "whipsaw / no help" if edge < 0.25 else "marginal")
        print(f"  {n:>2}  {int(r['k'].sum()):>8} {len(r):>6}  {sig_med:>9.2f} {univ_med:>9.2f} "
              f"{edge:>+7.2f} {wks_pos:>4.0f}%  {read}")

    print(f"\n  EDGE = universe median - signalled median (forward {cfg.horizon}td return).")
    print("  EDGE > 0  => the names that broke down went on to lag the market, so")
    print("             selling on the signal avoided weakness (protective).")
    print("  EDGE ~= 0 => broke down then recovered like everything else (whipsaw).")
    print("  Bigger N waits for more confirmation: fewer signals, later exit.\n")
    print("  Still before costs/taxes; a mechanical study on history — NOT advice.")


def main():
    p = argparse.ArgumentParser(description="Backtest a 'close below N-day MA for N sessions' exit rule.")
    p.add_argument("--dma", type=int, default=50, help="Moving-average length (default 50).")
    p.add_argument("--n", type=int, nargs="+", default=[1, 2, 3, 5],
                   help="Consecutive closes-below to confirm (default: compare 1 2 3 5).")
    p.add_argument("--horizon", type=int, default=20, help="Forward hold in trading days (default 20).")
    p.add_argument("--min-price", type=float, default=20.0)
    p.add_argument("--min-turnover", type=float, default=5.0, help="Median daily turnover Rs cr (default 5).")
    p.add_argument("--min-names", type=int, default=100, help="Min universe names in a week to count it.")
    p.add_argument("--min-signals", type=int, default=3, help="Min signals in a week to count it.")
    run(p.parse_args())


if __name__ == "__main__":
    main()
