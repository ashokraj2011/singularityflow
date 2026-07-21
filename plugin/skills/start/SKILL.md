---
name: start
description: Interactively start a Singularity Flow work item by selecting a configured feature/bugfix/chore work type and persona, then create and publish its exact-ID branch and durable workflow state.
argument-hint: "<WORK-ID> [--jira] [--title 'title'] [--base main]"
disable-model-invocation: true
---
# Start Singularity Flow work

1. Treat the invocation arguments as explicit user intent, but do not invent a work ID.
2. Run `singularity-flow version`. If unavailable, explain that the reviewed npm package must be installed; do not install an unknown package automatically.
3. Run `git status --short` and report existing changes. Singularity Flow refuses a dirty tree unless `--allow-dirty` was supplied.
4. If `.singularity/workflow.yml` is absent, run `singularity-flow init` on the base branch and ask the user to commit the generated workflow, templates, personas, and builder prompt before starting work.
5. Run `singularity-flow start <arguments>` in an interactive terminal. Let the user choose the immutable work type and initial persona; never choose for them.
6. Confirm that the current branch exactly equals the work ID.
7. Read the created `workflow.json`, `STATUS.md`, and `source.json`.
8. Summarize the source, current phase, required artifact, and next valid action.
9. Offer `/singularity-flow:documents upload` for requirements files, images, PDFs, `.fig` files, or Figma links during the configured initial phases.
10. Do not generate the active artifact unless also requested. Recommend `/singularity-flow:phase`.

`--jira` uses direct Jira REST through the npm utility and environment credentials. It does not use MCP or an IDE Jira plugin.
