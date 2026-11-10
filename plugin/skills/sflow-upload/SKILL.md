---
name: sflow-upload
description: Attach, inspect, list, or governably detach files, folders, images, PDFs, Figma exports, notes, and HTTPS references for an Epic or Story.
disable-model-invocation: true
agent: agent
argument-hint: "attach <PATH...> [--epic EPIC-ID] | list [OWNER-ID] | view <ID|NAME> [--work-id WORK-ID] | detach <ID|NAME> --reason TEXT [--epic EPIC-ID]"

---

# Upload governed evidence

<!-- sflow-output-contract: canonical-delegation -->
**Output contract:** Run the canonical skill once and preserve its result and handoff; do not repeat its preflight, authoring, or publication. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

REV feedback: use `/sf-revision-attachments`; ordinary upload cannot bypass its importer.

Delegate once to `/sf-documents`: load it and do its steps in this turn yourself, never through a sub-agent, mapping `attach` to `upload` and preserving paths, names, owner selectors, and the requested list/view/detach action. That canonical skill owns context resolution, choices, preview, confirmation, mutation, and reporting. Stop when it returns; preserve its result and next action. Do not repeat a preview, ask again for a choice already accepted by the canonical skill, or run a second upload/detach command.
