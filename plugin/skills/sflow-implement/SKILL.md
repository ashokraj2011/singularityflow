---
name: sflow-implement
description: Friendly alias for the canonical task-based Singularity Flow code-generation contract.
disable-model-invocation: true
agent: agent
argument-hint: "[implementation focus]"

---
# Implementation alias

<!-- sflow-output-contract: canonical-delegation -->
**Output contract:** Run the canonical skill once and preserve its result and handoff; do not repeat its preflight, authoring, or publication. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.


Run `/sflow-code` once with the supplied focus and stop when it returns. The canonical skill owns Story resolution, authoring, test evidence, publication, and the next action. Preserve its final result and Copilot/Shell handoff unchanged; this alias must not publish, submit, or approve again or suggest restarting code generation.
