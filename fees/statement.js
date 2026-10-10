/* Card Fee Checker, step 1: turn the text of a processor statement into numbers.

   The PDF is read in the browser by pdf.js, which gives every piece of text with its position on
   the page. linesFromItems() puts those pieces back into rows and cells; parse() then reads the
   statement's tables. Money is kept in whole cents so totals add up exactly.

   Only one layout is supported so far: the CardPointe statement that Fiserv prints for many
   resellers ("YOUR CARD PROCESSING STATEMENT", "Summary By Day", "Fee Summary"). Anything else is
   refused with a clear message rather than read badly. No DOM here, so the tests run it in Node. */

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
  const MONEY = /^-?\$-?[\d,]+\.\d{2}$/;
  const cents = (s) => {
    if (s == null) return null;
    const t = String(s).replace(/\s/g, "");
    if (!MONEY.test(t)) return null;
    const neg = t.includes("-");
    const [whole, frac] = t.replace(/[-$,]/g, "").split(".");
    return (neg ? -1 : 1) * (Number(whole) * 100 + Number(frac));
  };
  const int = (s) => (/^\d[\d,]*$/.test(String(s ?? "").trim()) ? Number(String(s).replace(/,/g, "")) : null);
  const dec = (s) => (/^-?\d*\.\d+$|^-?\d+$/.test(String(s ?? "").trim()) ? Number(s) : null);
  const isPct = (s) => /^-?[\d.]+%$/.test(String(s ?? "").trim());
  const text = (line) => line.cells.map((c) => c.s).join(" ");

  // ---------------------------------------------------------------- which statement is this?
  function detect(lines) {
    const all = lines.map(text).join("\n");
    if (/YOUR CARD PROCESSING STATEMENT/i.test(all) && /Summary By Day/i.test(all) && /Fee Summary/i.test(all)) return "cardpointe";
    return null;
  }
  function whyNot(lines) {
    const all = lines.map(text).join("\n");
    if (!all.trim()) return "This PDF has no text to read. It's probably a scan or a photo; download the statement as a PDF from your processor's website instead.";
    const known = [[/square/i, "Square"], [/clover/i, "Clover"], [/stripe/i, "Stripe"], [/helcim/i, "Helcim"], [/moneris/i, "Moneris"], [/paypal/i, "PayPal"], [/shopify/i, "Shopify"]];
    const hit = known.find(([re]) => re.test(all));
    return `This statement's layout isn't supported yet${hit ? ` (it looks like ${hit[1]})` : ""}. The checker reads CardPointe statements printed by Fiserv for now. You can still use the quick check below with two numbers from your statement.`;
  }

  // ---------------------------------------------------------------- the CardPointe layout
  const isNoise = (line) => /^PERIOD:/.test(line.cells[0]?.s || "") || line.cells.some((c) => /^Page \d+ of \d+$/.test(c.s));

  function parse(lines) {
    if (detect(lines) !== "cardpointe") return { ok: false, reason: whyNot(lines) };
    const all = lines.map(text).join("\n");
    const out = {
      ok: true, layout: "CardPointe (Fiserv)",
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
      return { ok: false, reason: "This looks like a CardPointe statement, but its tables couldn't be read (no daily totals or no fee lines). Nothing is shown rather than a partial reading." };
    }
    return out;
  }

  return { linesFromItems, parse, detect, cents, BRANDS };
})();

if (typeof module !== "undefined") module.exports = FeeStatement;
