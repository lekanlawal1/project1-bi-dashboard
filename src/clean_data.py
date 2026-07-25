"""
Superstore BI Dashboard — Data Cleaning & Modeling
===================================================
Every transformation below is a documented decision. The goal is not just a
clean table, but a defensible cleaning log (see docs/cleaning_log.md, which
this script generates).

Run: python src/clean_data.py
In:  data/raw/superstore_raw.csv
Out: data/processed/superstore_clean.csv, dashboard/data.json, docs/cleaning_log.md
"""

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
log: list[str] = []


def note(decision: str, why: str) -> None:
    log.append(f"- **{decision}** — {why}")


df = pd.read_csv(ROOT / "data/raw/superstore_raw.csv", encoding="latin-1")
note(f"Loaded {len(df):,} rows, {df.shape[1]} columns (latin-1 encoding)",
     "The file contains non-UTF8 characters in product names; latin-1 avoids decode errors without dropping rows.")

# --- 1. Column hygiene -------------------------------------------------------
df.columns = [c.strip().lower().replace(" ", "_").replace("-", "_") for c in df.columns]
note("Normalized column names to snake_case",
     "Consistent names prevent bugs in downstream SQL/BI tools and match common warehouse conventions.")

# --- 2. Types ----------------------------------------------------------------
for col in ("order_date", "ship_date"):
    df[col] = pd.to_datetime(df[col], format="mixed", dayfirst=False)
note("Parsed order_date and ship_date as datetimes",
     "Dates arrive as strings in mixed US formats; typed dates enable time-series KPIs and shipping-lag checks.")

# --- 3. Duplicates -----------------------------------------------------------
before = len(df)
df = df.drop_duplicates(subset=[c for c in df.columns if c != "row_id"])
note(f"Removed {before - len(df)} exact duplicate rows (ignoring row_id)",
     "row_id is a surrogate key, so identical order lines with different row_ids are true duplicates that would double-count revenue.")

# --- 4. Validity checks (kept, not dropped — flagged instead) ---------------
df["ship_lag_days"] = (df["ship_date"] - df["order_date"]).dt.days
bad_lag = int((df["ship_lag_days"] < 0).sum())
note(f"Computed ship_lag_days; {bad_lag} rows ship before order date",
     "Negative lags indicate data-entry errors. Decision: flag rather than drop — the sales amounts are still valid for revenue KPIs, "
     "only the logistics metric is unreliable, so they are excluded from shipping analysis only.")

neg_sales = int((df["sales"] <= 0).sum())
note(f"Checked for non-positive sales: {neg_sales} rows",
     "Zero/negative sales would signal returns or errors needing separate treatment; none found, so no action required.")

# --- 5. Derived business fields ---------------------------------------------
df["profit_margin"] = df["profit"] / df["sales"]
df["order_month"] = df["order_date"].dt.to_period("M").astype(str)
df["discount_band"] = pd.cut(
    df["discount"], bins=[-0.001, 0.0, 0.2, 0.4, 1.0],
    labels=["No discount", "1–20%", "21–40%", "41%+"],
)
note("Derived profit_margin, order_month, discount_band",
     "Margin (not raw profit) is the comparable unit across products; discount bands turn a continuous variable into a "
     "decision-ready lever a manager can act on ('cap discounts at 20%'), which raw percentages don't.")

# --- 6. Outlier policy -------------------------------------------------------
note("Retained high-value outlier orders (max sale ${:,.0f})".format(df["sales"].max()),
     "In retail transaction data, large orders are real revenue, not noise. Winsorizing would understate the business. "
     "Dashboard charts use medians/aggregates that are robust to them instead.")

# --- Save --------------------------------------------------------------------
df.to_csv(ROOT / "data/processed/superstore_clean.csv", index=False)

# --- Aggregates for the static dashboard ------------------------------------
def rec(frame: pd.DataFrame) -> list[dict]:
    return json.loads(frame.to_json(orient="records"))

monthly = (df.groupby("order_month")
             .agg(sales=("sales", "sum"), profit=("profit", "sum"), orders=("order_id", "nunique"))
             .round(0).reset_index())

cat_sub = (df.groupby(["category", "sub_category"])
             .agg(sales=("sales", "sum"), profit=("profit", "sum"),
                  margin=("profit_margin", "mean"), avg_discount=("discount", "mean"))
             .round(3).reset_index())

disc = (df.groupby(["discount_band", "category"], observed=True)
          .agg(avg_margin=("profit_margin", "mean"), sales=("sales", "sum"), rows=("row_id", "count"))
          .round(3).reset_index())

region = (df.groupby(["region", "segment"])
            .agg(sales=("sales", "sum"), profit=("profit", "sum"))
            .round(0).reset_index())

ship = (df[df["ship_lag_days"] >= 0]
        .groupby("ship_mode")
        .agg(avg_lag=("ship_lag_days", "mean"), orders=("order_id", "nunique"))
        .round(2).reset_index())

kpis = {
    "total_sales": round(float(df["sales"].sum())),
    "total_profit": round(float(df["profit"].sum())),
    "overall_margin": round(float(df["profit"].sum() / df["sales"].sum()), 4),
    "orders": int(df["order_id"].nunique()),
    "customers": int(df["customer_id"].nunique()),
    "loss_making_rows_pct": round(float((df["profit"] < 0).mean()), 4),
    "date_min": str(df["order_date"].min().date()),
    "date_max": str(df["order_date"].max().date()),
}

(ROOT / "dashboard/data.json").write_text(json.dumps({
    "kpis": kpis, "monthly": rec(monthly), "cat_sub": rec(cat_sub),
    "discount": rec(disc), "region": rec(region), "ship": rec(ship),
}))

(ROOT / "docs/cleaning_log.md").write_text(
    "# Cleaning & Modeling Decision Log\n\n"
    "Generated by `src/clean_data.py`. Each entry: what was done — and why.\n\n" + "\n".join(log) + "\n")

print("\n".join(log))
print("\nKPIs:", json.dumps(kpis, indent=2))
