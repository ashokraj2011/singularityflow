# OSA Stage 5 — duplicates removed, the map as the one renderer, and qualification

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) sections 4.3, 5, 8, 10 and 14; REQ-003, REQ-010–012, REQ-020–023, REQ-041, REQ-051; AC-003, AC-006, AC-020, AC-022; implementation plan section 7, and the parts [stage3.md](stage3.md) section 11 and [stage4.md](stage4.md) section 11 left for Stage 5.
**Branch:** `osa-v11-s5`, from the 11-17 landing `d5522e815` (main `ea398577f`, OSA Stages 0–4 with Stage 3 completed, SPEC-SCF stages 2–5, the 11-16 small fixes). Built beside `osa-v11-s5b`, same base, which owns VS Code's decisions card, the Copilot hook's skill lists from `writingAlias`, the AC-019 alias cases and the red `review-source-cli` and `person-step-golden` tests; none of those were changed here.
**Status:** the stage's implementation and its targeted qualification, **with named parts not done** (section 11). The heavy run (full suite on Node 22, then the weekly Node 26 run) has not been made; it comes after this report. Live Copilot host behaviour is the owner's daily paid run, not run here.
**Acceptance rows:** every requirement and acceptance row, with its qualifier, runtime, host mode and limitation, is in [coverage-matrix.md](coverage-matrix.md); activation and reversal in [activation.md](activation.md).

## 1 What changed

| # | Item | What | Where |
|---|---|---|---|
| 1 | The map | The action-to-command map moved to its own module, with **named Shell forms** per operation (`preview`, `begin`, `prepare`, `reconcile`, `recover`, `pending`, …). It holds the work command's resolution (`workCommandOf`, `actionSkill`) and the exact submission (`submitRoute`, which absorbed `submit-route.mjs`). It loads no kernel | `src/action-command-map.mjs` (new); `src/submit-route.mjs` (deleted) |
| 2 | The renderer | `decisionRoutes` builds every command from the map's named form (`actionRoute`); no command line is written in its cases any more | `src/step-decision.mjs` |
| 3 | Other renderers | The post-preparation route, the review delegation's packet, retention and status commands, the entry classification's inspection, damage and preview routes, and the submission route read the map | `commands/shared/prepared-phase-next-actions.mjs`, `review-subagent.mjs`, `phase-authoring-entry.mjs`, `action-command-map.mjs` |
| 4 | Routes that named recovery | Prepublish's lead for changed files after a retained publication (b39) and for a code step with no open version; the coverage refusal's `diagnosticCommand`; `TRP_PUBLICATION_PENDING` and `TCA_PUBLICATION_PENDING`; the pinned test configuration read; `return`'s fixed `prepare` (section 4) | `phase-prepublish.mjs`, `state.mjs`, `spec-coverage-preview.mjs`, `refusal-remediation.mjs`, `cli.mjs` |
| 5 | Deleted | Two unused predicate wrappers: `opensCodeVersion` (a raw intent read with `=== nextPhaseGeneration`, V-7) and `consumedByPublishedGeneration` (P-10, a copy of the kernel's `consumedByPublishedVersion`); `return`'s use of `phasePreparationCommandLines` | `code-delivery-policy.mjs`, `phase-generation.mjs`, `cli.mjs` |
| 6 | Guard | The edit guard and the entry read the step's task stage and pass it to the kernel; the task record is stamped so a stage recorded during a turn derives the grant again (section 5) | `copilot-mutation-guard.mjs`, `phase-entry-context.mjs`, `phase-mutation-contract.mjs`, `workflow-task-outcome.mjs` `readGuardTaskOutcome`, `workflow-task-store.mjs` `workflowTaskRecordFile` |
| 7 | Kernel | A published step whose execution still runs (a submission's tests under the Story's lease) is `waiting` and observed, not submitted; readiness renders it | `kernel/step-state.mjs`, `submission-readiness.mjs` |
| 8 | Lazy reducer | The planners load the kernel's route on their own paths (section 6) | `recovery-plan.mjs`, `collaboration.mjs`, `state.mjs`, `phase-prepublish.mjs` |
| 9 | Ratchet | Seven Stage 5 families, the final owner set, every exception left a final owner (sections 7 and 8) | `scripts/osa-inventory.mjs`, `benchmarks/osa/ratchet.json`, `test/osa-ratchet.test.mjs` |
| 10 | Qualification | `test/osa-stage5.test.mjs` (10 tests); the coverage matrix; the performance comparison; activation and reversal | `test/`, `docs/osa/` |
| 11 | Help | The recovery topic's example for changed published files names the step's work command, not `/sf-recover` (version 30) | `docs/topics/recovery.md`, `src/docs-manifest.json` |

## 2 One renderer: the map's named forms (REQ-021, AC-003)

Every kernel operation has an entry in `ACTION_COMMANDS` with its Copilot command and its **named Shell forms**. `<step>` and `<W>` are filled from the decision's target and Story; any other `<…>` is the person's placeholder.

| Operation | Forms |
|---|---|
| `open-version` | `preview` (consent), `begin` (code), `prepare` (document) |
| `build-version` | `prepare`, `preview` |
| `author-version`, `repair-version` | `prepare` |
| `publish-version` | `prepublish` (`--publish-if-ready`), `check` (a deterministic step's code), `draft` (an authored draft), `pending` (`sync`) |
| `start-review` | `context`, `retain` (`review-source submit <step>`), `status` |
| `submit-version` | `readiness`, `exact` (plus the decision values, `submitRoute`) |
| `approve-step` | `approve`, `reject` |
| `decide` | `story` (`decision show`), `card` (`decisions`) |
| `recover-operation` | `reconcile` (an uncertain opening), `recover` (positive damage) |
| the rest | one form each, as at Stage 4 |

`actionRoute(operation, form, { step, workId, detail, skill })` is the only way `decisionRoutes` builds a route; a form the map does not name gives no route. `osa-stage5` renders every kernel operation, for a code and a document step, with nine kinds of inputs and both submission modes, and checks that each command is one of the map's forms filled in (more than 100 routes).

## 3 Wrappers (§4.3)

| Old symbol | Now | Callers |
|---|---|---|
| `successorGenerationOpen` | exact delegate of `hasOpenVersion` | unchanged |
| `phaseNeedsGeneration`, `stepBeingWritten` | exact delegates of `needsVersion`, `beingWritten` | unchanged |
| `hasPublishedPhaseGeneration` (P-4) | exact delegate of `publishedVersionRecorded`, **kept as the historical-and-recorded query**: it is not `currentVersionPublished` and was not reinterpreted as one | 17 mentions, not reclassified one by one |
| `requiresProspectivePhaseInspection` | alias of `stepBeingWritten` | unchanged |
| `nextPhaseGeneration` | the kernel's `versionNumbers().next`, validated | unchanged |
| `phaseExplicitlyReopened` | exact delegate of `explicitlyReopened` | unchanged |
| `opensCodeVersion` | **deleted**: no caller since Stage 3 | — |
| `consumedByPublishedGeneration` | **deleted**: no caller; `osa-stage1-kernel` now checks the kernel's `consumedByPublishedVersion` against the same independent definition | — |

## 4 Routes that named recovery for healthy work (stage3.md §11)

| Before | Now |
|---|---|
| Prepublish of a retained publication whose files changed: `recover <W> --phase <step>` (`/sf-recover`), then recovery's plan named the work command (b39) | The recovery plan's own route leads: the step's work command previews the next version with the changed files and asks the person. `recover` stays only when the plan names no route |
| Prepublish of a code step with no open version: `phase rollover` or `phase begin` chosen in place (a raw intent read and its own "returned" test) | Positive damage keeps `recover`; otherwise the kernel's route, as every other surface names it |
| `SPEC_COVERAGE_INCOMPLETE` (`state.mjs`, `spec-coverage-preview.mjs`): `diagnosticCommand: recover …` | No diagnostic: the author's own recheck (`phase prepublish <step> --for-agent --json`) lists the open obligations |
| `TRP_PUBLICATION_PENDING`, `TCA_PUBLICATION_PENDING`: `recover --json` (`/sf-recover`) | `singularity-flow sync`, the pending publication's continuation (the map's `publish-version` `pending` form) |
| `CODE_TEST_RESULT_REQUIRED` and `CODE_TEST_SUPPRESSED` with a pinned configuration dependency: `recover --json` | `singularity-flow story test-policy show --json`, the Story's pinned policy, as Stage 3 recommended |
| `return`: a fixed `prepare <step>` | The kernel's route for the step (`stepRoute`), printed with its Copilot and VS Code lines |

Each keeps its original code and details. Recovery still leads for an unreadable or integrity-broken retained publication, staged governed paths, a scope refusal's set-aside, a consumed opening that is not the published version's receipt, and an unreadable publication marker: each protects bytes or reconciles an operation.

## 5 The guard reads the task stage (§8, REQ-010, REQ-012)

**Where it is read.** When the guard builds a turn's record (at the prompt, and when a command refreshes it), and at the phase entry, `readGuardTaskOutcome` reads the step's task record and, failing an outcome there, a running execution's live lease. Both are private files; nothing runs Git (REQ-041). It hands on the **repair and running stages**; the decision is the kernel's: `deriveMutationContract({ …, task })` passes the stage into the snapshot, so the entry's permission and the guard's grant stand on one basis, and on the views' basis for those stages.

| Task stage | Guard |
|---|---|
| `repair-required`, budget left | the open version's writes, unchanged |
| `repair-required`, budget spent | **no writes**; the refusal names `singularity-flow decisions <W>` (`/sf-decide`) |
| `waiting-input`, `waiting-environment`, `waiting-person` | **not handed to the guard**: the turn keeps the version's writes while the person decides, as before Stage 5; every view names the wait (decision 6) |
| `running` | the version's writes, unchanged (an execution is observed, never a stop) |
| `publication-pending` | not read by the guard: the views name `sync`, and the CLI's own publication gate refuses the next lifecycle mutation until it runs |

**Within a turn.** The task record's file is one of the turn record's stamps. When a repair is spent while the turn is open, the next write finds the stamp changed and the grant is derived again: the write is refused. `osa-stage5` walks this through the real guard: attempt 2 of 2 writes, the budget is spent, the same turn's write is refused, a new turn is refused with the card's route, and the file is unchanged.

**`running` beyond an open version.** A published step with nothing open whose Story lease is held by another live process (a submission's tests) is now `waiting`, `inspect` (`session current --for-agent --json`) on every view, with no writes. Before, the views named the submission again while it ran. A step with nothing published keeps its own action. A lease held on another machine is still not observed (its owner cannot be read here).

## 6 The reducer behind the rare paths (stage3.md §6 item 3, §12.7 item 1)

| Path | Before | Now |
|---|---|---|
| The recovery planner's kernel route (`kernelAction`, `approvedPhaseActions`) | static import of `step-decision.mjs` | loaded where the route is named |
| Finding resolution in the recovery planner (`phaseResolutionChoices`) | static import of `phase-resolution.mjs` | loaded for a retained submission's quality findings |
| `recover`'s healthy answer (`collaboration.mjs`) | static | loaded where it answers |
| Gate recovery's reopen check (`state.mjs` `reopenWorkflow`) | static import of `gate-recovery.mjs` | loaded on the reopen path |
| Prepublish's retained-publication readiness | static import of `submission-readiness.mjs` (and its review continuation) | loaded for a retained publication |

**Measured** (the test's own graph walk, before at `d5522e815`, after at this tree):

| Closure | Before | After | Change |
|---|---|---|---|
| `phase-lifecycle.mjs` | 9,772,838 bytes, 458 files | 9,678,093, 452 | −94,745: `phase-resolution.mjs`, `submission-readiness.mjs`, `source-review-continuation.mjs`, `phase-authoring-progress.mjs`, `finding-catalog.mjs`, `step-sheet-route.mjs` and `submit-route.mjs` left it; `action-command-map.mjs` joined it |
| `submit.mjs` | 9,737,238, 473 | 9,740,923, 473 | +3,685: the map (7,407) less `submit-route.mjs` (1,187) and the moved code |
| `start.mjs` | 9,753,366, 465 | 9,731,681, 464 | −21,685 |
| Session current | 4,288,926, 221 | 4,288,014, 221 | −912: the deleted wrappers |

**Ceilings lowered to what was measured** (`test/lazy-command-handlers.test.mjs`): lifecycle handlers **9,772,850 → 9,740,950** (the largest is now `submit.mjs`); session current **4,288,950 → 4,288,050**. Files: unchanged ceilings (473 and 221), none reached by a new file.

**Where the reducer stays eager, and why.** A command whose own narration names the next step after it succeeds (start, submit, approve, prepare, review-source, inputs) needs the decision on its normal path, so loading it later would save nothing. `sequence.mjs` builds a refusal's `storyNext` details synchronously at some 20 throw sites, and gate classification (`classifyStoryGateFailures`) is synchronous: making those lazy needs each throw site and its callers made asynchronous. Not done here (section 11).

## 7 The final owner set (plan section 7, "Delete")

| Owner | Modules | Holds |
|---|---|---|
| Decision | `kernel/step-state.mjs`, `kernel/step-versions.mjs` | the state, permission, primary action, predicates and version arithmetic |
| Adapter | `step-decision.mjs` (`stepSnapshotOf`, `stepDecisionOf`, `decisionRoutes`, `stepRoute`), `phase-generation-need.mjs` (`versionFactsOf`, the predicate wrappers) | the snapshot from the Story record, the decision's rendering |
| Map | `action-command-map.mjs`, `command-skills.mjs` (`WORK_COMMANDS`) | the commands and skills a route shows |
| Validator | `safe-command-guidance.mjs` | whether a command and skill may be shown |
| Readers of the reducer | `step-decision.mjs`, `phase-mutation-contract.mjs` (the guard's and the entry's permission), `commands/phase-opening.mjs` (the opening operation) | only these import `kernel/step-state.mjs`; the ratchet fails on any other |

**Named exceptions left:** four, each marked `final` with no deletion target: the adapter's `phaseKernelOwned` classification (normalizer), the map's one chooser call and its one `/sf-recover` literal, and `WORK_COMMANDS`'s two names. Deleted: the Stage 3 exceptions of `phase-authoring-entry.mjs` and `phase-prepublish.mjs`, `step-decision.mjs`'s three renderer exceptions, `prepared-phase-next-actions.mjs`'s and `review-subagent.mjs`'s. The test now fails on any exception that is not `final` or that names a stage as its deletion.

## 8 Ratchet (AC-020)

**The Stage 0 families** (totals of the per-module ceilings):

| Family | Stage 4 (landing) | Stage 5 |
|---|---|---|
| Raw opening reads | 64 | 61 |
| Opening writes | 11 | 11 |
| Lifecycle predicate calls | 201 | 200 |
| Skill and turn chooser calls | 97 | 95 |
| Version arithmetic in place | 37 | 37 |
| Routes built in place | 114 | 107 |
| Lifecycle command literals | 317 | 299 |
| Route skill literals | 104 | 96 |

**The Stage 5 families** (`STAGE5_FAMILIES`), which see what the Stage 0 ones could not: their baseline is this count, and they only fall.

| Family | What it counts | Stage 5 |
|---|---|---|
| `kernelImports` | an import of the reducer (static or dynamic) or a `stepState` call | 6 in 3 modules, the readers of section 7 |
| `kernelPredicateCalls` | a call of a kernel version predicate, by any import path | 32 in 15 modules |
| `mapRoutes` | the map's renderers or tables used outside it (through an import only: a same-named table elsewhere is not the map) | 25 in 6 modules |
| `argvRoutes` | an array that starts a lifecycle command as argv | 209 in 65 modules |
| `computedCommands` | a command line whose verb is computed (template or concatenation) | 77 in 32 modules |
| `altSkillLiterals` | a route skill's bare id in any case (`sf-recover`, `SFLOW-CODE`) | 34 in 6 modules |
| `routeFields` | a renamed route field (`recoveryCommand`, `authoringSkill`, …) holding a lifecycle command or a step skill | 19 in 11 modules |

`test/osa-ratchet.test.mjs` adds four tests: the Stage 5 families only fall; only the final owner set imports the reducer; synthetic sources show each new detection firing (and that the Stage 0 families miss them); and a module the ratchet has never seen fails on its first decider in any family.

**For the merge with `osa-v11-s5b`:** the Stage 5 families cover `apps/vscode/src`, as the Stage 0 families always did. A VS Code change that adds an argv route or a computed command line there raises its module's count: run `node scripts/osa-inventory.mjs --ratchet` only for a fall, and name anything else.

## 9 Decisions for the owner

| # | Decision | What was done; recommendation |
|---|---|---|
| 1 | The guard and a publication left pending | The guard reads the task record and a running execution, not the pending publication (the views do, and name `sync`). Conservative: no write that the guard allowed before is refused for it. **Recommendation:** keep; the CLI's publication gate already refuses the next lifecycle mutation. |
| 2 | `running` after publication | Applied only to a published step with nothing open; a step with nothing published keeps its own action even while a lease is held. **Recommendation:** keep; a cross-machine execution record is needed before a lease on another machine can be observed. |
| 3 | Making `sequence.mjs`'s refusal details lazy | Not done: some 20 synchronous throw sites and their callers would become asynchronous, for a few kilobytes, since the narration of most commands needs the reducer anyway. **Recommendation:** leave it, unless a measured hot path needs it. |
| 4 | `phase-preparation-guidance.mjs` | No caller in `src/` now; kept because the VS Code package manifest and its tests list it. **Recommendation:** delete it with the manifest entry in a change that owns packaging. |
| 5 | Prepublish's lead for a step that is not current and in progress | Kept as `recover` (with `/sf-recover`). Leading with the kernel's route instead would name, for a submitted step, its approval (`/sf-approve`) where the existing contract (`phase-prepublish` "routes missing evidence through lifecycle recovery once the phase awaits approval") leads with recovery's return plan. **Recommendation:** for a submitted step, lead with the kernel's `approve-step` pair (approve, or return it with `reject`), which is the person's own route; decide before changing it. |
| 6 | The guard and a wait for an input, the environment or a person | The guard is handed only the repair and running stages. Handing it every wait made the kernel refuse the version's writes while the decisions card waited, which broke journey E ("inside its window, the turn may edit the step's code", the 16 November turn-window incident) in the slow lane; the instruction named only the spent repair budget. **Recommendation:** decide whether a turn may keep writing while a person's decision is pending on the card. If not, hand every stage to the guard (one line in `readGuardTaskOutcome`) and change journey E's first check with it. |
| In force | D1–D8; the own correction asks the person (reversed 2026-11-28: SFlow starts it, with an undo, at most 2 in a row); a failed test offers no `/sf-recover`; document version 1 opening behind `SINGULARITY_FLOW_DOCUMENT_VERSION_OPENING=shared`, off; VS Code `runSubagent` stays a qualified reviewer; no `/sf-next` stop-hook completion; in-turn outcome review as Stage 3 left it | unchanged |

## 10 Targeted runs at Stage 5

Node 22 (22.14.0), through the isolated runner at concurrency 2, targeted files only. No touched set and no full run: the heavy run comes after this report. The machine's load average was between 9 and 27 while these ran (other agents' suites).

| Run | Files | Result |
|---|---|---|
| 1. Stage 5's own, the OSA files and the routes it changed | 56 files: `osa-stage0`, `osa-stage1-{kernel,guard,shadow,skills}`, `osa-stage2-opening`, `osa-stage3-{continuation,vscode,journeys}`, `osa-stage4-{commands,review-delegation,consent-card}`, `osa-ratchet`, `step-role-guidance`, `refusal-remediation`, `refusal-story-next`, `publication-preflight`, `phase-prepublish`, `authoring-skills`, `kernel-step-routes`, `phase-entry`, `phase-authoring-{continuation,progress}`, `step-routes-stage1`, `step-being-written`, `review-next-step`, `phase-governance-routing`, `workflow-task-{completion,resume}`, `submission-readiness`, `nextsteps`, `guide`, `sequence`, `gate-recovery`, `upstream-route-dead-ends`, `phase-resolution-rca`, `finding-routes-audit`, `dead-end-routes`, `terminal-publication-routes`, `phase-contract-recovery`, `spk-fastpath`, `phr-routing`, `upstream-coverage-decision`, `phase-mutation-contract`, `agent-output`, `post-code-handoff`, `confirmation-routes`, `test-recovery-store`, `refusal-routes-test-risk`, `code-generation-assurance`, `gjy-cross-machine-return`, `phase-appeals`, `story-test-command-amendment-lifecycle`, `phase-retention`, `phase-publication-readiness`, `no-dead-end` | 882 tests: 858 pass, 7 fail, 17 slow-lane skips. Six of the failures pinned a route or a grant Stage 5 changed. Four tests were changed to the new route, each with its reason (`publication-preflight` b39, `phase-prepublish` "refuses a code phase before its governed generation begins", `refusal-remediation` twice); for the other two the code was put back (prepublish's lead for a submitted step, decision 5; the guard and a task's wait, decision 6). The seventh is red at the base (section 10b) |
| 2. The changed files again | `osa-stage3-journeys`, `phase-prepublish`, `publication-preflight`, `refusal-remediation`, `osa-stage5`, `lazy-command-handlers` | 205 tests: 204 pass, 0 fail, 1 slow-lane skip |
| 3. Neighbours | 61 files: `agent-hooks`, `changes-after-publication-cli`, `cic-chat-entry`, `confirm-code`, `copilot-hook-{launcher,runtime}`, `copilot-repository-boundary`, `copilot-turn-renewal`, `docs-layer`, `docs-packaging`, `doctor-model-freedom`, `documentation-{consolidation,privacy}`, `exit-ratchet`, `git-bypass-audit`, `phase-repair-loop`, `phr-{amendment-plan-rows,later-step-tests,owner-checks,ratchet,refusal-plans}`, `plain-language`, `recovery-{phase-evidence,preparation-context}`, `requested-successor-{cli,document-cli}`, `review-subagent-cli`, `review-visual-evidence`, `sda-inventory`, `sda-m5-takeover`, `session-entry-{bounded,view}`, `session-read-service`, `snapshot`, `source-inspection`, `step-sheet-shadow`, `still-holds-in-chat`, `vscode-outcome-review`, `vscode-step-action-deliveries`, `vscode-surface-parity`, `osa-stage3-vscode`, `settled-decisions`, `journey-routes` (fast tier), the `refusal-*` files, `publication-retry-refusals`, `unknown-step-refusals`, `approval-intervening-commits`, `lifecycle-transitions`, `rework-lifecycle`, `document-step-routes`, `session-open`, `handoff`, `command-skills`, `copilot-guidance`, `phase-publication-readiness`, `person-step-golden` | 552 tests: 533 pass, 2 fail, 17 skips. Both failures are red at the base (section 10b) |
| 4. The qualification matrix: concurrency, crash, cache, takeover, role and presence, repair budget, historical evidence | `osa-stage2-opening` (the race, faults at six points, replay, takeover), `repair-budget`, `phase-retention`, `sda-m5-retention`, `sda-m5-takeover`, `lease-liveness`, `file-lease`, `governed-push-lease`, `read-scope-concurrency`, `auto-candidate-crash-recovery`, `sf-guard-person-steps`, `person-step-catalog`, `generation-publication`, `session-listing-cache`, `git-fact-cache`, `intent-amendment-retention`, `workflow-task-{completion,resume}` | 209 tests: 196 pass, 0 fail, 13 slow-lane skips |
| 5. After the guard's narrowing (section 9, decision 6) | `osa-stage5` (10), `osa-stage3-journeys`, `osa-stage1-guard`, `osa-ratchet`, `lazy-command-handlers` | 36 tests: 35 pass, 0 fail, 1 slow-lane skip |
| 6. Slow lane (`SINGULARITY_FLOW_TEST_SLOW=1`) | `journey-stories` (A, B, D–G, I), `osa-stage4-journeys` (J, D1, D5), `kernel-step-routes`, `deterministic-code-step`, `settled-decisions-flow`, `osa-stage2-journey-h`, `osa-stage3-journeys`, `journey-routes`, `review-every-step-cli`, `vscode-bundle-budget`, `cli-bundle` | 82 tests: 78 pass, 4 fail. Journey E failed through the guard's first rule (decision 6), fixed in `b0529142d`; the two `vscode-bundle-budget` checks are red at the base (section 10b) |
| 7. Slow lane again, after `b0529142d` | `journey-stories`, `osa-stage3-journeys` | **pass: 47 tests, 0 failed, 0 todo**: journeys A, B, D, E, F, G, I and every Stage 3 journey, KNOWN_BAD empty |
| Scripts | `scripts/plain-language-check.mjs` (0 new, 1 fixed and locked in), `scripts/git-bypass-audit.mjs` (2,003 sites, no new one; was 2,013), `scripts/build-docs-manifest.mjs` (93 topics), `scripts/osa-inventory.mjs --ratchet` | pass |
| Performance | `scripts/osa-perf-baseline.mjs --samples=3 --modes=source,bundle`, paired with `d5522e815` | [stage5-perf.md](stage5-perf.md): 0 Git processes on every guard row, modules unchanged but one fall, +1 or +2 file reads per row, every outcome the same |
| Repository check | `node check-iso.mjs <worktree>` (`scripts/check.mjs`) | pass: 3,807 checks (at `d7b7cd691`, and again before this record's commit). Its first run, before the deletion of `submit-route.mjs` was committed, failed only on reading that path from the index |

### 10b Reds, each also red at `d5522e815`

| Test | Also red at `d5522e815` | Why, and whose |
|---|---|---|
| `no-dead-end` "the first route of each known refusal is classified …" | **yes**, run there unchanged: the same three codes | `SKP_AMENDMENT_ANCESTRY_LIMIT`, `_REWRITTEN`, `_UPGRADE_REQUIRED` lead with a read-only route and are not on the dead-end list: SPEC-SCF's ancestry refusals, not OSA's |
| `requested-successor-cli` "a change the person asks for after Code is published opens generation 2 …" | **yes**, run there unchanged: the same difference | Stage 4's rule that a step named after the work command is never recorded as what the person asked for (`asked-for.mjs`) strips `implementation` from the request this test types; the test predates the rule. Not changed here (the alias cases are `osa-v11-s5b`'s) |
| `person-step-golden` "the tables, and every person's step …" | yes (Stage 3 §12.6, and the brief) | on `osa-v11-s5b` |
| `vscode-bundle-budget` (two checks) | **yes**, measured there: the same five failures and numbers (`gateway-runtime` 884 modules of 882, `help-runtime` 139 of 136, `support-runtime` 114 of 111, `lazy-panels-runtime` 3,559,862 bytes, `runtime-prewarm` 114,998) | the 11-17 landing merged bundles over their ceilings. Stage 5 adds +10,785 bytes to `gateway-runtime.cjs` (under its 7,730,000) and +12 to `extension.cjs`, no module. No ceiling was raised |
| `review-source-cli` | yes (stage4.md §10b) | not run here; on `osa-v11-s5b` |

## 11 What is not done

- **Not every route built in place was moved.** The ratchet's remaining counts are routes and command literals in planners and producers (lifecycle command literals 299, routes built in place 107, argv routes 209, computed command lines 77). They cannot grow, and some may be renderers of their own command's output rather than step routes; they were not each classified or moved. "No supported surface keeps an independent authoring-state decision" is met for the step's state and primary action (every surface reads the kernel), not for every secondary route a planner lists.
- **Producer details that still name `recover`:** a clause source owed by an earlier step (`state.mjs` `implementationEntryRefusal`, `phase-prepublish.mjs` `recoveryCommand`), a convergence step whose publication record is missing (`phase-transition-routes.mjs`), and prepublish's lead for a step that is not current and in progress. The last was changed and then put back: for a submitted step it would have led with approval where the existing contract leads with recovery's return plan, an owner question rather than a mechanical change.
- **Examples in help topics** were swept only for `recover` as a healthy route: `docs/topics/recovery.md` (version 30) now names the step's work command for changed published files. Other examples were not swept.
- **`sequence.mjs`'s refusal details and gate classification** keep the reducer eager (section 6, decision 3).
- **The P-4 wrapper's 17 callers** were not reclassified one by one (section 3); the wrapper keeps its meaning.
- **`phase-preparation-guidance.mjs`** is unused in `src/` but kept (decision 4).
- **On `osa-v11-s5b`:** VS Code's decisions card, the hook's skill lists from `writingAlias`, the AC-019 alias cases, the red `review-source-cli` and `person-step-golden` tests.
- **Not run:** the full suite, the weekly Node 26 run, a real reversal to a pre-OSA build, live Copilot.
