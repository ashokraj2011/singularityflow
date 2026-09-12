---
name: sflow-architecture
description: Show, validate, explain, compare, export, or manage a Story-owned architecture intent for the deterministic FINOS CALM projection.
disable-model-invocation: true
argument-hint: "show|explain <ELEMENT-ID>|sources <ELEMENT-ID>|validate|doctor|export --out <FILE>|intent init|revise|verify --work-id <ID>"
---
# Inspect generated architecture

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect required choices explicitly; never infer; preserve errors and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow workspace current --json`; use verified `repositoryPath` as cwd.
2. For a base overview run `singularity-flow architecture show`. For one element run `architecture explain <ELEMENT-ID>` or `architecture sources <ELEMENT-ID>`.
3. Use `--work-id <ID> --planned` only for an explicitly requested approved Story overlay.
4. Use `architecture validate` or `architecture doctor` for read-only diagnosis.
5. Export only to an explicitly supplied repository-relative destination. Run `singularity-flow architecture export --format calm --out <FILE>` as preflight, show destination, digest and effects, then ask for confirmation. Only then rerun with its `--confirm <SHA256>`.
6. When the user explicitly asks to create an architecture intent, require an exact Work ID and repository-relative candidate file, show the exact mutation, then run `singularity-flow architecture intent init --work-id <ID> --from <FILE>`. The candidate must name the active owner phase and may omit `generation`; omission means the owner's next publication (`P+1`). Report whether the draft was created or already identical. Do not hand-edit the managed intent.
7. When the user explicitly asks to revise an existing intent, first show its current digest, require the exact `--expect-intent sha256:<DIGEST>` value and a repository-relative candidate file, then run `singularity-flow architecture intent revise --work-id <ID> --from <FILE> --expect-intent sha256:<DIGEST>`. Revision is a compare-and-swap under the Story lock and cannot change the owner phase or generation. On conflict, re-read and ask the user to review the newer intent; never retry with a substituted digest.
8. For an explicit intent-verification request, run `singularity-flow architecture intent verify --work-id <ID>`. If exact source comparison refuses a dirty worktree, stop without capturing anything. Only when the user already supplied the exact reviewed reference returned by `wm snapshot`, append `--candidate-snapshot sha256:<DIGEST>`; an older Candidate that does not still match current source is never substituted or retried.
9. Init/revise creates only an unapproved draft. Governed order is owner-phase publish, submit, approve; enforcement consumes only that publication-bound approval.
10. Never edit `singularity/world-model/projections/arch.calm.json`, its source map, a planned projection, a managed architecture intent, or a receipt. Direct the user to the exact source returned by `architecture explain`.
11. Never call a model, approve an intent, publish or submit a Story phase, or execute a returned lifecycle action.
