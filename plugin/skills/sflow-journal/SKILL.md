---
name: sflow-journal
description: Review and manage the private machine-local My Work journal.
disable-model-invocation: true
agent: agent
argument-hint: "[today|refresh|settings|pause|resume|delete|export|doctor]"

---
# Local work journal

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

The journal is advisory return memory. It is never governance evidence, approval authority, a productivity score, or a remote source of truth.

1. With no requested action, run `singularity-flow journal today --json`. Explain that the result is stored locally and never pushed.
2. Use `singularity-flow journal refresh --json` only after the user asks to refresh local facts. It reads local Git state without fetching, pushing, or contacting a remote.
3. Use `singularity-flow journal settings --json` to inspect capture. Change mode, retention, or time zone only after showing the exact proposed settings and receiving explicit confirmation.
4. `singularity-flow journal pause` and `singularity-flow journal resume` change only future local capture. They do not alter governed work or delete history.
5. For day deletion, require the date twice: `singularity-flow journal delete --date YYYY-MM-DD --confirm YYYY-MM-DD --json`. For all history, require the exact phrase `DELETE LOCAL JOURNAL`.
6. Export only a reviewed summary, never raw events. The CLI refuses export inside a registered workspace so it cannot be staged accidentally.
7. Preserve refusals and diagnostics verbatim. Never describe locally observed remote-tracking refs as a live remote check.

Do not infer work duration, effort, attendance, or individual performance from journal records.
