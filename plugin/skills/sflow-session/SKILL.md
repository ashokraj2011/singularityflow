---
name: sflow-session
description: Select a work or Jira ID, synchronize its latest committed remote branch, and activate the current phase's governed agent.
disable-model-invocation: true

---
# Attach the Copilot session to durable Git state

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

This is a session-setup-only skill: before step 1, do not use raw Git, scan instructions, load phase skills, read source/artifacts, modify files, or execute lifecycle work. End after reporting.

1. Run `singularity-flow session status --json`.
2. If `initialized` is false, explain that Copilot must be opened inside the cloned application repository so its configured Git remote is known. Do not guess a repository URL.
3. If selection is required, run `singularity-flow session candidates --json` and show IDs, titles, phases, statuses, commits. Use an explicitly supplied candidate only after matching it; otherwise `ask_user` for the exact work ID or Jira ID. Never infer or silently select.
4. Run `singularity-flow session attach <WORK-ID> --json`. It fetches an existing branch, creates local tracking if needed, and fast-forwards. Read the exact `repositoryPath` returned by the command; it may be an isolated Story worktree rather than the workspace's launch clone. It may preserve dirty phase work only when already on the exact remote HEAD. Otherwise it refuses dirty, diverged, ahead, missing, or malformed state. Never create, merge, rebase, reset, force-checkout, stash, or discard work.
5. Rerun `singularity-flow session status --json` with its process working directory set to that returned `repositoryPath`. Use the same exact directory for context and nextsteps below; never assume a shell changed directory because an earlier child command attached the Story. The current phase's default governed agent is activated automatically. Do not ask the contributor to select a role.
6. Confirm `ready` is true, `workId` is the selected ID, and `activeAgent` matches the phase contract. `/sf-agent` is only for a contributor who explicitly asks to inspect or override that default.
7. From the returned `repositoryPath`, run `singularity-flow session context --work-id <WORK-ID> --slice brief --max-output-bytes 32768 --json`. Use that bounded approved brief for orientation. Request `world-model`, `ast`, or `evidence` as a separate slice only when the developer's question needs it; never preload all slices or paste the repository.
8. From the same returned `repositoryPath`, run `singularity-flow nextsteps <WORK-ID> --json`, then report work item, remote commit, agent, phase, context revision/accounting, and those next steps. Stories always use `nextsteps`, never `initiative next`. Git identity remains the actor/approval principal.
9. For earlier refused tools, read `singularity-flow logs --event hook --level warn`. `hook.session.initiative` means no work-item selection applies.
10. End the turn immediately; do not continue into the Story.
