---
name: sflow-confirm
description: Run one reviewed SFlow confirmation exactly as a returned /sf-confirm route carried it, with its digest, once.
disable-model-invocation: true
argument-hint: "<the exact command a returned /sf-confirm route carried>"
---
# Confirm a reviewed result

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

A returned `/sf-confirm <command>` route is the person's confirmation of the exact digest it carries, after reviewing its preview.

1. Require `$ARGUMENTS` to be one SFlow command, exactly as a returned route gave it, carrying `--confirm sha256:<DIGEST>` or `--confirm-plan sha256:<DIGEST>`. Refuse and stop on anything else: no digest, a `<placeholder>` or `a|b` choice still to fill, or shell operators.
2. Run `singularity-flow $ARGUMENTS` once from the resolved repository. Never edit the digest, preview again first or retry.
3. A refusal that the digest is stale: show the fresh review it returns and stop; the person reviews and confirms the new digest. A refusal that needs a live terminal: give its Shell command for the person's own terminal and stop.
4. Report the result and end with its next action per the Output contract.
