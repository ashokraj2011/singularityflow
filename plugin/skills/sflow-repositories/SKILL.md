---
name: sflow-repositories
description: List or search repositories already known to SFlow, and guide an explicit GitHub provider search without cloning or mapping anything.
disable-model-invocation: true
agent: agent
argument-hint: "[QUERY] [--provider github --host HOST]"
---
# Find repositories

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow repositories providers --json`. This is local and does not check authentication.
2. Unless the user explicitly supplied a provider and host, run `singularity-flow repositories list --scope known --audience model --surface copilot --limit 10 --json`. If a query was supplied, run `singularity-flow repositories search <QUERY>` with those same bounds. Do not run Git, scan directories, or inspect repositories.
3. Provider access is a separate explicit network and disclosure action. Require the exact provider and host from the user, state that private/internal repository names will be placed in this chat, and only after that explicit request run one bounded `singularity-flow repositories list|search --scope provider --provider github --host <HOST> --audience model --surface copilot --disclose-provider-results --limit 10 --json`. Never invent or silently fall back to a host/account. Provider search supports only GitHub hosts: for any other Git host, say provider search is unavailable there and ask for the exact credential-free clone URL.
4. Render the returned `enumeration`, every source state/reason, and safe repositories. State how many returned records are private/internal. Without the explicit disclosure flag, provider records are withheld; direct the user to the native **Choose repository** picker or the exact direct CLI command and do not recover names from caches, the filesystem, terminal history, or another tool.
5. Offer only these unexecuted follow-ups: next page, copy URL, inspect onboarding, map capability, or create workspace. Use returned cursors and opaque `selectionRef` values exactly, and preserve `--disclose-provider-results` on an explicitly disclosed next page. Never construct a locator from a repository name.
6. Stop after listing or preparing a selected action. Do not clone, map, propose, create a workspace, initialize, or mutate provider/SFlow state.
