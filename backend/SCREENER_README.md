# Screener.in industry growth screener

`screener_industry.py` — a self-contained, reusable tool that finds companies in
any Screener.in industry with **consistent year-by-year sales growth**, and flags
the ones the market has beaten down over the last year.

- **No dependencies.** Python standard library only (`urllib`, `html.parser`).
- **No login.** Screener's sector and company pages read anonymously.
- **Any industry.** Pass a sector path; discover paths with `--list-sectors`.

## Quick start

```bash
# 1. Find your industry (add --search to filter)
py screener_industry.py --list-sectors --search pharma

# 2. Screen it (--min-mcap is in Rs Crore)
py screener_industry.py --sector IN06/IN0601 --min-mcap 1000

# custom growth windows and output dir
py screener_industry.py --sector IN08/IN0801 --years 3 5 7 --min-mcap 500 --outdir data
```

## Choosing a sector: narrow vs broad

`--list-sectors` prints the **narrowest (leaf) industries**. Screener's paths are
hierarchical, and **every prefix is itself a valid sector** — so you widen the
universe by dropping segments from the right:

| Path | Universe |
|------|----------|
| `IN06/IN0601/IN060101/IN060101001` | 218 — Pharmaceuticals only |
| `IN06/IN0601/IN060101` | 224 — + related |
| `IN06/IN0601` | 331 — all Healthcare |

Same for IT: the leaf `IN08/IN0801/IN080101/IN080101001` is ~70 companies, while
`IN08/IN0801` is the full 296-company Information Technology sector (what the
delivered IT lists used).

**Common starting points** (broad sector level):

| Path | Sector |
|------|--------|
| `IN08/IN0801` | Information Technology |
| `IN06/IN0601` | Healthcare / Pharma |
| `IN05/IN0501` | Financials (banks, NBFCs) |
| `IN02/IN0201` | Automobiles & components |
| `IN01/IN0101` | Chemicals |

Run `--list-sectors` for the full 188-industry map. Note the `~COS` column is
Screener's own summary count and reads a bit low versus the actual listing.

## What it produces

For each window `N` in `--years`, two CSVs land in `--outdir` (default `data/`),
prefixed with the industry's leaf code (e.g. `IN0801_`):

| File | Contents |
|------|----------|
| `<code>_growth_<N>y.csv` | Sales grew in **every one** of the last N years. Sorted by market cap. |
| `<code>_growth_<N>y_losers.csv` | Same growth filter, but only names **down over 1 year**, worst-first. |

Columns: company, market cap, 1-year price return, the period window, each year's
sales-growth %, latest sales, and the Screener URL.

## Definitions & choices (important)

- **"Consistent growth" = every individual year-on-year change is positive.** This
  is stricter than Screener's built-in `Sales growth 3Yr/5Yr` fields, which are
  CAGRs and hide a down year in the middle. (This is why e.g. Wipro and Tech
  Mahindra are excluded from IT — a single down year fails them.)
- **Top line varies by sector.** Manufacturing/services P&Ls label it `Sales`;
  banks, NBFCs and other financials label it `Revenue`. The tool accepts either,
  so financial sectors screen correctly too.
- **Consolidated vs standalone:** the tool uses whichever statement Screener links
  by default in the listing, falling back to the other. Some firms have a short
  consolidated history but a long standalone one; honoring Screener's default
  avoids silently truncating the series.
- **Fiscal years are not aligned across companies** (Dec/Mar/Jun year-ends). Each
  company is measured against its own prior year; the `Period` column shows the
  exact window used. Partial "stub" years (e.g. `9m`, `3m`) are dropped.
- **Market-cap floor** removes the sector's shell-company tail. Default Rs 1000 Cr.

## Be polite — this matters

Screener rate-limits and will **temporarily IP-ban** a burst of parallel requests
(this happened during development). The tool is deliberately **sequential** with a
`--delay` gap (default 2s) and backs off on HTTP 429. Leave it slow. A ~300-company
sector takes a few minutes; that's fine.

## Not financial advice

These are mechanical screens, not recommendations — especially the "losers" list,
which surfaces both potential value and companies falling for good reasons. Do your
own diligence.

---

### Other files

- `it_growth_3y.csv`, `it_growth_5y_losers.csv` — the original IT deliverable.
- `screener_growth.py` + `data/screener_it_*.json` — earlier scrape-then-analyze
  pipeline (cached raw IT data + analysis). Superseded by `screener_industry.py`,
  kept as provenance for the IT lists.

---

# Weekly momentum screener

`weekly_momentum.py` — finds stocks **rising this week on a volume surge**, with
supporting trend / relative-strength / breakout factors. Runs off your local
`data/panel.parquet` (daily NSE bhavcopy), not Screener.in.

Uses the project venv (pandas/pyarrow):

```bash
./venv/Scripts/python.exe weekly_momentum.py                       # this week
./venv/Scripts/python.exe weekly_momentum.py --complete-weeks-only # skip a partial week
./venv/Scripts/python.exe weekly_momentum.py --top 0               # export all qualifiers
./venv/Scripts/python.exe weekly_momentum.py --relaxed             # rank all, gates advisory
./venv/Scripts/python.exe weekly_momentum.py --backtest             # validate the logic
```

Output: `data/weekly_momentum_<week-end>_<full|partial>.csv`

## The logic

A stock must pass **all nine** gates — the point is that a rise backed by
participation *and* trend is the kind that tends to persist:

| # | Gate | Why |
|---|------|-----|
| 1 | Weekly return > 0 | price actually rose |
| 2 | Volume surge ≥ 1.5× | conviction, vs its own 10-week median **per trading day** |
| 3 | Close strength ≥ 0.6 | closed in top 40% of the weekly range — buyers held, rally didn't fade |
| 4 | Close > 10w MA > 30w MA | a real uptrend, not a bounce inside a downtrend |
| 5 | 4w and 12w returns > 0 | the week fits an existing advance |
| 6 | Within 25% of 52w high | breakout character, not bottom-fishing |
| 7 | Beats market 4w return | peer-relative, so a broad rally doesn't flatter everything |
| 8 | Weekly gain ≤ 40% | rejects circuit-locked/news spikes you can't get filled on |
| 9 | 4w gain ≤ 100% | rejects parabolic, late-stage moves |

Plus universe filters: price ≥ ₹20, median daily turnover ≥ ₹5 cr, ≥ 40 weeks of
history, ETFs/index funds excluded.

Survivors are ranked 0–100 by a **percentile blend** (so one outlier can't
dominate): weekly return 20%, volume surge 20%, relative strength 20%,
12-week momentum 15%, close strength 15%, proximity to 52w high 10%.

**Volume is compared per trading day, not per week.** Indian weeks are often
holiday-shortened, and raw weekly totals would understate a 4-day week's surge by
~20% purely from the missing session.

## Does it work? (`--backtest`)

Re-runs the gates on every historical week and compares the screen's **median**
pick to the universe **median** that same week — both entered at the **next
week's open** (a tradeable fill, not the close we screen on):

```
weeks tested            : 193  (avg 41 picks/week)
screen MEDIAN pick      : +0.13%
market MEDIAN           : +0.08%
average EDGE (med-med)  : +0.05%
weeks beating market    : 54%
(screen MEAN pick, ref) : +0.88%  — skew gap +0.75%
```

**On fair terms the edge is ~zero.** An earlier version compared the screen's
*mean* to the market *median* and entered at the signal-week close; that showed
"+0.98% excess, 64% of weeks," but ~0.75% of it was pure mean-vs-median skew and
the rest an untradeable fill. Matching the statistic (median-to-median) and using
a next-open entry collapses it to +0.05% / 54% — a coin flip. Treat this screen as
a descriptive momentum filter with **no demonstrated forward-return edge**, which
is exactly what the dashboard's disclaimer already says.

## Data freshness matters

The screen is only as current as `panel.parquet`. If the latest week has fewer
than 5 sessions the tool prints a **PARTIAL** warning: volume comparison still
works (it's per-day), but the close/high/low are not final, so a stock can give
the move back on the missing day. Re-run after the week closes, or use
`--complete-weeks-only`.

**Not investment advice** — a mechanical screen, not a recommendation.

---

# Earnings-proximity flag

`nse_results_dates.py` fetches each symbol's historical quarterly-results dates
from NSE's public board-meeting API (no login; cookie-primed; cached to
`data/nse_results_dates.json`). Both breakout scanners then carry a
`near_results` flag — **True if the breakout week is within ±1 week of a results
date** — and the VCP `--backtest` splits its trades by it.

```bash
./venv/Scripts/python.exe nse_results_dates.py    # one-time ~9 min fetch, cached
```

## Why: is the breakout "edge" just earnings drift?

Every hand-checked breakout chart had a results marker next to the move. The
backtest now answers it directly (VCP, week-clustered `avg_rule_pct`):

```
earnings-date coverage : 100% of closed trades (415 near / 1040 away)
near earnings : +2.30% / week
away from it  : +0.69% / week
```

**Earnings-adjacent breakouts return ~3× the others.** So the VCP signal's
(already thin, benchmark-lagging) performance is disproportionately earnings
drift wearing a technical costume — the away-from-earnings breakout on its own is
barely distinguishable from noise. This does **not** rescue the screen (it still
trails its universe by ~1.5%), but it tells you *where* the little that's there
comes from, and warns that a "clean" technical breakout with no results nearby is
the weaker setup, not the stronger one.

Live lists (`weekly_momentum_*` and `breakout_vcp_*`) and the dashboard tabs show
the flag per name, so you can see at a glance whether this week's breakout is
riding an earnings release.
