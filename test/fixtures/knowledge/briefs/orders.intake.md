# Repository brief: orders at ac91860bb887 (for intake, focused on this Story)

## What exists
- orders: 10 code files in java (10 files); JPA, Spring Boot; 3 entry points, 7 rules in code, 2 tests. (commit ac91860bb887)
- Takes customer orders, checks them and stores them. (README.md › Orders Service)
- test: `mvn test` (Maven Surefire) (pom.xml:1)

## Rules that apply
- OrderService.cancel: when `order.getStatus() != OrderStatus.PLACED` → refuses "Only placed orders can be cancelled" (HTTP 409). Documented, enforced, no test reaches it. (OrderService.java:43; README.md › Business rules)
- 409 — the order cannot be cancelled in its state. Documented, enforced. (OrderService.java:44; README.md › Error responses)
- OrderService.place: when `order.isVip()` → does `total = total.subtract(total.multiply(VIP_DISCOUNT_RATE))`. Documented, enforced, tested. (OrderService.java:33; README.md › Business rules)
- 400 — the order is invalid. Documented, enforced. (OrderService.java:24; README.md › Error responses)

## Contracts
- enum OrderStatus: PLACED, PAID, SHIPPED, CANCELLED (OrderStatus.java:3)
- POST /orders takes Order {id: Long; customerId: String; lines: List<OrderLine>; total: BigDecimal; status: OrderStatus; vip: boolean} and returns it; refuses with 400 (3 checks); tested (OrderController.java:21)
- POST /orders/{id}/cancel takes path id and returns Order; refuses with 409 (1 check); no test reaches it (OrderController.java:26)
- class Order {id: Long; customerId: String; lines: List<OrderLine>; total: BigDecimal; status: OrderStatus; vip: boolean} (Order.java:9)
- OrderRepository stores Order (id Long) (OrderRepository.java:6)
- Configuration orders.max-items = 20 (application.properties:1)
- Configuration orders.payment.base-url = https://payments.internal.example (application.properties:2)

- … 6 more: singularity-flow wm brief --phase intake

Read without a model from the committed source. Open the cited lines before relying on a detail.
