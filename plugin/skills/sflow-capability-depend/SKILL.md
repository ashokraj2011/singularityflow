---
name: sflow-capability-depend
description: Propose an exact published-contract dependency discovered from a convenient reference.
disable-model-invocation: true
argument-hint: "<TARGET-CAPABILITY>@<REFERENCE>"
---
# Depend on a capability contract

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal or any stop, relay the returned route before ending: `remediationPlan` steps, else `commandGuidance`, `nextAction`, `continuation.actions` or `recovery.actions`, in that order; with none, offer `/sf-nextsteps`. Never retry an unchanged condition; run a returned action only when the person asks.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Require the target capability and reference. Require `--from` when source ownership is ambiguous and `--contract` when several published contracts match.
2. Run once after confirmation:
   `singularity-flow capability depend <TARGET>@<REFERENCE> [--from <SOURCE>] [--contract <ID>] --json`.
3. Confirm the result records an exact version, content SHA-256, publication SHA-256, and publisher authority. A movable reference such as `latest` must not appear in authoritative dependency state.
4. Relay the proposal or refusal. For a proposal, give the next action the CLI names for it: review with `singularity-flow capability proposal <BRANCH> --lead <LEAD-URL> --json`; after approval, activation through `/sf-capability-map` (`singularity-flow capability activate <BRANCH> --lead <LEAD-URL> --confirm <COMMIT> --json`). Stop. Never invent missing contract identity fields, activate yourself, or edit YAML.
