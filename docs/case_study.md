# Case study — Superstore Margin Console

A retailer's revenue grew four years straight — while 18% of its order lines quietly lost money. I built an interactive BI dashboard to find out where profit was leaking, and turned the answer into a concrete pricing recommendation.

I wrote a reproducible Python cleaning pipeline that logs every decision it makes: it caught 505 duplicate order lines that would have overstated revenue by ~5%, flagged (rather than dropped) rows with suspect logistics data, and deliberately kept high-value outlier orders because in retail, big orders are revenue, not noise. I then modeled discounts into four bands so a continuous variable became a lever a manager can actually pull.

The headline finding: every discount above 20% is margin-negative in every category — average line margin drops from +33% at full price to −97% at 41%+ discounts, and one sub-category (Tables) loses $17.7K on $207K in sales. The dashboard, a fast single-file Plotly.js build deployed on free static hosting, lets a reviewer filter by category and trace the "discount cliff" themselves. The accompanying one-page business case quantifies a discount-cap policy worth roughly a $150K annual profit swing — more than 50% of the company's current total profit.

**Stack:** Python (pandas), Plotly.js, static HTML/JS, GitHub Pages.
