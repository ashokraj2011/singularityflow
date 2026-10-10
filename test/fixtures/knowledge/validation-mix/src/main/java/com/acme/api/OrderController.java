package com.acme.api;

import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
    @PostMapping("/orders")
    public String create(@Valid @RequestBody OrderRequest request) {
        return "created";
    }

    @PostMapping("/refunds")
    public String refund(@RequestBody Refund refund) {
        return "refunded";
    }
}
