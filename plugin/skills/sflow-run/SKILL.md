---
name: sflow-run
description: Guide one Singularity Flow phase until the next human authoring or approval boundary without automatically approving.
disable-model-invocation: true
argument-hint: "[task focus]"

---
# Guided workflow execution

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.

Run `singularity-flow nextsteps --json` first. If it names `singularity-flow wm build`, explain that semantic generation starts a repository-reading, file-writing Copilot agent and ask the contributor for explicit consent; only an affirmative answer permits `singularity-flow run --yes --task "$ARGUMENTS"`. If the next action is submission, ask whether to submit and pass `--yes` only after that answer. Otherwise run `singularity-flow run --task "$ARGUMENTS"` without `--yes`. The command must stop at authoring and approval boundaries. Never choose a governed agent for the reviewer, approve, reject, bypass authority validation, or bypass confirmation. When it stops at authoring, complete only the active phase contract, then use `/sf-phase` to publish and display every generated artifact.
