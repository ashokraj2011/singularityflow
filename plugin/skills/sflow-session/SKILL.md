---
name: sflow-session
description: Select a work or Jira ID, synchronize its latest committed remote branch, and activate the current phase's governed agent.
disable-model-invocation: true
---
# Attach the Copilot session to durable Git state

Do not scan instruction files, inspect the repository with raw Git commands, or perform generic orientation before step 1. The session commands below perform the required repository and remote validation themselves.
This is a session-setup-only skill, never an implementation request. Do not load a phase skill, read task artifacts or application source, modify files, generate artifacts, or execute lifecycle work. After step 10, end the turn. The contributor must invoke a separate `/sflow-*` action to begin work.

1. Run `singularity-flow session status --json`.
2. If `initialized` is false, explain that Copilot must be opened inside the cloned application repository so its configured Git remote is known. Do not guess a repository URL.
3. If `workItemSelectionRequired` is true, run `singularity-flow session candidates --json`. Show the remote work-item IDs, titles, current phases, statuses, and commits. When the contributor already supplied an exact candidate in the current request, use that explicit answer after confirming it appears in the candidates; do not ask them to repeat it. Otherwise use Copilot's `ask_user` facility to ask for the exact work ID or Jira ID. Include `candidateWorkId` when present, but never infer or silently select it.
4. Run `singularity-flow session attach <WORK-ID>` with the exact answer. This operation must fetch the configured remote, use an existing branch only, create a local tracking branch when missing, and fast-forward to the exact remote head. It may preserve uncommitted phase work only when the requested branch is already checked out and its local HEAD exactly equals the fetched remote HEAD, because that path changes only local session metadata. It must refuse dirty trees whenever a checkout or fast-forward is needed, and refuse diverged, ahead, missing, or malformed branches. Never create, merge, rebase, reset, force-checkout, stash, or discard work to make attachment succeed.
5. Rerun `singularity-flow session status --json`. The current phase's default governed agent is activated automatically. Do not ask the contributor to select a role.
6. Confirm `ready` is true, `workId` is the selected ID, and `activeAgent` matches the phase contract. `/sflow-agent` is only for a contributor who explicitly asks to inspect or override that default.
7. Report the selected work item, synchronized remote commit, governed agent, phase, and the ordered result from `singularity-flow nextsteps <WORK-ID> --json`. A Story/work item always uses `nextsteps`; never run `singularity-flow initiative next` for a Story ID. State that the Git identity shown separately remains the real actor and approval principal.
10. If a tool call was refused before you got here, `singularity-flow logs --event hook --level warn` records the exact decision and which selection was missing. On a governed initiative branch the log shows `hook.session.initiative` and no work-item selection applies — do not ask for a work ID there.
9. End the turn immediately after the session report. Do not continue into the Story even when the selected work item and agent are ready.
