---
name: sflow-epic-planning
description: Compatibility entry point for the canonical sflow-epic-story-draft workflow that creates governed Story plans and specifications.
disable-model-invocation: true
agent: agent

---

# Plan governed Stories

<!-- sflow-output-contract: canonical-delegation -->
**Output contract:** Run the canonical skill once and preserve its result and handoff; do not repeat its preflight, authoring, or publication. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Run `/sf-epic-story-draft` once with the supplied arguments and stop when it returns. That canonical skill owns repository resolution, preparation, authoring, publication, validation, and the business-review handoff. Preserve its result unchanged. Do not run a second planning sequence, approve Planning yourself (the reviewer approves in the UI or with `/sf-initiative-approve <EPIC-ID> phase`), or publish Jira/Git Stories.
