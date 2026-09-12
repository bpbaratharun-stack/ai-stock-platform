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

    c = last["close"]
    # --- gates / graded features -------------------------------------------
    last["trend_ok"] = (c > last["sma50"]) & (last["sma50"] > last["sma50_prev"])
    align_bits = ((c > last["sma20"]).astype(int) + (last["sma20"] > last["sma50"]).astype(int)
                  + (last["sma50"] > last["sma100"]).astype(int) + (last["sma100"] > last["sma200"]).astype(int))
    last["align_bits"] = align_bits                            # 0..4
    last["aligned"] = align_bits == 4
    last["rsi_ok"] = last["rsi"].between(50, 78)
    last["macd_ok"] = (last["macd"] > last["macd_sig"]) & (last["macd"] > 0)
    last["vol_ratio"] = (last["volume"] / last["volavg50"]).replace([np.inf, -np.inf], np.nan)
    last["vol_ok"] = last["vol_ratio"] >= 1.0
    last["vcp_ok"] = last["atr_recent"] < last["atr_prev"]
    last["breakout_ok"] = c >= last["base_high"] * 0.985
    last["ext_above_base_pct"] = (c / last["base_high"] - 1) * 100

    # --- resistances, stop, risk:reward ------------------------------------
    # nearby resistance = nearest level ABOVE price (the immediate obstacle);
    # R4 = the monthly extension target (the swing goal). R:R is scored on R4.
    def _nearby(row):
        ups = [row[k] for k in ("base_high", "R1", "R2", "R3", "R4")
               if pd.notna(row[k]) and row[k] > row["close"]]
        return min(ups) if ups else (row["R4"] if pd.notna(row["R4"]) else row["close"] * 1.1)
    last["target_near"] = last.apply(_nearby, axis=1)
    last["target_r4"] = np.where(last["R4"].notna() & (last["R4"] > c), last["R4"], c * 1.1)
    stop = np.where(last["swing_low"] < c, last["swing_low"], last["sma50"])
    last["stop"] = np.minimum(stop, c * 0.999)                # stop must sit below price
    last["risk_pct"] = (c / last["stop"] - 1) * 100
    last["reward_near_pct"] = (last["target_near"] / c - 1) * 100   # to immediate resistance
    last["room_to_r4_pct"] = (last["target_r4"] / c - 1) * 100      # to R4 (swing target)
    last["rr"] = (last["room_to_r4_pct"] / last["risk_pct"]).replace([np.inf, -np.inf], np.nan)
    last["rr_ok"] = last["rr"] >= cfg.min_rr

    # --- composite (0..100) ------------------------------------------------
    rr = last["rr"].clip(lower=0).fillna(0)
    vr = last["vol_ratio"].clip(lower=0).fillna(0)
    last["score"] = (
        18 * last["trend_ok"]
        + 18 * (align_bits / 4)
        + 8 * last["rsi_ok"] + 8 * last["macd_ok"]
        + 10 * (vr.clip(upper=2) / 2)
        + 10 * last["vcp_ok"]
        + 15 * last["breakout_ok"]
        + 13 * (rr.clip(upper=3) / 3)
    ).round(1)

    last["symbol"] = last["symbol"].str.replace(".NS", "", regex=False).str.replace(".BO", "", regex=False)
    return last.sort_values("score", ascending=False)


def build(cfg) -> pd.DataFrame:
    df = pd.read_parquet(PANEL, columns=["date", "symbol", "sector", "open",
                                         "high", "low", "close", "volume", "turnover"])
    df = df[~df["symbol"].str.contains(ETF_RE, na=False)]
    cutoff = df["date"].max() - pd.Timedelta(days=cfg.window_days)
    df = df[df["date"] >= cutoff]
    df = compute(df)
    df = monthly_pivots(df)
    return score_latest(df, cfg)


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
