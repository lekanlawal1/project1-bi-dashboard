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
    visaCA: { name: "Visa Canada Interchange Reimbursement Fees (current schedule)", url: "https://www.visa.ca/content/dam/VCOM/regional/na/canada/Support/Documents/visa-canada-interchange-rates.pdf", official: true },
    visaCAnext: { name: "Visa Canada, Upcoming Interchange Modifications, effective 24 October 2026", url: "https://www.visa.ca/content/dam/VCOM/regional/na/canada/Support/Documents/visa-canada-upcoming-changes-to-interchange-rates.pdf", official: true },
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

  // ---------------------------------------------------------------- Visa Canada (official schedules)
  // Canadian credit interchange is a percentage only, by card type: Classic/Gold/Platinum,
  // Infinite, Infinite+, Infinite Privilege. Rates changed on 24 October 2026; for sales from
  // then on, only the programs whose new rate Visa has published are checked.
  const CA_COLS = ["Classic, Gold or Platinum", "Infinite", "Infinite+", "Infinite Privilege"];
  const CA_SWITCH = "2026-10-24";
  const CA = {   // [program pattern, name, current rates, rates from 24 Oct 2026 (null: not published), downgrade?]
    smElec: [/SMALL MERCHANT ELECTRONIC|SM MERCH(ANT)? ELEC/, "Small Merchant Electronic, card present", [0.77, 0.99, 1.05, 1.80], [0.70, 0.89, null, null]],
    smCnpTok: [/SMALL MERCHANT CNP.*TOKEN/, "Small Merchant card not present, tokenized", [1.25, 1.50, 2.15, 2.25], [1.15, 1.40, null, null]],
    smCnp: [/SMALL MERCHANT CNP|SMALL MERCHANT CARD NOT PRESENT/, "Small Merchant card not present", [1.30, 1.55, 2.20, 2.30], [1.20, 1.45, null, null]],
    cnpTok: [/(CNP|CARD NOT PRESENT).*TOKEN/, "Card not present, tokenized", [1.35, 1.60, 2.25, 2.35], null],
    cnp: [/\bCNP\b|CARD NOT PRESENT/, "Card not present", [1.40, 1.65, 2.30, 2.40], null],
    recurring: [/RECURRING/, "Recurring payments", [1.25, 1.53, 1.95, 1.95], null],
    elec: [/ELECTRONIC/, "Electronic, card present", [1.25, 1.57, 1.60, 2.08], null],
    standard: [/STANDARD (CONSUMER )?CREDIT|CANADA STANDARD$|\bSTANDARD\b/, "Standard (the rate a sale falls to when it qualifies for nothing cheaper)", [1.45, 1.70, 2.35, 2.45], null, true],
  };
  function visaCanadaCols(d) {
    if (/PRIVILEGE|INF PRIV|\bVIP\b/.test(d)) return [3];
    if (/INFINITE\s*\+|INF\s*\+|INF PLUS|INFINITE PLUS/.test(d)) return [2];
    if (/\bINF\b|INFINITE/.test(d)) return [1];
    if (/\bCGP\b|CLASSIC|GOLD|PLATINUM/.test(d)) return [0];
    return [0, 1, 2, 3];
  }
  function visaCanada(d, date) {
    const after = date && date >= CA_SWITCH;
    if (/BUSINESS/.test(d)) {
      if (!/STANDARD/.test(d)) return null;
      const inf = /INFINITE/.test(d);
      if (after) return inf ? null : { name: "Business credit, Standard", rates: [{ pct: 2.15, fix: 0, col: "Business" }], source: "visaCAnext" };
      return { name: `${inf ? "Infinite Business" : "Business"} credit, Standard`, rates: [{ pct: inf ? 2.35 : 2.00, fix: 0, col: inf ? "Visa Infinite Business" : "Business" }], source: "visaCA" };
    }
    const cols = visaCanadaCols(d);
    for (const [re, name, now, next, downgrade] of Object.values(CA)) {
      if (!re.test(d)) continue;
      const table = after ? next : now;
      if (!table) return null;
      const rates = cols.map((i) => table[i] == null ? null : { pct: table[i], fix: 0, col: CA_COLS[i] }).filter(Boolean);
      if (!rates.length) return null;
      const out = { name, rates, source: after ? "visaCAnext" : "visaCA" };
      if (downgrade) {
        out.downgrade = true;
        const sm = after ? CA.smElec[3] : CA.smElec[2];
        out.normal = { name: "Small Merchant Electronic", rates: cols.map((i) => sm[i] == null ? null : { pct: sm[i], fix: 0 }).filter(Boolean) };
      }
      return out;
    }
    return null;
  }

  // ---------------------------------------------------------------- look up one interchange line
  function lookup(brand, description, { country = "US", date } = {}) {
    const d = description.toUpperCase();
    if (country === "CA") return /^VS|^VI|^VISA/.test(d) || /^VISA/.test(brand) ? visaCanada(d, date) : null;
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
