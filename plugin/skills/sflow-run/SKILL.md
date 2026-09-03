---
name: sflow-run
description: Guide one Singularity Flow phase until the next human authoring or approval boundary without automatically approving.
disable-model-invocation: true
argument-hint: "[task focus]"

---
# Guided workflow execution

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

Run `singularity-flow nextsteps --json` first. Follow the lifecycle action marked `now`; never replace it with an optional `singularity-flow wm ensure ...` repair/build action. Run optional model construction only after separate explicit consent, and continue ordinary file-based work if it is declined or unavailable. Then run `singularity-flow run` without converting `$ARGUMENTS`, a Story title, or conversational prose into `--task`; lifecycle grounding uses the shared repository model. Treat optional arguments only as authoring emphasis after the governed prompt is composed. If the next action is submission, ask whether to submit and pass `--yes` only after that answer. Otherwise run without `--yes`. The command must stop at authoring and approval boundaries. Never choose a governed agent for the reviewer, approve, reject, bypass authority validation, or bypass confirmation. When it stops at authoring, complete only the active phase contract, then use `/sf-phase` to publish and display every generated artifact.
