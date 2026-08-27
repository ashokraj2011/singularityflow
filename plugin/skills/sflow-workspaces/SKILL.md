---
name: sflow-workspaces
description: List saved Singularity Flow workspaces, show the active workspace and repository, and display the workspace or Story context label.
disable-model-invocation: true

---
# Show Singularity Flow workspaces

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow workspace list --json`.
2. Run `singularity-flow workspace current --json`.
3. Show every non-archived workspace with its name, workspace ID, Jira anchor, directory, the capabilities it is for, and whether it is active. The capabilities are what the workspace is; the repositories in it are what those capabilities ship from.
4. For the active workspace, show the selected repository, branch, Story ID when present, and the exact context label from `prompt`.
5. If no workspace is active, say so and offer `/sf-workspace`. Do not select one without asking the contributor.
6. This skill is read-only. Do not create, clone, repair, archive, switch, or modify a workspace.

