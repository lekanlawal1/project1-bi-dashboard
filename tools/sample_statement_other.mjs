// Made-up statements in layouts the Card Fee Checker has no reader for, to test the general
// reader (fees/generic.js) on structures it has never seen:
//   other_a  interchange-plus, columns in a new order (volume, count, rate, per item, fee), three
//            fee sections closed by their own total lines, and a printed "Total Fees Charged";
//            one interchange line above Visa's published rate and one fee line that doesn't add up
//   other_b  flat-rate pricing: fees shown per day only, with a "Total fees" line
//   other_c  the same as other_a with its printed total off by $1.00: must be refused
//
//   node tools/sample_statement_other.mjs <out dir>          HTML only
//   node tools/sample_statement_other.mjs <out dir> --pdf    and PDFs (Playwright)
// No real business, processor or statement is used.
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] || "sample/other";
fs.mkdirSync(out, { recursive: true });
const c = (d) => Math.round(d * 100);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const usd = (cents) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const tr = (cells, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}>${cells.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`;
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
@page { size: 8.5in 11in; margin: 0 } * { box-sizing: border-box; margin: 0 }
body { font: 10px/1.4 Georgia, serif; color: #111 } .page { width: 816px; min-height: 1056px; padding: 48px 56px; page-break-after: always }
h1 { font-size: 18px; margin-bottom: 4px } h2 { font-size: 12px; margin: 22px 0 6px; text-transform: uppercase; letter-spacing: .05em }
table { border-collapse: collapse; width: 100% } td { padding: 4px 6px; border-bottom: 1px solid #ddd; white-space: nowrap }
td:not(:first-child) { text-align: right } thead td { font-weight: 700 } tr.tot td { font-weight: 700; border-top: 2px solid #111 }
.box { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 30px; border: 1px solid #999; padding: 10px; margin: 14px 0 }
</style></head><body>${body}</body></html>`;

// ------------------------------------------------------------------ A: interchange-plus, new column order
function statementA(offByOne = false) {
  const cards = [["Visa", 410, 31250.00, 4, 210.00], ["Mastercard", 160, 12480.50, 1, 45.00], ["American Express", 38, 6120.00, 0, 0]];
  const sales = sum(cards, (x) => c(x[2])), refunds = sum(cards, (x) => c(x[4]));
  // [program, volume, count, rate %, per item]
  const ic = [
    ["VI-CPS RETAIL P2 SIGN PREFERRED", 12400.00, 150, 2.10, 0.10],
    ["VI-CPS RETAIL P2 TRAD", 9850.00, 140, 1.51, 0.10],
    ["VI-ECOMM BSC P1 SIGN PREFERRED", 5200.00, 70, 2.60, 0.10],             // published: 2.50%
    ["VI-CPS/RETAIL (DB)", 3800.00, 50, 0.80, 0.15],
    ["MC-WORLD ELITE MERIT III", 7300.50, 90, 2.30, 0.10],
    ["MC-CORE MERIT III", 5180.00, 70, 1.65, 0.10],
    ["AXP RETAIL T2", 6120.00, 38, 2.05, 0.10],
  ].map(([d, v, n, r, p]) => ({ d, v: c(v), n, r, p, fee: Math.round(c(v) * r / 100 + n * p * 100) }));
  const brandFees = [
    ["Visa Assessment", c(31250.00), null, 0.14, null],
    ["Mastercard Assessment", c(12480.50), null, 0.14, null],
    ["Visa Acquirer Processing Fee", null, 414, null, 0.0195],
  ].map(([d, v, n, r, p]) => ({ d, v, n, r, p, fee: v != null ? Math.round(v * r / 100) : Math.round(n * p * 100) }));
  const proc = [
    ["Processing Markup", c(49850.50), null, 0.30, null],
    ["Authorization Fee", null, 640, null, 0.08],
    ["Monthly Service Fee", null, null, null, null, c(14.95)],
    ["PCI Non-Compliance Fee", null, null, null, null, c(24.95)],
  ].map(([d, v, n, r, p, flat]) => ({ d, v, n, r, p, fee: flat ?? (v != null ? Math.round(v * r / 100) : Math.round(n * p * 100)) }));
  proc[1].fee += 10;                                            // 640 x $0.08 is $51.20; $51.30 is printed
  const t1 = sum(ic, (x) => x.fee), t2 = sum(brandFees, (x) => x.fee), t3 = sum(proc, (x) => x.fee), total = t1 + t2 + t3 + (offByOne ? 100 : 0);
  const row = (x) => tr([x.d, x.v != null ? usd(x.v) : "", x.n != null ? String(x.n) : "", x.r != null ? `${x.r.toFixed(2)}%` : "", x.p != null ? `$${x.p.toFixed(x.p < 0.1 ? 4 : 2)}` : "", usd(x.fee)]);
  const head = tr(["Description", "Volume", "Count", "Rate", "Per Item", "Fee"]);
  return page("Statement A", `<div class="page"><h1>Merchant Statement</h1><p>Northwind Payments (example) · www.northwind-pay.test</p>
<p>Statement Period: August 2026 · Merchant: QUAYSIDE BIKES (SAMPLE)</p>
<div class="box"><div>Total Sales</div><div>${usd(sales)}</div><div>Refunds</div><div>${usd(-refunds)}</div><div>Net Sales</div><div>${usd(sales - refunds)}</div>
<div>Total Fees Charged</div><div>${usd(-total)}</div></div>
<h2>Card Summary</h2><table><thead>${tr(["Card", "Sales Count", "Sales", "Refunds", "Net"])}</thead><tbody>
${cards.map((x) => tr([x[0], String(x[1]), usd(c(x[2])), usd(-c(x[4])), usd(c(x[2]) - c(x[4]))])).join("")}
${tr(["Total", String(sum(cards, (x) => x[1])), usd(sales), usd(-refunds), usd(sales - refunds)], "tot")}</tbody></table>
<h2>Interchange and Program Fees</h2><table><thead>${head}</thead><tbody>${ic.map(row).join("")}${tr(["Total Interchange and Program Fees", "", "", "", "", usd(t1)], "tot")}</tbody></table>
<h2>Card Brand Fees</h2><table><thead>${head}</thead><tbody>${brandFees.map(row).join("")}${tr(["Total Card Brand Fees", "", "", "", "", usd(t2)], "tot")}</tbody></table>
<h2>Processor Fees</h2><table><thead>${head}</thead><tbody>${proc.map(row).join("")}${tr(["Total Processor Fees", "", "", "", "", usd(t3)], "tot")}</tbody></table>
<h2>Fee Summary</h2><table><tbody>${tr(["Total Fees Charged", usd(total)], "tot")}</tbody></table></div>`);
}

// ------------------------------------------------------------------ B: flat rate, fees by day only
function statementB() {
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const days = [];
  for (let d = 1; d <= 30; d++) {
    if (new Date(Date.UTC(2026, 8, d)).getUTCDay() === 0) continue;
    const n = 8 + Math.floor(rand() * 20), gross = c(n * (18 + rand() * 30)), refund = d % 9 === 0 ? c(25) : 0;
    const fee = Math.round(gross * 0.026 + n * 10) - (refund ? Math.round(refund * 0.026) : 0);
    days.push({ date: `Sep ${d}, 2026`, n, gross, refund, fee, net: gross - refund - fee });
  }
  const T = (k) => sum(days, (x) => x[k]);
  return page("Statement B", `<div class="page"><h1>Monthly Processing Statement</h1><p>Statement Period: September 2026 · Bluebird Cafe (sample) · www.flatpay.test</p>
<div class="box"><div>Gross Sales</div><div>${usd(T("gross"))}</div><div>Refunds</div><div>${usd(-T("refund"))}</div><div>Net Sales</div><div>${usd(T("gross") - T("refund"))}</div>
<div>Total Fees</div><div>${usd(-T("fee"))}</div><div>Net Deposits</div><div>${usd(T("net"))}</div></div>
<p>Pricing: 2.6% + 10¢ per card payment.</p>
<h2>Daily Activity</h2><table><thead>${tr(["Date", "Payments", "Gross Sales", "Refunds", "Fees", "Net"])}</thead><tbody>
${days.map((x) => tr([x.date, String(x.n), usd(x.gross), usd(-x.refund), usd(-x.fee), usd(x.net)])).join("")}
${tr(["Totals", String(T("n")), usd(T("gross")), usd(-T("refund")), usd(-T("fee")), usd(T("net"))], "tot")}</tbody></table></div>`);
}

const docs = { other_a: statementA(), other_b: statementB(), other_c: statementA(true) };
for (const [k, html] of Object.entries(docs)) fs.writeFileSync(path.join(out, `${k}.html`), html);
console.log(`wrote ${Object.keys(docs).length} statements to ${out}`);
if (process.argv.includes("--pdf")) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");   // or a global install
  const browser = await chromium.launch();
  const p = await browser.newPage();
  for (const [k, html] of Object.entries(docs)) {
    await p.setContent(html, { waitUntil: "load" });
    await p.pdf({ path: path.join(out, `${k}.pdf`), width: "8.5in", height: "11in" });
  }
  await browser.close();
  console.log("and PDFs");
}
