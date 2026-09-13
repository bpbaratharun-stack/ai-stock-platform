#!/usr/bin/env python3
"""winner_factors.py - "What did each week's top-10 performers look like the week
BEFORE they won, and does that tilt the odds?"

Method (built to resist fooling ourselves):
  1. Snapshot every liquid stock's features at each Friday close (week W-1).
     Nothing measured during the winning week is used - that would just be
     describing the win, not predicting it.
  2. Winners = next week's top-N by close-to-close return among the same
     gate-passing universe (the stocks you could actually have bought).
  3. LIFT = P(trait | winner) / P(trait | universe), averaged across weeks
     (week-clustered), with the universe base rate shown - "70% of winners were
     above the 50-DMA" means nothing if 65% of all stocks were.
  4. A rule is built from the strongest lifts on the FIRST --split share of
     weeks (in-sample), then scored on the remaining weeks it never saw
     (out-of-sample): next-Monday-open entry, +1w and +4w returns, universe
     benchmark, week-clustered. If OOS collapses vs IS, the rule is curve-fit.

    ./venv/Scripts/python.exe winner_factors.py
    ./venv/Scripts/python.exe winner_factors.py --top 10 --split 0.6 --k 3

NOT ADVICE. The weekly top-10 is the ~1% tail, mostly news gaps; the honest
target is a modest, out-of-sample tilt over the universe - or the finding that
there is none.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from strategy_scan import PANEL, ETF_RE, RS_CR, compute, add_turnaround

HERE = Path(__file__).parent


def build_snapshots(cfg) -> pd.DataFrame:
    print(f"Loading {PANEL.name} ...")
    df = pd.read_parquet(PANEL, columns=["date", "symbol", "open", "high", "low",
                                         "close", "volume", "turnover"])
    df = df[~df["symbol"].str.contains(ETF_RE, na=False)]
    print(f"  {len(df):,} rows, {df['symbol'].nunique():,} stocks, "
          f"{df['date'].min().date()} -> {df['date'].max().date()}. Computing daily features ...")
    df = compute(df)
    df = add_turnaround(df)                       # adds ema20/50/200, ta_weekly, week
    g = df.groupby("symbol", observed=True)

    # extra point-in-time features (all as-of that day's close)
    c = df["close"]
    for n, lab in ((5, "1w"), (20, "4w"), (60, "12w"), (120, "26w")):
        df[f"ret_{lab}"] = (c / g["close"].shift(n) - 1) * 100
    df["hi252"] = g["close"].transform(lambda s: s.rolling(252, min_periods=120).max())
    df["dist_52w_hi"] = (c / df["hi252"] - 1) * 100
    dr = g["close"].pct_change()
    df["vol20"] = dr.groupby(df["symbol"], observed=True).transform(
        lambda s: s.rolling(20, min_periods=15).std()) * 100
    df["vol5_ratio"] = (g["volume"].transform(lambda s: s.rolling(5, min_periods=3).mean())
                        / df["volavg50"]).replace([np.inf, -np.inf], np.nan)
    df["adtv_cr"] = df["med_turnover"] / RS_CR
    df["next_open"] = g["open"].shift(-1)         # Monday's open = the realistic fill

    # one snapshot per (symbol, week): the LAST session of the week = Friday close
    df["is_last"] = df["date"] == df.groupby(["symbol", "week"], observed=True)["date"].transform("max")
    snap = df[df["is_last"]].copy().sort_values(["symbol", "week"]).reset_index(drop=True)
    gs = snap.groupby("symbol", observed=True)
    # winners are defined on weekly close-to-close (the "top performers of the week")
    snap["fwd_1w_cc"] = (gs["close"].shift(-1) / snap["close"] - 1) * 100
    # strategy returns: next-Monday open -> +1w close / +4w close (tradeable)
    snap["fwd_1w"] = (gs["close"].shift(-1) / snap["next_open"] - 1) * 100
    snap["fwd_4w"] = (gs["close"].shift(-4) / snap["next_open"] - 1) * 100
    # universe gate as of the snapshot: what you could have bought that Monday
    snap["universe"] = (snap["sma200"].notna() & (snap["close"] >= cfg.min_price)
                        & (snap["med_turnover"] >= cfg.min_turnover_cr * RS_CR)
                        & snap["fwd_1w_cc"].notna())
    return snap[snap["universe"]].copy()


def _tercile(s: pd.DataFrame, col: str, q: float) -> pd.Series:
    return s.groupby("week", observed=True)[col].transform(lambda x: x.quantile(q))


FLAGS = {  # name: (description, fn(snap) -> bool Series) - ALL as of the prior Friday
    "above_sma20":  ("close > 20-DMA",                         lambda s: s["close"] > s["sma20"]),
    "above_sma50":  ("close > 50-DMA",                         lambda s: s["close"] > s["sma50"]),
    "above_sma200": ("close > 200-DMA",                        lambda s: s["close"] > s["sma200"]),
    "sma_stack4":   ("20>50>100>200 stack, price on top",      lambda s: (s["close"] > s["sma20"]) & (s["sma20"] > s["sma50"]) & (s["sma50"] > s["sma100"]) & (s["sma100"] > s["sma200"])),
    "sma50_rising": ("50-DMA higher than a month ago",         lambda s: s["sma50"] > s["sma50_prev"]),
    "rsi_gt60":     ("RSI(14) > 60",                           lambda s: s["rsi"] > 60),
    "rsi_lt40":     ("RSI(14) < 40",                           lambda s: s["rsi"] < 40),
    "macd_bull":    ("MACD > signal and > 0",                  lambda s: (s["macd"] > s["macd_sig"]) & (s["macd"] > 0)),
    "vol5_hot":     ("last-5d volume >= 1.5x 50d avg",         lambda s: s["vol5_ratio"] >= 1.5),
    "vol5_quiet":   ("last-5d volume <= 0.7x 50d avg",         lambda s: s["vol5_ratio"] <= 0.7),
    "atr_contract": ("10d ATR% < prior 10d (VCP proxy)",       lambda s: s["atr_recent"] < s["atr_prev"]),
    "near_52w_hi":  ("within 5% of 52-week high",              lambda s: s["dist_52w_hi"] >= -5),
    "far_52w_hi":   ("30%+ below 52-week high",                lambda s: s["dist_52w_hi"] <= -30),
    "at_60d_high":  ("at/near 60-day high (breakout)",         lambda s: s["close"] >= s["base_high"] * 0.985),
    "up_1w_5":      ("prior week already up > 5%",             lambda s: s["ret_1w"] > 5),
    "down_1w_5":    ("prior week down > 5%",                   lambda s: s["ret_1w"] < -5),
    "up_4w_10":     ("prior 4 weeks up > 10%",                 lambda s: s["ret_4w"] > 10),
    "up_12w_20":    ("prior 12 weeks up > 20%",                lambda s: s["ret_12w"] > 20),
    "down_12w_10":  ("prior 12 weeks down > 10%",              lambda s: s["ret_12w"] < -10),
    "price_lt100":  ("price < Rs 100",                         lambda s: s["close"] < 100),
    "price_gt1000": ("price > Rs 1000",                        lambda s: s["close"] > 1000),
    "adtv_lt5":     ("traded value < Rs 5 cr/day (small)",     lambda s: s["adtv_cr"] < 5),
    "adtv_gt50":    ("traded value > Rs 50 cr/day (large)",    lambda s: s["adtv_cr"] > 50),
    "hi_vol20":     ("20d volatility in top third that week",  lambda s: s["vol20"] >= _tercile(s, "vol20", 2 / 3)),
    "lo_vol20":     ("20d volatility in bottom third",         lambda s: s["vol20"] <= _tercile(s, "vol20", 1 / 3)),
    "ta_weekly":    ("weekly EMA turnaround structure (Mock 2)", lambda s: s["ta_weekly"].astype(bool)),
}
CONTINUOUS = [("rsi", "RSI(14)"), ("ret_4w", "prior 4w return %"), ("ret_12w", "prior 12w return %"),
              ("dist_52w_hi", "% from 52w high"), ("vol20", "20d daily vol %"),
              ("vol5_ratio", "5d/50d volume"), ("adtv_cr", "traded value Rs cr"), ("close", "price Rs")]


def label_winners(snap: pd.DataFrame, cfg) -> pd.DataFrame:
    snap["rank_cc"] = snap.groupby("week", observed=True)["fwd_1w_cc"].rank(ascending=False, method="first")
    snap["winner"] = snap["rank_cc"] <= cfg.top
    return snap


def lift_table(snap: pd.DataFrame) -> pd.DataFrame:
    rows = []
    win = snap["winner"].to_numpy()
    for name, (desc, fn) in FLAGS.items():
        f = fn(snap).fillna(False).astype(bool).to_numpy()
        d = pd.DataFrame({"week": snap["week"].to_numpy(), "f": f, "wf": f & win, "w": win})
        wk = d.groupby("week", observed=True).agg(u=("f", "mean"), wf=("wf", "sum"), w=("w", "sum"))
        wk = wk[wk["w"] > 0]
        wk["wr"] = wk["wf"] / wk["w"]                    # trait rate among that week's winners
        lift = (wk["wr"] / wk["u"].replace(0, np.nan)).replace([np.inf, -np.inf], np.nan).dropna()
        rows.append(dict(flag=name, desc=desc, winners_pct=wk["wr"].mean() * 100,
                         universe_pct=wk["u"].mean() * 100, lift=lift.mean(), lift_med=lift.median(),
                         wks_gt1=(lift > 1).mean() * 100, weeks=len(wk)))
    return pd.DataFrame(rows).sort_values("lift", ascending=False)


def print_lifts(t: pd.DataFrame, title: str):
    print()
    print("=" * 96)
    print(title)
    print("=" * 96)
    print(f"  {'trait (as of the prior Friday)':<44} {'winners%':>8} {'univ%':>7} {'LIFT':>6} {'medLIFT':>8} {'wks>1':>6}")
    for _, r in t.iterrows():
        print(f"  {r['desc']:<44} {r['winners_pct']:>7.1f}% {r['universe_pct']:>6.1f}% "
              f"{r['lift']:>6.2f} {r['lift_med']:>8.2f} {r['wks_gt1']:>5.0f}%")
    print("  LIFT = share of winners with the trait / share of the universe with it, averaged across weeks.")
    print("  1.0 = no information. wks>1 = share of weeks the trait was over-represented among winners.")


def evaluate_rule(snap: pd.DataFrame, rule: pd.Series, label: str):
    """Buy every rule-passing stock at Monday's open; hold 1w / 4w; vs the universe."""
    print()
    print(f"  --- {label} ---")
    print(f"  {'':>4} {'hold':>4} {'picks':>7} {'weeks':>6} {'avg%':>7} {'med%':>7} {'win%':>5} "
          f"{'univ%':>7} {'EDGE%':>7} {'wks+':>5}  in-top10")
    rule = rule.reindex(snap.index).fillna(False).astype(bool)
    for split, mask in (("IS", snap["is_sample"]), ("OOS", ~snap["is_sample"])):
        for h in ("1w", "4w"):
            col = f"fwd_{h}"
            base = snap[mask].dropna(subset=[col])
            if base.empty:
                continue
            picks = base[rule.reindex(base.index)]
            if picks.empty:
                print(f"  {split:>4} {h:>4}  (no picks)")
                continue
            bench = base.groupby("week", observed=True)[col].mean()
            wk = picks.groupby("week", observed=True).agg(ret=(col, "mean"))
            wk["bench"] = bench.reindex(wk.index)
            tail = (f"{picks['winner'].mean() * 100:.1f}% vs {base['winner'].mean() * 100:.1f}% base"
                    if h == "1w" else "")
            print(f"  {split:>4} {h:>4} {len(picks):>7,} {len(wk):>6} {wk['ret'].mean():>+7.2f} "
                  f"{picks[col].median():>+7.2f} {(picks[col] > 0).mean() * 100:>4.0f}% "
                  f"{wk['bench'].mean():>+7.2f} {(wk['ret'] - wk['bench']).mean():>+7.2f} "
                  f"{(wk['ret'] > wk['bench']).mean() * 100:>4.0f}%  {tail}")


def main():
    p = argparse.ArgumentParser(description="Prior-week traits of each week's top performers, with an out-of-sample rule test.")
    p.add_argument("--top", type=int, default=10, help="Winners per week (default 10).")
    p.add_argument("--split", type=float, default=0.6, help="Share of weeks used to LEARN the rule (default 0.6).")
    p.add_argument("--k", type=int, default=3, help="Number of top-lift traits ANDed into the rule (default 3).")
    p.add_argument("--min-support", type=float, default=5.0, help="Ignore traits held by < this %% of the universe (default 5).")
    p.add_argument("--min-price", type=float, default=30.0)
    p.add_argument("--min-turnover-cr", type=float, default=2.0)
    cfg = p.parse_args()

    snap = build_snapshots(cfg)
    snap = label_winners(snap, cfg)
    weeks = sorted(snap["week"].unique())
    cut = weeks[int(len(weeks) * cfg.split)]
    snap["is_sample"] = snap["week"] < cut
    n_is = snap.loc[snap["is_sample"], "week"].nunique()
    n_oos = snap.loc[~snap["is_sample"], "week"].nunique()
    print(f"  universe snapshots: {len(snap):,}  |  weeks: {len(weeks)}  "
          f"(learn on the first {n_is}, test on the last {n_oos}; cut at {cut})")
    print(f"  winners: top {cfg.top} per week by close-to-close return among gate-passing stocks "
          f"(price >= Rs {cfg.min_price:g}, traded value >= Rs {cfg.min_turnover_cr:g} cr/day)")
    w = snap[snap["winner"]]
    print(f"  a typical winning week: median winner +{w['fwd_1w_cc'].median():.1f}%, "
          f"the 10th-best +{w[w['rank_cc'] == cfg.top]['fwd_1w_cc'].median():.1f}%")

    # ---- 1. what winners looked like (IN-SAMPLE weeks only; OOS stays sealed) ----
    ins = snap[snap["is_sample"]]
    t = lift_table(ins)
    print_lifts(t, f"PRIOR-WEEK TRAITS OF THE TOP-{cfg.top}   (learning weeks only: {n_is} weeks)")
    print()
    print(f"  {'continuous trait (median)':<32} {'winners':>10} {'universe':>10}")
    for col, lab in CONTINUOUS:
        print(f"  {lab:<32} {ins.loc[ins['winner'], col].median():>10.2f} {ins[col].median():>10.2f}")

    # ---- 2. build the rule from the top-k POSITIVE lifts with support ----
    cand = t[(t["universe_pct"] >= cfg.min_support) & (t["lift"] > 1.0)].head(cfg.k)
    print()
    print("=" * 96)
    print(f"RULE = ALL of the top-{cfg.k} lifts (traits held by >= {cfg.min_support:g}% of the universe):")
    for _, r in cand.iterrows():
        print(f"    - {r['desc']}   (lift {r['lift']:.2f}; held by {r['universe_pct']:.1f}% of stocks)")
    print("=" * 96)
    rule = pd.Series(True, index=snap.index)
    for name in cand["flag"]:
        rule &= FLAGS[name][1](snap).fillna(False).astype(bool)
    print(f"  the rule passes {rule.mean() * 100:.1f}% of universe snapshots "
          f"({rule.sum():,} picks over {len(weeks)} weeks)")

    evaluate_rule(snap, rule, "RULE picks: Monday-open entry, hold 1w / 4w, vs the universe  (IS = learned on, OOS = never seen)")
    for name in cand["flag"]:                    # each trait alone: which one carries the OOS result, if any
        evaluate_rule(snap, FLAGS[name][1](snap).fillna(False).astype(bool), f"single trait: {FLAGS[name][0]}")

    print()
    print("  Read OOS, not IS. IS is where the traits were chosen, so it flatters by construction.")
    print("  in-top10 = share of picks that landed in that week's top-10, vs the base rate for any stock.")
    print("  Survivorship-optimistic in absolute terms (currently-listed names only); EDGE is roughly unbiased. NOT advice.")

    out = HERE / "data" / "weekly_winners.csv"
    snap[snap["winner"]][["week", "symbol", "close", "fwd_1w_cc", "rank_cc"]] \
        .sort_values(["week", "rank_cc"]).to_csv(out, index=False)
    print(f"  winners list -> {out}")


if __name__ == "__main__":
    main()
