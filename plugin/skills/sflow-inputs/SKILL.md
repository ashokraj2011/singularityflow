---
name: sflow-inputs
description: Inspect and render the approved phase-artifact inputs configured for the active Singularity Flow phase.
disable-model-invocation: true
argument-hint: "[phase]"

---
# Inspect phase inputs

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `--dry-run` only for read-only inspection and never edit managed input records to bypass a gate.

1. Run `singularity-flow status --json` and use only the active phase.
2. Preview resolution with `singularity-flow inputs <phase> --dry-run`.
3. Explain every missing, unapproved, truncated, hash-mismatched, missing-brief, stale-brief, or
   missing-expansion condition before continuing. When the record reports `approved-summary`, name
   the brief hash and source-bound expansion handle. Expand an exact source section only when the
   task requires its wording; never replace the governed brief by an agent-authored summary.
4. Run `singularity-flow inputs <phase>` to write the next-generation audit record and render the managed input block.
5. Read the returned artifact and preserve the marker-delimited managed block.
6. Do not submit, approve, or reject automatically.
