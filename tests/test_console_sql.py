"""The console's SQL (console/core.js), run by DuckDB on the raw Superstore file, must agree with an
independent pandas calculation. The raw file is messy on purpose: it ends with 806 rows from other
sheets of the workbook, and has one exact duplicate line."""
import json
import subprocess
from pathlib import Path

import duckdb
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "superstore_raw.csv"


def dump(filters=None):
    out = subprocess.run(["node", str(ROOT / "tests" / "sql_dump.js"), str(RAW), json.dumps(filters or {})],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


@pytest.fixture(scope="module")
def con():
    s = dump()
    c = duckdb.connect()
    c.execute(s["load"])
    c.execute(s["clean"])
    return c


@pytest.fixture(scope="module")
def truth():
    df = pd.read_csv(RAW, encoding="utf-8", dtype=str)
    df = df[pd.to_numeric(df["Row ID"], errors="coerce").notna()]
    df = df.drop(columns=["Row ID"]).drop_duplicates()
    for c in ("Sales", "Profit", "Discount", "Quantity"):
        df[c] = pd.to_numeric(df[c])
    df["date"] = pd.to_datetime(df["Order Date"], format="%m/%d/%Y")
    return df


def test_columns_are_recognised():
    s = dump()
    m = s["map"]
    assert (m["date"], m["sales"], m["profit"], m["discount"]) == ("Order Date", "Sales", "Profit", "Discount")
    assert (m["category"], m["subcategory"], m["product"], m["region"]) == ("Category", "Sub-Category", "Product Name", "Region")
    assert s["fmt"] == "%m/%d/%Y"


def test_data_check_finds_the_mess(con, truth):
    q = dict(zip(["rows_read", "rows_unusable", "duplicates", "rows_used"], con.execute(dump()["quality"]).fetchone()[:4]))
    assert q["rows_unusable"] == 806            # the Returns and People sheets appended to the export
    assert q["duplicates"] == 1
    assert q["rows_used"] == len(truth) == 9993


def test_headline_numbers(con, truth):
    sales, profit, margin = con.execute(dump()["kpi"]).fetchone()[:3]
    assert sales == pytest.approx(truth["Sales"].sum())
    assert profit == pytest.approx(truth["Profit"].sum())
    assert margin == pytest.approx(truth["Profit"].sum() / truth["Sales"].sum())


def test_discount_cliff(con, truth):
    rows = {r[0]: r for r in con.execute(dump()["discount"]).fetchall()}
    over = truth[truth["Discount"] > 0.5]
    assert rows["50+"][3] == pytest.approx(over["Profit"].sum())
    none = truth[truth["Discount"] == 0]
    assert rows["none"][1] == len(none)
    assert rows["none"][4] > 0 > rows["50+"][4]          # margin positive without discount, negative over 50%


def test_tables_lose_money(con, truth):
    rows = {r[0]: r for r in con.execute(dump()["sub"]).fetchall()}
    assert rows["Tables"][2] == pytest.approx(truth.loc[truth["Sub-Category"] == "Tables", "Profit"].sum())
    assert rows["Tables"][2] < 0


def test_pareto_and_losers(con, truth):
    per = truth.groupby("Product Name")["Profit"].sum().sort_values(ascending=False)
    pareto = con.execute(dump()["pareto"]).fetchall()
    assert pareto[0][1] == per.index[0]
    assert pareto[0][5] == pytest.approx(per[per > 0].sum())
    losers = con.execute(dump()["losers"]).fetchall()
    assert losers[0][0] == per.index[-1]


def test_filters_apply_everywhere(con, truth):
    f = {"category": "Furniture", "region": "West", "from": "2017-01", "to": "2017-12"}
    s = dump(f)
    sel = truth[(truth["Category"] == "Furniture") & (truth["Region"] == "West") & (truth["date"].dt.year == 2017)]
    assert con.execute(s["kpi"]).fetchone()[0] == pytest.approx(sel["Sales"].sum())
    # a chart skips the filter on its own dimension so it still shows every bar
    cats = [r[0] for r in con.execute(s["category"]).fetchall()]
    assert set(cats) == {"Furniture", "Office Supplies", "Technology"}


SHOP = ROOT / "tests" / "fixtures" / "shop_sample.csv"


def test_shopify_export(tmp_path):
    """Order names start with '#', which DuckDB can mistake for comments; costs are per unit and
    discounts in dollars. All three orders must survive, and the totals row must be skipped."""
    script = f"""
const C = require({json.dumps(str(ROOT / 'console' / 'core.js'))});
const map = {{ date: "Created at", sales: "Lineitem price", cost: "Cost per item", quantity: "Lineitem quantity",
  discount: "Discount Amount", product: "Lineitem name", category: "Product type", region: "Billing Province", order_id: "Name" }};
console.log(JSON.stringify({{ load: C.loadSQL({json.dumps(str(SHOP))}), clean: C.cleanSQL(map, {{ dateFormat: "%Y-%m-%d", costKind: "unit", discountKind: "amount" }}), quality: C.QUALITY_SQL }}));
"""
    s = json.loads(subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout)
    c = duckdb.connect()
    c.execute(s["load"])
    c.execute(s["clean"])
    rows_read, unusable, _, used = c.execute(s["quality"]).fetchone()[:4]
    assert (rows_read, unusable, used) == (4, 1, 3)
    pan = c.execute("SELECT profit, discount FROM sales WHERE order_id = '#1003'").fetchone()
    assert pan[0] == pytest.approx(29.40 - 31.00)            # sold at a loss after a $12.60 discount
    assert pan[1] == pytest.approx(12.60 / 42.00)            # 30% off the pre-discount price
    two = c.execute("SELECT profit FROM sales WHERE order_id = '#1001'").fetchone()[0]
    assert two == pytest.approx(84.00 - 2 * 31.00)           # cost per unit times quantity


def test_minimal_file_runs_every_chart(tmp_path):
    """Only a date, a product, sales and profit: no category, region, customer or order number.
    Every chart's SQL must still run, and each line counts as one order."""
    f = tmp_path / "minimal.csv"
    f.write_text("Date,Product,Sales,Profit\n2026-08-01,Mug,12.00,4.00\n2026-08-01,Mug,12.00,4.00\n2026-08-02,Lamp,40.00,-3.00\n")
    s = dump_for(f)
    c = duckdb.connect()
    c.execute(s["load"])
    c.execute(s["clean"])
    for k in ("kpi", "discount", "category", "region", "heatmap", "pareto", "losers", "monthly"):
        c.execute(s[k]).fetchall()
    sales, profit, _, orders = c.execute(s["kpi"]).fetchone()[:4]
    assert (sales, profit, orders) == (pytest.approx(52.0), pytest.approx(1.0), 2)   # the duplicate line is dropped


def dump_for(path):
    out = subprocess.run(["node", str(ROOT / "tests" / "sql_dump.js"), str(path), "{}"], capture_output=True, text=True, check=True).stdout
    return json.loads(out)
