package com.acme.orders.controller;

import com.acme.orders.model.Order;
import com.acme.orders.service.OrderService;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
public class OrderController {
    private final OrderService service;

    public OrderController(OrderService service) {
        this.service = service;
    }

    @PostMapping
    public Order place(@RequestBody Order order) {
        return service.place(order);
    }

    @PostMapping("/{id}/cancel")
    public Order cancel(@PathVariable Long id) {
        return service.cancel(id);
    }
}
