---
name: sflow-initiative-documents
description: Summarize initiative outputs and link their verified Markdown previews for human review outside chat.
disable-model-invocation: true
agent: agent
argument-hint: "[PHASE] [--initiative INIT-ID]"
---
# Show initiative documents

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (VS Code: Continue).
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID] --json`.
2. Give a brief supported summary and verified Markdown-preview link for each output; never reproduce bodies/code/diffs in chat. Use the host's Markdown preview when available, otherwise link the verified path without claiming it opened.
3. List output ID, kind, status, generation and byte count.
4. Summaries, links and opened previews do not establish human review. Approval separately requires the person's explicit review of complete exact-bound outputs; disclose unavailable/truncated material.
5. For binary bundles, show metadata and the absolute local path instead of attempting text rendering.

Keep this operation read-only.
