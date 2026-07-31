---
name: sflow-ledger
description: Inspect, initialize, verify, and reconcile the opt-in Singularity Flow capability ledger without inventing lifecycle state.
---

# Singularity Flow capability ledger

Use the deterministic CLI. Do not edit ledger entries, head files, idempotency
indexes, or durable intents by hand.

1. Run `singularity-flow ledger status --json`.
2. If disabled, explain that `ledger.enabled: true` must be reviewed; do not enable it silently.
3. If enabled but uninitialized, offer `singularity-flow ledger init`.
4. Run `singularity-flow ledger doctor` to check orphan ancestry, pin transport,
   signing readiness, and the clone's custom-ref fetch configuration.
5. Run `singularity-flow ledger verify` for integrity and source-pin reachability.
6. Use `singularity-flow ledger archive --out <FILE>` only when the user asks for
   an export. Explain that the bundle is verified and does not delete retained state.
6. Run `singularity-flow ledger reconcile [WORK-ID]` for pending durable intents.
7. Report the exact branch, sequence, head hash, pending count, and errors.

Never describe a warning-only or unverifiable ledger as fully enforced. Never merge
the ledger branch into `main`, use `--allow-unrelated-histories`, or force-push it.
