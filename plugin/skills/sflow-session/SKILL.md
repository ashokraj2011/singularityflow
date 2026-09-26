---
name: sflow-session
description: Select an exact Story, open its managed local checkout or attach from remote, and bind its phase agent.
disable-model-invocation: true

---
# Attach the Copilot session to durable Git state

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; an exact selected workspace/repository is also valid before checkout exists; refuse if neither resolves; never search `$HOME`/parents.

Session setup only: no raw Git, source reads, edits, or lifecycle work. A deferred path is not cwd.

1. Run `singularity-flow session status --json`.
2. If uninitialized, check `singularity-flow workspace current --json`; ask for missing selection. Never guess URLs.
3. For an explicitly chosen work ID, try `singularity-flow session open-local <WORK-ID> --json` with exact workspace/repository selectors. Success opens a registered managed checkout without remote sync; report `localOnly: true`. Only `SESSION_LOCAL_STORY_UNAVAILABLE` or `SESSION_LOCAL_REPOSITORY_UNAVAILABLE` permits remote fallback. Stop on other refusals.
4. Otherwise run `singularity-flow session candidates --json` (`--diagnostics` for gaps). Use `--workspace <WORKSPACE> --repository <REPOSITORY-ID>` when selected. Show IDs, titles, phases, statuses, commits; ask for an exact ID if missing. Candidate `repositoryPath` is only the scan source.
5. If local opening did not succeed, run `singularity-flow session attach <WORK-ID> --json` with the same selectors. This synchronizes the selected remote Story and returns its checkout. Ahead, diverged, dirty, missing, malformed, or unverifiable state may refuse. Never manually merge, rebase, reset, force-checkout, stash, or discard work.
6. At the returned `repositoryPath`, run `singularity-flow session status --json`; confirm `ready`, `workId`, and `activeAgent`. Tell shell users to `cd` there. `/sf-agent` requires an explicit override request.
7. There run `singularity-flow session context --work-id <WORK-ID> --slice brief --max-output-bytes 32768 --json`. Never preload the repository.
8. There run `singularity-flow nextsteps <WORK-ID> --json`; report work, commit, agent, phase. For each action preserve order, timing, reason, `Copilot: <copilotCommand>`, and `Shell: <command>` from that same object. Do not merge distinct actions or invent missing routes.
9. For hook refusals, read `singularity-flow logs --event hook --level warn`; `hook.session.initiative` means no Story selection.
10. End the turn; do not continue into Story work.
