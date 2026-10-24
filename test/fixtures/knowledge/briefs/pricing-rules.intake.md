# Repository brief: pricing-rules at 3edeffbc47c6 (for intake, focused on this Story)

## What exists
- pricing-rules: 1 code files in javascript (1 files); 0 entry points, 4 rules in code, 0 tests. (commit 3edeffbc47c6)

## Rules that apply
- loyal-customer-discount: when `customer.years >= 3` and `order.total > 100` → decides `discount = 0.1`. Documented, enforced. (discounts.yml:2; README.md › Business rules)
- high-risk-block: when `customer.riskScore > 80` → decides `action = "reject", reason = "Risk score too high"`. Documented, enforced. (discounts.yml:13; README.md › Business rules)
- minimum-age: when `age >= 18` → decides `eligible`. Conflict: the docs say at least 21; the code allows at least 18. (eligibility.json:3; README.md › Business rules)
- partner-routing: when `partner == "acme"` → decides `route = "partner-queue", apiKey = (withheld)`. Not documented, enforced. (eligibility.json:4)

## Questions for the product owner
- Docs and code disagree on "minimum-age: when `age >= 18` → decides `eligible`": the docs say at least 21; the code allows at least 18. Which is right? (eligibility.json:3; README.md › Business rules)

Read without a model from the committed source. Open the cited lines before relying on a detail.
