---
name: sflow-constitution
description: Inspect, deterministically generate, or explicitly record a governed constitution exception.
disable-model-invocation: true
argument-hint: "check|show|generate|except"
---
# Manage the constitution

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Use `singularity-flow constitution check --json` or `show --json` for read-only inspection.
2. Preview generation with `singularity-flow constitution generate --dry-run`; do not replace a customised file without an explicit reviewed request.
3. For an exception, require the exact article ID, reason, scope, expiry, and Work ID as applicable. Show that an exception is an auditable waiver, not approval.
4. Run only the requested mutation and preserve output path, hash, actor, scope, expiry, commit, and push result.

