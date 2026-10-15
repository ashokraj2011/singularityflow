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
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. A command's JSON is complete even when long: if your tool saved it to a file, read that file to its end before acting; never treat a saved or long result as truncated or stop because of its size.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

Run `singularity-flow nextsteps --json` first. Follow the lifecycle action marked `now`. The Repository brief is guidance and never blocks file-based work. Run `singularity-flow run` without deriving `--task` from arguments or Story prose. Arguments are authoring emphasis only. If the next action is submission, ask whether to submit and pass `--yes` only after that answer; otherwise omit it.

At the authoring boundary, load the exact returned canonical `/sf-*` skill once and let it own preparation, authoring, checks, publication, and display. Pass any prepared prompt/path as context; do not complete authoring before delegation or invoke `/sf-phase` afterward. If the returned result already published or submitted, report it and stop. Preserve the canonical result and next-action pair; never publish a delegated action again. Stop at human approval. Never select the reviewer's agent, approve, reject, or bypass authority or confirmation.
