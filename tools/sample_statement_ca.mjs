// Builds the made-up Canadian sample statement for the Card Fee Checker: a fictional tile shop,
// one month of card sales, laid out like a TSYS (Canada) statement. Totals are computed from the
// rows, so it adds up to the cent, and problems are planted on purpose for the checker to find:
// a Visa business line billed above Visa Canada's published rate, a sale at the "Standard" rate,
// a fee line whose own arithmetic is wrong, Amex fees with no Amex sales, and PCI penalties.
//
//   node tools/sample_statement_ca.mjs           writes sample/sample_statement_ca.html
//   node tools/sample_statement_ca.mjs --pdf     also prints it to sample/sample_statement_ca.pdf
//
// No real business, merchant or statement is used.
import fs from "node:fs";

const c = (d) => Math.round(d * 100);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
// TSYS writes money as "$11,285.94", "$.00" and "$-62.63"
const m = (cents) => {
  const a = Math.abs(cents), whole = Math.floor(a / 100), frac = String(a % 100).padStart(2, "0");
  return `$${cents < 0 ? "-" : ""}${whole ? whole.toLocaleString("en-US") : ""}.${frac}`;
};
const m3 = (d) => `$${d.toFixed(3).replace(/^0/, "")}`;

// ------------------------------------------------------------------ card types: [name, sales, $, refunds, $, discount %]
const CARDS = [
  ["Visa", 14, 18420.50, 1, 120.00, 0.25],
  ["Visa Debit", 0, 0, 0, 0, 0.25],
  ["Visa Business", 4, 6880.00, 0, 0, 0.25],
  ["MasterCard", 6, 5310.40, 0, 0, 0.25],
  ["MasterCard Debit", 0, 0, 0, 0, 0.25],
  ["MasterCard Business", 0, 0, 0, 0, 0.25],
  ["American Express", 0, 0, 0, 0, 0.00],
  ["Interac", 12, 8950.25, 1, 210.00, 0.00],
].map(([name, n, s, rn, r, pct]) => {
  const gross = c(s), refunds = c(r), net = gross - refunds;
  return { name, n, gross, rn, refunds, net, items: n + rn, pct, discount: Math.round((gross + refunds) * pct / 100) };
});
const total = (k) => sum(CARDS, (x) => x[k]);

// ------------------------------------------------------------------ rates & fees: [description, rate %, count, base $]
const visaGross = sum(CARDS.filter((x) => x.name.startsWith("Visa")), (x) => x.gross);
const mcGross = sum(CARDS.filter((x) => x.name.startsWith("MasterCard")), (x) => x.gross);
const RATES = [
  ["VS CA SMALL MERCHANT ELECTRONIC CGP NNSS", 0.77, 5, c(4210.50)],
  ["VS CA SMALL MERCHANT ELECTRONIC INF NNSS", 0.99, 6, c(9880.00)],
  ["VS CA SMALL MERCHANT CNP INF", 1.55, 2, c(3110.00)],
  ["VS CANADA STANDARD CREDIT", 1.45, 1, c(1220.00)],                 // fell to the default rate
  ["VS CANADA STANDARD BUSINESS", 2.10, 4, c(6880.00)],                // published: 2.00%
  ["MC CA WORLD ELITE ELECTRONIC", 1.56, 3, c(3000.00)],
  ["MC CA CORE ELECTRONIC", 0.92, 3, c(2310.40)],
  ["VS ASSESSMENT", 0.09, null, visaGross],
  ["MC ASSESSMENT", 0.09, null, mcGross],
  ["PCI NON-COMPLIANCE ASSESSMENT FEE", 0.15, total("items"), total("gross") + total("refunds")],
  ["INTERAC INTERCHANGE", 0.00, 12, 0],
].map(([d, rate, count, base]) => ({ d, rate, count, base, amt: Math.round(base * rate / 100) }));

// ------------------------------------------------------------------ other charges: [description, count, per item, total $]
const OTHER = [
  ["MONTHLY STATEMENT FEE", null, null, 7.50],
  ["EQUIPMENT RENTAL FEE", null, null, 39.95],
  ["MC ACQUIRER LICENSE FEE", null, null, 0.62],
  ["VISA DIRECT ACQ ASSESSMENT", null, null, 1.38],
  ["AMEX DIRECT ASSESSMENT", null, null, 0.40],                         // no Amex sales this month
  ["SAQ/SCAN INCOMPLETE", null, null, 29.99],
  ["GST/HST", null, null, 6.24],
  ["INTERAC DEBIT TRANSACTION FEE", 13, 0.05, 0.65],
  ["BATCH FEE", 18, 0.05, 0.95],                                       // 18 x $0.05 is $0.90
].map(([d, n, per, t]) => ({ d, n, per, amt: c(t) }));

const discountTotal = total("discount");
const ratesTotal = sum(RATES, (x) => x.amt), otherTotal = sum(OTHER, (x) => x.amt);
const deducted = discountTotal + ratesTotal + otherTotal;

// ------------------------------------------------------------------ deposits: one batch per business day, sales spread out
const salesTotal = total("gross"), creditsTotal = total("refunds");
let seed = 5;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const days = [2, 3, 4, 8, 9, 10, 11, 15, 16, 17, 18, 22, 23, 24, 25, 29, 30];
const w = days.map(() => 0.4 + rand()), ws = sum(w, (x) => x);
let left = salesTotal;
const batches = days.map((d, i) => {
  const s = i === days.length - 1 ? left : Math.round(salesTotal * w[i] / ws);
  left -= s;
  return { day: String(d).padStart(2, "0"), ref: `9100000${String(100 + i * 7).padStart(4, "0")}`, n: 0, sales: s, credits: 0 };
});
batches[3].credits = c(120.00); batches[9].credits = c(210.00);       // the two refunds
// sale counts: spread the 36 sales over the batches
let nLeft = total("n");
batches.forEach((b, i) => { b.n = i === batches.length - 1 ? nLeft : Math.min(nLeft, 1 + (i % 3)); nLeft -= b.n; });

// ------------------------------------------------------------------ EMDR: discount, interchange and assessment per brand
const emdr = [
  ["Visa", visaGross + c(120.00), CARDS.filter((x) => x.name.startsWith("Visa")), /^VS /],
  ["Visa Debit", 0, [], null], ["Visa Prepaid", 0, [], null],
  ["MasterCard", mcGross, CARDS.filter((x) => x.name.startsWith("MasterCard")), /^MC /],
  ["MasterCard Debit", 0, [], null], ["MasterCard Prepaid", 0, [], null],
  ["Interac", c(8950.25 + 210.00), [], null],
].map(([name, vol, cards, re]) => {
  const fees = name === "Interac" ? OTHER.find((x) => x.d === "INTERAC DEBIT TRANSACTION FEE").amt
    : sum(cards, (x) => x.discount) + (re ? sum(RATES.filter((x) => re.test(x.d)), (x) => x.amt) : 0);
  return { name, vol, fees, rate: vol ? (fees / vol) * 100 : 0 };
});

// ------------------------------------------------------------------ HTML
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const td = (x, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${x === "" ? "" : esc(x)}</td>`;
const tr = (cells, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}>${cells.map((x) => td(x)).join("")}</tr>`;
const head = (n) => `<div class="qh"><div>Questions regarding your statement?<br>Contact Client Care: 1-800-555-0199</div><div>Statement Period: September 2026<br>Merchant Number: 999000777000</div></div>`;
const foot = (n, of) => `<div class="pf">Page ${n} of ${of}</div>`;
const N = 4;
const pages = [];
pages.push(`<h1>MERCHANT PROCESSING STATEMENT</h1>
<div class="top"><div>Example Payments Canada<br>100 Sample Street, Suite 1<br>Toronto, Ontario M0M 0M0</div>
<table class="meta"><tr><td>STATEMENT PERIOD:</td><td>SEPTEMBER 2026</td></tr><tr><td>MERCHANT NUMBER:</td><td>999000777000</td></tr><tr><td>CONTACT CLIENT CARE:</td><td>1-800-555-0199</td></tr></table></div>
<p class="addr">LAKESHORE TILE &amp; STONE (SAMPLE)<br>45 SAMPLE AVE UNIT 2<br>MISSISSAUGA ON L0L 0L0</p>
<h2>DEPOSIT SUMMARY</h2>
<table class="dep"><thead>${tr(["Day", "Reference Number", "Tran Code*", "Plan Code*", "Number of Sales", "Amount of Sales", "Amount of Credits", "Discount Paid", "Net Deposit"])}</thead><tbody>
${batches.map((b) => tr([b.day, b.ref, "D", "T", String(b.n).padStart(2, "0"), m(b.sales), m(b.credits), "$.00", m(b.sales - b.credits)])).join("")}
${tr(["Deposit Totals", "", "", "", String(total("n")), m(salesTotal), m(creditsTotal), "$.00", m(salesTotal - creditsTotal)], "tot")}</tbody></table>
<p class="small">* Transaction Codes and Plan Codes are described on the last page of this statement.</p>${foot(1, N)}`);

pages.push(`${head()}<h2>CARD TYPE SUMMARY</h2>
<table class="cards"><thead>${tr(["Card Type", "Number of Sales", "Sales", "Number of Credits", "Credits", "Total Number of Items", "Net Sales", "Average Ticket", "Disc Per Item", "Disc %", "Discount Due"])}</thead><tbody>
${CARDS.map((x) => tr([x.name, String(x.n), m(x.gross), String(x.rn), m(x.refunds), String(x.items), m(x.net), m(x.items ? Math.round(x.net / x.items) : 0), "$.00", x.pct.toFixed(2), m(x.discount)])).join("")}
${tr(["Total", String(total("n")), m(salesTotal), String(total("rn")), m(creditsTotal), String(total("items")), m(total("net")), m(Math.round(total("net") / total("items"))), "", "", m(discountTotal)], "tot")}</tbody></table>
<h2>RATES &amp; FEES</h2>
<table class="rates"><thead>${tr(["Description", "Rate %", "Per Item", "Number of Items", "Amount", "Total"])}</thead><tbody>
${RATES.map((x) => tr([x.d, `${x.rate.toFixed(2)} %`, "$.00", x.count == null ? "" : String(x.count), m(x.base), m(x.amt)])).join("")}
<tr class="tot"><td></td><td></td><td></td><td colspan="2">Total Rates &amp; Fees Due</td><td>${m(ratesTotal)}</td></tr></tbody></table>${foot(2, N)}`);

pages.push(`${head()}<h2>OTHER CHARGES</h2>
<table class="other"><thead>${tr(["Description", "Number of Items", "Per Item", "Total"])}</thead><tbody>
${OTHER.map((x) => tr([x.d, x.n == null ? "" : String(x.n), x.per == null ? "$" : m3(x.per), m(x.amt)])).join("")}
<tr class="tot"><td></td><td colspan="2">Total Other Charges</td><td>${m(otherTotal)}</td></tr></tbody></table>
<h2>FEE SUMMARY</h2>
<table class="fsum"><thead>${tr(["Description", "Amount", "Total"])}</thead><tbody>
${tr(["DISCOUNT TOTAL", m(discountTotal), ""])}${tr(["DISCOUNT PAID", "$.00", ""])}
<tr><td class="r">Net Discount Due</td><td></td><td>${m(discountTotal)}</td></tr>
${tr(["RATES & FEES TOTAL", m(ratesTotal), ""])}${tr(["OTHER CHARGES TOTAL", m(otherTotal), ""])}${tr(["RATES & FEES AND OTHER CHARGES PAID", "$.00", ""])}
<tr><td class="r">Net Rates &amp; Fees and Other Charges</td><td></td><td>${m(ratesTotal + otherTotal)}</td></tr>
<tr class="tot"><td class="r">Total Amount Deducted</td><td></td><td>${m(deducted)}</td></tr></tbody></table>
<h2>EMDR CALCULATIONS</h2>
<table class="emdr"><thead>${tr(["Description", "Volume", "Discount", "EMDR"])}</thead><tbody>
${emdr.map((e) => tr([e.name, m(e.vol), m(e.fees), `${e.rate.toFixed(e.name === "Interac" ? 3 : 2)} %`])).join("")}</tbody></table>
<p class="small">EMDR = Effective Merchant Discount Rate</p>${foot(3, N)}`);

pages.push(`${head()}<p class="small">For questions, contact Client Care. This is a made-up statement for testing; www.examplepay.test is not a real site.</p>
<h2>TRANSACTION CODES</h2><p class="small">D - DEPOSIT &nbsp; C - CHARGEBACK &nbsp; A - ADJUSTMENT</p>
<h2>PLAN CODES</h2><p class="small">VS - VISA &nbsp; MC - MASTERCARD &nbsp; T - ALL PLANS</p>${foot(4, N)}`);

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Sample TSYS-style statement</title><style>
@page { size: 8.5in 11in; margin: 0 }
* { box-sizing: border-box; margin: 0 }
body { font: 9px/1.3 Arial, Helvetica, sans-serif; color: #222 }
.page { width: 816px; height: 1056px; padding: 40px 44px; page-break-after: always; position: relative; overflow: hidden }
h1 { font-size: 14px; text-align: center; margin-bottom: 30px }
h2 { font-size: 11px; text-align: center; margin: 22px 0 8px }
.top { display: flex; justify-content: space-between; } .meta td { padding: 3px 6px }
.addr { margin: 30px 0 }
.qh { display: flex; justify-content: space-between; font-size: 8.5px; margin-bottom: 10px }
.pf { position: absolute; bottom: 14px; left: 0; right: 0; text-align: center; font-size: 8px }
.small { font-size: 8px; margin-top: 6px }
table { border-collapse: collapse; width: 100% }
td { padding: 3px 4px; vertical-align: middle }
thead td { font-weight: 700; vertical-align: bottom; border-bottom: 1px solid #999; font-size: 8.5px }
tr.tot td { font-weight: 700; border-top: 1px solid #999 }
td.r { text-align: right }
table.dep td:nth-child(n+5), table.cards td:nth-child(n+2), table.rates td:nth-child(n+2), table.other td:nth-child(n+2), table.fsum td:nth-child(n+2), table.emdr td:nth-child(n+2) { text-align: right }
table.cards td:first-child { width: 62px } table.rates td:first-child { width: 160px } table.cards thead td { white-space: normal }
</style></head><body>${pages.map((p) => `<div class="page">${p}</div>`).join("")}</body></html>`;

fs.mkdirSync("sample", { recursive: true });
fs.writeFileSync("sample/sample_statement_ca.html", html);
console.log(`sales ${m(salesTotal)}, refunds ${m(creditsTotal)}, deducted ${m(deducted)} (discount ${m(discountTotal)}, rates ${m(ratesTotal)}, other ${m(otherTotal)})`);

if (process.argv.includes("--pdf")) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");   // or a global install
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.pdf({ path: "sample/sample_statement_ca.pdf", width: "8.5in", height: "11in", printBackground: true });
  await browser.close();
  console.log("wrote sample/sample_statement_ca.pdf");
}
