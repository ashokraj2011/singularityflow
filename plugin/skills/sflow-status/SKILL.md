---
name: sflow-status
description: Show the current phase, artifacts, checks, and approvals.
disable-model-invocation: true
argument-hint: "[WORK-ID]"

---
# Show Singularity Flow status

<!-- sflow-copilot-pause -->
Read-only utility: run the requested read once with `--utility-entry --for-agent --json` (default `singularity-flow status --utility-entry --for-agent --json`). Keep explicit Work IDs/filters; do not replace requested edits with a list. Eligible forms: status, progress, nextsteps, logs, agents list/mappings/status, workflow list, skill/instruction list/show without retained selectors. It checks pause before Git and returns verified `repositoryPath` plus `data`; no separate pause/session/workspace lookup or STATUS.md read. If paused, native Copilot; only offer `/sf-pause off`, never resume implicitly. Other forms: Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. Reads never authorize mutations; preserve later gates. If unsupported, stop with the compatibility error, never retry blindly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Run `singularity-flow status --utility-entry --for-agent --json` with the supplied work ID, if any. Use only returned `data` to report the branch, immutable work type, current phase, suggested governed agents, generation, artifacts, token usage, human approval authority groups, threshold, self-approval warnings, publication state, and next valid action. Unavailable fields stay unavailable. Do not read STATUS.md, change files or lifecycle state.
