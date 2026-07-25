# Superstore Margin Console — Retail BI Dashboard

**Live demo:** https://lekanlawal1.github.io/project1-bi-dashboard/ · **Stack:** Python (pandas) · Plotly.js · vanilla JS · static HTML

## Problem statement
A US retailer's revenue grew every year from 2015–2018 — yet overall margin sat at 12.5% and nearly 1 in 5 order lines lost money. Leadership sees the sales trend; nobody sees *where profit leaks*. This dashboard is a profitability audit: it answers "which products, discounts, and regions are quietly funding growth with losses?"

## My approach
1. **Ingest & clean** (`src/clean_data.py`): a scripted, reproducible pipeline where every transformation writes to a decision log (`docs/cleaning_log.md`) — what was done *and why*.
2. **Model**: derive decision-ready fields — line-level profit margin, shipping lag, and **discount bands** (0% / 1–20% / 21–40% / 41%+) so a continuous variable becomes an actionable pricing lever.
3. **Export row-level data** (not just aggregates) into the dashboard's HTML, so every chart, KPI, and the product table below recompute **live in the browser** as you search or filter — no backend, free hosting, instant load.

## Key decisions and why
- **Static Plotly.js over Power BI** — a public, link-accessible demo with zero licensing cost; full client-side interactivity (search, cross-filtering, sortable tables) preserved. Power BI public embedding requires a paid workspace.
- **Dropped 806 trailing non-order rows** — the raw export is a CSV dump of a multi-sheet workbook (Orders / Returns / People); the Returns and People sheets got appended after the last order row and parsed as malformed, mostly-empty order rows. They were silently inflating downstream counts (they're why this project used to report "505 duplicate rows" — most of that was actually these fragments collapsing together, not real duplicates). Filtering on a valid numeric `Row ID` removes them cleanly; the true duplicate count is 1.
- **Removed 1 exact duplicate row** — identical order lines with different surrogate `row_id`s would double-count revenue. Duplicates were detected by comparing all business columns while ignoring the surrogate key.
- **Flag, don't drop, suspect rows** — rows failing a logistics validity check keep contributing to revenue KPIs (their dollar amounts are valid) but are excluded from shipping metrics only.
- **Kept outliers** — a $22.6K order is real revenue, not noise; charts use aggregates robust to skew instead of winsorizing the business away.
- **Margin, not raw profit, as the comparison unit** — raw profit rewards big categories; margin exposes the discount cliff.

## Results — 3 business insights
1. **The discount cliff:** average margin falls from **+33% (no discount)** to **−15% (21–40%)** to **−90% (41%+)**. No category survives a >20% discount. → *Recommend a 20% discount cap requiring manager approval above it.*
2. **Tables are a loss engine:** $207K in sales, **−$17.7K profit**, driven by a 26% average discount. Bookcases similar. → *Renegotiate supplier cost or de-emphasize in promotions.*
3. **Profit concentration:** Copiers, Phones and Accessories generate ~$142K of the $286K total profit on a fraction of volume; Central region underperforms every segment. → *Reallocate marketing spend toward Technology in West/East.*

Full one-page business case: [`docs/business_case.md`](docs/business_case.md)

## Repo structure
```
data/raw/            source CSV (public Superstore dataset)
data/processed/      cleaned output (git-ignored, regenerate locally)
src/clean_data.py    pipeline (generates data.json + cleaning log)
dashboard/index.html interactive dashboard (source of truth)
index.html            mirror of dashboard/index.html served at the repo root for GitHub Pages
docs/                cleaning_log.md · business_case.md
```

## Run / deploy
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python src/clean_data.py             # rebuild data/processed/, dashboard/data.json, docs/cleaning_log.md
cp dashboard/index.html index.html             # keep the Pages root copy in sync
```
Live at **https://lekanlawal1.github.io/project1-bi-dashboard/** — GitHub Pages is configured to serve `main` from `/` (root), which is why the root `index.html` mirror exists; `.nojekyll` disables Jekyll so the file is served as-is instead of being treated as a theme.
