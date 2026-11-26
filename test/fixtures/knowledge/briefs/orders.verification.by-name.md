# Repository brief: orders at ac91860bb887 (for verification, focused on this Story)

## Rules that apply
- OrderService.cancel: when `order.getStatus() != OrderStatus.PLACED` → refuses "Only placed orders can be cancelled" (HTTP 409). Documented, enforced. (OrderService.java:43; README.md › Business rules)
- 409 — the order cannot be cancelled in its state. Documented, enforced. (OrderService.java:44; README.md › Error responses)
- OrderService.place: when `order.isVip()` → does `total = total.subtract(total.multiply(VIP_DISCOUNT_RATE))`. Documented, enforced, tested. (OrderService.java:33; README.md › Business rules)
- OrderService.place: when `order.getLines().isEmpty()` → refuses "An order needs at least one line" (HTTP 400). Documented, enforced, tested. (OrderService.java:23; README.md › Business rules)
- OrderService.place: when `order.getLines().size() > MAX_ITEMS` → refuses "An order can have at most 20 lines" (HTTP 400). Documented, enforced, tested. (OrderService.java:26; README.md › Business rules)
- OrderService.place: when `total.compareTo(MINIMUM_ORDER_TOTAL) < 0` → refuses "Orders under 10.00 are not accepted" (HTTP 400). Documented, enforced, tested. (OrderService.java:30; README.md › Business rules)
- 400 — the order is invalid. Documented, enforced. (OrderService.java:24; README.md › Error responses)
- 404 — the order does not exist. Documented, enforced. (OrderService.java:42; README.md › Error responses)

## Risks
- (changed by this Story) OrderService.place: 5 rules (OrderService.java:22)

## What a change touches
- OrderService.cancel (changed): 1 rule (OrderService.java:41)
- OrderService.place (changed): 5 rules (OrderService.java:22)

- … 1 more: singularity-flow wm brief --phase verification

Not known: calls are matched by name (no semantic pack is warmed), so who calls what and which tests reach it are left out; no runtime or incident data.
Read without a model from the committed source. Open the cited lines before relying on a detail.
