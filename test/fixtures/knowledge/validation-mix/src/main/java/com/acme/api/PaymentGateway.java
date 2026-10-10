package com.acme.api;

import java.math.BigDecimal;

public interface PaymentGateway {
    String charge(String customer, BigDecimal amount);
}
