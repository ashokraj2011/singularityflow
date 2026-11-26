# Repository brief: refunds at b99212c47dcc (for intake, focused on this Story)

## What exists
- refunds: 7 code files in java (5 files), typescript (2 files); 2 entry points, 0 rules in code, 0 tests. (commit b99212c47dcc)

## Rules that apply
- Refund.amount: more than 0. Documented; declared on Refund, but no endpoint validates it (@Valid is missing). (Refund.java:7; README.md › Business rules)
- Refund.reason: required, not blank. Not documented; declared on Refund, but no endpoint validates it (@Valid is missing). (Refund.java:7)
- OrderRequest.email: an email address. Not documented, enforced by bean-validation. (OrderRequest.java:18)
- Signup.age: at least 18. Not documented, enforced by zod. (schema.ts:5)

## Questions for the product owner
- Refund.amount is declared more than 0, but no endpoint validates Refund. Should it be validated (@Valid)? (Refund.java:7; README.md › Business rules)
- Refund.reason is declared required, not blank, but no endpoint validates Refund. Should it be validated (@Valid)? (Refund.java:7)

## Contracts
- POST /refunds takes Refund {reason: String (required, not blank); amount: BigDecimal (more than 0)} and returns String (OrderController.java:16)
- record Refund {reason: String (required, not blank); amount: BigDecimal (more than 0)} (Refund.java:7)
- PaymentGateway (interface) is implemented by StripeGateway (PaymentGateway.java:5; StripeGateway.java:5)
- POST /orders takes OrderRequest {lines: List<String> (required, at least 1 long, at most 20 long); total: BigDecimal (at least 10); email: String (an email address)} and returns String (OrderController.java:11)

- … 7 more: singularity-flow wm brief --phase intake

Not known: calls are matched by name (no semantic pack is warmed), so who calls what and which tests reach it are left out.
Read without a model from the committed source. Open the cited lines before relying on a detail.
