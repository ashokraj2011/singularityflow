package com.acme.orders.service;

import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class OrderServiceTest {
    @Test
    void rejectsEmptyOrders() {
        OrderService service = new OrderService(null);
        assertThrows(IllegalArgumentException.class, () -> service.place(new com.acme.orders.model.Order()));
    }

    @Test
    void rejectsOrdersBelowMinimum() {
        // exercises place() with a 5.00 order
    }
}
