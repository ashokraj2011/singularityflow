---
name: sflow-run
description: Guide one Singularity Flow phase until the next human authoring or approval boundary without automatically approving.
disable-model-invocation: true
argument-hint: "[task focus]"

---
# Guided workflow execution

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

Run `singularity-flow nextsteps --json` first. Follow the lifecycle action marked `now`; never replace it with optional `singularity-flow wm ensure ...` work, which needs separate consent. Missing world-model intelligence does not block ordinary file-based work. Run `singularity-flow run` without deriving `--task` from arguments or Story prose. Arguments are authoring emphasis only. If the next action is submission, ask whether to submit and pass `--yes` only after that answer; otherwise omit it.

At the authoring boundary, load the exact returned canonical `/sf-*` skill once and let it own preparation, authoring, checks, publication, and display. Pass any prepared prompt/path as context; do not complete authoring before delegation or invoke `/sf-phase` afterward. If the returned result already published or submitted, report it and stop. Preserve the canonical result and next-action pair; never publish a delegated action again. Stop at human approval. Never select the reviewer's agent, approve, reject, or bypass authority or confirmation.
