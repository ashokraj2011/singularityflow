---
name: sflow-story-fetch
description: Securely fetch a governed Jira Story branch, verify its parent and Story specifications, and start its pinned repository workflow.
disable-model-invocation: true

---

# Fetch a governed Story

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Ask the user to choose a Story from `/sf-story-inbox`.
2. Run `singularity-flow story fetch <JIRA-KEY>`. If it belongs to another configured repository, provide the user's chosen local directory through `--directory`.
3. The command must resolve repository identity only through the workspace allowlist, fast-forward the canonical branch, and verify the seed and every governed-context hash.
4. Let the governed-agent picker complete. The workflow type is already pinned by the approved Story plan.
5. Show Epic → plan ID → Jira Story lineage, local directory, workflow type, current phase, and next action.
6. Never override an unlisted URL, a remote mismatch, a divergent branch, or a specification hash mismatch.
