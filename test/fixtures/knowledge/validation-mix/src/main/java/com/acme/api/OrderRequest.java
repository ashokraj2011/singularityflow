package com.acme.api;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.List;

public class OrderRequest {
    @NotNull
    @Size(min = 1, max = 20, message = "An order has 1 to 20 lines")
    private List<String> lines;

    @DecimalMin("10.00")
    private BigDecimal total;

    @Email
    private String email;

    public List<String> getLines() { return lines; }
    public BigDecimal getTotal() { return total; }
}
