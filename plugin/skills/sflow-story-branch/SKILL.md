---
name: sflow-story-branch
description: Create, attach, inspect, or promote a Developer child branch with an explicit canonical Jira Story parent and repository completion policy.
disable-model-invocation: true

---

# Manage Story branch lineage

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow story branch status --parent <STORY-KEY>`.
2. Create with `singularity-flow story branch create <BRANCH> --parent <STORY-KEY>` only from a clean canonical Story branch.
3. Attach an existing custom branch with `singularity-flow story branch attach --parent <STORY-KEY>`.
4. Never infer the parent from a branch name. If no parent is registered, stop generation and submission with the CLI's exact guidance.
5. After accepted review, run `singularity-flow story branch promote --parent <STORY-KEY> [--mode pr|direct]`.
6. Follow the pinned `pr`, `direct`, or `either` policy. Direct promotion must fast-forward; never force-push.
