---
name: sflow-telemetry
description: Show and reconcile exact Copilot model, token, timing, and cost telemetry for the current workflow without estimating unavailable values.
disable-model-invocation: true

---

# Inspect telemetry

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

1. Run `singularity-flow telemetry status --json`.
2. Show exporter state, raw trace availability, completed spans, pending generations, model-wise token totals, exact cost, and phase time.
3. If a completed generation is pending, ask before running `singularity-flow telemetry reconcile [PHASE] --json`; reconciliation commits and pushes the sanitized record.
4. Report `unavailable` when the provider omitted model, tokens, or cost. Never estimate.
