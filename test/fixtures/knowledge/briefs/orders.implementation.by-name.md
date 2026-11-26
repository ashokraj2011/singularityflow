# Repository brief: orders at ac91860bb887 (for implementation, focused on this Story)

## What a change touches
- OrderService.cancel (changed): 1 rule (OrderService.java:41)
- OrderService.place (changed): 5 rules (OrderService.java:22)

## Rules that apply
- OrderService.cancel: when `order.getStatus() != OrderStatus.PLACED` → refuses "Only placed orders can be cancelled" (HTTP 409). Documented, enforced. (OrderService.java:43; README.md › Business rules)
- 409 — the order cannot be cancelled in its state. Documented, enforced. (OrderService.java:44; README.md › Error responses)
- OrderService.place: when `order.isVip()` → does `total = total.subtract(total.multiply(VIP_DISCOUNT_RATE))`. Documented, enforced, tested. (OrderService.java:33; README.md › Business rules)
- OrderService.place: when `order.getLines().isEmpty()` → refuses "An order needs at least one line" (HTTP 400). Documented, enforced, tested. (OrderService.java:23; README.md › Business rules)

## Contracts
- enum OrderStatus: PLACED, PAID, SHIPPED, CANCELLED (OrderStatus.java:3)
- POST /orders takes Order {id: Long; customerId: String; lines: List<OrderLine>; total: BigDecimal; status: OrderStatus; vip: boolean} and returns it; refuses with 400 (3 checks) (OrderController.java:21)
- POST /orders/{id}/cancel takes path id and returns Order; refuses with 409 (1 check) (OrderController.java:26)
- class Order {id: Long; customerId: String; lines: List<OrderLine>; total: BigDecimal; status: OrderStatus; vip: boolean} (Order.java:9)
- OrderRepository stores Order (id Long) (OrderRepository.java:6)
- Configuration orders.max-items = 20 (application.properties:1)
- Configuration orders.payment.base-url = https://payments.internal.example (application.properties:2)
- program start → OrdersApplication.main (OrdersApplication.java:8)

## Risks
- (changed by this Story) OrderService.place: 5 rules (OrderService.java:22)

- … 5 more: singularity-flow wm brief --phase implementation

Not known: calls are matched by name (no semantic pack is warmed), so who calls what and which tests reach it are left out; no runtime or incident data.
Read without a model from the committed source. Open the cited lines before relying on a detail.
