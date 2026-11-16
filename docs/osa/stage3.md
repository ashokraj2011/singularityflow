# OSA Stage 3 — surfaces on the one decision, and durable continuation

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) sections 5, 8 and 10; REQ-010–014, REQ-020–023 (their Stage 3 parts), REQ-050–052, REQ-060; AC-002, AC-006, AC-012, AC-020, AC-022; implementation plan section 5.
**Branch:** `osa-v11-s3`, from `osa-v11-s2` at `91dac87bb`; completed on `osa-v11-s3b`, from `osa-v11-s3` at `dac523e22` (section 12).
**Status:** the stage's implementation and its targeted qualification. Section 12 completes the parts the first pass left (refusals and the recovery planner, session listing and selection, the `publication-pending` stage, the missing qualification journeys); section 11 lists only what is still left. The heavy run (full suite on Node 22, then the weekly Node 26 run) has not been made; it comes at the end.

## 1 What changed

| # | Cohort | What | Where |
|---|---|---|---|
| 1 | Surfaces | One adapter and one rendering of the kernel's decision for every surface: `stepSnapshotOf`, `stepDecisionOf`, `reviewFactOf`, `decisionRoutes` (moved out of `phase-mutation-contract.mjs`, which re-exports them) | `src/step-decision.mjs` |
| 2 | Surfaces | Sequence guidance takes the step's primary action from the decision; its open-version, begin-or-prepare and rollover branches are deleted, and the Stage 2 exception (lifecycle commands 9 → 10) with them | `src/sequence.mjs` |
| 3 | Surfaces | The review continuation renders the decision with the review it holds; its own successor, open-version and review branches are deleted | `src/source-review-continuation.mjs` |
| 4 | Surfaces | The guide and next steps: the step's task stage leads (now for every step being written, not only one with a code intent), otherwise the continuation's rendering of the decision; the regenerate branch is deleted. Next steps puts a code step's `phase begin` before its inputs read | `src/guide.mjs`, `src/nextsteps.mjs` |
| 5 | Surfaces | Submission readiness and phase show (which reads readiness): the review continuation, the task's wait, and the kernel's route for a step with no task stage | `src/submission-readiness.mjs` |
| 6 | Surfaces | A damaged step leads with recovery before an amendment pause or another hold (§5 precedence 3 before 4–5); C14 (no rollover of a submitted step) and C20 (no `prepare` of a consumed code step) | `src/phase-governance-routing.mjs` |
| 7 | Surfaces | VS Code: a review that asked corrections keeps the engine's route (b27, S4b, S10), a waiting task shows its wait; the prefill stays a partial query that never sends | `apps/vscode/src/views/{submission-presentation,tree-model,journey-model}.ts` |
| 8 | Kernel | Durable task outcomes, the no-progress classifier, an advisory view of an opening it did not observe, review corrections on a step with no versions | `src/kernel/step-state.mjs` |
| 9 | Task outcomes | Kept in the task record and read by every view; the record's merge keeps the local blocked code | `src/workflow-task-outcome.mjs`, `src/workflow-task.mjs`, `src/state.mjs` |
| 10 | Refusals | One route for an uncertain opening retained for sync (Stage 2 finding 8); no recovery detour beside a failed test; the entry's unreadable review reads its status again; the non-Copilot hook names the kernel's next (a7, C19); a plain refusal with no remote to publish to (Stage 2 finding 13) | `phase-entry-authoring.mjs`, `refusal-remediation.mjs`, `phase-authoring-entry.mjs`, `agent-hooks.mjs`, `publication-unit-of-work.mjs` |
| 11 | Handoffs | A code publication's outcome review is read and asked in the same turn (act `read`), not handed to `/sf-outcome` (b38); a kernel-built step (convergence too) is checked and published by its own work command, never `/sf-publish` (b25, C9) | `src/agent-output.mjs`, `src/commands/shared/prepared-phase-next-actions.mjs` |
| 12 | Stage 2 path | A verification step that writes test automation was opened as a code generation before `prepare` (GENERATION_INTENT_NOT_APPLICABLE); it opens as a document does | `src/commands/phase-opening.mjs` |
| 13 | Owner, 2026-11-17 | The author's own correction asks the person like every successor (section 5) | `own-correction-rollover.mjs`, `requested-successor.mjs`, `story-version-opening.mjs`, `commands/phase-opening.mjs`, `settled-decisions.mjs`, `sflow-code` step 2 |
| 14 | Qualification | `test/osa-stage3-continuation.test.mjs`, `test/osa-stage3-vscode.test.mjs`, journey I, the three `osa-stage-3` KNOWN_BAD entries removed, the shadow comparison widened to six surfaces | `test/` |

## 2 One decision for every surface

`step-decision.mjs` is the only place a surface turns the Story record into the kernel's snapshot and the decision into a route. A view passes what it read (the review, the opening it observed, the task outcome) and renders `decisionRoutes`; it no longer decides what is next. `exactSubmit` lets sequence guidance and the guide name the exact submission where the edit guard leads with the readiness read: both are the one `submit-version` action.

**A view's basis.** A view reads, so it is `turnMode: 'view'`: it grants nothing. An operation's opening it did not observe is named as being written (`OPENING_UNOBSERVED` among the reasons), an advisory decision with its basis (§4.1); the work command's entry observes the opening and reconciles an uncertain one before any write. A view that read a review owes that review whatever its policy says now (a retained review stands).

**Common-basis agreement (AC-002).** `scripts/osa-shadow.mjs` now compares, at the operation level, the kernel against sequence guidance, the guide, next steps' "now", the review continuation, submission readiness and the entry's classification, on 672 captured records with five review states (none read, pending, ready, corrections, disposition): **7,400 surface readings, 0 differences.** At Stage 2 the shadow compared sequence and the entry only, with 380 declared sequence differences (312 amendment pause, 48 damage, 20 submit led by readiness). Two renderings of one action compare equal (`operationOf`: the exact submission and the readiness read; a review's status and its context); a facts read for the review accepts either the readiness read or the review's own read.

**What the shadow cannot show.** Every surface now shares the kernel, so their agreement is by construction. The independent expected results are the kernel's golden fixtures, the written-out expectations in `osa-stage3-continuation`, and the journeys through the real guard (section 9).

## 3 Durable task outcomes (§8, plan section 5 "Task stages")

| Outcome | Kernel state and action | Rendered | Edits |
|---|---|---|---|
| `running` | `waiting`, `observe` / `inspect` (task: execution) | `session current --for-agent --json` | the version's, unchanged |
| `waiting-input` | `waiting`, `person-decision` / `provide-input` | `documents readiness --phase <step> --work-id <W> --json` | none |
| `waiting-environment` | `waiting`, `person-decision` / `decide` (task-outcome) | `decisions <W>` | none |
| `waiting-person` | `waiting`, `person-decision` / `decide` (task-outcome) | `decisions <W>` | none |
| `repair-required`, budget left | `waiting`, `agent-work` / `repair-version` (attempt, budget) | the step's work command, `prepare <step>` | the version's |
| `repair-required`, budget spent | `waiting`, `person-decision` / `decide` (repair-exhausted, attempts) | `decisions <W>` | none |

- **Where it is kept.** The task record's `blockedCode`, as `<outcome>:<original code>:<lifecycle mark>`, with state `blocked`. An older reader sees an ordinary blocked task (no schema change). The record stays progress, never authority.
- **When it is read.** Only while the Story stands where it stopped: the mark is the Story record's history length and last entry. Any lifecycle event since (the person's decision on the card, a publication) makes it stale, and the kernel decides from the Story again. The kernel applies an outcome only to an open version.
- **Who writes it.** A failed required test at publication (`state.mjs`): a Node to pin is `waiting-person`, an environment cause `waiting-environment`, anything else `repair-required` within the step's repair budget (`repairBudget.maxAttempts`, default 3, the same budget the task record's continuations use).
- **Who reads it.** Next steps (with the guide), submission readiness and phase show, and the session's task resume.
- **No-progress detection (AC-012).** `noProgress(steps)` in the kernel: the same action on an unchanged basis twice is a loop; observing a running task, a declared wait and an idempotent acknowledgement are not.

## 4 Refusals, recovery and handoffs

| Before | Now | Reference |
|---|---|---|
| An uncertain opening retained for sync: the entry's act named `appeal resolve`, then `sync`; the permission named `phase opening <step> --reconcile` | One route for both: the entry leads with the permission's route on any kernel hold of the open version (opening pending, unknown, refused or unobserved, a writer fence, a stale branch). Reconciling settles the retained commit under its original lease | Stage 2 finding 8; journey H |
| CODE_TEST_FAILED offered `recover --phase <step>` (/sf-recover) among its steps | A failed test is a repair outcome: no recovery beside it | REQ-003, §5 |
| The entry sent an unreadable review to /sf-recover | It reads the review's status again, keeping the original error as the diagnostic | b1, REQ-022 |
| The non-Copilot hook told a published code step to run `recover` | It names the kernel's next action (submission, or the preview the person confirms) | a7, C19 |
| With no `origin` and publication required: "remote changed after its exact push authority was observed" | `PUBLICATION_REMOTE_AUTHORITY_MISSING`: "This checkout has no remote named 'origin' to publish to. Nothing was changed." with the person's `git remote add origin <url>` | Stage 2 finding 13 |
| A code publication with no review owed handed the agent to `/sf-outcome` while every view named `/sf-submit` | The outcome review is read and its question asked in the same turn (as `sflow-code` step 10 says); the step's next action is unchanged | b38, KNOWN_BAD `osa-stage-3` |
| A kernel-built step's preparation, and convergence's reviewed report, were handed to `/sf-publish` | Its own work command checks and publishes it (`phase prepublish <step> --for-agent --json --publish-if-ready`) | b25, C9, KNOWN_BAD `osa-stage-3-c9` |

**A malformed staged review report** is repaired inside its own review task: `review-source check` returns the exact repairs and the task is `repair-report` within its two-repair budget (`test/source-review-repair.test.mjs`, existing). A retained finding that needs a new product version is the kernel's `review-corrections`, previewed for the person's yes (journeys B, F and I). The two stay apart.

**Handoffs (REQ-050).** The guard already ends the turn's writes on a change of phase or version (b37, `step-routes-stage1`, `osa-stage1-guard` "a moved basis or an expired turn revokes an earlier grant"); a successor's opening ends in the same turn only through the person's yes. VS Code's prefill fills the chat input and never sends; it already waits while the person types and never replaces their text (`vscode-chat-prefill`, `osa-stage3-vscode`).

## 5 Owner's decision of 2026-11-17: the own correction asks the person

This supersedes the owner's rule of 2026-11-13 (settled for the person, with an undo). D3 and REQ-030 now hold with no exception.
- `phase rollover <step> --correction "<what it contradicts>"` previews the next version with the reason `own-correction` and the proposal's question ("Start version N of …?"). Its confirmation (`--correction … --confirm <value>`) opens it only on the person's yes, through the same proposal, consent receipt and opening operation as every successor. A confirmation with no yes in the turn is refused by the guard.
- The opening operation's settled exception, `openSuccessor`'s `settled` path and the hold for an undone correction are removed. No own correction is settled now: recording one refuses `SETTLED_DECISION_RETIRED`. Settlements recorded before 2026-11-17 stay readable, with their undo.
- The author's words are the proposal's request; they are never recorded as what the person asked for.
- `own-correction` stays in the proposal's reason list. `sflow-code` step 2 asks the preview's question as for any change; no exit was added.
- Where it is offered: the author's own turn (`sflow-code` step 2) offered it; it now asks the preview's "Start version N …?" question and confirms only on the yes. The review continuation never offered it. The decisions card listed it only as a settled item with an undo; no new item of that kind arises, and the card's own successor item (`generation-rollover`, for a change asked for or files changed) was already the person's preview.
- This replaces the instruction to leave the Stage 2 behaviour in place pending the ruling; with the exception gone there is no switch left to drop.
- Tests: `settled-decisions` (the guard refuses the confirmation with no yes; recording a settlement refuses) and `settled-decisions-flow` (the preview opens nothing; the person's terminal yes opens it with their receipt and reason `own-correction`).

## 6 Findings and decisions for the owner

| # | Finding or decision | What was done; what the owner may want to decide |
|---|---|---|
| 1 | The own correction (owner, 2026-11-17) | Done as ruled (section 5). |
| 2 | A code publication's outcome review was a hand-off to `/sf-outcome`; the work command's own text already reads it in the same turn | The act now says `read` with the outcome read as `do.shell`, so the hand-off disappears and every view names one next step. **Owner may confirm** that the in-turn ask is the intended experience (it is what `sflow-code` step 10 says). |
| 3 | The lifecycle handlers' eager-source budget | Raised by the measured +53,047 bytes to 9,747,600 (section 7): the reducer and its adapter now load wherever a next step is named. **Owner decision:** accept the raise, or ask Stage 5 to lazy-load the reducer behind sequence's refusal paths. |
| 4 | Journey A could not reach its end: verification was opened as a code generation (a Stage 2 path), and convergence's report went to `/sf-publish` | Both fixed (rows 11, 12 of section 1). |
| 5 | The task record's merge dropped the local blocked code (pre-existing) | Fixed: a shared record no longer erases the step's wait. |
| 6 | A step whose policy needs no versions had a review's corrections turned into a successor | The kernel names a person's decision instead (`REVIEW_CORRECTIONS_WITHOUT_VERSIONS`). |
| 7 | `refresh-facts` for an unread review | Rendered by the guard as the readiness read and by the review's own surfaces as its context; both read the review first. Left as is. |
| 8 | A failed required test offered `/sf-recover` beside its repair | Removed: a failed test is a repair outcome, not damage (REQ-003). Its other routes (the Node pin, the risk acceptance, the base comparison, the saved log) stay. |

## 7 Ratchet and budgets

**AC-020 ratchet** (totals of the per-module ceilings):

| Family | Stage 2 | Stage 3 |
|---|---|---|
| Raw opening reads | 76 | 76 |
| Opening writes | 12 | 11 |
| Lifecycle predicate calls | 230 | 214 |
| Skill and turn chooser calls | 106 | 102 |
| Version arithmetic in place | 38 | 38 |
| Routes built in place | 121 | 115 |
| Lifecycle command literals | 333 | 321 |
| Route skill literals | 116 | 112 |

- **Deleted exceptions:** `sequence.mjs` lifecycle commands (now 4, Stage 0 had 9) and `phase-mutation-contract.mjs` (now holds none of the counted families but one chooser).
- **Named exceptions added:** `step-decision.mjs` (the snapshot adapter's `phaseKernelOwned` classification as a normalizer; the chooser, the approve and reject commands and `/sf-recover` as renderers, all moved from `phase-mutation-contract.mjs`, owner Stage 4's central map); `commands/shared/prepared-phase-next-actions.mjs` route objects 1 → 2 (renderer: the post-preparation route names the step's work command, where Stage 0's conditional hid the chooser beside `/sf-publish`).
- **Falls by module:** `sequence.mjs` predicates 6 → 1, choosers 3 → 1, routes 7 → 3, commands 10 → 4; `guide.mjs` predicates 9 → 5, choosers 3 → 1, routes 10 → 8, commands 10 → 8; `source-review-continuation.mjs` predicates 7 → 1; `own-correction-rollover.mjs` writes 1 → 0, routes 2 → 1, commands 2 → 1, skill literals 2 → 0; `refusal-remediation.mjs` commands 29 → 28, skill literals 24 → 23; `nextsteps.mjs` commands 18 → 17.

**Budgets:**

| Ceiling | Stage 2 | Stage 3 measured | Change |
|---|---|---|---|
| Lifecycle handlers' bytes | 9,694,550 (`phase-lifecycle` 9,694,534) | `phase-lifecycle` 9,747,581 | **raised to 9,747,600** (+53,047), measured and commented in `test/lazy-command-handlers.test.mjs`: the reducer (35,067 bytes) and `step-decision.mjs` (15,138) join every surface's closure |
| Lifecycle handlers' files | 473 (`submit` 471) | `submit` 473 | none: two new eager files, at the ceiling |
| Session current | 4,279,100 (4,279,049), 221 files | 4,279,062, 221 files | none |
| VS Code bundles | `benchmarks/dx/vscode-bundle-budgets.json` | within (`vscode-bundle-budget`) | none |
| Cold CLI bundle | ≤ 21 chunks | within (`cli-bundle`) | none |

## 8 Performance (AC-022)

**Method:** the Stage 0 method ([perf-baseline.md](perf-baseline.md)), unchanged: `scripts/osa-perf-baseline.mjs --samples=3 --modes=source,bundle`, in an isolated journey fixture, on Node 22. Three samples, not five, because two other agents' suites were loading the machine; counts are what the comparison rests on.

**Pairing.** The Stage 2 head `91dac87bb` and the Stage 3 candidate `6d175aca1` (its `source.dirty` flag is true only for the documentation and one VS Code label edited beside it) were measured back to back on the same machine. Data: `benchmarks/osa/perf-stage3.json` and `benchmarks/osa/perf-stage3-paired-base.json`; Stage 0's own run is `perf-baseline.json` and Stage 1's comparison [stage1-perf.md](stage1-perf.md).

Medians of three samples. Counts are from the counted cold run.

| State | Layout | Request | Outcome (Stage 3) | Cold ms base → Stage 3 | Warm ms base → Stage 3 | Modules / Git / reads / dirs / stats, base | Stage 3 |
|---|---|---|---|---|---|---|---|
| document v1 being written | source | guard | allow (no decision) | 105.3 → 108.6 | 79 → 76.2 | 85 / 0 / 91 / 0 / 53 | 90 / 0 / 91 / 0 / 53 |
| document v1 being written | source | guard-other-file | deny | 111.4 → 109.3 | 74.9 → 79.8 | 87 / 0 / 85 / 0 / 38 | 92 / 0 / 85 / 0 / 38 |
| document v1 being written | source | entry | author | 871.6 → 798.9 | 659.6 → 651 | 608 / 26 / 199 / 37 / 3079 | 610 / 26 / 199 / 37 / 3115 |
| document v1 being written | source | next | now prepare intake /sf-phase | 349.7 → 344.6 | 248.7 → 259.8 | 398 / 3 / 110 / 10 / 375 | 400 / 3 / 110 / 10 / 391 |
| document v1 being written | bundle | guard | allow (no decision) | 79.5 → 82 | 52.3 → 56.2 | 10 / 0 / 21 / 1 / 53 | 10 / 0 / 21 / 1 / 53 |
| document v1 being written | bundle | guard-other-file | deny | 76 → 80.2 | 50.8 → 51.4 | 9 / 0 / 15 / 1 / 38 | 9 / 0 / 15 / 1 / 38 |
| document v1 being written | bundle | entry | author | 715 → 671.2 | 556.9 → 543.6 | 19 / 26 / 145 / 38 / 3170 | 19 / 26 / 145 / 38 / 3206 |
| document v1 being written | bundle | next | now prepare intake /sf-phase | 463.1 → 455.9 | 275.1 → 273.2 | 244 / 3 / 122 / 11 / 378 | 244 / 3 / 122 / 11 / 394 |
| code v1 open | source | guard | allow (no decision) | 106 → 105.5 | 75.2 → 72.2 | 85 / 0 / 93 / 0 / 49 | 90 / 0 / 93 / 0 / 49 |
| code v1 open | source | guard-other-file | deny | 107.2 → 108.6 | 71.9 → 73.5 | 87 / 0 / 89 / 0 / 42 | 92 / 0 / 89 / 0 / 42 |
| code v1 open | source | entry | author | 1009.3 → 1011.3 | 853.3 → 815.4 | 638 / 38 / 300 / 87 / 6737 | 640 / 38 / 300 / 87 / 6569 |
| code v1 open | source | next | now prepare implement /sf-code | 457.9 → 452 | 304 → 298.5 | 565 / 3 / 134 / 14 / 439 | 567 / 3 / 134 / 14 / 445 |
| code v1 open | bundle | guard | allow (no decision) | 79.3 → 77.7 | 52.2 → 53 | 10 / 0 / 23 / 1 / 49 | 10 / 0 / 23 / 1 / 49 |
| code v1 open | bundle | guard-other-file | deny | 77.4 → 75.3 | 53.2 → 56.1 | 9 / 0 / 19 / 1 / 42 | 9 / 0 / 19 / 1 / 42 |
| code v1 open | bundle | entry | author | 1002.2 → 1026.7 | 792 → 809.4 | 94 / 41 / 324 / 90 / 6834 | 94 / 41 / 324 / 90 / 6666 |
| code v1 open | bundle | next | now prepare implement /sf-code | 451.7 → 456.6 | 278.9 → 277.9 | 244 / 3 / 148 / 15 / 442 | 244 / 3 / 148 / 15 / 448 |

**Against the AC-022 rules:**

| Rule | Result |
|---|---|
| No per-tool Git discovery | **Met:** 0 Git processes on every guard row, as at Stage 0, 1 and 2 |
| Module and Git counts must not grow | **Git: met** on every row. **Bundle modules: met** on every row (the guard 10 and 9, the entries 19 and 94, next steps 244). **Source modules:** the guard +5 (85 → 90, 87 → 92): `step-decision.mjs` and the policy modules it imports beside the mutation contract; the entry and next steps +2 (the reducer and `step-decision.mjs` through the planners). Reported, not hidden; the installed product runs the bundle layout. |
| File and directory reads | identical on every row; stat calls within ±3% (the code entry fell by 168, next steps rose by 6 to 16) |
| No ceiling raised to pass | **Met** for every bundle, chunk and hook ceiling. The one raise is the lifecycle handlers' eager-source byte budget (section 7), measured and stated, not a timing ceiling. |

Timings moved both ways under load (within about ±10%), and no row is consistently slower.

## 9 Acceptance rows

| Row | Result | Evidence |
|---|---|---|
| REQ-010 | **Pass** (Stage 1 cohort kept; Stage 3 adds the hook and the entry) | `osa-stage1-guard`, `agent-hooks` (a7), journey H (the entry and the permission name one route for an uncertain opening) |
| REQ-011 | **Pass** | no recovery beside a failed test (`refusal-remediation`), the entry's unreadable review (`phase-authoring-continuation`), the hook (`agent-hooks`); journeys B, D, F, G, I with no detour. Completion (§12): phase refusals, the recovery planner, finding resolution and gate recovery name the step's own route; `recover` on healthy work names its real next action (`refusal-remediation`, `step-routes-stage1`, `gate-recovery`, `upstream-route-dead-ends`, `phase-resolution-rca`, `osa-stage3-journeys`) |
| REQ-012 | **Pass** | `osa-stage3-continuation` tests 1–4, journey D (the failed test's wait); completion: `publication-pending` from the sealed record and `running` from a live lease (§12.2), `workflow-task-resume`, `osa-stage3-journeys` (heartbeat, missing attachment, bounded repair, and the slow-lane pending publication across processes) |
| REQ-013 | **Pass** (Stage 1, kept) | `osa-stage1-guard` "review staging and execution outputs are their own capabilities" |
| REQ-014 | **Pass** | `publication-preflight` (changed bytes preserved; keeping them is asked by the work command, b34), `phase-appeals` (an edited published document is kept through its preview, never published in place, b11); the slow-lane journey keeps both the edit and the published bytes and opens nothing before the yes |
| REQ-020 | **Pass** | `osa-stage1-shadow` (7,400 readings, 0 differences), `osa-stage3-continuation` test 4, `osa-stage3-vscode`, journeys B, D, E, F, G, I "the person's views name the agent's skill at every hand-off"; completion: one session-opening read for `/sf-session` and `/sf-resume`, the `/sf-resume` prerequisite on the decision (`session-open`, `session-read-service`, `handoff`, `workspace-clone-resume`, `story-start-handoff`, `nextsteps`); every view at one basis in `osa-stage3-journeys` |
| REQ-021 | **Pass** | the kernel returns no command, skill or prompt (`osa-stage1-kernel`, `osa-stage3-continuation` test 1) |
| REQ-022 | **Pass** for every phase refusal's containment and the planners moved; **partial**: the producer details and refusal steps listed in section 11 | `refusal-remediation`, `refusal-story-next`, `osa-stage3-continuation` test 6, `osa-stage3-journeys` (codes kept, original details, the step's own route) |
| REQ-023 | **Pass** for the routes changed | every new route validates through `safeCommandGuidance` (`osa-stage3-continuation`, `authoring-skills`) |
| REQ-050 | **Pass** (existing guard boundary; prefill) | `step-routes-stage1`, `osa-stage1-guard`, `vscode-chat-prefill`, `osa-stage3-vscode` |
| REQ-051 | **Pass** | `osa-stage3-continuation` test 7, `copilot-turn-renewal`, journey E; completion: a live heartbeat renews no turn, a person's answer renews the turn but neither an expired yes nor a fenced writer (`osa-stage3-journeys`) |
| REQ-052 | **Stage 4** (review delegation) | — |
| REQ-060 | **Pass** | `plain-language-check` (section 10) |
| AC-002 | **Pass** for the moved surfaces | `osa-stage1-shadow` |
| AC-006 | **Pass** for the refusals and planners moved; section 11 names the rest | as REQ-022 |
| AC-012 | **Pass** | `osa-stage3-continuation` test 5 (kernel classifier); the route follower's loop, circle and no-progress checks in every journey; completion: an agent's repair repeated on an unchanged basis is a loop, a person's wait is not (`osa-stage3-journeys`) |
| AC-020 | **Pass** | `osa-ratchet` |
| AC-022 | see section 8 | |

**Original incidents with named journeys** ([baseline.md](baseline.md)): review routed to help (journey A's first incident, `refusal-story-next`); the turn-window expiry (journey E); a review with no next action (journey B "the reviewer's reply carries the next step"); the /sf-recover misroute (journey B "after the rollover, /sf-recover routes the code step to its author"); the v2 reviewer blocked by PHASE_MUTATION_CONTRACT_REQUIRED and the /sf-code ↔ /sf-session loop (journeys B and F through the real guard, with the route follower's circle check). Results in section 10.

## 10 Targeted runs at Stage 3

Node 22, through the isolated runner at concurrency 2, targeted files only. No touched set and no full run: the heavy run comes at the end, by the owner's rule.

| Run | Files | Result |
|---|---|---|
| Stage 3 qualification | `osa-stage3-continuation` (7: task outcomes, the stale-outcome rule, the views' agreement on a wait, a failed test's boundary, no-progress detection, the missing remote, liveness kept apart), `osa-stage3-vscode` (3) | pass |
| Slow lane (`SINGULARITY_FLOW_TEST_SLOW=1`), journeys | `journey-stories`: A, B, D, E, F, G and the new I, at `6d175aca1` | **pass: 39 checks, 0 failed, 0 todo**, KNOWN_BAD empty. The first run, at `b00166774`, found the four faults of `6d175aca1` (journey A could not end, B's and D's views differed); they were fixed and the whole file run again |
| Slow lane, other walks | `osa-stage2-journey-h` (now asserting one route for the uncertain opening) and `journey-routes` (fast tier: C, the skill entry map, a quick fix's start), at `0c5469ae1` with the refusal's wording change | pass, 11 |
| Slow lane, the owner's ruling | `settled-decisions-flow`, `settled-decisions` | pass, 11 |
| After the last code change | `8ba08d6b1` read the failed test's record through its family; a scripted walk to journey D's failed test (not committed) showed next steps naming the decisions card, as at `6d175aca1` | as expected |
| Neighbours (79 files in all, with the rows above) | `agent-hooks`, `agent-output`, `author-owned-findings`, `authoring-skills`, `changes-after-publication-cli`, `cic-chat-entry`, `clarification-guidance-contract`, `confirmation-routes`, `dead-end-routes`, `guide`, `iac-chat`, `intent-amendment-defaults`, `kernel-step-routes`, `lifecycle-transitions`, `nextsteps`, `nextsteps-no-model`, `outcome-review`, `phase-authoring-continuation`, `phase-authoring-progress`, `phase-authoring-skills`, `phase-contract-recovery`, `phase-entry`, `phase-governance-routing`, `phase-mutation-contract`, `phase-repair-loop`, `phr-routing`, `plugin`, `post-code-handoff`, `publication-guidance-contract`, `publication-preflight`, `refusal-remediation`, `refusal-story-next`, `repository-host-routes`, `requested-successor-cli`, `requested-successor-document-cli`, `review-next-step`, `rework-lifecycle`, `sequence`, `session-entry-view`, `sf-amend`, `skill-efficiency`, `skills-html`, `skp-amendment-state`, `source-review-repair`, `spk-e2e`, `spk-fastpath`, `step-being-written`, `step-routes-stage1`, `still-holds-in-chat`, `submission-readiness`, `vscode-chat-prefill`, `vscode-decision-list`, `vscode-outcome-review`, `vscode-step-action-deliveries`, `workflow-task-completion`, `workflow-task-resume`, `xpl2-routing` | pass after the changes below. The first passes found two kinds of failure. Some were the code's: a view that had not observed an opening, a record with no step order, a review a view read for a step its policy does not review, and review corrections on a step with no versions; the adapter and the kernel were fixed (sections 2 and 6). The others were tests that pinned a route the kernel now gives every surface: `prepare` for a published document's successor (now its preview, D3), `prepare` for a code step's first version (now `phase begin`), `/sf-publish` after a kernel-built step's preparation, `/sf-outcome` as the code publication's hand-off, a recover step beside a failed test, the own correction's settlement. Each was changed to the new route with its reason; none was weakened |
| Must stay green | `source-inspection`, `git-bypass-audit` (and the script: 2,013 sites, no new one), `sda-inventory`, `lazy-command-handlers`, `exit-ratchet`, `plain-language` (and the script: 0 new, 4 fixed, locked in), `osa-ratchet`, `osa-stage0`, `osa-stage1-kernel`, `osa-stage1-guard`, `osa-stage1-shadow`, `osa-stage1-skills`, `osa-stage2-opening`, `documentation-privacy`, `docs-layer`, `docs-packaging`, `documentation-consolidation`, `cli-bundle`, `vscode-bundle-budget` | pass |
| Repository check | `node check-iso.mjs <worktree>` (`scripts/check.mjs`) | pass: 3,784 checks. It first flagged the outcome's raw record read, now through `readRecord` |
| Performance | `scripts/osa-perf-baseline.mjs`, paired with `91dac87bb` | section 8 |

**Reds:** none left. One fault the journeys found came from Stage 2 (`openBeforePrepare` opened a verification step as a code generation); it was not run at `91dac87bb` to confirm, but the code path there is the same.

**Not run:** the full suite, the weekly Node 26 run, and `osa-stage2-compat` against an older checkout.

## 11 What is left

Done in the completion (section 12): the recovery planner (b11, b34), finding resolution (b13), gate recovery (b26), the rest of the phase refusals' containment (b12, b33), session listing and selection with one session-opening read for `/sf-session` and `/sf-resume`, the `publication-pending` stage, and the qualification journeys. Still left, and why:
- **Stage 4's (owned there):** version 1 of a document step has no opening record (Stage 2 finding 4); successors of kernel-built document steps (Stage 2 finding 5); the decisions card as a consent surface; the central action-to-command map, which should take over `decisionRoutes` with this stage's two additions (its `publish-version` case for a pending publication, and `stepRoute`).
- **Routes not moved here, each a producer's own detail or step:**
  - prepublish's lead action for changed files after a code publication still names `recover` (`phase-prepublish.mjs`, b39); recovery's own plan then names the work command;
  - `state.mjs` and `spec-coverage-preview.mjs` still set a coverage refusal's `diagnosticCommand` to `recover` (the refusal now drops it);
  - `CODE_TEST_RESULT_REQUIRED` and `CODE_TEST_SUPPRESSED` with a pinned configuration dependency open with a recovery read of the configured command; `TRP_PUBLICATION_PENDING` and `TCA_PUBLICATION_PENDING` name `recover` where the pending publication's `sync` is the continuation;
  - `return` still prints a fixed `prepare` of the active step (`cli.mjs`), as `resume` did.
- **The guard does not read task outcomes.** A spent repair budget stops every view at the decisions card, but the guard keeps the open version's writes; the edit permission does not take the task's stage.
- **`running` applies to an open version only**: a long run under the Story's lease after publication (a submission's tests) is not observed as running, and a lease held on another machine is not observed at all (its owner cannot be read here).
- **The session listing** (`session candidates`, the roster) shows the indexed phase status and published number and names no step action; it has no decision to move and was left as is.
- **Not run:** the full suite, the weekly Node 26 run, `osa-stage2-compat` against an older checkout, and the performance comparison for the completion.

## 12 Stage 3 completion

**Branch:** `osa-v11-s3b`, from `osa-v11-s3` at `dac523e22`. Commits: `2d3be74de` (refusals and the recovery planner), `abac5bd81` (sessions), `00ffd0385` (task stages), `d85a5e8f3` (journeys), then this record with the ratchet, budget and plain-language lock-ins. Built beside Stage 4 (`osa-v11-s4`, same base), which owns the work commands, `/sf-next`, kernel-built steps, review delegation, the decisions card as a consent surface, version 1 of a document's opening, the central action-to-command map and the skill, help and example texts; none of those were changed here.

### 12.1 What changed

| # | Cohort | What | Where |
|---|---|---|---|
| 1 | Recovery planner (b11, b34) | The planner reads the step's version through the kernel's predicates (no raw opening read, no `nextPhaseGeneration`, no `generation + 1`). Changed files after a code publication keep their exact confirmation but are asked by the step's own work command, not `/sf-recover`. An edited published document is kept as the next version through its preview (`phase rollover <step> --reason "<what to change>" --json`), never `phase publish` in place; dropping it is the person's set-aside. A published version's other changed content, an agent-brief source error and the retry contract name the step's own preview or recheck, never a document view or `recover`. An approved step's and a matching published code step's action is the kernel's route (`stepRoute`) | `src/recovery-plan.mjs`, `src/step-decision.mjs` |
| 2 | Recover for healthy work (§10) | `recover` with nothing to repair says so and names the step's real next action | `src/collaboration.mjs` |
| 3 | Finding resolution (b13) | No default `/sf-recover` skill. The read beside every finding is the Story's next steps; a failed or skipped test is rechecked by the step's own work command (`phase prepublish <step> --for-agent --json --publish-if-ready`); an intent to open is the kernel's route (version 1 directly, a next version on the person's yes); only changed published bytes and a lifecycle appeal keep recovery | `src/phase-resolution.mjs` |
| 4 | Gate recovery (b26) | A final step in progress repairs in its own work (its kernel route); an approved owner is never repaired in place (the upstream issue for its approvers, about the finding's clause); a step not reached yet names the current step's action; an unknown owner reads the Story's next steps. `recover --fetch` stays for a remote that moved (a refresh) | `src/gate-recovery.mjs` |
| 5 | Refusals (b12, b33) | A phase refusal's containment is the step's own next-step read (`nextsteps <W> --json`), which names recovery only for real damage; recovery and the document view are no longer added beside a healthy refusal. An approval turn keeps its end-of-turn step and the approver's evidence read. A coverage refusal's recovery read is dropped (the author's recheck lists the obligations) | `src/refusal-remediation.mjs` |
| 6 | Sessions (plan section 6 item 7) | One session-opening read for `/sf-session` (`session open`, `session takeover`) and `/sf-resume` (`resume`): the binding, the brief and the next steps (from the kernel through next steps). `resume` keeps its own selection and arguments (`<WORK-ID or branch>`, `--fetch`, `--allow-dirty`, `--agent`) and no longer prints a fixed `prepare` of the active step. The `/sf-resume` prerequisite in next steps reads the kernel's decision (b7) | `src/session-opening.mjs`, `src/commands/session-open.mjs`, `src/commands/session-takeover.mjs`, `src/commands/shared/start-context.mjs`, `src/commands/nextsteps.mjs` |
| 7 | Task stages (§8) | `publication-pending`, and `running` from a live lease | `src/kernel/step-state.mjs`, `src/workflow-task-outcome.mjs`, `src/workflow-task.mjs`, `src/workflow-task-store.mjs`, `src/submission-readiness.mjs`, `src/commands/nextsteps.mjs`, `src/session-read-service.mjs`, `src/step-decision.mjs` |
| 8 | No-progress (AC-012) | A declared wait is a wait for a person; the agent's own repair repeated on an unchanged basis is now a loop | `src/kernel/step-state.mjs` |
| 9 | Qualification | `test/osa-stage3-journeys.test.mjs` (section 12.4); the tests that pinned a recovery detour changed to the new route, each with its reason | `test/` |

### 12.2 The task stages

| Stage | Kernel | Rendered | Read from |
|---|---|---|---|
| `publication-pending` | `waiting`, `reconcile` / `publish-version` (`pending: true`, the original code and commit), before any authoring; it applies whether or not a version is open | `singularity-flow sync` (the same command next steps, readiness and the skills already name for `state=publication_pending`) | the sealed pending-publication record (`readPendingPublication`), which keeps the exact commit, branch, remote and lease across any interruption. Not a task-record code: a record cannot outlive the publication it names |
| `running` | `waiting`, `observe` / `inspect` (task: execution); the version stays writable | `session current --for-agent --json` | another process on this machine holds the Story's lease with a fresh heartbeat (`inspectSubjectLease`); this process's own lease, an unknown owner or a stale heartbeat is not observed as running |

- **Who reads them.** Next steps (the retained record is read once and shared with the task's stage and resume), submission readiness (`synchronization-required`), the session's task resume (session current and session status read the record; the shared session read passes what it already checked), and the kernel's views.
- **The task resume** with a retained publication says `stage: 'publication-pending'`, `remaining: ['publish']` and names `sync`; it named `recover` before. A blocked task with no route of its own, and an interrupted operation with no inspection, now name the kernel's route for the step instead of `recover`.

### 12.3 Refusals and the recovery planner, before and now

| Before | Now | Reference |
|---|---|---|
| Every phase refusal with no route of its own added `recover <W> --phase <step> --json` (`/sf-recover`) and `phase show <step> --json` (`/sf-phase-documents`) | `nextsteps <W> --json` (`/sf-nextsteps`): the step's own next action as the kernel decides it, recovery only for damage. Its codes, details and producer routes are unchanged | b12, b33, D4 |
| Gate findings owned by a step: `recover <W> --phase <owner>` | the owner's kernel route, the upstream issue for an approved owner, or the Story's next steps | b26 |
| `phaseResolutionChoices` defaulted every route's skill to `/sf-recover`, and its trailing read was `recover` | the command's own skill; the trailing read is the Story's next steps; a failed test is rechecked in its step | b13, owner 2026-11-17 |
| Changed files after a code publication: `phase rollover --confirm <digest>` under `/sf-recover` ("Use /sf-recover for this phase-scoped rollover") | the same confirmation under the step's own work command, which previews it and asks the person | b34, REQ-014 |
| An edited published document in progress: `phase publish <step>` (`/sf-publish`), which opened the next version with nobody asked; restoring it pointed at the document view | its preview (`phase rollover <step> --reason "<what to change>" --json`); restoring is the person's set-aside | b11, D3, REQ-014 |
| `recover` with nothing to repair named no next action | it names the step's real next action | §10 |

**Kept on purpose:** recovery for changed published bytes (it protects them first, §6), a lifecycle appeal problem, an unreadable Story state, a retained publication's backup route and a dirty start's set-aside (they protect bytes or reconcile an interrupted operation); `recover --fetch` for a remote that moved; `CODE_TEST_RESULT_REQUIRED` with a pinned configuration dependency still opens with the recovery read of the configured command (section 12.7).

### 12.4 Qualification journeys

`test/osa-stage3-journeys.test.mjs`, through the real guard (`mutationToolGuard`), the real lease, task and consent stores, and the views; expected results written out from §5, §6 and §8:

| Journey | What it shows |
|---|---|
| A long-running execution with a live heartbeat | A child process holds the Story's lease and renews its heartbeat; `inspectSubjectLease` reads it alive and fresh; every view names `session current`; repeated observation is no loop; a turn opened 31 minutes ago is refused (`PHASE_MUTATION_TURN_EXPIRED`) while a fresh turn still writes the open version; once the execution ends the views name `prepare implement`, and another turn resumes the same task record |
| A revoked writer and an expired yes | A takeover moves the writer fence: the same turn's next write is denied, the kernel names `session takeover`. A yes given 31 minutes ago leaves no grant and its receipt is `VERSION_CONSENT_EXPIRED`; the person's answer renews the turn's window and neither the yes nor the fenced write |
| A missing local attachment, a missing file, a permission error | The task record keeps `waiting-input` (`DOCUMENT_REUPLOAD_REQUIRED`); a later read names `documents readiness` on every view, nothing repeats. A missing required artifact and `PHASE_ARTIFACT_MISSING` keep their codes, with the author's route then the next-step read. A write to another step's artifact is denied by the guard (`PHASE_MUTATION_PATH_DENIED`) before a byte changes, leading with `prepare implement` |
| A failed test with bounded repair | Attempts 1 and 2 of 2 repair in the step; spent, the decisions card; a repair repeated on an unchanged basis is a loop; the refusal and the finding name the step's recheck, never recovery |
| A malformed review citation | The reviewer's turn writes only its exact staging file; the review task's `repair-report` stage names its own context read and opens no version |
| A stale screen, a switched Story, a concurrent window | An unobserved opening is advisory and grants nothing; two windows both write the open version, and once one publishes the other's next write is refused; another Story's files are refused; the action has a Shell and a Copilot line and an explicit model-free status, and the engine sends nothing (VS Code's prefill: `osa-stage3-vscode`) |
| No-progress | An idempotent acknowledgement and a declared wait are no loop; the same action on an unchanged basis is |
| (slow lane) A pending publication; a published document edited in place | Through the CLI with a bare remote that refuses the push: next steps and session current name `singularity-flow sync` and `publication-pending` from separate processes, never recovery; sync sends the same commit and the stage ends. Then the published intake edited in place: recover offers its preview (`phase rollover intake --reason …`), never `phase publish`; the edit and the published bytes are both kept; the preview asks "Start version 2 of Intake? …" and opens nothing |

### 12.5 Ratchet and budgets

**AC-020 ratchet** (totals of the per-module ceilings, locked in with `scripts/osa-inventory.mjs --ratchet`; no rise, no new exception):

| Family | Stage 3 first pass | Completion |
|---|---|---|
| Raw opening reads | 76 | 64 |
| Opening writes | 11 | 11 |
| Lifecycle predicate calls | 214 | 201 |
| Skill and turn chooser calls | 102 | 97 |
| Version arithmetic in place | 38 | 37 |
| Routes built in place | 115 | 114 |
| Lifecycle command literals | 321 | 317 |
| Route skill literals | 112 | 103 |

Falls by module: `recovery-plan.mjs` opening reads 10 → 0, predicates 11 → 0, version arithmetic 1 → 0, routes 7 → 6, commands 15 → 12, skill literals 6 → 2; `phase-resolution.mjs` opening reads 2 → 0, choosers 6 → 1, skill literals 3 → 0; `gate-recovery.mjs` commands 6 → 4; `refusal-remediation.mjs` skill literals 23 → 21; `commands/nextsteps.mjs` predicates 5 → 3.

**Budgets:**

| Ceiling | Before | Completion measured | Change |
|---|---|---|---|
| Lifecycle handlers' bytes | 9,747,600 (`phase-lifecycle` 9,747,581) | `phase-lifecycle` 9,751,587 | **raised to 9,751,600** (+4,006), measured and commented in `test/lazy-command-handlers.test.mjs`: the planners' kernel route (`stepRoute`), the kernel's `publication-pending` stage and its render, readiness naming it. The comments of the first draft were cut to keep it there; the stage's readers and the session-opening read stay lazy |
| Lifecycle handlers' files | 473 | `submit` 473 | none, no new eager file |
| Session current | 4,279,100 | 4,279,062, 221 files | none |

Plain language: 0 new, 5 fixed and locked in (`benchmarks/plain-language/baseline.json`). Git bypass audit: 2,013 sites, no new one.

### 12.6 Targeted runs

Node 22, through the isolated runner at concurrency 2, targeted files only; no touched set, no full run.

| Run | Files | Result |
|---|---|---|
| Completion qualification | `osa-stage3-journeys` (7 fast tests), `osa-stage3-continuation` (7) | pass |
| Slow lane (`SINGULARITY_FLOW_TEST_SLOW=1`), alone | `osa-stage3-journeys` "a publication left pending … a published document edited in place" | pass |
| Refusals and planners | `refusal-remediation`, `phr-routing`, `approval-intervening-commits`, `refusal-story-next`, `refusal-ways-out`, `refusal-plumbing`, `refusal-renewal-route`, `refusal-routes-test-risk`, `refusal-first-routes`, `refusal-routes-test-coverage-flow`, `phr-refusal-plans`, `phr-owner-checks`, `publication-retry-refusals`, `unknown-step-refusals`, `gate-recovery`, `upstream-route-dead-ends`, `upstream-coverage-decision`, `terminal-publication-routes`, `dead-end-routes`, `phase-resolution-rca`, `finding-routes-audit`, `publication-preflight`, `phase-appeals`, `phase-publication-readiness`, `node-pin-flow`, `phase-contract-recovery`, `phase-prepublish`, `phase-entry`, `phase-repair-loop`, `findings-loop`, `conformance-gap-decisions`, `decision-list-plan-accounting`, `lifecycle-worktree`, `sda-acceptance-007-010-020` | pass after the test changes below, but one pre-existing red |
| Sessions and surfaces | `handoff`, `session-open`, `session-open-local`, `session-read-service`, `session-entry-view`, `session-entry-bounded`, `session-roster`, `workspace-clone-resume`, `story-start-handoff`, `command-skills`, `nextsteps`, `submission-readiness`, `workflow-task-resume`, `workflow-task-completion`, `kernel-step-routes`, `step-routes-stage1`, `osa-stage1-kernel`, `osa-stage1-shadow`, `osa-stage1-skills`, `osa-stage1-guard`, `phase-mutation-contract`, `agent-output`, `agent-hooks`, `review-next-step`, `confirmation-routes`, `no-dead-end`, `route-audit`, `document-step-routes`, `phase-authoring-progress`, `phase-authoring-continuation`, `changes-after-publication-cli`, `step-sheet-shadow`, `source-clause-bindings`, `spk-fastpath`, `skill-efficiency`, `iac-chat`, `oap-m3-one-list`, `vscode-outcome-review`, `git-index-lock-wait`, `journey-routes` (fast tier), `post-code-handoff`, `copilot-guidance`, `native-copilot-efficiency`, `person-step-golden` | pass, but one pre-existing red |
| Must stay green | `osa-ratchet`, `osa-stage0`, `lazy-command-handlers` (after the measured raise), `plain-language`, `source-inspection`; the scripts `plain-language-check` (0 new), `git-bypass-audit` (no new site), `build-docs-manifest` | pass |
| Repository check | `node check-iso.mjs <worktree>` (`scripts/check.mjs`) | pass: 3,786 checks |

**Tests changed, each to the new route with its reason (none weakened):** 20 assertions pinned the recovery detour: the containment's `recover <W> --phase <step>` (`refusal-remediation` ×7, `phr-routing` kept its id, `approval-intervening-commits`, `step-routes-stage1`), a failed test's `recover` (`refusal-routes-test-risk`, `phase-resolution-rca`), gate recovery's `recover --phase <owner>` (`gate-recovery` ×3, `upstream-route-dead-ends` ×2), the changed-files rollover under `/sf-recover` (`publication-preflight` ×4 and the retry's `beforeRetry`), the edited document's `phase publish` (`phase-appeals`), the task resume's `recover` for a pending publication (`workflow-task-resume`), and the outcome list (`osa-stage3-continuation`). Two fixtures were made consistent with what they test: `gate-recovery`'s pinned-owner Story now has its earlier steps approved and its current step in progress, and `upstream-route-dead-ends` submits from an in-progress final step.

**Reds, both pre-existing (by reading; not run at `dac523e22`):**
- `phase-publication-readiness` "missing MCP evidence and a missing required host are actionable without starting any server" expects "this phase generation" where `src/phase-publication-readiness.mjs:182` says "this version" since `8ac43fb0f`, before `dac523e22`. Neither file changed here.
- `person-step-golden` "the tables, and every person's step against the turns that differ most, have not moved": its golden table lacks the `version-opened` and `version-writer-taken-over` lifecycle members Stage 2 added (`abdcca2ba`). Neither the vocabulary nor the golden changed here.

### 12.7 Decisions for the owner

| # | Decision | What was done; the recommendation |
|---|---|---|
| 1 | The lifecycle handlers' eager budget, raised again by 4,006 bytes | Accepted at the measured value. **Recommendation:** let Stage 5 lazy-load the planners' kernel route behind their refusal paths when it removes the duplicates. |
| 2 | A healthy phase refusal now offers the step's next-step read instead of `recover` and the document view | Done (D4). An approval turn keeps its end-of-turn step and the approver's own evidence read. **Recommendation:** confirm. |
| 3 | `publication-pending` renders as `singularity-flow sync`, without the Work ID | Kept as the skills' `state=publication_pending` contract and next steps already say it; the exact commit is in the decision's inputs. **Recommendation:** Stage 4's central map names `sync <WORK-ID>` once the skill texts move with it. |
| 4 | `running` is read from a live lease held by another process on this machine | A lease on another machine, or a stale heartbeat, is not observed as running. **Recommendation:** keep; a cross-machine execution observation needs its own record. |
| 5 | `resume` now runs the shared session-opening read | It reports the binding and the kernel's next steps instead of a fixed `prepare`, and costs the binding read (also when `start` resumes an existing Story). A failed read is reported, never a failed resume. **Recommendation:** confirm. |
| 6 | `CODE_TEST_RESULT_REQUIRED` with a pinned configuration dependency still opens with a recovery read | Left (a configuration defect, not a failed test). **Recommendation:** Stage 5 replaces it with the policy read (`story test-policy`). |

### 12.8 For the merge with Stage 4

- `src/step-decision.mjs`: two additions only, `stepRoute` (after `stepDecisionOf`) and the `publish-version` case before `default` in `decisionRoutes`. If Stage 4 moves `decisionRoutes` into its central map, both move with it; `recovery-plan.mjs`, `phase-resolution.mjs`, `gate-recovery.mjs` and `collaboration.mjs` import `stepRoute` from `step-decision.mjs`.
- No new command name: every route uses a command the map already renders (`nextsteps`, `sync`, `phase rollover`, `phase prepublish`, `session current`, `session takeover`, `upstream-issue raise`, `status --submission-readiness`).
- Skill texts were not changed.
