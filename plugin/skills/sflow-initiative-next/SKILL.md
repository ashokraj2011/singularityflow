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
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow initiative next [INIT-ID] --json`.
2. Present each returned action in order with its exact command and reason.
3. Call out missing output approvals, checklist evidence, stale contracts, incomplete blocking stories, and materialization work.
4. Keep this operation read-only. Do not execute an action unless the contributor explicitly asks.
