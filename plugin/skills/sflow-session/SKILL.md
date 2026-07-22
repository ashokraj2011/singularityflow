---
name: sflow-session
description: Select a work or Jira ID, synchronize its latest committed remote branch, and bind an explicit persona before a Copilot session begins work.
disable-model-invocation: true
---
# Attach the Copilot session to durable Git state

1. Run `singularity-flow session status --json`.
2. If `initialized` is false, explain that Copilot must be opened inside the cloned application repository so its configured Git remote is known. Do not guess a repository URL.
3. If `workItemSelectionRequired` is true, run `singularity-flow session candidates --json`. Show the remote work-item IDs, titles, current phases, statuses, and commits, then use Copilot's `ask_user` facility to ask for the exact work ID or Jira ID. Include `candidateWorkId` when present, but never infer or silently select it.
4. Run `singularity-flow session attach <WORK-ID>` with the exact answer. This operation must fetch the configured remote, use an existing branch only, create a local tracking branch when missing, fast-forward to the exact remote head, and refuse dirty, diverged, ahead, missing, or malformed branches. Never create, merge, rebase, reset, force-checkout, stash, or discard work to make attachment succeed.
5. Rerun `singularity-flow session status --json`. Only after `workItemSelectionRequired` is false may persona selection begin.
6. If `selectionRequired` is true, run `singularity-flow persona <WORK-ID>` in a persistent interactive shell. When the CLI prints `Choose persona`, call `ask_user` with every displayed label, ID, and description. Never recommend, infer, preselect, or silently reuse a persona when the policy requires a choice.
7. Map the contributor's selected persona ID to the displayed menu number and send only that number plus a newline to the same shell with `write_bash`.
8. Rerun `singularity-flow session status --json` and confirm `ready` is true, `workId` is the selected ID, `bound` is true when persona selection is active, and `activePersona` matches the contributor's choice.
9. Report the selected work item, synchronized remote commit, persona, phase, and `/sflow-nextsteps`. If interactive questions are unavailable, stop and ask the contributor to run `singularity-flow session attach <WORK-ID>` followed by `sflow-persona`; never bypass either selection with environment variables or local-file edits.
