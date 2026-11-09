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
import { recordSha256 } from '../records.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';
import { evaluateEvidence, testOnlyCorrection } from './evaluate.mjs';
import { WITNESS_CHECKLIST } from '../verification/witness-records.mjs';
import { RISK_CATEGORIES, riskAuthorities, riskEligibility } from './risk-decisions.mjs';
import { evidenceGraphFromAggregate } from './graph.mjs';
import { gateRefusal } from './gate-refusal.mjs';
import { completionLabel } from './labels.mjs';
import { upstreamIssueTerminalBlockers } from '../upstream-issues.mjs';
import { decidableUpstreamStep, raiseUpstreamIssueRoute } from '../upstream-routes.mjs';
import { forwardAmendmentTerminalBlockers, pendingAmendmentRevalidations, revalidateCommand } from '../forward-amendments.mjs';
import { markSyntheticApproval } from '../presence/counted.mjs';

const MAX_LISTED = 20;
const BLOCKING_RESULTS = new Set(['failed', 'inconclusive', 'missing', 'pending']);
// recordWitness accepts only these; a test slot is witnessed by its own run, so offering
// `decision witness` for it would hand the person a command that is always refused.
const WITNESSED_METHODS = new Set(['inspection', 'visual']);

/** The planned evidence files of a criterion, from its plan obligations. */
export function plannedEvidenceFiles(row) {
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
export function terminalRecoveryActions(workId, evaluation, gate = null, workflow = null) {
  const decisions = [], upstream = [], witnesses = [], risks = [], diagnostics = [];
  const add = (collection, command) => {
    if (typeof command === 'string' && command.trim() && !collection.includes(command)) collection.push(command);
  };
  for (const row of evaluation?.rows ?? []) {
    if (!BLOCKING_RESULTS.has(row.result)) continue;
    for (const action of row.actions ?? []) {
      if (action.kind === 'decide') add(decisions, action.command);
      if (action.kind === 'accept-risk') add(risks, action.command);
    }
    // What an earlier step owns is corrected there: an upstream issue this step raises, which that
    // step's approvers decide (a return, a plan correction, an accepted risk or a dismissal). A
    // missing implementation at the final step had only a risk route (2026-10-27).
    if (workflow) for (const obligation of row.obligations ?? []) {
      if (!UPSTREAM_OWNED.has(obligation.responsibility) || !UPSTREAM_STATUSES.has(obligation.status)) continue;
      // A tests-only delivery for a row planned as a product change is corrected in the plan, by its
      // approvers directly; a correction could not change a row's fulfillment before 2026-10-28.
      const owner = (obligation.correctionSteps ?? obligation.owningSteps)?.at(-1);
      if (obligation.correctionSteps && owner) add(decisions, testOnlyCorrection(workId, owner, row.id, row.plan, obligation.deliveredTests ?? []));
      const step = owner ? decidableUpstreamStep(workflow, owner) : null;
      const route = step ? raiseUpstreamIssueRoute(workflow, step, workflow.currentPhase) : null;
      if (route) add(upstream, route.command.replace('<clause-or-section>', row.id).replace('<what-is-wrong>', obligation.correctionSteps
        ? `"Tests are the whole delivery: plan ${row.id} as test-only"` : '<what-is-wrong>'));
    }
    // Evidence a scope revision made stale is its own step's to bring current: that step's approvers
    // say it still holds where the amendment owes them that, or it returns there [PHR:REQ-003]. It
    // had no route: pending is neither upstream-owned nor risk-eligible (2026-11-09 audit).
    if (workflow) for (const obligation of row.obligations ?? []) {
      const owner = obligation.facets?.freshness === 'stale' ? obligation.owningSteps?.at(-1) : null;
      if (!owner || owner === workflow.currentPhase) continue;
      const owed = pendingAmendmentRevalidations(workflow).find((entry) => entry.phase === owner);
      if (owed) add(upstream, revalidateCommand(workId, owed));
      add(upstream, staleEvidenceReturn(workflow, owner, row.id));
    }
    for (const slot of row.verification?.contract?.slots ?? []) {
      if (!BLOCKING_RESULTS.has(slot.status) || !WITNESSED_METHODS.has(slot.method)) continue;
      // The approver confirms the evidence with the approval itself; a separate witness stays possible.
      if (workflow?.currentPhase) add(witnesses, `singularity-flow approve ${workflow.currentPhase} --work-id ${workId} --confirm-evidence`);
      add(witnesses, witnessAction(workId, row, slot));
    }
  }
  for (const finding of gate?.findings ?? []) add(decisions, finding.recovery?.command);
  if ((evaluation?.decision?.gate === 'block')) add(diagnostics, `singularity-flow evidence matrix ${workId} --json`);
  // Both callers judge a Story still open on disk, where `gate --terminal` always adds "not closed".
  // The decision list shows this same as-if-closed evaluation, and runs in any turn.
  if ((gate?.errors ?? []).length) add(diagnostics, `singularity-flow decisions ${workId}`);
  return [...decisions, ...upstream, ...witnesses, ...risks, ...diagnostics];
}

/**
 * The return of stale evidence to the step that produced it: the submitted current step's own return
 * when its policy allows it, else an upstream issue its approvers decide (a return among the
 * choices). Null when neither is open from here, such as on a closed Story.
 */
function staleEvidenceReturn(workflow, owner, clauseId) {
  const workId = workflow.workItem.id;
  const current = workflow.phases?.[workflow.currentPhase];
  if (workflow.status === 'in_progress' && current?.status === 'awaiting_approval' && (current.approvalPolicy?.rejectTo ?? []).includes(owner)) {
    return `singularity-flow reject ${current.id} --work-id ${workId} --to ${owner} --reason <REASON>`;
  }
  const step = decidableUpstreamStep(workflow, owner);
  const route = step ? raiseUpstreamIssueRoute(workflow, step, workflow.currentPhase) : null;
  return route ? route.command.replace('<clause-or-section>', clauseId)
    .replace('<what-is-wrong>', `"Its evidence predates the scope revision; run ${owner} again"`) : null;
}

/**
 * The witness commands that wait for submission: visual ones, recorded once submission pins the
 * candidate. An inspection is witnessed now; its command was dropped at submission too, so only a
 * risk was left, which its owner could not always take (2026-10-28).
 */
export function visualWitnessCommands(workId, evaluation) {
  return new Set((evaluation?.rows ?? []).flatMap((row) => (row.verification?.contract?.slots ?? [])
    .filter((slot) => slot.method === 'visual').map((slot) => witnessAction(workId, row, slot))));
}

const UPSTREAM_OWNED = new Set(['plan', 'implement', 'verify']);
const UPSTREAM_STATUSES = new Set(['missing', 'partial', 'failed']);

/**
 * Whether a person may accept the risk of what holds the ending, as `decision risk` judges each
 * obligation, and who may. A refusal without it said "not eligible" beside the risk commands it
 * listed, so an agent was told both to use them and that they were barred.
 */
export function terminalRisk(workflow, obligations) {
  const eligible = obligations.filter((obligation) => riskEligibility(obligation).eligible);
  return { eligible: eligible.length > 0, authorities: [...new Set(eligible.flatMap((obligation) => riskAuthorities(workflow, obligation)))].sort(), maximumDays: null };
}

/**
 * The evidence decisions a person makes before the Story ends, one per blocking criterion: each
 * visual or inspection slot to witness, with its exact command, and each obligation that may be
 * accepted as a dated risk. The decision list shows these, so it names what the approval refusal
 * names [decision list parity]; nothing here records a witness or a risk.
 */
export function terminalEvidenceDecisions(workId, evaluation, workflow = null) {
  const entries = [];
  for (const row of evaluation?.rows ?? []) {
    if (!BLOCKING_RESULTS.has(row.result)) continue;
    // Who may take each, as `decision witness` and `decision risk` check it, for the list to name.
    const groups = (obligations) => (workflow ? { groups: riskAuthorities(workflow, { owningSteps: [...new Set(obligations.flatMap((entry) => entry.owningSteps ?? []))] }) } : {});
    const witnesses = (row.verification?.contract?.slots ?? [])
      .filter((slot) => BLOCKING_RESULTS.has(slot.status) && WITNESSED_METHODS.has(slot.method))
      .map((slot) => ({ slot: slot.slot, method: slot.method, files: slot.method === 'visual' ? plannedEvidenceFiles(row) : [],
        command: witnessAction(workId, row, slot), ...groups((row.obligations ?? []).filter((entry) => ['verify', 'implement'].includes(entry.responsibility))) }));
    const risks = [...new Set((row.actions ?? []).filter((action) => action.kind === 'accept-risk').map((action) => action.command))]
      .map((command) => {
        const obligationId = /--obligation (\S+)/u.exec(command)?.[1] ?? null;
        return { obligationId, command, ...groups((row.obligations ?? []).filter((entry) => entry.id === obligationId)) };
      });
    if (witnesses.length || risks.length) entries.push({ criterion: row.id, result: row.result, witnesses, risks, categories: [...RISK_CATEGORIES] });
  }
  return entries;
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
  const decisions = await pendingDecisionLead(workflow, gate, upstream, openStory);
  const recovery = [...new Set([...(decisions ? [decisions.nextAction.command] : []), ...upstream.map((entry) => entry.command),
    ...terminalRecoveryActions(workflow.workItem.id, evaluation, gate, workflow)])];
  return { evaluation, gate, blockers, recovery, upstream, decisions };
}

/**
 * When the ending waits for people's decisions (a conformance gap, an open upstream issue), the
 * plain sentence and the decision-list route that lead its refusal; null otherwise.
 */
async function pendingDecisionLead(workflow, gate, upstream, openStory) {
  const gaps = (gate.findings ?? []).filter((finding) => finding.code === 'gate.conformance.blocking-verdict' && finding.details?.clauseId)
    .map((finding) => ({ report: finding.phase, clauseId: finding.details.clauseId, verdict: finding.details.verdict,
      owner: finding.details.owner, status: finding.details.status, issue: finding.details.issue ?? null }));
  if (!gaps.length && !upstream.some((entry) => entry.code === 'UPSTREAM_ISSUES_OPEN')) return null;
  const [{ decisionRefusalLead }, { upstreamIssueStates }] = await Promise.all([import('../decision-list-facts.mjs'), import('../upstream-routes.mjs')]);
  const order = workflow.phaseOrder ?? [];
  const phaseId = openStory?.phase ?? [...order].reverse().find((id) => workflow.phases?.[id]?.status !== 'skipped') ?? null;
  return phaseId ? decisionRefusalLead(workflow, phaseId, { gaps, issues: upstreamIssueStates(workflow), includeAllIssues: true }) : null;
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
    phase.approvals.push(markSyntheticApproval({
      decision: 'approved', generation: phase.generation, at: 'terminal-readiness-preview',
      actor: null, agent: null, authorityGroup: null, selfApproval: false,
      preview: true
    }));
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
  const { gate: previewGate, omitted } = withoutPreviewApproval(result.gate, phaseId);
  // A partial or missing verdict submits as written: a person decides it while the step is reviewed,
  // and approval and the ending refuse it until then [owner decision 2026-10-19].
  const gapFindings = stage === 'submission'
    ? (previewGate.findings ?? []).filter((finding) => finding.code === 'gate.conformance.blocking-verdict') : [];
  const gapMessages = new Set(gapFindings.map((finding) => finding.details?.message).filter(Boolean));
  const gate = gapFindings.length ? { ...previewGate,
    findings: previewGate.findings.filter((finding) => !gapFindings.includes(finding)),
    errors: previewGate.errors.filter((message) => !gapMessages.has(message)) } : previewGate;
  // A visual witness is intentionally recorded only after submission has pinned the exact
  // candidate. Likewise, the final human approval itself supplies pending review obligations.
  // At the submission boundary defer only those two human-after-submission findings (and the
  // conformance gap decisions above); every scope, implementation, test, conformance-row and
  // integrity finding remains blocking. The approval/status
  // projection uses the default stage and exposes the exact witness route.
  const deferred = stage === 'submission'
    ? (result.evaluation.findings ?? []).filter((finding) =>
      ['EVIDENCE_VISUAL_MISSING', 'EVIDENCE_REVIEW_PENDING'].includes(finding.code))
    : [];
  const deferredMessages = new Set([...deferred.map((finding) => finding.message), ...gapMessages]);
  const deferredObligations = new Set(deferred.flatMap((finding) => finding.obligationIds ?? []));
  // Upstream issues are decided by earlier steps' owners while the last step is reviewed; only the
  // ending itself waits for them, so the submission preview defers them too.
  if (stage === 'submission') result.upstream.forEach((entry) => deferredMessages.add(entry.message));
  const blockers = result.blockers.filter((message) => !omitted.has(message) && !deferredMessages.has(message));
  // Submission defers the decisions; approval and the ending lead with their list.
  const decisions = stage === 'submission' ? null : result.decisions;
  const visualWitness = visualWitnessCommands(workflow.workItem.id, result.evaluation);
  const recovery = [...(decisions ? [decisions.nextAction.command] : []), ...(stage === 'submission' ? [] : result.upstream.map((entry) => entry.command)),
    ...terminalRecoveryActions(workflow.workItem.id, result.evaluation, gate, workflow).filter((command) => {
      if (stage !== 'submission') return true;
      if (visualWitness.has(command) || command.includes(' --confirm-evidence')) return false;
      return ![...deferredObligations].some((id) => command.includes(`--obligation ${id}`));
    })];
  return {
    ...result,
    gate,
    blockers,
    recovery: [...new Set(recovery)],
    decisions
  };
}

export function terminalRefusalMessage(workId, { blockers, recovery, decisions = null }) {
  const listed = blockers.slice(0, MAX_LISTED);
  return [
    ...(decisions ? [`${decisions.headline} ${decisions.route}`] : []),
    `Story ${workId} cannot finish yet: its final evaluation found ${blockers.length === 1 ? 'an open obligation' : `${blockers.length} open obligations`}.`,
    ...listed.map((message) => `- ${message}`),
    ...(blockers.length > listed.length ? [`- …and ${blockers.length - listed.length} more`] : []),
    'Nothing was recorded; the Story stays where it was.',
    ...(recovery.length ? ['Recover:', ...recovery.map((command) => `  ${command}`)] : [])
  ].join('\n');
}

const readinessOnce = new WeakMap();
/**
 * evaluateTerminalReadiness for one read of the Story: the slowest read on these paths, which the
 * approval check, readiness and the list each ask for at its last step. A changed workflow reads again.
 */
export function terminalReadinessOnce(root, definition, workflow, { stage = 'approval' } = {}) {
  const key = `${stage}:${recordSha256(workflow)}`;
  const known = readinessOnce.get(workflow);
  if (known?.key === key) return known.result;
  const result = evaluateTerminalReadiness(root, definition, workflow, { stage });
  readinessOnce.set(workflow, { key, result });
  return result;
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
      risk: terminalRisk(workflow, result.evaluation.rows.flatMap((row) => row.obligations ?? []).filter((obligation) => BLOCKING_RESULTS.has(obligation.status))),
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
      details: { blockers: result.blockers.slice(0, MAX_LISTED), recovery: result.recovery, gate,
        ...(result.decisions ? { decisions: { count: result.decisions.count, headline: result.decisions.headline }, nextAction: result.decisions.nextAction } : {}) }
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
    risk: terminalRisk(workflow, obligations),
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
