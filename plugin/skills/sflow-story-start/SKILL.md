---
name: sflow-story-start
description: Select a Jira Story, workflow, and persona, then create or resume its canonical governed branch.
argument-hint: "<JIRA-STORY-KEY>"
disable-model-invocation: true
---
# Start a governed Jira Story

1. If no Story key was supplied, run `singularity-flow jira assigned --type Story --json` and ask the contributor to choose one. Never infer a Story.
2. Run `singularity-flow jira pull <STORY-KEY> --json`. Show the title, description, acceptance criteria, parent Epic, attachments, assignee, status, and project before making changes.
3. Confirm that the Jira project is routed to the current repository or active Singularity workspace. If it belongs to another configured repository, switch to that repository first. Never start the Story in an arbitrary repository.
4. Run `git status --short`. Stop when unrelated changes would make intake unsafe.
5. Start `singularity-flow story start <STORY-KEY> --fetch` in an interactive terminal and bridge the displayed workflow and persona choices through `ask_user`.
6. If persistent terminal input is unavailable:
   - Run `singularity-flow choices begin start <STORY-KEY> --json`.
   - Record `jira` for `intake-source`.
   - Present the workflow-template and persona options with `ask_user`.
   - Record each explicit answer with `singularity-flow choices answer`.
   - Run `singularity-flow story start <STORY-KEY> --fetch --selection-receipt <TOKEN>` only after the receipt reports `ready: true`.
7. Show the resulting Epic → Jira Story → canonical branch lineage, selected workflow, persona, current phase, generated intake document paths, commit, and push result.
8. Only after the canonical Story branch exists, run `singularity-flow wm check`. If the model is missing or stale, run `singularity-flow wm build --phase <CURRENT-PHASE> --task "<STORY-TITLE>"` on that Story branch. Do not use `--local`: the model commit must be pushed as part of the Story branch before phase authoring begins.
9. Show the world-model generation timestamp, source-tree hash, commit, and push result. If generation fails, leave the Story intake intact and explain that `/sflow-phase` remains blocked until `/sflow-worldmodel` succeeds on this branch.
10. Continue only when asked. The next authoring action is `/sflow-phase`; `/sflow-nextsteps` remains the read-only guide.

The canonical branch is the exact Jira key. Jira intake pins the normalized issue snapshot in Git; it does not silently update Jira status or create an approval. Main, workspace, and Epic intake never require or warn about a world model.
