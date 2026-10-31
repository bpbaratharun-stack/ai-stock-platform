#!/usr/bin/env python3
"""resilience_scan.py — which stocks are HOLDING UP while the market falls?

A breakout screen needs stocks making new highs, so it goes empty in a selloff
(see weekly_breakout_vcp.py: 0 signals through late Oct 2026). This screen asks
the question that still has answers in a down market: relative strength.

The market here is the liquid universe's own MEDIAN daily return — the typical
stock, not a cap-weighted index. That matters: in Oct 2026 the Nifty 50 was flat
while the median stock fell ~7%, so an index benchmark would have flattered
everything. Self-contained too: no external index feed to go stale.

Per stock, over the lookback window:
  rel_pct        stock return minus the market's return (the headline)
  down_capture   on days the market FELL, the stock's average move divided by
                 the market's. 1.0 = fell exactly with it, 0.5 = fell half as
                 much, NEGATIVE = actually rose while the market fell.
  beat_down_pct  share of those down days where the stock beat the market
  max_dd_pct     deepest peak-to-trough inside the window
  from_52w_high  how far below its own 52-week high it sits

Ranked by relative return, with down-capture as the quality check: a stock can
lead on relative return simply by being volatile, so a LOW down-capture is what
separates genuine resilience from a lucky bounce.

DESCRIPTIVE, AND UNTESTED FORWARD. Every screen in this project that has been
backtested came out flat-to-negative against its own universe; this one has not
been backtested at all yet. Treat it as a map of what is holding up, not a
buy list.

    ./venv/Scripts/python.exe resilience_scan.py
    ./venv/Scripts/python.exe resilience_scan.py --weeks 2 --top 25
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from strategy_scan import PANEL, ETF_RE, RS_CR

HERE = Path(__file__).parent


def build(cfg) -> pd.DataFrame:
    df = pd.read_parquet(PANEL, columns=["date", "symbol", "high", "low", "close", "turnover"])
    df = df[~df["symbol"].str.contains(ETF_RE, na=False)]
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)

    end = df["date"].max()
    # keep ~14 months so the 52-week high is real, then measure over the window
    df = df[df["date"] >= end - pd.Timedelta(days=430)]
    g = df.groupby("symbol", observed=True)
    df["ret"] = g["close"].pct_change() * 100
    df["adtv_cr"] = g["turnover"].transform(lambda s: s.rolling(20, min_periods=10).median()) / RS_CR
    df["hi_52w"] = g["close"].transform(lambda s: s.rolling(252, min_periods=120).max())
    df["n_bars"] = g.cumcount() + 1

    # liquid, investable names as of the latest bar
    last = df.groupby("symbol", observed=True).tail(1)
    keep = set(last.loc[(last["close"] >= cfg.min_price)
                        & (last["adtv_cr"] >= cfg.min_turnover_cr)
                        & (last["n_bars"] >= 200), "symbol"])
    df = df[df["symbol"].isin(keep)]
    if df.empty:
        return pd.DataFrame()

    sessions = sorted(df["date"].unique())
    win = sessions[-cfg.weeks * 5:]                       # ~5 sessions per week
    start = win[0]
    w = df[df["date"].isin(win)]

    # "the market" = the median liquid stock, per day
    mkt = w.groupby("date", observed=True)["ret"].median()
    down_days = mkt.index[mkt < 0]
    mkt_down_mean = float(mkt.loc[down_days].mean()) if len(down_days) else np.nan

    piv = w.pivot_table(index="date", columns="symbol", values="ret")
    closes = w.pivot_table(index="date", columns="symbol", values="close")
    first_close, last_close = closes.iloc[0], closes.iloc[-1]
    stock_ret = (last_close / first_close - 1) * 100
    mkt_ret = float((1 + mkt / 100).prod() - 1) * 100     # compounded median-stock return

    dn = piv.loc[down_days] if len(down_days) else piv.iloc[0:0]
    down_mean = dn.mean()                                  # stock's avg move on market-down days
    beat = (dn.sub(mkt.loc[down_days], axis=0) > 0).mean() * 100 if len(down_days) else pd.Series(dtype=float)

    # max drawdown inside the window
    run_max = closes.cummax()
    max_dd = ((closes / run_max - 1) * 100).min()

    snap = df.groupby("symbol", observed=True).tail(1).set_index("symbol")
    out = pd.DataFrame({
        "close": last_close.round(2),
        "ret_pct": stock_ret.round(2),
        "rel_pct": (stock_ret - mkt_ret).round(2),
        "down_capture": (down_mean / mkt_down_mean).round(2) if np.isfinite(mkt_down_mean) else np.nan,
        "beat_down_pct": beat.round(0),
        "max_dd_pct": max_dd.round(1),
        "adtv_cr": snap["adtv_cr"].round(1),
        "from_52w_high": ((last_close / snap["hi_52w"] - 1) * 100).round(1),
    }).dropna(subset=["ret_pct"])
    out.index = out.index.str.replace(".NS", "", regex=False).str.replace(".BO", "", regex=False)
    out = out.sort_values("rel_pct", ascending=False)
    out.attrs.update(start=str(pd.Timestamp(start).date()), end=str(pd.Timestamp(end).date()),
                     market_ret_pct=round(mkt_ret, 2), n_down_days=int(len(down_days)),
                     n_sessions=len(win), n_universe=int(len(out)))
    return out


class Cfg:
    def __init__(self, weeks=4, top=30, min_price=30.0, min_turnover_cr=2.0):
        self.weeks, self.top = weeks, top
        self.min_price, self.min_turnover_cr = min_price, min_turnover_cr


def main():
    p = argparse.ArgumentParser(description="Stocks holding up best versus the typical stock.")
    p.add_argument("--weeks", type=int, default=4, help="Lookback in weeks (default 4).")
    p.add_argument("--top", type=int, default=30)
    p.add_argument("--min-price", type=float, default=30.0)
    p.add_argument("--min-turnover-cr", type=float, default=2.0)
    a = p.parse_args()
    res = build(Cfg(a.weeks, a.top, a.min_price, a.min_turnover_cr))
    if res.empty:
        print("No qualifying stocks."); return
    m = res.attrs
    print(f"\n{m['start']} -> {m['end']}  ({m['n_sessions']} sessions, {m['n_down_days']} of them down)")
    print(f"the typical stock returned {m['market_ret_pct']:+.2f}% over the window; "
          f"{m['n_universe']:,} liquid stocks ranked\n")
    print(f"  {'symbol':<14}{'ret%':>8}{'vs mkt':>8}{'downCap':>9}{'beatDn%':>9}{'maxDD%':>8}"
          f"{'52wHi%':>8}{'Rs cr/d':>9}")
    for sym, r in res.head(a.top).iterrows():
        print(f"  {sym:<14}{r['ret_pct']:>+8.2f}{r['rel_pct']:>+8.2f}{r['down_capture']:>9.2f}"
              f"{r['beat_down_pct']:>9.0f}{r['max_dd_pct']:>8.1f}{r['from_52w_high']:>8.1f}{r['adtv_cr']:>9.1f}")
    print("\n  downCap < 1 = fell less than the market on its down days; < 0 = rose while it fell.")
    print("  Descriptive and NOT yet backtested for forward returns. Not advice.")


if __name__ == "__main__":
    main()
