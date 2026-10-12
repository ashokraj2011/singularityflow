/**
 * Where each approval-gate refusal is answered before the gate [gate parity].
 *
 * A release approval was refused for obligations that existed since earlier steps and that no
 * earlier check or person had been shown. Every code the gate can refuse with is listed here with
 * who owns it and how it is met before the gate runs:
 *
 * - `same-check`: the same function runs earlier, where its owner can still fix it (`checks`).
 * - `approval`: the approve command decides it from the approver's own authority.
 * - `integrity`: it detects a change made after the fact; no earlier check can prevent that.
 * - `operational`: the environment's state (remote, configuration), shown by status and sync.
 * - `lifecycle`: the route's own state (unapproved or skipped steps), shown by status.
 * - `final-check-preview`: shown only by the closing step's final-check preview (readiness and the
 *   entry packet). An author-owned code here must name its known `gap`.
 *
 * test/gate-parity.test.mjs fails when the gate refuses with a code missing here, when an entry
 * names a code the gate no longer uses, or when a `same-check` names a function that is gone.
 */
const entry = (owner, stage, extra = {}) => Object.freeze({ owner, stage, ...extra });
const check = (module, name, at) => Object.freeze({ module, export: name, at });

const CONFORMANCE_CONTRACT = [
  check('conformance-readiness.mjs', 'inspectConformanceReportContract', 'draft-check, publication, submission'),
  check('conformance-readiness.mjs', 'inspectQualifiedConformanceReport', 'draft-check, publication, submission')
];
const QUALIFIED_ROWS = [check('conformance-readiness.mjs', 'inspectQualifiedConformanceReport', 'draft-check, publication, submission')];
const CODE_COVERAGE = [
  check('spec-coverage-preview.mjs', 'assertStrictCandidateSpecificationCoverage', 'code publication'),
  check('state.mjs', 'assertStrictCodeSpecificationCoverage', 'code submission and approval')
];

export const GATE_PARITY = Object.freeze({
  'gate.acceptance-criteria.unbound': entry('author', 'same-check', { checks: [check('delivery-evidence.mjs', 'evaluateCodeDeliveryPreflight', 'code draft-check and publication')] }),
  'gate.acceptance.command-failed': entry('author', 'final-check-preview', { gap: 'G6: acceptance runs are not run before the ending' }),
  'gate.acceptance.observed-test-missing': entry('author', 'final-check-preview', { gap: 'G6: acceptance runs are not run before the ending' }),
  'gate.acceptance.planned-test-missing': entry('author', 'final-check-preview', { gap: 'G7: the planned-test predicate is not shared with planning' }),
  'gate.acceptance.run-missing': entry('author', 'final-check-preview', { gap: 'G6: acceptance runs are not run before the ending' }),
  'gate.acceptance.run-stale': entry('author', 'final-check-preview', { gap: 'G6: acceptance runs are not run before the ending' }),
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
    check('state.mjs', 'assertStrictCodeSpecificationCoverage', 'code submission and approval')
  ] }),
  'gate.clause.unimplemented': entry('author', 'same-check', { checks: CODE_COVERAGE }),
  'gate.clause.withdrawn-claimed': entry('author', 'same-check', { checks: [check('state.mjs', 'assertStrictCodeSpecificationCoverage', 'code submission and approval')] }),
  'gate.code-delivery.commit-mismatch': entry('engine', 'integrity'),
  'gate.code-delivery.packet-mismatch': entry('engine', 'integrity'),
  'gate.code-delivery.receipt-missing': entry('engine', 'integrity'),
  'gate.code-delivery.replay': entry('engine', 'integrity'),
  'gate.configuration.snapshot-drift': entry('engine', 'integrity'),
  'gate.conformance.blocking-verdict': entry('author', 'same-check', { checks: CONFORMANCE_CONTRACT }),
  'gate.conformance.clause-row-duplicate': entry('author', 'same-check', { checks: QUALIFIED_ROWS }),
  'gate.conformance.clause-row-invalid': entry('author', 'same-check', { checks: QUALIFIED_ROWS }),
  'gate.conformance.clause-row-unknown': entry('author', 'same-check', { checks: QUALIFIED_ROWS }),
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
  'gate.visual.coverage': entry('author', 'final-check-preview', { gap: 'G8: visual coverage is not checked at the code step' }),
  'gate.visual.evidence-unreadable': entry('author', 'final-check-preview', { gap: 'G8: visual comparisons are read only at the ending' }),
  'gate.visual.threshold': entry('author', 'final-check-preview', { gap: 'G8: visual thresholds are not checked at the code step' }),
  'gate.witness.exception-lapsed': entry('approver', 'final-check-preview')
});

export const GATE_PARITY_STAGES = Object.freeze(['same-check', 'approval', 'integrity', 'operational', 'lifecycle', 'final-check-preview']);
export const GATE_PARITY_OWNERS = Object.freeze(['author', 'approver', 'engine', 'operator', 'route']);
