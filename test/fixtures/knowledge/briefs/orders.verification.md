# Repository brief: orders at ac91860bb887 (for verification, focused on this Story)

## Rules that apply
- OrderService.cancel: when `order.getStatus() != OrderStatus.PLACED` → refuses "Only placed orders can be cancelled" (HTTP 409). Documented, enforced, no test reaches it. (OrderService.java:43; README.md › Business rules)
- 409 — the order cannot be cancelled in its state. Documented, enforced. (OrderService.java:44; README.md › Error responses)
- OrderService.place: when `order.isVip()` → does `total = total.subtract(total.multiply(VIP_DISCOUNT_RATE))`. Documented, enforced, tested. (OrderService.java:33; README.md › Business rules)
- OrderService.place: when `order.getLines().isEmpty()` → refuses "An order needs at least one line" (HTTP 400). Documented, enforced, tested. (OrderService.java:23; README.md › Business rules)
- OrderService.place: when `order.getLines().size() > MAX_ITEMS` → refuses "An order can have at most 20 lines" (HTTP 400). Documented, enforced, tested. (OrderService.java:26; README.md › Business rules)
- 400 — the order is invalid. Documented, enforced. (OrderService.java:24; README.md › Error responses)

## Risks
- (changed by this Story) OrderService.cancel: reached by 1 entry point, no test reaches it (OrderService.java:41)
- (changed by this Story) OrderService.place: reached by 1 entry point, 5 rules (OrderService.java:22)
- OrderService.totalOf: reached by 1 entry point (OrderService.java:50)

## Flows
- POST /orders/{id}/cancel → OrderController.cancel → OrderService.cancel; refuses 1 way (HTTP 409); 1 rule on the way; writes the database; returns Order (OrderController.java:26)
- POST /orders → OrderController.place → OrderService.place (and 1 helper: totalOf); refuses 3 ways (HTTP 400); 6 rules on the way; writes the database; returns Order (OrderController.java:21)

## What a change touches
- OrderService.cancel (changed): called by OrderController.cancel; on POST /orders/{id}/cancel; 1 rule; no test reaches it (OrderService.java:41)
- OrderService.place (changed): called by OrderController.place; on POST /orders; 5 rules; tested by OrderServiceTest.java (OrderService.java:22)

- … 3 more: singularity-flow wm brief --phase verification

Not known: calls are matched by name (no semantic pack is warmed); no runtime or incident data.
Read without a model from the committed source. Open the cited lines before relying on a detail.
