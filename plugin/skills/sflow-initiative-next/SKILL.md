---
name: sflow-initiative-next
description: Show the deterministic next actions for the active multi-repository initiative in GitHub Copilot without changing lifecycle state.
disable-model-invocation: true
argument-hint: "[INIT-ID]"
---
# Show initiative next actions

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow initiative next [INIT-ID] --json`.
2. Present each returned action in order with its exact command and reason.
3. Call out missing output approvals, checklist evidence, stale contracts, incomplete blocking stories, and materialization work.
4. Keep this operation read-only. Do not execute an action unless the contributor explicitly asks.
