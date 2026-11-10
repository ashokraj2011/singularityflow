/**
 * Where each approval-gate refusal is answered before the gate [gate parity].
 *
 * A release approval was refused for obligations that existed since earlier steps and that no
 * earlier check or person had been shown. Every code the gate can refuse with is listed here with
 * who owns it and how it is met before the gate runs:
 *
 * - `same-check`: the same function runs earlier, where its owner can still fix it (`checks`); it
 *   refuses there, or warns where the policy leaves the step free to finish later (`at` says which).
 * - `approval`: the approve command decides it from the approver's own authority.
 * - `integrity`: it detects a change made after the fact; no earlier check can prevent that.
 * - `operational`: the environment's state (remote, configuration), shown by status and sync.
 * - `lifecycle`: the route's own state (unapproved or skipped steps), shown by status.
 * - `final-check-preview`: shown only by the closing step's final-check preview (readiness and the
 *   entry packet). An author-owned code here must name its known `gap`.
 *
 * test/gate-parity.test.mjs fails when the gate refuses with a code missing here, when an entry
 * names a code the gate no longer uses, or when a `same-check` names a function that is gone.
 *
 * `routes` names where a refusal at the ending sends what an earlier step owns back to that step
 * [PHR:REQ-003]; test/phr-ratchet.test.mjs fails when an author-owned code refused only at the ending
 * has none [PHR:REQ-005].
 */
const entry = (owner, stage, extra = {}) => Object.freeze({ owner, stage, ...extra });
const check = (module, name, at) => Object.freeze({ module, export: name, at });

const CONFORMANCE_CONTRACT = [
  check('conformance-readiness.mjs', 'inspectConformanceReportContract', 'draft-check, publication, submission'),
  check('conformance-readiness.mjs', 'inspectQualifiedConformanceReport', 'draft-check, publication, submission')
];
// A partial or missing verdict is never the report author's to fix: it is an advisory from the draft
// check through submission, and approval and the gate accept it once a person decided it.
const CONFORMANCE_GAPS = [
  check('conformance-readiness.mjs', 'inspectConformanceVerdictAdvisories', 'draft-check, prepublish, publication and submission (advisory, required before approval)'),
  check('upstream-routes.mjs', 'conformanceGapRefusal', 'conformance approval and the gate (refuses until a decided upstream issue names the clause)')
];
const QUALIFIED_ROWS = [check('conformance-readiness.mjs', 'inspectQualifiedConformanceReport', 'draft-check, publication, submission')];
// The ending's own gate findings about an earlier step's output name the upstream issue to that step [PHR:REQ-005].
const ENDING_UPSTREAM = [check('evidence/terminal.mjs', 'terminalRecoveryActions', 'the ending: the upstream issue to the step gateFindingOwner names')];
// The ending's acceptance evaluation, run first at the last code step's submission [PHR:REQ-007], G6.
const ACCEPTANCE_CHECK = [check('acceptance-owner-check.mjs', 'acceptanceOwnerRefusal', 'the last code step\'s submission (pinned Stories under an enforced specification with acceptance on)')];
const CODE_COVERAGE = [
  check('spec-coverage-preview.mjs', 'assertStrictCandidateSpecificationCoverage', 'code publication (refuses when enforced, returns a warning when recorded)'),
  check('state.mjs', 'assertStrictCodeSpecificationCoverage', 'code submission and approval (refuses when enforced, and at the last code step\'s approval when recorded on a Story that pinned the owner-step checks; warns otherwise)')
];

export const GATE_PARITY = Object.freeze({
  'gate.acceptance-criteria.unbound': entry('author', 'same-check', { checks: [check('delivery-evidence.mjs', 'evaluateCodeDeliveryPreflight', 'code draft-check and publication')] }),
  'gate.acceptance.command-failed': entry('author', 'same-check', { checks: ACCEPTANCE_CHECK, routes: ENDING_UPSTREAM }),
  'gate.acceptance.observed-test-missing': entry('author', 'same-check', { checks: ACCEPTANCE_CHECK, routes: ENDING_UPSTREAM }),
  // G7: the same predicate (evaluateSpecAcceptance, presence) at planning, wherever the ending would refuse it.
  'gate.acceptance.planned-test-missing': entry('author', 'same-check', { checks: [check('phase-prepublish.mjs', 'phasePrepublish', 'planning prepublish, with the predicate the ending uses (planned claims required, or a pinned Story under an enforced specification with acceptance on)')], routes: ENDING_UPSTREAM }),
  'gate.acceptance.run-missing': entry('author', 'same-check', { checks: ACCEPTANCE_CHECK, routes: ENDING_UPSTREAM }),
  'gate.acceptance.run-stale': entry('author', 'same-check', { checks: ACCEPTANCE_CHECK, routes: ENDING_UPSTREAM }),
  'gate.agents.context-uncommitted': entry('engine', 'integrity'),
  'gate.agents.integrity': entry('engine', 'integrity'),
  'gate.agents.remote-output-missing': entry('engine', 'integrity'),
  'gate.agents.remote-output-uncommitted': entry('engine', 'integrity'),
  'gate.approval.assurance-missing': entry('approver', 'approval'),
  'gate.approval.authority-mismatch': entry('engine', 'integrity'),
  'gate.approval.required-authority': entry('approver', 'approval'),
  'gate.approval.self-approval-undisclosed': entry('engine', 'integrity'),
  'gate.approval.stale': entry('engine', 'integrity'),
  'gate.approval.threshold': entry('approver', 'approval'),
  'gate.approval.unauthorized': entry('approver', 'approval'),
  'gate.approval.waiver-invalid': entry('engine', 'integrity'),
  'gate.clarification.invalid': entry('engine', 'integrity'),
  'gate.clarification.uncommitted': entry('engine', 'integrity'),
  'gate.clause.invalid-evidence': entry('author', 'same-check', { checks: CODE_COVERAGE }),
  'gate.clause.unclaimed-path': entry('author', 'same-check', { checks: [
    check('spec-coverage-preview.mjs', 'inspectUnclaimedChangedPaths', 'code draft-check (advisory)'),
    check('state.mjs', 'assertStrictCodeSpecificationCoverage', 'code submission and approval (enforced coverage only; recorded endings only warn)')
  ] }),
  'gate.clause.unimplemented': entry('author', 'same-check', { checks: CODE_COVERAGE }),
  'gate.clause.withdrawn-claimed': entry('author', 'same-check', { checks: [check('state.mjs', 'assertStrictCodeSpecificationCoverage', 'code submission and approval (refuses when enforced, warns when recorded)')] }),
  'gate.code-delivery.commit-mismatch': entry('engine', 'integrity'),
  'gate.code-delivery.packet-mismatch': entry('engine', 'integrity'),
  'gate.code-delivery.receipt-missing': entry('engine', 'integrity'),
  'gate.code-delivery.replay': entry('engine', 'integrity'),
  'gate.configuration.snapshot-drift': entry('engine', 'integrity'),
  'gate.conformance.blocking-verdict': entry('approver', 'same-check', { checks: CONFORMANCE_GAPS }),
  'gate.conformance.clause-row-duplicate': entry('author', 'same-check', { checks: QUALIFIED_ROWS }),
  'gate.conformance.clause-row-invalid': entry('author', 'same-check', { checks: QUALIFIED_ROWS }),
  'gate.conformance.clause-row-unknown': entry('author', 'same-check', { checks: QUALIFIED_ROWS }),
  // A deviated or unplanned row that does not say what differs [SCS:REQ-011]: the report author writes it, refused from the
  // draft check on, for a Story that decides differences. The gate's own report checks do not read it.
  'gate.conformance.deviation-unstated': entry('author', 'same-check', { checks: [check('conformance-readiness.mjs', 'inspectPhaseConformance', 'draft-check, publication, submission and approval')] }),
  'gate.conformance.missing-row': entry('author', 'same-check', { checks: CONFORMANCE_CONTRACT }),
  'gate.conformance.self-approval-undisclosed': entry('author', 'same-check', { checks: [check('conformance-readiness.mjs', 'inspectSelfApprovalDisclosures', 'draft-check, publication, submission')] }),
  'gate.conformance.stale': entry('engine', 'integrity'),
  'gate.conformance.verdict-missing': entry('author', 'same-check', { checks: CONFORMANCE_CONTRACT }),
  'gate.design-source.integrity': entry('engine', 'integrity'),
  'gate.documents.catalog': entry('engine', 'integrity'),
  'gate.documents.integrity': entry('engine', 'integrity'),
  'gate.documents.policy': entry('author', 'same-check', { checks: [check('documents.mjs', 'documentUploadPhases', 'documents upload')] }),
  'gate.generation.commit-missing': entry('engine', 'integrity'),
  'gate.generation.publication-invalid': entry('engine', 'integrity'),
  'gate.impact.prompt-study': entry('engine', 'integrity'),
  'gate.impact.receipt': entry('engine', 'integrity'),
  'gate.impact.snapshot-drift': entry('engine', 'integrity'),
  'gate.impact.unavailable': entry('operator', 'operational'),
  'gate.inputs.integrity': entry('engine', 'integrity'),
  'gate.mcp.integrity': entry('engine', 'integrity'),
  'gate.protected-path.changed': entry('engine', 'integrity'),
  'gate.publication.remote-missing': entry('operator', 'operational'),
  'gate.rework.abandoned-unverified': entry('engine', 'integrity'),
  'gate.source.snapshot-drift': entry('engine', 'integrity'),
  // The pinned Story source could not be read at all (not read and found changed): the environment's state.
  'gate.source.snapshot-unavailable': entry('operator', 'operational'),
  'gate.specification-index.missing': entry('route', 'lifecycle'),
  'gate.specification-index.stale': entry('engine', 'integrity'),
  'gate.state.invalid': entry('engine', 'integrity'),
  'gate.telemetry.invalid': entry('engine', 'integrity'),
  'gate.telemetry.uncommitted': entry('engine', 'integrity'),
  'gate.template.snapshot-drift': entry('engine', 'integrity'),
  'gate.terminal.decision-pending': entry('route', 'lifecycle'),
  'gate.terminal.phase-skipped': entry('route', 'lifecycle'),
  'gate.terminal.phase-unapproved': entry('route', 'lifecycle'),
  'gate.terminal.workflow-incomplete': entry('route', 'lifecycle'),
  // G8: the visual verification step, which captures the screens, runs the same coverage evaluation at its submission.
  'gate.visual.coverage': entry('author', 'same-check', { checks: [check('visual-coverage.mjs', 'assertVisualCoverage', 'the visual verification step\'s submission (enforced coverage)')], routes: ENDING_UPSTREAM }),
  // A comparison record that will not parse is an integrity failure whatever the comparison mode says (visual-compare.mjs).
  'gate.visual.evidence-unreadable': entry('engine', 'integrity'),
  // A failed comparison stays in the evidence for good; an approver of the visual step accepts its risk there, and the
  // ending reads the same decision (owner, 2026-11-10).
  'gate.visual.threshold': entry('author', 'same-check', { checks: [check('visual-risks.mjs', 'visualThresholdRefusal', 'the visual verification step\'s approval (pinned Stories): a failed comparison nobody accepted')], routes: ENDING_UPSTREAM }),
  'gate.witness.exception-lapsed': entry('approver', 'final-check-preview')
});

export const GATE_PARITY_STAGES = Object.freeze(['same-check', 'approval', 'integrity', 'operational', 'lifecycle', 'final-check-preview']);
export const GATE_PARITY_OWNERS = Object.freeze(['author', 'approver', 'engine', 'operator', 'route']);

/**
 * What the evidence evaluator itself finds, and who answers it before the ending [PHR:REQ-005].
 *
 * Each EVIDENCE_* and SCOPE_* finding of the final evaluation (evidence/evaluate.mjs, evidence/graph.mjs,
 * verification/contract-results.mjs) names the output it judges (`owner`) and where that is met:
 * - `owner-check`: the step that owns the output checks it first (`checks`), and the ending's refusal
 *   still routes it back there (`routes`);
 * - `upstream-route`: no earlier check yet, but the ending sends it back to the owning step (`routes`);
 * - `approval`: a person's own decision (a reviewer's exception that lapsed, a renewal);
 * - `integrity`: records that cannot be read or trusted; no earlier check can prevent that;
 * - `lifecycle`: the route's own state (a delivery not yet approved, a responsibility no step holds);
 * - `advisory`: it never blocks.
 * test/phr-ratchet.test.mjs fails on an evaluator code missing here, on an entry the evaluator no longer
 * emits, and on an earlier step's output with neither a check nor a route.
 */
const SCOPE_CHECK = [check('scope/authoring.mjs', 'assertScopeDispositioned', 'approval of the last step that defines the scope (pinned Stories)')];
const PLAN_CHECK = [check('phase-prepublish.mjs', 'phasePrepublish', 'planning prepublish (planned-test-missing and the plan\'s rows), then plan publication')];
const CLAUSE_CHECK = [check('phase-prepublish.mjs', 'phasePrepublish', 'the defining step\'s prepublish (clauses-required where planned claims are enforced)')];
const IMPLEMENTATION_CHECK = [check('state.mjs', 'assertStrictCodeSpecificationCoverage', 'code submission and approval (enforced coverage; the last code step under recorded coverage, pinned Stories)')];
const CRITERION_CHECK = [check('owner-step-evidence.mjs', 'criterionTestRefusal', 'approval of the code step that answers for the criterion (pinned Stories)')];
const INSPECTION_CHECK = [check('owner-step-evidence.mjs', 'inspectionWitnessRefusal', 'approval of the code step that answers for the criterion (pinned Stories)')];
const VISUAL_CHECK = [check('owner-step-evidence.mjs', 'inspectionWitnessRefusal', 'approval of the visual verification step, or of the code step that delivers the criterion on a route with none (pinned Stories)')];
const STALE_CHECK = [check('owner-step-evidence.mjs', 'staleEvidenceRefusal', 'approval of the code step that answers for the criterion (pinned Stories)')];
const UPSTREAM_ROUTE = [check('evidence/terminal.mjs', 'terminalRecoveryActions', 'the ending: the upstream issue, plan correction, return or revalidation to the owning step')];
const WITNESS_ROUTE = [check('evidence/terminal.mjs', 'terminalEvidenceDecisions', 'the ending and the decision list: the witness, with who may give it')];
const SCOPE_ROUTE = [check('evidence/terminal.mjs', 'terminalRecoveryActions', 'the ending: each scope decision, for the scope step\'s approvers')];
const evidence = (owner, stage, { checks = [], routes = [] } = {}) => Object.freeze({ owner, stage, checks, routes });
const criterion = evidence('code', 'owner-check', { checks: CRITERION_CHECK, routes: UPSTREAM_ROUTE });

export const EVIDENCE_PARITY = Object.freeze({
  EVIDENCE_ASSURANCE_SHORTFALL: criterion,
  EVIDENCE_CARRIED_BY_REVALIDATION: evidence('approver', 'advisory'),
  EVIDENCE_IMPLEMENTATION_DEVIATED: evidence('code', 'owner-check', { checks: IMPLEMENTATION_CHECK, routes: UPSTREAM_ROUTE }),
  EVIDENCE_IMPLEMENTATION_MISSING: evidence('code', 'owner-check', { checks: IMPLEMENTATION_CHECK, routes: UPSTREAM_ROUTE }),
  EVIDENCE_IMPLEMENTATION_PARTIAL: evidence('code', 'owner-check', { checks: IMPLEMENTATION_CHECK, routes: UPSTREAM_ROUTE }),
  EVIDENCE_INSPECTION_MISSING: evidence('code', 'owner-check', { checks: INSPECTION_CHECK, routes: WITNESS_ROUTE }),
  EVIDENCE_INSPECTION_UNREADABLE: evidence('engine', 'integrity'),
  EVIDENCE_NO_CRITERIA: evidence('scope', 'owner-check', { checks: CLAUSE_CHECK }),
  EVIDENCE_PLAN_MISSING: evidence('plan', 'owner-check', { checks: PLAN_CHECK, routes: UPSTREAM_ROUTE }),
  EVIDENCE_RECEIPT_UNREADABLE: evidence('engine', 'integrity'),
  EVIDENCE_RECORDS_UNTRUSTED: evidence('engine', 'integrity'),
  EVIDENCE_RESPONSIBILITY_UNHELD: evidence('route', 'lifecycle'),
  EVIDENCE_REVIEW_PENDING: evidence('route', 'lifecycle'),
  EVIDENCE_STALE_AFTER_SCOPE_REVISION: evidence('code', 'owner-check', { checks: STALE_CHECK, routes: UPSTREAM_ROUTE }),
  EVIDENCE_TAG_NOT_ON_TEST: criterion,
  EVIDENCE_TEST_AMBIGUOUS: criterion,
  EVIDENCE_TEST_ASSERTION_MISSING: criterion,
  EVIDENCE_TEST_ASSERTION_TAUTOLOGICAL: criterion,
  EVIDENCE_TEST_FAILED: criterion,
  EVIDENCE_TEST_FLAKY: criterion,
  EVIDENCE_TEST_IDENTITY_INCONCLUSIVE: criterion,
  EVIDENCE_TEST_NOT_RUN: criterion,
  EVIDENCE_TEST_RECEIPT_UNREADABLE: evidence('engine', 'integrity'),
  EVIDENCE_TEST_SKIPPED: criterion,
  EVIDENCE_TEST_UNAVAILABLE: criterion,
  EVIDENCE_TESTS_SKIPPED: criterion,
  EVIDENCE_VISUAL_MISSING: evidence('code', 'owner-check', { checks: VISUAL_CHECK, routes: WITNESS_ROUTE }),
  EVIDENCE_WITNESS_EXCEPTION_EXPIRED: evidence('approver', 'approval'),
  EVIDENCE_WITNESS_MISSING: criterion,
  EVIDENCE_WITNESS_NOT_APPLICABLE: criterion,
  SCOPE_INVENTORY_UNAVAILABLE: evidence('engine', 'integrity'),
  SCOPE_ITEMS_UNRESOLVED: evidence('scope', 'owner-check', { checks: SCOPE_CHECK, routes: SCOPE_ROUTE })
});

export const EVIDENCE_PARITY_STAGES = Object.freeze(['owner-check', 'upstream-route', 'approval', 'integrity', 'lifecycle', 'advisory']);
export const EVIDENCE_PARITY_OWNERS = Object.freeze(['scope', 'plan', 'code', 'approver', 'engine', 'route']);
/** The owners whose output a later step judges: what they own needs an owner-step check or an upstream route. */
export const EARLIER_OUTPUT_OWNERS = Object.freeze(['scope', 'plan', 'code']);
