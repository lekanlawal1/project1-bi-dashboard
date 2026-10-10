/* Card Fee Checker: the general reader, for statements whose layout isn't known.

   It doesn't know where anything is, so it relies on the statement checking itself. Every
   statement prints totals. The reader:
   1. finds sections: a run of rows that ends in a "Total" line, where the rows above add up
      exactly to that total in one of its columns;
   2. finds the printed fee total ("Total Fees", "Total Amount Deducted", "Month End Charge"...);
   3. picks the sections whose totals add up exactly to that fee total. Exactly one combination
      must work, or nothing is shown;
   4. hands the rows of those sections to check.js as fee lines.
   A wrong reading would have to land on the printed total to the cent by accident, which is why
   this can be trusted when it succeeds, and why it refuses rather than guesses when it can't. */

const FeeGeneric = (() => {
  const S = typeof FeeStatement !== "undefined" ? FeeStatement : require("./statement.js");
  const cents = S.cents;
  const text = (l) => l.cells.map((c) => c.s).join(" ");
  const MONEY_IN = (s) => cents(String(s).replace(/\s?(CAD|USD)$/i, "").replace(/^\((.*)\)$/, "-$1"));
  const isNumeric = (s) => MONEY_IN(s) != null || /^-?[\d,]*\.?\d+\s?%$/.test(s) || /^[\d,]+$/.test(s) || /^\$-?[\d,]*\.\d{3,4}$/.test(s) || /^\$$/.test(s);
  const DATE = /^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?$|^\d{4}-\d{2}-\d{2}$|^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/;
  const NOISE = /^Page\b|^PERIOD:|Page \d+ of \d+/i;
  const TOTAL = /(\b|sub)totals?\b|month end charge/i;          // "Total", "Totals", "Subtotal"
  // labels that name the month's total fees, strongest first
  const FEE_TOTAL = [/total amount deducted/i, /total (merchant |processing )?fees( and charges)?( charged| due| deducted)?\b/i, /month end charge/i,
    /fees? (charged|deducted|due)\b/i, /total charges/i, /total deductions/i, /net (rates? & )?fees/i];
  const FEEISH = /FEE|CHARGE|DISC|ASSESS|INTERCHANGE|AUTH|RATE|DUES|MARKUP|SERVICE/i;

  // one row: its words, its money in reading order, and any rate. A row of numbers with no name
  // takes the text-only lines just above and below it (long names wrap around their numbers).
  // a rate written as a decimal ("0.0165") beats a percentage, which is often a share of sales
  const rateOf = (cells) => {
    const d = cells.find((c) => /^0?\.\d{3,5}$/.test(c));
    if (d) return Number(d);
    const p = cells.find((c) => /^-?[\d.]+\s?%$/.test(c));
    return p ? parseFloat(p) / 100 : null;
  };
  function rowsOf(lines) {
    const rows = [];
    const textOnly = (l) => l && l.cells.length && l.cells.every((c) => !isNumeric(c.s));
    lines.forEach((l, i) => {
      if (!l.cells.length || l.cells.some((c) => NOISE.test(c.s))) return;
      const cells = l.cells.map((c) => c.s);
      const money = cells.map(MONEY_IN).filter((v) => v != null);
      const firstNum = cells.findIndex((c) => isNumeric(c));
      const words = (firstNum < 0 ? l.cells : l.cells.slice(0, firstNum));
      let label = words.map((c) => c.s).join(" ").trim();
      if (!label && DATE.test(cells[0])) label = cells[0];
      let wrapped = false;
      if (!label && money.length) {
        const near = (x) => x && x.page === l.page && Math.abs(x.y - l.y) <= 8 && textOnly(x) && x.cells.length === 1;
        const parts = [near(lines[i - 1]) ? lines[i - 1].cells[0].s : "", near(lines[i + 1]) ? lines[i + 1].cells[0].s : ""].filter(Boolean);
        if (parts.length) { label = parts.join(" "); wrapped = true; }
      }
      const ints = cells.filter((c) => /^[\d,]+$/.test(c)).map((c) => Number(c.replace(/,/g, "")));
      rows.push({ i, page: l.page, y: l.y, label, words, wrapped, money, cells, pct: rateOf(cells), count: ints.length ? ints[0] : null });
    });
    return rows;
  }

  // inside one section, the description is the text column with the most to say; the others
  // (a category shown once, a type repeated on every line) are left out
  function describe(rows) {
    const cols = new Map();
    for (const r of rows) for (const w of r.words) {
      const k = Math.round(w.x / 12);
      const c = cols.get(k) || { n: 0, len: 0 };
      c.n++; c.len += w.s.length; cols.set(k, c);
    }
    let best = null, score = -1;
    for (const [k, c] of cols) if (c.n * (c.len / c.n) > score) { score = c.n * (c.len / c.n); best = k; }
    return (r) => {
      if (r.wrapped || best == null) return r.label;
      const w = r.words.find((x) => Math.round(x.x / 12) === best);
      return w ? w.s : r.label;
    };
  }

  // sections: rows since the last total line that add up to this total line, in some column
  function sections(rows) {
    const out = [];
    let run = [];
    for (const r of rows) {
      if (!r.money.length) continue;
      if (!TOTAL.test(r.label)) { if (r.label) run.push(r); continue; }
      for (let k = 0; k < Math.min(3, r.money.length); k++) {
        let best = null;
        const target = r.money[r.money.length - 1 - k];
        if (!target) continue;
        // walk up from the total line, keeping the longest run that adds up exactly (rows may differ
        // in how many amounts they show: the fee is the k-th from the right on every one)
        let acc = 0;
        for (let j = run.length - 1; j >= 0; j--) {
          const row = run[j];
          if (row.money.length < k + 1) break;
          acc += row.money[row.money.length - 1 - k];
          if (acc === target && (!best || run.length - j > best.rows.length)) best = { rows: run.slice(j), total: target, col: k, totalRow: r };
        }
        if (best) out.push(best);
      }
      run = [];
    }
    return out;
  }

  // which sections add up to the fee total? exactly one combination must
  function choose(blocks, target) {
    const cand = blocks.map((b, i) => ({ b, i, v: Math.abs(b.total) })).filter((x) => x.v > 0 && x.v <= target);
    if (cand.length > 22) return { many: true };
    const found = [];
    const walk = (k, sum, picked) => {
      if (sum === target && picked.length) { found.push([...picked]); return; }
      if (k === cand.length || sum > target || found.length > 50) return;
      picked.push(cand[k]); walk(k + 1, sum + cand[k].v, picked); picked.pop();
      walk(k + 1, sum, picked);
    };
    walk(0, 0, []);
    // a section of sections (a grand total over subtotals) can double up: drop overlapping picks
    const ok = found.filter((set) => {
      const seen = new Set();
      return set.every((x) => x.b.rows.every((r) => !seen.has(r.i) && seen.add(r.i)));
    });
    if (ok.length <= 1) return { set: ok[0] || null };
    // more than one: prefer the reading whose rows look most like fees; refuse a tie
    const score = (set) => set.reduce((n, x) => n + x.b.rows.filter((r) => FEEISH.test(r.label)).length / x.b.rows.length, 0);
    const ranked = ok.map((set) => ({ set, s: score(set) })).sort((a, b) => b.s - a.s);
    if (ranked[0].s === ranked[1].s) return { ambiguous: ranked.length };
    return { set: ranked[0].set };
  }

  function read(lines) {
    const rows = rowsOf(lines);
    const all = lines.map(text).join("\n");
    const blocks = sections(rows);
    // the fee total: the first strong label that a combination of sections reaches exactly
    const totals = [];
    for (const re of FEE_TOTAL) for (const r of rows) if (re.test(r.label) && r.money.length) {
      for (const v of new Set(r.money.map(Math.abs))) if (v && !totals.some((t) => t.v === v)) totals.push({ v, row: r });
    }
    let picked = null, feeTotal = null, why = "";
    for (const t of totals) {
      const c = choose(blocks, t.v);
      if (c.set) { picked = c.set; feeTotal = t; break; }
      if (c.ambiguous) why = "More than one reading of this statement's sections adds up to its fee total, so none is shown rather than a guess.";
      if (c.many) why = "The statement has too many sections to work out which ones are fees.";
    }
    if (!picked) {
      return { ok: false, reason: why || (totals.length ? "No set of sections on this statement adds up to its printed fee total, so it can't be read line by line." : "No line on this statement is labelled as the total fees, so it can't be read line by line."), blocks: blocks.length };
    }

    // the fee lines, signed so that fees are negative (statements print them either way)
    const sign = Math.sign(picked.reduce((s, x) => s + x.b.total, 0)) || 1;
    const feeLines = [];
    const used = new Set(picked.flatMap((x) => x.b.rows.map((r) => r.i)));
    for (const x of picked) {
      const name = describe(x.b.rows);
      for (const r of x.b.rows) {
        const v = r.money[r.money.length - 1 - x.b.col];
        const others = r.money.filter((m, j) => j !== r.money.length - 1 - x.b.col && Math.abs(m) > Math.abs(v));
        const per = r.cells.find((cl) => /^\$\d*\.\d{2,4}$/.test(cl) && Number(cl.slice(1)) < 1 && Number(cl.slice(1)) > 0);
        const perItem = per ? Number(per.slice(1)) : null;
        let calc = null;
        if (r.pct != null && others.length) calc = { rate: r.pct, base: Math.abs(others[others.length - 1]) / 100, kind: "rate", ...(perItem && r.count ? { count: r.count, perItem } : {}) };
        else if (perItem && r.count) calc = { rate: perItem, base: r.count, kind: "count", unit: "items" };
        const type = r.words.length > 1 ? r.words[r.words.length - 1].s : x.b.totalRow.label;
        if (!v) continue;                              // a card type or fee with nothing charged
        feeLines.push({ category: x.b.totalRow.label, product: null, description: name(r).toUpperCase(), type, amount: -sign * v, calc, page: r.page, row: r });
      }
    }
    // the same program named elsewhere with its rate, sales and count (an interchange table)
    const elsewhere = new Map();
    for (const r of rows) if (!used.has(r.i) && r.pct != null && r.money.length >= 2 && r.label) elsewhere.set(r.label.toUpperCase(), r);
    // anything that names an interchange program and shows its rate and sales becomes an interchange line
    const canada = /\bCAD\b|GST\/HST|\bCANADA\b|\bQU[EÉ]BEC\b|\bONTARIO\b|\bINTERAC\b/i.test(all);
    const FR = typeof FeeRates !== "undefined" ? FeeRates : require("./rates.js");
    const ic = [];
    for (const l of feeLines) {
      const d = l.description;
      const brand = /^VI|^VS|^VISA/.test(d) ? "VISA" : /^MC|^MASTERCARD/.test(d) ? "MASTERCARD" : /^AXP|^AMEX/.test(d) ? "AMEX ACQ" : /^DSCVR|^DISCOVER/.test(d) ? "DISCOVER" : null;
      if (!brand || /\bFEES?\b|ASSESS|NETWORK|NTWK|\bDISC(OUNT)?\b/.test(d)) continue;   // named fees aren't interchange programs
      const country = canada ? "CA" : "US";
      // a named program: one the rate tables know, or a card-brand line with a rate and program words
      const PROGRAM = /ELECTRONIC|STANDARD|\bCNP\b|MERIT|\bCPS\b|ECOMM|PREMIUM|WORLD|\bCORE\b|ELITE|SIGNATURE|INFINITE|REWARDS|PRODUCT|\bTIER\b|DATA RATE|SMALL MERCHANT|NON.?QUAL|REGULATED|HEALTHCARE|\bRETAIL\b/;
      if (!FR.lookup(brand, d, { country }) && !/INTERCHANGE|PSL|DSCVR|^AXP .*T[123]$/.test(d) && !((l.calc || elsewhere.has(d)) && PROGRAM.test(d) && !/ASSESS/.test(d))) continue;
      l.isIC = true;                                   // a named interchange program, whether or not its rate is shown
      const t = elsewhere.get(d);
      if (t && t.money.length >= 3) {
        ic.push({ brand, description: d, sales: t.money[0], count: t.count || 0, rate: t.pct, perItem: t.money[t.money.length - 2], total: l.amount, country });
      } else if (l.calc && l.calc.kind === "rate") {
        ic.push({ brand, description: d, sales: Math.round(l.calc.base * 100), count: l.calc.count || l.row.count || 0, rate: l.calc.rate, perItem: Math.round((l.calc.perItem || 0) * 100), total: l.amount, country });
      }
    }
    for (const l of feeLines) delete l.row;
    const totals2 = S.findTotals(lines);
    // no labelled sales total: a section of card brands whose columns add up to its total line.
    // Of the columns that do, net sales is the one equal to another minus a third (sales minus
    // refunds); otherwise the biggest.
    if (!totals2.sales) {
      const BRANDS = /^(VISA|MASTERCARD|MASTER CARD|AMEX|AMERICAN EXPRESS|DISCOVER|INTERAC|DEBIT)\b/i;
      let best = null;
      for (const b of blocks.filter((x) => x.rows.length >= 2 && x.rows.every((r) => BRANDS.test(r.label)))) {
        const t = b.totalRow.money, sums = [];
        for (const fromLeft of [true, false]) for (let j = 0; j < t.length; j++) {
          const get = (m) => fromLeft ? m[j] : m[m.length - 1 - j];
          const target = fromLeft ? t[j] : t[t.length - 1 - j];
          if (b.rows.every((r) => get(r.money) != null) && b.rows.reduce((n, r) => n + get(r.money), 0) === target && !sums.includes(target)) sums.push(target);
        }
        const pos = sums.filter((v) => v > 0);
        // sales minus refunds equals net, but sales minus net also equals refunds: take the larger
        const net = pos.filter((v) => sums.some((a) => a !== v && sums.some((c) => c !== v && c !== a && a - Math.abs(c) === v))).sort((x, y) => y - x)[0];
        const v = net ?? Math.max(...pos, 0);
        if (v > 0 && (!best || v > best.v)) best = { v, b };
      }
      if (best) totals2.sales = { cents: best.v, line: text(lines[best.b.totalRow.i]), page: best.b.totalRow.page };
    }
    const per = all.match(/(?:STATEMENT\s+)?PERIOD:?\s*([A-Z][a-z]+|[A-Z]+)\s+(\d{4})/i);
    const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
    let period = null;
    if (per && MONTHS.includes(per[1].toUpperCase())) {
      const m = MONTHS.indexOf(per[1].toUpperCase()) + 1;
      period = { from: `${per[2]}-${String(m).padStart(2, "0")}-01`, to: new Date(Date.UTC(+per[2], m, 0)).toISOString().slice(0, 10) };
    } else {
      const d = all.match(/PERIOD:?\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/i);
      if (d) period = { from: `${d[3]}-${d[1]}-${d[2]}`, to: `${d[6]}-${d[4]}-${d[5]}` };
    }
    const site = all.match(/www\.([a-z0-9-]+\.[a-z.]+)/i);
    return {
      ok: true, layout: "General reader", layoutKey: "generic", currency: canada ? "CAD" : "USD",
      period, processor: site ? site[1].toLowerCase() : null,
      feeLines, ic, cardTypes: [], days: [],
      sales: totals2.sales ? totals2.sales.cents : null, salesFrom: totals2.sales,
      feeTotal: -feeTotal.v, feeTotalFrom: { line: text(lines[feeTotal.row.i]), page: feeTotal.row.page },
      sectionsUsed: picked.map((x) => ({ label: x.b.totalRow.label, rows: x.b.rows.length, total: Math.abs(x.b.total), page: x.b.totalRow.page })),
      sectionsFound: blocks.length, txns: null, warnings: [],
    };
  }

  // a known layout first; then the general reader; then, failing both, the labelled totals
  function parseAny(lines) {
    const st = S.parse(lines);
    if (st.ok) return st;
    const g = read(lines);
    if (g.ok) return g;
    // a scan has no text at all: say that; otherwise the general reader's reason is the useful one
    const reason = /no text to read/.test(st.reason) ? st.reason : `This statement couldn't be checked line by line. ${g.reason}`;
    return { ok: false, reason, totals: st.totals || S.findTotals(lines) };
  }

  return { read, parseAny, rowsOf, sections, choose };
})();

if (typeof module !== "undefined") module.exports = FeeGeneric;
