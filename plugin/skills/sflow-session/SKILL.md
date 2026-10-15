---
name: sflow-session
description: Select an exact Story, open its managed local checkout or attach from remote, and bind its phase agent.
disable-model-invocation: true

---
# Attach the Copilot session to durable Git state

<!-- sflow-copilot-pause -->
Start with `singularity-flow session open --for-agent --json` once, including only an explicitly supplied Work ID and workspace/repository selectors; resolve partial selectors as below. It checks pause before Git and resolves workspace selection itself. If `status: paused`, native Copilot; only offer `/sf-pause off`, never resume implicitly. Do not precede it with separate pause/workspace/session lookups. Reuse this initial result when selectors/Work ID are unchanged. Without a Work ID, show its candidates and ask for an exact choice; never infer selection.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; an exact selected workspace/repository is also valid before checkout exists; refuse if neither resolves; never search `$HOME`/parents.

Session setup only: no raw Git, source reads, edits, or lifecycle work. A deferred path is not cwd.
Story discovery comes from the configured state ledger, not an application-branch scan. The kernel verifies its reachable chain and exact indexed metadata; attachment fetches only the selected Story branch. Missing or unrefreshable state is a diagnostic, not an empty roster. Preserve that refusal; never enumerate branches or search the filesystem as a fallback. Existing verified managed checkouts may still use the local open route.

1. Preserve explicit `--workspace <WORKSPACE> --repository <REPOSITORY-ID>` selectors. Partial selectors: resolve only within the explicit workspace or ask; never fill from active workspace/cwd. With none, `singularity-flow session open` reads `singularity-flow workspace current --json` itself and carries the active `workspacePath`/`repositoryId` explicitly; an old host cwd must not replace that scope. Never guess URLs.
2. Without an explicit work ID, reuse the initial `singularity-flow session open --for-agent --json` result when its selectors match. Run again only after an explicit selection change. Relay its `table` verbatim, then ask with `ask_user` or plain chat for an exact ID; a current binding or first row is not selection. Stop without attaching if no choice exists. Gaps: `singularity-flow session candidates --json --diagnostics` with the returned `selectors`.
3. For the chosen ID run `singularity-flow session open <WORK-ID> --for-agent --json` with the returned `selectors`, or reuse the initial result if it already opened this exact choice. It opens the managed local checkout without remote sync (`localOnly: true`), and only when no local Story or repository exists attaches and synchronizes the remote Story. It requires `ready`, the exact `workId` and the open/attach result's `agent` as `activeAgent` (`null` for a completed Story) before reading brief `context` and `nextsteps`. Relay any refusal and stop. Never manually merge, rebase, reset, force-checkout, stash, or discard work.
4. Report work, commit, agent and phase from `open`; tell shell users to `cd` to `repositoryPath`. For each action preserve order, timing, reason, `Copilot: <copilotCommand>`, and `Shell: <command>` from that same object in `nextsteps`. Do not merge distinct actions or invent missing routes. `/sf-agent` requires an explicit override request.
5. For hook refusals, read `singularity-flow logs --event hook --level warn`; `hook.session.initiative` means no Story selection.
6. End the turn; do not continue into Story work.
