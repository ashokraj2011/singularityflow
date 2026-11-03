/** Portable progress, never lifecycle evidence, consent, a lease or executable authority. */
import { recordSha256 } from './records.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { SingularityFlowError } from './util.mjs';
import { hasPublishedPhaseGeneration, phaseInspectionGeneration } from './phase-inspection-generation.mjs';
import { readRecord, currentSchemaVersion } from './schema-migrations.mjs';

const ROLES = new Set(['author', 'source-reviewer']);
const STATES = new Set(['load-context', 'prepare-successor', 'author-draft', 'repair-draft', 'publish-ready',
  'validate-draft', 'open-code-generation',
  'publication-requested', 'author-report', 'check-report', 'repair-report', 'retain-report', 'retention-requested',
  'complete', 'blocked', 'lifecycle-handoff']);
const SHA = /^[a-f0-9]{64}$/u;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const fail = message => { throw new SingularityFlowError(message, { code: 'WORKFLOW_TASK_RECORD_INVALID',
  details: { owner: 'workflow-maintainer', nextAction: 'singularity-flow recover --for-agent --json' } }); };

export function workflowTaskIdentity(workflow, phase, role = 'author', generation = null) {
  if (!workflow?.workItem?.id || !phase?.id || !ROLES.has(role)) fail('A workflow task needs an exact Story, phase and role.');
  generation ??= role === 'source-reviewer' ? Number(phase.generation) : phaseInspectionGeneration(workflow, phase);
  if (!Number.isSafeInteger(generation) || generation < 1) fail('A workflow task needs a positive generation.');
  const bases = workflow.workItem.repositoryBases;
  const repositories = Array.isArray(bases) ? bases.map(entry => entry?.repositoryId ?? entry?.id)
    : bases && typeof bases === 'object' ? Object.keys(bases) : [];
  const subject = { workId: workflow.workItem.id, phaseId: phase.id, generation, role,
    repositoryIdentity: recordSha256({ primary: workflow.workItem.repositoryId ?? null,
      repositories: [...new Set(repositories.filter(value => typeof value === 'string' && value.length))].sort(),
      capability: workflow.resolution?.capability?.id ?? null }),
    storyIdentity: recordSha256({ workId: workflow.workItem.id, createdAt: workflow.workItem.createdAt ?? null,
      capability: workflow.resolution?.capability?.id ?? null, source: workflow.workItem.source?.stableId ?? null }) };
  return { ...subject, id: `WT-${recordSha256(subject)}` };
}

export function workflowTaskApplies(phase, role = 'author') {
  return Boolean(phase) && (role !== 'author' || phase.generationPolicy?.requirement !== 'none'
    && phase.generationPolicy?.task !== 'none');
}

/** Current pins and predecessors: editing this task's draft does not create a new operation. */
export function workflowTaskInputSha256(workflow, phase) {
  const order = workflow.phaseOrder ?? [];
  return recordSha256({ resolution: workflow.resolution ?? null, snapshot: workflow.workflowSnapshot ?? null,
    phase: { id: phase.id, agent: phase.defaultAgent ?? null, requiredArtifact: phase.requiredArtifact ?? null,
      generationPolicy: phase.generationPolicy ?? null, writeScope: phase.writeScope ?? null },
    predecessors: order.slice(0, Math.max(0, order.indexOf(phase.id))).map(id => {
      const value = workflow.phases[id];
      return { id, generation: value.generation, artifacts: (value.artifacts ?? []).map(artifact =>
        ({ path: artifact.path, sha256: artifact.sha256 ?? null })) };
    }) });
}

export function validateWorkflowTask(record, expected = null) {
  record = readRecord('workflow-task-record', record).record;
  if (!record || record.kind !== 'workflow-task-record'
      || record.authority !== 'progress-only' || !/^WT-[a-f0-9]{64}$/u.test(record.id ?? '')
      || !ROLES.has(record.role) || !STATES.has(record.state) || !SHA.test(record.inputSha256 ?? '')
      || !SHA.test(record.storyIdentity ?? '') || !SHA.test(record.repositoryIdentity ?? '')
      || !['workId', 'phaseId'].every(key => typeof record[key] === 'string' && record[key].length > 0 && record[key].length <= 128)
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || !Number.isSafeInteger(record.generation) || record.generation < 1
      || !Number.isSafeInteger(record.continuations) || record.continuations < 0 || record.continuations > 3
      || !Number.isSafeInteger(record.maximumContinuations) || record.maximumContinuations < 0 || record.maximumContinuations > 3
      || !Number.isSafeInteger(record.repairConsumed) || record.repairConsumed < 0 || record.repairConsumed > 3
      || !Array.isArray(record.conditions) || record.conditions.length > 32 || record.conditions.some(value => !SHA.test(value))
      || !Array.isArray(record.checkpoints) || record.checkpoints.length > 16) fail('The retained workflow task is malformed; preserve it for inspection.');
  const { recordSha256: digest, ...core } = record;
  if (digest !== recordSha256(core)) fail('The retained workflow task failed its content hash check.');
  const subject = Object.fromEntries(['workId', 'phaseId', 'generation', 'role', 'repositoryIdentity', 'storyIdentity'].map(key => [key, record[key]]));
  if (record.id !== `WT-${recordSha256(subject)}` || expected
      && ['id', 'workId', 'phaseId', 'generation', 'role', 'repositoryIdentity', 'storyIdentity'].some(key => Object.hasOwn(expected, key) && expected[key] !== record[key])) {
    fail('The retained workflow task belongs to a different Story, generation or role.');
  }
  for (const checkpoint of record.checkpoints) {
    if (!['prepared', 'validation', 'publication-requested', 'publication', 'review-check', 'retention-requested', 'retained-review'].includes(checkpoint.kind)
        || !SHA.test(checkpoint.inputSha256 ?? '') || !SHA.test(checkpoint.fingerprint ?? '')
        || Object.keys(checkpoint).some(key => !['kind', 'inputSha256', 'fingerprint'].includes(key))) fail('A workflow task checkpoint contains unsupported data.');
  }
  const allowed = ['schemaVersion', 'kind', 'authority', 'id', 'workId', 'phaseId', 'generation', 'role', 'repositoryIdentity', 'storyIdentity',
    'inputSha256', 'revision', 'state', 'continuations', 'maximumContinuations', 'repairConsumed', 'conditions',
    'checkpoints', 'blockedCode', 'progressQuarantined', 'recordSha256'];
  if (Object.keys(record).some(key => !allowed.includes(key)) || record.blockedCode != null && !CODE.test(record.blockedCode)) {
    fail('Workflow task progress cannot contain local paths, free text, prompts or commands.');
  }
  if (record.progressQuarantined != null && (record.progressQuarantined !== true
      || record.maximumContinuations !== 0 || record.repairConsumed !== 3 || record.continuations !== 3)) fail('Quarantined task progress cannot refund an automatic budget.');
  return record;
}

export function updateWorkflowTask(identity, previous, observation = {}) {
  if (previous) validateWorkflowTask(previous, identity);
  const inputSha256 = observation.inputSha256 ?? previous?.inputSha256;
  if (!SHA.test(inputSha256 ?? '')) fail('Task progress requires its current input revision.');
  const changed = previous && previous.inputSha256 !== inputSha256;
  const conditions = [...new Set([...(previous?.conditions ?? []), ...(observation.conditions ?? []), ...(observation.condition ? [observation.condition] : [])])].slice(-32);
  let checkpoints = changed ? [] : [...new Map([...(observation.checkpoints ?? []), ...(previous?.checkpoints ?? [])]
    .filter(item => item.inputSha256 === inputSha256).map(item => [item.kind, item])).values()];
  if (observation.checkpoint) {
    const checkpoint = { kind: observation.checkpoint, inputSha256,
      fingerprint: observation.fingerprint ?? observation.condition ?? inputSha256 };
    checkpoints = [...checkpoints.filter(item => item.kind !== checkpoint.kind), checkpoint].slice(-16);
  }
  const maximumContinuations = Math.min(previous?.maximumContinuations ?? 3,
    Number.isSafeInteger(observation.maximumContinuations) ? Math.max(0, Math.min(3, observation.maximumContinuations)) : 3);
  const core = { schemaVersion: currentSchemaVersion('workflow-task-record'), kind: 'workflow-task-record', authority: 'progress-only', ...identity,
    inputSha256, revision: (previous?.revision ?? 0) + 1,
    state: observation.state ?? (changed ? identity.role === 'author' ? 'author-draft' : 'author-report' : previous?.state) ?? 'load-context',
    continuations: Math.max(previous?.continuations ?? 0, observation.continuations ?? 0), maximumContinuations,
    repairConsumed: Math.max(previous?.repairConsumed ?? 0, Math.min(3, observation.repairConsumed ?? 0)),
    conditions, checkpoints, blockedCode: observation.blockedCode ?? null,
    ...(previous?.progressQuarantined || observation.progressQuarantined ? { progressQuarantined: true } : {}) };
  const record = { ...core, recordSha256: recordSha256(core) };
  validateWorkflowTask(record, identity);
  // Reading identical facts must not generate writes, timestamps, commits or an ever-growing log.
  if (previous && recordSha256({ ...previous, revision: 0, recordSha256: null })
      === recordSha256({ ...record, revision: 0, recordSha256: null })) return previous;
  return record;
}

/** Merge independently observed progress conservatively; no clock or last-writer assumption. */
export function mergeWorkflowTasks(shared, local, identity) {
  if (local) validateWorkflowTask(local, identity);
  if (shared) {
    try { validateWorkflowTask(shared, identity); }
    catch (error) { if (local?.progressQuarantined) return local; throw error; }
  }
  if (!shared || !local) return local ?? shared ?? null;
  return updateWorkflowTask(identity, local, { inputSha256: local.inputSha256,
    ...(shared.inputSha256 === local.inputSha256 ? { checkpoints: shared.checkpoints,
      ...(shared.state === 'complete' && shared.checkpoints.some(item => ['publication', 'retained-review'].includes(item.kind))
        ? { state: 'complete' } : {}) } : {}),
    continuations: Math.max(shared.continuations, local.continuations),
    maximumContinuations: Math.min(shared.maximumContinuations, local.maximumContinuations),
    repairConsumed: Math.max(shared.repairConsumed, local.repairConsumed),
    // Conditions carry budget history across input changes and laptop takeover.
    conditions: shared.conditions });
}

/** A published progress record may spend a repair budget; it can never increase that budget. */
export function portableTaskRepairFloor(workflow, phase, generation = null) {
  const identity = workflowTaskIdentity(workflow, phase, 'author', generation);
  const record = workflow.taskOperations?.[identity.id];
  if (!record) return 0;
  return validateWorkflowTask(record, identity).repairConsumed;
}

/** Human decision commits may carry progress, but cannot use it to refund or alter authority. */
export function workflowTaskDeltaSafe(before, after) {
  try {
    const prior = before.taskOperations ?? {};
    const current = after.taskOperations ?? {};
    if (recordSha256(prior) === recordSha256(current)) return true;
    if (Object.keys(prior).some(id => !Object.hasOwn(current, id))) return false;
    for (const [id, record] of Object.entries(current)) {
      if (prior[id] && recordSha256(prior[id]) === recordSha256(record)) continue;
      const phase = after.phases?.[record.phaseId];
      if (!phase || !workflowTaskApplies(phase, record.role)
          || record.generation > Math.max(Number(phase.generation ?? 0) + 1, Number(phase.generationIntent?.generation ?? 0))) return false;
      validateWorkflowTask(record, workflowTaskIdentity(after, phase, record.role, record.generation));
      if (id !== record.id) return false;
      if (prior[id]) {
        validateWorkflowTask(prior[id]);
        if (record.continuations < prior[id].continuations || record.repairConsumed < prior[id].repairConsumed
            || record.maximumContinuations > prior[id].maximumContinuations
            || prior[id].progressQuarantined && !record.progressQuarantined) return false;
      }
    }
    return true;
  } catch { return false; }
}

/** A record suggests work; only fresh kernel facts choose the step or establish completion. */
export function workflowTaskResume(workflow, phase, { role = 'author', generation = null, record = null,
  inputSha256 = workflowTaskInputSha256(workflow, phase), progress = null, review = null,
  published = null, pendingPublication = false, blocked = null, nextAction = null } = {}) {
  if (!workflowTaskApplies(phase, role)) return null;
  const identity = workflowTaskIdentity(workflow, phase, role, generation ?? (published === true && phase.generation > 0 ? phase.generation : null));
  if (record) validateWorkflowTask(record, identity);
  const inputChanged = Boolean(record && record.inputSha256 !== inputSha256);
  let state = role === 'author' ? progress?.state ?? 'load-context' : review?.state ?? 'author-report';
  state = ({ retained: 'complete', 'read-error': 'blocked', 'reload-context': 'load-context',
    'review-changed-inputs': 'author-report' })[state] ?? state;
  let complete = role === 'author' ? published ?? (hasPublishedPhaseGeneration(phase)
    && identity.generation === Number(phase.generation) && phaseInspectionGeneration(workflow, phase) === Number(phase.generation)) : review?.complete === true;
  let next = nextAction ?? progress?.nextAction ?? review?.nextAction ?? null;
  const recovery = safeCommandGuidance({ argv: ['recover', identity.workId, '--phase', phase.id, '--for-agent', '--json'] });
  const checkpointRoute = workflow.currentPhase === phase.id && workflow.status === 'in_progress'
    ? safeCommandGuidance({ argv: ['appeal', 'task-checkpoint', '--work-id', identity.workId, '--phase', phase.id, '--role', role, '--json'] }) : null;
  if (pendingPublication) { state = 'blocked'; complete = false; next = recovery; }
  else if (blocked) { state = 'blocked'; complete = false; next = blocked.nextAction ?? next ?? recovery; }
  else if (complete) state = 'complete';
  else if (role === 'author' && phase.status !== 'in_progress') {
    state = 'lifecycle-handoff'; next ??= safeCommandGuidance({ argv: ['nextsteps', identity.workId, '--for-agent', '--json'] });
  }
  else if (record && ['publication-requested', 'retention-requested'].includes(record.state) && !inputChanged) {
    state = 'inspect-interrupted-operation'; next = recovery;
  }
  if (!next && !complete) next = safeCommandGuidance({ argv: role === 'author'
    ? ['phase', 'enter', phase.id, '--work-id', identity.workId, '--compose', '--for-agent', '--json']
    : ['review-source', 'context', phase.id, '--for-agent', '--json'] });
  return { schemaVersion: 1, operationId: identity.id, role, generation: identity.generation, state, complete,
    resumed: Boolean(record), inputChanged, authority: 'progress-only',
    nextAction: complete ? null : next,
    ...(checkpointRoute ? { handoff: { command: checkpointRoute.command, copilotCommand: checkpointRoute.copilotCommand,
      modelFreeCommand: checkpointRoute.modelFreeCommand, transfers: 'progress-metadata-only' } } : {}),
    checkpoints: (record?.checkpoints ?? []).filter(checkpoint => checkpoint.inputSha256 === inputSha256).map(item => item.kind),
    remaining: complete ? [] : state === 'publish-ready' ? ['publish'] : state === 'retain-report' ? ['retain']
      : state === 'inspect-interrupted-operation' ? ['inspect-outcome'] : state === 'validate-draft' ? ['validate', 'repair-if-needed', 'publish']
      : state === 'repair-draft' ? ['repair', 'validate', 'publish'] : state === 'repair-report' ? ['repair', 'check', 'retain']
        : role === 'author' ? ['author', 'validate', 'repair-if-needed', 'publish'] : ['author-report', 'check', 'repair-if-needed', 'retain'],
    continuationBudget: { consumed: record?.continuations ?? 0, maximum: record?.maximumContinuations ?? 3 },
    repairConsumed: record?.repairConsumed ?? 0,
    repairConditions: { observed: record?.conditions.length ?? 0, resetOnNewChat: false },
    instruction: 'Resume from fresh kernel facts and exact newly issued local paths. Read the instructions this chat needs; a previous chat reading them is not current context. Progress never grants evidence, consent or authority. Observe an interrupted operation before any replay. Local drafts and attachments require explicit handoff or re-upload.' };
}
