---
name: sflow-story-branch
description: Create, attach, inspect, or promote a Developer child branch with an explicit canonical Jira Story parent and repository completion policy.
disable-model-invocation: true

---

# Manage Story branch lineage

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal or any stop, relay the returned route before ending: `remediationPlan` steps, else `commandGuidance`, `nextAction`, `continuation.actions` or `recovery.actions`, in that order; with none, offer `/sf-nextsteps`. Never retry an unchanged condition; run a returned action only when the person asks.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow story branch status --parent <STORY-KEY>`.
2. Create with `singularity-flow story branch create <BRANCH> --parent <STORY-KEY>` only from a clean canonical Story branch.
3. Attach an existing custom branch with `singularity-flow story branch attach --parent <STORY-KEY>`.
4. Never infer the parent from a branch name. If no parent is registered, stop generation and submission with the CLI's exact guidance.
5. After accepted review, run `singularity-flow story branch promote --parent <STORY-KEY> [--mode pr|direct]`.
6. Follow the pinned `pr`, `direct`, or `either` policy. Direct promotion must fast-forward; never force-push.
