import { repoRoot } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { attestPhaseAppeal, decidePhaseAppeal, phaseAppealDecisionHash, phaseAppealStatus, preparePhaseAppeal, submitPhaseAppeal } from '../phase-appeals.mjs';
import { inspectPhaseJourney } from '../phase-journey-inspection.mjs';
import { coordinatePhaseContinuation } from '../phase-continuation-runtime.mjs';
import { coordinatePhaseRepair } from '../phase-repair-runtime.mjs';
import { acceptQualityRisk, attestQualityRisk, prepareQualityRisk, revokeQualityRisk } from '../phase-quality-risk.mjs';
import { operationContext } from '../operation-context.mjs';
import { commandResult, effects, noEffects, succeeded, action as nextAction } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';
import { createPhaseCheckpoint, inspectPhaseCheckpoint } from '../phase-checkpoint.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { prepareEvidenceContractCorrection, acceptEvidenceContractCorrection } from '../phase-evidence-amendment.mjs';

const actions = ['preflight', 'resolve', 'resolve-run', 'resolve-resume', 'prepare', 'submit', 'list', 'show', 'decide', 'attest', 'risk-prepare', 'risk-accept', 'risk-attest', 'risk-revoke', 'repair-plan', 'repair-status', 'repair-run', 'repair-resume', 'repair-quarantine', 'task-quarantine', 'task-checkpoint', 'checkpoint', 'checkpoint-show', 'evidence-prepare', 'evidence-accept'];
function riskRequest(options) {
  return { phaseId: optionString(options, 'phase') ?? undefined, gateMode: optionString(options, 'gate-mode') ?? undefined,
    clauses: optionStrings(options, 'clause'), transitions: optionStrings(options, 'transition').length
      ? optionStrings(options, 'transition') : undefined, expires: optionString(options, 'expires'),
    findings: optionStrings(options, 'finding'), evidence: optionStrings(options, 'evidence-file'),
    reason: optionString(options, 'reason'), confirm: optionString(options, 'confirm') };
}
function request(options, workId = null) {
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
  if (reasons.length !== changes.filter(entry => entry.kind === 'add-supporting').length) {
    throw new SingularityFlowError(`Give exactly one --supporting-reason for each supporting path: ${changes.filter(entry => entry.kind === 'add-supporting').length} path(s), ${reasons.length} reason(s).`,
      { code: 'PHASE_APPEAL_INVALID', details: { needs: ['supporting-reason'], workId } });
  }
  return { phaseId: optionString(options, 'phase') ?? undefined, changes, reason: optionString(options, 'reason') ?? '', confirm: optionString(options, 'confirm') };
}

export async function run(argv, { positionals = argv, options = {}, root = repoRoot() } = {}) {
  const action = positionals[1] ?? 'preflight';
  if (options.help === true) {
    console.log('Phase appeals: preflight | prepare | submit | list | show APL-ID | decide APL-ID\n'
      + 'prepare/submit: --phase ID --add-location CLAUSE=PATH or --add-supporting PATH=CLASS --supporting-reason TEXT --reason TEXT\n'
      + 'submit: --confirm PACKET_SHA256\ndecide: --decision account-scope|request-changes --reason TEXT --confirm PACKET_SHA256 (live terminal review required)\n'
      + 'repair-plan/repair-status: --phase ID; repair-run: --phase ID --confirm PLAN_SHA256; repair-resume: --phase ID\n'
      + 'repair-quarantine: --phase ID previews a corrupt repair journal; --confirm SHA256 moves it to private quarantine (nothing deleted, budget not refunded)\n'
      + 'task-quarantine: --phase ID [--role author|source-reviewer] previews exact task progress; --confirm SHA256 preserves its bytes and disables automatic retries for this task, while current owned draft correction remains available\n'
      + 'task-checkpoint: --phase ID [--role author|source-reviewer] shares progress metadata through state for laptop takeover; it never shares uncommitted source or local attachments\n'
      + 'resolve: --phase ID previews the shared journey; resolve-run: --confirm SHA256 runs at most publish then submit through normal gates (tests may run); resolve-resume inspects an interrupted operation without replay. Never approves or answers human reviews.\n'
      + 'checkpoint: --phase ID saves private dirty-file/index recovery copies; checkpoint-show PCP-ID verifies them without restoring files\n'
      + 'risk-prepare/risk-accept: --phase ID [--gate-mode soft] [--clause EXACT-ID | --finding EXACT-CODE] [--transition publish|submit|approve|consume|terminal] --expires YYYY-MM-DD --reason TEXT; risk-accept also --confirm PACKET_SHA256 (live human review)\n'
      + 'dispute (a finding the author cannot fix because the check misreads correct work): risk-prepare/risk-accept --phase ID --finding CODE_DELIVERY_EVIDENCE_REQUIRED --evidence-file PATH [--evidence-file PATH]... --expires YYYY-MM-DD --reason TEXT; the step\'s approvers accept it live, as an exception for that exact candidate, never a pass\n'
      + 'risk-attest/risk-revoke PQR-ID: --confirm DECISION_SHA256; revoke also --reason TEXT\n'
      + 'evidence-prepare/evidence-accept: --phase ID --clause EXACT-AC --path STORY/evidence/FILE --method visual|inspection --reason TEXT; accept also --confirm PACKET_SHA256 [--review-ui] (local browser or terminal human review). No tests or visual checks are waived.\n'
      + 'Extra behaviour: story intent-amendment; eligible failed checks: story test-policy risks. Neither is waived by accounting for scope.');
    return;
  }
  if (!actions.includes(action)) throw new SingularityFlowError('Unknown appeal action.', { code: 'PHASE_APPEAL_ACTION_INVALID' });
  const allowed = new Set(['json', 'help', 'no-model', 'work-id', 'phase']);
  if (['prepare', 'submit'].includes(action)) ['add-location', 'add-supporting', 'supporting-reason', 'reason', ...(action === 'submit' ? ['confirm'] : [])].forEach(key => allowed.add(key));
  if (action === 'decide') ['decision', 'reason', 'confirm'].forEach(key => allowed.add(key));
  if (action === 'attest') allowed.add('confirm');
  if (['evidence-prepare', 'evidence-accept'].includes(action)) ['clause', 'path', 'method', 'reason',
    ...(action === 'evidence-accept' ? ['confirm', 'review-ui'] : [])].forEach(key => allowed.add(key));
  if (['repair-run', 'repair-quarantine'].includes(action)) allowed.add('confirm');
  if (action === 'task-quarantine') { allowed.add('confirm'); allowed.add('role'); }
  if (action === 'task-checkpoint') allowed.add('role');
  if (action === 'resolve-run') allowed.add('confirm');
  if (['risk-prepare', 'risk-accept'].includes(action)) ['gate-mode', 'clause', 'finding', 'evidence-file', 'transition', 'expires', 'reason', ...(action === 'risk-accept' ? ['confirm'] : [])].forEach(key => allowed.add(key));
  if (['risk-attest', 'risk-revoke'].includes(action)) ['confirm', ...(action === 'risk-revoke' ? ['reason'] : [])].forEach(key => allowed.add(key));
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new SingularityFlowError(`Unsupported appeal option --${key}. No blanket waiver, automatic approval or source rewrite is available.`, { code: 'PHASE_APPEAL_OPTIONS_INVALID' });
  if (positionals.length > (['show', 'decide', 'attest', 'risk-attest', 'risk-revoke', 'checkpoint-show'].includes(action) ? 3 : 2)) throw new SingularityFlowError('Unexpected appeal arguments. Use --work-id for the attached Story.');
  const { workflow, definition: config } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  const phase = workflow.phases?.[optionString(options, 'phase') ?? workflow.currentPhase];
  if ((action !== 'list' || optionString(options, 'phase')) && !phase) throw new SingularityFlowError('Choose an existing phase with --phase.');
  let data;
  if (action === 'task-checkpoint') data = await (await import('../workflow-task-store.mjs')).shareWorkflowTaskProgress(
    root, workflow, phase, { role: optionString(options, 'role') ?? 'author' });
  if (action === 'task-quarantine') data = await (await import('../workflow-task-store.mjs')).quarantineWorkflowTaskProgress(
    root, workflow, phase, { role: optionString(options, 'role') ?? 'author', confirm: optionString(options, 'confirm') });
  const modelEnabled = operationContext()?.modelMode?.enabled !== false;
  if (action.startsWith('resolve')) {
    for (const key of ['work-id', 'phase', 'confirm']) if (optionStrings(options, key).length > 1) {
      throw new SingularityFlowError(`Choose one exact --${key}.`, { code: 'PHASE_APPEAL_OPTIONS_INVALID' });
    }
    data = await coordinatePhaseContinuation({ root, workId: workflow.workItem.id, phaseId: phase.id,
      action: action === 'resolve' ? 'preview' : action.slice(8), confirmation: optionString(options, 'confirm'), modelEnabled });
  }
  if (action.startsWith('evidence-')) {
    for (const key of ['work-id', 'phase', 'clause', 'path', 'method', 'reason', 'confirm']) {
      if (optionStrings(options, key).length > 1) throw new SingularityFlowError(`Choose one exact --${key} for this evidence correction.`, { code: 'PHASE_APPEAL_OPTIONS_INVALID' });
    }
    const request = { phaseId: phase.id, clauseId: optionString(options, 'clause'),
      evidencePath: optionString(options, 'path'), method: optionString(options, 'method') ?? 'visual',
      reason: optionString(options, 'reason'), confirm: optionString(options, 'confirm'), reviewUi: optionBoolean(options, 'review-ui') };
    data = action === 'evidence-prepare'
      ? { status: 'review-required', stateChanged: false, packet: await prepareEvidenceContractCorrection(root, config, workflow, request) }
      : await acceptEvidenceContractCorrection(root, config, workflow, request);
  }
  if (action === 'checkpoint') data = await withSubjectLock(root, { kind: 'story', id: workflow.workItem.id },
    () => createPhaseCheckpoint(root, config, workflow, phase));
  if (action === 'checkpoint-show') data = await inspectPhaseCheckpoint(root, workflow, phase, positionals[2]);
  // A scope appeal is a departure now [CQF:REQ-029]: its exact changes are checked as before, then each is
  // recorded for a person to decide once on the decision list, with no appeal review of its own.
  if (action === 'prepare') {
    const packet = await preparePhaseAppeal(root, config, workflow, request(options, workflow.workItem.id));
    const [{ recordAppealDepartures }, { actionActor }, { loadSession }] = await Promise.all([import('../departure-records.mjs'), import('../git.mjs'), import('../session.mjs')]);
    const session = await loadSession(root, { required: false });
    const departures = await recordAppealDepartures(root, config, workflow, packet,
      { actor: actionActor(root), agent: session?.workId === workflow.workItem.id ? session.agent ?? null : null });
    data = { status: 'departure-recorded', departures: departures.map((entry) => ({ id: entry.id, kind: entry.kind, paths: entry.paths, clauses: entry.clauses })),
      stateChanged: true, nextAction: { command: `singularity-flow decisions ${workflow.workItem.id}`, skill: '/sf-decide',
        label: 'A person decides each departure on the decision list before the step is approved; the step keeps working.' } };
  }
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
    data = await inspectPhaseJourney(root, config, workflow, phase, { modelEnabled });
    const inspection = data;
    // Reuse this invocation's inspection. A persisted refusal must stay visible when the
    // screen reopens, rather than claiming static readiness erased a failed operation.
    const continuation = await coordinatePhaseContinuation({ root, workId: workflow.workItem.id,
      phaseId: phase.id, modelEnabled }, { inspect: async () => inspection });
    data = { ...inspection, journey: continuation.journey, continuation: {
      status: continuation.status, next: continuation.next, continuationAllowed: continuation.continuationAllowed,
      consumed: continuation.consumed, attemptsRemaining: continuation.attemptsRemaining } };
    // No appeal is open, and a person's choice is what clears this step: say so, not /sf-code again (bin-opr2).
    if (data.appeals?.status !== 'needs-human') {
      const pin = await (await import('../node-pin.mjs')).storyNodePin(root, config, workflow, phase, { failedOnly: true }).catch(() => null);
      if (pin) data = { ...data, nextStep: { command: `singularity-flow decisions ${workflow.workItem.id}`, skill: '/sf-decide', copilotCommand: `/sf-decide ${workflow.workItem.id}`,
        reason: `No appeal is open. What stops this step is a person's choice: ${pin.words} Pin Node ${pin.version} creates ${pin.file} and amends the plan in one step.` } };
    }
  }
  const changed = data.stateChanged === true;
  const postState = action.startsWith('resolve') && action !== 'resolve'
    ? (await loadAcceptedStoryExecution(root, workflow.workItem.id)).workflow : workflow;
  if (!optionBoolean(options, 'json')) console.log(JSON.stringify(data, null, 2));
  return emitCommandResult(commandResult({
    operation: ['repair-quarantine', 'task-quarantine'].includes(action)
      ? { id: `appeal.${action}${optionString(options, 'confirm') ? '' : '.preview'}`, classification: optionString(options, 'confirm') ? 'mutation' : 'read' }
      : { id: `appeal.${action}`, classification: ['submit', 'decide', 'attest', 'risk-accept', 'risk-attest', 'risk-revoke', 'repair-run', 'repair-resume', 'resolve-run', 'resolve-resume', 'checkpoint', 'task-checkpoint', 'evidence-accept'].includes(action) ? 'mutation' : 'read' },
    subject: { kind: 'story', id: workflow.workItem.id },
    ...(data.status === 'owner-required' ? { restState: 'blocked' } : {}),
    ...(data.nextStep ? { next: [nextAction({ id: 'appeal.preflight.next', command: data.nextStep.command, skill: data.nextStep.skill, label: data.nextStep.reason, rank: 'NOW' })] } : {}),
    ...(action.startsWith('task-') && data.commandGuidance ? { next: [nextAction({ id: `task.${action}.next`,
      command: data.commandGuidance.command, skill: data.commandGuidance.skill,
      label: data.status === 'confirmation-required' ? 'Review the exact task metadata recovery.' : 'Resume the current task from fresh bindings.', rank: 'NOW' })] } : {}),
    outcome: succeeded(action.startsWith('task-') ? 'task.progress' : ['submit', 'decide', 'attest', 'risk-accept', 'risk-attest', 'risk-revoke', 'repair-run', 'repair-resume', 'evidence-accept'].includes(action) ? 'appeal.review-result' : 'appeal.inspected', { action, status: data.status ?? 'informational' }),
    effects: changed ? effects({ stateChanged: true, filesChanged: true, publicationCreated: true,
      externalSystemsChanged: Boolean(data.publication?.pushed) }) : data.journalChanged ? effects({ filesChanged: true,
      externalSystemsChanged: data.registeredOperationExecuted === true }) : data.localFilesChanged ? effects({ filesChanged: true }) : noEffects(), data
  }), { json: optionBoolean(options, 'json'), postState });
}
