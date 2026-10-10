// node --test tests/fees.test.mjs
// The Card Fee Checker on the made-up sample statement (sample/sample_statement.pdf). The fixture is
// the text pdf.js reads from that PDF, so these tests run without a browser. The sample has four
// problems planted on purpose; each one must be found, and nothing else may be flagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const S = require("../fees/statement.js");
const R = require("../fees/rates.js");
const K = require("../fees/check.js");
const items = require("./fixtures/sample_statement_items.json");

const read = () => S.parse(S.linesFromItems(items));
const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);

test("every table on the statement is read", () => {
  const st = read();
  assert.equal(st.ok, true);
  assert.deepEqual(st.period, { from: "2026-08-01", to: "2026-08-31" });
  assert.equal(st.days.length, 26);
  assert.equal(st.dayTotal.submitted, 9622930);
  assert.equal(st.dayTotal.fees, -266526);
  assert.deepEqual(st.cardTypes.map((c) => c.brand), ["MASTERCARD", "VISA", "DISCOVER", "AMEX ACQ"]);
  assert.equal(st.feeLines.length, 50);
  assert.equal(st.ic.length, 21);
  assert.equal(st.subtotals.length, 3);
  assert.deepEqual(st.warnings, []);
});

test("the statement adds up, and the one bad line is caught", () => {
  const a = K.analyze(read());
  assert.equal(a.ok, true);
  const failed = a.checks.filter((c) => !c.ok).map((c) => c.label);
  assert.deepEqual(failed, ["Every fee line that shows its own calculation adds up"]);
  const bad = a.lines.filter((l) => l.mathOk === false);
  assert.equal(bad.length, 1);
  assert.match(bad[0].description, /^BATCH SETTLEMENT FEE 26 TRANSACTIONS AT 0.05/);
  assert.equal(bad[0].mathExpected, 130);
});

test("every dollar is sorted, and the parts add back to the total", () => {
  const a = K.analyze(read());
  assert.equal(a.buckets.unknown, 0);
  assert.equal(a.buckets.interchange + a.buckets.network + a.buckets.processor, a.fees);
  assert.equal(a.buckets.interchange, -sum(a.st.ic, "total"));
  const who = (re) => a.lines.find((l) => re.test(l.description)).cls;
  assert.equal(who(/MC LICENSE VOLUME/), "network");          // looks like a markup line ("DISC RATE"), isn't
  assert.equal(who(/VISA NETWORK FEE/), "network");           // filed under "Fees" by the statement
  assert.equal(who(/VISA ASSESSMENT FEE CR/), "network");     // filed under "Interchange Charges"
  assert.equal(who(/PCI NON-COMPLIANCE/), "processor");
  assert.equal(who(/VISA SALES DISCOUNT/), "processor");
  assert.equal(who(/AXP RETAIL T1/), "interchange");
  const brands = sum(a.byBrand, "fees") + a.unbranded;
  assert.equal(brands, a.fees);
});

test("interchange is checked against the published rates", () => {
  const a = K.analyze(read());
  assert.deepEqual(a.rateSummary, { match: 18, above: 1, below: 0, differs: 0, unchecked: 1, refund: 1 });
  const above = a.ic.find((r) => r.verdict === "above");
  assert.equal(above.description, "MC-ENHANCED MERIT III");
  assert.equal(above.over, 312);                               // 0.10% of $3,120.45
  assert.equal(a.ic.find((r) => r.verdict === "unchecked").description, "DSCVR PSL RETAIL");
  assert.ok(a.netRates.length === 5 && a.netRates.every((n) => n.ok));
});

test("the findings name the planted problems, biggest first", () => {
  const a = K.analyze(read());
  const titles = a.findings.map((f) => f.title);
  for (const t of ["Charged above the published rate", "A sale paid the most expensive rate", "A fee line doesn't add up",
    "A fee you can usually make go away", "What your processor charges on top", "Keyed-in and online sales cost more"]) assert.ok(titles.includes(t), t);
  const amounts = a.findings.map((f) => f.amount);
  assert.deepEqual(amounts, [...amounts].sort((x, y) => y - x));
  const markup = a.findings.find((f) => f.kind === "markup");
  assert.match(markup.text, /0\.60% on Amex and 0\.45% on Mastercard, Visa, Discover/);
});

test("a statement that doesn't add up is refused, not shown", () => {
  const st = read();
  st.feeLines[3] = { ...st.feeLines[3], amount: st.feeLines[3].amount - 100 };   // one line a dollar off
  const a = K.analyze(st);
  assert.equal(a.ok, false);
  assert.match(a.reason, /didn't add up/);
});

test("other layouts and scans get a clear message", () => {
  const scan = S.parse([]);
  assert.equal(scan.ok, false);
  assert.match(scan.reason, /no text/);
  const square = S.parse(S.linesFromItems([{ page: 1, s: "Square monthly statement", x: 10, y: 700, w: 100 }]));
  assert.match(square.reason, /isn't fully supported yet \(it looks like Square\)/);
});

test("published rates: spot checks against Visa's April 2026 schedule", () => {
  const r = (b, d) => R.lookup(b, d).rates.map((x) => [x.pct, x.fix]);
  assert.deepEqual(r("VISA", "VI-ECOMM BSC P1 SIGN PREFERRED"), [[2.50, 0.10]]);
  assert.deepEqual(r("VISA", "VI-CPS RETAIL P2 INFINITE SQ"), [[2.30, 0.10]]);
  assert.deepEqual(r("VISA", "VI-US BUS TR3 PRD 2"), [[2.10, 0.10]]);
  assert.deepEqual(r("VISA", "VI-NON QUAL CONSUMER CR"), [[3.15, 0.10]]);
  assert.deepEqual(r("VISA", "VI-REG CONSUMER MQ (DB)"), [[0.05, 0.21], [0.05, 0.22]]);
  assert.deepEqual(r("AMEX ACQ", "AXP HEALTHCARE NONSWIPE T2"), [[2.15, 0.10]]);
  assert.equal(R.lookup("MASTERCARD", "MC-HIGH VAL MERIT I"), null);       // no source on file: not guessed
});

test("pieces of text on one baseline become cells; split words are joined", () => {
  const lines = S.linesFromItems([
    { page: 1, s: "VISA AUTH", x: 100, y: 500, w: 40 }, { page: 1, s: "FEE", x: 141.5, y: 500.4, w: 15 },
    { page: 1, s: "-$1.00", x: 400, y: 500, w: 20 }, { page: 1, s: "Next row", x: 100, y: 490, w: 30 },
  ]);
  assert.deepEqual(lines.map((l) => l.cells.map((c) => c.s)), [["VISA AUTH FEE", "-$1.00"], ["Next row"]]);
  assert.equal(S.cents("-$1,234.56"), -123456);
  assert.equal(S.cents("$0.07"), 7);
});

test("comparing a quote", () => {
  const a = K.analyze(read());
  const same = K.whatIf(a, { pct: 0, perTxn: 0 });
  assert.equal(same.then, 0);
  const cheaper = K.whatIf(a, { pct: 0.30, perTxn: 0.05 });
  assert.equal(cheaper.then, Math.round(same.vol * 0.003 + same.count * 5));
  assert.ok(cheaper.saving > 0);
});

// ------------------------------------------------------------------ the Canadian (TSYS) layout
const caItems = require("./fixtures/sample_statement_ca_items.json");
const readCA = () => S.parse(S.linesFromItems(caItems));

test("TSYS: every section is read, wrapped names included", () => {
  const st = readCA();
  assert.equal(st.ok, true);
  assert.equal(st.layoutKey, "tsys");
  assert.equal(st.currency, "CAD");
  assert.deepEqual(st.period, { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(st.batches.length, 17);
  assert.equal(st.sales, 3956115 - 33000);
  assert.equal(st.feeTotal, -66057);
  assert.ok(st.cardRows.some((c) => c.name === "Visa Business"));            // "Visa" above, "Business" below
  assert.ok(st.rateLines.some((r) => r.description === "VS CA SMALL MERCHANT ELECTRONIC CGP NNSS"));
  assert.deepEqual(st.ic.map((r) => r.brand), ["VISA", "VISA", "VISA", "VISA", "VISA", "MASTERCARD", "MASTERCARD", "INTERAC"]);
});

test("TSYS: it adds up, against the statement's own effective-rate table too", () => {
  const a = K.analyze(readCA());
  assert.equal(a.ok, true);
  assert.deepEqual(a.checks.filter((c) => !c.ok).map((c) => c.label), ["Every fee line that shows its own calculation adds up"]);
  assert.match(a.lines.find((l) => l.mathOk === false).description, /^BATCH FEE$/);
  assert.ok(a.checks.find((c) => /EMDR/.test(c.label)).ok);
  assert.equal(a.buckets.unknown, 0);
  assert.equal(a.buckets.interchange + a.buckets.network + a.buckets.processor, 66057);
});

test("TSYS: Visa Canada's published rates, and the planted problems", () => {
  const a = K.analyze(readCA());
  assert.deepEqual(a.rateSummary, { match: 4, above: 1, below: 0, differs: 0, unchecked: 2, refund: 1 });
  const above = a.ic.find((r) => r.verdict === "above");
  assert.equal(above.description, "VS CANADA STANDARD BUSINESS");
  assert.equal(above.over, 688);                                  // 0.10% of $6,880.00
  const titles = a.findings.map((f) => f.title);
  for (const t of ["Charged above the published rate", "A sale paid the most expensive rate", "A fee line doesn't add up",
    "A fee you can usually make go away", "Amex fees with no Amex sales", "The statement's own effective rate leaves fees out"]) assert.ok(titles.includes(t), t);
  const who = (re) => a.lines.find((l) => re.test(l.description)).cls;
  assert.equal(who(/PCI NON-COMPLIANCE ASSESSMENT/), "processor");      // says "assessment", isn't a network's
  assert.equal(who(/^VS ASSESSMENT$/), "network");
  assert.equal(who(/^GST\/HST$/), "processor");
});

test("Visa Canada rates change on 24 October 2026", () => {
  const before = R.lookup("VISA", "VS CA SMALL MERCHANT ELECTRONIC CGP NNSS", { country: "CA", date: "2026-10-01" });
  const after = R.lookup("VISA", "VS CA SMALL MERCHANT ELECTRONIC CGP NNSS", { country: "CA", date: "2026-11-01" });
  assert.equal(before.rates[0].pct, 0.77);
  assert.equal(after.rates[0].pct, 0.70);
  assert.equal(R.lookup("VISA", "VS CA SMALL MERCHANT ELECTRONIC INF PLUS", { country: "CA", date: "2026-11-01" }), null);   // not published yet
});

test("any other statement: labelled totals are found, with the line they came from", () => {
  const lines = S.linesFromItems([
    { page: 1, s: "Acme Payments monthly statement", x: 10, y: 700, w: 100 },
    { page: 1, s: "Total Sales", x: 10, y: 600, w: 40 }, { page: 1, s: "$12,345.67", x: 300, y: 600, w: 40 },
    { page: 2, s: "Total Fees Charged", x: 10, y: 500, w: 60 }, { page: 2, s: "-$345.10", x: 300, y: 500, w: 40 },
  ]);
  const st = S.parse(lines);
  assert.equal(st.ok, false);
  assert.deepEqual(st.totals.sales, { cents: 1234567, line: "Total Sales $12,345.67", page: 1 });
  assert.equal(st.totals.fees.cents, 34510);
});

// ------------------------------------------------------------------ the general reader, on layouts it has no rules for
const G = require("../fees/generic.js");
const fixture = (name) => S.linesFromItems(require(`./fixtures/${name}`));

test("general reader: the two known layouts give the same answers as their own readers", () => {
  for (const [file, own] of [["sample_statement_items.json", read()], ["sample_statement_ca_items.json", readCA()]]) {
    const g = G.read(fixture(file));
    assert.equal(g.ok, true, file);
    const a = K.analyze(g), b = K.analyze(own);
    assert.equal(a.fees, b.fees, file);
    assert.equal(a.sales, b.sales, file);
    assert.deepEqual(a.buckets, b.buckets, file);
    assert.equal(a.rateSummary.above, b.rateSummary.above, file);
    assert.equal(a.rateSummary.match, b.rateSummary.match, file);
  }
});

test("general reader: a new interchange-plus layout is read and checked", () => {
  const g = G.read(fixture("statement_other_a_items.json"));
  assert.equal(g.ok, true);
  assert.equal(g.feeTotal, -132692);
  assert.deepEqual(g.sectionsUsed.map((x) => x.label), ["Total Interchange and Program Fees", "Total Card Brand Fees", "Total Processor Fees"]);
  assert.equal(g.sales, 4985050);
  const a = K.analyze(g);
  assert.equal(a.buckets.unknown, 0);
  assert.deepEqual(a.rateSummary, { match: 6, above: 1, below: 0, differs: 0, unchecked: 0, refund: 0 });
  assert.equal(a.ic.find((r) => r.verdict === "above").description, "VI-ECOMM BSC P1 SIGN PREFERRED");
  assert.match(a.lines.find((l) => l.mathOk === false).description, /^AUTHORIZATION FEE$/);
  assert.ok(a.findings.some((f) => f.title === "A fee you can usually make go away"));
});

test("general reader: flat-rate statements are read, and said to be flat-rate", () => {
  const g = G.read(fixture("statement_other_b_items.json"));
  assert.equal(g.ok, true);
  assert.equal(g.feeTotal, -37877);
  assert.equal(g.sales, 1292813);                              // net sales, not gross
  const a = K.analyze(g);
  assert.equal(a.findings[0].title, "Fees are only shown by day");
});

test("general reader: a statement whose fees don't reach its printed total is refused", () => {
  const g = G.read(fixture("statement_other_c_items.json"));
  assert.equal(g.ok, false);
  assert.match(g.reason, /adds up to its printed fee total/);
  const any = G.parseAny(fixture("statement_other_c_items.json"));
  assert.equal(any.ok, false);
  assert.equal(any.totals.fees.cents, 132792);                 // the quick check still gets the totals
});

test("general reader: sections closed by \"Subtotal\" lines", () => {
  const it = (s, x, y) => ({ page: 1, s, x, y, w: s.length * 4 });
  const g = G.read(S.linesFromItems([it("Total Sales", 10, 760), it("$10,000.00", 300, 760),
    it("Monthly Fee", 10, 700), it("$9.95", 300, 700), it("Gateway Fee", 10, 690), it("$10.00", 300, 690), it("Subtotal", 10, 680), it("$19.95", 300, 680),
    it("Visa Assessment", 10, 660), it("$14.00", 300, 660), it("MC Assessment", 10, 650), it("$6.00", 300, 650), it("Subtotal", 10, 640), it("$20.00", 300, 640),
    it("Total Fees Charged", 10, 620), it("$39.95", 300, 620)]));
  assert.equal(g.ok, true);
  assert.equal(g.feeTotal, -3995);
  assert.equal(g.sectionsUsed.length, 2);
});
