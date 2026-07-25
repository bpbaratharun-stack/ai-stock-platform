#!/usr/bin/env python3
"""
screener_industry.py — reusable consistent-sales-growth screener for ANY
Screener.in industry.

Standard library only (urllib + html.parser). No pip install, no login:
Screener's sector-listing and company pages are readable anonymously.

WHAT IT DOES
------------
For a given industry (a Screener sector code such as IN0801 = IT):
  1. Reads every page of the sector listing to build the company universe
     (name, market cap).
  2. Keeps companies at/above --min-mcap (Rs Crore).
  3. Visits each company's page and reads the annual Sales row from the
     Profit & Loss table, plus the "1 Year" Stock Price CAGR.
  4. Writes, for each window in --years (default 3 and 5):
       <sector>_growth_<N>y.csv         : Sales up in EVERY one of the last N years
       <sector>_growth_<N>y_losers.csv  : same, but only names DOWN over 1 year,
                                          ranked worst-first.

"Consistent" means every individual year-on-year change is positive — stricter
than Screener's own Sales-growth CAGR fields, which hide down years.

USAGE
-----
  # discover the code for your industry, then screen it
  py screener_industry.py --list-sectors
  py screener_industry.py --sector IN0801 --min-mcap 1000
  py screener_industry.py --sector IN0801 --years 3 5 7 --min-mcap 500 --outdir data

BE POLITE
---------
Screener rate-limits aggressive crawling and will IP-ban a burst of parallel
requests. This tool is deliberately sequential with a --delay gap (default 2s)
and backs off on HTTP 429. Leave it slow.
"""

import argparse
import csv
import html as _html
import re
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

BASE = "https://www.screener.in"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

PERIOD_RE = re.compile(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}")


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def fetch(url, delay, retries=4):
    """GET url politely. Honours 429 with a long backoff. Returns HTML or None."""
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                html = r.read().decode("utf-8", "replace")
            time.sleep(delay)
            return html
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 20 * (attempt + 1)
                print(f"    429 rate-limited; backing off {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            print(f"    HTTP {e.code} for {url}", file=sys.stderr)
            return None
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"    network error ({e}); retrying", file=sys.stderr)
            time.sleep(5)
    return None


# --------------------------------------------------------------------------- #
# Parsers (stdlib html.parser)
# --------------------------------------------------------------------------- #
class SectorListParser(HTMLParser):
    """Pull (name, href, mcap) rows out of a sector-listing table."""

    def __init__(self):
        super().__init__()
        self.rows = []
        self.in_tbody = self.in_row = self.in_cell = False
        self.cell_idx = -1
        self.cur = None
        self.cell_text = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "tbody":
            self.in_tbody = True
        elif tag == "tr" and self.in_tbody:
            self.in_row = True
            self.cell_idx = -1
            self.cur = {"name": None, "href": None, "mcap": None}
        elif tag in ("td", "th") and self.in_row:
            self.in_cell = True
            self.cell_idx += 1
            self.cell_text = []
        elif tag == "a" and self.in_row and self.cur and self.cur["href"] is None:
            href = a.get("href", "")
            if href.startswith("/company/"):
                self.cur["href"] = href

    def handle_data(self, data):
        if self.in_cell:
            self.cell_text.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.in_cell:
            self.in_cell = False
            text = " ".join("".join(self.cell_text).split())
            if self.cur:
                if self.cur["href"] and self.cur["name"] is None and self.cell_idx == 1:
                    self.cur["name"] = text
                elif self.cell_idx == 4:  # Mar Cap column
                    self.cur["mcap"] = to_float(text)
        elif tag == "tr" and self.in_row:
            self.in_row = False
            if self.cur and self.cur["href"] and self.cur["name"]:
                self.rows.append(self.cur)
            self.cur = None
        elif tag == "tbody":
            self.in_tbody = False


class CompanyParser(HTMLParser):
    """From a company page, capture P&L period headers + Sales row, and the
    '1 Year' Stock Price CAGR."""

    def __init__(self):
        super().__init__()
        # profit-loss section state
        self.in_pl_section = False
        self.pl_depth = 0
        self.in_first_table = False
        self.seen_table = False
        self.in_thead = self.in_tbody = False
        self.in_th = self.in_td = False
        self.th_text = []
        self.headers = []            # list of period-header strings
        self.row_first_cell = []     # buffer for a body row's first cell
        self.in_body_row = False
        self.first_cell_done = False
        self.row_is_sales = False
        self.cur_val = []
        self.sales_vals = []
        self.capture_val = False

        # ranges-table (Stock Price CAGR) state
        self.in_ranges = False
        self.ranges_is_cagr = False
        self.ranges_cells = []
        self.in_ranges_cell = False
        self.ranges_cell_text = []
        self.ret_1y = None

    # -- section / table tracking --
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "section" and a.get("id") == "profit-loss":
            self.in_pl_section = True
            self.pl_depth = 1
            return
        if self.in_pl_section and tag == "section":
            self.pl_depth += 1

        if self.in_pl_section:
            if tag == "table" and not self.seen_table:
                self.in_first_table = True
                self.seen_table = True
            elif tag == "thead" and self.in_first_table:
                self.in_thead = True
            elif tag == "tbody" and self.in_first_table:
                self.in_tbody = True
            elif tag == "th" and self.in_thead:
                self.in_th = True
                self.th_text = []
            elif tag == "tr" and self.in_tbody:
                self.in_body_row = True
                self.first_cell_done = False
                self.row_is_sales = False
                self.row_first_cell = []
                self.sales_vals = []
            elif tag == "td" and self.in_body_row:
                if not self.first_cell_done:
                    self.in_td = True  # first (label) cell
                elif self.row_is_sales:
                    self.capture_val = True
                    self.cur_val = []

        # ranges tables live near the P&L section
        if tag == "table" and "ranges-table" in a.get("class", ""):
            self.in_ranges = True
            self.ranges_is_cagr = False
            self.ranges_cells = []
        elif self.in_ranges and tag in ("th", "td"):
            self.in_ranges_cell = True
            self.ranges_cell_text = []

    def handle_data(self, data):
        if self.in_th:
            self.th_text.append(data)
        if self.in_td:
            self.row_first_cell.append(data)
        if self.capture_val:
            self.cur_val.append(data)
        if self.in_ranges_cell:
            self.ranges_cell_text.append(data)

    def handle_endtag(self, tag):
        # ranges-table close handling
        if self.in_ranges and tag in ("th", "td") and self.in_ranges_cell:
            self.in_ranges_cell = False
            txt = " ".join("".join(self.ranges_cell_text).split())
            if "Stock Price CAGR" in txt:
                self.ranges_is_cagr = True
            self.ranges_cells.append(txt)
        elif tag == "table" and self.in_ranges:
            if self.ranges_is_cagr:
                for i, c in enumerate(self.ranges_cells):
                    if c.lower().startswith("1 year") and i + 1 < len(self.ranges_cells):
                        self.ret_1y = self.ranges_cells[i + 1]
            self.in_ranges = False

        if not self.in_pl_section:
            return

        if tag == "th" and self.in_th:
            self.in_th = False
            txt = " ".join("".join(self.th_text).split())
            if PERIOD_RE.match(txt):
                self.headers.append(txt)
        elif tag == "td" and self.in_td:
            self.in_td = False
            label = " ".join("".join(self.row_first_cell).split())
            self.first_cell_done = True
            # Manufacturing/services P&Ls call the top line "Sales"; banks, NBFCs
            # and other financials call it "Revenue". Accept either.
            if label.startswith("Sales") or label.startswith("Revenue"):
                self.row_is_sales = True
                self.topline_label = label.rstrip(" +")
        elif tag == "td" and self.capture_val:
            self.capture_val = False
            self.sales_vals.append(" ".join("".join(self.cur_val).split()))
        elif tag == "tr" and self.in_body_row:
            self.in_body_row = False
            if self.row_is_sales and self.sales_vals:
                # first matching Sales row wins
                if not getattr(self, "_sales_locked", False):
                    self.sales_final = list(self.sales_vals)
                    self._sales_locked = True
        elif tag == "thead" and self.in_thead:
            self.in_thead = False
        elif tag == "tbody" and self.in_tbody:
            self.in_tbody = False
            self.in_first_table = False
        elif tag == "section" and self.in_pl_section:
            self.pl_depth -= 1
            if self.pl_depth == 0:
                self.in_pl_section = False


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def to_float(x):
    if x is None:
        return None
    x = str(x).replace(",", "").replace("%", "").strip()
    if x in ("", "-"):
        return None
    try:
        return float(x)
    except ValueError:
        return None


def growth_check(values, years):
    """values: list of annual sales floats (oldest->newest, excluding TTM/stubs).
    Returns (passed, detail_pcts) for the last `years` YoY transitions."""
    if len(values) < years + 1:
        return False, []
    window = values[-(years + 1):]
    if any(v is None or v <= 0 for v in window):
        return False, []
    pcts, ok = [], True
    for prev, cur in zip(window, window[1:]):
        p = (cur - prev) / prev * 100.0
        pcts.append(round(p, 2))
        if p <= 0:
            ok = False
    return ok, pcts


def annual_points(headers, sales_vals):
    """Zip period headers with sales values, dropping stub (9m/3m/18m) years."""
    pts = []
    for h, v in zip(headers, sales_vals):
        if re.search(r"\b\d+m\b", h):   # partial-year column
            continue
        f = to_float(v)
        pts.append((h, f))
    return pts


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def list_sectors(delay, search=None):
    """Print the industry map from /market/, with company counts.

    Screener's /market/ page lists only the *leaf* industries. Every prefix of
    a path is itself a valid URL, so you can broaden the universe by truncating
    (see the hint printed at the end) — e.g.
        IN08/IN0801/IN080101/IN080101001  Computers - Software & Consulting (70)
        IN08/IN0801                       -> the whole IT sector (296)
    """
    html = fetch(BASE + "/market/", delay)
    if not html:
        print("Could not load /market/", file=sys.stderr)
        return

    # each row: <a href="/market/PATH/">Label</a> ... <td>company count</td>
    row_re = re.compile(
        r'href="/market/(IN[0-9]+(?:/IN[0-9]+)*)/?"[^>]*>\s*([^<]+?)\s*</a>\s*'
        r'</td>\s*<td[^>]*>\s*([0-9,]+)\s*</td>',
        re.S,
    )
    rows = []
    for m in row_re.finditer(html):
        path = m.group(1)
        label = _html.unescape(m.group(2).strip())
        count = to_float(m.group(3))
        rows.append((path, label, int(count) if count else 0))

    if not rows:
        print("No industry links found (page markup may have changed).", file=sys.stderr)
        return

    if search:
        needle = search.lower()
        rows = [r for r in rows if needle in r[1].lower()]
        if not rows:
            print(f"Nothing matched {search!r}. Run without --search to see all.")
            return

    rows.sort(key=lambda r: r[1].lower())
    print(f"{'PATH (pass to --sector)':<38} {'~COS':>5}  INDUSTRY")
    for path, label, count in rows:
        print(f"{path:<38} {count:>5}  {label}")

    print(f"\n{len(rows)} industries listed.")
    print("~COS is Screener's own summary count; the actual listing is usually")
    print("somewhat larger (e.g. Pharmaceuticals: 158 here, 218 on the page).")
    print("\nTIP: these are the narrowest (leaf) industries. Drop path segments")
    print("to widen the universe -- every prefix is a valid sector:")
    print("     IN06/IN0601/IN060101/IN060101001  ->  218 cos (Pharmaceuticals)")
    print("     IN06/IN0601                       ->  331 cos (all Healthcare)")
    print("     IN08/IN0801                       ->  296 cos (all Information Technology)")


def crawl_universe(sector, delay, min_mcap):
    """Page through the sector listing; return companies >= min_mcap."""
    companies, page = [], 1
    while True:
        url = f"{BASE}/market/{sector}/?page={page}"
        html = fetch(url, delay)
        if not html:
            break
        p = SectorListParser()
        p.feed(html)
        if not p.rows:
            break
        companies.extend(p.rows)
        # Screener shows "page X of Y"; stop when we've passed the last page.
        m = re.search(r"page\s+(\d+)\s+of\s+(\d+)", html, re.I)
        print(f"  sector page {page}"
              + (f" of {m.group(2)}" if m else "")
              + f": +{len(p.rows)} companies")
        if m and page >= int(m.group(2)):
            break
        page += 1
        if page > 100:  # safety
            break
    kept = [c for c in companies if c["mcap"] is not None and c["mcap"] >= min_mcap]
    return companies, kept


def scrape_company(href, delay):
    """Return dict with headers, sales values, 1Y return — or None."""
    for path in company_urls(href):
        html = fetch(BASE + path, delay)
        if not html:
            continue
        cp = CompanyParser()
        cp.feed(html)
        sales = getattr(cp, "sales_final", None)
        if cp.headers and sales:
            return {"headers": cp.headers, "sales": sales, "ret1y": cp.ret1y_value()}
    return None


def company_urls(href):
    """Try the URL exactly as the sector listing gives it FIRST — that is
    Screener's own default (consolidated where its history is meaningful,
    standalone otherwise) — then fall back to the alternate statement.

    This matters: some companies (e.g. Zaggle) have a short consolidated
    history but a long standalone one. Forcing consolidated would silently
    truncate the series and drop them from multi-year growth tests.
    """
    base = href.split("#")[0].rstrip("/")
    if base.endswith("/consolidated"):
        std = base[: -len("/consolidated")]
        return [base + "/", std + "/"]
    return [base + "/", base + "/consolidated/"]


# small shim so CompanyParser exposes the parsed 1Y return cleanly
def _ret1y_value(self):
    return self.ret_1y
CompanyParser.ret1y_value = _ret1y_value


def write_csv(path, rows):
    if not rows:
        print(f"  {path.name}: no qualifying companies")
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"  {path.name}: {len(rows)} companies")


def run(sector, years, min_mcap, delay, outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    # sector paths contain "/"; use the leaf code as a filesystem-safe prefix
    tag = sector.strip("/").split("/")[-1]
    print(f"Sector {sector}: building universe (min mcap Rs {min_mcap:.0f} Cr)...")
    all_c, kept = crawl_universe(sector, delay, min_mcap)
    print(f"  universe: {len(all_c)} companies, {len(kept)} above floor\n")
    if not kept:
        print("Nothing to scan. Check the sector code with --list-sectors.")
        return

    print(f"Reading financials for {len(kept)} companies "
          f"(~{len(kept) * delay / 60:.1f} min at {delay}s/req)...")
    records = []
    for i, c in enumerate(kept, 1):
        data = scrape_company(c["href"], delay)
        if not data:
            print(f"  [{i}/{len(kept)}] {c['name']}: no data", file=sys.stderr)
            continue
        pts = annual_points(data["headers"], data["sales"])
        records.append({
            "name": c["name"], "mcap": c["mcap"], "href": c["href"],
            "pts": pts, "ret1y": to_float(data["ret1y"]),
        })
        if i % 10 == 0:
            print(f"  [{i}/{len(kept)}] ...")
    print(f"  got financials for {len(records)} companies\n")

    for n in years:
        grow, losers = [], []
        for r in records:
            vals = [v for _, v in r["pts"]]
            ok, pcts = growth_check(vals, n)
            if not ok:
                continue
            win = r["pts"][-(n + 1):]
            row = {
                "Company": r["name"],
                "Market Cap (Rs Cr)": r["mcap"],
                "1Y Return %": r["ret1y"] if r["ret1y"] is not None else "",
                "Period": f"{win[0][0]} -> {win[-1][0]}",
                **{f"Sales Growth Y{k+1} %": pcts[k] for k in range(n)},
                "Latest Sales (Rs Cr)": win[-1][1],
                "URL": BASE + r["href"],
            }
            grow.append(row)
            if r["ret1y"] is not None and r["ret1y"] < 0:
                losers.append(row)
        grow.sort(key=lambda x: -x["Market Cap (Rs Cr)"])
        losers.sort(key=lambda x: x["1Y Return %"])
        print(f"{n}-year windows:")
        write_csv(outdir / f"{tag}_growth_{n}y.csv", grow)
        write_csv(outdir / f"{tag}_growth_{n}y_losers.csv", losers)


def main():
    ap = argparse.ArgumentParser(description="Consistent sales-growth screener for a Screener.in industry.")
    ap.add_argument("--sector", help="Screener sector code, e.g. IN0801 (IT). Use --list-sectors to find it.")
    ap.add_argument("--list-sectors", action="store_true", help="Print industry paths (with company counts) and exit.")
    ap.add_argument("--search", help="With --list-sectors, filter industries by name, e.g. --search pharma")
    ap.add_argument("--years", type=int, nargs="+", default=[3, 5], help="Growth windows (default: 3 5).")
    ap.add_argument("--min-mcap", type=float, default=1000.0, help="Market-cap floor in Rs Crore (default 1000).")
    ap.add_argument("--delay", type=float, default=2.0, help="Seconds between requests (default 2.0). Keep it polite.")
    ap.add_argument("--outdir", type=Path, default=Path(__file__).parent / "data", help="Output directory.")
    args = ap.parse_args()

    if args.list_sectors:
        list_sectors(args.delay, args.search)
        return
    if not args.sector:
        ap.error("give --sector CODE (or --list-sectors to discover it)")
    run(args.sector.strip("/"), args.years, args.min_mcap, args.delay, args.outdir)


if __name__ == "__main__":
    main()
