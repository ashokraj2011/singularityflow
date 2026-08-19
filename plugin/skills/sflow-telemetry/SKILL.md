---
name: sflow-telemetry
description: Inspect, enable, disable, and reconcile privacy-safe local Copilot usage for SFlow-owned launches without estimating unavailable values.
disable-model-invocation: true

---

# Inspect telemetry

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

1. Run `singularity-flow telemetry status --json`.
2. Show the qualified state (`captured`, `partial`, `unavailable`, `conflict`, or `disabled`), SFlow-owned launch counts, capability mode, and pending generations. Do not expose host paths or raw event content.
3. If disclosure is required, explain that `/sf-telemetry` cannot accept it on the contributor's behalf. Ask before running `singularity-flow telemetry enable --confirm "ENABLE LOCAL USAGE" --json`; quote the metadata-only disclosure first.
4. If a completed generation is pending, ask before running `singularity-flow telemetry reconcile [PHASE] --json`; reconciliation commits and pushes only the sanitized record.
5. Run `singularity-flow telemetry disable --json` only when explicitly requested. Disabling changes future local capture only and never governs work.
6. Report `unavailable` when the provider omitted model, tokens, or cost. Never estimate, and never treat native IDE chat as captured by an adjacent CLI launch.
