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
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). Every turn that no SFlow note carries on ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow plugin list`, `singularity-flow plugin verify --json`, or `singularity-flow plugin path` before changing installation state. Verification owns Copilot-version compatibility: it prefers the current flat plugin inventory plus one flat skill inventory, and uses legacy bounded scoped inventories only when the plugin inventory explicitly reports that JSON is unsupported.
2. For install or uninstall, show the exact plugin identity and target path and require an explicit request.
3. Run only the requested `singularity-flow plugin install|uninstall|verify` command and relay discovery, byte-integrity, or restart guidance. Every verification requires exact enabled identities and skills and byte-checks direct aliases. The current path-bearing inventory also requires exact direct paths and packaged sources, and rejects missing, stale, symlinked, or non-regular packaged skill files.
4. Never remove personal skills, edit a governed repository, or substitute a full reinstall unless the user asks for that broader operation.
