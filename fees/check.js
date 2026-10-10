/* Card Fee Checker, step 3: check the statement and explain it.

   analyze() takes what statement.js read and returns:
   - checks: does the statement add up? The daily totals and the fee lines must match the
     statement's own totals to the cent, or nothing is shown.
   - lines: every fee, sorted into who gets the money: the bank that issued the card
     (interchange), the card networks (Visa, Mastercard...), or your processor. The sorting uses
     written rules on each line's description, not the statement's own labels, which mix them up.
   - ic: every interchange line compared with the published rate for that program.
   - findings: plain sentences about money worth asking about, biggest first.
   Everything here is a fixed rule over the statement's numbers. No AI. */

const FeeCheck = (() => {
  const R = typeof FeeRates !== "undefined" ? FeeRates : require("./rates.js");
  const sum = (a, f) => a.reduce((s, x) => s + (typeof f === "function" ? f(x) : x[f]), 0);
  const usd = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const usd0 = (c) => `$${Math.round(Math.abs(c) / 100).toLocaleString("en-US")}`;
  const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
  const num = (s) => Number(String(s).replace(/,/g, ""));

  // ---------------------------------------------------------------- who gets each fee
  // Checked top to bottom; the first match wins. Each rule says why, and the page shows it.
  const RULES = [
    ["network", /LICENSE VOLUME|ACQUIRER LICENSE/, "Mastercard's acquirer licence fee: a tiny percentage of your Mastercard sales. Same for every processor."],
    ["processor", /SALES DISC|DISC RATE/, "The processor's own percentage on your sales. This is their markup, and it's negotiable."],
    ["network", /ASSESS/, "A card network's assessment: a small percentage Visa, Mastercard, Discover or Amex charge on every sale. Same for every processor."],
    ["network", /NETWORK|NTWK/, "A card network's fee for using its network. Same for every processor."],
    ["processor", /AVS\s*950|CALL AUTHORI/, "The processor's charge for checking the card's address. Not a card-network fee."],
    ["processor", /PLATFORM|REGULATORY|BATCH|STATEMENT FEE|PCI|ANNUAL FEE|MINIMUM|MONTHLY SERVICE|GATEWAY|CHARGEBACK|RETRIEVAL|ACCOUNT FEE|SUPPORT|COMPLIANCE|SERVICE FEE$|MEMBERSHIP/,
      "A fee the processor sets itself, not a card network. Ask whether it can be lowered or dropped."],
    ["network", /INTEGRITY|NEVER APPROVE|ZERO ACCT|DECLINE REASON|BASE II|CONNECTIVITY|DIGITAL ENABLEMENT|DIGTL COM|DIGITAL INVESTMENT|DATA USAGE|LICENSE VOLUME|COMMERCIAL SOLUTIONS|CR VCHER|LOCATION FEE|ACQUIRER|AVS FEE|ADDRS VERIFICATION|FANF|KILOBYTE/,
      "A small card-network fee for authorisations, data or card checks. Same for every processor."],
    ["processor", /AUTH(ORI[SZ]ATION)? FEE/, "The processor's charge for each authorisation (each time a card is checked). Negotiable."],
  ];
  const WHO = { interchange: "Card-issuing bank (interchange)", network: "Card networks", processor: "Your processor", unknown: "Not sure" };

  function classify(line, icNames) {
    const d = line.description.toUpperCase();
    if (icNames.has(d)) return { cls: "interchange", why: /^AXP|AMEX/.test(d)
      ? "American Express's rate for this kind of sale, its version of interchange. Same for every processor."
      : "Interchange: the fee that goes to the bank that issued your customer's card. Set by the card network, same for every processor." };
    for (const [cls, re, why] of RULES) if (re.test(d)) return { cls, why };
    return { cls: "unknown", why: "No rule matches this description, so it isn't guessed." };
  }

  const brandOf = (d) => /^VISA|^VI\b|^VI[-\s]/.test(d) ? "VISA" : /^MASTERCARD|^MC\b|^MC[-\s]/.test(d) ? "MASTERCARD" : /DISCOVER|DSCVR/.test(d) ? "DISCOVER" : /AMEX|AXP/.test(d) ? "AMEX" : null;
  const cardBrand = (b) => (/AMEX|AMERICAN/.test(b) ? "AMEX" : b);

  // ---------------------------------------------------------------- arithmetic printed inside a fee line
  // "VISA SALES DISCOUNT 0.0065 DISC RATE TIMES $47108.34", "AUTH FEE 130 TRANSACTIONS AT 0.1",
  // "DIGITAL ENABLEMENT FEE $16741.31 AT0.00025": the line's own numbers must give its amount.
  function lineMath(d) {
    let m = d.match(/(\d*\.?\d+)\s*(?:DISC RATE\s*)?TIMES\s*\$\s*([\d,]+\.\d{2})/);
    if (m) return { rate: num(m[1]), base: num(m[2]), kind: "rate" };
    m = d.match(/\$\s*([\d,]+\.\d{2})\s*AT\s*(\d*\.?\d+)/);
    if (m) return { rate: num(m[2]), base: num(m[1]), kind: "rate" };
    m = d.match(/(\d[\d,]*)\s*(TRANSACTIONS|KILOBYTES|ITEMS)\s*AT\s*\$?\s*(\d*\.?\d+)/);
    if (m) return { rate: num(m[3]), base: num(m[1]), kind: "count", unit: m[2].toLowerCase() };
    return null;
  }
  const near = (a, b) => Math.abs(a - b) <= 1;      // within a cent: processors round or truncate

  function analyze(st) {
    const checks = [];
    const add = (label, ok, detail, critical = false) => checks.push({ label, ok, detail, critical });

    // ------------------------------------------------ does it add up?
    const sales = st.dayTotal.submitted;
    const feeTotal = st.feeByType.rows.Total?.Total ?? st.dayTotal.fees;
    const lineSum = sum(st.feeLines, "amount");
    const daySum = sum(st.days, "submitted");
    add("Daily sales add up to the statement's total", daySum === sales, `${st.days.length} days sum to ${usd(daySum)}; the statement says ${usd(sales)}.`, true);
    add("Every fee line adds up to the total fees", lineSum === feeTotal && feeTotal === st.dayTotal.fees,
      `${st.feeLines.length} fee lines sum to ${usd(lineSum)}; the fee summary says ${usd(feeTotal)} and the monthly charge was ${usd(st.dayTotal.fees)}.`, true);
    const processed = st.dayTotal.submitted + st.dayTotal.disputes + st.dayTotal.adjustments + st.dayTotal.fees;
    add("Sales minus fees equals the amount processed", processed === st.dayTotal.processed, `${usd(sales)} ${st.dayTotal.disputes || st.dayTotal.adjustments ? "with disputes and adjustments " : ""}minus ${usd(-st.dayTotal.fees)} is ${usd(processed)}; the statement says ${usd(st.dayTotal.processed)}.`);
    if (st.cardTypes.length) {
      const net = sum(st.cardTypes, "net");
      add("Sales by card brand add up to total sales", net === sales && (!st.cardTotal || st.cardTotal.net === net), `${st.cardTypes.map((c) => c.brand).join(", ")} sum to ${usd(net)}.`);
    }
    if (st.subtotals.length) {
      // a subtotal closes the run of lines since the previous one
      let start = 0, bad = [];
      const cats = st.feeLines.map((l) => l.category);
      for (const s of st.subtotals) {
        let end = cats.lastIndexOf(s.category);
        const got = sum(st.feeLines.slice(start, end + 1), "amount");
        if (got !== s.amount) bad.push(`${s.category}: lines ${usd(got)}, subtotal ${usd(s.amount)}`);
        start = end + 1;
      }
      add("Each fee section matches its subtotal", !bad.length, bad.length ? bad.join("; ") : `${st.subtotals.length} sections checked.`);
    }
    const types = Object.keys(st.feeByType.rows).filter((k) => k !== "Total");
    if (types.length) {
      const bad = types.filter((k) => sum(st.feeLines.filter((l) => l.type === k), "amount") !== st.feeByType.rows[k].Total);
      add("Fee lines match the fee summary by type", !bad.length, bad.length ? `Doesn't match for: ${bad.join(", ")}.` : `${types.join(", ")}: all match.`);
    }
    let icMathBad = [];
    if (st.ic.length) {
      for (const r of st.ic) {
        const exp = Math.round(r.sales * r.rate + r.count * r.perItem);
        if (!near(Math.abs(r.total), Math.abs(exp)) && r.sales > 0) icMathBad.push(r.description);
      }
      add("Each interchange line equals rate times sales plus the per-sale fee", !icMathBad.length,
        icMathBad.length ? `Doesn't work out for: ${icMathBad.join(", ")}.` : `${st.ic.length} lines checked.`);
      const brandBad = st.icBrandTotals.filter((b) => sum(st.ic.filter((r) => r.brand === b.brand), "total") !== b.total);
      const grand = st.icTotal ? sum(st.ic, "total") === st.icTotal.total : true;
      add("Interchange lines add up by card brand", !brandBad.length && grand, brandBad.length ? `Doesn't add up for ${brandBad.map((b) => b.brand).join(", ")}.` : "Every brand total and the grand total match.");
      const inLines = new Map(st.feeLines.map((l) => [l.description.toUpperCase(), l.amount]));
      const missing = st.ic.filter((r) => r.total !== 0 && inLines.get(r.description.toUpperCase()) !== r.total);
      add("Each interchange line is billed once, for the same amount", !missing.length, missing.length ? `Not found in the fee list: ${missing.map((r) => r.description).join(", ")}.` : `${st.ic.filter((r) => r.total).length} lines found in the fee list.`);
    }

    const critical = checks.filter((c) => c.critical && !c.ok);
    if (critical.length) return { ok: false, checks, reason: "The statement didn't add up when it was read, so no results are shown. " + critical.map((c) => c.detail).join(" ") };

    // ------------------------------------------------ who gets each dollar
    const icNames = new Set(st.ic.map((r) => r.description.toUpperCase()));
    const lines = st.feeLines.map((l) => {
      const d = l.description.toUpperCase();
      const math = lineMath(d);
      let mathOk = null, mathExpected = null;
      if (math) { mathExpected = Math.round(math.rate * math.base * 100); mathOk = near(Math.abs(l.amount), mathExpected); }
      const prodBrand = brandOf(String(l.product || "").toUpperCase());
      const icRow = st.ic.find((r) => r.description.toUpperCase() === d);
      const brand = icRow ? cardBrand(icRow.brand) : prodBrand || brandOf(d);
      return { ...l, ...classify(l, icNames), brand, math, mathOk, mathExpected };
    });
    const bucket = (k) => 0 - sum(lines.filter((l) => l.cls === k), "amount");
    const buckets = { interchange: bucket("interchange"), network: bucket("network"), processor: bucket("processor"), unknown: bucket("unknown") };
    const fees = -feeTotal;

    const mathBad = lines.filter((l) => l.mathOk === false);
    add("Every fee line that shows its own calculation adds up", !mathBad.length,
      mathBad.length ? mathBad.map((l) => `${l.description}: printed ${usd(-l.amount)}, its own numbers give ${usd(l.mathExpected)}`).join("; ")
        : `${lines.filter((l) => l.math).length} lines recalculated.`);

    // ------------------------------------------------ interchange against the published rates
    const ic = st.ic.map((r) => {
      const ref = R.lookup(r.brand, r.description);
      const out = { ...r, ref, verdict: "unchecked", note: "" };
      if (r.sales <= 0 && r.total === 0) { out.verdict = "refund"; out.note = "A refund: no interchange charged."; return out; }
      if (!ref) { out.note = "No published rate on file for this program."; return out; }
      const cost = (x) => Math.round(r.sales * x.pct / 100 + r.count * x.fix * 100);
      const idx = ref.rates.findIndex((x) => Math.abs(x.pct / 100 - r.rate) < 1e-7 && Math.abs(x.fix * 100 - r.perItem) < 0.5);
      if (idx >= 0) {
        out.verdict = "match"; out.matched = ref.rates[idx]; out.note = `Matches ${ref.name}, ${ref.rates[idx].col}.`;
        // what the same sales would cost in person, when the statement says keyed or online
        if (ref.alt && (!ref.alt.only || /keyed or online/.test(ref.rates[idx].col))) {
          const a = ref.alt.rates[idx % ref.alt.rates.length];
          if (a) { out.inPerson = cost(a); out.inPersonRate = a; out.inPersonName = ref.alt.name; }
        }
      } else {
        const costs = ref.rates.map(cost);
        const lo = Math.min(...costs), hi = Math.max(...costs), paid = -r.total;
        out.expectedLow = lo; out.expectedHigh = hi;
        if (paid > hi + 1) { out.verdict = "above"; out.over = paid - hi; out.note = `Published: ${ref.rates.map((x) => `${x.pct.toFixed(2)}% + $${x.fix.toFixed(2)}`).filter((v, i, a) => a.indexOf(v) === i).join(" or ")}. Charged ${usd(out.over)} more than that.`; }
        else if (paid < lo - 1) { out.verdict = "below"; out.note = `Charged less than the published ${ref.rates.map((x) => `${x.pct.toFixed(2)}% + $${x.fix.toFixed(2)}`).filter((v, i, a) => a.indexOf(v) === i).join(" or ")}; the rate may have changed since the source was published.`; }
        else { out.verdict = "differs"; out.note = "Rate differs from the published one, but the total is within the published range."; }
      }
      if (ref.band && r.count) {
        const avg = r.sales / r.count / 100;
        out.bandOk = avg >= ref.band[0] - 0.005 && avg <= ref.band[1] + 0.005;
        if (!out.bandOk) out.note += ` The average sale (${usd(Math.round(avg * 100))}) is outside this tier's range, which is worth asking about.`;
      }
      return out;
    });
    const rateSummary = { match: 0, above: 0, below: 0, differs: 0, unchecked: 0, refund: 0 };
    for (const r of ic) rateSummary[r.verdict]++;

    // ------------------------------------------------ network percentages and the sales they were charged on
    const grossBy = Object.fromEntries(st.cardTypes.map((c) => [cardBrand(c.brand), c.gross]));
    const netRates = [];
    for (const l of lines) {
      const d = l.description.toUpperCase();
      const nr = R.NETWORK_RATES.find(([re]) => re.test(d));
      if (!nr) continue;
      const base = d.match(/\$\s*([\d,]+\.\d{2})/);
      if (!base) continue;
      const b = Math.round(num(base[1]) * 100), exp = Math.round(b * nr[1]);
      netRates.push({ description: l.description, what: nr[2], base: b, expected: exp, charged: -l.amount, ok: near(-l.amount, exp) });
    }
    if (netRates.length) add("Card-network percentages match the published rates", netRates.every((n) => n.ok),
      netRates.filter((n) => !n.ok).map((n) => `${n.description}: charged ${usd(n.charged)}, published rate gives ${usd(n.expected)}`).join("; ") || `${netRates.length} lines checked.`);

    // the processor's percentage: rate per brand, and the sales it was charged on
    const disc = lines.filter((l) => l.cls === "processor" && /SALES DISC|DISC RATE/.test(l.description.toUpperCase()) && l.math);
    const markup = {};
    for (const l of disc) {
      const b = cardBrand(l.brand || "");
      (markup[b] ||= { rates: new Set(), base: 0, fee: 0 });
      markup[b].rates.add(l.math.rate); markup[b].base += Math.round(l.math.base * 100); markup[b].fee += -l.amount;
    }
    const baseBad = Object.entries(markup).filter(([b, m]) => grossBy[b] != null && m.base !== grossBy[b]);
    if (Object.keys(markup).length) add("The processor's percentage was charged on your actual sales", !baseBad.length,
      baseBad.length ? baseBad.map(([b, m]) => `${b}: charged on ${usd(m.base)}, but sales were ${usd(grossBy[b])}`).join("; ")
        : Object.entries(markup).map(([b, m]) => `${b}: ${usd(m.base)}`).join(", ") + ", matching sales by card brand (before refunds).");

    // authorisations: the processor's per-check fee, and how many checks there were
    const auths = lines.filter((l) => l.cls === "processor" && /AUTH(ORI[SZ]ATION)? FEE/.test(l.description.toUpperCase()) && l.math?.kind === "count" && !/AVS|CALL/.test(l.description.toUpperCase()));
    const authCount = sum(auths, (l) => l.math.base), authFee = -sum(auths, "amount");
    const authRates = [...new Set(auths.map((l) => l.math.rate))];
    const txns = st.cardTotal ? st.cardTotal.netItems : sum(st.cardTypes, "netItems");

    // ------------------------------------------------ by card brand
    // worked out from the lines, not the statement's brand columns, which file some brand fees
    // (like the Amex markup) under "Others"
    const byBrand = st.cardTypes.map((c) => {
      const b = cardBrand(c.brand), fee = -sum(lines.filter((l) => l.brand === b), "amount");
      return { brand: c.brand, key: b, sales: c.net, count: c.netItems, fees: fee, rate: c.net > 0 ? fee / c.net : null };
    });
    const unbranded = -sum(lines.filter((l) => !l.brand || !byBrand.some((x) => x.key === l.brand)), "amount");

    // ------------------------------------------------ findings, biggest first
    const findings = [];
    const keyed = ic.filter((r) => r.inPerson != null);
    if (keyed.length) {
      const saving = sum(keyed, (r) => -r.total - r.inPerson), vol = sum(keyed, "sales");
      if (saving > 100) findings.push({ amount: saving, kind: "habit", title: "Keyed-in and online sales cost more",
        text: `${usd0(vol)} of sales went through at card-not-present rates. If any of those customers were in front of you, tapping or inserting the card instead would have cost up to ${usd(saving)} less this month (about ${usd0(saving * 12)} a year). Online sales can't be tapped, so this only applies to payments typed in at the counter or taken over the phone.` });
    }
    for (const r of ic.filter((x) => x.ref?.downgrade)) {
      const normal = r.ref.normal ? r.ref.normal.rates.map((x) => Math.round(r.sales * x.pct / 100 + r.count * x.fix * 100)) : null;
      findings.push({ amount: normal ? -r.total - Math.min(...normal) : 0, kind: "downgrade", title: "A sale paid the most expensive rate",
        text: `${r.description}: ${usd(r.sales)} over ${r.count} sale${r.count > 1 ? "s" : ""} cost ${usd(-r.total)} (${pct(r.rate)} + $${(r.perItem / 100).toFixed(2)}). ${normal ? `At the normal rate for that kind of card it would have been ${usd(Math.min(...normal))} to ${usd(Math.max(...normal))}. ` : ""}"Non-qualified" usually means the sale was missing data (such as the address check) or was settled late. Ask your processor what caused it.` });
    }
    for (const r of ic.filter((x) => x.verdict === "above")) {
      findings.push({ amount: r.over, kind: "overcharge", title: "Charged above the published rate",
        text: `${r.description}: ${pct(r.rate)} + $${(r.perItem / 100).toFixed(2)} on ${usd(r.sales)}. ${r.note} Ask your processor to explain or refund the difference.` });
    }
    for (const l of mathBad) {
      findings.push({ amount: Math.max(0, -l.amount - l.mathExpected), kind: "overcharge", title: "A fee line doesn't add up",
        text: `${l.description}: the line's own numbers give ${usd(l.mathExpected)}, but ${usd(-l.amount)} was charged.` });
    }
    for (const n of netRates.filter((x) => !x.ok)) {
      findings.push({ amount: Math.max(0, n.charged - n.expected), kind: "overcharge", title: "A card-network fee is higher than published",
        text: `${n.description}: ${n.what} on ${usd(n.base)} should be ${usd(n.expected)}; ${usd(n.charged)} was charged.` });
    }
    const markupFee = sum(Object.values(markup), "fee");
    if (markupFee) {
      const parts = Object.entries(markup).map(([b, m]) => [b, [...m.rates].map((x) => pct(x)).join("/")]);
      const groups = {};
      for (const [b, r] of parts) (groups[r] ||= []).push(b === "AMEX" ? "Amex" : b[0] + b.slice(1).toLowerCase());
      findings.push({ amount: markupFee + authFee, kind: "markup", title: "What your processor charges on top",
        text: `Your processor adds ${Object.entries(groups).map(([r, b]) => `${r} on ${b.join(", ")}`).join(" and ")} sales${authRates.length ? `, plus $${authRates.map((r) => r.toFixed(2)).join("/")} each time a card is checked` : ""}. That came to ${usd(markupFee + authFee)} this month. This is the part to compare when you get a quote from another processor.` });
    }
    const fixed = lines.filter((l) => l.cls === "processor" && !disc.includes(l) && !auths.includes(l));
    if (fixed.length) findings.push({ amount: -sum(fixed, "amount"), kind: "fixed", title: "The processor's other fees",
      text: `${fixed.map((l) => `${l.description.replace(/\s+\d[\d,]*\s*TRANSACTIONS AT.*$/, "")} ${usd(-l.amount)}`).join(", ")}. These are set by the processor, not the card networks, so ask whether any can be dropped.` });
    if (authCount > txns && authRates.length) {
      const extra = authCount - txns;
      findings.push({ amount: Math.round(extra * authRates[0] * 100), kind: "habit", title: "More card checks than sales",
        text: `You were charged for ${authCount} authorisations but made ${txns} sales and refunds. The other ${extra} are declined cards, retries and card-on-file checks; at $${authRates[0].toFixed(2)} each that's about ${usd(Math.round(extra * authRates[0] * 100))}. A lot of declines and retries can also add card-network penalty fees.` });
    }
    const pci = lines.filter((l) => /PCI.*NON|NON.?COMPLIAN/.test(l.description.toUpperCase()));
    if (pci.length) findings.push({ amount: -sum(pci, "amount") * 1.0001, kind: "fixed", title: "A fee you can usually make go away",
      text: `${pci.map((l) => `${l.description} ${usd(-l.amount)}`).join(", ")}. Processors charge this when the yearly card-security questionnaire (PCI) hasn't been filed. Filing it, usually free through your processor's website, normally stops the fee: about ${usd0(-sum(pci, "amount") * 12)} a year.` });
    const unknown = lines.filter((l) => l.cls === "unknown");
    if (unknown.length) findings.push({ amount: -sum(unknown, "amount"), kind: "unknown", title: "Lines the checker couldn't place",
      text: `${unknown.map((l) => l.description).join(", ")}. They're counted in the total but not sorted into who gets the money.` });
    findings.sort((a, b) => b.amount - a.amount);

    return {
      ok: true, st, checks, lines, buckets, fees, sales, txns, byBrand, unbranded,
      effectiveRate: sales > 0 ? fees / sales : null,
      ic, rateSummary, netRates, markup, authCount, authFee, authRates, findings, WHO,
      allChecksOk: checks.every((c) => c.ok),
    };
  }

  // ---------------------------------------------------------------- "what if" a different markup
  function whatIf(a, { pct: p, perTxn }) {
    const vol = sum(Object.values(a.markup), "base");
    const count = a.authCount || a.txns;
    const now = sum(Object.values(a.markup), "fee") + a.authFee;
    const then = Math.round(vol * p / 100 + count * perTxn * 100);
    return { vol, count, now, then, saving: now - then };
  }

  return { analyze, whatIf, classify, lineMath, RULES, WHO, usd, pct };
})();

if (typeof module !== "undefined") module.exports = FeeCheck;
