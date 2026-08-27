---
name: sflow-watch
description: Watch a governed work item for remote lifecycle changes without modifying its branch or state.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--once]"
---
# Watch governed work

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Prefer `singularity-flow watch $ARGUMENTS --once --fetch` for one bounded refresh.
2. Start continuous watching only when the user explicitly asks for it and preserve the requested interval.
3. Relay remote phase, approval, publication, and completion changes without inventing progress.
4. Watching is read-only. Do not check out, reset, merge, approve, or repair a branch.

