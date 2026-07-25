# Superstore Margin Console — Retail BI Dashboard

**Live demo:** `dashboard/index.html` (deploy to GitHub Pages — see below) · **Stack:** Python (pandas) · Plotly.js · vanilla JS · static HTML

## Problem statement
A US retailer's revenue grew every year from 2015–2018 — yet overall margin sat at 12.5% and nearly 1 in 5 order lines lost money. Leadership sees the sales trend; nobody sees *where profit leaks*. This dashboard is a profitability audit: it answers "which products, discounts, and regions are quietly funding growth with losses?"

## My approach
1. **Ingest & clean** (`src/clean_data.py`): a scripted, reproducible pipeline where every transformation writes to a decision log (`docs/cleaning_log.md`) — what was done *and why*.
2. **Model**: derive decision-ready fields — line-level profit margin, shipping lag, and **discount bands** (0% / 1–20% / 21–40% / 41%+) so a continuous variable becomes an actionable pricing lever.
3. **Aggregate** to a compact JSON (9 KB) consumed by a **static, single-file dashboard** — no backend, free hosting, instant load.

## Key decisions and why
- **Static Plotly.js over Power BI** — a public, link-accessible demo with zero licensing cost; interactivity (category filters, hover drill-down) preserved. Power BI public embedding requires a paid workspace.
- **Removed 505 duplicate rows** — identical order lines with different surrogate `row_id`s would have overstated revenue by ~5%. Duplicates were detected by comparing all business columns while ignoring the surrogate key.
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
data/processed/      cleaned output
src/clean_data.py    pipeline (generates data.json + cleaning log)
dashboard/index.html static interactive dashboard
docs/                cleaning_log.md · business_case.md
```

## Run / deploy
```bash
python src/clean_data.py                      # rebuild data + log
# deploy: push repo, enable GitHub Pages on /dashboard (or copy index.html to docs/)
```
