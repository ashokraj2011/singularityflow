---
name: sflow-nextsteps
description: Show ordered next actions from the current workflow state.
disable-model-invocation: true

---
# Show next actions

<!-- sflow-copilot-pause -->
Read-only utility: run the requested read once with `--utility-entry --for-agent --json` (default `singularity-flow nextsteps --utility-entry --for-agent --json`). Keep explicit Work IDs/filters; do not replace requested edits with a list. Eligible forms: status, progress, nextsteps, logs, agents list/mappings/status, workflow list, skill/instruction list/show without retained selectors. It checks pause before Git and returns verified `repositoryPath` plus `data`; no separate pause/session/workspace lookup or STATUS.md read. If paused, native Copilot; only offer `/sf-pause off`, never resume implicitly. Other forms: Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. Reads never authorize mutations; preserve later gates. If unsupported, stop with the compatibility error, never retry blindly.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. In the Boundary repository run `singularity-flow nextsteps <WORK-ID> --utility-entry --for-agent --json` when the user supplied an ID; otherwise omit the ID. Read the returned `data`. A ready Story session is not required for repository initialization, start, resume, or explicit-ID guidance.
2. Read `contextBoundary` before listing actions. If this chat already worked on an earlier phase, show its ordered `commandGuidance.copilotCommand` (`/clear`, then `/sf-next`, or `/compact`, then `/sf-next`) and stop; authoring is after that boundary, not NOW in this chat. No Shell or model-free equivalent exists for a chat reset. A fresh chat continues without another reset. Present returned actions in order, preserving labels, routes and reasons.
3. List only the returned actions, in their order (initialization, start or resume, `singularity-flow sync`, then the step's own); never add one the CLI did not return.
4. Keep this operation read-only. Do not execute any returned action unless the user separately asks to perform it.
5. If the user wants the first valid action executed, point them to the explicitly mutating `/sf-next` command.
