package com.acme.orders.model;

import java.math.BigDecimal;

public record OrderLine(String sku, int quantity, BigDecimal unitPrice) {
}
