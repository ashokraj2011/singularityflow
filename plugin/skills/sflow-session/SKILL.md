---
name: sflow-session
description: Select a work or Jira ID, synchronize its latest committed remote branch, and activate the current phase's governed agent.
disable-model-invocation: true

---
# Attach the Copilot session to durable Git state

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; an exact selected workspace/repository is also valid before checkout exists; refuse if neither resolves; never search `$HOME`/parents.

This is a session-setup-only skill: no raw Git, source reads, edits, or lifecycle work before status. A deferred path is not cwd.

1. Run `singularity-flow session status --json`.
2. If uninitialized, check `singularity-flow workspace current --json`. An exact deferred selection can attach; otherwise ask. Never guess URLs.
3. Run `singularity-flow session candidates --json` (`--diagnostics` for gaps). An exact selection uses `--workspace <WORKSPACE> --repository <REPOSITORY-ID>` to override cwd. Show IDs, titles, phases, statuses, commits. Match an explicit ID or `ask_user` for the exact work ID or Jira ID. Never infer one. A candidate found through bounded remote metadata is still eligible for attachment; candidates' `repositoryPath` is only the scan source.
4. Run `singularity-flow session attach <WORK-ID> --json` with the same selectors. Attach verifies the Story and materializes only its selected deferred repository. It reuses a managed worktree, creates one from another Story worktree, or switches a clean canonical checkout; it never switches an unrelated Story worktree. Read the exact `repositoryPath` returned. Refuse dirty (unless exact remote HEAD), ahead, diverged, missing, malformed, or unverifiable state. Never manually create branches/worktrees, merge, rebase, reset, force-checkout, stash, or discard work.
5. Run `singularity-flow session status --json` at the same returned `repositoryPath`; use it for later commands. Tell a shell contributor to `cd` to the exact returned path; VS Code opens it after attach. Child commands cannot change parent cwd. The current phase's default governed agent is activated automatically.
6. Confirm `ready`, selected `workId`, and phase `activeAgent`; `/sf-agent` is only for an explicit agent request.
7. At that path, run `singularity-flow session context --work-id <WORK-ID> --slice brief --max-output-bytes 32768 --json`. Never preload the repository.
8. At that path, run `singularity-flow nextsteps <WORK-ID> --json`; report work, commit, agent, phase. For every returned `actions` entry, preserve order and render `<TIMING> — <reason>`, `Copilot: <copilotCommand>`, `Shell: <command>`. Copy both route fields from the same action object. Never collapse prepare, phase publish, submit, approve, or another action into prose or omit either surface. Print `unavailable` for missing fields, never guess. Stories use `singularity-flow nextsteps`, not `singularity-flow initiative next`.
9. For hook refusals, read `singularity-flow logs --event hook --level warn`; `hook.session.initiative` means no Story selection.
10. End the turn immediately; do not continue into the Story.
