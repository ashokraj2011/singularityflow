---
name: sflow-harness
description: Inspect the deterministic reference-expansion harness report without changing governed state.
disable-model-invocation: true

---
# Inspect the reference harness

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow harness report --json`.
2. Preserve every reported checker, fixture, failure, and bounded-reference result.
3. If a reference needs expansion, offer `/sf-show`; do not accept an arbitrary repository path.
4. Do not repair fixtures, rewrite reference records, or mutate workflow state.

