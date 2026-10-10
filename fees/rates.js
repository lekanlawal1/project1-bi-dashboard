/* Card Fee Checker, step 2: the published rates each statement line is checked against.

   Interchange is set by the card networks and paid to the bank that issued the customer's card. It
   is the same for every processor, so a statement can be checked against the networks' own
   schedules. Each entry below says where its numbers come from. When a line on a statement doesn't
   match any entry, the checker says "not checked" rather than guessing.

   Rates are written as [percent, fixed fee in dollars]. Visa's columns are the card types in its
   schedule: Infinite (spend qualified), Infinite (not spend qualified), Signature Preferred,
   Signature, Traditional Rewards, All Other. */

const FeeRates = (() => {
  const SOURCES = {
    visa: { name: "Visa USA Interchange Reimbursement Fees, rates effective 18 April 2026", url: "https://usa.visa.com/content/dam/VCOM/download/merchants/visa-usa-interchange-reimbursement-fees.pdf", official: true },
    mc: { name: "Helcim's summary of Mastercard U.S. interchange (Mastercard's own schedule is not openly downloadable)", url: "https://www.helcim.com/mastercard-usa-interchange-rates/", official: false },
    amex: { name: "American Express OptBlue Pricing Guide 25.2 (Fall 2025), as published by a Fiserv bank partner", url: "https://www.fhb.com/sites/default/files/2025-10/25.2_American_Express_OptBlue_Program_Pricing_Guide.pdf", official: false },
    fees: { name: "Published card-network fee schedules (Visa and Mastercard assessments are widely reported, not posted by the networks)", url: "https://www.helcim.com/mastercard-usa-interchange-rates/", official: false },
  };

  // ---------------------------------------------------------------- Visa (official schedule)
  const VISA_COLS = ["Infinite (spend qualified)", "Infinite", "Signature Preferred", "Signature", "Traditional Rewards", "All Other"];
  const V = (...pairs) => pairs.map((p, i) => ({ pct: p[0], fix: p[1], col: VISA_COLS[i] }));
  const VISA = {
    product1: V([2.60, .10], [2.20, .10], [2.50, .10], [2.05, .10], [2.04, .10], [1.89, .10]),          // card not present
    product2: V([2.30, .10], [1.90, .10], [2.10, .10], [1.65, .10], [1.65, .10], [1.51, .10]),          // card present
    health1: V([2.40, .10], [1.53, .05], [2.40, .10], [1.53, .05], [1.53, .05], [1.53, .05]),           // healthcare, card not present
    health2: V([2.30, .10], [1.43, .05], [2.30, .10], [1.43, .05], [1.43, .05], [1.43, .05]),           // healthcare, card present
  };
  const VISA_BUS = {   // business credit, by spend tier I..V
    1: [2.65, 2.80, 2.85, 2.95, 3.00], 2: [1.90, 2.05, 2.10, 2.20, 2.25], 3: [2.40, 2.55, 2.60, 2.70, 2.75],
  };
  // which Visa columns a statement's card-type words point to
  function visaColumns(d) {
    if (/INFINITE\s*SQ|INF\s*SQ/.test(d)) return [0];
    if (/INFINITE|\bINF\b/.test(d)) return [0, 1];
    if (/SIGN(ATURE)?\s*PREF/.test(d)) return [2];
    if (/SIGNATURE|\bSIGN\b|\bSIG\b/.test(d)) return [3];
    if (/TRAD/.test(d)) return [4, 5];
    return [0, 1, 2, 3, 4, 5];
  }
  const pick = (table, cols) => cols.map((i) => table[i]);
  const REGULATED = [{ pct: 0.05, fix: 0.21, col: "Regulated debit" }, { pct: 0.05, fix: 0.22, col: "Regulated debit with fraud adjustment" }];

  function visa(d) {
    if (/REG(ULATED)?\b|REG CONSUMER|\bREG\s/.test(d) && /\((DB|PP)\)|DEBIT|CONSUMER/.test(d)) return { name: "Regulated debit (capped by law)", rates: REGULATED, source: "visa" };
    const bus = d.match(/BUS(?:INESS)?\s*TR(?:IER)?\s*([1-5])\s*PRD\s*([123])/);
    if (bus) {
      const tier = +bus[1], prod = +bus[2];
      return { name: `Business credit, tier ${tier}, product ${prod}`, rates: [{ pct: VISA_BUS[prod][tier - 1], fix: .10, col: `Tier ${tier}` }], source: "visa",
        alt: prod === 1 ? { name: "Business product 2", rates: [{ pct: VISA_BUS[2][tier - 1], fix: .10 }] } : null };
    }
    if (/NON[\s-]?QUAL/.test(d)) {
      if (/BUS/.test(d)) return { name: "Business non-qualified", rates: [{ pct: 3.15, fix: .20, col: "All" }], source: "visa", downgrade: true };
      return { name: "Non-qualified consumer credit", rates: [{ pct: 3.15, fix: .10, col: "all card types" }], source: "visa", downgrade: true,
        normal: { name: "Product 1 (card not present)", rates: VISA.product1 } };
    }
    if (/\(DB\)/.test(d)) {
      if (/ECOMM|CNP|CARD NOT PRESENT/.test(d)) return { name: "Debit, card not present (CPS/e-Commerce Basic)", rates: [{ pct: 1.65, fix: .15, col: "Exempt debit" }], source: "visa" };
      if (/RETAIL/.test(d)) return { name: "Debit, card present (CPS/Retail)", rates: [{ pct: 0.80, fix: .15, col: "Exempt debit" }], source: "visa" };
    }
    if (/\(PP\)|PREPAID/.test(d)) {
      if (/ECOMM|CNP/.test(d)) return { name: "Prepaid, card not present (CPS/e-Commerce Basic)", rates: [{ pct: 1.75, fix: .20, col: "Exempt prepaid" }], source: "visa" };
      if (/RETAIL/.test(d)) return { name: "Prepaid, card present (CPS/Retail)", rates: [{ pct: 1.15, fix: .15, col: "Exempt prepaid" }], source: "visa" };
    }
    const cols = visaColumns(d);
    if (/HEALTHCARE|HLTHCARE/.test(d)) {
      // the statement name doesn't say keyed or in person, so both healthcare programs are allowed
      return { name: "Healthcare credit", rates: [...pick(VISA.health1, cols).map((r) => ({ ...r, col: `${r.col}, keyed or online` })), ...pick(VISA.health2, cols).map((r) => ({ ...r, col: `${r.col}, in person` }))], source: "visa",
        alt: { name: "Healthcare 2 (card present)", rates: pick(VISA.health2, cols), only: "keyed or online" } };
    }
    if (/ECOMM|\bP1\b|PRD\s*1|PRODUCT 1|CNP/.test(d)) return { name: "Consumer credit, card not present (Product 1)", rates: pick(VISA.product1, cols), source: "visa",
      alt: { name: "Product 2 (card present)", rates: pick(VISA.product2, cols) } };
    if (/\bP2\b|PRD\s*2|PRODUCT 2|CPS\s*RETAIL|RETAIL/.test(d)) return { name: "Consumer credit, card present (Product 2)", rates: pick(VISA.product2, cols), source: "visa" };
    return null;
  }

  // ---------------------------------------------------------------- Mastercard (secondary source)
  // MERIT I is the card-not-present program, MERIT III the card-present one
  const MC = { worldElite: [2.60, 2.30], world: [2.20, 1.90], enhanced: [2.10, 1.80], core: [1.95, 1.65] };
  const MC_DATA2 = [1.90, 2.05, 2.10, 2.20, 2.25];
  function mastercard(d) {
    if (/\bREG\b|REGULATED/.test(d)) return { name: "Regulated debit (capped by law)", rates: REGULATED, source: "mc" };
    const lvl = d.match(/BUS(?:INESS)?\s*LEVEL\s*([1-5])\s*DATA RATE\s*II\b(?!I)/);
    if (lvl) return { name: `Business level ${lvl[1]}, Data Rate II`, rates: [{ pct: MC_DATA2[lvl[1] - 1], fix: .10, col: `Level ${lvl[1]}` }], source: "mc" };
    const cp = /MERIT\s*(III|3)\b/.test(d), cnp = /MERIT\s*(I|1)\b/.test(d) && !cp;
    if (!cp && !cnp) return null;
    if (/PREPAID/.test(d)) return { name: `Prepaid, ${cp ? "card present" : "card not present"}`, rates: [cp ? { pct: 1.15, fix: .15, col: "Prepaid" } : { pct: 1.76, fix: .20, col: "Prepaid" }], source: "mc" };
    if (/\(DB\)|DEBIT/.test(d)) return { name: `Debit, ${cp ? "card present" : "card not present"}`, rates: [cp ? { pct: 1.05, fix: .15, col: "Debit" } : { pct: 1.65, fix: .15, col: "Debit" }], source: "mc" };
    const kind = /WORLD\s*ELITE/.test(d) ? "worldElite" : /HIGH\s*VAL/.test(d) ? null : /WORLD/.test(d) ? "world" : /ENHANCED/.test(d) ? "enhanced" : /CORE|CONSUMER/.test(d) ? "core" : null;
    if (!kind) return null;
    const label = { worldElite: "World Elite", world: "World", enhanced: "Enhanced", core: "Core" }[kind];
    return { name: `${label} credit, ${cp ? "card present (Merit III)" : "card not present (Merit I)"}`, rates: [{ pct: MC[kind][cp ? 1 : 0], fix: .10, col: label }], source: "mc",
      alt: cnp ? { name: "Merit III (card present)", rates: [{ pct: MC[kind][1], fix: .10 }] } : null };
  }

  // ---------------------------------------------------------------- Amex OptBlue
  // tiers are set by the size of each sale; key-entered ("non-swipe") sales cost more
  const AMEX = {
    RETAIL: { swipe: [1.45, 2.05, 2.50], key: [1.75, 2.35, 2.80], bands: [[0, 75], [75.01, 1000], [1000.01, Infinity]] },
    HEALTHCARE: { swipe: [1.55, 1.85, 2.30], key: [1.85, 2.15, 2.65], bands: [[0, 150], [150.01, 2000], [2000.01, Infinity]] },
  };
  function amex(d) {
    const m = d.match(/(?:AXP|AMEX)\s*(RETAIL|HEALTHCARE)\s*(NON[\s-]?SWIPE)?\s*T(?:IER)?\s*([123])/);
    if (!m) return null;
    const ind = AMEX[m[1]], tier = +m[3], key = !!m[2];
    const rate = { pct: ind[key ? "key" : "swipe"][tier - 1], fix: .10, col: `Tier ${tier}${key ? ", key entered" : ""}` };
    // the Fall 2025 guide prints healthcare tier 3 key-entered at 2.65%; later 2026 summaries show 2.60%
    const rates = m[1] === "HEALTHCARE" && key && tier === 3 ? [rate, { ...rate, pct: 2.60, col: "Tier 3, key entered (2026)" }] : [rate];
    return { name: `${m[1] === "RETAIL" ? "Retail" : "Healthcare"} tier ${tier}${key ? ", key entered" : ""}`, rates, source: "amex",
      band: ind.bands[tier - 1], alt: key ? { name: `Tier ${tier}, card swiped, tapped or inserted`, rates: [{ pct: ind.swipe[tier - 1], fix: .10 }] } : null };
  }

  // ---------------------------------------------------------------- look up one interchange line
  function lookup(brand, description) {
    const d = description.toUpperCase();
    if (/^VI|^VISA/.test(brand) || /^VI[-\s]/.test(d)) return visa(d);
    if (/^MASTER|^MC/.test(brand) || /^MC[-\s]/.test(d)) return mastercard(d);
    if (/AMEX|AMERICAN/.test(brand) || /^AXP/.test(d)) return amex(d);
    return null;
  }

  // ---------------------------------------------------------------- card-network percentage fees
  // [pattern on the fee line, expected rate as a fraction, what it is]
  const NETWORK_RATES = [
    [/VISA ASSESSMENT FEE\s*CR/, 0.0014, "Visa's assessment on credit sales (0.14%)"],
    [/VISA ASSESSMENT FEE\s*DB/, 0.0013, "Visa's assessment on debit sales (0.13%)"],
    [/MASTERCARD ASSESSMENT FEE/, 0.0014, "Mastercard's assessment (0.14%, plus 0.01% more on sales of $1,000 or more)"],
    [/MC ASSESSMNT.*>=\s*\$1K|MC ASSESSMENT.*1,?000/, 0.0001, "Mastercard's extra 0.01% on sales of $1,000 or more"],
    [/AMEX ASSESSMENT FEE|AMEX NETWORK FEE/, 0.00165, "American Express's network fee (0.165%)"],
  ];

  return { SOURCES, lookup, NETWORK_RATES, VISA_COLS };
})();

if (typeof module !== "undefined") module.exports = FeeRates;
