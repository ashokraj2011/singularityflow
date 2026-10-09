---
name: sflow-agent
description: Choose or inspect the governed Agent Markdown used for the current phase; agent selection never changes human identity or approval authority.
disable-model-invocation: true
argument-hint: "[WORK-ID]"

---

# Select the governed agent

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow agent <WORK-ID>`; omit the ID when the current branch already identifies it.
2. The phase default is automatic. Only ask the contributor when more than one compatible agent is available or they explicitly request a change.
3. When a picker is required, present every displayed label, ID, and description. Never infer human identity or approval authority from the agent.
4. Run `singularity-flow session status --json`, then report the agent, source hash, phase compatibility, work-item scope, and Copilot-session binding.
5. Agent Markdown controls prompt instructions and world-model views. Git/Jira identity and configured approval groups control human decisions.
