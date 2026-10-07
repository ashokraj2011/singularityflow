---
name: sflow-ledger
description: Inspect, initialize, verify, and reconcile the opt-in Singularity Flow capability ledger without inventing lifecycle state.
disable-model-invocation: true

---

# Singularity Flow capability ledger

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Use the deterministic CLI. Do not edit ledger entries, head files, idempotency
indexes, or durable intents by hand.

1. Run `singularity-flow ledger status --json`.
2. If disabled, explain that `ledger.enabled: true` must be reviewed; do not enable it silently.
3. If enabled but uninitialized, offer `singularity-flow ledger init`.
4. Run `singularity-flow ledger doctor` to check orphan ancestry, pin transport,
   signing readiness, and the clone's custom-ref fetch configuration.
5. Run `singularity-flow ledger verify` for integrity and source-pin reachability.
6. If a pin is unreachable, run `singularity-flow ledger repair --dry-run --json`.
   Preserve its distinction between a missing ref, a mismatched ref, an unavailable
   remote, disabled networking, and an incomplete local cache. Safe local healing may
   be applied with `singularity-flow ledger repair [--source-remote <CONFIGURED-REMOTE>]`.
7. Never restore a remote pin on the user's behalf. If the preview proves the exact
   recorded commit and offers restoration, show every destination ref and ask the user
   to confirm the complete `RESTORE LEDGER PINS <PLAN-SHA256>` phrase. Only then run
   `singularity-flow ledger repair --restore-remote [--source-remote <REMOTE>] --confirm "<EXACT-PHRASE>" --json`.
8. Use `singularity-flow ledger archive --out <FILE>` only when the user asks for
   an export. Explain that the bundle is verified and does not delete retained state.
9. Run `singularity-flow ledger reconcile [WORK-ID]` for pending durable intents.
10. Report the exact branch, sequence, head hash, pending count, and errors.

Never describe a warning-only or unverifiable ledger as fully enforced. Never merge
the ledger branch into `main`, use `--allow-unrelated-histories`, force-push a pin, or
replace a mismatched remote pin. Changing `pinTransport` affects future entries; it
does not repair or erase refs already recorded in the chain.
