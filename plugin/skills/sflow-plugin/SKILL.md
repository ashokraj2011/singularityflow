---
name: sflow-plugin
description: Inspect, verify, install, or uninstall the packaged Singularity Flow Copilot plugin without touching governed repositories.
disable-model-invocation: true
agent: agent
argument-hint: "list|verify [--json]|path|install|uninstall"
---
# Manage the Copilot plugin

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow plugin list`, `singularity-flow plugin verify --json`, or `singularity-flow plugin path` before changing installation state. Verification owns Copilot-version compatibility: it prefers the current flat plugin inventory plus one flat skill inventory, and uses legacy bounded scoped inventories only when the plugin inventory explicitly reports that JSON is unsupported.
2. For install or uninstall, show the exact plugin identity and target path and require an explicit request.
3. Run only the requested `singularity-flow plugin install|uninstall|verify` command and relay discovery, byte-integrity, or restart guidance. Every verification requires exact enabled identities and skills and byte-checks direct aliases. The current path-bearing inventory also requires exact direct paths and packaged sources, and rejects missing, stale, symlinked, or non-regular packaged skill files.
4. Never remove personal skills, edit a governed repository, or substitute a full reinstall unless the user asks for that broader operation.
