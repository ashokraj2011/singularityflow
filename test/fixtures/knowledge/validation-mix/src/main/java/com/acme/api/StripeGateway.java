package com.acme.api;

import java.math.BigDecimal;

public class StripeGateway implements PaymentGateway {
    @Override
    public String charge(String customer, BigDecimal amount) {
        return "charged";
    }
}
