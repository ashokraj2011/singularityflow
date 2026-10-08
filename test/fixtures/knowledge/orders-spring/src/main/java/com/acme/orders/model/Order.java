package com.acme.orders.model;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import java.math.BigDecimal;
import java.util.List;

@Entity
public class Order {
    @Id
    private Long id;
    private String customerId;
    private List<OrderLine> lines;
    private BigDecimal total;
    private OrderStatus status;
    private boolean vip;

    public Long getId() { return id; }
    public List<OrderLine> getLines() { return lines; }
    public BigDecimal getTotal() { return total; }
    public void setTotal(BigDecimal total) { this.total = total; }
    public OrderStatus getStatus() { return status; }
    public void setStatus(OrderStatus status) { this.status = status; }
    public boolean isVip() { return vip; }
}
