# Repository brief: refunds at b99212c47dcc (for verification, focused on this Story)

## Rules that apply
- Refund.amount: more than 0. Documented; declared on Refund, but no endpoint validates it (@Valid is missing). (Refund.java:7; README.md › Business rules)
- Refund.reason: required, not blank. Not documented; declared on Refund, but no endpoint validates it (@Valid is missing). (Refund.java:7)
- OrderRequest.email: an email address. Not documented, enforced by bean-validation. (OrderRequest.java:18)
- OrderRequest.lines: required, at least 1 long, at most 20 long ("An order has 1 to 20 lines"). Documented, enforced by bean-validation. (OrderRequest.java:11; README.md › Business rules)
- OrderRequest.total: at least 10. Documented, enforced by bean-validation. (OrderRequest.java:15; README.md › Business rules)
- CreateUserDto.name: required, not empty, at least 3 long, at most 30 long. Conflict: the docs say at most 40; the code allows at most 30. (dto.ts:4; README.md › Business rules)
- CreateUserDto.credit: at least 0. Not documented, enforced by class-validator. (dto.ts:8)
- Signup.age: at least 18. Not documented, enforced by zod. (schema.ts:5)
- Signup.email: required, an email address. Not documented, enforced by zod. (schema.ts:4)

## Risks
- src/main/java/com/acme/api/OrderController.java: changed 1 time, complexity 2, imported by 0 (OrderController.java)
- src/main/java/com/acme/api/Refund.java: changed 1 time, complexity 1, imported by 0 (Refund.java)
- src/main/java/com/acme/api/StripeGateway.java: changed 1 time, complexity 1, imported by 0 (StripeGateway.java)

## What a change touches
- OrderController.refund (changed): handles POST /refunds; no test reaches it (OrderController.java:16)

Not known: calls are matched by name (no semantic pack is warmed); no runtime or incident data.
Read without a model from the committed source. Open the cited lines before relying on a detail.
