#!/usr/bin/env python3
"""strategy_backtest.py — "If I put Rs 50k into the scanner's picks on their signal
day, what would the reward have been N days later?"  Scores ALL of history with
the exact same formula as strategy_scan.py, then measures forward returns.

Honest by construction (same standard as the other backtests here):
  - a SIGNAL is the first day a stock's setup score crosses the threshold (a
    fresh trigger, not every day it stays high — avoids counting one move 20x)
  - ENTRY at the NEXT session's OPEN, never the signal-day close you scanned on
  - REWARD = fixed-horizon buy-and-hold to the +H close (H = 10 / 20 / 40 td)
  - BENCHMARK = every universe-gate-passing stock's same-horizon return that
    same day (equal weight): the edge is signal minus universe, like-for-like
  - CLUSTERED by week: many signals in one week are one correlated bet, so we
    average within the week first, then across weeks (the honest sample size)

    ./venv/Scripts/python.exe strategy_backtest.py                 # full history
    ./venv/Scripts/python.exe strategy_backtest.py --amount 50000 --min-score 80
    ./venv/Scripts/python.exe strategy_backtest.py --top-per-day 5 # only the day's top-5
    ./venv/Scripts/python.exe strategy_backtest.py --date 2026-07-15  # that day's picks

Survivorship: panel.parquet holds currently-listed names, so absolute returns are
optimistic; the EDGE (signal minus universe) is roughly unbiased. NOT ADVICE.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from strategy_scan import PANEL, ETF_RE, RS_CR, compute, monthly_pivots, add_scores

HORIZONS = (10, 20, 40)       # trading days ≈ 2 weeks / 1 month / 2 months


def prepare(cfg) -> pd.DataFrame:
    print(f"Loading {PANEL.name} ...")
    df = pd.read_parquet(PANEL, columns=["date", "symbol", "open", "high", "low",
                                         "close", "volume", "turnover"])
    df = df[~df["symbol"].str.contains(ETF_RE, na=False)]
    print(f"  {len(df):,} rows, {df['symbol'].nunique():,} stocks, through "
          f"{df['date'].max().date()}. Computing indicators on all history ...")
    df = compute(df)
    df = monthly_pivots(df)
    df = add_scores(df, cfg.min_rr)

    g = df.groupby("symbol", observed=True)
    df["entry"] = g["open"].shift(-1)                       # next-open fill
    for h in HORIZONS:
        df[f"ret{h}"] = (g["close"].shift(-h) / df["entry"] - 1) * 100

    df["universe"] = (df["sma200"].notna() & (df["close"] >= cfg.min_price)
                      & (df["med_turnover"] >= cfg.min_turnover_cr * RS_CR))

    # --- variant A: BREAKOUT — the live scanner's checklist score -------------
    hot = df["universe"] & (df["score"] >= cfg.min_score)
    df["signal_breakout"] = hot & ~g["score"].shift(1).ge(cfg.min_score).fillna(False)

    # --- variant B: PULLBACK — buy the dip inside an intact uptrend ------------
    # The breakout checklist buys names that have already moved (extended); this
    # keeps the same trend context but enters on a quiet dip to the 20-DMA.
    df["hi20"] = g["close"].transform(lambda s: s.rolling(20, min_periods=10).max())
    df["prev_close"] = g["close"].shift(1)
    stack = ((df["sma20"] > df["sma50"]) & (df["sma50"] > df["sma100"])
             & (df["sma100"] > df["sma200"]) & (df["sma50"] > df["sma50_prev"]))
    pb = (stack
          & (df["close"] > df["sma50"])                             # trend still intact
          & (df["close"] / df["hi20"]).between(0.90, 0.97)          # 3-10% off the 20d high
          & (df["close"] <= df["sma20"] * 1.03)                     # at / near the 20-DMA
          & df["rsi"].between(40, 62)                               # cooled, not broken
          & (df["vol_ratio"] < 1.0)                                 # quiet, light-volume dip
          & (df["close"] > df["prev_close"]))                       # the dip is being bought
    raw = df["universe"] & pb.fillna(False)
    df["signal_pullback"] = raw & ~raw.groupby(df["symbol"], observed=True).shift(1).fillna(False)  # fresh trigger

    df["signal"] = df["signal_pullback"] if cfg.variant == "pullback" else df["signal_breakout"]
    df["week"] = df["date"].dt.to_period("W-FRI")
    return df


def pick_signals(df: pd.DataFrame, cfg) -> pd.DataFrame:
    sig = df[df["signal"] & df["entry"].notna()].copy()
    if cfg.top_per_day > 0:                  # realistic: you'd act on the day's best few
        sig = (sig.sort_values(["date", "score"], ascending=[True, False])
                  .groupby("date", observed=True).head(cfg.top_per_day))
    return sig


def report(df: pd.DataFrame, sig: pd.DataFrame, cfg):
    amt = cfg.amount
    rule = (f"PULLBACK (quiet dip to the 20-DMA in an intact uptrend)" if cfg.variant == "pullback"
            else f"BREAKOUT checklist (score >= {cfg.min_score})")
    print(f"\n{'='*74}\nSTRATEGY BACKTEST — Rs {amt:,.0f} into each fresh setup, entry next open"
          f"\n  rule: {rule}\n{'='*74}")
    print(f"  signals: {len(sig):,} across {sig['week'].nunique():,} weeks  "
          f"({'top ' + str(cfg.top_per_day) + ' per day' if cfg.top_per_day else 'all fresh triggers'})")
    print(f"  universe gate: price >= Rs {cfg.min_price}, median turnover >= Rs {cfg.min_turnover_cr} cr\n")
    print(f"  {'hold':>6} {'trades':>7} {'weeks':>6} {'avg%':>7} {'med%':>7} {'win%':>5} "
          f"{'Rs on ' + f'{amt/1000:.0f}k':>12} {'univ%':>7} {'EDGE%':>7} {'wks+':>5}  read")

    for h in HORIZONS:
        col = f"ret{h}"
        s = sig.dropna(subset=[col])
        if s.empty:
            print(f"  {h:>5}d  (no resolved trades yet)")
            continue
        # universe benchmark: equal-weight same-horizon return per day, then
        # attached to each signal's day and clustered by week alongside it
        bench = df[df["universe"]].dropna(subset=[col]).groupby("date", observed=True)[col].mean()
        s = s.assign(bench=s["date"].map(bench)).dropna(subset=["bench"])
        wk = s.groupby("week", observed=True).agg(ret=(col, "mean"), bench=("bench", "mean"))
        avg, med = wk["ret"].mean(), s[col].median()
        edge = (wk["ret"] - wk["bench"]).mean()
        win = (s[col] > 0).mean() * 100
        wks_pos = (wk["ret"] > wk["bench"]).mean() * 100
        rupees = amt * avg / 100
        read = ("edge" if edge > 1.0 else "no edge" if edge < 0.25 else "marginal")
        print(f"  {h:>5}d {len(s):>7,} {len(wk):>6,} {avg:>+7.2f} {med:>+7.2f} {win:>4.0f}% "
              f"{rupees:>+12,.0f} {wk['bench'].mean():>+7.2f} {edge:>+7.2f} {wks_pos:>4.0f}%  {read}")

    print(f"\n  avg% / Rs = week-clustered mean return of the signals (what Rs {amt:,.0f} earns).")
    print("  univ% = the same-horizon return of EVERY gate-passing stock that week.")
    print("  EDGE  = avg% - univ%: the part you can credit to the checklist, not the market.")
    print("  med%  = median trade — expect it below the mean; setups pay through a few big winners.")
    print("\n  Before costs/taxes; survivorship-optimistic in absolute terms. NOT advice.")


def report_date(df: pd.DataFrame, cfg):
    d = pd.Timestamp(cfg.date)
    day = df[(df["date"] == d) & df["signal"] & df["entry"].notna()].copy()
    if day.empty:
        avail = df.loc[df["signal"], "date"].drop_duplicates().sort_values()
        near = avail[(avail - d).abs().argsort()[:5]] if len(avail) else []
        print(f"\nNo fresh setups on {d.date()}. Nearby signal dates: "
              f"{', '.join(str(x.date()) for x in near)}")
        return
    if cfg.top_per_day > 0:
        day = day.sort_values("score", ascending=False).head(cfg.top_per_day)
    amt = cfg.amount
    print(f"\n{'='*74}\nPICKS ON {d.date()}  —  Rs {amt:,.0f} each at the next open\n{'='*74}")
    cols = ["symbol", "score", "close", "entry"] + [f"ret{h}" for h in HORIZONS]
    show = day.sort_values("score", ascending=False)[cols].copy()
    show["symbol"] = show["symbol"].str.replace(".NS", "", regex=False)
    for h in HORIZONS:
        show[f"Rs@{h}d"] = (amt * show[f"ret{h}"] / 100).round(0)
    print(show.round(2).to_string(index=False))
    for h in HORIZONS:
        r = day[f"ret{h}"].dropna()
        if len(r):
            print(f"  {h:>3}d: {len(r)} resolved, avg {r.mean():+.2f}%  ->  Rs {amt*r.mean()/100:+,.0f} "
                  f"per pick, total {amt*r.sum()/100:+,.0f} on Rs {amt*len(r):,.0f}")
    print("  (blank = not enough forward days yet)")


def main():
    p = argparse.ArgumentParser(description="Backtest the strategy-scan setups: Rs X per pick, forward reward.")
    p.add_argument("--amount", type=float, default=50000, help="Rupees per pick (default 50000).")
    p.add_argument("--min-score", type=float, default=80, help="Setup score to count as a signal (default 80).")
    p.add_argument("--top-per-day", type=int, default=0, help="Only the day's top-N by score (0 = all).")
    p.add_argument("--min-rr", type=float, default=2.0)
    p.add_argument("--min-price", type=float, default=30.0)
    p.add_argument("--min-turnover-cr", type=float, default=2.0)
    p.add_argument("--date", type=str, default=None, help="Show one day's picks and their realized reward.")
    p.add_argument("--variant", choices=["breakout", "pullback"], default="breakout",
                   help="breakout = the live scanner's checklist score; pullback = buy a quiet dip "
                        "to the 20-DMA inside an intact uptrend (default: breakout).")
    cfg = p.parse_args()
    df = prepare(cfg)
    if cfg.date:
        report_date(df, cfg)
    else:
        report(df, pick_signals(df, cfg), cfg)


if __name__ == "__main__":
    main()
