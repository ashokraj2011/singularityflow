---
name: sflow-epic-start
description: Start or resume a Jira-keyed Epic planning workspace with an explicitly selected immutable profile and session persona.
---

# Start an Epic workspace

1. Require the Jira Epic key. Run `singularity-flow initiative choices begin start <EPIC-KEY> --json`.
2. Present every profile and persona option with Copilot's selectable question UI. Do not infer an answer.
3. Record each answer with `singularity-flow initiative choices answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
4. When the receipt is ready, run `singularity-flow epic start <EPIC-KEY> --selection-receipt <TOKEN>`.
5. The default profile is `epic-planning`; a user may select a configured full-delivery profile instead.
6. Show the created branch, pinned profile, source Jira identity, commit/push result, complete phase flow, and first deterministic next action.
7. Do not create branches manually or approve any phase.
