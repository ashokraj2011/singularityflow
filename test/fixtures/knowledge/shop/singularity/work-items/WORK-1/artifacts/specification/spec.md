# Specification: checkout pricing

## Requirements

- Orders of $50 or more ship free; smaller orders pay a flat shipping fee. [WORK-1:REQ-001]
- The SAVE10 coupon takes 10% off a subtotal of $30 or more. [WORK-1:REQ-002]

## Acceptance criteria

| Criterion | Statement |
| --- | --- |
| [WORK-1:AC-001] | A shopper who is not a member cannot use the VIP20 coupon. |
| [WORK-1:AC-002] | Placing an order with an empty cart is refused with a message. |
