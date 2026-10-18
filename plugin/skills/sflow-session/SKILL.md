---
name: sflow-session
description: Select an exact Story, open its managed local checkout or attach from remote, and bind its phase agent.
disable-model-invocation: true

---
# Attach the Copilot session to durable Git state

<!-- sflow-copilot-pause -->
Start with `singularity-flow session open --for-agent --json` once; for explicit takeover with an exact ID use `singularity-flow session takeover <WORK-ID> --for-agent --json` instead. Carry exact workspace/repository selectors and requested `--refresh`; with an ID refresh synchronizes, not local-open. Both entries check pause before Git. If paused, only offer `/sf-pause off`. Reuse the matching result. No separate pause/workspace/session lookups. Without an ID show candidates and ask for an exact choice; never infer selection.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; an exact selected workspace/repository is also valid before checkout exists; refuse if neither resolves; never search `$HOME`/parents.

Already loaded: never call the `skill` tool for this skill ("Skill not found" is expected). Wait for each command to exit.
Session setup only: no raw Git, source reads, edits, or lifecycle work. A deferred path is not cwd.
Story discovery comes from the configured state ledger, not an application-branch scan. The kernel verifies its reachable chain and exact indexed metadata; attachment fetches only the selected Story branch. Missing or unrefreshable state is a diagnostic, not an empty roster. Preserve that refusal; never enumerate branches or search the filesystem as a fallback. Existing verified managed checkouts may still use the local open route.

Listings reuse advisory snapshots (default 30 minutes). `source: local`/`remoteCheckedAt: null` is not remote freshness; report it accurately. Forward `/sf-session --refresh` with the same selectors. Failed refresh invalidates old success: preserve the real error/deadline and stop; never retry automatically. Help is not a transport repair. Listings never authorize attachment or approval.

1. Preserve explicit `--workspace <WORKSPACE> --repository <REPOSITORY-ID>`. Resolve partial selectors within that workspace or ask; never fill from active workspace/cwd. Otherwise reuse `open`'s explicit active scope; host cwd must not override it. Never guess URLs.
2. Without a Work ID, reuse the matching entry; relay `table` verbatim and ask for an exact ID via `ask_user` or chat. Binding/first row is not selection. Stop if no choice. Rerun only after explicit scope change or refresh. Gaps: `singularity-flow session candidates --json --diagnostics` with returned `selectors`.
3. Run `singularity-flow session open <WORK-ID> --for-agent --json` with returned `selectors`, or reuse the matching entry. Managed local open is `localOnly: true`; only a missing Story/repository permits remote fallback. Require `ready`, exact `workId` and open/attach `agent` matching `activeAgent` (`null` for completed Stories) before using `context`/`nextsteps`. Relay refusals and stop; never manually merge, rebase, reset, force-checkout, stash or discard work.
4. Report work, commit, agent and phase from `open`; tell shell users to `cd` to `repositoryPath`. For each action preserve order, timing, reason, `Copilot: <copilotCommand>`, and `Shell: <command>` from that same object in `nextsteps`. Do not merge distinct actions or invent missing routes. `/sf-agent` requires an explicit override request.
5. For hook refusals, read `singularity-flow logs --event hook --level warn`; `hook.session.initiative` means no Story selection.
6. End the turn; do not continue into Story work.
