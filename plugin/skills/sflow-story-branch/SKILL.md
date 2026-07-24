---
name: sflow-story-branch
description: Create, attach, inspect, or promote a Developer child branch with an explicit canonical Jira Story parent and repository completion policy.
---

# Manage Story branch lineage

1. Run `singularity-flow story branch status --parent <STORY-KEY>`.
2. Create with `singularity-flow story branch create <BRANCH> --parent <STORY-KEY>` only from a clean canonical Story branch.
3. Attach an existing custom branch with `singularity-flow story branch attach --parent <STORY-KEY>`.
4. Never infer the parent from a branch name. If no parent is registered, stop generation and submission with the CLI's exact guidance.
5. After accepted review, run `singularity-flow story branch promote --parent <STORY-KEY> [--mode pr|direct]`.
6. Follow the pinned `pr`, `direct`, or `either` policy. Direct promotion must fast-forward; never force-push.
