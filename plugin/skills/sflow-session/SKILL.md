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
2. If `initialized` is false, explain that Copilot must be inside the cloned application repository so its configured remote is known. Never guess its URL.
3. If selection is required, run `singularity-flow session candidates --json` and show IDs, titles, phases, statuses, commits. Match an explicitly supplied candidate; otherwise `ask_user` for the exact work ID or Jira ID. Never infer one.
4. Run `singularity-flow session attach <WORK-ID> --json`; it fetches and fast-forwards an existing branch. Read the exact `repositoryPath` returned; it may be an isolated Story worktree. Dirty phase work is preserved only at the exact remote HEAD; all other dirty, diverged, ahead, missing, or malformed state is refused. Never create, merge, rebase, reset, force-checkout, stash, or discard work.
5. Rerun `singularity-flow session status --json` with cwd set to that returned `repositoryPath`. Use the same returned `repositoryPath` for context and nextsteps; child commands do not change cwd. The current phase's default governed agent is activated automatically. Do not ask the contributor to select a role.
6. Confirm `ready` is true, `workId` is the selected ID, and `activeAgent` matches the phase contract. `/sf-agent` is only for a contributor who explicitly asks to inspect or override that default.
7. From the returned `repositoryPath`, run `singularity-flow session context --work-id <WORK-ID> --slice brief --max-output-bytes 32768 --json`. Use this bounded approved brief. Request another slice only when needed; never preload all slices or paste the repository.
8. From the same returned `repositoryPath`, run `singularity-flow nextsteps <WORK-ID> --json`; report work item, remote commit, agent, phase, and context accounting. For **every** returned `actions` entry, preserve order and render `<TIMING> — <reason>`, `Copilot: <copilotCommand>`, and `Shell: <command>`. Copy both route fields from the same action object. Never collapse prepare, phase publish, submit, approve, or another action into prose or omit either surface; print `unavailable` for a missing field, never guess. Stories use `singularity-flow nextsteps`, never `singularity-flow initiative next`. Git identity remains the actor/approval principal.
9. For earlier refused tools, read `singularity-flow logs --event hook --level warn`. `hook.session.initiative` means no work-item selection applies.
10. End the turn immediately; do not continue into the Story.
