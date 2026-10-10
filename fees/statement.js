/* Card Fee Checker, step 1: turn the text of a processor statement into numbers.

   The PDF is read in the browser by pdf.js, which gives every piece of text with its position on
   the page. linesFromItems() puts those pieces back into rows and cells; parse() then reads the
   statement's tables. Money is kept in whole cents so totals add up exactly.

   Two layouts are read in full so far:
   - CardPointe, which Fiserv prints for many US resellers ("YOUR CARD PROCESSING STATEMENT",
     "Summary By Day", "Fee Summary");
   - TSYS in Canada ("MERCHANT PROCESSING STATEMENT", "DEPOSIT SUMMARY", "CARD TYPE SUMMARY").
   Every parser returns the same shape (sales, fee lines, interchange lines, card types, days) plus
   its own add-up checks, so check.js works on either. Any other statement is not guessed at:
   findTotals() only looks for its labelled total-sales and total-fees lines, to fill in the quick
   check for the person to confirm. No DOM here, so the tests run it in Node. */

const FeeStatement = (() => {
  const BRANDS = ["VISA", "MASTERCARD", "DISCOVER", "AMEX ACQ", "AMEX", "AMERICAN EXPRESS", "DEBIT", "OTHERS", "JCB", "DINERS"];

  // ---------------------------------------------------------------- text pieces -> rows of cells
  // items: [{ page, s, x, y, w }] in PDF points (y grows upwards). Pieces on the same baseline form
  // a row; pieces closer than `gap` points on a row are one cell (some PDFs split words).
  function linesFromItems(items, { tol = 2.5, gap = 3 } = {}) {
    const byPage = new Map();
    for (const it of items) {
      if (!it.s || !it.s.trim()) continue;
      if (!byPage.has(it.page)) byPage.set(it.page, []);
      byPage.get(it.page).push(it);
    }
    const lines = [];
    for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
      const rows = [];
      for (const it of byPage.get(page).sort((a, b) => b.y - a.y || a.x - b.x)) {
        const row = rows.find((r) => Math.abs(r.y - it.y) <= tol);
        if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        const cells = [];
        for (const it of r.items.sort((a, b) => a.x - b.x)) {
          const last = cells[cells.length - 1];
          if (last && it.x - last.x2 < gap) {
            last.s += (it.x - last.x2 > 0.8 && !last.s.endsWith(" ") && !it.s.startsWith(" ") ? " " : "") + it.s;
            last.x2 = Math.max(last.x2, it.x + (it.w || 0));
          } else cells.push({ s: it.s, x: it.x, x2: it.x + (it.w || 0) });
        }
        for (const c of cells) c.s = c.s.replace(/\s+/g, " ").trim();
        lines.push({ page, y: r.y, cells: cells.filter((c) => c.s) });
      }
    }
    return lines;
  }

  // ---------------------------------------------------------------- values
  const MONEY = /^-?\$-?[\d,]*\.\d{2}$/;          // "$1,234.56", "-$1.00", "$-62.63", TSYS's "$.00"
  const cents = (s) => {
    if (s == null) return null;
    const t = String(s).replace(/\s/g, "");
    if (!MONEY.test(t)) return null;
    const neg = t.includes("-");
    const [whole, frac] = t.replace(/[-$,]/g, "").split(".");
    return (neg ? -1 : 1) * (Number(whole || 0) * 100 + Number(frac));
  };
  const int = (s) => (/^\d[\d,]*$/.test(String(s ?? "").trim()) ? Number(String(s).replace(/,/g, "")) : null);
  const dec = (s) => (/^-?\d*\.\d+$|^-?\d+$/.test(String(s ?? "").trim()) ? Number(s) : null);
  const isPct = (s) => /^-?[\d.]+%$/.test(String(s ?? "").trim());
  const text = (line) => line.cells.map((c) => c.s).join(" ");

  // ---------------------------------------------------------------- which statement is this?
  function detect(lines) {
    const all = lines.map(text).join("\n");
    if (/YOUR CARD PROCESSING STATEMENT/i.test(all) && /Summary By Day/i.test(all) && /Fee Summary/i.test(all)) return "cardpointe";
    if (/MERCHANT PROCESSING STATEMENT/i.test(all) && /DEPOSIT SUMMARY/.test(all) && /CARD TYPE SUMMARY/.test(all) && /Total Amount Deducted/i.test(all)) return "tsys";
    return null;
  }
  function whyNot(lines) {
    const all = lines.map(text).join("\n");
    if (!all.trim()) return "This PDF has no text to read. It's probably a scan or a photo; download the statement as a PDF from your processor's website instead.";
    const known = [[/square/i, "Square"], [/clover/i, "Clover"], [/stripe/i, "Stripe"], [/helcim/i, "Helcim"], [/moneris/i, "Moneris"], [/paypal/i, "PayPal"], [/shopify/i, "Shopify"]];
    const hit = known.find(([re]) => re.test(all));
    return `This statement's layout isn't fully supported yet${hit ? ` (it looks like ${hit[1]})` : ""}. Line-by-line checks work for CardPointe (Fiserv) and TSYS (Canada) statements so far.`;
  }

  // ---------------------------------------------------------------- the CardPointe layout
  const isNoise = (line) => /^PERIOD:/.test(line.cells[0]?.s || "") || line.cells.some((c) => /^Page \d+ of \d+$/.test(c.s));

  function parse(lines) {
    const kind = detect(lines);
    if (kind === "tsys") return parseTsys(lines);
    if (kind !== "cardpointe") return { ok: false, reason: whyNot(lines), totals: findTotals(lines) };
    return parseCardPointe(lines);
  }

  function parseCardPointe(lines) {
    const all = lines.map(text).join("\n");
    const out = {
      ok: true, layout: "CardPointe (Fiserv)", layoutKey: "cardpointe", currency: "USD",
      period: null, processor: null,
      days: [], monthEnd: null, dayTotal: null,
      cardTypes: [], cardTotal: null,
      feeByType: { columns: [], rows: {} },
      feeLines: [], subtotals: [],
      ic: [], icBrandTotals: [], icTotal: null,
      warnings: [],
    };
    const per = all.match(/PERIOD:\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
    if (per) out.period = { from: `${per[3]}-${per[1]}-${per[2]}`, to: `${per[6]}-${per[4]}-${per[5]}` };
    const site = all.match(/www\.([a-z0-9-]+\.[a-z.]+)/i);
    if (site) out.processor = site[1].toLowerCase();

    let section = null, cols = null, category = null, product = null, icBrand = null;
    for (const line of lines) {
      if (isNoise(line)) continue;
      const c = line.cells.map((x) => x.s), first = c[0] || "", t = c.join(" ");

      // section headings
      if (/^Summary By Day$/i.test(first)) { section = "days"; continue; }
      if (/^Summary by Card Type$/i.test(first)) { section = "cards"; continue; }
      if (/^Fee Summary$/i.test(first)) { section = "feesum"; continue; }
      // the heading repeats at the top of each page; the card brand carries over
      if (/^Interchange Charges \/ Program Fees$/i.test(first)) { if (section !== "ic") icBrand = null; section = "ic"; continue; }
      if (/^Amounts Funded$/i.test(first)) { section = "funded"; continue; }
      if (/^Total Gross Reportable Sales/i.test(first)) { section = null; continue; }
      if (first === "Category" && c.includes("Description") && c.includes("Amount")) {
        section = "lines";
        cols = line.cells.map((x) => ({ name: x.s, x: x.x }));
        continue;
      }
      if (/^Fees$/.test(first) && c.length === 2 && /^Amount charged/i.test(c[1])) { section = section === "lines" ? "lines" : "feehead"; continue; }

      if (section === "days") {
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(first) && c.length >= 6) {
          const v = c.slice(1, 6).map(cents);
          if (v.every((x) => x != null)) out.days.push({ date: first.replace(/(\d{2})\/(\d{2})\/(\d{4})/, "$3-$1-$2"), submitted: v[0], disputes: v[1], adjustments: v[2], fees: v[3], processed: v[4] });
        } else if (/^Month End Charge$/i.test(first)) {
          const v = c.slice(1, 6).map(cents);
          out.monthEnd = { submitted: v[0], disputes: v[1], adjustments: v[2], fees: v[3], processed: v[4] };
        } else if (first === "Total" && c.length >= 6) {
          const v = c.slice(1, 6).map(cents);
          out.dayTotal = { submitted: v[0], disputes: v[1], adjustments: v[2], fees: v[3], processed: v[4] };
        }
      } else if (section === "cards") {
        if (BRANDS.includes(first) && c.length >= 8) {
          out.cardTypes.push({ brand: first, avgTicket: cents(c[1]), grossItems: int(c[2]), gross: cents(c[3]), refundItems: int(c[4]), refunds: cents(c[5]), netItems: int(c[6]), net: cents(c[7]) });
        } else if (first === "Total" && c.length >= 7) {
          out.cardTotal = { grossItems: int(c[1]), gross: cents(c[2]), refundItems: int(c[3]), refunds: cents(c[4]), netItems: int(c[5]), net: cents(c[6]) };
        }
      } else if (section === "feesum") {
        if (first === "Type" && c.includes("Total")) out.feeByType.columns = c.slice(1);
        else if (out.feeByType.columns.length && c.length === out.feeByType.columns.length + 1 && c.slice(1).every((x) => cents(x) != null)) {
          out.feeByType.rows[first] = Object.fromEntries(out.feeByType.columns.map((k, i) => [k, cents(c[i + 1])]));
        }
      } else if (section === "lines" && cols) {
        // each cell belongs to the column whose heading starts at or before it
        const row = {};
        for (const cell of line.cells) {
          let k = 0;
          for (let i = 0; i < cols.length; i++) if (cols[i].x <= cell.x + 2) k = i;
          // amounts are right-aligned under their heading: anything that looks like money is the amount
          const name = MONEY.test(cell.s.replace(/\s/g, "")) ? "Amount" : cols[k].name;
          row[name] = row[name] ? `${row[name]} ${cell.s}` : cell.s;
        }
        if (row.Category === "Total" || (first === "Total" && Object.keys(row).length <= 2)) {
          out.subtotals.push({ category, amount: cents(row.Amount) });
          continue;
        }
        if (row.Category && row.Category !== "Total") { category = row.Category; product = null; }
        if (row.Product) product = row.Product;
        if (row.Description && row.Amount != null && cents(row.Amount) != null) {
          out.feeLines.push({ category, product, description: row.Description, type: row.Type || "", amount: cents(row.Amount) });
        } else if (row.Description || row.Amount) {
          out.warnings.push(`A fee line could not be read: "${t}"`);
        }
      } else if (section === "ic") {
        if (BRANDS.includes(first) && c.length === 1) { icBrand = first; continue; }
        const brandTotal = first.match(/^(.+) Total$/);
        if (brandTotal && BRANDS.includes(brandTotal[1]) && c.length >= 4) {
          out.icBrandTotals.push({ brand: brandTotal[1], sales: cents(c[1]), count: int(c[2]), total: cents(c[3]) });
          continue;
        }
        if (first === "Total" && c.length >= 4) { out.icTotal = { sales: cents(c[1]), count: int(c[2]), total: cents(c[3]) }; continue; }
        if (icBrand && c.length >= 8 && cents(c[1]) != null && isPct(c[2]) && int(c[3]) != null && dec(c[5]) != null) {
          out.ic.push({ brand: icBrand, description: first, sales: cents(c[1]), count: int(c[3]), rate: dec(c[5]), perItem: cents(c[6]), total: cents(c[7]) });
        }
      }
    }
    if (!out.days.length || !out.feeLines.length || !out.dayTotal) {
      return { ok: false, reason: "This looks like a CardPointe statement, but its tables couldn't be read (no daily totals or no fee lines). Nothing is shown rather than a partial reading.", totals: findTotals(lines) };
    }
    // the shape every layout shares
    out.sales = out.dayTotal.submitted;
    out.feeTotal = out.feeByType.rows.Total?.Total ?? out.dayTotal.fees;
    out.txns = out.cardTotal ? out.cardTotal.netItems : out.cardTypes.reduce((n, c) => n + c.netItems, 0);
    return out;
  }

  // ---------------------------------------------------------------- the TSYS (Canada) layout
  // Sections: DEPOSIT SUMMARY (one row per batch), CARD TYPE SUMMARY (sales, refunds and the
  // processor's discount per card type), RATES & FEES (interchange and other percentage fees),
  // OTHER CHARGES (flat and per-item fees), FEE SUMMARY (the totals) and EMDR CALCULATIONS (the
  // processor's own effective rate per card brand). Long names wrap onto a line above and below
  // their numbers; those pieces are joined back on.
  const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
  const TSYS_BRAND = (name) => /^VISA/i.test(name) ? "VISA" : /^MASTER/i.test(name) ? "MASTERCARD" : /^AMERICAN|^AMEX/i.test(name) ? "AMEX"
    : /^INTERAC/i.test(name) ? "INTERAC" : /^DISCOVER/i.test(name) ? "DISCOVER" : null;
  const perItem = (s) => (/^\$-?[\d,]*\.\d{2,4}$/.test(String(s ?? "").trim()) ? Number(String(s).replace(/[$,]/g, "")) : null);
  const isNum = (s) => cents(s) != null || int(s) != null || perItem(s) != null || /^-?[\d.]+\s?%$/.test(s);

  function parseTsys(lines) {
    const all = lines.map(text).join("\n");
    const out = {
      ok: true, layout: "TSYS (Canada)", layoutKey: "tsys", currency: "CAD", period: null, processor: null,
      days: [], batches: [], depositTotal: null, cardRows: [], cardTotal: null, rateLines: [], otherLines: [],
      summary: {}, emdr: [], feeLines: [], ic: [], cardTypes: [], warnings: [],
    };
    const per = all.match(/STATEMENT PERIOD:\s*([A-Z]+)\s+(\d{4})/i);
    let ym = null;
    if (per && MONTHS.includes(per[1].toUpperCase())) {
      const m = MONTHS.indexOf(per[1].toUpperCase()) + 1, y = +per[2];
      ym = `${y}-${String(m).padStart(2, "0")}`;
      out.period = { from: `${ym}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
    }
    const site = all.match(/www\.([a-z0-9-]+\.[a-z.]+)/i);
    if (site) out.processor = site[1].toLowerCase();

    // rows of one section, with wrapped names joined: text-only lines just above and below a
    // numbers line (within 8 points, on the same page) belong to it
    const sectionRows = (start, stop) => {
      const i0 = lines.findIndex((l) => text(l) === start);
      if (i0 < 0) return [];
      let i1 = lines.findIndex((l, i) => i > i0 && stop.some((s) => text(l).startsWith(s)));
      if (i1 < 0) i1 = lines.length;
      const sec = lines.slice(i0 + 1, i1).filter((l) => !/^Page\b|^Questions regarding/.test(l.cells[0]?.s || "") && !/^Contact Client Care/.test(l.cells[0]?.s || ""));
      const used = new Set(), rows = [];
      sec.forEach((l, i) => {
        if (!l.cells.slice(1).some((c) => isNum(c.s)) && !(l.cells.length === 1 && isNum(l.cells[0].s))) return;
        const first = l.cells[0], hasName = first && !isNum(first.s);
        let name = hasName ? first.s : "";
        if (!hasName || (sec[i - 1] && !used.has(i - 1) && sec[i - 1].page === l.page && sec[i - 1].y - l.y <= 8 && sec[i - 1].cells.every((c) => !isNum(c.s)) && sec[i - 1].cells.length === 1 && sec[i - 1].cells[0].x < 100)) {
          const above = sec[i - 1], below = sec[i + 1];
          const wrap = (x) => x && x.page === l.page && Math.abs(x.y - l.y) <= 8 && x.cells.length === 1 && !isNum(x.cells[0].s) && x.cells[0].x < 100;
          if (wrap(above)) { name = `${above.cells[0].s} ${name}`.trim(); used.add(i - 1); }
          if (wrap(below)) { name = `${name} ${below.cells[0].s}`.trim(); used.add(i + 1); }
        }
        rows.push({ name, cells: (hasName ? l.cells.slice(1) : l.cells).map((c) => c.s), raw: l.cells.map((c) => c.s) });
      });
      return rows;
    };

    // deposits: one row per batch
    for (const r of sectionRows("DEPOSIT SUMMARY", ["* Transaction Codes", "CARD TYPE SUMMARY"])) {
      const c = /^\d{2}$/.test(r.raw[0]) ? r.raw.slice(1) : r.cells;       // the day is a number, not a name
      if (/^Deposit Totals$/i.test(r.name)) { const v = c.slice(1).map(cents); out.depositTotal = { count: int(c[0]), sales: v[0], credits: v[1], discountPaid: v[2], net: v[3] }; continue; }
      const day = /^\d{2}$/.test(r.raw[0]) ? r.raw[0] : null;
      if (day && c.length >= 8) {
        const v = c.slice(4, 8).map(cents);
        if (v.every((x) => x != null)) out.batches.push({ date: ym ? `${ym}-${day}` : day, ref: c[0], code: c[1], count: int(c[3]), sales: v[0], credits: v[1], discountPaid: v[2], net: v[3] });
      }
    }
    // card types
    for (const r of sectionRows("CARD TYPE SUMMARY", ["RATES & FEES"])) {
      const c = r.cells;
      if (r.name === "Total" && c.length >= 8) {
        out.cardTotal = { grossItems: int(c[0]), gross: cents(c[1]), refundItems: int(c[2]), refunds: cents(c[3]), netItems: int(c[4]), net: cents(c[5]), discount: cents(c[c.length - 1]) };
      } else if (c.length >= 10 && TSYS_BRAND(r.name)) {
        out.cardRows.push({ name: r.name, brand: TSYS_BRAND(r.name), grossItems: int(c[0]), gross: cents(c[1]), refundItems: int(c[2]), refunds: cents(c[3]),
          netItems: int(c[4]), net: cents(c[5]), perItem: perItem(c[7]), discPct: dec(c[8]), discount: cents(c[9]) });
      }
    }
    // rates & fees: [rate %, per item, (count), amount, total]
    for (const r of sectionRows("RATES & FEES", ["Total Rates & Fees Due"])) {
      const c = r.cells, rate = c.find((x) => /%$/.test(x));
      if (!rate || !r.name) continue;
      const money = c.filter((x) => cents(x) != null), count = c.find((x, i) => i > 1 && int(x) != null);
      out.rateLines.push({ description: r.name, rate: parseFloat(rate) / 100, perItem: perItem(c[1]), count: count != null ? int(count) : null, base: cents(money[money.length - 2]), amount: 0 - cents(money[money.length - 1]) });
    }
    // other charges: [(count), (per item), total]
    for (const r of sectionRows("OTHER CHARGES", ["Total Other Charges"])) {
      const c = r.cells.filter((x) => x !== "$");
      if (!r.name || !c.length) continue;
      const total = cents(c[c.length - 1]);
      if (total == null) continue;
      const count = c.length >= 3 ? int(c[0]) : null, each = c.length >= 3 ? perItem(c[1]) : null;
      out.otherLines.push({ description: r.name, count, perItem: each, amount: 0 - total });
    }
    // the fee summary and the processor's own effective rates
    for (const l of lines) {
      const t = text(l), m = (re) => re.test(t) && cents(l.cells[l.cells.length - 1].s);
      const pairs = [["discount", /^DISCOUNT TOTAL/], ["discountPaid", /^DISCOUNT PAID/], ["rates", /^RATES & FEES TOTAL/], ["other", /^OTHER CHARGES TOTAL/],
        ["ratesDue", /^Total Rates & Fees Due/], ["otherDue", /^Total Other Charges/], ["deducted", /^Total Amount Deducted/]];
      for (const [k, re] of pairs) { const v = m(re); if (v !== false && v != null && out.summary[k] == null) out.summary[k] = v; }
    }
    for (const r of sectionRows("EMDR CALCULATIONS", ["EMDR ="])) {
      if (r.cells.length >= 3 && TSYS_BRAND(r.name)) out.emdr.push({ name: r.name, brand: TSYS_BRAND(r.name), volume: cents(r.cells[0]), fees: cents(r.cells[1]), rate: parseFloat(r.cells[2]) / 100 });
    }

    if (!out.batches.length || !out.cardRows.length || out.summary.deducted == null) {
      return { ok: false, reason: "This looks like a TSYS statement, but its tables couldn't be read (no deposits, card types or total deducted). Nothing is shown rather than a partial reading.", totals: findTotals(lines) };
    }

    // ---- the shared shape
    // the processor's discount, one line per card type that has one
    for (const c of out.cardRows) {
      if (!c.discount) continue;
      const base = c.gross + Math.abs(c.refunds);    // TSYS charges it on sales and refunds alike
      out.feeLines.push({ category: "Card type summary", product: c.brand, description: `${c.name.toUpperCase()} DISCOUNT ${(c.discPct ?? 0).toFixed(2)}% ON SALES AND REFUNDS $${(base / 100).toFixed(2)}`,
        type: "Discount", amount: 0 - c.discount, brand: c.brand, calc: { rate: (c.discPct ?? 0) / 100, base: base / 100, kind: "rate", tolerance: Math.max(1, c.grossItems + c.refundItems) } });
    }
    for (const r of out.rateLines) {
      out.feeLines.push({ category: "Rates & fees", product: null, description: r.description, type: "Rates & Fees", amount: r.amount,
        calc: r.base != null ? { rate: r.rate, base: r.base / 100, kind: "rate" } : null });
    }
    for (const r of out.otherLines) {
      out.feeLines.push({ category: "Other charges", product: null, description: r.description, type: "Other Charges", amount: r.amount,
        calc: r.count != null && r.perItem != null ? { rate: r.perItem, base: r.count, kind: "count", unit: "items" } : null });
    }
    // interchange: the Visa lines in RATES & FEES ("VS CA ...", "VS CANADA ...") and Interac's
    for (const r of out.rateLines) {
      if (/^(VS|VI|VISA|MC|MASTERCARD)\s+(CA|CANADA)\b/.test(r.description) || /INTERCHANGE/.test(r.description)) {
        out.ic.push({ brand: /INTERAC/.test(r.description) ? "INTERAC" : /^(MC|MASTERCARD)/.test(r.description) ? "MASTERCARD" : "VISA", description: r.description, sales: r.base ?? 0, count: r.count ?? 0, rate: r.rate, perItem: 0, total: r.amount, country: "CA" });
      }
    }
    // card types by brand (Visa, Visa Debit and Visa Business are one brand here)
    const byBrand = new Map();
    for (const c of out.cardRows) {
      const b = byBrand.get(c.brand) || { brand: c.brand, gross: 0, refunds: 0, net: 0, grossItems: 0, refundItems: 0, netItems: 0 };
      for (const k of ["gross", "refunds", "net", "grossItems", "refundItems", "netItems"]) b[k] += c[k] || 0;
      byBrand.set(c.brand, b);
    }
    out.cardTypes = [...byBrand.values()].filter((b) => b.gross || b.refunds).map((b) => ({ ...b, refunds: -b.refunds }));
    // one bar per day on the chart: batches on the same day are added together
    const days = new Map();
    for (const b of out.batches) days.set(b.date, (days.get(b.date) || 0) + b.sales - b.credits);
    out.days = [...days].map(([date, submitted]) => ({ date, submitted }));
    out.sales = out.depositTotal ? out.depositTotal.sales - out.depositTotal.credits : out.cardTotal.net;
    out.feeTotal = -out.summary.deducted;
    out.txns = out.cardTotal ? out.cardTotal.netItems : out.cardRows.reduce((n, c) => n + c.netItems, 0);
    return out;
  }

  // ---------------------------------------------------------------- any other statement
  // Only the labelled totals, each with the line it came from so the person can check it.
  const FEE_LABELS = [/total amount deducted/i, /total fees? (charged|due|deducted)/i, /total (merchant )?fees\b/i, /fees? charged/i, /total charges/i, /total (discount|service) (fees?|charges?|due)/i, /total deductions/i];
  const SALES_LABELS = [/total (net )?sales/i, /net sales/i, /amount submitted/i, /total (card )?volume/i, /total (amount )?processed/i, /gross sales/i, /total sales volume/i, /total transactions? value/i, /value of (all )?(txns|transactions)/i];
  function findTotals(lines) {
    const valueOf = (l) => {
      const vals = l.cells.map((c) => cents(c.s.replace(/[A-Z]{3}$/, "").trim())).filter((v) => v != null && v !== 0);
      return vals.length ? Math.abs(vals[vals.length - 1]) : null;
    };
    // labels with "total" in them, in order; then, for the rest, the biggest figure on any matching
    // line (a monthly total is bigger than the daily or per-card lines that share its label)
    const pick = (labels) => {
      const hits = [];
      for (const re of labels) for (const l of lines) {
        const t = text(l), v = re.test(t) ? valueOf(l) : null;
        if (v == null) continue;
        if (/total/i.test(re.source)) return { cents: v, line: t, page: l.page };
        hits.push({ cents: v, line: t, page: l.page });
      }
      return hits.sort((x, y) => y.cents - x.cents)[0] || null;
    };
    return { sales: pick(SALES_LABELS), fees: pick(FEE_LABELS) };
  }

  return { linesFromItems, parse, detect, findTotals, cents, BRANDS };
})();

if (typeof module !== "undefined") module.exports = FeeStatement;
