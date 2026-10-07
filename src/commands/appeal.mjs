import { repoRoot } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { assertPhaseAppealsResolved, attestPhaseAppeal, decidePhaseAppeal, phaseAppealDecisionHash, phaseAppealStatus, preparePhaseAppeal, submitPhaseAppeal } from '../phase-appeals.mjs';
import { phasePrepublish } from '../phase-prepublish.mjs';
import { phaseResolutionProjection } from '../phase-resolution.mjs';
import { phaseDraftCheck } from '../phase-draft-check.mjs';
import { recoveryPlan } from '../collaboration.mjs';
import { coordinatePhaseRepair } from '../phase-repair-runtime.mjs';
import { phaseRepairLoopSummary } from '../phase-repair-journal.mjs';
import { acceptQualityRisk, attestQualityRisk, inspectPhaseQualityGate, prepareQualityRisk, revokeQualityRisk } from '../phase-quality-risk.mjs';
import { loadSession } from '../session.mjs';
import { operationContext } from '../operation-context.mjs';
import { requiresProspectivePhaseInspection } from '../code-submission-evidence.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';
import { createPhaseCheckpoint, inspectPhaseCheckpoint } from '../phase-checkpoint.mjs';
import { inspectPhaseAuthoredReviewContent } from '../publication-preflight.mjs';
import { artifactQualityStatus } from '../phase-artifact-risk.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { prepareEvidenceContractCorrection, acceptEvidenceContractCorrection } from '../phase-evidence-amendment.mjs';

const actions = ['preflight', 'prepare', 'submit', 'list', 'show', 'decide', 'attest', 'risk-prepare', 'risk-accept', 'risk-attest', 'risk-revoke', 'repair-plan', 'repair-status', 'repair-run', 'repair-resume', 'checkpoint', 'checkpoint-show', 'evidence-prepare', 'evidence-accept'];
function riskRequest(options) {
  return { phaseId: optionString(options, 'phase') ?? undefined, gateMode: optionString(options, 'gate-mode') ?? undefined,
    clauses: optionStrings(options, 'clause'), transitions: optionStrings(options, 'transition').length
      ? optionStrings(options, 'transition') : undefined, expires: optionString(options, 'expires'),
    findings: optionStrings(options, 'finding'),
    reason: optionString(options, 'reason'), confirm: optionString(options, 'confirm') };
}
function request(options) {
  const split = (value, flag) => {
    const at = value.indexOf('=');
    if (at < 1) throw new SingularityFlowError(`${flag} needs an exact identity=path or path=class.`, { code: 'PHASE_APPEAL_INVALID' });
    return [value.slice(0, at), value.slice(at + 1)];
  };
  const reasons = optionStrings(options, 'supporting-reason');
  const changes = [
    ...optionStrings(options, 'add-location').map(value => { const [clauseId, path] = split(value, '--add-location'); return { kind: 'add-location', clauseId, path }; }),
    ...optionStrings(options, 'add-supporting').map((value, index) => { const [path, kind] = split(value, '--add-supporting'); return { kind: 'add-supporting', path, class: kind, reason: reasons[index] ?? '' }; })
  ];
  if (reasons.length !== changes.filter(entry => entry.kind === 'add-supporting').length) throw new SingularityFlowError('Give exactly one --supporting-reason for each supporting path.');
  return { phaseId: optionString(options, 'phase') ?? undefined, changes, reason: optionString(options, 'reason') ?? '', confirm: optionString(options, 'confirm') };
}

export async function run(argv, { positionals = argv, options = {}, root = repoRoot() } = {}) {
  const action = positionals[1] ?? 'preflight';
  if (options.help === true) {
    console.log('Phase appeals: preflight | prepare | submit | list | show APL-ID | decide APL-ID\n'
      + 'prepare/submit: --phase ID --add-location CLAUSE=PATH or --add-supporting PATH=CLASS --supporting-reason TEXT --reason TEXT\n'
      + 'submit: --confirm PACKET_SHA256\ndecide: --decision account-scope|request-changes --reason TEXT --confirm PACKET_SHA256 (live terminal review required)\n'
      + 'repair-plan/repair-status: --phase ID; repair-run: --phase ID --confirm PLAN_SHA256; repair-resume: --phase ID\n'
      + 'checkpoint: --phase ID saves private dirty-file/index recovery copies; checkpoint-show PCP-ID verifies them without restoring files\n'
      + 'risk-prepare/risk-accept: --phase ID [--gate-mode soft] [--clause EXACT-ID | --finding EXACT-CODE] [--transition publish|submit|approve|consume|terminal] --expires YYYY-MM-DD --reason TEXT; risk-accept also --confirm PACKET_SHA256 (live human review)\n'
      + 'risk-attest/risk-revoke PQR-ID: --confirm DECISION_SHA256; revoke also --reason TEXT\n'
      + 'evidence-prepare/evidence-accept: --phase ID --clause EXACT-AC --path STORY/evidence/FILE --method visual|inspection --reason TEXT; accept also --confirm PACKET_SHA256 (live plan-authority review). No tests or visual checks are waived.\n'
      + 'Extra behaviour: story intent-amendment; eligible failed checks: story test-policy risks. Neither is waived by accounting for scope.');
    return;
  }
  if (!actions.includes(action)) throw new SingularityFlowError('Unknown appeal action.', { code: 'PHASE_APPEAL_ACTION_INVALID' });
  const allowed = new Set(['json', 'help', 'no-model', 'work-id', 'phase']);
  if (['prepare', 'submit'].includes(action)) ['add-location', 'add-supporting', 'supporting-reason', 'reason', ...(action === 'submit' ? ['confirm'] : [])].forEach(key => allowed.add(key));
  if (action === 'decide') ['decision', 'reason', 'confirm'].forEach(key => allowed.add(key));
  if (action === 'attest') allowed.add('confirm');
  if (['evidence-prepare', 'evidence-accept'].includes(action)) ['clause', 'path', 'method', 'reason',
    ...(action === 'evidence-accept' ? ['confirm'] : [])].forEach(key => allowed.add(key));
  if (action === 'repair-run') allowed.add('confirm');
  if (['risk-prepare', 'risk-accept'].includes(action)) ['gate-mode', 'clause', 'finding', 'transition', 'expires', 'reason', ...(action === 'risk-accept' ? ['confirm'] : [])].forEach(key => allowed.add(key));
  if (['risk-attest', 'risk-revoke'].includes(action)) ['confirm', ...(action === 'risk-revoke' ? ['reason'] : [])].forEach(key => allowed.add(key));
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new SingularityFlowError(`Unsupported appeal option --${key}. No blanket waiver, automatic approval or source rewrite is available.`, { code: 'PHASE_APPEAL_OPTIONS_INVALID' });
  if (positionals.length > (['show', 'decide', 'attest', 'risk-attest', 'risk-revoke', 'checkpoint-show'].includes(action) ? 3 : 2)) throw new SingularityFlowError('Unexpected appeal arguments. Use --work-id for the attached Story.');
  const { workflow, definition: config } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  const phase = workflow.phases?.[optionString(options, 'phase') ?? workflow.currentPhase];
  if ((action !== 'list' || optionString(options, 'phase')) && !phase) throw new SingularityFlowError('Choose an existing phase with --phase.');
  let data;
  const modelEnabled = operationContext()?.modelMode?.enabled !== false;
  if (action.startsWith('evidence-')) {
    for (const key of ['work-id', 'phase', 'clause', 'path', 'method', 'reason', 'confirm']) {
      if (optionStrings(options, key).length > 1) throw new SingularityFlowError(`Choose one exact --${key} for this evidence correction.`, { code: 'PHASE_APPEAL_OPTIONS_INVALID' });
    }
    const request = { phaseId: phase.id, clauseId: optionString(options, 'clause'),
      evidencePath: optionString(options, 'path'), method: optionString(options, 'method') ?? 'visual',
      reason: optionString(options, 'reason'), confirm: optionString(options, 'confirm') };
    data = action === 'evidence-prepare'
      ? { status: 'review-required', stateChanged: false, packet: await prepareEvidenceContractCorrection(root, config, workflow, request) }
      : await acceptEvidenceContractCorrection(root, config, workflow, request);
  }
  if (action === 'checkpoint') data = await withSubjectLock(root, { kind: 'story', id: workflow.workItem.id },
    () => createPhaseCheckpoint(root, config, workflow, phase));
  if (action === 'checkpoint-show') data = await inspectPhaseCheckpoint(root, workflow, phase, positionals[2]);
  if (action === 'prepare') data = { status: 'review-required', packet: await preparePhaseAppeal(root, config, workflow, request(options)), stateChanged: false };
  if (action === 'submit') data = await submitPhaseAppeal(root, config, workflow, request(options));
  if (action === 'list') data = await phaseAppealStatus(root, config, workflow, optionString(options, 'phase') ? phase : null);
  if (action === 'show') {
    await phaseAppealStatus(root, config, workflow);
    const packet = (workflow.phaseAppeals ?? []).find(entry => entry.id === positionals[2]);
    if (!packet) throw new SingularityFlowError('Choose an exact retained appeal ID from appeal list.', { code: 'PHASE_APPEAL_NOT_FOUND' });
    const decisions = (workflow.phaseAppealDecisions ?? []).filter(entry => entry.appealId === packet.id);
    data = { packet, decisions, decisionSha256: decisions[0] ? phaseAppealDecisionHash(decisions[0]) : null };
  }
  if (action === 'decide') data = await decidePhaseAppeal(root, config, workflow, { id: positionals[2], decision: optionString(options, 'decision'), reason: optionString(options, 'reason'), confirm: optionString(options, 'confirm') });
  if (action === 'attest') data = await attestPhaseAppeal(root, config, workflow, { id: positionals[2], confirm: optionString(options, 'confirm') });
  if (action === 'risk-prepare') data = { status: 'review-required', packet: await prepareQualityRisk(root, config, workflow, riskRequest(options)), stateChanged: false };
  if (action === 'risk-accept') data = await acceptQualityRisk(root, config, workflow, riskRequest(options));
  if (action === 'risk-attest') data = await attestQualityRisk(root, config, workflow, { id: positionals[2], confirm: optionString(options, 'confirm') });
  if (action === 'risk-revoke') data = await revokeQualityRisk(root, config, workflow, { id: positionals[2], confirm: optionString(options, 'confirm'), reason: optionString(options, 'reason') });
  if (action.startsWith('repair-')) data = await coordinatePhaseRepair({ root, workId: workflow.workItem.id,
    phaseId: phase.id, action: action.slice(7), confirmation: optionString(options, 'confirm'), modelEnabled });
  if (action === 'preflight') {
    const session = await loadSession(root, { required: false });
    const drafting = requiresProspectivePhaseInspection(workflow, phase);
    const inspection = drafting ? await phasePrepublish(root, config, workflow, phase, { session, modelEnabled })
      : await phaseDraftCheck(root, config, workflow, phase, { session, modelEnabled });
    const recovery = await recoveryPlan(root, config, workflow, { phaseId: phase.id, inspectActivePhase: true, modelEnabled });
    const quality = await inspectPhaseQualityGate(root, config, workflow, phase,
      { transition: phase.status === 'awaiting_approval' ? 'approve' : 'submit' });
    const artifactQuality = await artifactQualityStatus(root, config, workflow, phase,
      await inspectPhaseAuthoredReviewContent(root, config, workflow, phase, { resolveRisks: false }),
      { transition: drafting ? 'publish' : phase.status === 'awaiting_approval' ? 'approve' : 'submit' });
    // Prefer the exact owning gate over wrappers of that same refusal, so a coverage gap does
    // not simultaneously suggest an unrelated test-risk route.
    const findings = [...quality.findings, ...inspection.findings, ...recovery.blockers];
    const seen = new Set();
    const unique = findings.filter(entry => { const key = `${entry.details?.sourceCode ?? entry.code}:${entry.path ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; });
    let appeals;
    try { appeals = await phaseAppealStatus(root, config, workflow, phase); await assertPhaseAppealsResolved(root, config, workflow, phase); }
    catch (error) { unique.push({ code: error.code, category: 'appeal', path: null, message: error.message }); }
    data = { status: unique.length ? 'resolution-required' : 'ready-for-next-check', workId: workflow.workItem.id, phaseId: phase.id,
      resolution: phaseResolutionProjection(workflow, phase, unique), inspection, recovery, appeals, quality, artifactQuality,
      repairLoop: inspection.repairLoop ?? await phaseRepairLoopSummary(root, workflow, phase),
      mutates: false, modelInvocations: 0, testsRun: false, phaseAdvanced: false };
  }
  const changed = data.stateChanged === true;
  if (!optionBoolean(options, 'json')) console.log(JSON.stringify(data, null, 2));
  return emitCommandResult(commandResult({
    operation: { id: `appeal.${action}`, classification: ['submit', 'decide', 'attest', 'risk-accept', 'risk-attest', 'risk-revoke', 'repair-run', 'repair-resume', 'checkpoint', 'evidence-accept'].includes(action) ? 'mutation' : 'read' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded(['submit', 'decide', 'attest', 'risk-accept', 'risk-attest', 'risk-revoke', 'repair-run', 'repair-resume', 'evidence-accept'].includes(action) ? 'appeal.review-result' : 'appeal.inspected', { action, status: data.status ?? 'informational' }),
    effects: changed ? effects({ stateChanged: true, filesChanged: true, publicationCreated: true,
      externalSystemsChanged: Boolean(data.publication?.pushed) }) : data.journalChanged ? effects({ filesChanged: true,
      externalSystemsChanged: data.registeredOperationExecuted === true }) : data.localFilesChanged ? effects({ filesChanged: true }) : noEffects(), data
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
