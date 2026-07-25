"""Build IT-sector consistent-sales-growth lists from scraped Screener P&L data.

Consumes data/screener_it_pl.json (produced by the browser scrape) and emits:
  - it_growth_3y.csv : sales up in every one of the last 3 years
  - it_growth_5y_losers.csv : sales up in every one of the last 5 years,
                              ranked by worst 1-year price return

"Consistent" here means each individual year-on-year change is positive, which
is stricter than Screener's own 3Yr/5Yr fields (those are CAGRs and hide down years).
"""

import csv
import json
import re
from pathlib import Path

DATA = Path(__file__).parent / "data"
MCAP_FLOOR_CR = 1000.0

# A column header is an annual period like "Mar 2026" / "Dec 2025".
# Anything else (TTM, blank) is not a comparable annual figure.
PERIOD_RE = re.compile(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})")


def parse_num(x):
    if x is None:
        return None
    x = x.replace(",", "").strip()
    if x in ("", "-"):
        return None
    try:
        return float(x)
    except ValueError:
        return None


def annual_series(rec):
    """Return [(label, value, is_stub)] for real annual columns, oldest first."""
    out = []
    for head, val in zip(rec["h"], rec["s"]):
        head = " ".join(head.split())  # collapse the embedded newlines Screener emits
        if not PERIOD_RE.match(head):
            continue  # drops "" and "TTM"
        v = parse_num(val)
        if v is None:
            continue
        # Screener marks partial years (transition to a new FY end) e.g. "Mar 2016 9m"
        is_stub = bool(re.search(r"\b\d+m\b", head))
        out.append((head, v, is_stub))
    return out


def growth_check(series, years):
    """Every YoY change positive across the last `years` transitions?

    Needs years+1 annual points. Returns (passed, reason, detail_rows).
    """
    if len(series) < years + 1:
        return False, f"only {len(series)} annual periods, need {years + 1}", []

    window = series[-(years + 1):]

    if any(s[2] for s in window):
        return False, "partial/stub year in window", []

    # A zero or negative base makes the percentage meaningless, not "infinite growth".
    if any(s[1] <= 0 for s in window):
        return False, "non-positive sales in window", []

    rows, ok = [], True
    for (_, prev, _), (lbl, cur, _) in zip(window, window[1:]):
        pct = (cur - prev) / prev * 100.0
        rows.append((lbl, cur, pct))
        if pct <= 0:
            ok = False
    return ok, "" if ok else "a year declined", rows


def parse_pct(x):
    """'-29%' -> -29.0 ; '%' or '' -> None (Screener leaves the cell blank
    when the stock has less than that much price history)."""
    if not x:
        return None
    x = x.replace("%", "").replace(",", "").strip()
    try:
        return float(x)
    except ValueError:
        return None


def load():
    raw = json.loads((DATA / "screener_it_pl.json").read_text(encoding="utf-8"))
    returns_path = DATA / "screener_it_returns.json"
    returns = {}
    if returns_path.exists():
        rawret = json.loads(returns_path.read_text(encoding="utf-8"))
        returns = {k: parse_pct(v.get("r1")) for k, v in rawret.items()}
    return raw, returns


def main():
    raw, returns = load()
    rows3, rows5, skipped = [], [], []

    for name, rec in raw.items():
        if rec.get("err"):
            skipped.append((name, rec["err"]))
            continue

        mcap = parse_num(rec.get("m") or "")
        if mcap is None or mcap < MCAP_FLOOR_CR:
            continue

        series = annual_series(rec)
        url = "https://www.screener.in" + rec["href"]

        ok3, why3, det3 = growth_check(series, 3)
        if ok3:
            rows3.append({
                "Company": name,
                "Market Cap (Rs Cr)": mcap,
                "Period": f"{series[-4][0]} -> {series[-1][0]}",
                "Sales Growth Y1 %": round(det3[0][2], 2),
                "Sales Growth Y2 %": round(det3[1][2], 2),
                "Sales Growth Y3 %": round(det3[2][2], 2),
                "Latest Sales (Rs Cr)": det3[-1][1],
                "URL": url,
            })
        else:
            skipped.append((name, f"3y: {why3}"))

        ok5, _, det5 = growth_check(series, 5)
        if ok5:
            ret1y = returns.get(name)
            # "lost the most in last 1 year": only stocks actually down over 1Y.
            # Blank return = too little price history (recent listing) -> not a "loser".
            if ret1y is not None and ret1y < 0:
                rows5.append({
                    "Company": name,
                    "Market Cap (Rs Cr)": mcap,
                    "1Y Return %": ret1y,
                    "Period": f"{series[-6][0]} -> {series[-1][0]}",
                    **{f"Sales Growth Y{i+1} %": round(d[2], 2) for i, d in enumerate(det5)},
                    "Latest Sales (Rs Cr)": det5[-1][1],
                    "URL": url,
                })

    rows3.sort(key=lambda r: -r["Market Cap (Rs Cr)"])
    rows5.sort(key=lambda r: r["1Y Return %"])  # biggest loser first

    for fname, rows in (("it_growth_3y.csv", rows3), ("it_growth_5y_losers.csv", rows5)):
        if not rows:
            print(f"{fname}: no qualifying rows")
            continue
        p = DATA / fname
        with p.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"{fname}: {len(rows)} companies -> {p}")

    print(f"\nInput records: {len(raw)}  |  above Rs {MCAP_FLOOR_CR:.0f} Cr floor: "
          f"{sum(1 for r in raw.values() if not r.get('err') and (parse_num(r.get('m') or '') or 0) >= MCAP_FLOOR_CR)}")
    if not returns:
        print("NOTE: no screener_it_returns.json found - 1Y Return column is empty.")


if __name__ == "__main__":
    main()
