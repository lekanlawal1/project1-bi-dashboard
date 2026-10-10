/* Money Snitch, margins tab, core: everything that decides what the numbers mean. No DOM here, so the tests
   run it in Node: column detection, date formats, the SQL that cleans an upload into one tidy
   `sales` table, the SQL behind every chart, and the plain-English findings.

   Every chart on the page shows the exact SQL it ran, so this file is also the documentation. */

const MarginCore = (() => {
  // ---------------------------------------------------------------- column roles
  // role -> header words that usually mean it (lowercase, matched against a cleaned header)
  const ROLES = [
    { key: "date", label: "Order date", required: true, words: ["order date", "created at", "date", "order_date", "invoice date", "transaction date", "paid at", "day"] },
    { key: "sales", label: "Sales (revenue)", required: true, words: ["sales", "net sales", "revenue", "lineitem price", "total", "amount", "line total", "subtotal", "gross sales", "item revenue"] },
    { key: "profit", label: "Profit", words: ["profit", "gross profit", "margin $", "net profit"] },
    { key: "cost", label: "Total cost", words: ["cost", "total cost", "cogs", "cost of goods sold", "product cost"] },
    { key: "discount", label: "Discount", words: ["discount", "discounts", "discount rate", "discount %", "discount amount", "lineitem discount"] },
    { key: "quantity", label: "Quantity", words: ["quantity", "qty", "units", "lineitem quantity"] },
    { key: "category", label: "Category", words: ["category", "product type", "department", "product category"] },
    { key: "subcategory", label: "Sub-category", words: ["sub-category", "subcategory", "sub category", "product subcategory"] },
    { key: "product", label: "Product", words: ["product name", "product", "item", "item name", "lineitem name", "title", "description", "sku"] },
    { key: "region", label: "Region", words: ["region", "location", "store", "province", "state", "billing province", "shipping province", "territory", "country"] },
    { key: "customer", label: "Customer", words: ["customer name", "customer", "customer id", "email", "client"] },
    { key: "order_id", label: "Order ID", words: ["order id", "order", "order number", "invoice", "name", "transaction id"] },
  ];
  const clean = (h) => String(h).trim().toLowerCase().replace(/[_\s]+/g, " ");

  /** Best guess for each role from the headers and a sample of rows ({header: value}). */
  function guessMapping(headers, rows) {
    const used = new Set();
    const map = {};
    const numericShare = (h) => {
      const vals = rows.map((r) => r[h]).filter((v) => v != null && String(v).trim() !== "");
      return vals.length ? vals.filter((v) => parseNumber(v) != null).length / vals.length : 0;
    };
    for (const role of ROLES) {
      let best = null, bestScore = 0;
      for (const h of headers) {
        if (used.has(h)) continue;
        const c = clean(h);
        let score = 0;
        role.words.forEach((w, i) => {
          if (c === w) score = Math.max(score, 100 - i);
          else if (c.includes(w) && w.length > 3) score = Math.max(score, 50 - i);
        });
        if (!score) continue;
        if (["sales", "profit", "cost", "discount", "quantity"].includes(role.key) && numericShare(h) < 0.8) continue;
        if (role.key === "date" && detectDateFormat(rows.map((r) => r[h])).share < 0.8) continue;
        if (score > bestScore) { best = h; bestScore = score; }
      }
      if (best) { map[role.key] = best; used.add(best); }
    }
    // "Region" fallback: a Country column says little when every row has the same country
    if (map.region && clean(map.region) === "country") {
      const distinct = new Set(rows.map((r) => r[map.region])).size;
      if (distinct < 2) delete map.region;
    }
    return map;
  }

  // ---------------------------------------------------------------- values
  /** "$1,234.50" -> 1234.5, "(12.00)" -> -12, "15%" -> 15, "" -> null */
  function parseNumber(v) {
    if (v == null) return null;
    let s = String(v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[$€£\s,%]/g, "");
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? (neg ? -n : n) : null;
  }

  // DuckDB strptime formats we recognise, with a JS check for each so detection can run here.
  const DATE_FORMATS = [
    { fmt: "%Y-%m-%d", re: /^(\d{4})-(\d{1,2})-(\d{1,2})/, order: "ymd" },
    { fmt: "%Y/%m/%d", re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})/, order: "ymd" },
    { fmt: "%m/%d/%Y", re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})/, order: "mdy" },
    { fmt: "%d/%m/%Y", re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})/, order: "dmy" },
    { fmt: "%m/%d/%y", re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/, order: "mdy" },
    { fmt: "%d/%m/%y", re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/, order: "dmy" },
    { fmt: "%d-%m-%Y", re: /^(\d{1,2})-(\d{1,2})-(\d{4})/, order: "dmy" },
    { fmt: "%m-%d-%Y", re: /^(\d{1,2})-(\d{1,2})-(\d{4})/, order: "mdy" },
    { fmt: "%d.%m.%Y", re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})/, order: "dmy" },
  ];
  function validParts(y, m, d) {
    if (y < 100) y += 2000;
    return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate() && y >= 1990 && y <= 2100;
  }
  /** Which format fits these values best. Ambiguous day/month: the one valid for every value wins;
      when both are, month-first (North American exports) unless any day part is over 12. */
  function detectDateFormat(values) {
    const vals = values.map((v) => String(v ?? "").trim()).filter(Boolean).slice(0, 2000);
    let best = { fmt: null, share: 0 };
    for (const f of DATE_FORMATS) {
      let ok = 0;
      for (const v of vals) {
        const m = v.match(f.re);
        if (!m) continue;
        const [a, b, c] = m.slice(1).map(Number);
        const [y, mo, d] = f.order === "ymd" ? [a, b, c] : f.order === "mdy" ? [c, a, b] : [c, b, a];
        if (validParts(y, mo, d)) ok++;
      }
      const share = vals.length ? ok / vals.length : 0;
      if (share > best.share + 1e-9) best = { fmt: f.fmt, share };
    }
    return best;
  }

  // ---------------------------------------------------------------- the tidy table
  const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
  const num = (col) => `TRY_CAST(CASE WHEN trim(${col}) LIKE '(%)' THEN '-' || regexp_replace(trim(${col}), '[()$€£,%\\s]', '', 'g')
      ELSE regexp_replace(trim(${col}), '[$€£,%\\s]', '', 'g') END AS DOUBLE)`;
  // a missing column is a typed NULL: a bare NULL is an INTEGER in DuckDB and breaks coalesce() with text
  const txt = (col) => (col ? `NULLIF(trim(${q(col)}), '')` : "CAST(NULL AS VARCHAR)");

  /**
   * SQL that turns the uploaded table `raw` (all text) into `sales`, one row per line:
   * order_date, sales, profit, discount (0 to 1), quantity, category, subcategory, product, region,
   * customer, order_id. opts: { dateFormat, discountKind: "rate" | "amount", costKind: "total" | "unit" }
   */
  function cleanSQL(map, opts = {}) {
    const date = `CAST(try_strptime(regexp_extract(trim(${q(map.date)}), '^[0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4}'), '${opts.dateFormat}') AS DATE)`;
    const sales = num(q(map.sales));
    let profit = "NULL";
    if (map.profit) profit = num(q(map.profit));
    else if (map.cost) profit = opts.costKind === "unit" && map.quantity
      ? `${sales} - ${num(q(map.cost))} * ${num(q(map.quantity))}` : `${sales} - ${num(q(map.cost))}`;
    let discount = "NULL";
    if (map.discount) {
      // point-of-sale exports often write discounts as negatives ("-$0.50"): use the size
      const d = opts.discountKind === "amount" ? `abs(${num(q(map.discount))})` : num(q(map.discount));
      // a discount in dollars becomes a rate of the pre-discount price (sales are after discount)
      discount = opts.discountKind === "amount" ? `CASE WHEN ${sales} + ${d} > 0 THEN ${d} / (${sales} + ${d}) END` : d;
    }
    return `CREATE OR REPLACE TABLE typed AS
SELECT
  ${date} AS order_date,
  ${sales} AS sales,
  ${profit} AS profit,
  ${discount} AS discount,
  ${map.quantity ? num(q(map.quantity)) : "NULL"} AS quantity,
  coalesce(${txt(map.category)}, 'Uncategorised') AS category,
  ${txt(map.subcategory)} AS subcategory,
  coalesce(${txt(map.product)}, '(no name)') AS product,
  coalesce(${txt(map.region)}, 'Unknown') AS region,
  ${txt(map.customer)} AS customer,
  ${txt(map.order_id)} AS order_id
FROM raw;

-- percentages written as 15 instead of 0.15: if any discount is over 1, all were percentages
CREATE OR REPLACE TABLE sales AS
SELECT * REPLACE (CASE WHEN (SELECT max(discount) FROM typed) > 1 THEN discount / 100 ELSE discount END AS discount)
FROM (SELECT DISTINCT * FROM typed)
WHERE order_date IS NOT NULL AND sales IS NOT NULL;`;
  }

  /** Read an uploaded CSV as text. Ragged rows (other sheets of a workbook export, notes at the
      bottom) are padded with blanks instead of failing the whole file; the data check counts them.
      comment = '' because DuckDB can otherwise guess that "#" starts a comment, and Shopify names
      every order "#1001": the whole export would vanish. */
  const loadSQL = (file) => `CREATE OR REPLACE TABLE raw AS
SELECT * FROM read_csv(${lit(file)}, all_varchar = true, header = true, null_padding = true, strict_mode = false,
  quote = '"', escape = '"', comment = '')`;

  /** Counts for the data check shown after loading. */
  const QUALITY_SQL = `SELECT
  (SELECT count(*) FROM raw) AS rows_read,
  (SELECT count(*) FROM typed WHERE order_date IS NULL OR sales IS NULL) AS rows_unusable,
  (SELECT count(*) FROM typed WHERE order_date IS NOT NULL AND sales IS NOT NULL)
    - (SELECT count(*) FROM (SELECT DISTINCT * FROM typed WHERE order_date IS NOT NULL AND sales IS NOT NULL)) AS duplicates,
  (SELECT count(*) FROM sales) AS rows_used,
  (SELECT min(order_date) FROM sales) AS first_date,
  (SELECT max(order_date) FROM sales) AS last_date,
  (SELECT count(*) FROM sales WHERE profit IS NOT NULL) AS rows_with_profit,
  (SELECT count(*) FROM sales WHERE discount IS NOT NULL) AS rows_with_discount`;

  // ---------------------------------------------------------------- filters
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const BANDS = [
    { key: "none", label: "No discount", sql: "coalesce(discount, 0) = 0" },
    { key: "1-10", label: "Up to 10%", sql: "discount > 0 AND discount <= 0.10" },
    { key: "10-20", label: "10 to 20%", sql: "discount > 0.10 AND discount <= 0.20" },
    { key: "20-30", label: "20 to 30%", sql: "discount > 0.20 AND discount <= 0.30" },
    { key: "30-50", label: "30 to 50%", sql: "discount > 0.30 AND discount <= 0.50" },
    { key: "50+", label: "Over 50%", sql: "discount > 0.50" },
  ];
  const BAND_CASE = `CASE ${BANDS.map((b) => `WHEN ${b.sql} THEN ${lit(b.key)}`).join(" ")} END`;

  /** filters: { from, to (YYYY-MM), category, subcategory, region, band, product } -> WHERE clause */
  function where(f = {}, skip = []) {
    const c = [];
    if (f.from && !skip.includes("date")) c.push(`order_date >= DATE ${lit(f.from + "-01")}`);
    if (f.to && !skip.includes("date")) c.push(`order_date < DATE ${lit(f.to + "-01")} + INTERVAL 1 MONTH`);
    for (const k of ["category", "subcategory", "region", "product"]) if (f[k] && !skip.includes(k)) c.push(`${k} = ${lit(f[k])}`);
    if (f.band && !skip.includes("band")) c.push(`(${BANDS.find((b) => b.key === f.band).sql})`);
    return c.length ? `WHERE ${c.join("\n  AND ")}` : "";
  }

  // ---------------------------------------------------------------- the charts' SQL
  // The previous period: the same number of months immediately before the selected range.
  function kpiSQL(f, range) {
    const cur = where(f);
    let prev = null;
    if (range?.from && range?.months) {
      const p = { ...f, from: addMonths(range.from, -range.months), to: addMonths(range.from, -1) };
      prev = where(p);
    }
    const body = (w) => `SELECT sum(sales) AS sales, sum(profit) AS profit, sum(profit) / nullif(sum(sales), 0) AS margin,
    -- no order number and no customer: each line counts as an order
    CASE WHEN count(order_id) + count(customer) = 0 THEN count(*)
      ELSE count(DISTINCT coalesce(order_id, CAST(order_date AS VARCHAR) || customer)) END AS orders,
    avg(CASE WHEN profit < 0 THEN 1.0 ELSE 0 END) AS loss_share
  FROM sales ${w}`;
    return prev ? `WITH cur AS (${body(cur)}),\n  prev AS (${body(prev)})\nSELECT cur.*, prev.sales AS prev_sales, prev.profit AS prev_profit, prev.margin AS prev_margin, prev.orders AS prev_orders FROM cur, prev`
      : body(cur);
  }
  function addMonths(ym, n) {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  }

  const SQL = {
    monthly: (f) => `SELECT strftime(date_trunc('month', order_date), '%Y-%m') AS month,
    sum(sales) AS sales, sum(profit) AS profit, sum(profit) / nullif(sum(sales), 0) AS margin
  FROM sales ${where(f, ["date"])}
  GROUP BY 1 ORDER BY 1`,
    discount: (f) => `SELECT ${BAND_CASE} AS band, count(*) AS lines, sum(sales) AS sales, sum(profit) AS profit,
    sum(profit) / nullif(sum(sales), 0) AS margin
  FROM sales ${where(f, ["band"])}
  GROUP BY 1`,
    byGroup: (f, col) => `SELECT ${col} AS name, sum(sales) AS sales, sum(profit) AS profit,
    sum(profit) / nullif(sum(sales), 0) AS margin, avg(discount) AS avg_discount
  FROM sales ${where(f, [col])}
  GROUP BY 1 ORDER BY profit ASC NULLS LAST`,
    heatmap: (f) => `SELECT region, category, sum(sales) AS sales, sum(profit) AS profit,
    sum(profit) / nullif(sum(sales), 0) AS margin
  FROM sales ${where(f, ["region", "category"])}
  GROUP BY 1, 2`,
    // Pareto: products ranked by profit, with running share of total profit
    pareto: (f) => `WITH p AS (
    SELECT product, sum(sales) AS sales, sum(profit) AS profit FROM sales ${where(f, ["product"])} GROUP BY 1
  ), ranked AS (
    SELECT *, row_number() OVER (ORDER BY profit DESC) AS rank,
      sum(profit) OVER (ORDER BY profit DESC ROWS UNBOUNDED PRECEDING) AS running
    FROM p
  )
  SELECT rank, product, sales, profit, running,
    (SELECT sum(profit) FILTER (WHERE profit > 0) FROM p) AS positive_total,
    (SELECT count(*) FROM p) AS products
  FROM ranked ORDER BY rank`,
    losers: (f) => `SELECT product, any_value(category) AS category, count(*) AS lines, sum(sales) AS sales,
    sum(profit) AS profit, sum(profit) / nullif(sum(sales), 0) AS margin, avg(discount) AS avg_discount
  FROM sales ${where(f, ["product"])}
  GROUP BY 1 HAVING sum(profit) < 0
  ORDER BY profit ASC LIMIT 25`,
  };

  // ---------------------------------------------------------------- findings, by rule
  const money = (v) => (v < 0 ? "-" : "") + "$" + Math.round(Math.abs(v)).toLocaleString("en-CA");
  const pct = (v) => `${Math.round(v * 100)}%`;

  /** Plain-English findings from the chart results. Every sentence is a fixed rule over the data. */
  function findings({ kpi, discount, category, pareto, losers, hasProfit }) {
    const out = [];
    if (!hasProfit) {
      out.push({ chart: "monthly", text: `There is no profit or cost column, so margins can't be shown. Sales, discounts and products still are.` });
      return out;
    }
    if (kpi && kpi.prev_margin != null && kpi.margin != null && Math.abs(kpi.margin - kpi.prev_margin) >= 0.02) {
      const up = kpi.sales > kpi.prev_sales;
      out.push({ chart: "kpi", text: `Margin ${kpi.margin < kpi.prev_margin ? "fell" : "rose"} from ${pct(kpi.prev_margin)} to ${pct(kpi.margin)} compared with the previous period${up && kpi.margin < kpi.prev_margin ? ", even though sales grew" : ""}.` });
    }
    const losingBands = BANDS.filter((b) => b.key !== "none").map((b) => (discount || []).find((d) => d.band === b.key))
      .filter((d) => d && d.profit < 0);
    if (losingBands.length) {
      const loss = losingBands.reduce((a, b) => a + b.profit, 0), lines = losingBands.reduce((a, b) => a + b.lines, 0);
      const names = losingBands.map((d) => BANDS.find((b) => b.key === d.band).label.toLowerCase());
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
      out.push({ chart: "discount", text: `Discounts of ${list} lost ${money(-loss)} across ${lines.toLocaleString("en-CA")} lines.` });
    }
    const losingCats = (category || []).filter((c) => c.profit < 0);
    if (losingCats.length) {
      const c = losingCats[0];
      out.push({ chart: "category", text: `${c.name} lost ${money(-c.profit)} on ${money(c.sales)} of sales${c.avg_discount != null ? `, with an average discount of ${pct(c.avg_discount)}` : ""}.` });
    }
    if (pareto?.length) {
      const total = pareto[0].positive_total;
      const k = pareto.findIndex((p) => p.running >= 0.8 * total) + 1;
      const n = pareto[0].products;
      const losing = pareto.filter((p) => p.profit < 0);
      if (k > 0 && n >= 10) out.push({ chart: "pareto", text: `${k.toLocaleString("en-CA")} of ${n.toLocaleString("en-CA")} products (${pct(k / n)}) make 80% of the profit. ${losing.length.toLocaleString("en-CA")} products lose money in total, ${money(-losing.reduce((a, p) => a + p.profit, 0))} between them.` });
    }
    if (losers?.length) {
      const l = losers[0];
      out.push({ chart: "losers", text: `The biggest single loss: ${l.product} lost ${money(-l.profit)} on ${money(l.sales)} of sales.` });
    }
    return out;
  }

  const DATE_FORMAT_LIST = DATE_FORMATS.map((f) => f.fmt);
  return { ROLES, BANDS, DATE_FORMAT_LIST, loadSQL, guessMapping, parseNumber, detectDateFormat, cleanSQL, QUALITY_SQL, where, kpiSQL, addMonths, SQL, findings, money, pct };
})();

if (typeof module !== "undefined") module.exports = MarginCore;
