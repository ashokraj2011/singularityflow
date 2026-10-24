# Repository brief: refunds at b99212c47dcc (for design, focused on this Story)

## Contracts
- POST /refunds takes Refund {reason: String (required, not blank); amount: BigDecimal (more than 0)} and returns String; no test reaches it (OrderController.java:16)
- record Refund {reason: String (required, not blank); amount: BigDecimal (more than 0)} (Refund.java:7)
- PaymentGateway (interface) is implemented by StripeGateway (PaymentGateway.java:5; StripeGateway.java:5)
- POST /orders takes OrderRequest {lines: List<String> (required, at least 1 long, at most 20 long); total: BigDecimal (at least 10); email: String (an email address)} and returns String; no test reaches it (OrderController.java:11)
- class OrderRequest {lines: List<String> (required, at least 1 long, at most 20 long); total: BigDecimal (at least 10); email: String (an email address)} (OrderRequest.java:10)

## Rules that apply
- Refund.amount: more than 0. Documented; declared on Refund, but no endpoint validates it (@Valid is missing). (Refund.java:7; README.md › Business rules)
- Refund.reason: required, not blank. Not documented; declared on Refund, but no endpoint validates it (@Valid is missing). (Refund.java:7)
- OrderRequest.email: an email address. Not documented, enforced by bean-validation. (OrderRequest.java:18)
- OrderRequest.lines: required, at least 1 long, at most 20 long ("An order has 1 to 20 lines"). Documented, enforced by bean-validation. (OrderRequest.java:11; README.md › Business rules)

## Risks
- src/main/java/com/acme/api/OrderController.java: changed 1 time, complexity 2, imported by 0 (OrderController.java)
- src/main/java/com/acme/api/Refund.java: changed 1 time, complexity 1, imported by 0 (Refund.java)
- src/main/java/com/acme/api/StripeGateway.java: changed 1 time, complexity 1, imported by 0 (StripeGateway.java)

## What exists
- refunds: 7 code files in java (5 files), typescript (2 files); 2 entry points, 0 rules in code, 0 tests. (commit b99212c47dcc)

- … 5 more: singularity-flow wm brief --phase design

Not known: calls are matched by name (no semantic pack is warmed); no runtime or incident data.
Read without a model from the committed source. Open the cited lines before relying on a detail.
