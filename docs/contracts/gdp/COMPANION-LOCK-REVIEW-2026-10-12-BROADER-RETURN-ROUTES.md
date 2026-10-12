# GDP companion authority review — broader return routes — 2026-10-12

Review boundary: `5f368a057d56a54408d045ced6d51c6bf8bd6346`. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-11-MUTATION-CONTRACT-AND-INSTRUCTION-DEMO.md`.

One GDP-locked companion changed, `workflow-configuration`. `main` already carried an unreviewed change to it, so the lock failed on `main`: `26553c19` ("fix: catch specification scenario gaps before publication") edited `templates/workflow.yml` without a companion review. The previously accepted digest is the file as of `c815d908`. This review covers that change after the fact and the owner-approved broadening of the packaged return routes (item C4 of `docs/PHASE-SELF-REPAIR-ANALYSIS.md`). It is not a bulk hash refresh or a new approval authority. No other locked companion drifted at the boundary.

## Reviewed after the fact in `templates/workflow.yml`

- The shared `specification` phase gains `specificationQuality.scenarioCoverage: required`. This is one added line and no removed or edited lines.
- The setting turns on the scenario-coverage check that `26553c19` added for new Stories that use the phase (`spec-code-test-loop`, `reference-driven-build`, `spec-driven-standard`). Draft check, prepublish and publication now require a `## Scenario coverage` table with a row for every behavior or acceptance clause, each naming an existing S-number scenario with a complete Given/When/Then acceptance case. A missing table, a missing row, a dangling scenario or an incomplete case is an author correction in the open generation. The policy normalizer keeps an omitted value omitted, so Stories already pinned without the field keep their policy digest and behaviour.
- The phase's approval authorities, approval policy, write scope and return routes are unchanged by that commit.

## Reviewed in `templates/workflow.yml`: broader return routes

- In every packaged work type, each step whose approval is `required` or `policy` may now be rejected to every earlier step of that work type and to itself, listed in workflow order. Before this change the code step could return only to itself in ten work types, Verification and Testing could return only to the code step, and in `spec-driven-standard` and `reference-driven-build` nothing after Planning could return to Planning or the Specification.
- Steps with `approval: none` (quick-fix `implement`, POC Lite `poc-lite-plan`, `poc-lite-act` and `poc-lite-verify`) are unchanged. The kernel normalizes their policy to the step alone, because nobody reviews them.
- Phases shared by several work types (`design`, `implementation`, `verification`, `testing`, `conformance`) keep their base `rejectTo` defaults. Each packaged work type names its own list in `phaseOverrides.<phase>.approval.rejectTo`, which `mergePhaseOverride` merges key by key, so their authorities and minimums are unchanged. Phases used by one work type, and `planning`, `convergence` and `release`, which `reference-driven-build` and `spec-driven-standard` run in the same order, list the routes on the phase itself.
- `spec-code-test-loop` already met the rule and does not change. In `poc-lite` only `poc-lite-finalize` is reviewed, and it already met the rule.
- Who authorizes a return is unchanged. `rejectPhase` checks the actor against the rejecting step's own `approvalPolicy` (`requireApprovalAuthority(..., phase.approvalPolicy, ...)` in `src/state.mjs`), never the target's, and still requires a change-request reason.
- What a return does is unchanged. `reopenPhaseRange` and `resetPhaseRangeForRework` (`src/lifecycle-transitions.mjs`) reset the target and every later step, require a fresh target generation and keep a later approval only under rule E1.
- Repair budgets still apply. `spec-code-test-loop` keeps its Testing-to-Code loop (three attempts, reset on a new Specification generation), and `poc-validation` keeps its two-attempt budget reset on a new `poc-intake` generation. `repairBudgetPhaseForRejection` charges new returns that pass through a budgeted step to that step's budget, and a return to the reset step only requests a new count. No budget, loop or `resetOnPhase` value changes, and none is added: the packaged work types without a budget had unbounded human-reviewed returns before this change (for example Verification to Code), and still do.
- In the four scenario work types (`document-test-repair`, `demo-web-e2e-testing`, `demo-check-repair-close`, `demo-instruction-test-loop`), a later review may now return the Story directly to the repair step. Their decisions still bound the automatic routes with `maxRounds` and `enforceConditions: true`. A reviewer's rejection is explicit human direction, and a pass still requires fresh evidence. Because those reviews can now return to the code step, `reviewMayReturnToCode` also offers them the guarded `reject <review> --to <repair> --repair` route when they find changed source.
- Existing Stories are unaffected. Each keeps the approval policy pinned at Story start in its immutable workflow snapshot. Refreshed configuration applies to Stories started afterwards.
- The canonical digests of the nine changed work types and twenty changed phases move to `CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256`. Their previous digests are kept as historical framework values in `src/packaged-workflow-history.mjs`, so an unmodified earlier seed still upgrades as framework-owned configuration.
- No approval authority, approval minimum, write scope, input, artifact, decision, omission or planned-claim declaration changes.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | Enables required scenario coverage on `specification` (after the fact), and lets every reviewed step of every packaged work type return to each earlier step or itself. | `sha256:bc2438fef7d062036e1576f9d57b4117b5e26afcb8ee4bca9dc92989f3c87b18` | `sha256:f179fc6d6e5b7a171f10fa503d5f5657a7a95b1be727c70fbd10ebaffc665365` |
