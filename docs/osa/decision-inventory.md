# OSA Stage 0 — decision inventory (call sites and owners)

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md), plan §2 item 3, and AC-020.

**Base:** `d7a976821`. Every `file:line` below is on that commit; paths are under `src/` unless shown otherwise.

**Method.** The code was read and grepped, never run. The starting point was the design review of 16 November (the "46 deciders", counted at `56dfa031e`). Each row was re-located on this branch. "Changed" names the commits since `56dfa031e`:
- review-next `fb368d49b`;
- kernel-step-route `5baaba5d1`;
- turn-renew `7436ec3ff`;
- refusal-next-step `1cfb2c986` and `7a2bbf482`;
- review-visual-evidence `197f25f31`;
- the misspelt-step names `6343414ae`;
- chat-prefill;
- OSA v1 stage 1: `13066fe33`, `f749b5fed`, `4787ce1ef`, `e5570c373`, `3c998fbed`, `322fca509`.

Merge commits only resolve imports, budgets and the docs manifest.

**How to read the tables.**
- **Kind** is P for policy (it decides a state, a permission or a route). N is a normalizer or record writer, V a validator, R a renderer, C a classifier (the step's kind, from configuration only). Normalizers, validators and renderers are kept apart from policy, as the plan requires.
- **Owner after OSA** is where the decision goes in v1.1:
  - `kernel`: `src/kernel/step-state.mjs` ([kernel-location.md](kernel-location.md));
  - `adapter`: the host command map (REQ-021);
  - `coordinator`: the operation coordinator;
  - `storage`: the storage adapter;
  - `execution`: the execution owner;
  - `guard`: the pre-tool guard, which keeps its fresh mutation checks but takes eligibility from the kernel.
- **Stage** is the plan stage that moves it.
- **Reproducer** is the test that pins today's behaviour. "None" means no test pins it, which Stage 1 must fix before it moves the row.

## 1 Counts by decider type

| Type | Review (`56dfa031e`) | This branch | New since the review |
|---|---|---|---|
| May edit, permission, task done | 10 (a1–a10) | **15** (a1–a15) | a11 act follows the permission; a12 published reviewer start; a13 turn window; a14 successor-consent binding; a15 submit refusal while open |
| Next action, route | 27 (b1–b27) | **41** (b1–b41) | b28–b41 (§3) |
| Which skill or command | 7 (c1–c7) | **14** (c1–c14) | c8 `successorSkillForPhase`; c9 `opensCodeVersion`; c10 step commands take the work command; c11 `stepHandoff`; c12 `storyNextDetails`; c13 containment rule; c14 hard-coded skills inside deciders |
| **All deciders** | **46** | **70** | |
| …of which not policy | — | 11 | V: c3. R: c4, b4, b17, b27, b29, b35, b36. N: b19, b28. Mapping with deciding defaults: b41 |
| Shared predicates | 8 tests | 11 (P-1 to P-11) | P-3 `stepBeingWritten`, P-11 `opensCodeVersion` |
| Meanings of "published" | 6 | 6 distinct (Pub-2 to Pub-7) plus inline copies | Pub-4 gained a second status |
| Version computations | — | 9 groups (V-1 to V-9) | Sites at V-3 and V-5 came with review-next and `197f25f31` |

The count grew because the fixes taught new places about new states (a12, a14, a15, b28–b41, c8–c13). This inventory is the list Stage 1's ratchet stops from growing.

## 2 What v1 stage 1 already unified, and what still decides on its own

**`stepBeingWritten`** (`phase-generation-need.mjs:45`, which is `in_progress && (phaseNeedsGeneration || successorGenerationOpen)`) **replaced a separate test in nine places** (`13066fe33`):

| # | File and function (line) | The test before |
|---|---|---|
| 1 | `phase-mutation-contract.mjs` `deriveMutationContract`, `editable` (:147) | An inline copy with the same meaning |
| 2 | `phase-inspection-generation.mjs` `requiresProspectivePhaseInspection` (:19), now a pure alias | `in_progress && (!hasPublished \|\| needsGeneration)`. Its 20 call sites now follow P-3. Behaviour changed in three edge states (§4, P-5). |
| 3 | `phase-authoring-progress.mjs` `phaseAuthoringProgress` (:61) | `!phaseNeedsGeneration`. An open next version now has its task (C5). |
| 4 | `guide.mjs` `nextActions` (:152) | `phaseNeedsGeneration`. P-1 is still used at :150 and :157. |
| 5 | `nextsteps.mjs` `plannedNextSteps`, `submitsTheEnd` (:298) and `needsGeneration` (:365) | P-1 (C18) |
| 6 | `commands/nextsteps.mjs` `resolveStorySnapshot` (:255, :305) | `!P-1` (the task-resume `published`) |
| 7 | `sequence.mjs` `sequenceGuidance` (:96, :98, :114) | `in_progress && P-1` |
| 8 | `source-review-continuation.mjs` `sourceReviewContinuation` (:69) | `!P-1`. Its new branch at :73 uses P-2, not P-3. |
| 9 | `submission-readiness.mjs` `submissionReadinessSnapshot` (:382, :383, :388) | P-1 |

The `requiresProspectivePhaseInspection` call sites that row 2 reaches:

| Module | Lines |
|---|---|
| `phase-authoring-entry` | :22 |
| `recovery-plan` | :59, :344 |
| `phase-repair-runtime` | :29, :47, :126 |
| `draft-evidence-hold` | :18, :58 |
| `phase-prepublish` | :516 |
| `phase-draft-check` | :129 |
| `phase-publication-unchanged` | :20 |
| `phase-journey` | :12 |
| `phase-journey-inspection` | :20 |
| `phase-artifact-risk` | :108 |
| `scope/authoring` | :16 |
| `phase-evidence-amendment` | :71, :195 |
| `commands/nextsteps` | :83 |
| `phaseInspectionGeneration` | :23 |

**The other stage 1 items:**

| Commit | What it unified |
|---|---|
| `f749b5fed` | The entry's act is `author` only when the permission grants an edit (`agent-output.mjs:487-491`) |
| `4787ce1ef` | A step not being written takes `stepHandoff` (`phase-mutation-contract.mjs:112`, used at :194), not `recover`. `sourceEditPrerequisite` is gated on `editable` (:287-288). Phase show's catch-all no longer says recover (`review-continuation.mjs:42-50`). |
| `e5570c373` | Step commands and refusal `nextAction` objects name the step's work command (c10) |
| `3c998fbed` | No recover or phase show beside a refusal whose first route writes the step (c13) |
| `322fca509` | `sflow-code` step 2 follows the entry's act (c7) |

**Still deciding "being written" on its own** (its own P-2/P-1 combination, or a raw "open" check):

| Module | Function and lines |
|---|---|
| `guide.mjs` | `phaseHandoff` :92, :97, :101 |
| `sequence.mjs` | `openVersionGuidance` :149 |
| `recovery-plan.mjs` | `inspectPhaseRecovery` :325-327 |
| `code-delivery-policy.mjs` | `codeOutcomeReviewOffer` :434 |
| `copilot-mutation-guard.mjs` | `publishedReviewerStart` :2165 |
| `phase-entry-authoring.mjs` | `reviewCorrection` :267-268 |
| `source-review-lifecycle.mjs` | `checkPublishedGeneration` :70; `loadSourceReviewStatus` :823 |
| `state.mjs` | `submitPhaseTransition` :5614 |
| `phase-authoring-summary.mjs` | :32 |

**Still treating an open version 2 as published** (P-1 alone):

| Module | Lines and effect |
|---|---|
| `cli.mjs` | `nextCommand` :2054, which routes to submit; a15 then refuses it |
| `review-subagent.mjs` | `reviewerSubagentStart` :208-210 |
| `verification/witness-records.mjs` | `republicationRoute` :188. **No test.** |
| `commands/nextsteps.mjs` | `storyPrerequisites` :109 |
| `guide.mjs` | :35, :157 |
| `source-review-lifecycle.mjs` | :533, :835, :902 |
| `state.mjs` | :2781, :3770, :5652 |
| `cli.mjs` | `runCommand` :6002 |

**Still reading "published" from an entry status or an event, not from the step:** Pub-4, Pub-6, Pub-7, and the guard's task check (a4 :278-283).

## 3 The matrix

### 3.1 May edit, permission, task done (a)

| ID | `file:line` and function | Reads | Returns | Reproducer | Kind | Changed since `56dfa031e` | Owner after OSA, REQ, stage |
|---|---|---|---|---|---|---|---|
| a1 | `phase-mutation-contract.mjs:135` `deriveMutationContract`. `openGeneration` :143-144, `editable` :147, deterministic :148-149, application :173-174, `next` :175-201, `allow.artifacts` :222 | status; raw `generationIntent` against `nextPhaseGeneration`; P-3; `generationPolicy.allowedProducers` (inline); `writeScope`; pause; turn mode; `handoff` | `policy{editable, openGeneration}`, `allow{artifacts, application, staging}`, `next[]`, `summary`, `authoringSkill` | `phase-mutation-contract`, `step-being-written`, `step-routes-stage1`, `phase-authoring-progress` | P | `13066fe33` (P-3); `4787ce1ef` (`stepHandoff`; recover only for a consumed intent that is not the published version's, :197-198); `f749b5fed` | kernel (eligibility, next); guard keeps the path checks; REQ-001, 002, 010, 011; stage 1 |
| a2 | `phase-mutation-contract.mjs:281` `mutationContractPresentation` (`codeAuthoringReady` :285, `sourceEditPrerequisite` :287-288) | a1 | presentation fields | as a1 | P (presentation) | `4787ce1ef` | kernel, then adapter; REQ-010, 020; stage 1 |
| a3 = c6 | `phase-mutation-contract.mjs:52` `mutationTurnMode` | **the typed skill's name only** | turn mode | `phase-mutation-contract`, `exit-ratchet`, `helpers/skill-admission` | P | Unchanged. New consumer: `SUCCESSOR_BOUND_MODES` (guard :19-20) | kernel (`turn`), adapter maps skill to role; REQ-010, 024, 027, 050; stages 1 and 4 |
| a4 | `copilot-mutation-guard.mjs:234` `createRecord`. Step changed during the turn → read-only (:237-239). Raw open read :241. a1 **without `handoff`** :244. Task complete :278-283. Raw `openGeneration` :292. Runtime: `currentContract` :1613, `mutationToolDecision` :2186 | a1, a3, the turn record | the turn's contract record, `taskOperation.complete` | 15 files through `mutationToolGuard`; journeys through the real guard (`ce1b89ecc`) | P | `7436ec3ff` (`turnExpired`); `197f25f31` (:300-302); `e5570c373` | guard over kernel; REQ-010, 041, 012, 050; stage 1 |
| a5 | `phase-entry-admission.mjs:2` `phaseContextAdmission` | entry status, `phaseKernelOwned`, recovery, references, inputs | `{allowed, blockers, pendingEvidence}` | `phase-entry`, `phase-inputs-readiness-routing` | P | Unchanged | kernel (prerequisites); REQ-010, 026; stage 1 |
| a6 | `phase-entry-authoring.mjs:61` `completePhaseEntry`. `kernelBuilt` :87, deterministic :100-101, `authoringAllowed` :126, `codeAuthoringReady` :127-128, status chain :205-211, `reviewCorrection` :267-268 | a5, clarification, a2, entry status, raw `intent.generation === generation + 1` | status, `authoringAllowed`, `next`, `successor` | `phase-entry`, `kernel-step-routes`, `review-next-step`, `review-every-step-cli` | P | `5baaba5d1` (`deterministic-generation`); `fb368d49b` (`successor-confirmation-required`, `reviewCorrection`) | kernel; REQ-010, 005, 026; stage 1 |
| a7 | `agent-hooks.mjs:417` `agentGuardHook` (the non-Copilot hook), :459-468 | raw consumed and same version (an inline P-10) | deny, naming `recover` (:466) | `agent-hooks` (:347, :471 pin the text) | P | **Unchanged**: it ignores rework and reopen and still names recover (C19) | guard over kernel; REQ-010, 011, 022; stage 3 |
| a8 | `phase-authoring-progress.mjs:17` `phaseTaskCompletion`; :59 `phaseAuthoringProgress` (P-3 :61, raw open :63-65, damage → `/sf-recover` :68-69) | entry, P-3, raw intent | task state, `nextAction` | `workflow-task-completion`, `step-being-written`, `kernel-step-routes` | P | `13066fe33`, `5baaba5d1`, `e5570c373` | kernel (`task`), execution; REQ-012; stages 1 and 3 |
| a9 | `copilot-review-completion.mjs:135` `workflowTaskAgentStop` (:142); `copilot-mutation-guard.mjs:2786` `recordPhaseTaskProgress` (:2795) | `taskOperation`, `contract.generation + 1` | the stop hook holds with `SFLOW_WORKFLOW_TASK_INCOMPLETE` | `workflow-task-completion` | P | **Unchanged**: `+ 1` ignores the high-watermark (C22) | kernel (`version.writing`); REQ-012, 002; stage 1 |
| a10 | Kernel refusals: `state.mjs:2342` `preparePhaseInputs` (:2379-2395); `state.mjs:2305` `beginPhaseGeneration`; `generation-boundary.mjs:77` `beginCodeGeneration` (:88-89); `commands/phase-lifecycle.mjs` rollover :114, begin :207-210, publish :314-321; `generation-boundary.mjs:268` `requireOpenGenerationIntent` (:274-280); `state.mjs:3741` `publishGeneration` (:3767-3776) | raw intent, `phaseExplicitlyReopened`, `nextPhaseGeneration` | refusal code with `nextAction` | `publication-preflight`, `step-routes-stage1:110`, `refusal-remediation` | P | `e5570c373`: `nextAction` objects with `successorSkillForPhase` or `generationSkillForPhase` | coordinator (mutation checks), kernel (post-refusal next); REQ-022, 030, 031; stages 2 and 3 |
| a11 | `agent-output.mjs:297` `agentAct`: permission override :487-491, deterministic :506 | entry `mutationContract.applicationEdits` and `.artifacts` | act `next` instead of `author` | `step-routes-stage1:30`, `kernel-step-routes`, `dead-end-routes` | P | new in `f749b5fed`, `5baaba5d1` | adapter maps the kernel's `next` to an act; REQ-010; stage 1 |
| a12 | `copilot-mutation-guard.mjs:2151` `publishedReviewerStart` (called :2270-2271) | **loads the Story with Git inside the pre-tool path** (`loadAcceptedStoryExecution`); its own `!P-2 && !P-1` (:2165); `writing = openGeneration ?? generation + 1` (:2167) | allows a reviewer delegation without a current contract | `review-visual-evidence` | P | new in `197f25f31` | guard over kernel; REQ-010, 052, 041; stage 1 (the Git read on the fallback path) |
| a13 | Turn window: `copilot-mode.mjs:204` `TURN_WINDOW_MS`, :213, :228, :239; guard `turnExpired` :34, `renewOnAnswer` :1889, `noteCardOpened` :2000, `renewTurnAfterCardAnswer` :2017 | `recordedAt`, `renewedAt` | whether the window has expired | `copilot-turn-renewal`, journey E | P (liveness) | new in `7436ec3ff` | execution and guard; REQ-051; stage 3 |
| a14 | Successor-consent binding: guard `SUCCESSOR_BOUND_MODES` :19, `successorConfirmationOfCall` :1427, `noteTaskQuestion` :1895 (:1919-1925); `copilot-answer-binding.mjs` | `phase rollover --confirm` (also a `confirm` code), the turn's answer ledger | deny unless the person said yes in this turn | `review-next-step` | P | new in `fb368d49b` | coordinator plus consent receipt; REQ-030; stage 2 |
| a15 | `state.mjs:5587` `submitPhaseTransition` (:5614-5620) | P-2 | refuses `PHASE_VERSION_BEING_WRITTEN` with `storyNextDetails` | journey G | P | new in `13066fe33` | coordinator gate, kernel next; REQ-032, 022; stage 3 |

### 3.2 Next action, route (b)

The "Open v2 / kernel" column says whether the decider knows an open next version, and whether it knows a step SFlow builds itself.

| ID | `file:line` and function | Output | Open v2 / kernel | Reproducer | Kind | Changed | Owner, REQ, stage |
|---|---|---|---|---|---|---|---|
| b1 | `phase-authoring-entry.mjs:10-52` `phaseAuthoringEntry` | `{status, reason, actions}`. **reviewError → `recover` /sf-recover (:17-21)**. authoring-entry (:22-31); `successor-confirmation-required` (:35-42); `successor-preparation-required` (:43-49) | yes / no | `step-routes-stage1:44`, `review-next-step:102`, `phase-authoring-continuation:116`, journey F | P | `fb368d49b`, `f749b5fed` | kernel; REQ-001, 010; stage 1 (reviewError → REQ-003, stage 3) |
| b2 | `phase-entry-authoring.mjs:61-285` `completePhaseEntry` | status chain :205-211; `next` :212-227; **`/sf-appeal` inspect :242-246**; successor :273-276 | via b1 / yes | `kernel-step-routes:37,66`, `review-every-step-cli`, `cli-bundle` | P | `5baaba5d1`, `fb368d49b` | kernel; REQ-001, 010; stage 1 |
| b3 | `agent-output.mjs:470-514` `agentAct` (entry branch) | act: confirm (:479-485), next ← permission (:487-491), author (:492-496), next ← generator (:506-511), first now (:513) | entry status; author only on a grant | `step-routes-stage1:30`, `review-next-step:63,102`, journey F | P (status → act map) | `fb368d49b`, `5baaba5d1`, `f749b5fed` | adapter over kernel `next`; REQ-010, 020; stage 1 |
| b4 | `phase-authoring-summary.mjs:18-68` `phaseAuthoringSummary` | handoff = b5; offer ordering (:51-54) | yes / no | `authoring-skills` | R (plus ordering) | unchanged | adapter; REQ-020; stage 3 |
| b5 | `guide.mjs:48-64` `requestedSuccessorAction`, :71-120 `phaseHandoff`, :122-167 `nextActions`, :169 `workflowGuide` | being written → task stage; open → prepare (:92-96); review (:100-104, :112-118); approve or reject (:143-147); rollover via `successorSkillForPhase` (:39-41, :55-63) | yes / partly (deterministic → prepare :157-165) | `step-being-written:99`, `review-next-step`, `phase-contract-recovery` | P | `fb368d49b`, `13066fe33` | kernel; REQ-001, 020; stage 3 |
| b6 | `nextsteps.mjs:260` `plannedNextSteps` | recovery (:271-278 → /sf-recover); rows; `submitsTheEnd` (:298) | yes / partly | `step-being-written:155,169`, `nextsteps`, `dead-end-routes` | P | `13066fe33`, `fb368d49b` | kernel (now), adapter ("then" rows); REQ-020; stage 1 (now row), stage 3 |
| b7 | `commands/nextsteps.mjs:78` `storyPrerequisites` (/sf-resume :99-105), :195 `resolveStorySnapshot` (:255, :303-308) | the /sf-resume prerequisite; `taskResume.published = !P-3` (:305) | yes / yes | `workflow-task-resume`, `kernel-step-routes:66` | P plus N | `13066fe33`, `5baaba5d1` | kernel; REQ-012, 020; stage 1 |
| b8 | `source-review-continuation.mjs:60-113` `sourceReviewContinuation` | prepare the open version (:73-80); rollover /sf-code (:87-90); phase begin (:92-93); prepare (:94-95); /sf-review-decide; submit; review-source | yes / no | `step-being-written:116`, `review-next-step:63,90,154`, `phr-routing` | P | `fb368d49b`, `13066fe33`, `f749b5fed` | kernel; REQ-020, 032 (stage 3); the consent ask is REQ-030 (stage 2) |
| b9 | `phase-authoring-progress.mjs:59-93` (see a8) | stages: **review-successor → recover /sf-recover (:68-70)**, open-code-generation → phase begin, validate, draft | yes / null (task via `generate`) | as a8 | P | `13066fe33`, `5baaba5d1`, `e5570c373` | kernel; REQ-012; stages 1 and 3 |
| b10 | a1 `next` and `stepHandoff` (:112-120); caller `phase-entry-context.mjs:25-28`, :75-77 | paused → /sf-decide (:187); not editable → handoff, else `nextsteps --json` (:194, :118-119); damage → recover (:197-198); begin (:199-200); prepare (:201) | yes / yes | `step-routes-stage1:59,82`, `step-being-written:57,84` | P | `13066fe33`, `4787ce1ef`, `f749b5fed` | kernel; REQ-001, 010, 011; stage 1 |
| b11 | `recovery-plan.mjs:294` `inspectPhaseRecovery` (raw intent :99-100, :112, :153, :326-327, :444-446, :690, :702) | changed bytes → b34; **edited published document → `phase publish` /sf-publish (:365-368)** and restore (:369-378); runner missing → prepare; submit-published; node pin → /sf-decide | no / no | `publication-preflight`, `phase-appeals`, `review-every-step-cli` | P | `fb368d49b` (:645-660) | kernel (damage facts only), coordinator; REQ-003, 011, 014; stage 3 |
| b12 | `refusal-remediation.mjs:2019` `remediationPlanFor` (storyNext :2105, writingStep :2111); :226-264 `phaseContainmentSteps`; :333 `requiredTestFailureSteps`; :1959 `unknownStepPlan`; ~30 refusal codes | producer route first; containment unless story-next, writing the step, unknown step or recover | only via the producer's details / no | `refusal-remediation`, `step-routes-stage1:110,130`, `refusal-story-next`, journeys D and G | P plus R | `1cfb2c986`, `fb368d49b`, `3c998fbed` | kernel post-refusal next, adapter rendering; REQ-022; stage 3 |
| b13 | `phase-resolution.mjs:87` `phaseResolutionChoices` (default /sf-recover :20; INTENT_REQUIRED → begin /sf-code :284-289; ALREADY_CONSUMED → recovery :290-291) | resolution route plus skill | no / no | `phase-resolution-rca`, `finding-routes-audit` | P | wording only | kernel; REQ-022, 003; stage 3 |
| b14 | `phase-governance-routing.mjs:8-52` `phaseGovernanceHold` | author conflict: agent, reject when submitted, **rollover with no status check (:42-46)**, prepare (:47-49) | no / no | `phase-governance-routing:84`, `iac-chat` | P | `fb368d49b` (skill only) | kernel (`held`); REQ-005, 023; stage 3 |
| b15 | `submission-readiness.mjs:285` `submissionReadinessSnapshot` (writing :382-412, record :414-436, review :438-454, ready :456-464) | `{classification, nextCommand, nextSkill, lifecycleReady}` | yes / partly | `step-being-written:130`, `submission-readiness`, journey G | P | `13066fe33` | kernel; REQ-020, 032; stage 3 |
| b16 | `sequence.mjs:68-126` `sequenceGuidance` | open → prepare; being written → begin or prepare, then publish; published → submit or readiness | yes; **review corrections: no** / partly | `step-being-written:145`, `sequence` | P | `13066fe33`, `f749b5fed` | kernel; REQ-020, 022; stage 3 |
| b17 | `review-continuation.mjs:21-52` `reviewContinuation` (phase show) | readiness next (:36-40); on error the planner's own next (:42-50) | via b15 | `step-routes-stage1:90` | R (plus recovery gate) | `4787ce1ef` | adapter; REQ-011, 020; stage 3 |
| b18 | `workflow-task.mjs:179-233` `workflowTaskResume` | recover (:192-196); nextsteps; draft-check; **`phase enter --compose` (:213-218)** | via caller / **no** | `workflow-task-resume`, `step-routes-stage1:110` | P | `e5570c373` | kernel (`task.continuation`); REQ-012, 026; stages 3 and 4 |
| b19 | `workflow-task-store.mjs:282` `readWorkflowTaskResume`, :291 `resumeWorkflowTask`, :121-126 `taskEntryGuidance`, :355 ARTIFACT_GENERATED | b18's output; the callers' `published` | callers agree now | `workflow-task-resume` | N | `e5570c373` | execution (task record); REQ-012; stage 3 |
| b20 | `phase-transition-routes.mjs:4-31` `convergenceTransitionRoute` | prepare /sflow-converge; recover /sflow-recover; advance /sflow-submit | via its argument / convergence only | **none by name** (via `submission-readiness`, `dead-end-routes`) | P | wording only | kernel; REQ-026; stage 4 |
| b21 | `source-review-lifecycle.mjs:68-87` `checkPublishedGeneration` (SUCCESSOR_OPEN :69-77); :809-843 `loadSourceReviewStatus` | refusal `nextAction`; status continuation = b8 | yes / no | `step-routes-stage1:130`, `review-next-step` | P plus N | `e5570c373`, `13066fe33` | kernel; REQ-022, 032; stage 3 |
| b22 | `state.mjs` refusals: prepare ALREADY_CONSUMED :2379-2394; publish ALREADY_CONSUMED :3767-3776; submit SOURCE_REVIEW_REQUIRED :5660-5684; approve :6887-6912; no work interval :6289-6293 | `nextAction` objects | no / no | `step-routes-stage1:110,130`, `publication-preflight` | P | `e5570c373` | coordinator, kernel; REQ-022; stage 3 |
| b23 | `commands/phase-lifecycle.mjs` rollover :114-200 (preview skill :151-170); begin :205-232; publish :312-321; PHASE_DRAFT_NOT_ACTIVE :238-242 | the preview carries **/sf-recover** for changed bytes | no / code only | `publication-preflight:3466-3470`, `review-next-step:246`, journey G | P | `e5570c373`, `fb368d49b`, `1cfb2c986` | coordinator; REQ-030 (stage 2), REQ-022 (stage 3) |
| b24 | `generation-boundary.mjs:268-283` `requireOpenGenerationIntent`; :253-266 `closedByAmendment` | `nextAction{phase begin, generationSkillForPhase}` | no / no | `step-routes-stage1:110` | P | `e5570c373` | coordinator, kernel; REQ-022; stage 3 |
| b25 | `commands/shared/prepared-phase-next-actions.mjs:10-95` (:18-37) | kernel-built → prepublish **/sf-publish (:32-34)** | n/a / yes | `authoring-skills:230-266`; journeys A and B KNOWN_BAD `osa-stage-3-c9` | P | wording only | coordinator; REQ-026; stages 3 and 4 |
| b26 | `gate-recovery.mjs:120-158` `openStoryRecovery` (:128-132), :189-194, :255-261, :340 | recover, reject, next | no / no | `gate-recovery`, `terminal-publication-routes`, `upstream-route-dead-ends` | P | unchanged | kernel (damage only); REQ-003, 011; stage 3 |
| b27 | `apps/vscode/src/views/submission-presentation.ts:75-155`, :44-58 | **a review state keeps a skill only when it is /sf-review-source (:132)**; S5 label (:118) | via b15 | `vscode-step-action-deliveries` | R plus filter | unchanged | adapter; REQ-020; stage 3 |
| b28 | `sequence.mjs:133-141` `storyNextDetails`, :146-154 `openVersionGuidance` | `details{storyNext, nextAction}` at 22 call sites in 13 files | yes / partly | `step-being-written:145`, `refusal-story-next:93-221` | N (the decision is b16's) | `1cfb2c986`, `7a2bbf482`, `13066fe33` | kernel; REQ-022; stage 3 |
| b29 | `source-review-continuation.mjs:52-58` `continuationPresentation`; `agent-output.mjs:568`, :589-596; `commands/review-source.mjs:123-124`, :240 | the "Now —" block | via b8 | `review-next-step:63-100`, `review-every-step-cli` | R | `fb368d49b` | adapter; REQ-021, 060; stage 4 |
| b30 | successor-confirmation-required: `phase-authoring-entry.mjs:35-42`; `phase-entry-authoring.mjs:207-208`, :214, :275-276; `agent-output.mjs:479-485`; `phase-entry.mjs:27-28` | "Start version N to fix the review's findings?"; act confirm | n/a / no | `review-next-step:102,246`, journeys B and F (F todo) | P | `fb368d49b` | kernel (`review-corrections`), coordinator; REQ-030; stage 2 |
| b31 | deterministic-generation: `phase-entry-authoring.mjs:100-101`, :211, :216-221, :280; `agent-output.mjs:504-511`; `phase-authoring-progress.mjs:19-20`, :34-37; `commands/nextsteps.mjs:99-101` | prepare, then `prepublish --publish-if-ready` | n/a / yes | `kernel-step-routes:37-100`, `spk-fastpath` | P | `5baaba5d1` | kernel (`kernel-build`), coordinator; REQ-026; stage 4 |
| b32 | `state.mjs:5606-5620` PHASE_VERSION_BEING_WRITTEN (= a15) | refusal plus b28 | yes | journey G (`journey-stories:430-443`) | P | `13066fe33` | as a15 |
| b33 | `refusal-remediation.mjs:213-224` `routesToWritingTheStep`; :2106-2112, :2170 | drops recover and phase show | partly / no | `step-routes-stage1:130` | P | `3c998fbed`. **:220 reads `details.stepBeingWritten`, which no producer sets: a dead branch.** | kernel; REQ-022; stage 3 |
| b34 | `recovery-plan.mjs:151-251` `generationRecovery`, route :229-246 | begin-new-generation → `phase rollover --confirm <digest>` with **skill /sf-recover (:245)** and the text at :243 | no / no | `publication-preflight:3035,3058,3440,3468` (they pin /sf-recover) | P | unchanged | kernel (damage), coordinator (opening with consent); REQ-014, 030; stages 2 and 3 |
| b35 | `apps/vscode/src/views/journey-model.ts:226-384` `storyJourneyOf`; `views/tree-model.ts:802-909` `storyPhaseActions` | journey `nextAction`; **null when the review state's skill is not /sf-review-source** | via b15 and b27 | `vscode-step-action-deliveries`, `vscode-extension`, `vscode-decision-list` | R plus filter | unchanged | adapter; REQ-020; stage 3 |
| b36 | `apps/vscode/src/chat-prefill.ts:84-118` `nextChatPrefill` | chat input text, never sent | via b35 | `vscode-chat-prefill:53-198` | R | new (chat-prefill) | adapter; REQ-050, 020; stage 3 |
| b37 | Guard turn boundary: `copilot-mutation-guard.mjs:236-246` (phase changed → read); `phase-mutation-contract.mjs:309-318` `mutationDenial`; refresh-entry :2820-2822 | deny plus `contract.next` (`nextsteps --json` when not editable, because no handoff is passed) | yes / yes | `step-routes-stage1:59`, `phase-mutation-contract:364`, journey `guardedStory` | P (turn boundary) plus R | `7436ec3ff`, `fb368d49b`, `197f25f31`, `e5570c373` | guard, kernel (`turn`); REQ-010, 050; stages 1 and 3 |
| b38 | Publication result: `code-delivery-policy.mjs:430-443` `codeOutcomeReviewOffer`; `commands/phase-lifecycle.mjs:622-651`; `agent-output.mjs:441-456`; `review-subagent.mjs:164-186` | the /sf-outcome validation ask, or the reviewer sub-agent | n/a | `post-code-handoff`, `vscode-outcome-review`; journey G KNOWN_BAD `osa-stage-3` | P | review-subagent text `fb368d49b` | kernel (`published` → start-review or submit); REQ-020; stage 3 |
| b39 | `phase-prepublish.mjs:341` `staticPublicationBlockers` (outside files → recover :335; pending publication :355-363; **INTENT_REQUIRED plus consumed → recover /sf-recover :389-395**); lead action :646-668 | correction, `commands.next` | no / no | `publication-preflight:3458-3463` | P | wording only | kernel; REQ-003, 011; stage 3 |
| b40 | `requested-successor.mjs:69-160` (:86-99); `own-correction-rollover.mjs:54-67`; `changes-after-publication.mjs:65-75`; `code-delivery-policy.mjs:379` | rollover preview and confirm by `successorSkillForPhase` | n/a | `review-next-step`, `changes-after-publication-cli` | P (skill choice) | `fb368d49b` | coordinator, consent; REQ-030; stage 2 |
| b41 | `command-skills.mjs:256-269` (`phase` and `prepare` → sf-phase; begin and rollover → sf-code); `safe-command-guidance.mjs:381-416` (`--confirm` adds /sf-recover :387; prepublish adds /sf-publish :399); `copilot-guidance.mjs:91-103`, :117-129 (fallback /sf-next) | skill, `copilotCommand` | no / no | `step-routes-stage1:101`, `review-next-step:154` | R with deciding defaults | `e5570c373`, `fb368d49b` | adapter (the central map); REQ-021; stages 4 and 5 |

### 3.3 Which skill or command (c)

| ID | `file:line` | Rule now | Reproducer | Kind | Changed | Owner, REQ, stage |
|---|---|---|---|---|---|---|
| c1 | `code-delivery-policy.mjs:312` `authoringRoute`, :367 `generationSkillForPhase` | none → null; deterministic convergence → /sflow-converge; configured skill; code → /sflow-code; else /sflow-phase | `authoring-skills`, `vscode-workflow-studio`, `code-generation-assurance` | P (mapping) | unchanged (call mentions 69 → 79) | adapter (skill), kernel (`kind`); REQ-021, 024; stage 4 |
| c2 | `command-skills.mjs:229` `COMMAND_LINE_SKILL_ROUTES` (`phase` :262-267, `prepare` :268), resolver `skillForCommandLine` :515 | rollover → sf-code; **begin → sf-code**; show → sf-phase-documents; publish → sf-publish; prepare and enter default to sf-phase | `command-skills`, `journey-routes`, `step-routes-stage1:101` | P (mapping) | `fb368d49b`, `e5570c373` | adapter; REQ-021, 027; stages 4 and 5 |
| c3 | `safe-command-guidance.mjs:350` `safeCommandGuidance` (:380-416) | keeps a route's skill only when its command accepts it | 33 test files | **V** | `fb368d49b`, `e5570c373` | adapter (validator, named exception); REQ-021, 023 |
| c4 | `copilot-guidance.mjs:33` `copilotSkillForCommand` (fallback **/sf-next**); :116 `skillRouteForCommand` (:126-128) | — | `copilot-guidance`, `review-next-step` | R | :126-128 `fb368d49b` | adapter; REQ-021, 023; stage 4 |
| c5 | hard-coded literals | see §5 | — | — | — | adapter (ratchet); REQ-021; stages 1–5 |
| c6 | = a3 | | | | | |
| c7 | Skill texts: `plugin/skills/sflow-code/SKILL.md:21`, `sflow-phase/SKILL.md:20`, `sflow-next/SKILL.md:21` | sflow-code follows the entry's act; sflow-phase relays a non-/sf-phase step; sflow-next never runs /sf-code | `plugin`, `phase-authoring-skills`, `skill-efficiency`, `scripts/skill-policy.mjs:320` | P (prose) | `322fca509` (sflow-code only) | skills follow the issued action (AC-008); REQ-021, 024, 025; stage 4 |
| c8 | `code-delivery-policy.mjs:379` `successorSkillForPhase`. Callers: `state.mjs:2389`, :2391, :3775; `phase-lifecycle.mjs:136`, :320; `own-correction-rollover.mjs:66`; `requested-successor.mjs:86`; `guide.mjs:40` | code → /sf-code; else c1 with /sflow- rewritten to /sf- | via `review-next-step`, `step-routes-stage1:110` | P (mapping) | `fb368d49b` | adapter; REQ-021; stage 4 |
| c9 | `code-delivery-policy.mjs:189` `opensCodeVersion` (callers `sequence.mjs:108`, `source-review-continuation.mjs:92`) | a code step with no `open === next` intent gets begin, else prepare (raw intent) | `step-routes-stage1:44` | P | `f749b5fed` | kernel; REQ-002, 021; stage 1 |
| c10 | Step commands take the work command: `phase-authoring-progress.mjs:10`; `workflow-task-store.mjs:121`; `workflow-task.mjs:208`, :215; guard :2826-2827; `generation-boundary.mjs:278-279`; `source-review-lifecycle.mjs:70-76`; `state.mjs:6291-6293` | routes carry `generationSkillForPhase` or `effectiveAuthoringSkill` | `step-routes-stage1:101,110` | P | `e5570c373` | adapter; REQ-021, 022; stage 4 |
| c11 | `phase-mutation-contract.mjs:112` `stepHandoff`; `phase-entry-context.mjs:26` `storyHandoff` (:76-77) | a step not being written takes `sequenceGuidance().actions`, else nextsteps. **Only the entry passes `handoff`; the guard (:244) and the prompt composer (`phase-prompt-composer.mjs:495`, :563) do not.** | `step-routes-stage1:59,82` | P | `4787ce1ef` | kernel; REQ-011, 020, 010; stage 1 |
| c12 | = b28 (`storyNextDetails`; consumer `refusal-remediation.mjs:2105`) | | | | | |
| c13 | = b33 (`routesToWritingTheStep` :219, `phaseContainmentSteps` :226) | | | | | |
| c14 | Hard-coded skills inside deciders: `phase-authoring-entry.mjs:18` (/sf-recover on a review error), :28 (/sf-code rollover); `phase-governance-routing.mjs:47`; `phase-mutation-contract.mjs:198` and `phase-authoring-progress.mjs:69` (/sf-recover for damage); `phase-transition-routes.mjs:21` (/sflow-recover) | — | per file | P | `4787ce1ef`, `f749b5fed`, `fb368d49b` | adapter; REQ-021, 003; stages 3 and 5 |

### 3.4 Shared predicates and the meanings of "published"

| ID | Where | True when | Files / mentions: review → here | Reproducer | Kind | Owner, REQ |
|---|---|---|---|---|---|---|
| P-1 `phaseNeedsGeneration` | `phase-generation-need.mjs:20` | author conflict, skill amendment, version 0, rework, rejected not rewritten. **Ignores an open next version.** | 21/66 → 17/53 | `lifecycle-transitions`, `rework-lifecycle`, `phase-authoring-continuation` | P | kernel; REQ-002 |
| P-2 `successorGenerationOpen` | :14 | intent open and its version > `generation` (not `=== next`) | 5/10 → 9/19 | `step-being-written`, `review-next-step` | P | kernel (`hasOpenVersion`); REQ-002 |
| P-3 `stepBeingWritten` | :45 | `in_progress && (P-1 \|\| P-2)` | 0 → 11/26 | `step-being-written`, `step-routes-stage1` | P | kernel (`state === writing`); REQ-002, 010 |
| P-4 `hasPublishedPhaseGeneration` | `phase-inspection-generation.mjs:5` | version ≥ 1, intent not open, and (consumed and same version, or a publication record with a path) | 11/20 → 11/19 | `phase-appeals` | P | kernel. It **mixes** history with "no open intent": see the note after this table. REQ-002 |
| P-5 `requiresProspectivePhaseInspection` | :18 | **now an alias of P-3** (was `in_progress && (!P-4 \|\| P-1)`) | 15/34 → 15/34 | `step-being-written`, `grounding-paths` | P (wrapper) | kernel; REQ-002 |
| P-6 `phaseInspectionGeneration` | :22 | P-5 ? `nextPhaseGeneration` : `generation` | 11/24 | `phase-authoring-continuation` | version selector | kernel; REQ-002 |
| P-7 `phaseExplicitlyReopened` | `sequence.mjs:58` | open change request, rework with P-1, affected skill amendment with P-1, or intent amendment not revalidated | 5/9 | `dead-end-routes` | P | kernel (`reopened`); REQ-001, 005 |
| P-8 `phaseKernelOwned` | `code-delivery-policy.mjs:218` | deterministic and not code | 7/15 → 8/17 | `kernel-step-routes`, `authoring-skills` | C | kernel (`kind`); REQ-026 |
| P-9 `phaseUsesDeterministicGeneration`, `deterministicOnlyGeneration` | `manual-authorship.mjs:98`, `code-delivery-policy.mjs:265` (inline copies at `phase-mutation-contract.mjs:148-149` and `phase-prompt-composer.mjs:493`) | the producer is deterministic | 8/17, 3/10 | `phase-authoring-progress`, `authoring-skills` | C | kernel (`kind`) |
| P-10 `consumedByPublishedGeneration` | `phase-generation.mjs:22` | consumed and same version (the receipt, not damage) | 3/5 (14 inline copies, V-8) | `step-routes-stage1:82` | P | kernel; REQ-002, 003 |
| P-11 `opensCodeVersion` | `code-delivery-policy.mjs:189` | code step and not (open && `=== next`) | 3/5 | `step-routes-stage1` | P | kernel; REQ-002 |
| Pub-2 `publicationIsRecorded` | `submission-readiness.mjs:31` (`currentPublication` :17) | the record has a path and a sha256; ignores the intent | 1/3 | `submission-readiness` | V | storage-record validator, a named exception; REQ-002 |
| Pub-3 | `phase-transition-routes.mjs:12-18` | an inline copy of the record check. Its callers pass P-3, **except `guide.mjs:97`, which passes P-1** | — | none direct | P with embedded V | kernel; REQ-002, 020 |
| Pub-4 | `phase-entry.mjs:28` (:30, :32) | entry status ∈ {retained-generation, successor-confirmation-required} | — | `workflow-task-completion`, `cli-bundle` | P | kernel; REQ-012, 020 |
| Pub-5 | `commands/nextsteps.mjs:305` (:255) | `!stepBeingWritten` | — | `step-being-written` | P | kernel; REQ-012 |
| Pub-6 | `workflow-task-store.mjs:343` `batchWorkflowTaskProgress`, :355 | an ARTIFACT_GENERATED event means the author task is complete | — | `workflow-task-resume` | P (event) | execution (task); REQ-012 |
| Pub-7 | `workflow-task.mjs:179` `workflowTaskResume` (:189) | `published ?? (P-4 && identity === generation && Pub-6)` | — | `workflow-task-resume` | P | kernel; REQ-012 |

**Note on P-4.** v1.1 §4.3 separates historical publication (`hasPublishedVersion`) from current publication (`currentVersionPublished`). P-4 is closer to `currentVersionPublished`, but it also requires a consumed intent or a record path. Replacing it mechanically with either predicate changes behaviour, which §4.3 forbids. Each caller must be classified first.

### 3.5 Version-number computations

| ID | Where | Formula | Owner |
|---|---|---|---|
| V-1 | `phase-generation.mjs:32` `nextPhaseGeneration` | `max(generation, highWatermark) + 1`, validated (`GENERATION_COUNTER_INVALID`); 47 files, 164 mentions | kernel (`proposedNext`); REQ-002 |
| V-2 | `guide.mjs:50`; `changes-after-publication.mjs:67`; `decision-list-reads.mjs:303`; `decision-advice.mjs:33`; `asked-for.mjs:77-79` | inline `max(g, hw) + 1`, unvalidated | kernel |
| V-3 | `copilot-review-completion.mjs:142`; guard :2795, :2167; `phase-entry-authoring.mjs:268`; `workflow-task.mjs:164`; `session-read-service.mjs:118` | `generation + 1` taken as the version being written; **ignores the high-watermark** | kernel (`version.writing`) |
| V-4 | `state.mjs:2388`, :2392, :9551; `phase-authoring-entry.mjs:29`; `own-correction-rollover.mjs:67`, :108; `recovery-plan.mjs:367`; `review-subagent.mjs:180`; `commands/upstream-issue.mjs:351` | `generation + 1` in labels and text | adapter (wording from the decision) |
| V-5 | `source-review-continuation.mjs:89-90` (`nextPhaseGeneration - 1`, **wrong when the watermark > generation**); `phase-authoring-entry.mjs:41`; `commands/departure.mjs:131` | `n - 1` | kernel |
| V-6 | `phase-appeals.mjs:108`; `phase-repair-journal.mjs:46-48`; `work-intervals.mjs:94-101`; `cli.mjs:2807`; `visual-coverage.mjs:27` | each picks `nextPhaseGeneration` or `max(1, g)` by its own rule | kernel |
| V-7 | `phase-mutation-contract.mjs:143-144`; `phase-authoring-progress.mjs:63-65`; `code-delivery-policy.mjs:190-191`; `generation-boundary.mjs:88-89`, :271-274; `phase-lifecycle.mjs:209-210`; `auto/auto-executor.mjs:351`; `amended-drafts.mjs:136`, :189, :257; `recovery-plan.mjs:112` | inline `open && intent.g === next`. P-2 uses `>`, so they **disagree** when the watermark > generation (C22) | kernel (`hasOpenVersion`, `writing`) |
| V-8 | `agent-hooks.mjs:460-461`; `state.mjs:2382-2383`, :3768-3769; `phase-lifecycle.mjs:314-315`; `recovery-plan.mjs:99-100`, :153-154; `review-continuation.mjs:30`; `code-submission-evidence.mjs:47-48`; `changes-after-publication.mjs:28`; `guide.mjs:32-33`; `commands/nextsteps.mjs:207-208`; `collaboration.mjs:260`; `phase-inspection-generation.mjs:8` | inline `consumed && intent.g === g` (copies of P-10) | kernel |
| V-9 | `state.mjs:10286-10293` (`rollForwardRework` :10227) | **the only writer of the high-watermark**; an opening does not advance it | storage (the opening operation); REQ-002, 031; stage 2 |

## 4 State table on this branch

This updates the review's table §1.4. ✗ marks a cell that disagrees with the rest of its row.

| State | Permission and guard (b10, b37) | Entry and act (b1–b3) | Guide and next steps (b5–b7) | Readiness, phase show, VS Code (b15, b17, b27, b35, b36) | Other |
|---|---|---|---|---|---|
| S0 not started | `nextsteps --json` | retained → nextsteps | the current step | phase show → nextsteps | — |
| S1a code v1, before begin | begin /sf-code | author | begin | generation-required, begin /sf-code | sequence: begin |
| S1b code v1 open | prepare /sf-code, application edits | author | prepare | prepare /sf-code | — |
| S1d document v1 | prepare | author | prepare | prepare | — |
| S2 published, no review owed | entry: submit; guard: nextsteps | retained → submit | submit | ready-to-attempt | **publish result → /sf-outcome ✗** (KNOWN_BAD `osa-stage-3`) |
| S3 under review | the readiness read /sf-submit ✗ | review-source context | review | source-review-required | — |
| S4a review ready | the readiness read | submit | submit | ready-to-attempt | — |
| S4b code, corrections | the readiness read ✗ (no ask) | successor-confirmation-required, act confirm | rollover /sf-code "now" | rollover /sf-code; **VS Code: no action, no prefill ✗** | **sequence / storyNext → the readiness read ✗** |
| S4b document, corrections | the readiness read ✗ | successor-preparation-required → prepare, **no ask** | prepare | prepare; **VS Code: no action ✗** | — |
| S5 version N+1 open | editable, prepare /sf-code | author; the task is present | prepare; `taskResume.published` false | generation-required prepare; VS Code label "has not been published" (wording) | review status, SUCCESSOR_OPEN, PHASE_VERSION_BEING_WRITTEN and sequence all say prepare |
| S7 submitted | approve; guard: nextsteps | retained → nextsteps | approve or reject | already-submitted; prefill approve | **author-conflict hold: rollover ✗** |
| S9 returned code | begin /sf-code | author | begin | begin | **prepublish → recover ✗** (`phase-prepublish.mjs:389-395`); **agent-guard hook → recover ✗** |
| S9b/S12b deterministic code | begin (no grants) | act next → begin | **prepare ✗** | **prepare ✗** | sequence: begin |
| S10 reopened, republished, corrections | the readiness read ✗ | **begin /sf-code, act next, no ask ✗** | begin | begin; VS Code: no action ✗ | journey F todo `osa-stage-2` |
| S11 paused by an amendment | /sf-decide | hold → card | hold | hold | consistent |
| S12 kernel-built document | no edits, prepare | deterministic-generation | prepare, no /sf-resume | prepare /sf-phase | **prepare → /sf-publish ✗**; **session resume → `phase enter --compose` ✗** |
| S13 author conflict | **begin or prepare ✗** (the hold is not read) | hold | hold | hold | the hold's prepare refuses ALREADY_CONSUMED |
| S14 superseded by an amendment | not traced | not traced | not traced | not traced | PHASE_DRAFT_PREDATES_AMENDMENT → begin /sf-code |
| S15 watermark > generation | editable, begin (open ≠ next) | not traced | begin | begin | **sequence / storyNext → prepare ✗** (P-2 uses `>`) |

Each cell is backed by the file and line in §3 (b1–b41). The rows marked "not traced" are unresolved, and Stage 1's golden fixtures must set them.

## 5 Contradictions C1–C23 on this branch

| C | Status | Evidence or what remains |
|---|---|---|
| C1 healthy step → recover | **Fixed** for the permission, phase show and sflow-code (`4787ce1ef`, `322fca509`) | Remains: b1 reviewError (:17-21), b39 (prepublish :389-395), a7 agent-guard hook, containment on other refusals |
| C2 open v2 shown as v1's review or submission | **Fixed** (`13066fe33`) | `step-being-written:116,130,145`; journey G. VS Code wording at `submission-presentation.ts:118` |
| C3 refusals add recover and phase show | Partly (`1cfb2c986`, `3c998fbed`) | Other refusals keep containment; `details.stepBeingWritten` is dead |
| C4 skill guessed from the command | Partly (`e5570c373`, `fb368d49b`) | A bare `prepare` or `phase enter` still maps to sf-phase (`command-skills.mjs:262-268`) |
| C5 open work has no task | **Fixed** (`13066fe33`; `5baaba5d1` for kernel-built) | `step-being-written:99` |
| C6 sflow-code text routes to recover | **Fixed** (`322fca509`) | `sflow-code/SKILL.md:21` |
| C7 entry and guard use different tests | **Fixed** for the grant (`13066fe33`, `f749b5fed`) | Remains: the guard's `next` without a handoff (§6 finding 1) |
| C8 correction after rework: no consent | **Fixed**, stage 2 ([stage2.md](stage2.md) §6 item 2) | Journey F checks 2 and 3; the KNOWN_BAD `osa-stage-2` entry is removed |
| C9 kernel-built step: competing routes | Partly (`5baaba5d1`) | b25 /sf-publish, b18 `phase enter --compose` |
| C10 typed name decides the turn | **Open**, stage 4 | `sflow-phase` L20, `sflow-next` L21 ([alias-matrix.md](alias-matrix.md)) |
| C11 one refusal, several skills | Partly | Changed bytes: the refusal says /sf-code but the preview says /sf-recover (b34, b23); b13; b39 |
| C12 hand-edited publication: two options | **Open**, stages 2 and 3 | `recovery-plan.mjs:365-378`; journey I |
| C13 returned code step | **Fixed** for authored code (`f749b5fed`) | Deterministic code step: guide and readiness say prepare (S9b) |
| C14 rollover offered while submitted | **Open** | `phase-governance-routing.mjs:42-46` |
| C15 phase changes during the turn | Now the adopted rule (D7, REQ-050) | `copilot-mutation-guard.mjs:237-243`; prefill in a new turn |
| C16 window expires during work | **Fixed** for a person's answers (`7436ec3ff`) | Long runs: REQ-051, stage 3 |
| C17 local vs shared opening | **Fixed**, stage 2 ([stage2.md](stage2.md) §3) | Every opening is one committed and pushed operation (`story-version-opening.mjs`); a legacy local opening is promoted on the person's yes (§5) |
| C18 last phase with an open successor | **Fixed** (`13066fe33`) | `step-being-written:155` |
| C19 agent-guard hook | **Open** | `agent-hooks.mjs:459-470` |
| C20 author conflict: an impossible route | **Open** | `phase-governance-routing.mjs:47-49` |
| C21 refusal guidance ignores v2 | Partly | Open version fixed; S4b and S10 still → the readiness read (`sequence.mjs:116-121`) |
| C22 next version computed inconsistently | **Open**, stage 1 | V-3, V-5, V-7 against V-1 |
| C23 meanings of "published" | Partly: "being written" is unified, "published" is not | §3.4 |

## 6 Findings not tracked before Stage 0

1. **The guard and the entry build the permission differently.** Only the entry passes `handoff` (`phase-entry-context.mjs:76-77`). The guard (`copilot-mutation-guard.mjs:244`) and the prompt composer (`phase-prompt-composer.mjs:495`, :563) do not. The grant is the same; the `next` differs (REQ-010).
2. **Dead branch.** `refusal-remediation.mjs:220` reads `details.stepBeingWritten`; nothing sets it.
3. **Three places still treat an open version 2 as published:** `cli.mjs:2054`, `review-subagent.mjs:210` and `verification/witness-records.mjs:188`. The last has no test.
4. **a12 reads Git inside the pre-tool path.** It calls `loadAcceptedStoryExecution` on the reviewer-start fallback (`copilot-mutation-guard.mjs:2151`). The performance baseline saw no Git process for an edit ([perf-baseline.md](perf-baseline.md)), but this path is not measured there (REQ-041).
5. **Returned code steps are sent to recover.** `phase-prepublish.mjs:389-395` routes GENERATION_INTENT_REQUIRED with a consumed intent to `recover` /sf-recover. That is the normal state of a returned code step before `phase begin`.
6. **The changed-bytes rollover is pinned to /sf-recover by tests** (`publication-preflight.test.mjs:3035`, :3058, :3440, :3463, :3468). They must change with b34 in stages 2 and 3.
7. **VS Code drops every review-correction route.** `submission-presentation.ts:132` keeps a skill in a review state only when it is /sf-review-source. So S4b and S10 show no action and no prefill.
8. **The opening does not advance the high-watermark** (V-9). Only rework writes it. Stage 2's opening operation owns it.

## 7 The AC-020 first inventory

`scripts/osa-inventory.mjs` reads `src/**/*.mjs` and `apps/vscode/src/**/*.ts` as syntax trees, the way `scripts/sda-inventory.mjs` does, and counts per module. Its committed form is **`benchmarks/osa/inventory.json`**: per-module counts, no line numbers. `--sites` gives the lines. `test/osa-stage0.test.mjs` checks the scanner on a fixed sample.

**Stage 1 turns it into the ratchet.** A module's counts may only fall. Approved normalizers, record validators and renderer strings become named exceptions with an owner and a deletion target. The kernel folder is exempt by design.

**What it counts:**
- raw and aliased `generationIntent.status` reads;
- writes to the intent;
- calls of the 14 lifecycle predicates and of the 7 skill and turn choosers;
- `generation ± 1` and `max(…HighWatermark…)` computed in place;
- step route objects built in place;
- lifecycle command literals by verb;
- the route skills `/sf-recover`, `/sf-code` and `/sf-phase` (with their `/sflow-` spellings), each as an exact literal, a route literal or a mention inside text.

**Counts at `d7a976821`:**

| Measure | Value |
|---|---|
| `generationIntent.status` reads | 51 modules: 75 direct, 11 aliased |
| Intent writes | 12 sites in 9 modules |
| Predicate calls | `nextPhaseGeneration` 116, `phaseNeedsGeneration` 31, `requiresProspectivePhaseInspection` 19, `stepBeingWritten` 13, `phaseInspectionGeneration` 13, `successorGenerationOpen` 10, `hasPublishedPhaseGeneration` 9, `phaseKernelOwned` 9, `phaseUsesDeterministicGeneration` 9, `deterministicOnlyGeneration` 7, `phaseExplicitlyReopened` 4, `consumedByPublishedGeneration` 2, `opensCodeVersion` 2, `publicationIsRecorded` 2 |
| Chooser calls | `generationSkillForPhase` 50, `mutationTurnMode` 23, `copilotSkillForCommand` 16, `successorSkillForPhase` 8, `authoringRoute` 6, `skillForCommandLine` 4, `skillRouteForCommand` 2 |
| Version arithmetic in place | 44 sites in 27 modules |
| Step route objects built in place | 121 in 52 modules |
| Lifecycle command literals | recover 66, nextsteps 47, reject 36, prepare 33, phase prepublish 28, approve 23, phase rollover 22, phase show 17, phase begin 13, submit 13, review-source 12, phase enter 10, phase publish 7 |
| Route skill literals (exact / route / in text) | `/sf-code` 30 / 8 / 18 in 31 modules; `/sf-recover` 40 / 0 / 2 in 18 modules; `/sf-phase` 9 / 2 / 4 in 11 modules; `/sflow-phase` 3, `/sflow-code` 1, `/sflow-recover` 1 |

**The heaviest owners**, by the sum of the counted decisions:

| Module | Weight |
|---|---|
| `state.mjs` | 45 |
| `recovery-plan.mjs` | 33 |
| `copilot-mutation-guard.mjs` | 31 |
| `guide.mjs` | 25 |
| `refusal-remediation.mjs` | 25 (24 of them skill literals) |
| `phase-prepublish.mjs` | 24 |
| `code-delivery-policy.mjs` | 20 |
| `amended-drafts.mjs` | 18 |
| `sequence.mjs` | 18 |
| `generation-boundary.mjs` | 17 |
| `submission-readiness.mjs` | 17 |
| `source-review-continuation.mjs` | 16 |
| `commands/phase-lifecycle.mjs` | 15 |
| `nextsteps.mjs` | 14 |

**Roles of the 211 modules with a site:**

| Role | Modules |
|---|---|
| policy | 44 |
| mapping (`command-skills.mjs`) | 1 |
| renderer | 1 |
| validator (`safe-command-guidance.mjs`) | 1 |
| record (`workflow-task-store.mjs`) | 1 |
| unclassified | 163 |

Most of the unclassified modules hold one or two command literals or skill mentions. Stage 1 classifies the rest.

**Why these counts differ from the grep counts in §3** (49 files and 76 mentions of `generationIntent?.status`; 17 files and 40 `'/sf-recover'` literals):
- the AST scan skips comments;
- it includes aliased reads and `apps/vscode/src`;
- it counts a literal once, however it is quoted.

Each method is self-consistent. The ratchet uses the AST counts.
