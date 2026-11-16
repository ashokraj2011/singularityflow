# OSA Stage 1 — one working decision path

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) sections 3–6, 11 and 12; implementation plan section 3.
**Branch:** `osa-v11-s1`, from `293a2e9a8` (main `ea398577f` with Stage 0 merged).
**Status:** the stage's implementation and its targeted qualification. Broader surfaces stay pending (Stage 3), as the exit gate allows. The heavy run (full suite, Node 22, then the weekly Node 26 run) has not been made; it comes at the end.

## 1 What changed

| # | Item | Where |
|---|---|---|
| 1 | `StepSnapshot/v1` and `StepDecision/v1`, with the reducer | `src/kernel/step-state.mjs` |
| 2 | The §4.3 predicates and the one version arithmetic | `src/kernel/step-versions.mjs` |
| 3 | The Story record's adapter, and the old helpers as wrappers | `src/phase-generation-need.mjs` (`versionFactsOf`), `src/phase-generation.mjs`, `src/sequence.mjs` (`phaseExplicitlyReopened`) |
| 4 | The snapshot adapter and the host's rendering of a decision | `src/phase-mutation-contract.mjs` (`stepSnapshotOf`, `decisionRoutes`) |
| 5 | The cohort on one decision | the mutation contract, the pre-tool guard, the phase entry, the authoring task and the immediate next route (section 3) |
| 6 | Shadow comparison | `scripts/osa-shadow.mjs`, `test/osa-stage1-shadow.test.mjs` |
| 7 | The AC-020 ratchet | `test/osa-ratchet.test.mjs`, `benchmarks/osa/ratchet.json`, `scripts/osa-inventory.mjs --ratchet` |
| 8 | Qualification tests | `test/osa-stage1-kernel.test.mjs` (with the 40 cases of `test/fixtures/osa/stage1-golden.json`), `test/osa-stage1-guard.test.mjs`, `test/osa-stage1-skills.test.mjs` |

`src/phase-inspection-generation.mjs` is gone: its three helpers moved into `phase-generation-need.mjs`, so every eager closure that reaches the kernel keeps its file count.

## 2 The contracts

Both are plain JSON values with `schemaVersion: 1`. The kernel imports only its sibling, and returns errors as data.

### 2.1 `StepSnapshot/v1`

| Field | Type and bounds | Notes |
|---|---|---|
| `schemaVersion` | `1` | Any other value: `invalid` / `SNAPSHOT_VERSION_UNSUPPORTED` |
| `record` | `{ family, version }` | Record-version admission: `story-workflow` versions 1–13 (`RECORD_ADMISSION`, the workflow schema's enum). Others: `RECORD_VERSION_NOT_ADMITTED` |
| `subject` | `{ projectId, workId, requestedPhaseId, currentPhaseId }`, strings of at most 256 characters; `workId` required; the rest nullable | `currentPhaseId` must be in `story.phaseOrder` |
| `basis` | `lifecycleRevision`, `authorityEpoch`, `configurationRevision`, `publicationDigest`, `reviewDigest`, `openVersionReceiptId`, `workingObservationId`, `principalBinding`, `capabilityRevision`, `executionRevision`, `decisionSnapshotId`: each a string of at most 256 characters, or null | Copied into the decision |
| `sources` | `{ name: { status, diagnostic } }`; status one of `verified`, `not-created`, `missing`, `unavailable`, `stale`, `corrupt` | Required: `lifecycle`, `configuration`. A required source that is absent is `unavailable`. Optional: `review`, `authority`, `working`, `execution` |
| `differences` | up to 32 `{ field, state }`, state `same`, `differs` or `unknown` | The tri-state accepted/working difference (REQ-040) |
| `story` | `{ status: active \| complete \| cancelled, phaseOrder: string[] (≤ 128), pendingDecision: { id } \| null }` | |
| `step`, `current` | step facts (below); `current` only when the requested step is not the current one | `step.id` must equal the requested step, `current.id` the current step |
| `actor` | `{ principalKind: agent \| human, role: author \| reviewer \| approver \| person, turnMode, permissionsRevoked }` | |

**Step facts:** `id`, `status`, `versionRequired`, `published`, `recordedHighWatermark` (absent means none), `opening: { status, version } | null`, `publicationRecorded`, `rework: { version } | null`, `amendment: { baseline } | null`, `rejection: { rewritten } | null`, `authorConflict`, `changeRequestOpen`, `intentAmendmentPending`, `kind: { executionOwner: agent | kernel, code, changeCapabilities: (step-artifacts | application)[] }`, `pause: { id } | null`, `holds: { code, owner, blocks: (authoring | submission)[], resolution }[]` (at most 16 read), `review: { required, status, version }` (status `unavailable`, `not-created`, `pending`, `ready`, `correction-required` or `disposition-required`), `damage: { code } | null`.

Counters are nonnegative safe integers or their decimal strings. `null` is not absent.

### 2.2 `StepDecision/v1`

The shape of §4.2, with these exact values:

| Field | Values |
|---|---|
| `state` | `not-started`, `writing`, `kernel-build`, `waiting`, `published`, `in-review`, `review-ready`, `review-corrections`, `reopened`, `submitted`, `approved`, `paused`, `held`, `damaged`, `complete`, `cancelled`, and `invalid` (an explicit error, never a plausible healthy state) |
| `version` | `published`, `writing`, `highWatermark`, `proposedNext`: safe integers or null |
| `publication` | the three predicates, booleans or null |
| `edit` | `eligible`, `scopeReference` (a logical target or null), `permittedCategories` (`step-artifacts`, `application`), `reasons`, and `authoring` (the step's version is being written, whatever this turn may write) |
| `next` | `actionId`, `kind` (`agent-work`, `person-consent`, `person-decision`, `person-approval`, `review`, `observe`, `refresh`, `reconcile`, `none`), `operation` (`open-version`, `author-version`, `build-version`, `publish-version`, `start-review`, `review-version`, `submit-version`, `approve-step`, `decide`, `recover-operation`, `refresh-authority`, `refresh-facts`, `takeover-writer`, `inspect`, `none`), `inputs`, `target: { projectId, workId, phase, version }`, `principalKind`, `role`, `prerequisites`, `reasonCodes`, `then` |
| `obligations` | holds that do not stop the primary action, kept with their owner and resolution |
| `task`, `turn` | the bound scope and `endOnScopeChange: true`; task fields are null until Stage 3 |

`REASON_CODES` lists the 41 codes. Stage 0's fixture vocabulary is a subset of these enumerations; `refresh-facts` and `invalid` are the two additions.

The kernel returns no shell string, skill name, question wording or prompt; `test/osa-stage1-kernel.test.mjs` checks every decision for them.

### 2.3 Precedence

`stepState` applies §5 in order:

1. shape, record admission, mixed bindings, source status, counters, and an opening past the next number. An opening at a used number (a restored checkpoint leaves one) applies to nothing and is stated as `OPENING_NOT_APPLICABLE`; it is not an error;
2. a cancelled or complete Story;
3. positive damage: a corrupt source, or a consumed opening that is not the published version's;
4. revoked authority, and holds that stop authoring;
5. a Story decision or an amendment pause;
6. a submitted version;
7. the initial version (a nonzero watermark asks for consent);
8. an accepted open version;
9. a published step that needs a successor, then review corrections, dispositions and the review;
10. submission.

A request for another step than the current one is inspected, and routed to the current step's action (precedence 11).

## 3 Predicates and wrappers

| Old helper | Now | Meaning kept | Behaviour change |
|---|---|---|---|
| `successorGenerationOpen` | `hasOpenVersion` | the next version is open | An opening applies only at max(published, watermark) + 1. The old `>` test also accepted a used number (decision inventory S15, C22). |
| `phaseNeedsGeneration` | `needsVersion` (`versionNeed` gives the reason) | unchanged, with the record's own comparisons | none |
| `stepBeingWritten` | `beingWritten` | in progress, and it needs a version or one is open | Invalid counters, or an opening past the next number, are not "being written" (they are `invalid`). An opening at a used number opens nothing. |
| `nextPhaseGeneration` | `versionNumbers().next` | max(generation, watermark) + 1, validated | none: the same `GENERATION_COUNTER_INVALID` refusal |
| `consumedByPublishedGeneration` | `consumedByPublishedVersion` | the published version's receipt | none |
| `hasPublishedPhaseGeneration` | `publishedVersionRecorded` | published and recorded, nothing open | none. It stays separate from `currentVersionPublished` (P-4 asks for the record) |
| `phaseExplicitlyReopened` | `explicitlyReopened` | reopened by a person's return | none |
| `requiresProspectivePhaseInspection`, `phaseInspectionGeneration` | wrappers in `phase-generation-need.mjs` | unchanged | none |

Two more kernel helpers are shared by the reducer, the entry, the authoring task and prepublish:
- `consumedOpeningMismatch`, the one positive-damage test;
- `reopenedByReturn`: a person's return or rejection authorized the successor. It opens with `phase begin`; any other published code step is previewed with `phase rollover` for the person's yes.

## 4 Adapter-side facts (REQ-040, REQ-041)

- **`versionFactsOf(workflow, phase)`** normalizes the Story record's step into version facts. It is the one approved raw reader of the opening (a named ratchet exception).
- **`stepSnapshotOf(…)`** builds `StepSnapshot/v1` from the record the caller already holds:
  - `lifecycle` and `configuration` are `verified`;
  - `review` is `unavailable` unless the caller read it;
  - an approved amendment's acknowledgement is a submission-only hold;
  - the accepted/working difference is `unknown`, because nothing is compared per tool call.
- **No Git or history discovery** on the guard path. The reviewer-start fallback (Stage 0 finding 4, a12) used to load the Story with Git inside the pre-tool hook. It now reads the bound `workflow.json` once, through `readRecord('story-workflow')`, and judges it with `currentVersionPublished`.

## 5 The cohort

| Surface | Before | Now |
|---|---|---|
| Mutation contract (a1, b10) | its own `editable`, open test, application rule and `next`; recover inline | `stepState(stepSnapshotOf(…))` decides eligibility, categories and the next action; `decisionRoutes` renders it |
| Pre-tool guard (a4, b37, a12, a9) | the contract without the entry's handoff, so a different `next`; a Git load on the reviewer fallback; `generation + 1` | the same contract as the entry; no Git; the decision's version (`taskVersion`) |
| Phase entry (b1, a11) | the permission with a handoff only it had; a damaged step's rollover preview; an impossible opening held for a pause; a rejected code step previewed while the permission said begin | the same contract as the guard; damage and impossible openings classified first; a rejection opens like a return |
| Authoring task (a8, b9) | its own damage and open tests | the kernel's predicates (damage, a person's return or rejection, an open version) |
| Immediate next route | the guard said `nextsteps`, the entry the Story's next | one rendered action for both, and for the task |

**Stage 0 finding 1 is fixed.** The guard built the edit permission without the entry's handoff, so the two gave different next steps. They now derive one permission from one decision (`test/osa-stage1-guard.test.mjs`, `test/step-routes-stage1.test.mjs`).

## 6 Shadow comparison

`node scripts/osa-shadow.mjs --baseline=<Stage 0 checkout>` compared the kernel's rendered action with the existing outputs on 672 captured Story records. It executes nothing and reads only the records.

**Against the Stage 0 edit permission (resolved by this stage):**

| Class | Records | Resolution |
|---|---|---|
| The guard named `nextsteps` where the entry named the Story's next | 208 | One decision for both; a step not being written leads with its readiness read, approval or decision |
| Damage under an amendment pause went to the decisions card | 24 | Damage first (§5 precedence 3 before 5) |

**Found and fixed in the entry**, which now agrees with the permission on every record:
- a damaged step was given its rollover preview;
- an impossible opening was held for a pause;
- a rejected code step was previewed with `phase rollover`, while the permission, the task and next steps said `phase begin`. A rejection is a person's return; `publication-preflight`'s and `phase-authoring-progress`'s tests pin `phase begin`, and the entry now says it too.

**Along the way, the kernel itself was corrected.** A first version called an opening at a used number `invalid`. The authoring-progress test of a restored checkpoint showed that such an opening is a legitimate leftover, not an impossible record: the step opens the next free number (golden G39). The golden fixtures G22 and G32 were corrected with it, and the reasons are recorded in their notes.

**Still differing, declared and owned (Stage 3, the Story's next in `sequence.mjs`):**

| Class | Records | Why |
|---|---|---|
| sequence ignores the amendment pause | 312 | sequence reads no pause |
| sequence writes a damaged step | 48 | it routes damage to begin or prepare |
| submit led by readiness | 20 | the permission leads with the readiness read, which names the exact submission |

`test/osa-stage1-shadow.test.mjs` fails on any new class, any rise, or any difference in the migrated cohort.

## 7 Stage 0 findings in this cohort

| Finding | Result |
|---|---|
| 1. The guard and the entry built the permission differently | **Fixed** (§5) |
| 2. `refusal-remediation.mjs:220` reads `details.stepBeingWritten`, which nothing sets | **Fixed:** removed; the refusal's own route is the one test |
| 4. a12 reads Git inside the pre-tool path | **Fixed** (§4) |
| 5. `phase-prepublish.mjs:389-395` sends a returned code step to recover | **Fixed:** recover only for `consumedOpeningMismatch`; a return opens with `phase begin`, any other published step with the person's `phase rollover` preview |
| 8. Opening a version never advances the high-watermark (V-9) | **Recorded for Stage 2.** The watermark belongs to the opening operation (capability matrix 2c, §7.2). The kernel already proposes max(published, watermark) + 1 and refuses an opening at a used number, so the gap cannot reuse a number through the cohort. |
| 3. Three places treat an open version 2 as published (`cli.mjs:2054`, `review-subagent.mjs:210`, `verification/witness-records.mjs:188`) | **Stage 3.** Outside the cohort. |
| 6. Tests pin the changed-bytes rollover to `/sf-recover` | **Stages 2 and 3**, with b34 |
| 7. VS Code drops every review-correction route (`apps/vscode/src/views/submission-presentation.ts:132`) | **Recorded for Stage 3** (b27, b35, b36). The kernel's `review-corrections` action is `person-consent` / `open-version`. VS Code keeps a review state's skill only when it is `/sf-review-source`, so S4b and S10 show no action and no prefill. |
| Computed-path imports outside the bundle (`decision-list-reads.mjs:254`, `story-lineage.mjs:49`) | **Recorded for Stage 3.** Not OSA's; they load 148 and 74 source modules into bundled `nextsteps` and code entry, and §9 keeps them in view. |

A pre-existing red, also fixed: `publication-preflight`'s "prepare refuses a consumed code generation" was red at `293a2e9a8`. It expected the recover route that `e5570c373` removed from the refusal.

## 8 The AC-020 ratchet

Per module and family, counts may only fall (`test/osa-ratchet.test.mjs`). The baseline is Stage 0's `benchmarks/osa/inventory.json`.

| Family (all modules) | Stage 0 | Stage 1 |
|---|---|---|
| Raw opening reads (direct and aliased) | 86 | 82 |
| Opening writes | 12 | 12 |
| Lifecycle predicate calls | 246 | 235 |
| Skill and turn chooser calls | 109 | 108 |
| Version arithmetic in place | 44 | 42 |
| Routes built in place | 121 | 122 |
| Lifecycle command literals | 327 | 332 |
| Route skill literals | 118 | 121 |

The rises are eight named exceptions in `benchmarks/osa/ratchet.json`, each with its kind, owner, deletion target and reason:

- **The record adapter**, a normalizer that is permanent: `phase-generation-need.mjs`, +1 opening read moved in from `phase-inspection-generation.mjs`.
- **Renderers of the kernel's decision:**
  - `decisionRoutes` (+2 commands, +1 skill), owned by Stage 4's central command map;
  - the entry's damage and invalid classifications (+1 route, +2 commands, +1 skill), Stage 3;
  - the task's successor preview (+1 skill), Stage 3;
  - prepublish's opening route (+1 command), Stage 3.

The kernel folder holds no counted site.

## 9 Performance against Stage 0

See [stage1-perf.md](stage1-perf.md).

## 10 Budgets

| Ceiling | Stage 0 | Stage 1 measured | Change |
|---|---|---|---|
| Session current files | 221 of 221 | 221 | none: `phase-inspection-generation.mjs` was deleted for `kernel/step-versions.mjs` |
| Session current bytes | 4,273,500 (4,273,495) | 4,277,571 | **raised to 4,277,600** with its measurement in `test/lazy-command-handlers.test.mjs`. The moved bodies cost what they did; the +4,076 is the new §4.3 checks and the record adapter. The reducer stays out of this closure. |
| Lifecycle handlers' files | 470 of 473 (`submit`) | 470 | none |
| Lifecycle handlers' bytes | 9,694,550 (9,688,981) | `phase-lifecycle` 9,693,773 | none: within the ceiling |
| Cold bundle chunks | ≤ 21 | unchanged | Both kernel files are pinned to the `core` family |

## 11 Acceptance rows for the migrated cohort

| Row | Result | Evidence |
|---|---|---|
| AC-001 | **Pass** | `osa-stage1-guard`: the real guard, the entry's permission and the decision agree on six write categories in six states; staging and execution outputs grant no authoring; a moved record or an expired turn revokes a grant |
| AC-002 | **Pass** for the cohort | `osa-stage1-guard`, `osa-stage1-shadow` (the entry and permission agree on all 672 records). Other surfaces: Stage 3. |
| AC-003 | **Pass** for the cohort | Every rendered route validates as a supported command naming its target (`osa-stage1-guard`, `osa-stage1-skills`) |
| AC-004 | **Pass** (abstract model) | `osa-stage1-kernel`: every golden and generated start reaches a milestone, a human boundary, a wait or the end within six transitions, with no repeated action |
| AC-005 | **Pass** | `osa-stage1-kernel` generator; recover only for positive damage |
| AC-006 | **Pass** for the guard's path refusals | A refusal keeps its code and leads with the decision's next (`osa-stage1-guard`). Refusal presentation as a whole: Stage 3. |
| AC-007 | **Pass** | `osa-stage1-kernel`: the predicates and every wrapper against their written-out definitions, including version 1 published while 2 is open |
| AC-008 | **Pass** for the cohort, with one declared restatement | `osa-stage1-skills`. `/sf-code`'s "open intent" lines agree with the kernel and are owned by Stage 4 (c7). |
| AC-009 | **Pass** | `osa-stage1-kernel`: two kernel files, sibling imports only, no `node:` module, I/O, nondeterminism or host wording |
| AC-020 | **Pass** | `osa-ratchet` |

## 12 Known limits and what Stage 2 inherits

- **Successor consent.** For a reworked or rejected step, the kernel says `person-consent` / `open-version` with consent `required`. The cohort still renders `phase begin` for a person's return, and keeps the step's files writable. These are the `LEGACY_SUCCESSOR_OPENING` and `LEGACY_SUCCESSOR_EDITS` reasons, which Stage 2's receipt removes. Journey F's KNOWN_BAD `osa-stage-2` ("Start version 3?" is never asked after rework) is therefore unchanged.
- **Document openings** have no opening record (capability matrix 2b). A document step's first version is `not-started` with `open-version` rendered as `prepare`, and its files are writable in the work command's own turn. A document successor is Stage 2 (journey I).
- **The watermark on opening** (finding 8): Stage 2.
- **Holds.** Stage 1's snapshot carries the amendment pause and the acknowledgement hold. The author-conflict hold (b14, S13) still reaches the kernel as a reason a version is needed (`reopened`, previewed with `phase rollover`; golden G40), not as a hold: Stage 3.
- **Review facts.** The cohort reads no review record, so a published step leads with its readiness read (`refresh-facts`), which then names the review or the submission. The entry's own review continuation is unchanged.
- **Other surfaces** still decide on their own, through the wrappers: next steps, guide, sequence, readiness, phase show, session, VS Code and the refusal plans. They are Stage 3 cohorts, and the shadow test lists their differences.

**Run:** the targeted files, the slow-lane journeys B, E, F and G, and the repository check; see [README.md](README.md). **Not run:** the full suite and the weekly Node 26 run.
