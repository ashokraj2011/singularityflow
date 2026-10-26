---
name: sflow-secrets
description: Scan tracked or staged content for likely credentials and explicitly install repository secret protection.
disable-model-invocation: true
argument-hint: "scan [--staged] | protect"
---
# Scan and protect secrets

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow secrets scan --json`, adding `--staged` only when requested.
2. Report file paths, rule IDs, and remediation without reproducing detected credential values.
3. Before `singularity-flow secrets protect --json`, say it writes the `pre-commit` hook Git runs for this repository (shared by its worktrees) and require an explicit request. Use `--force` only after separately reviewing an existing installation conflict. Afterwards, name the exact `data.hook` path. Claim protection only when `data.active` is true; otherwise relay `data.manualSteps` exactly and never edit that hooks directory or Git config yourself.
4. Secret scanning is deterministic and never sends file content to a model. Never print environment variables or add a detected secret to chat, logs, commits, or prompt context.

