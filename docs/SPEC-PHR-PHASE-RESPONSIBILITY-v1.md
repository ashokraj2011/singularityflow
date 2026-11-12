# Phase responsibility (PHR) — v1: a step is never blocked by an earlier step's output

Status: owner rule and decisions recorded 2026-11-09 ("go with your recommendations"); the one policy below and the
answers to batch 2's questions recorded 2026-11-10. Being built.

## The one policy (2026-11-10)

The owner, 2026-11-10: "We should always adhere to one policy .. all the issues should be repairable in that phase. One
phase issue should not cause another phase to stall or go to recover loop."

It takes precedence over everything below where they differ. Each check this spec adds or touches holds to it:

- `[PHR:REQ-006]` **Every refusal a step gets is one that step can repair itself**, with the route to do it, in that
  step: a command in a structured field (`nextAction`, `recoveryCommand`, `recoveryCommands` or `repairCommand`),
  never only in prose, and never only a route that sends the work to another step.
- `[PHR:REQ-007]` **No step is held, or sent backward, because of an earlier step's output.** A check of a step's
  output runs in that step, before its approval, with the same evaluator and the same inputs as any later reader, so
  a later step finds nothing new for unchanged inputs.
- `[PHR:REQ-008]` **A later step that changes the inputs owns the result** (it edits code after approval, or amends a
  document) and repairs it there. An intent amendment that would leave a separate plan with gaps carries the plan's
  row corrections itself, signed by the plan's approvers in the same decision; the plan keeps its approval. So does
  one that revises a clause the plan has a row for: it carries that row as it stands (`--keep-row`) or updated, and
  the signed row keeps the plan's evidence of that clause current across the scope revision (owner, 2026-11-10).
- `[PHR:REQ-009]` **The upstream routes are a safety net**, for drift or a checker bug: `reject --to`, an upstream
  issue, a revalidation. Nothing relies on reaching them.
- `[PHR:REQ-010]` **The ratchet holds the policy.** A refusal at a later step that judges an earlier step's output is
  matched by the identical check (the same evaluator) at the owning step, run before that step's approval
  (src/gate-parity.mjs, test/phr-ratchet.test.mjs). An upstream route alone does not satisfy it. A code that truly
  cannot be checked earlier is reported to the owner, never allowance-listed.

The owner's answers to batch 2's questions, 2026-11-10:

1. Finding 11: a criterion's own test that fails, exactly attributed to it, refuses the code step's submission with
   the same-step repair ("ask it to rectify it"). One no exact identity ties to the criterion warns at submission;
   approval refuses both.
2. Finding 12: an inspection or sign-off may be deferred to a later step, by a person's own decision naming that step,
   only when that step can perform and repair it; that step then holds it as its own check. The dated risk stays.
3. Finding 13: kept as built.
4. Finding 15: approving an amendment never reruns the plan (`[PHR:REQ-008]`).
5. Finding 17: kept, with no opt-out.
6. Finding 10: kept as built.
7. G6 to G8: owner-step checks in the step that produces acceptance runs and visual evidence, with the ending's own
   evaluation; the ending's upstream route stays the fallback.

Where answer 7 stands (batch 2, 2026-11-10), each for a Story that pinned the owner-step checks:

- G6, the acceptance runs (`gate.acceptance.run-missing`, `run-stale`, `command-failed`, `observed-test-missing`): the
  last code step's submission runs the ending's own evaluation (`specAcceptanceFindings`) on the same records, under
  an enforced specification with acceptance on, and refuses there (`SPEC_ACCEPTANCE_INCOMPLETE`, with
  `spec acceptance --phase` or the publication as its route).
- G7, `gate.acceptance.planned-test-missing`: planning's prepublish runs the same predicate wherever the ending would
  refuse it.
- G8: `gate.visual.coverage` is the visual verification step's own submission check, the same evaluation; an
  unreadable comparison record is an integrity failure. The visual step holds each visual sign-off at its approval
  (`EVIDENCE_VISUAL_MISSING`; the code step that delivers the criterion on a route with no visual step), and its
  approvers give it. Evidence from before a scope revision (`EVIDENCE_STALE_AFTER_SCOPE_REVISION`) holds the code step
  that answers for it.
- The ratchet (`[PHR:REQ-010]`): every evaluator finding that judges an earlier step's output names its owner-step
  check; an upstream route alone no longer satisfies it.
- Item 8 (owner, option A, 2026-11-10): a code step runs, before its approval, every repository test (`tests:`) the
  steps after it choose (`testLevels`, `testIds`), up to the next code step, with the same runner and result adapter.
  It is resolved when the Story starts, so a running Story keeps what it started with. A failure is repaired in the
  code step, like its own tests; the later step's run on the same code only confirms it (a passing attempt on this
  exact code is not run again). A test bound to a declared environment needs what only its later step has: it is
  not run there, never allowance-listed and never looped back; Story start and the code step's runs say so
  ("Cannot run here: … needs environment …; <step> runs it"). A code step that changes the code after it owns the
  result.
  - (2026-11-12) So does a test whose own `env`, argv or command holds a literal URL to a host other than this
    machine (localhost, 127.0.0.1, [::1], *.localhost, *.test), for example `BASE_URL=https://staging.example.com`:
    that deployed build does not have the code step's code yet. It reads "needs staging.example.com (a deployed
    environment)", host and port only, never a user name, password or query. One the code step chose itself leaves
    it too when a later step runs it; one only the code step runs stays its own. Two tests with the same argv but
    another `env` or `environment` are two runs.
- `gate.visual.threshold` (owner, 2026-11-10: "person accepts the risk"): a failed visual comparison stays in the
  evidence for good, so its repair is a person's accepted risk on that exact comparison, recorded at the visual
  verification step in an approver's own terminal (`decision visual-risk`, with an expiry and a reason). The visual
  step's approval holds a failed comparison nobody accepted (`VISUAL_THRESHOLD_EXCEEDED`, routed to that decision),
  and the same decision settles it at the ending, as an exception, not passing evidence. With that, the approval
  gate's side of the ratchet is tightened too: every author-owned gate code names its owner-step check.

The owner, 2026-11-09: "no phase should be blocked due to prior ones .. It should be caught in the phase responsible
and rectify there."

The case behind the rule: planning prepublish refused a correct plan with `SPEC_VERIFICATION_INTENT_INVALID`. It was
a checker bug (fixed in 04db2ae90), but the planning author had no way forward, and nothing told the Specification's
owners.

## The rule

- `[PHR:REQ-001]` **Every check names the step whose output it judges.**
  - That step owns the check. Its output is its artifact, clause index, verification intent, plan rows and
    verification contracts, delivered code and test evidence, witnesses, and decisions.
  - For Story start, the owner is the policy pinned at start.
  - A refusal's details carry `ownerPhase`. Where it is not the current step, they also carry `upstreamPhase`.
- `[PHR:REQ-002]` **The owner checks it first.** A check that a later step applies to an earlier step's output also
  runs in the owning step, before that step can be approved. It runs at prepublish where it can, and at approval at
  the latest.
- `[PHR:REQ-003]` **Later, it routes back; it never strands the current author.**
  - **What the later step does.** If a later step still finds a fault in an earlier step's output (a checker bug,
    configuration that moved, or anything the owner's check missed), it does not refuse its own author with a fix
    they cannot make.
  - **Where it goes.** The finding becomes, or offers, an upstream issue against the owning step. Its route names that
    step's correction: `decision plan`, an intent amendment, `reject --to <owner> --repair`, or a revalidation.
  - **While an issue is open.** While an open upstream issue names every row behind a refusal, the hold is
    "someone decides", and the decision list leads. This is the `SPEC_COVERAGE_INCOMPLETE` pattern from 1f68d7b6c.
  - **Once it is decided.** An upstream issue decided `accept-risk` settles the later obligation it names, until
    its date. It is never re-raised against the current author.
    - A `dismiss` settles nothing: it says the earlier step's output is right, so what the later step owes stands, and
      its refusal no longer waits on the issue (decided 2026-11-10, from batch 1's review).
    - A conformance gap keeps its own dismissal, "the gap is not real".
- `[PHR:REQ-004]` **Holds point the right way.** An approval hold's route uses the refusal's own `repairCommand`,
  `upstreamPhase` or `gate.actions` before it falls back to rejecting the current step to itself.
- `[PHR:REQ-005]` **A ratchet keeps it true.**
  - The gate-parity table (src/gate-parity.mjs) also covers the evidence evaluator's own `EVIDENCE_*` and `SCOPE_*`
    findings.
  - A test fails when a later step's refusal judges an earlier step's output and has neither an owner-step check nor
    an upstream route.

## Findings (read-only audits, main 04db2ae90)

Ranked by how likely a real Story meets them.

**Routing: the finding fires later and strands the current author** (batch 1)

1. `SPEC_COVERAGE_INCOMPLETE` at code submit and approve (state.mjs ~1992). It does not work out the upstream decision
   that code publish does (spec-coverage-preview.mjs ~28-36), and a decided issue does not settle it.
   - Name `decision plan --replace-location / --remove-location / --replace-test` and the upstream issue.
   - Apply 1f68d7b6c on every path.
   - Treat a decided `accept-risk` issue like a decided conformance gap; a dismissal leaves the clause owed.
2. `SPEC_VERIFICATION_INTENT_INVALID` at planning (intent.mjs ~113-143; phase-prepublish.mjs ~229-236). Plan-row syntax
   and "the plan does not meet the approved intent" share one code, and both are filed as the planner's.
   - Split out the plan's own row errors.
   - Give "intent not met" `upstreamPhase` = the clause's defining step, and an upstream issue or intent amendment as
     its route.
   - Make it disputable before the plan's approvers.
3. Approval `holdRoute` ignores `repairCommand` and `gate.actions` (approval-check.mjs ~766-777), so for example
   `PRIOR_CODE_TEST_EVIDENCE_STALE` sends the person to reject the verification step to itself.
4. `PHASE_VALIDATION_FAILED` at verification approval, from `repositoryTests: run`: a regression in code it does not
   own. Its route is `reject --to <code step> --repair`.
5. `EVIDENCE_STALE_AFTER_SCOPE_REVISION` (evidence/evaluate.mjs ~542) has no route. Offer the owning step's return or
   revalidation.
6. `STEP_ACTION_REQUIRED_UNRECORDED` (step-action-receipts.mjs ~250) blocks later steps' prepare and submit. Hold only
   the Story's ending, as upstream issues do.
7. **At the end of the Story** (evidence/terminal.mjs ~270-280), an open upstream issue naming every blocking row
   makes the hold "someone decides". A decided issue settles its rows (`[PHR:REQ-003]`).
8. A planning source-review `reviewer-blocker` about the approved Specification (source-grounded-review.mjs ~444) can
   name its owning step and become an upstream issue that does not hold planning.
9. `specification.clause-source-required` at planning prepublish (phase-prepublish.mjs ~164) carries the same
   `upstreamPhase` as its plan-publish twin.

**Shift-left: the owning step does not check it** (batch 2)

10. Scope items with no disposition (`SCOPE_ITEMS_UNRESOLVED`, evaluate.mjs ~695) are refused only at the end, and
    are advisory in the scope step. Hold the scope step's approval until each is dispositioned.
11. Per-criterion test results (`EVIDENCE_TEST_*`, `EVIDENCE_ASSURANCE_SHORTFALL`, contract-results.mjs ~16-45) are
    judged only at the end. The code step only warns ("judged at the end", state.mjs ~6049).
    - Judge them at code submission and approval.
    - `inconclusive` also gets the upstream route.
12. A missing inspection witness (`EVIDENCE_INSPECTION_MISSING`) is advisory at code approval. Require the witness, or
    an explicit deferral that names who gives it, at code approval.
13. Coverage under the default `coverage: record / qualified` is refused only at the end (governance.mjs ~864). Refuse
    it at the last code step's approval.
14. The plan's existing, removed, document and configuration paths are checked only at Code (delivery-evidence.mjs
    ~921-933). Planning prepublish checks them against the Story's base. The code refusal names `decision plan
    --set-fulfillment / --replace-location` and the upstream issue.
15. An intent amendment to a separate Specification does not recheck the separate plan
    (`SPEC_PLANNED_CLAIM_MAP_REQUIRED` and `SPEC_CLAIM_MAP_UNKNOWN_CLAUSE` at code, state.mjs ~1813-1844).
    - Check the plan against the amended clauses when the amendment is proposed.
    - Refuse an "unchanged" revalidation that leaves gaps.
    - Add a remove-row plan correction, and name `--add-row`.
16. Story start does not check approval staffing, so `APPROVAL_IDENTITY_NOT_AUTHORIZED` and
    `APPROVAL_SELF_APPROVAL_PROHIBITED` surface at a later approval. Warn at start when a gated step has no eligible
    approver besides its author. This informs and blocks nothing.
17. A supplemental document's `downstream` risk is decided only at submit or approve (trp-document-runtime.mjs ~218).
    Offer it in the same decision at approval.

## Constraints

- **Approvals and decisions stay people's.** A route never decides for anyone. Shift-left checks refuse only in the
  owning step and say how to fix the output there.
- **No guard is loosened to make a test pass.** A guard that is in the way is reported.
- **Stories already running keep their pinned policy.** A new owner-step check applies from the next time that step
  is published.
- **Both hosts matter.** VS Code Copilot and Copilot CLI show the same routes.

## Order

- **Batch 1 (routing, findings 1–9)** first. It removes the dead ends without new refusals.
- **Batch 2 (shift-left, findings 10–17)** next. Each new owner-step check gets its own commit, with a test showing
  the later step no longer meets that fault.
- **`[PHR:REQ-005]`'s ratchet** last, so it holds what both batches built.
