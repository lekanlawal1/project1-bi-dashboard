# Money Snitch

It tells you who's taking your business's money.

Two separate money checks for a small business, in one page. Use either one, or both:

- **Profit margins:** drop in a sales export and see where your profit goes: which discounts cost you
  money, which products lose it, and how your margin moves month by month, with the SQL behind every chart.
- **Card fees:** drop in your card processor's monthly statement (PDF) and see what you really pay to take
  cards, whether every fee is billed correctly, and which part you can negotiate.

Everything runs in your browser; no file is ever uploaded.

**Live:** [lekanlawal1.github.io/project1-bi-dashboard](https://lekanlawal1.github.io/project1-bi-dashboard/)
(each tab has a sample; the card-fee tab is at [#fees](https://lekanlawal1.github.io/project1-bi-dashboard/#fees))

If both files cover the same month, each tab says what card fees were as a share of that month's sales and
profit.

## Who it's for

A small business owner whose sales are growing but whose bank balance isn't. Export your orders from
Shopify, Square, Clover, QuickBooks or a spreadsheet, drop the file in, confirm which column is which, and
you get:

- **Headline numbers** with the change against the previous period: sales, profit, margin, orders, and the
  share of lines sold at a loss.
- **The discount cliff:** margin at each discount level, so you can see where discounting starts costing more
  than it brings in.
- **Profit by category** and a **region by category** heatmap.
- **Where the profit comes from:** products ranked by profit with the running share of the total. Typically a
  small share of products makes most of the profit and a tail gives some back.
- **Products that lose money,** the 25 biggest.
- **What stands out:** plain-English findings, each a fixed rule over the numbers, not AI text.

Click any bar, heatmap cell, month or product and every chart filters to it. Under each chart, "Show the
SQL" shows the exact query it ran.

Files with no profit or cost column (most point-of-sale exports) still work: the dashboard shows sales,
discounts, products and locations instead of margins, and says so.

## How it works

- **DuckDB in the browser** reads the file (Excel goes through SheetJS first). Every chart is one SQL query
  from `console/core.js`.
- **Messy files are handled and reported, not silently counted:** rows without a readable date or sales
  amount (totals, notes, other sheets pasted below the data) are skipped, exact duplicate lines removed, and
  the data check says how many of each.
- **Columns are guessed, then confirmed by you.** Common export names are recognised (Shopify's "Lineitem
  price", "Billing Province"; point-of-sale "Net Sales", "Location"). Dates in day-first or month-first
  order are told apart from the values themselves. Costs can be per line or per unit, discounts a rate or a
  dollar amount.

## Card fees: the statement checker

A card statement mixes three kinds of fee under labels that don't say who gets the money. The checker
reads the statement PDF with pdf.js (in the browser) and does four things:

1. **It has to add up.** Daily sales must sum to the statement's total and every fee line must sum to the
   total fees, to the cent, or nothing is shown. Then ten more checks: sales by card brand, each section's
   subtotal, the fee summary by type, each interchange line (rate times sales plus the per-sale fee), and
   every fee line that prints its own calculation ("0.0065 DISC RATE TIMES $47,108.34",
   "130 TRANSACTIONS AT 0.1") is recalculated.
2. **Every dollar is sorted** into the bank that issued the card (interchange), the card networks
   (assessments and network fees), or the processor. The sorting uses written rules on each line's
   description (`fees/check.js`), because the statements' own labels mix these up: a Visa network fee filed
   under "Fees", Visa's assessment filed under "Interchange Charges". Lines no rule recognises are marked
   "not sure", never guessed.
3. **Interchange is checked against published rates** (`fees/rates.js`): Visa's own April 2026 schedule,
   the Amex OptBlue pricing guide, and a published summary of Mastercard's rates (Mastercard's schedule isn't
   openly downloadable, and the page says so). Card names on statements are abbreviated, so when a name could
   mean more than one card type every possible rate is allowed. A program with no source on file is "not
   checked".
4. **Findings, biggest first:** lines billed above the published rate, "non-qualified" downgrades, fee lines
   whose own arithmetic is wrong, PCI non-compliance fees, what keyed-in sales cost compared with tapping
   the card, more card checks than sales, and the processor's markup, with a box to compare another
   processor's quote.

Statements without a supported layout get a quick check instead: card sales and total fees give the real
rate.

**Tested on two real statements** (real businesses', read only locally for testing and never committed). US
CardPointe: 12 of 12 checks passed, 75 fee lines and 28 interchange lines read, all 25 checkable interchange lines
matched the published rates. Canadian TSYS: every deposit, card type and fee section added up, all 33 fee lines
summed to the $829.32 deducted, and all 5 Visa interchange lines matched Visa Canada's rates. **The public
samples** (`sample/sample_statement.pdf`, `sample/sample_statement_ca.pdf`) are made-up businesses in the same
layouts, built by `tools/sample_statement.mjs` and `tools/sample_statement_ca.mjs` with problems planted on purpose;
`tests/fees.test.mjs` checks that each one is found and nothing else is flagged.

**Two layouts are read in full:** CardPointe (printed by Fiserv for many US resellers) and TSYS in Canada.
Each has its own add-up checks; for TSYS that includes every deposit, each card type's discount (which TSYS
charges on refunds as well as sales), and the statement's own "EMDR" effective-rate table, which is matched to
the cent and then compared with everything actually deducted (on a real statement it left out 29% of the fees).
Canadian interchange is checked against Visa Canada's own schedules, including the change on 24 October 2026.

**Any other statement** gets the quick check, filled in from its labelled totals ("Total Amount Deducted",
"Total Fees Charged", "Total Sales"...), with the line each number came from so the person can confirm it. I
looked for public sample statements to build more layouts from: Chase's and Elavon's guides can't be
downloaded, Moneris, Clover and Square publish none, and the ones that exist (Australian banks) are annotated
pictures of statements. A parser built from a picture would be a guess, so new layouts wait for real statements.

**Limits.** Scanned or photographed statements have no text to read. US Mastercard rates come from a secondary
source, and Canadian Mastercard rates aren't checked yet. It's a check, not financial advice.

## Tested against an independent calculation

`tests/test_console_sql.py` generates the console's SQL with the same JavaScript the page uses, runs it in
DuckDB on the **raw** Superstore export, and compares every number with pandas:

- the raw file ends with 806 rows from the workbook's other sheets: all 806 are skipped
- 1 exact duplicate line is removed, leaving 9,993 lines, the same as the original cleaning pipeline
- sales, profit, margin, the discount cliff, the Tables loss, the profit ranking and the filters all match

A Shopify-style fixture caught a real bug: DuckDB can guess that `#` starts a comment line, and Shopify
names every order `#1001`, so a whole export would have vanished. Comments are now switched off.

```bash
node --test tests/core.test.mjs   # column guessing, dates, money formats, filters, findings
node --test tests/fees.test.mjs   # the card-fee checker, on the made-up sample statement
python -m pytest tests -q         # the SQL, against pandas, on the raw export and a Shopify-style file
python3 -m http.server 8800       # then open http://localhost:8800
```

## The original dashboard

The first version of this project was a fixed dashboard of the same Superstore data, built from a scripted
pandas cleaning pipeline (`src/clean_data.py`, decision log in `docs/cleaning_log.md`). It's still at
[/dashboard/](https://lekanlawal1.github.io/project1-bi-dashboard/dashboard/). Its findings are below. The
console shows the same patterns on the sample; its discount bands are finer (20 to 30%, 30 to 50%, over 50%), so
its percentages differ.


1. **The discount cliff:** average margin falls from **+33% (no discount)** to **−15% (21–40%)** to **−90% (41%+)**. No category survives a >20% discount. → *Recommend a 20% discount cap requiring manager approval above it.*
2. **Tables are a loss engine:** $207K in sales, **−$17.7K profit**, driven by a 26% average discount. Bookcases similar. → *Renegotiate supplier cost or de-emphasize in promotions.*
3. **Profit concentration:** Copiers, Phones and Accessories generate ~$142K of the $286K total profit on a fraction of volume; Central region underperforms every segment. → *Reallocate marketing spend toward Technology in West/East.*

Full one-page business case: [`docs/business_case.md`](docs/business_case.md)

Built by [Lekan Lawal](https://lekanlawal1.github.io/portfolio-site/). The sample is the public Superstore dataset.
