---
name: sflow-epic-stories
description: List, inspect, and validate the editable Stories produced by an approved Epic Planning package.
---

# Review planned Stories

1. Run `singularity-flow epic planning status --json`.
2. Open `artifacts/epic-planning/story-plan.yml` and the generated `artifacts/epic-planning/stories/<PLAN-ID>/story-spec.md` files.
3. Show a compact table with plan ID, title, repository, workflow type, REQ/AC allocation, dependencies, and specification hash.
4. For requested edits, modify the Story plan, republish Planning, and clearly state that the former package hash is no longer approvable.
5. Never invent a Jira key or assignee. Jira keys are returned only during the reviewed publish operation; assignment remains in Jira.
