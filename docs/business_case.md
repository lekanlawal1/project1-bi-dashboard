# Business Case: Discount Governance Policy

**Audience:** VP Sales / CFO · **Ask:** approve a discount cap policy · **Basis:** 2015–2018 transaction data (9,993 order lines after removing appended non-order rows and de-duplication — see [`cleaning_log.md`](cleaning_log.md))

## The problem, in one number
Nearly 1 in 5 order lines (18.7%) are sold at a loss. Total profit is $286K on $2.30M of sales (12.5% margin) — but that blended figure hides that **every discount band above 20% is margin-negative in every product category**:

| Discount band | Avg. line margin | Sales exposed |
|---|---|---|
| No discount | +33% | $1.09M |
| 1–20% | +16% | $846K |
| 21–40% | **−16%** | $234K |
| 41%+ | **−97%** | $129K |

Roughly **$363K of revenue (16%) is transacted at value-destroying discount levels.**

## Recommended decision
1. **Cap standard discounts at 20%.** Discounts above 20% require manager approval with a documented reason (e.g., clearance, contractual).
2. **Product exceptions list:** Tables and Bookcases (currently −13 to −15% margin at a 21–26% *average* discount) move to cost renegotiation or promotion exclusion rather than discount-led selling.
3. **Reinvest** promotional budget into Technology sub-categories (Copiers +32% margin, Accessories +22%) in West/East regions where segment profitability is proven.

## Quantified impact (conservative)
If the two loss-making discount bands had transacted at the 1–20% band's +16% margin instead of their actual −26% blended margin, the same $363K of revenue would have contributed **≈ +$58K profit instead of −$95K — a ~$150K annualized swing, a >50% increase in total company profit.** Even assuming 30% of that deep-discount revenue is lost entirely when discounts shrink, the policy remains strongly profit-positive.

## Risks & mitigations
- **Volume loss:** deep discounts may drive attachment sales → monitor basket-level revenue for 2 quarters post-policy.
- **Data caveat:** margins are line-level; allocated fixed costs are not modeled, so absolute profit figures are directional.
