/**
 * The final evaluation every transition that ends a Story must pass [E2G-028, decision D3].
 *
 * It runs in decision mode on the Story its transition is about to commit, inside the same
 * transaction. If anything is open (a criterion pending, failed or inconclusive, a governance
 * error, or an omitted responsibility nobody has decided) the transition is refused and nothing is
 * written. On success the evaluation is recorded on the Story, and only that record, while it still
 * matches the evidence, can label the Story Complete.
 */
import { runGovernanceGate } from '../governance.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';
import { evaluateEvidence } from './evaluate.mjs';
import { WITNESS_CHECKLIST } from '../verification/witness-records.mjs';
import { evidenceGraphFromAggregate } from './graph.mjs';
import { gateRefusal } from './gate-refusal.mjs';
import { completionLabel } from './labels.mjs';
import { upstreamIssueTerminalBlockers } from '../upstream-issues.mjs';
import { forwardAmendmentTerminalBlockers } from '../forward-amendments.mjs';

const MAX_LISTED = 20;
const BLOCKING_RESULTS = new Set(['failed', 'inconclusive', 'missing', 'pending']);
// recordWitness accepts only these; a test slot is witnessed by its own run, so offering
// `decision witness` for it would hand the person a command that is always refused.
const WITNESSED_METHODS = new Set(['inspection', 'visual']);

/** The planned evidence files of a criterion, from its plan obligations. */
function plannedEvidenceFiles(row) {
  const obligations = row.obligations ?? [];
  const nested = obligations.flatMap((entry) => entry.plannedObligations ?? [])
    .filter((entry) => entry.fulfillment === 'evidence').flatMap((entry) => entry.expectedPaths ?? []);
  const direct = obligations.some((entry) => entry.fulfillment === 'evidence') ? row.plan?.expectedPaths ?? [] : [];
  return [...new Set([...nested, ...direct])];
}

/**
 * A runnable witness command: the exact planned file when the criterion has one, and every
 * checklist item the record requires (a single `--confirm` is refused). The person still inspects
 * the file before running it; nothing here answers the checklist for them.
 */
function witnessAction(workId, row, slot) {
  const files = slot.method === 'visual' ? plannedEvidenceFiles(row) : [];
  return `singularity-flow decision witness ${workId} --criterion ${row.id} --slot ${slot.slot} `
    + `--file ${files.length === 1 ? files[0] : '<EVIDENCE-PATH>'} `
    + WITNESS_CHECKLIST.map((item) => `--confirm ${item}`).join(' ')
    + ' --reason "<why this exact evidence satisfies the slot>"';
}

/**
 * Exact, typed continuations for a terminal hold. Publication recovery repairs lifecycle transport;
 * it cannot satisfy evidence obligations, so never make it the only route for this boundary.
 */
export function terminalRecoveryActions(workId, evaluation, gate = null) {
  const decisions = [], witnesses = [], risks = [], diagnostics = [];
  const add = (collection, command) => {
    if (typeof command === 'string' && command.trim() && !collection.includes(command)) collection.push(command);
  };
  for (const row of evaluation?.rows ?? []) {
    if (!BLOCKING_RESULTS.has(row.result)) continue;
    for (const action of row.actions ?? []) {
      if (action.kind === 'decide') add(decisions, action.command);
      if (action.kind === 'accept-risk') add(risks, action.command);
    }
    for (const slot of row.verification?.contract?.slots ?? []) {
      if (BLOCKING_RESULTS.has(slot.status) && WITNESSED_METHODS.has(slot.method)) add(witnesses, witnessAction(workId, row, slot));
    }
  }
  for (const finding of gate?.findings ?? []) add(decisions, finding.recovery?.command);
  if ((evaluation?.decision?.gate === 'block')) add(diagnostics, `singularity-flow evidence matrix ${workId} --json`);
  if ((gate?.errors ?? []).length) add(diagnostics, 'singularity-flow gate --terminal');
  return [...decisions, ...witnesses, ...risks, ...diagnostics];
}

/**
 * Why a blocked evaluation blocks, one line per reason: every blocking finding, and every blocking
 * row no finding explains, so a refusal never lists nothing.
 */
function evidenceBlockersOf(evaluation) {
  if (evaluation.decision.gate !== 'block') return [];
  const blocking = evaluation.findings.filter((entry) => entry.blocking !== false);
  const explained = new Set(blocking.flatMap((entry) => entry.obligationIds ?? []));
  const unexplained = evaluation.rows
    .filter((row) => BLOCKING_RESULTS.has(row.result) && !row.obligations.some((obligation) => explained.has(obligation.id)))
    .map((row) => `${row.id} is ${row.result}.`);
  return [...blocking.map((entry) => entry.message), ...unexplained];
}

/**
 * Evaluate an ending without changing anything. `openStory` names the final phase and its real
 * status: the Story is judged as if closed, but until the transition commits it is open.
 */
export async function evaluateTerminalTransition(root, definition, workflow, { openStory = null } = {}) {
  const graph = await evidenceGraphFromAggregate(root, definition, workflow);
  graph.terminal = null;
  const evaluation = evaluateEvidence(graph, { boundary: 'terminal', mode: 'decision' });
  const gate = await runGovernanceGate(root, definition, workflow, { terminal: true, pendingTransition: true, openStory });
  const evidenceBlockers = evidenceBlockersOf(evaluation);
  // An earlier step's owners decide every upstream issue before the Story ends [UIF-M2].
  const upstream = [...upstreamIssueTerminalBlockers(workflow), ...forwardAmendmentTerminalBlockers(workflow)];
  const blockers = [...new Set([...evidenceBlockers, ...gate.errors, ...upstream.map((entry) => entry.message)])];
  const recovery = [...new Set([...upstream.map((entry) => entry.command), ...terminalRecoveryActions(workflow.workItem.id, evaluation, gate)])];
  return { evaluation, gate, blockers, recovery, upstream };
}

// The preview has no real reviewer by design. Approval authority, assurance and threshold are
// checked by the actual approve command; only findings caused by that synthetic actor are dropped.
const PREVIEW_APPROVAL_CODES = new Set([
  'gate.approval.required-authority', 'gate.approval.unauthorized',
  'gate.approval.assurance-missing', 'gate.approval.minimum', 'gate.approval.threshold'
]);

/**
 * The Story as it will be immediately after the final phase is approved `at`. The synthetic
 * decision exists only in memory and is deliberately not self-approved, attributed or persisted.
 * The ending is dated `at`, as the real approval will be: without it the latest earlier approval
 * dated the ending, and anything that lapsed since surfaced first at the real approval.
 */
export function projectFinalApproval(workflow, { at = nowIso() } = {}) {
  const projected = structuredClone(workflow);
  const phaseId = projected.currentPhase ?? projected.phaseOrder?.at(-1) ?? null;
  const phase = phaseId ? projected.phases?.[phaseId] ?? null : null;
  const openStory = phase ? { phase: phaseId, status: phase.status } : null;
  if (phase && phase.status === 'in_progress') phase.status = 'awaiting_approval';
  if (phase?.status === 'awaiting_approval') {
    phase.status = 'approved';
    phase.approvedAt = at;
    phase.approvals ??= [];
    phase.approvals.push({
      decision: 'approved', generation: phase.generation, at: 'terminal-readiness-preview',
      actor: null, agent: null, authorityGroup: null, selfApproval: false,
      preview: true
    });
  }
  projected.currentPhase = null;
  projected.status = 'closed';
  delete projected.completion;
  return { projected, phaseId, openStory };
}

/**
 * The gate without the approval findings of the synthetic decision on `phaseId`. An earlier
 * step's real approval problem stays, so it surfaces here and not first at the final approval.
 */
export function withoutPreviewApproval(gate, phaseId) {
  const synthetic = (finding) => PREVIEW_APPROVAL_CODES.has(finding.code) && (finding.phase == null || finding.phase === phaseId);
  const omitted = new Set((gate.findings ?? []).filter(synthetic)
    .map((finding) => finding.details?.message ?? finding.message).filter(Boolean));
  return {
    omitted,
    gate: {
      ...gate,
      findings: (gate.findings ?? []).filter((finding) => !synthetic(finding)),
      errors: (gate.errors ?? []).filter((message) => !omitted.has(message))
    }
  };
}

/**
 * Read-only projection of the state immediately after a successful approval of the final phase:
 * it removes the two obligations the pending approval itself will satisfy while all scope,
 * evidence, conformance and integrity inputs remain exact.
 */
export async function evaluateTerminalReadiness(root, definition, workflow, { stage = 'approval' } = {}) {
  const { projected, phaseId, openStory } = projectFinalApproval(workflow);
  const result = await evaluateTerminalTransition(root, definition, projected, { openStory });
  const { gate, omitted } = withoutPreviewApproval(result.gate, phaseId);
  // A visual witness is intentionally recorded only after submission has pinned the exact
  // candidate. Likewise, the final human approval itself supplies pending review obligations.
  // At the submission boundary defer only those two human-after-submission findings; every scope,
  // implementation, test, conformance and integrity finding remains blocking. The approval/status
  // projection uses the default stage and exposes the exact witness route.
  const deferred = stage === 'submission'
    ? (result.evaluation.findings ?? []).filter((finding) =>
      ['EVIDENCE_VISUAL_MISSING', 'EVIDENCE_REVIEW_PENDING'].includes(finding.code))
    : [];
  const deferredMessages = new Set(deferred.map((finding) => finding.message));
  const deferredObligations = new Set(deferred.flatMap((finding) => finding.obligationIds ?? []));
  // Upstream issues are decided by earlier steps' owners while the last step is reviewed; only the
  // ending itself waits for them, so the submission preview defers them too.
  if (stage === 'submission') result.upstream.forEach((entry) => deferredMessages.add(entry.message));
  const blockers = result.blockers.filter((message) => !omitted.has(message) && !deferredMessages.has(message));
  const recovery = [...(stage === 'submission' ? [] : result.upstream.map((entry) => entry.command)),
    ...terminalRecoveryActions(workflow.workItem.id, result.evaluation, gate).filter((command) => {
      if (stage !== 'submission') return true;
      if (command.startsWith('singularity-flow decision witness ')) return false;
      return ![...deferredObligations].some((id) => command.includes(`--obligation ${id}`));
    })];
  return {
    ...result,
    gate,
    blockers,
    recovery
  };
}

export function terminalRefusalMessage(workId, { blockers, recovery }) {
  const listed = blockers.slice(0, MAX_LISTED);
  return [
    `Story ${workId} cannot finish yet: its final evaluation found ${blockers.length === 1 ? 'an open obligation' : `${blockers.length} open obligations`}.`,
    ...listed.map((message) => `- ${message}`),
    ...(blockers.length > listed.length ? [`- …and ${blockers.length - listed.length} more`] : []),
    'Nothing was recorded; the Story stays where it was.',
    ...(recovery.length ? ['Recover:', ...recovery.map((command) => `  ${command}`)] : [])
  ].join('\n');
}

/**
 * Refuse the ending, or record its evaluation on the aggregate the transaction is about to write.
 * Call only with a Story whose transition has just made it complete.
 */
export async function assertTerminalTransition(root, definition, workflow) {
  const result = await evaluateTerminalTransition(root, definition, workflow);
  if (result.blockers.length) {
    const phase = result.evaluation.endpoint?.from ?? workflow.phaseOrder?.at(-1) ?? null;
    const gate = gateRefusal({
      code: 'STORY_COMPLETION_REFUSED', gate: 'terminal',
      subject: { workId: workflow.workItem.id, phase, generation: workflow.phases?.[phase]?.generation ?? null },
      evaluation: result.evaluation.decision.gate === 'block' ? result.evaluation : null,
      findings: [
        ...result.evaluation.findings.filter((entry) => entry.blocking !== false).map(({ code, message }) => ({ code, message })),
        ...(result.gate.findings ?? []).map((finding) => ({ code: finding.code, message: finding.details?.message })),
        ...result.upstream.map(({ code, message }) => ({ code, message }))
      ],
      actions: result.recovery
    });
    throw new SingularityFlowError(terminalRefusalMessage(workflow.workItem.id, result), {
      code: 'STORY_COMPLETION_REFUSED',
      exitCode: 2,
      details: { blockers: result.blockers.slice(0, MAX_LISTED), recovery: result.recovery, gate }
    });
  }
  const decision = { gate: result.evaluation.decision.gate };
  const label = completionLabel({
    workflow, rows: result.evaluation.rows, gate: decision.gate,
    terminal: { mode: 'decision', boundary: 'terminal', decision }
  });
  // A passing evaluation always labels the Story complete; anything else is a defect, never a record.
  if (!['complete', 'complete-with-exceptions'].includes(label.kind)) {
    throw new SingularityFlowError(terminalRefusalMessage(workflow.workItem.id, { blockers: label.reasons, recovery: ['singularity-flow evidence matrix'] }), {
      code: 'STORY_COMPLETION_REFUSED', exitCode: 2, details: { blockers: label.reasons, recovery: ['singularity-flow evidence matrix'] }
    });
  }
  workflow.completion = {
    label: label.label, kind: label.kind, mode: 'decision', boundary: 'terminal', decision,
    inputSha256: result.evaluation.inputSha256,
    assuranceFloor: result.evaluation.summary.assuranceFloor,
    evaluatedAt: nowIso()
  };
  return result;
}

/**
 * Preview the exact completion evaluator before a final phase is submitted. It records nothing;
 * the approval transaction still reruns assertTerminalTransition against the final exact bytes.
 */
export async function assertTerminalReadiness(root, definition, workflow) {
  const result = await evaluateTerminalReadiness(root, definition, workflow, { stage: 'submission' });
  if (!result.blockers.length) return result;
  const phase = result.evaluation.endpoint?.from ?? workflow.currentPhase ?? workflow.phaseOrder?.at(-1) ?? null;
  const blockerMessages = new Set(result.blockers);
  const evidenceFindings = result.evaluation.findings.filter((entry) =>
    entry.blocking !== false && blockerMessages.has(entry.message));
  const obligationIds = new Set(evidenceFindings.flatMap((entry) => entry.obligationIds ?? []));
  const obligations = result.evaluation.rows.flatMap((row) => {
    const unexplainedRow = blockerMessages.has(`${row.id} is ${row.result}.`);
    return (row.obligations ?? []).filter((obligation) =>
      obligationIds.has(obligation.id) || (unexplainedRow && BLOCKING_RESULTS.has(obligation.status)));
  });
  const governanceFindings = (result.gate.findings ?? []).filter((finding) =>
    blockerMessages.has(finding.details?.message));
  const gate = gateRefusal({
    code: 'STORY_TERMINAL_READINESS_REFUSED', gate: 'terminal',
    subject: { workId: workflow.workItem.id, phase, generation: workflow.phases?.[phase]?.generation ?? null },
    evaluation: result.evaluation.decision.gate === 'block' ? result.evaluation : null,
    obligations,
    findings: [
      ...evidenceFindings.map(({ code, message }) => ({ code, message })),
      ...governanceFindings.map((finding) => ({ code: finding.code, message: finding.details?.message }))
    ],
    actions: result.recovery
  });
  throw new SingularityFlowError(
    `${terminalRefusalMessage(workflow.workItem.id, result)}\nResolve these obligations before submitting the final phase; final approval will revalidate the same evidence graph.`,
    {
      code: 'STORY_TERMINAL_READINESS_REFUSED', exitCode: 2,
      details: { blockers: result.blockers.slice(0, MAX_LISTED), recovery: result.recovery, gate }
    }
  );
}
