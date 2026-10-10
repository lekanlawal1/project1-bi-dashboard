// Builds the made-up sample statement for the Card Fee Checker: a fictional shop, one month of
// card sales, laid out like a CardPointe (Fiserv) statement. Every total is computed from the rows,
// so the statement adds up to the cent, and a few problems are planted on purpose for the checker
// to find: one Mastercard line billed above its published rate, one non-qualified Visa sale, one
// fee line whose own arithmetic is wrong, and the usual processor extras.
//
//   node tools/sample_statement.mjs            writes sample/sample_statement.html
//   node tools/sample_statement.mjs --pdf      also prints it to sample/sample_statement.pdf (Playwright)
//
// No real business, merchant or statement is used.
import fs from "node:fs";

// ------------------------------------------------------------------ the month's interchange lines
// [description, sales $, count, rate, per item $]
const IC = {
  MASTERCARD: [
    ["MC-WORLD ELITE MERIT III", 7980.25, 84, 0.0230, 0.10],
    ["MC-WORLD ELITE MERIT I", 2410.90, 30, 0.0260, 0.10],
    ["MC-ENHANCED MERIT III", 3120.45, 41, 0.0190, 0.10],          // published: 1.80%
    ["MC-CORE MERIT III", 2260.00, 37, 0.0165, 0.10],
    ["MC-MERIT III (DB)", 2870.15, 66, 0.0105, 0.15],
    ["MC-REG CONSM WFRAUD ADJ MC(DB)", 1960.80, 52, 0.0005, 0.22],
    ["MC-BUS LEVEL 2 DATA RATE II", 1450.00, 6, 0.0205, 0.10],
  ],
  VISA: [
    ["VI-CPS RETAIL P2 SIGN PREFERRED", 18420.55, 212, 0.0210, 0.10],
    ["VI-CPS RETAIL P2 TRAD", 9880.10, 160, 0.0151, 0.10],
    ["VI-CPS RETAIL P2 INFINITE SQ", 6210.00, 48, 0.0230, 0.10],
    ["VI-ECOMM BSC P1 SIGN PREFERRED", 7450.20, 95, 0.0250, 0.10],
    ["VI-ECOMM BSC P1 TRAD", 3105.75, 61, 0.0204, 0.10],
    ["VI-CPS/RETAIL (DB)", 5640.30, 140, 0.0080, 0.15],
    ["VI-CPS/ECOMM-BASIC (DB)", 1990.40, 38, 0.0165, 0.15],
    ["VI-REG CONSUMER MQ (DB)", 8315.60, 205, 0.0005, 0.22],
    ["VI-NON QUAL CONSUMER CR", 1240.00, 6, 0.0315, 0.10],          // a downgrade
    ["VI-MOTO ECOMM CREDIT", -312.40, 3, 0, 0],                      // refunds
  ],
  DISCOVER: [
    ["DSCVR PSL RETAIL", 1880.35, 22, 0.0156, 0.10],
  ],
  "AMEX ACQ": [
    ["AXP RETAIL T1", 2145.60, 46, 0.0145, 0.10],
    ["AXP RETAIL T2", 6890.30, 31, 0.0205, 0.10],
    ["AXP RETAIL NONSWIPE T2", 1320.00, 8, 0.0235, 0.10],
  ],
};
const MARKUP = 0.0045, AMEX_MARKUP = 0.0060, AUTH = 0.08;
const EXTRA_AUTHS = { VISA: 31, MASTERCARD: 12, DISCOVER: 2, "AMEX ACQ": 5 };   // declines and retries

// ------------------------------------------------------------------ cents and formatting
const c = (d) => Math.round(d * 100);
const r2 = (x) => Math.round(x);                                              // x already in cents
const fmt = (cents) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plain = (cents) => (Math.abs(cents) / 100).toFixed(2);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

// ------------------------------------------------------------------ derived numbers
const rows = [];
for (const [brand, list] of Object.entries(IC)) for (const [d, s, n, rate, per] of list) {
  const sales = c(s), total = sales <= 0 ? 0 : -r2(sales * rate + n * per * 100);
  rows.push({ brand, d, sales, n, rate, per: c(per), total });
}
const brands = Object.keys(IC);
const card = Object.fromEntries(brands.map((b) => {
  const br = rows.filter((x) => x.brand === b);
  const pos = br.filter((x) => x.sales > 0), neg = br.filter((x) => x.sales < 0);
  return [b, { grossItems: sum(pos, (x) => x.n), gross: sum(pos, (x) => x.sales), refundItems: sum(neg, (x) => x.n), refunds: sum(neg, (x) => x.sales) }];
}));
for (const b of brands) Object.assign(card[b], { netItems: card[b].grossItems + card[b].refundItems, net: card[b].gross + card[b].refunds });
const isDebit = (x) => /\((DB|PP)\)/.test(x.d);
const visaDB = sum(rows.filter((x) => x.brand === "VISA" && x.sales > 0 && isDebit(x)), (x) => x.sales);
const visaCR = card.VISA.gross - visaDB;
const mcDB = sum(rows.filter((x) => x.brand === "MASTERCARD" && x.sales > 0 && isDebit(x)), (x) => x.sales);
const mcCR = card.MASTERCARD.gross - mcDB;
const mcBig = c(1450.00 + 1210.00);                       // Mastercard sales of $1,000 or more
const auths = Object.fromEntries(brands.map((b) => [b, card[b].grossItems + card[b].refundItems + EXTRA_AUTHS[b]]));

// ------------------------------------------------------------------ fee lines: [category, product, description, type, cents]
const L = [];
const fee = (cat, prod, d, type, cents) => L.push({ cat, prod, d, type, amt: -Math.round(cents) });
const at = (n, r) => n * r * 100;
fee("Account Fees", "Miscellaneous", "MC MONTHLY LOCATION FEE", "Fees", 125);
fee("Account Fees", "Miscellaneous", "PCI NON-COMPLIANCE FEE", "Fees", 2995);
fee("Account Fees", "Miscellaneous", "STATEMENT FEE", "Fees", 995);
fee("Account Fees", "Miscellaneous", "VISA NETWORK FEE CP 1-03", "Fees", 900);
for (const x of rows.filter((x) => x.brand === "AMEX ACQ")) fee("Program Fees", "Amex", x.d, "Program Fees", -x.total);
fee("Program Fees", "Amex", `AXP ACQUIRER TRANS FEE ${card["AMEX ACQ"].grossItems} TRANSACTIONS AT 0.02`, "Program Fees", at(card["AMEX ACQ"].grossItems, 0.02));
fee("Program Fees", "Amex", `AMEX ASSESSMENT FEE 0.00165 TIMES $${plain(card["AMEX ACQ"].gross)}`, "Program Fees", card["AMEX ACQ"].gross * 0.00165);
const T = "Transaction Fees";
fee(T, "Miscellaneous", "GATEWAY PLATFORM FEE", "Service Charges", 1500);
fee(T, "Miscellaneous", `AMEX SALES DISCOUNT ${AMEX_MARKUP} DISC RATE TIMES $${plain(card["AMEX ACQ"].gross)}`, "Service Charges", card["AMEX ACQ"].gross * AMEX_MARKUP);
fee(T, "Miscellaneous", "BATCH SETTLEMENT FEE 26 TRANSACTIONS AT 0.05", "Fees", 140);   // should be $1.30
fee(T, "Miscellaneous", `VI BASE II SYSTEM FILE FEE ${card.VISA.grossItems} TRANSACTIONS AT 0.0025`, "Service Charges", at(card.VISA.grossItems, 0.0025));
fee(T, "Mastercard", `MASTERCARD SALES DISCOUNT ${MARKUP} DISC RATE TIMES $${plain(mcCR)}`, "Service Charges", mcCR * MARKUP);
fee(T, "Mastercard", `MASTERCARD DEBIT SALES DISC ${MARKUP} DISC RATE TIMES $${plain(mcDB)}`, "Service Charges", mcDB * MARKUP);
fee(T, "Mastercard", `MASTERCARD ASSESSMENT FEE 0.0014 TIMES $${plain(card.MASTERCARD.gross)}`, "Interchange Charges", card.MASTERCARD.gross * 0.0014);
fee(T, "Mastercard", `MC ASSESSMNT TRAN AMT >=$1K 0 X TRNS $${plain(mcBig)}`, "Interchange Charges", mcBig * 0.0001);
fee(T, "Mastercard", `MC LICENSE VOLUME FEE 0.000046 DISC RATE TIMES $${plain(card.MASTERCARD.gross)}`, "Service Charges", card.MASTERCARD.gross * 0.000046);
fee(T, "Mastercard", `MASTERCARD AUTH FEE ${auths.MASTERCARD} TRANSACTIONS AT ${AUTH}`, "Fees", at(auths.MASTERCARD, AUTH));
fee(T, "Mastercard", `MC NETWORK ACCESS AUTH FEE ${auths.MASTERCARD} TRANSACTIONS AT 0.0195`, "Fees", at(auths.MASTERCARD, 0.0195));
for (const x of rows.filter((x) => x.brand === "MASTERCARD")) fee(T, "Mastercard", x.d, "Interchange Charges", -x.total);
fee(T, "Visa", `VISA SALES DISCOUNT ${MARKUP} DISC RATE TIMES $${plain(visaCR)}`, "Service Charges", visaCR * MARKUP);
fee(T, "Visa", `VISA DEBIT SALES DISCOUNT ${MARKUP} DISC RATE TIMES $${plain(visaDB)}`, "Service Charges", visaDB * MARKUP);
fee(T, "Visa", `VISA ASSESSMENT FEE CR 0.0014 TIMES $${plain(visaCR)}`, "Interchange Charges", visaCR * 0.0014);
fee(T, "Visa", `VISA ASSESSMENT FEE DB 0.0013 TIMES $${plain(visaDB)}`, "Interchange Charges", visaDB * 0.0013);
fee(T, "Visa", `VISA AUTH FEE ${auths.VISA} TRANSACTIONS AT ${AUTH}`, "Fees", at(auths.VISA, AUTH));
const visaCRn = sum(rows.filter((x) => x.brand === "VISA" && x.sales > 0 && !isDebit(x)), (x) => x.n), visaDBn = card.VISA.grossItems - visaCRn;
fee(T, "Visa", `VI NTWK ACQ PROC FEE US CR ${visaCRn} TRANSACTIONS AT 0.0195`, "Fees", at(visaCRn, 0.0195));
fee(T, "Visa", `VI NTWK ACQ PROC FEE US DB/PP ${visaDBn} TRANSACTIONS AT 0.0155`, "Fees", at(visaDBn, 0.0155));
fee(T, "Visa", `VI NEVER APPROVE REATTEMPT FEE 3 TRANSACTIONS AT 0.1`, "Fees", at(3, 0.1));
for (const x of rows.filter((x) => x.brand === "VISA" && x.total)) fee(T, "Visa", x.d, "Interchange Charges", -x.total);
fee(T, "Discover", `DISCOVER SALES DISCOUNT ${MARKUP} DISC RATE TIMES $${plain(card.DISCOVER.gross)}`, "Service Charges", card.DISCOVER.gross * MARKUP);
fee(T, "Discover", `DISCOVER ASSESSMENT FEE 0.0014 TIMES $${plain(card.DISCOVER.gross)}`, "Interchange Charges", card.DISCOVER.gross * 0.0014);
fee(T, "Discover", `DISCOVER AUTH FEE ${auths.DISCOVER} TRANSACTIONS AT ${AUTH}`, "Fees", at(auths.DISCOVER, AUTH));
fee(T, "Discover", `DISCOVER DATA USAGE FEE ${card.DISCOVER.grossItems} TRANSACTIONS AT 0.0025`, "Service Charges", at(card.DISCOVER.grossItems, 0.0025));
for (const x of rows.filter((x) => x.brand === "DISCOVER")) fee(T, "Discover", x.d, "Interchange Charges", -x.total);
fee(T, "Amex", `AMEX AUTH FEE ${auths["AMEX ACQ"]} TRANSACTIONS AT ${AUTH}`, "Fees", at(auths["AMEX ACQ"], AUTH));

const feeTotal = sum(L, (x) => x.amt);
const salesNet = sum(brands, (b) => card[b].net);

// ------------------------------------------------------------------ days: August 2026, every weekday plus Saturdays
let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const days = [];
for (let d = 1; d <= 31; d++) {
  const dt = new Date(Date.UTC(2026, 7, d));
  if (dt.getUTCDay() === 0) continue;
  days.push({ date: `08/${String(d).padStart(2, "0")}/2026`, w: 0.6 + rand() + (dt.getUTCDay() === 6 ? 0.8 : 0) });
}
const wsum = sum(days, (x) => x.w);
let left = salesNet;
days.forEach((x, i) => { x.sub = i === days.length - 1 ? left : Math.round(salesNet * x.w / wsum); left -= x.sub; });

// ------------------------------------------------------------------ fee summary by type and column
const COLS = ["Visa", "Mastercard", "Amex", "Discover", "Debit", "Others", "Total"];
const colOf = (p) => (["Visa", "Mastercard", "Amex", "Discover"].includes(p) ? p : "Others");
const TYPES = ["Fees", "Interchange Charges", "Program Fees", "Service Charges"];
const byType = Object.fromEntries([...TYPES, "Total"].map((t) => [t, Object.fromEntries(COLS.map((k) => [k, 0]))]));
for (const x of L) { byType[x.type][colOf(x.prod)] += x.amt; byType[x.type].Total += x.amt; byType.Total[colOf(x.prod)] += x.amt; byType.Total.Total += x.amt; }

// ------------------------------------------------------------------ HTML, one fixed page at a time
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PERIOD = "PERIOD: 08/01/2026-08/31/2026", MERCHANT = "Merchant Number: 999000123456";
const pages = [];
const head = (n, of) => `<div class="ph"><span>${PERIOD}</span><span>Page ${n} of ${of}</span><span>${MERCHANT}</span></div>`;
const table = (cls, header, body) => `<table class="${cls}"><thead>${header}</thead><tbody>${body}</tbody></table>`;
const tr = (cells, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}>${cells.map((x) => `<td>${x === "" ? "" : esc(x)}</td>`).join("")}</tr>`;

// page 1: account summary and the first days
const p1 = `<div class="top"><div class="co">Example Merchant Services<br>100 Sample Way, Springfield, ST 00000</div><div class="pg">Page 1 of PAGES</div>
  <div class="cs">Customer Service<br>www.examplepay.test<br>1-800-555-0100</div></div>
  <div class="title"><span>YOUR CARD PROCESSING STATEMENT</span><span>THIS IS NOT A BILL</span></div>
  <div class="title sm"><span>${PERIOD}</span><span>${MERCHANT}</span></div>
  <p class="addr">HARBOUR STREET OUTFITTERS (SAMPLE)<br>12 HARBOUR ST<br>SPRINGFIELD ST 00000</p>
  <h2>Account Summary</h2>
  <div class="sumbox"><div><small>Amount Submitted</small><b>${fmt(salesNet)}</b></div><div><small>Disputes</small><b>$0.00</b></div><div><small>Adjustments</small><b>$0.00</b></div>
  <div><small>Fees</small><b>${fmt(feeTotal)}</b></div><div><small>Amount Processed</small><b>${fmt(salesNet + feeTotal)}</b></div></div>
  <h2>Summary By Day</h2>`;
const dayHead = tr(["Date Submitted", "Amount Submitted", "Disputes", "Adjustments", "Fees", "Amount Processed"]);
const dayRow = (x) => tr([x.date, fmt(x.sub), "$0.00", "$0.00", "$0.00", fmt(x.sub)]);
pages.push(p1 + table("days", dayHead, days.slice(0, 12).map(dayRow).join("")));
pages.push(`<h2>Summary By Day</h2>` + table("days", dayHead, days.slice(12).map(dayRow).join("") +
  tr(["Month End Charge", "$0.00", "$0.00", "$0.00", fmt(feeTotal), fmt(feeTotal)]) + tr(["Total", fmt(salesNet), "$0.00", "$0.00", fmt(feeTotal), fmt(salesNet + feeTotal)], "tot")) +
  `<h2>Summary by Card Type</h2>` + table("cards",
    tr(["Card Type", "Average Ticket", "Items", "Amount", "Items", "Amount", "Items", "Amount"]),
    brands.map((b) => tr([b, fmt(Math.round(card[b].gross / card[b].grossItems)), String(card[b].grossItems), fmt(card[b].gross), String(card[b].refundItems), fmt(card[b].refunds), String(card[b].netItems), fmt(card[b].net)])).join("") +
    tr(["Total", String(sum(brands, (b) => card[b].grossItems)), fmt(sum(brands, (b) => card[b].gross)), String(sum(brands, (b) => card[b].refundItems)), fmt(sum(brands, (b) => card[b].refunds)), String(sum(brands, (b) => card[b].netItems)), fmt(salesNet)], "tot")) +
  `<h2>Fee Summary</h2>` + table("ftype", tr(["Type", ...COLS]), [...TYPES, "Total"].map((t) => tr([t, ...COLS.map((k) => fmt(byType[t][k]))], t === "Total" ? "tot" : "")).join("")));

// fee lines, split over pages with the header repeated
const feeHead = `<div class="sec"><h2>Fees</h2><span>Amount charged to authorize, process and settle card transactions</span></div>`;
const feeCols = tr(["Category", "Product", "Description", "Type", "Amount"]);
const feeRows = [];
const cats = [...new Set(L.map((x) => x.cat))];
for (const cat of cats) {
  const list = L.filter((x) => x.cat === cat);
  let lastProd = null;
  list.forEach((x, i) => {
    feeRows.push(tr([i === 0 ? cat : "", x.prod !== lastProd ? x.prod : "", x.d, x.type, fmt(x.amt)]));
    lastProd = x.prod;
  });
  feeRows.push(tr(["Total", "", "", "", fmt(sum(list, (x) => x.amt))], "tot"));
}
for (let i = 0; i < feeRows.length; i += 52) pages.push(feeHead + table("fees", feeCols, feeRows.slice(i, i + 52).join("")));

// interchange table
const icHead = `<div class="sec"><h2>Interchange Charges / Program Fees</h2><span>These are the variable fees charged by card organizations for processing transactions.</span></div>`;
const icCols = tr(["Product Description", "Sales Total", "% of Sales", "No. of Transactions", "% of Transaction", "Rate", "Sub Transaction", "Total Interchange / Program Charges"]);
const icRows = [];
for (const b of brands) {
  const br = rows.filter((x) => x.brand === b), bs = sum(br, (x) => x.sales), bn = sum(br, (x) => x.n);
  icRows.push(`<tr class="brand"><td>${b}</td></tr>`);
  for (const x of br) icRows.push(tr([x.d, fmt(x.sales), `${Math.round((x.sales / bs) * 100)}%`, String(x.n), `${Math.round((x.n / bn) * 100)}%`, x.rate.toFixed(4), fmt(x.per), fmt(x.total)]));
  icRows.push(tr([`${b} Total`, fmt(bs), String(bn), fmt(sum(br, (x) => x.total))], "tot"));
}
icRows.push(tr(["Total", fmt(salesNet), String(sum(rows, (x) => x.n)), fmt(sum(rows, (x) => x.total))], "tot"));
for (let i = 0; i < icRows.length; i += 40) pages.push(icHead + table("ic", icCols, icRows.slice(i, i + 40).join("")));

const N = pages.length;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Sample card processing statement</title><style>
@page { size: 612pt 792pt; margin: 0 }
* { box-sizing: border-box; margin: 0 }
body { font: 9px/1.35 Helvetica, Arial, sans-serif; color: #222 }
.page { width: 816px; height: 1056px; padding: 36px 48px; page-break-after: always; position: relative; overflow: hidden }
.ph { display: flex; justify-content: space-between; font-size: 8px; color: #555; margin-bottom: 18px }
.top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px }
.co, .cs { font-size: 8px } .cs { text-align: right }
.title { display: flex; justify-content: space-between; font-weight: 700; font-size: 11px; margin-top: 4px } .title.sm { font-size: 9px; font-weight: 400 }
.addr { margin: 16px 0 }
h2 { font-size: 12px; margin: 16px 0 6px }
.sec { display: flex; gap: 14px; align-items: baseline } .sec span { font-size: 8px; color: #555 }
.sumbox { display: flex; gap: 36px; border: 1px solid #ccc; padding: 10px; border-radius: 6px }
.sumbox small { display: block; font-size: 8px; color: #555 } .sumbox b { font-size: 10px }
table { border-collapse: collapse; width: 100% }
td { padding: 2.5px 4px; white-space: nowrap; vertical-align: baseline }
thead td { font-weight: 700; border-bottom: 1px solid #999 }
tr.tot td { font-weight: 700; border-top: 1px solid #ccc }
tr.brand td { font-weight: 700; padding-top: 6px }
table.days td:not(:first-child), table.cards td:not(:first-child), table.ftype td:not(:first-child) { text-align: right }
table.fees td:last-child, table.ic td:nth-child(n+2) { text-align: right }
table.fees td:nth-child(1) { width: 80px } table.fees td:nth-child(2) { width: 70px } table.fees td:nth-child(4) { width: 100px }
table.ic thead td { white-space: normal; font-size: 8px }
</style></head><body>${pages.map((p, i) => `<div class="page">${i ? head(i + 1, N) : ""}${p.replace("PAGES", N)}</div>`).join("")}</body></html>`;

fs.mkdirSync("sample", { recursive: true });
fs.writeFileSync("sample/sample_statement.html", html);
console.log(`sales ${fmt(salesNet)}, fees ${fmt(feeTotal)}, ${L.length} fee lines, ${N} pages`);

if (process.argv.includes("--pdf")) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");   // or a global install
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.pdf({ path: "sample/sample_statement.pdf", width: "8.5in", height: "11in", printBackground: true });
  await browser.close();
  console.log("wrote sample/sample_statement.pdf");
}
