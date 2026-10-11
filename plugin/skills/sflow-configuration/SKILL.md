---
name: sflow-configuration
description: Inspect, validate, publish, or explicitly recreate and sync governed configuration without Git merge questions.
disable-model-invocation: true
argument-hint: "show|explain [--pointer <JSON-POINTER>]|validate|save <path>|publish|transactions|reconcile <CFT-ID>|recreate-sync [--apply]|cleanup-history [--keep-recent 10]"
---
# Manage governed configuration

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. For `show` or `explain`, run the exact requested read-only command and preserve any explicit
   `--pointer`; do not substitute validation or a write.
   `transactions` inspects the local non-authoritative recovery journal. For an explicitly requested
   `reconcile <CFT-ID>`, run `singularity-flow configuration reconcile <CFT-ID> --json` directly:
   the kernel re-observes shared authority and finishes only a verified transaction's reference sync.
   It never retries a push, accepts a proposal, or grants approval. Preserve `not-confirmed` or
   `sync-pending`; do not turn a prepared/cache record into an acceptance decision.
2. For `recreate-sync`, run the read-only preview unless the user explicitly requests recreation and sync. That request authorizes `singularity-flow configuration recreate-sync --apply --json` without follow-up merge or confirmation questions. The main-panel **Recreate & sync configuration** menu performs the same model-free operation. Preserve its backups and effects; never reset application code or Story history, and never apply merely because a proposal conflict was reported. The operation owns validation; do not add a pre-validation or another publication command.
3. For `cleanup-history`, run `singularity-flow configuration cleanup-history --json` (preserve an explicit `--keep-recent`). Show the exact candidates and retained reasons, then obtain human confirmation of that packet before using its returned apply command and hash. Do not delete refs manually, retry a stale hash, or prune tags. The Configuration menu has the same model-free preview/confirmation path. This archives only immutable history branch refs; it never accepts proposals or changes Stories.
4. For other writes, run `singularity-flow configuration validate --json` before proposing any write.
5. For save, require the exact reviewed source path. For publish, show the changed governed files, target configuration branch, commit message, and remote state.
6. Require an explicit mutation request, then run only the selected `singularity-flow configuration save` or `singularity-flow configuration publish` operation.
7. Report validation, commit, push, and active-work invalidation effects. Never edit lifecycle snapshots or publish directly to an application branch.

Report the exact `singularity-flow configuration ...` action on all three surfaces per the Output contract; preserve its operation and operands.
