---
name: sflow-initiative-checklist
description: Review an initiative phase checklist, evidence assurance, freshness, applicability decisions, and blocking gates in GitHub Copilot.
disable-model-invocation: true
argument-hint: "[PHASE] [--initiative INIT-ID]"
---
# Review an initiative checklist

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow initiative checklist [PHASE] [--initiative INIT-ID] --json`.
2. Show every checklist ID, requirement, gate mode, status, accepted assurance levels, current evidence hashes, expiration, and reason.
3. Clearly separate blocking errors from warnings and optional items.
4. For unmet checks, show an exact `singularity-flow initiative evidence add <CHECK-ID> ...` example without inventing evidence or assurance.
5. Use `singularity-flow initiative verify [PHASE]` only when the contributor asks for current verification.

Never turn file presence into higher assurance and never record a waiver or not-applicable decision without explicit user intent.
