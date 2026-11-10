---
name: sflow-scenario-repair
description: Repair the latest approved document-derived defect through the canonical code-generation and executable-test gate.
disable-model-invocation: true
agent: agent
argument-hint: "[approved scenario defect]"
---
# Repair a scenario defect

<!-- sflow-output-contract: canonical-delegation -->
**Output contract:** Run the canonical skill once and preserve its result and handoff; do not repeat its preflight, authoring, or publication. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.


Delegate once to `/sf-code` with the approved scenario defect and supplied focus. That canonical
skill owns pause/session resolution, verified task policy, open generation intent, current rework
request, scoped code/test changes, structured test evidence and exactly-once publication.

Preserve approved documents, expected behavior, tolerances and other people's edits. Do not turn a
failure into a pass by weakening assertions. Missing tools need the canonical skill's reviewed
configuration/recovery route. Retest belongs to `/sf-scenario-check`; an agent cannot grant human
acceptance or loop indefinitely. Stop when the canonical skill returns, preserving its evidence,
limitations and exact Copilot/Shell handoff. Do not repeat preflight, publish, submit or approve.
