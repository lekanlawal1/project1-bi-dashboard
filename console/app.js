/* Margin Console page: load a file into DuckDB (in the browser), confirm the columns, then run the
   SQL in core.js for every chart and draw it with charts.js. Clicking a mark filters every chart;
   each chart shows the exact query it ran. Nothing is uploaded anywhere. */

const C = MarginCore;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const DUCKDB = "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";
const status = (msg, bad = false) => { $("status").textContent = msg; $("status").classList.toggle("bad", bad); };

const money = (v, short) => {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const a = Math.abs(v), sign = v < 0 ? "-" : "";
  if (short && a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (short && a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${sign}$${Math.round(a).toLocaleString("en-CA")}`;
};
const pct = (v, short) => (v == null || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(short || Math.abs(v) >= 0.1 ? 0 : 1)}%`);
const monthLabel = (ym) => new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-CA", { month: "short", year: "2-digit", timeZone: "UTC" });

// ------------------------------------------------------------------ DuckDB in the browser
let db = null, conn = null;
async function duck() {
  if (conn) return conn;
  status("Starting the database in your browser...");
  const duckdb = await import(DUCKDB);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const url = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(url));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(url);
  conn = await db.connect();
  return conn;
}
async function query(sql) {
  const r = await conn.query(sql);
  const cols = r.schema.fields.map((f) => f.name);
  return r.toArray().map((row) => Object.fromEntries(cols.map((c) => {
    let v = row[c];
    if (typeof v === "bigint") v = Number(v);
    else if (v && typeof v === "object" && !(v instanceof Date)) { const n = Number(v); if (Number.isFinite(n)) v = n; }
    return [c, v];
  })));
}

// ------------------------------------------------------------------ step 1: a file
let fileName = "";
async function loadText(text, name) {
  await duck();
  status(`Reading ${name}...`);
  fileName = name;
  await db.registerFileText("upload.csv", text);
  await conn.query(C.loadSQL("upload.csv"));
  // a random sample from the whole file: read order is not guaranteed, and junk rows can sit anywhere
  const sample = await query("SELECT * FROM raw USING SAMPLE reservoir(400 ROWS) REPEATABLE (7)");
  const headers = sample.length ? Object.keys(sample[0]) : [];
  if (!headers.length) return status("That file has no rows.", true);
  showMapping(headers, sample);
}
async function loadFile(file) {
  try {
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      status(`Reading ${file.name}...`);
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      // the first sheet with a header row wins; other sheets (returns, notes) are ignored
      const sheet = wb.Sheets[wb.SheetNames[0]];
      return loadText(XLSX.utils.sheet_to_csv(sheet, { rawNumbers: true }), file.name);
    }
    return loadText(await file.text(), file.name);
  } catch (err) { status(`Couldn't read that file: ${err.message}`, true); }
}
$("file").addEventListener("change", (e) => e.target.files[0] && loadFile(e.target.files[0]));
const drop = $("drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]));
$("sample").addEventListener("click", async () => {
  try {
    status("Loading the sample: Superstore's raw export, messy rows included...");
    const text = await (await fetch("sample/superstore_raw.csv")).text();
    await loadText(text, "Superstore sample (raw export)");
    build(true);
  } catch (err) { status(`Couldn't load the sample: ${err.message}`, true); }
});

// ------------------------------------------------------------------ step 2: which column is which
let mapping = {}, opts = {};
function showMapping(headers, sample) {
  mapping = C.guessMapping(headers, sample);
  const fmt = mapping.date ? C.detectDateFormat(sample.map((r) => r[mapping.date])).fmt : null;
  opts = { dateFormat: fmt || "%Y-%m-%d", discountKind: "rate", costKind: "total" };
  const option = (h, sel) => `<option value="${esc(h)}"${h === sel ? " selected" : ""}>${esc(h)}</option>`;
  const example = (h) => { const v = sample.find((r) => r[h] != null && String(r[h]).trim() !== ""); return v ? String(v[h]).slice(0, 28) : ""; };
  $("map-rows").innerHTML = C.ROLES.map((r) => `<label class="map-row">
      <span><b>${esc(r.label)}</b>${r.required ? ` <em>required</em>` : ""}</span>
      <select data-role="${r.key}"><option value="">${r.required ? "Choose a column" : "Not in my file"}</option>${headers.map((h) => option(h, mapping[r.key])).join("")}</select>
      <small class="ex" data-ex="${r.key}">${mapping[r.key] ? esc(example(mapping[r.key])) : ""}</small></label>`).join("");
  $("map-rows").querySelectorAll("select").forEach((s) => s.addEventListener("change", () => {
    if (s.value) mapping[s.dataset.role] = s.value; else delete mapping[s.dataset.role];
    s.parentElement.querySelector(".ex").textContent = s.value ? example(s.value) : "";
    if (s.dataset.role === "date" && s.value) {
      opts.dateFormat = C.detectDateFormat(sample.map((r) => r[s.value])).fmt || opts.dateFormat;
      $("date-format").value = opts.dateFormat;
    }
    syncOptions();
  }));
  $("date-format").innerHTML = C.DATE_FORMAT_LIST.map((f) => `<option value="${f}"${f === opts.dateFormat ? " selected" : ""}>${f.replace(/%Y/, "2024").replace(/%y/, "24").replace(/%m/, "MM").replace(/%d/, "DD")}</option>`).join("");
  syncOptions();
  $("map-file").textContent = fileName;
  $("mapping").hidden = false;
  status("");
  $("mapping").scrollIntoView({ behavior: "smooth", block: "start" });
}
function syncOptions() {
  $("opt-discount").hidden = !mapping.discount;
  $("opt-cost").hidden = !mapping.cost || !!mapping.profit;
  $("map-warn").textContent = !mapping.date || !mapping.sales ? "Choose the order date and sales columns to continue."
    : !mapping.profit && !mapping.cost ? "No profit or cost column: you'll get sales, discounts and products, but not margins." : "";
  $("build").disabled = !mapping.date || !mapping.sales;
}
$("date-format").addEventListener("change", (e) => { opts.dateFormat = e.target.value; });
document.querySelectorAll("input[name=dk]").forEach((r) => r.addEventListener("change", () => { opts.discountKind = r.value; }));
document.querySelectorAll("input[name=ck]").forEach((r) => r.addEventListener("change", () => { opts.costKind = r.value; }));
$("build").addEventListener("click", () => build(false));

// ------------------------------------------------------------------ step 3: the tidy table and the data check
let meta = null, filters = {};
async function build(isSample) {
  try {
    status("Cleaning the data...");
    const cleanSQL = C.cleanSQL(mapping, opts);
    for (const stmt of cleanSQL.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await conn.query(stmt);
    const [qc] = await query(C.QUALITY_SQL);
    if (!qc.rows_used) return status("No rows had both a valid date and a sales amount. Check the date format and the columns.", true);
    meta = { ...qc, hasProfit: qc.rows_with_profit > 0, hasDiscount: qc.rows_with_discount > 0, hasSub: !!mapping.subcategory, isSample };
    const months = await query("SELECT DISTINCT strftime(order_date, '%Y-%m') AS m FROM sales ORDER BY 1");
    meta.months = months.map((r) => r.m);
    filters = {};
    $("mapping").hidden = true;
    $("dash").hidden = false;
    $("check").innerHTML = dataCheck(qc, cleanSQL);
    setupRange();
    status("");
    await render();
    $("dash").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) { status(`Couldn't build the dashboard: ${err.message.split("\n")[0]}`, true); }
}
function dataCheck(q, sql) {
  const d = (x) => new Date(x).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  const parts = [`<b>${q.rows_used.toLocaleString("en-CA")}</b> lines used from <b>${q.rows_read.toLocaleString("en-CA")}</b> rows in ${esc(fileName)}, ${d(q.first_date)} to ${d(q.last_date)}.`];
  if (q.rows_unusable) parts.push(`${q.rows_unusable.toLocaleString("en-CA")} row${q.rows_unusable > 1 ? "s" : ""} skipped: no readable date or sales amount (often totals, notes or other sheets pasted below the data).`);
  if (q.duplicates) parts.push(`${q.duplicates.toLocaleString("en-CA")} exact duplicate line${q.duplicates > 1 ? "s" : ""} removed.`);
  if (!q.rows_with_profit) parts.push("No profit or cost column, so the dashboard shows sales instead of margins.");
  return `<p>${parts.join(" ")}</p><details class="sql"><summary>Show the cleaning SQL</summary><pre>${esc(sql)}</pre></details>
    <button type="button" class="link" id="remap">Change the column choices</button>`;
}

// ------------------------------------------------------------------ filters
function setupRange() {
  const opt = (m, sel) => `<option value="${m}"${m === sel ? " selected" : ""}>${monthLabel(m)}</option>`;
  $("from").innerHTML = meta.months.map((m, i) => opt(m, meta.months[0])).join("");
  $("to").innerHTML = meta.months.map((m) => opt(m, meta.months[meta.months.length - 1])).join("");
}
function rangeInfo() {
  const from = $("from").value, to = $("to").value;
  const [fy, fm] = from.split("-").map(Number), [ty, tm] = to.split("-").map(Number);
  const months = (ty - fy) * 12 + (tm - fm) + 1;
  const full = from === meta.months[0] && to === meta.months[meta.months.length - 1];
  return { from, to, months, full };
}
function activeFilters() {
  const r = rangeInfo();
  return { ...filters, ...(r.full ? {} : { from: r.from, to: r.to }) };
}
["from", "to"].forEach((id) => $(id).addEventListener("change", () => {
  if ($("from").value > $("to").value) (id === "from" ? $("to") : $("from")).value = $(id).value;
  render();
}));
document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
  const n = +b.dataset.preset, last = meta.months[meta.months.length - 1];
  $("to").value = last;
  $("from").value = n ? (meta.months.find((m) => m >= C.addMonths(last, -(n - 1))) || meta.months[0]) : meta.months[0];
  render();
}));
function setFilter(f) {
  for (const [k, v] of Object.entries(f)) filters[k] = filters[k] === v ? undefined : v;   // a second click clears it
  for (const k of Object.keys(filters)) if (filters[k] === undefined) delete filters[k];
  render();
}
function chips() {
  const names = { category: "Category", subcategory: "Sub-category", region: "Region", band: "Discount", product: "Product" };
  const bandLabel = (k) => C.BANDS.find((b) => b.key === k)?.label;
  const list = Object.entries(filters).map(([k, v]) => `<button type="button" class="chip" data-k="${k}">${names[k]}: ${esc(k === "band" ? bandLabel(v) : v)} <span aria-hidden="true">&times;</span></button>`);
  $("chips").innerHTML = list.length ? list.join("") + `<button type="button" class="link" id="clear">Clear all</button>`
    : `<span class="hint">Click any bar, cell or point to filter every chart.</span>`;
  $("chips").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { delete filters[b.dataset.k]; render(); }));
  $("clear")?.addEventListener("click", () => { filters = {}; render(); });
}

// ------------------------------------------------------------------ rendering every chart
const card = (id, title, sub, sql, body) => {
  const el = $(id);
  el.innerHTML = `<div class="card-head"><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ""}</div>${body}
    <details class="sql"><summary>Show the SQL</summary><pre>${esc(sql)}</pre></details>`;
};
let renderToken = 0;
async function render() {
  const token = ++renderToken;
  const f = activeFilters(), r = rangeInfo(), P = meta.hasProfit;
  chips();
  try {
    const kpiSQL = C.kpiSQL(f, r.full ? null : { from: r.from, months: r.months });
    const sqls = { monthly: C.SQL.monthly(f), discount: C.SQL.discount(f), category: C.SQL.byGroup(f, "category"),
      sub: C.SQL.byGroup(f, "subcategory"), region: C.SQL.byGroup(f, "region"), heatmap: C.SQL.heatmap(f), pareto: C.SQL.pareto(f), losers: C.SQL.losers(f) };
    const [kpi] = await query(kpiSQL);
    const res = {};
    for (const [k, s] of Object.entries(sqls)) {
      if ((k === "sub" && !meta.hasSub) || (k === "discount" && !meta.hasDiscount) || (k === "losers" && !P)) continue;
      res[k] = await query(s);
    }
    if (token !== renderToken) return;                       // a newer click is already rendering
    drawKPIs(kpi, r);
    drawFindings(C.findings({ kpi, discount: res.discount, category: res.category, pareto: res.pareto, losers: res.losers, hasProfit: P }));
    drawMonthly(res.monthly, sqls.monthly);
    if (meta.hasDiscount) drawDiscount(res.discount, sqls.discount); else $("c-discount").innerHTML = `<div class="card-head"><h3>Discounts</h3><p>No discount column in this file.</p></div>`;
    drawGroups(meta.hasSub ? res.sub : res.category, meta.hasSub ? "subcategory" : "category", meta.hasSub ? sqls.sub : sqls.category);
    drawHeatmap(res.heatmap, sqls.heatmap);
    drawPareto(res.pareto, sqls.pareto);
    if (P) drawLosers(res.losers, sqls.losers); else $("c-losers").innerHTML = "";
    wire();
  } catch (err) { status(`A query failed: ${err.message.split("\n")[0]}`, true); }
}

function drawKPIs(k, r) {
  const delta = (cur, prev, kind) => {
    if (prev == null || cur == null) return "";
    if (kind === "pp") { const d = (cur - prev) * 100; return `<span class="d ${d < 0 ? "down" : "up"}">${d >= 0 ? "+" : ""}${d.toFixed(1)} pts</span>`; }
    // a percentage change only means something between two positive amounts; otherwise show dollars
    if (kind === "money" && (prev <= 0 || cur <= 0)) { const d = cur - prev; return `<span class="d ${d < 0 ? "down" : "up"}">${d >= 0 ? "+" : ""}${money(d)}</span>`; }
    if (!prev) return "";
    const d = cur / prev - 1;
    return `<span class="d ${d < 0 ? "down" : "up"}">${d >= 0 ? "+" : ""}${(d * 100).toFixed(0)}%</span>`;
  };
  const vs = k.prev_sales != null ? `vs the ${r.months} months before` : "whole period";
  const tiles = [["Sales", money(k.sales), delta(k.sales, k.prev_sales)]];
  if (meta.hasProfit) tiles.push(["Profit", money(k.profit), delta(k.profit, k.prev_profit, "money")], ["Margin", pct(k.margin), delta(k.margin, k.prev_margin, "pp")]);
  tiles.push(["Orders", Math.round(k.orders).toLocaleString("en-CA"), delta(k.orders, k.prev_orders)]);
  if (meta.hasProfit) tiles.push(["Lines sold at a loss", pct(k.loss_share), ""]);
  $("kpis").innerHTML = tiles.map(([l, v, d]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}</div><div class="dl">${d}${d ? ` <small>${vs}</small>` : ""}</div></div>`).join("");
}
function drawFindings(list) {
  $("findings").innerHTML = list.length ? `<h3>What stands out</h3><ul>${list.map((f) => `<li><a href="#c-${f.chart}">${esc(f.text)}</a></li>`).join("")}</ul>
    <p class="fine">Each sentence is a fixed rule over the numbers below, not AI text.</p>` : "";
}
// the inner width of a full-width card, so charts are drawn at real size (measured on the
// dashboard itself: an empty card is hidden and has no width yet)
const widthOf = () => Math.max(280, ($("dash").clientWidth || 800) - 40);
function drawMonthly(rows, sql) {
  const pts = rows.map((r) => ({ label: monthLabel(r.month), x: r.month,
    tip: `<b>${monthLabel(r.month)}</b><br>Sales ${money(r.sales)}${meta.hasProfit ? `<br>Profit ${money(r.profit)}<br>Margin ${pct(r.margin)}` : ""}<br>Click to show only this month`,
    filter: { month: r.month } }));
  const sales = Charts.columns(pts.map((p, i) => ({ ...p, y: rows[i].sales })), { fmt: (v, s) => money(v, s), label: "Sales by month", width: widthOf("c-monthly") });
  const margin = meta.hasProfit ? `<p class="chart-label">Margin by month</p>` + Charts.line(pts.map((p, i) => ({ ...p, y: rows[i].margin })), { fmt: (v) => pct(v, true), label: "Margin by month", width: widthOf("c-monthly") }) : "";
  card("c-monthly", "Month by month", meta.hasProfit ? "Sales and margin as two charts on their own scales. Growing sales with falling margin is the warning sign." : "", sql,
    `<p class="chart-label">Sales by month</p>${sales}${margin}`);
}
function drawDiscount(rows, sql) {
  const order = C.BANDS.map((b) => rows.find((r) => r.band === b.key)).filter(Boolean);
  const P = meta.hasProfit;
  card("c-discount", "The discount cliff", P ? "Margin at each discount level. Where bars turn red, discounting costs more than it brings in." : "Sales at each discount level.", sql,
    Charts.hbars(order.map((r) => ({ name: r.band, label: C.BANDS.find((b) => b.key === r.band).label, value: P ? r.margin : r.sales,
      tip: `<b>${C.BANDS.find((b) => b.key === r.band).label}</b><br>${r.lines.toLocaleString("en-CA")} lines, ${money(r.sales)} of sales${P ? `<br>Profit ${money(r.profit)}, margin ${pct(r.margin)}` : ""}<br>Click to filter`,
      filter: { band: r.band } })), { fmt: P ? (v) => pct(v) : (v) => money(v, true), label: "Margin by discount band", polarity: P, selected: filters.band }));
}
function drawGroups(rows, col, sql) {
  const P = meta.hasProfit, name = col === "subcategory" ? "Sub-category" : "Category";
  const sorted = [...rows].sort((a, b) => (P ? a.profit - b.profit : b.sales - a.sales));
  card("c-category", `Profit by ${name.toLowerCase()}`, P ? "Sorted from biggest loss to biggest profit." : "", sql,
    Charts.hbars(sorted.map((r) => ({ name: r.name, value: P ? r.profit : r.sales,
      tip: `<b>${esc(r.name)}</b><br>Sales ${money(r.sales)}${P ? `<br>Profit ${money(r.profit)}, margin ${pct(r.margin)}` : ""}${r.avg_discount != null ? `<br>Average discount ${pct(r.avg_discount)}` : ""}<br>Click to filter`,
      filter: { [col]: r.name } })), { fmt: (v) => money(v, true), label: `Profit by ${name}`, polarity: P, selected: filters[col] }));
}
function drawHeatmap(rows, sql) {
  const P = meta.hasProfit;
  const regions = [...new Set(rows.map((r) => r.region))].sort(), cats = [...new Set(rows.map((r) => r.category))].sort();
  if (regions.length > 20) { $("c-heatmap").innerHTML = `<div class="card-head"><h3>Region by category</h3><p>Too many regions (${regions.length}) to show as a grid.</p></div>`; return; }
  card("c-heatmap", "Region by category", P ? "Margin in each combination: red loses money, blue makes it, pale is near zero." : "Sales in each combination.", sql,
    Charts.heatmap(rows.map((r) => ({ row: r.region, col: r.category, value: P ? r.margin : r.sales,
      tip: `<b>${esc(r.category)} in ${esc(r.region)}</b><br>Sales ${money(r.sales)}${P ? `<br>Profit ${money(r.profit)}, margin ${pct(r.margin)}` : ""}<br>Click to filter`,
      filter: { region: r.region, category: r.category } })), regions, cats, { fmt: P ? (v) => pct(v) : (v) => money(v, true), label: "Region by category", metric: P ? "margin" : "sales" }));
}
function drawPareto(rows, sql) {
  if (!meta.hasProfit) { $("c-pareto").innerHTML = ""; return; }
  const n = rows.length, total = rows[0]?.positive_total;
  const k = rows.findIndex((r) => r.running >= 0.8 * total) + 1;
  const losing = rows.filter((r) => r.profit < 0);
  card("c-pareto", "Where the profit comes from", n ? `Products ranked from most to least profitable, with the running share of total profit. ${k} of ${n.toLocaleString("en-CA")} products make 80% of it; the line falls where ${losing.length.toLocaleString("en-CA")} products give some back.` : "", sql,
    Charts.pareto(rows, { label: "Running share of profit by product", money: (v) => money(v), width: widthOf("c-pareto") }));
}
function drawLosers(rows, sql) {
  card("c-losers", "Products that lose money", rows.length ? "The 25 biggest losses in this selection. Click a product to filter every chart to it." : "No product loses money in this selection.", sql,
    rows.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Product</th><th>Category</th><th class="n">Lines</th><th class="n">Sales</th><th class="n">Profit</th><th class="n">Margin</th><th class="n">Avg discount</th></tr></thead><tbody>${rows.map((r) => `
      <tr tabindex="0" data-filter="${esc(JSON.stringify({ product: r.product }))}" data-tip="${encodeURIComponent(`<b>${esc(r.product)}</b><br>Click to filter every chart to this product`)}"><td>${esc(r.product)}</td><td>${esc(r.category)}</td><td class="n">${r.lines}</td><td class="n">${money(r.sales)}</td><td class="n neg">${money(r.profit)}</td><td class="n">${pct(r.margin)}</td><td class="n">${r.avg_discount == null ? "n/a" : pct(r.avg_discount)}</td></tr>`).join("")}</tbody></table></div>` : "");
}

let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (meta && !$("dash").hidden) render(); }, 250); });

// ------------------------------------------------------------------ tooltips and clicks (once per render)
const tip = $("tip");
function wire() {
  document.querySelectorAll("#dash [data-tip]").forEach((el) => {
    const show = () => {
      tip.innerHTML = decodeURIComponent(el.dataset.tip); tip.hidden = false;
      const b = el.getBoundingClientRect();
      tip.style.left = `${Math.min(innerWidth - tip.offsetWidth - 10, Math.max(10, b.left + b.width / 2 - tip.offsetWidth / 2))}px`;
      tip.style.top = `${b.top + scrollY - tip.offsetHeight - 8}px`;
    };
    el.addEventListener("mouseenter", show); el.addEventListener("focus", show);
    el.addEventListener("mouseleave", () => { tip.hidden = true; }); el.addEventListener("blur", () => { tip.hidden = true; });
  });
  document.querySelectorAll("#dash [data-filter]").forEach((el) => {
    const go = () => {
      tip.hidden = true;
      const f = JSON.parse(el.dataset.filter);
      if (f.month) { $("from").value = f.month; $("to").value = f.month; render(); return; }
      setFilter(f);
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
  $("remap")?.addEventListener("click", () => { $("mapping").hidden = false; $("mapping").scrollIntoView({ behavior: "smooth" }); });
}
