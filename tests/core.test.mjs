// node --test tests/core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../console/core.js");

test("a Shopify orders export is recognised", () => {
  const headers = ["Name", "Email", "Paid at", "Subtotal", "Discount Amount", "Lineitem quantity", "Lineitem name",
    "Lineitem price", "Billing Province", "Vendor", "Created at"];
  const rows = [{ "Name": "#1001", "Email": "a@b.ca", "Paid at": "2024-03-05 14:22:10 -0500", "Subtotal": "84.00",
    "Discount Amount": "12.00", "Lineitem quantity": "2", "Lineitem name": "Cast iron pan", "Lineitem price": "42.00",
    "Billing Province": "ON", "Vendor": "Lodge", "Created at": "2024-03-05 14:20:01 -0500" }];
  const m = C.guessMapping(headers, rows);
  assert.equal(m.date, "Created at");
  assert.equal(m.product, "Lineitem name");
  assert.equal(m.region, "Billing Province");
  assert.equal(m.discount, "Discount Amount");
  assert.equal(m.quantity, "Lineitem quantity");
  assert.ok(m.sales);                                  // the person confirms which money column on screen
});

test("text columns are never guessed as money", () => {
  const m = C.guessMapping(["Sales rep", "Amount"], [{ "Sales rep": "Jo", "Amount": "$12.50" }]);
  assert.equal(m.sales, "Amount");
});

test("day-first dates are recognised when a day is over 12", () => {
  assert.equal(C.detectDateFormat(["03/04/2024", "25/04/2024"]).fmt, "%d/%m/%Y");
  assert.equal(C.detectDateFormat(["03/04/2024", "04/25/2024"]).fmt, "%m/%d/%Y");
});

test("money formats", () => {
  assert.equal(C.parseNumber("$1,234.50"), 1234.5);
  assert.equal(C.parseNumber("(12.00)"), -12);
  assert.equal(C.parseNumber("N/A"), null);
  assert.equal(C.parseNumber(""), null);
});

test("filters build one WHERE clause, and a chart can skip its own", () => {
  const w = C.where({ category: "Furniture", region: "O'Hare", band: "20-30", from: "2024-01", to: "2024-06" }, ["region"]);
  assert.match(w, /category = 'Furniture'/);
  assert.doesNotMatch(w, /region/);
  assert.match(w, /discount > 0.20 AND discount <= 0.30/);
  assert.match(C.where({ region: "O'Hare" }), /'O''Hare'/);      // quotes are escaped
});

test("findings are plain sentences from the numbers", () => {
  const f = C.findings({
    hasProfit: true,
    kpi: { sales: 120, prev_sales: 100, margin: 0.09, prev_margin: 0.22 },
    discount: [{ band: "none", lines: 10, profit: 50 }, { band: "20-30", lines: 4, profit: -30 }, { band: "30-50", lines: 2, profit: -20 }],
    category: [{ name: "Cookware", sales: 500, profit: -40, avg_discount: 0.26 }],
    pareto: Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, profit: 20 - i * 2, running: 0, positive_total: 110, products: 20 }))
      .map((p, i, a) => ({ ...p, running: a.slice(0, i + 1).reduce((s, x) => s + x.profit, 0) })),
    losers: [{ product: "Cast iron pan", profit: -40, sales: 500 }],
  });
  const text = f.map((x) => x.text).join(" ");
  assert.match(text, /Margin fell from 22% to 9% compared with the previous period, even though sales grew/);
  assert.match(text, /Discounts of 20 to 30% and 30 to 50% lost \$50 across 6 lines/);
  assert.match(text, /Cookware lost \$40/);
  assert.match(text, /make 80% of the profit/);
  assert.match(text, /Cast iron pan lost \$40/);
});

test("no profit column: one honest sentence instead of margin findings", () => {
  const f = C.findings({ hasProfit: false });
  assert.equal(f.length, 1);
  assert.match(f[0].text, /no profit or cost column/);
});

test("a point-of-sale item export (Square style) maps itself; no cost column means no margins", () => {
  const headers = ["Date", "Time", "Category", "Item", "Qty", "Gross Sales", "Discounts", "Net Sales", "Tax", "Transaction ID", "Location"];
  const rows = [{ Date: "2025-03-05", Time: "12:01:00", Category: "Coffee", Item: "Latte", Qty: "1", "Gross Sales": "$5.25",
    Discounts: "-$0.50", "Net Sales": "$4.75", Tax: "$0.62", "Transaction ID": "abc", Location: "Queen St" }];
  const m = C.guessMapping(headers, rows);
  assert.equal(m.date, "Date");
  assert.equal(m.sales, "Net Sales");                   // after discounts, which is what was actually earned
  assert.equal(m.product, "Item");
  assert.equal(m.region, "Location");
  assert.equal(m.discount, "Discounts");
  assert.equal(m.profit, undefined);
  assert.equal(m.cost, undefined);
});
