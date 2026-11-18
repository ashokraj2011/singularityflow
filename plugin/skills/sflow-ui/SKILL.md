---
name: sflow-ui
description: Inspect the independent SFlow browser workspace and show its native opening routes.
disable-model-invocation: true
agent: agent

---
# Open the browser workspace

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.


1. Run `singularity-flow ui status --json` once. This machine-local read needs no active Story. Report the actual running/stopped/draining state and any original error; do not select another checkout implicitly.
2. To open the workspace, direct the person to the native Shell command `singularity-flow ui open` or VS Code Command Palette **Singularity Flow: Open SFlow in browser**. There is no Copilot execution equivalent for opening it. Never open, serve or shut down the service from this turn, consume a bootstrap link, read native credentials, or claim a browser opened. The browser's person-view grant must not enter a model turn.
3. Explain the actual availability briefly: local browser Spec Studio supports draft creation, writing, save, checks and local sources. Other menus show their current read views or explicit native handoffs. Person-only signing and approvals remain with the existing native signer. Preparing the Copilot request in VS Code is delivery to the person, never proof of model execution.
4. On failure preserve the exact code, original message and recovery guidance. Do not delete discovery files, kill a PID, repeat a write, recreate a Story or change an installation. A Windows/remote qualification refusal leaves the existing CLI and VS Code surfaces available.
