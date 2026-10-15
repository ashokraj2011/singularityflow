---
name: sflow-confirm
description: Run one reviewed SFlow confirmation exactly as a returned /sf-confirm route carried it, with its digest, once.
disable-model-invocation: true
argument-hint: "<the exact command a returned /sf-confirm route carried>"
---
# Confirm a reviewed result

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

A returned `/sf-confirm <command>` route is the person's confirmation of the exact digest it carries, after reviewing its preview.

1. Require `$ARGUMENTS` to be one SFlow command, exactly as a returned route gave it, carrying `--confirm sha256:<DIGEST>` or `--confirm-plan sha256:<DIGEST>`. Refuse and stop on anything else: no digest, a `<placeholder>` or `a|b` choice still to fill, or shell operators.
2. Run `singularity-flow $ARGUMENTS` once from the resolved repository. Never edit the digest, preview again first or retry.
3. A refusal that the digest is stale: show the fresh review it returns and stop; the person reviews and confirms the new digest. A refusal that needs a live terminal: give its Shell command for the person's own terminal and stop.
4. Report the result and end with its next action per the Output contract.
