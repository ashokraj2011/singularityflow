---
name: sflow-ledger
description: Inspect, initialize, verify, and reconcile the opt-in Singularity Flow capability ledger without inventing lifecycle state.
disable-model-invocation: true

---

# Singularity Flow capability ledger

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Use the deterministic CLI. Do not edit ledger entries, head files, idempotency
indexes, or durable intents by hand.

1. Run `singularity-flow ledger status --json`.
2. If disabled, explain that `ledger.enabled: true` must be reviewed; do not enable it silently.
3. If enabled but uninitialized, offer `singularity-flow ledger init`.
4. Only when status returns `enabled` and `initialized`: run `singularity-flow ledger doctor` to check orphan ancestry, pin transport,
   signing readiness, and the clone's custom-ref fetch configuration.
5. Reuse status `verification`; run `singularity-flow ledger verify` only for source-pin reachability.
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
9. Only when status reports pending intents, run `singularity-flow ledger reconcile [WORK-ID]`.
10. Report the exact branch, sequence, head hash, pending count, and errors.

Never describe a warning-only or unverifiable ledger as fully enforced. Never merge
the ledger branch into `main`, use `--allow-unrelated-histories`, force-push a pin, or
replace a mismatched remote pin. Changing `pinTransport` affects future entries; it
does not repair or erase refs already recorded in the chain.
