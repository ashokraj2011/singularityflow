---
name: sflow-session
description: Select an exact Story, open its managed local checkout or attach from remote, and bind its phase agent.
disable-model-invocation: true

---
# Attach the Copilot session to durable Git state

<!-- sflow-copilot-pause -->
Start with `singularity-flow session open --for-agent --json` once; carry explicit Work ID/workspace/repository selectors and requested `--refresh`. Resolve partial selectors below. It checks pause before Git and resolves workspace scope. If `status: paused`, native Copilot; only offer `/sf-pause off`, never resume implicitly. No separate pause/workspace/session lookups. Reuse this invocation's result while selectors/Work ID match; a new /sf-session starts again. Without an ID, show candidates and ask for an exact choice; never infer selection.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; an exact selected workspace/repository is also valid before checkout exists; refuse if neither resolves; never search `$HOME`/parents.

Session setup only: no raw Git, source reads, edits, or lifecycle work. A deferred path is not cwd.
Story discovery comes from the configured state ledger, not an application-branch scan. The kernel verifies its reachable chain and exact indexed metadata; attachment fetches only the selected Story branch. Missing or unrefreshable state is a diagnostic, not an empty roster. Preserve that refusal; never enumerate branches or search the filesystem as a fallback. Existing verified managed checkouts may still use the local open route.

Listings can reuse a successful advisory snapshot (configurable 30 minutes by default). First use may verify a retained local index; `source: local` with `remoteCheckedAt: null` does not claim a remote check. Report supplied freshness accurately; never treat the listing as attachment/approval authority. `/sf-session --refresh` forwards `--refresh` to the single entry command, preserving the same explicit selectors. A refused refresh invalidates the older snapshot: preserve its real error, transport classification and timeout evidence; do not retry automatically or offer command help as if it repairs Git access. Attach/open of a chosen Story retains its normal checks.

1. Preserve explicit `--workspace <WORKSPACE> --repository <REPOSITORY-ID>`. Resolve partial selectors within that workspace or ask; never fill from active workspace/cwd. Otherwise reuse `open`'s explicit active scope; host cwd must not override it. Never guess URLs.
2. Without a Work ID, reuse the matching entry; relay `table` verbatim and ask for an exact ID via `ask_user` or chat. Binding/first row is not selection. Stop if no choice. Rerun only after explicit scope change or refresh. Gaps: `singularity-flow session candidates --json --diagnostics` with returned `selectors`.
3. Run `singularity-flow session open <WORK-ID> --for-agent --json` with returned `selectors`, or reuse the matching entry. Managed local open is `localOnly: true`; only a missing Story/repository permits remote fallback. Require `ready`, exact `workId` and open/attach `agent` matching `activeAgent` (`null` for completed Stories) before using `context`/`nextsteps`. Relay refusals and stop; never manually merge, rebase, reset, force-checkout, stash or discard work.
4. Report work, commit, agent and phase from `open`; tell shell users to `cd` to `repositoryPath`. For each action preserve order, timing, reason, `Copilot: <copilotCommand>`, and `Shell: <command>` from that same object in `nextsteps`. Do not merge distinct actions or invent missing routes. `/sf-agent` requires an explicit override request.
5. For hook refusals, read `singularity-flow logs --event hook --level warn`; `hook.session.initiative` means no Story selection.
6. End the turn; do not continue into Story work.
