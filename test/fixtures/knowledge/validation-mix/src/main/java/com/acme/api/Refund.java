package com.acme.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;

public record Refund(@NotBlank String reason, @Positive BigDecimal amount) {}
