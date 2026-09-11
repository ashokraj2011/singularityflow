---
name: sflow-architecture
description: Show, validate, explain, compare, or export the deterministic FINOS CALM architecture projection for the selected Singularity Flow repository.
disable-model-invocation: true
argument-hint: "show|explain <ELEMENT-ID>|sources <ELEMENT-ID>|validate|doctor|export --out <FILE>"
---
# Inspect generated architecture

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Resolve the selected repository with `singularity-flow workspace current --json` and use its verified `repositoryPath` as cwd.
2. For a base overview run `singularity-flow architecture show`. For one element run `architecture explain <ELEMENT-ID>` or `architecture sources <ELEMENT-ID>`.
3. Use `--work-id <ID> --planned` only when the user explicitly asks for a Story's approved planned overlay.
4. Use `architecture validate` or `architecture doctor` for read-only diagnosis.
5. Export only when the user explicitly supplies a repository-relative destination: `singularity-flow architecture export --format calm --out <FILE>`.
6. Never edit `singularity/world-model/projections/arch.calm.json`, its source map, a planned projection, or a receipt. Direct the user to the exact source returned by `architecture explain`.
7. Never call a model, approve an intent, publish a Story phase, or execute a returned lifecycle action.
