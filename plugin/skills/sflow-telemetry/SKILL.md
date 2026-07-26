---
name: sflow-telemetry
description: Show and reconcile exact Copilot model, token, timing, and cost telemetry for the current workflow without estimating unavailable values.
---

# Inspect telemetry

1. Run `singularity-flow telemetry status --json`.
2. Show exporter state, raw trace availability, completed spans, pending generations, model-wise token totals, exact cost, and phase time.
3. If a completed generation is pending, ask before running `singularity-flow telemetry reconcile [PHASE] --json`; reconciliation commits and pushes the sanitized record.
4. Report `unavailable` when the provider omitted model, tokens, or cost. Never estimate.
