// Prints the SQL the console would run for the Superstore sample, as JSON, for tests/test_console_sql.py.
const C = require("../console/core.js");
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
// A small CSV reader (quoted fields may contain commas). The page itself gets its sample rows from DuckDB.
function parseCSV(t, limit) {
  const out = []; let row = [], f = "", inQ = false;
  for (let i = 0; i < t.length && out.length < limit; i++) {
    const ch = t[i];
    if (inQ) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else inQ = false; } else f += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n") { row.push(f.replace(/\r$/, "")); out.push(row); row = []; f = ""; }
    else f += ch;
  }
  return out;
}
const [header, ...body] = parseCSV(text, 300);
const rows = body.map((v) => Object.fromEntries(header.map((h, i) => [h, v[i]])));
const map = C.guessMapping(header, rows);
const fmt = C.detectDateFormat(rows.map((r) => r[map.date])).fmt;
const f = JSON.parse(process.argv[3] || "{}");
console.log(JSON.stringify({ load: C.loadSQL(process.argv[2]), map, fmt, clean: C.cleanSQL(map, { dateFormat: fmt }), quality: C.QUALITY_SQL,
  kpi: C.kpiSQL(f), discount: C.SQL.discount(f), category: C.SQL.byGroup(f, "category"), sub: C.SQL.byGroup(f, "subcategory"),
  region: C.SQL.byGroup(f, "region"), heatmap: C.SQL.heatmap(f), pareto: C.SQL.pareto(f), losers: C.SQL.losers(f), monthly: C.SQL.monthly(f) }));
