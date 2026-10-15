---
name: sflow-agent
description: Choose or inspect the governed Agent Markdown used for the current phase; agent selection never changes human identity or approval authority.
disable-model-invocation: true
argument-hint: "[WORK-ID]"

---

# Select the governed agent

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. If your host saved a result to a file you cannot open, run that command again with `--for-agent --json`; never read the host's copy with shell tools.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Run `singularity-flow agent <WORK-ID>` with the entry's `workId`; add `--agent <ID>` only for a change the contributor asked for.
2. The phase default is automatic. A `SELECTION_REQUIRED` refusal lists `details.choices`: present every label, ID and description, then rerun with `--agent <ID>`.
3. Never pick for the contributor. Never infer human identity or approval authority from the agent.
4. Run `singularity-flow session status --json`, then report the agent, source hash, phase compatibility, work-item scope, and Copilot-session binding.
5. Agent Markdown controls prompt instructions and world-model views. Git/Jira identity and configured approval groups control human decisions.
