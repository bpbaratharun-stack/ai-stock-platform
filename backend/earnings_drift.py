#!/usr/bin/env python3
"""earnings_drift.py - does the REACTION to quarterly results predict what follows?
(Post-earnings-announcement drift, the one anomaly with a non-price input we can
test: nse_results_dates.json gives the dates; the price panel gives the reaction.)

For every (stock, results date D):
  reaction  = close(first session AFTER D) / close(last session BEFORE D) - 1
              - a 2-session window, so it catches in-market and after-close releases
  entry     = the OPEN of the session after that (you have seen the full reaction)
  forward   = +10 / +20 / +40 session return from entry, vs the universe's return
              from the same day, week-clustered (same standard as the other tests)
  buckets   = fixed reaction bands (the hypothesis, not tuned), and a volume-
              confirmed sub-bucket; 2022-24 vs 2025-26 shown as a stability check

Also reported: the 5-session run-up INTO results (does buying ahead of results
pay?) and the size of the reaction itself (what holding through results costs).

    ./venv/Scripts/python.exe earnings_drift.py

Survivorship: currently-listed names only. Dates cover 914 stocks (the cache),
not the whole universe. NOT ADVICE.
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from strategy_scan import PANEL, ETF_RE, RS_CR
from weekly_momentum import load_results_map

HORIZONS = (10, 20, 40)
BANDS = [("big DOWN  (< -8%)", -np.inf, -8), ("down  (-8 to -3%)", -8, -3), ("flat  (-3 to +3%)", -3, 3),
         ("up  (+3 to +8%)", 3, 8), ("big UP  (> +8%)", 8, np.inf)]


def load_panel(cfg) -> pd.DataFrame:
    print(f"Loading {PANEL.name} ...")
    df = pd.read_parquet(PANEL, columns=["date", "symbol", "open", "close", "volume", "turnover"])
    df = df[~df["symbol"].str.contains(ETF_RE, na=False)]
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    g = df.groupby("symbol", observed=True)
    df["med_turnover"] = g["turnover"].transform(lambda s: s.rolling(20, min_periods=10).median())
    df["volavg50"] = g["volume"].transform(lambda s: s.shift(1).rolling(50, min_periods=20).mean())
    df["n_bars"] = g.cumcount() + 1
    df["entry"] = g["open"].shift(-1)                       # next-open fill
    for h in HORIZONS:
        df[f"ret{h}"] = (g["close"].shift(-h) / df["entry"] - 1) * 100
    df["universe"] = ((df["close"] >= cfg.min_price) & (df["med_turnover"] >= cfg.min_turnover_cr * RS_CR)
                      & (df["n_bars"] >= 120))
    df["week"] = df["date"].dt.to_period("W-FRI")
    print(f"  {len(df):,} rows, {df['symbol'].nunique():,} stocks, {df['date'].min().date()} -> {df['date'].max().date()}")
    return df


def build_events(df: pd.DataFrame, cfg) -> pd.DataFrame:
    rmap = load_results_map()
    by_sym = {s: g for s, g in df.groupby("symbol", observed=True)}
    rows, n_dates, n_nosym = 0, 0, 0
    out = []
    for sym, dates in rmap.items():
        g = by_sym.get(f"{sym}.NS")
        if g is None:
            n_nosym += 1
            continue
        d = g["date"].dt.date.to_numpy()
        op, cl, vol = g["open"].to_numpy(), g["close"].to_numpy(), g["volume"].to_numpy()
        va, uni = g["volavg50"].to_numpy(), g["universe"].to_numpy()
        rets = {h: g[f"ret{h}"].to_numpy() for h in HORIZONS}
        wk, dt = g["week"].to_numpy(), g["date"].to_numpy()
        for D in dates:
            n_dates += 1
            b = np.searchsorted(d, D, side="left") - 1            # last session BEFORE D
            a = np.searchsorted(d, D, side="right")               # first session AFTER D
            if b < 5 or a >= len(d) or a - b > 6 or a + 1 >= len(d):
                continue                                           # off the edges / data gap
            if not uni[b]:
                continue                                           # not investable at the time
            react = (cl[a] / cl[b] - 1) * 100
            runup = (cl[b] / cl[b - 5] - 1) * 100                  # the 5 sessions into results
            vr = (vol[b + 1:a + 1].mean() / va[b]) if (np.isfinite(va[b]) and va[b] > 0) else np.nan
            row = dict(symbol=sym, D=D, signal_date=dt[a], week=wk[a], react=react, runup=runup,
                       vol_ratio=vr, entry=op[a + 1])
            for h in HORIZONS:
                row[f"ret{h}"] = rets[h][a]                        # from the reaction-day row: close[a+h]/open[a+1]
            out.append(row)
    ev = pd.DataFrame(out)
    print(f"  results dates: {n_dates:,} across {len(rmap):,} symbols ({n_nosym} symbols not in the panel)")
    print(f"  usable events: {len(ev):,}  (investable at the time, with a forward window)")
    return ev


def _bench(df: pd.DataFrame) -> dict:
    u = df[df["universe"]]
    return {h: u.dropna(subset=[f"ret{h}"]).groupby("date", observed=True)[f"ret{h}"].mean() for h in HORIZONS}


def table(ev: pd.DataFrame, bench: dict, title: str):
    print()
    print("=" * 100)
    print(title)
    print("=" * 100)
    print(f"  {'reaction band':<22} {'hold':>4} {'events':>7} {'weeks':>5} {'avg%':>7} {'med%':>7} {'win%':>5} "
          f"{'univ%':>7} {'EDGE%':>7} {'wks+':>5}  read")
    for lab, lo, hi in BANDS:
        sub = ev[(ev["react"] > lo) & (ev["react"] <= hi)]
        for h in HORIZONS:
            col = f"ret{h}"
            s = sub.dropna(subset=[col]).copy()
            if len(s) < 30:
                continue
            s["bench"] = s["signal_date"].map(bench[h])
            s = s.dropna(subset=["bench"])
            wk = s.groupby("week", observed=True).agg(ret=(col, "mean"), bench=("bench", "mean"))
            edge = (wk["ret"] - wk["bench"]).mean()
            read = ("EDGE" if edge > 1.0 else "no edge" if edge < 0.25 else "marginal")
            if edge < -1.0:
                read = "NEG edge"
            print(f"  {lab:<22} {h:>3}d {len(s):>7,} {len(wk):>5} {wk['ret'].mean():>+7.2f} {s[col].median():>+7.2f} "
                  f"{(s[col] > 0).mean() * 100:>4.0f}% {wk['bench'].mean():>+7.2f} {edge:>+7.2f} "
                  f"{(wk['ret'] > wk['bench']).mean() * 100:>4.0f}%  {read}")
        print()


def main():
    p = argparse.ArgumentParser(description="Post-earnings drift test on nse_results_dates.json + panel.parquet.")
    p.add_argument("--min-price", type=float, default=30.0)
    p.add_argument("--min-turnover-cr", type=float, default=2.0)
    p.add_argument("--vol-mult", type=float, default=2.0, help="'volume-confirmed' = reaction volume >= this x 50d avg (default 2).")
    cfg = p.parse_args()

    df = load_panel(cfg)
    ev = build_events(df, cfg)
    bench = _bench(df)

    print()
    print(f"  the reaction itself (2 sessions around results): median |move| {ev['react'].abs().median():.1f}%, "
          f"p90 |move| {ev['react'].abs().quantile(.9):.1f}%, up {(ev['react'] > 0).mean() * 100:.0f}% of the time, "
          f"mean {ev['react'].mean():+.2f}%")
    print(f"  the 5-session run-up INTO results: mean {ev['runup'].mean():+.2f}%, median {ev['runup'].median():+.2f}%  "
          f"(the universe's typical 5-day return is about {df.loc[df['universe'], 'ret10'].mean() / 2:+.2f}%)")

    table(ev, bench, "AFTER RESULTS: buy the next open, by reaction band  (all events, 2022-2026)")

    conf = ev[ev["vol_ratio"] >= cfg.vol_mult]
    table(conf, bench, f"VOLUME-CONFIRMED reactions only (reaction volume >= {cfg.vol_mult:g}x the 50-day average)")

    ev["period"] = np.where(ev["signal_date"] < pd.Timestamp("2025-01-01"), "2022-24", "2025-26")
    for per in ("2022-24", "2025-26"):
        table(ev[ev["period"] == per], bench, f"STABILITY CHECK: {per} only")

    print("  EDGE = week-clustered mean of the band's forward return minus the universe's same-day return.")
    print("  Post-earnings drift would show as a POSITIVE edge in the 'big UP' band and a NEGATIVE one in 'big DOWN'.")
    print("  Survivorship-optimistic in absolute terms; EDGE roughly unbiased. Dates cover the cached 914 names. NOT advice.")


if __name__ == "__main__":
    main()
