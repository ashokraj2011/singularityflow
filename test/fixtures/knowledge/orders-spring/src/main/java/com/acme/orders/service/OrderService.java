package com.acme.orders.service;

import com.acme.orders.model.Order;
import com.acme.orders.model.OrderLine;
import com.acme.orders.model.OrderStatus;
import com.acme.orders.repository.OrderRepository;
import java.math.BigDecimal;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
    public static final BigDecimal MINIMUM_ORDER_TOTAL = new BigDecimal("10.00");
    public static final int MAX_ITEMS = 20;
    public static final BigDecimal VIP_DISCOUNT_RATE = new BigDecimal("0.05");

    private final OrderRepository repository;

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    public Order place(Order order) {
        if (order.getLines().isEmpty()) {
            throw new IllegalArgumentException("An order needs at least one line");
        }
        if (order.getLines().size() > MAX_ITEMS) {
            throw new IllegalArgumentException("An order can have at most 20 lines");
        }
        BigDecimal total = totalOf(order);
        if (total.compareTo(MINIMUM_ORDER_TOTAL) < 0) {
            throw new IllegalArgumentException("Orders under 10.00 are not accepted");
        }
        if (order.isVip()) {
            total = total.subtract(total.multiply(VIP_DISCOUNT_RATE));
        }
        order.setTotal(total);
        order.setStatus(OrderStatus.PLACED);
        return repository.save(order);
    }

    public Order cancel(Long id) {
        Order order = repository.findById(id).orElseThrow(() -> new OrderNotFoundException(id));
        if (order.getStatus() != OrderStatus.PLACED) {
            throw new IllegalStateException("Only placed orders can be cancelled");
        }
        order.setStatus(OrderStatus.CANCELLED);
        return repository.save(order);
    }

    BigDecimal totalOf(Order order) {
        BigDecimal total = BigDecimal.ZERO;
        for (OrderLine line : order.getLines()) {
            total = total.add(line.unitPrice().multiply(BigDecimal.valueOf(line.quantity())));
        }
        return total;
    }
}
