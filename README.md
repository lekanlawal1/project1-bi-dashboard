# Margin Console

Drop in a sales export and see where your profit goes: which discounts cost you money, which products
lose it, and how your margin moves month by month, with the SQL behind every chart. Everything runs in
your browser; the file is never uploaded.

**Live:** [lekanlawal1.github.io/project1-bi-dashboard](https://lekanlawal1.github.io/project1-bi-dashboard/)
(click "Try it with sample data", or drop in your own CSV or Excel file)

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
