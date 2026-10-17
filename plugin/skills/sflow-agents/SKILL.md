---
name: sflow-agents
description: Inspect governed Agent Markdown, mappings, and hash-pinned remote Markdown dependencies; agents are instructions, never human approval authorities.
disable-model-invocation: true

---

# Manage governed agents

<!-- sflow-copilot-pause -->
Read-only utility: run the requested read once with `--utility-entry --for-agent --json` (default `singularity-flow agents list --utility-entry --for-agent --json`). Keep explicit Work IDs/filters; do not replace requested edits with a list. Eligible forms: status, progress, nextsteps, logs, agents list/mappings/status, workflow list, skill/instruction list/show without retained selectors. It checks pause before Git and returns verified `repositoryPath` plus `data`; no separate pause/session/workspace lookup or STATUS.md read. If paused, native Copilot; only offer `/sf-pause off`, never resume implicitly. Other forms: Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. Reads never authorize mutations; preserve later gates. If unsupported, stop with the compatibility error, never retry blindly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

- Discover: `singularity-flow agents list`.
- Inspect Copilot-agent routing: `singularity-flow agents mappings`.
- Inspect: `singularity-flow agents status [AGENT]`.
- First trust: `singularity-flow agents lock <AGENT>`.
- Review an update: `singularity-flow agents lock <AGENT> --update`.
- Materialize locked content: `singularity-flow agents sync <AGENT>`.
- Refresh generated Markdown: `singularity-flow agents refresh-output <RESOURCE-ID> [--replace]`.

First trust and updates require exact agent-name confirmation. Never edit `singularity/agents.lock.yml` manually, bypass a changed hash, send credentials, or overwrite local output unless the user explicitly requests `--replace`.

An agent combines its own instructions and world-model view declarations with optional remote Markdown dependencies. It cannot act as a human or approve/reject lifecycle state.

Copilot custom-agent IDs may map to different governed-agent IDs in `singularity/agent-mappings.yml`. Explicit mappings win; omitted agents use same-name fallback.
