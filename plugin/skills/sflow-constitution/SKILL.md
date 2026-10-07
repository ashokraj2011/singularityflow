---
name: sflow-constitution
description: Inspect, deterministically generate, or explicitly record a governed constitution exception.
disable-model-invocation: true
argument-hint: "check|show|generate|except"
---
# Manage the constitution

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Use `singularity-flow constitution check --json` or `singularity-flow constitution show --json` for read-only inspection.
2. Preview generation with `singularity-flow constitution generate --dry-run`; do not replace a customised file without an explicit reviewed request.
3. For an exception, require the exact article ID, reason, scope, expiry, and Work ID as applicable. Show that an exception is an auditable waiver, not approval.
4. Run only the requested mutation and preserve output path, hash, actor, scope, expiry, commit, and push result.
