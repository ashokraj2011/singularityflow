---
name: start
description: Start a Singularity Flow work item from a unique ID or Jira issue, create and check out the exact matching Git branch, and initialize the SDLC workflow. Use only on explicit request.
argument-hint: "<WORK-ID> [--jira] [--title 'title'] [--base main]"
disable-model-invocation: true
---
# Start Singularity Flow work

1. Treat the invocation arguments as explicit user intent, but do not invent a work ID.
2. Run `singularity-flow version`. If unavailable, explain that the reviewed npm package must be installed; do not install an unknown package automatically.
3. Run `git status --short` and report existing changes. Singularity Flow refuses a dirty tree unless `--allow-dirty` was supplied.
4. If `.sdlc/worldmodel.json` is absent, run `singularity-flow wm init` on the base branch and ask the user to commit the generated configuration and builder prompt before starting work.
5. Run `singularity-flow start <arguments>`.
6. Confirm that the current branch exactly equals the work ID.
7. Read the created `workflow.json`, `STATUS.md`, and `source.json`.
8. Summarize the source, current phase, required artifact, and next valid action.
9. Do not begin requirements work unless also requested. Recommend `/singularity-flow:requirements`.

`--jira` uses direct Jira REST through the npm utility and environment credentials. It does not use MCP or an IDE Jira plugin.
