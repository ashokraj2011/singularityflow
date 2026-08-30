/**
 * Deterministic, model-free SGOS authoring ceremonies.
 *
 * This module turns explicit declarations into the existing SGOS contracts. It deliberately has
 * no model, random, filesystem-write, or publication dependency. Packet and candidate construction
 * are pure. Human decisions additionally require an exact packet hash and membership in an
 * authority group loaded from the trusted sflow/config boundary; a caller cannot supply an
 * approving principal or authority assertion.
 */
import path from 'node:path';
import { realpathSync } from 'node:fs';

import { repoRoot } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  SHA256_PATTERN,
  cloneSgosValue,
  createIntentIr,
  createWorkflowIr,
  createWorkflowRatification,
  sha256,
  validateGvmProgram,
  validateIntentEnvelope,
  validateIntentIr,
  validatePolicySnapshot,
  validateSgosIntentWorkflowMap,
  validateWorkflowIr
} from './contracts.mjs';
import { compareSgosCodePoints } from './order.mjs';
import { normalizeSgosFanout } from './fanout.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { validateSgosRegistrySnapshot } from './compiler.mjs';
import {
  loadApprovedPlatformMutationAuthority,
  PLATFORM_MUTATION_AUTHORITIES
} from './platform/authority.mjs';
import {
  createSgosProgramAuthorityRecord as createTrustedProgramAuthorityRecord,
  sgosProgramAuthorityPath,
  validateSgosProgramStaticSafety
} from './program-trust.mjs';

const INTENT_ARRAY_FIELDS = Object.freeze([
  'outcomes', 'successCriteria', 'constraints', 'invariants', 'preferences', 'nonGoals',
  'assumptions', 'unknowns', 'contradictions', 'risks', 'evidenceExpectations',
  'authorityRequirements', 'budgets', 'domainCandidates', 'workTypeCandidates'
]);
const INTENT_ANSWER_FIELDS = Object.freeze(['objective', ...INTENT_ARRAY_FIELDS, 'subjects']);
const HUMAN_ANSWER_PROVENANCE = new Set(['explicit', 'human-confirmed']);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const SGOS_INTENT_CONFIRMATION_FORMAT =
  'singularity-flow-sgos-intent-confirmation-packet/v1';
export const SGOS_WORKFLOW_RATIFICATION_FORMAT =
  'singularity-flow-sgos-workflow-ratification-packet/v1';
export const SGOS_PROGRAM_AUTHORITY_PROPOSAL_FORMAT =
  'singularity-flow-sgos-program-authority-proposal/v1';

/**
 * Installed authoring roles. Membership and the exact group definition always come from the
 * trusted sflow/config authority; these defaults only select which governed group owns a decision.
 */
export const SGOS_AUTHORING_AUTHORITY_REQUIREMENTS = deepFreeze({
  'intent.confirm': PLATFORM_MUTATION_AUTHORITIES['intent.confirm'],
  'workflow.ratify': PLATFORM_MUTATION_AUTHORITIES['workflow.ratify'],
  'program-authority.approve': PLATFORM_MUTATION_AUTHORITIES['program-authority.approve']
});

function fail(message, code = 'SGOS_AUTHORING_INPUT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) fail(`${label} must be an object.`);
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown) fail(`${label} contains unknown field '${unknown}'.`, 'SGOS_AUTHORING_INPUT_INVALID', {
    field: unknown
  });
}

function requireFields(value, required, label) {
  const missing = required.find((field) => !Object.hasOwn(value, field));
  if (missing) fail(`${label} is missing required field '${missing}'.`, 'SGOS_AUTHORING_INPUT_INVALID', {
    field: missing
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const member of Object.values(value)) deepFreeze(member);
  return Object.freeze(value);
}

function present(value) {
  if (value == null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(present);
  if (plainObject(value)) return Object.values(value).some(present);
  return true;
}

function timestamp(value, label) {
  const matched = typeof value === 'string' ? RFC3339.exec(value) : null;
  const date = matched ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value) : null;
  const [, year, month, day, hour, minute, second] = date ?? [];
  const maximumDay = date
    ? new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    : 0;
  if (!matched || !Number.isFinite(Date.parse(value))
      || Number(month) < 1 || Number(month) > 12
      || Number(day) < 1 || Number(day) > maximumDay
      || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    fail(`${label} must be an explicit RFC 3339 timestamp.`, 'SGOS_AUTHORING_TIMESTAMP_REQUIRED');
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be exactly 'sha256:' plus 64 lowercase hex characters.`,
      'SGOS_AUTHORING_DIGEST_REQUIRED');
  }
  return value;
}

function canonicalRepositoryRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    fail('SGOS human authoring requires an explicit absolute repository root.',
      'SGOS_AUTHORING_REPOSITORY_REQUIRED');
  }
  let selectedRoot;
  try { selectedRoot = repoRoot(root); } catch (error) {
    fail('SGOS human authoring requires an existing Git repository root.',
      'SGOS_AUTHORING_REPOSITORY_REQUIRED', { cause: error.message });
  }
  const receivedRoot = realpathSync(root);
  if (receivedRoot !== selectedRoot) {
    fail('SGOS human authoring requires the canonical selected repository root, not a subdirectory or alias.',
      'SGOS_AUTHORING_REPOSITORY_REQUIRED', { received: receivedRoot, expected: selectedRoot });
  }
  return selectedRoot;
}

async function approvedHumanPrincipal(root, operation) {
  const selectedRoot = canonicalRepositoryRoot(root);
  const authorityId = SGOS_AUTHORING_AUTHORITY_REQUIREMENTS[operation];
  if (authorityId == null) {
    fail(`Unknown SGOS authoring authority operation '${operation}'.`,
      'SGOS_AUTHORING_AUTHORITY_POLICY_INVALID', { operation });
  }
  // This is an authorization decision, not an identity lookup: the platform authority loader
  // refreshes/mounts sflow/config, verifies the protected boundary, matches the observed identity
  // against the selected approved group, and returns a content-addressed witness. Only its private
  // actor ID and exact authority digest enter the portable SGOS contracts.
  const authorization = await loadApprovedPlatformMutationAuthority(selectedRoot, operation);
  return deepFreeze({
    kind: 'human',
    id: authorization.actorId,
    authoritySha256: authorization.authoritySha256
  });
}

function answerProvenance(value, label) {
  const provenance = value?.provenance;
  if (!HUMAN_ANSWER_PROVENANCE.has(provenance)) {
    fail(
      `${label}.provenance must remain 'explicit' or 'human-confirmed'; '${provenance ?? 'missing'}' cannot be upgraded by this authoring path.`,
      'SGOS_INTENT_PROVENANCE_REFUSED',
      { provenance: provenance ?? null }
    );
  }
}

function normalizeIntentAnswers(value, envelope) {
  const answers = cloneSgosValue(value);
  exactKeys(answers, INTENT_ANSWER_FIELDS, 'intent answers');
  requireFields(answers, ['objective'], 'intent answers');
  if (!plainObject(answers.objective)) fail('intent answers.objective must be an object.');
  exactKeys(answers.objective, ['statement', 'provenance'], 'intent answers.objective');
  requireFields(answers.objective, ['statement', 'provenance'], 'intent answers.objective');
  answerProvenance(answers.objective, 'intent answers.objective');

  const normalized = { objective: answers.objective };
  for (const field of INTENT_ARRAY_FIELDS) {
    const clauses = answers[field] ?? [];
    if (!Array.isArray(clauses)) fail(`intent answers.${field} must be an array.`);
    normalized[field] = clauses.map((clause, index) => {
      if (!plainObject(clause)) fail(`intent answers.${field}[${index}] must be an object.`);
      exactKeys(clause, [
        'id', 'clauseId', 'statement', 'value', 'provenance', 'required', 'category', 'severity'
      ], `intent answers.${field}[${index}]`);
      answerProvenance(clause, `intent answers.${field}[${index}]`);
      return clause;
    });
  }
  normalized.subjects = answers.subjects ?? [];
  if (!Array.isArray(normalized.subjects)) fail('intent answers.subjects must be an array.');

  // Reuse the strict Intent IR contract to validate answer shapes. The pending source is replaced
  // by the exact confirmation witness only after a human confirms the packet hash.
  createIntentIr({
    intentId: envelope.intentId,
    generation: envelope.generation,
    objective: { ...normalized.objective, sourceRef: 'sgos-intent-confirmation:pending' },
    ...Object.fromEntries(INTENT_ARRAY_FIELDS.map((field) => [field,
      normalized[field].map((clause) => ({ ...clause, sourceRef: 'sgos-intent-confirmation:pending' }))])),
    subjects: normalized.subjects
  });
  return normalized;
}

function sealPacket(core, hashField) {
  return deepFreeze({ ...cloneSgosValue(core), [hashField]: sha256(core) });
}

/** Build the exact, inspectable packet a human must confirm before Intent IR can be authored. */
export function createSgosIntentConfirmationPacket(envelopeValue, answersValue) {
  const envelope = validateIntentEnvelope(envelopeValue);
  const answers = normalizeIntentAnswers(answersValue, envelope);
  return sealPacket({
    format: SGOS_INTENT_CONFIRMATION_FORMAT,
    envelopeSha256: envelope.envelopeSha256,
    intentId: envelope.intentId,
    generation: envelope.generation,
    answers
  }, 'packetSha256');
}

/**
 * Transform an Intent Envelope and explicitly confirmed answers into the existing Intent IR.
 * Provenance is preserved, never promoted. The generated sourceRef binds the exact packet, the
 * repository-observed human identity, and the caller-supplied decision timestamp.
 */
export async function createSgosIntentIrFromConfirmedAnswers(root, requestValue) {
  const request = cloneSgosValue(requestValue);
  exactKeys(request, ['envelope', 'answers', 'confirmationSha256', 'confirmedAt'],
    'intent confirmation request');
  requireFields(request, ['envelope', 'answers', 'confirmationSha256', 'confirmedAt'],
    'intent confirmation request');
  const packet = createSgosIntentConfirmationPacket(request.envelope, request.answers);
  digest(request.confirmationSha256, 'confirmationSha256');
  if (request.confirmationSha256 !== packet.packetSha256) {
    fail('Intent confirmation must equal the exact current answer packet hash.',
      'SGOS_INTENT_CONFIRMATION_REQUIRED', {
        expected: packet.packetSha256,
        received: request.confirmationSha256
      });
  }
  const confirmedAt = timestamp(request.confirmedAt, 'confirmedAt');
  const principal = await approvedHumanPrincipal(root, 'intent.confirm');
  const sourceRef = `sgos-intent-confirmation:${sha256({
    packetSha256: packet.packetSha256,
    principal,
    confirmedAt
  }).slice('sha256:'.length)}`;
  const { answers } = packet;
  return createIntentIr({
    intentId: packet.intentId,
    generation: packet.generation,
    objective: { ...answers.objective, sourceRef },
    ...Object.fromEntries(INTENT_ARRAY_FIELDS.map((field) => [field,
      answers[field].map((clause) => ({ ...clause, sourceRef }))])),
    subjects: answers.subjects
  });
}

function sortedStrings(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array.`);
  if (values.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    fail(`${label} must contain only non-empty strings.`);
  }
  return [...new Set(values)].sort(compareSgosCodePoints);
}

function normalizedTask(taskId, value, policySnapshotSha256, workflowMaximumAttempts) {
  if (!plainObject(value)) fail(`workflow task '${taskId}' must be an object.`);
  const task = cloneSgosValue(value);
  if (task.policySnapshotSha256 != null
      && task.policySnapshotSha256 !== policySnapshotSha256) {
    fail(`workflow task '${taskId}' carries a stale policy snapshot digest.`,
      'SGOS_WORKFLOW_POLICY_MISMATCH', {
        taskId,
        expected: policySnapshotSha256,
        received: task.policySnapshotSha256
      });
  }
  task.policySnapshotSha256 = policySnapshotSha256;
  task.dependsOn = sortedStrings(task.dependsOn ?? [], `workflow task '${taskId}'.dependsOn`);
  if (task.intentClauseIds != null) {
    task.intentClauseIds = sortedStrings(
      task.intentClauseIds,
      `workflow task '${taskId}'.intentClauseIds`
    );
  }
  if (task.resources != null) {
    if (!plainObject(task.resources)) fail(`workflow task '${taskId}'.resources must be an object.`);
    for (const field of ['reads', 'writes', 'devices', 'externalEffects']) {
      if (task.resources[field] != null) {
        task.resources[field] = sortedStrings(
          task.resources[field],
          `workflow task '${taskId}'.resources.${field}`
        );
      }
    }
  }
  if (task.retry == null) task.retry = { maximumAttempts: 1 };
  if (!plainObject(task.retry)) fail(`workflow task '${taskId}'.retry must be an object.`);
  const taskMaximumAttempts = task.retry.maximumAttempts ?? task.retry.maxAttempts;
  if (!Number.isSafeInteger(taskMaximumAttempts) || taskMaximumAttempts < 1
      || taskMaximumAttempts > workflowMaximumAttempts
      || taskMaximumAttempts > SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask) {
    fail(`workflow task '${taskId}' retry ceiling is outside the declared or installed bound.`,
      'SGOS_WORKFLOW_BOUND_INVALID', {
        taskId,
        maximumAttempts: taskMaximumAttempts ?? null,
        workflowMaximumAttempts,
        installedMaximumAttempts: SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask
      });
  }
  return task;
}

function declaredTaskBound(tasks) {
  let count = 0;
  for (const [taskId, task] of Object.entries(tasks)) {
    const kind = String(task.kind ?? '').toLowerCase();
    if (kind === 'foreach') {
      const fanout = normalizeSgosFanout({
        taskId,
        items: task.items,
        maximumItems: task.maximumItems,
        maximumParallel: task.maximumParallel ?? 1
      });
      if (!plainObject(task.body)) {
        fail(`Fan-out '${taskId}' requires one explicit body task.`, 'SGOS_WORKFLOW_BOUND_INVALID');
      }
      count += fanout.items.length + 1;
      continue;
    }
    if (kind === 'bounded-loop') {
      if (!Number.isSafeInteger(task.maximumIterations) || task.maximumIterations < 1
          || task.maximumIterations > SGOS_INSTALLED_LIMITS.maximumTasks) {
        fail(`workflow task '${taskId}' requires an installed maximumIterations bound.`,
          'SGOS_WORKFLOW_BOUND_INVALID');
      }
    }
    count += 1;
  }
  return count;
}

function assertFiniteTaskGraph(tasks) {
  const ids = Object.keys(tasks).sort(compareSgosCodePoints);
  const indegree = new Map(ids.map((id) => [id, tasks[id].dependsOn.length]));
  const forward = new Map(ids.map((id) => [id, []]));
  let edgeCount = 0;
  for (const [taskId, task] of Object.entries(tasks)) {
    for (const predecessor of task.dependsOn) {
      forward.get(predecessor).push(taskId);
      edgeCount += 1;
    }
  }
  if (edgeCount > SGOS_INSTALLED_LIMITS.maximumEdges) {
    fail('workflow dependencies exceed the installed edge ceiling.',
      'SGOS_WORKFLOW_BOUND_INVALID', {
        edgeCount,
        installedMaximumEdges: SGOS_INSTALLED_LIMITS.maximumEdges
      });
  }
  for (const successors of forward.values()) successors.sort(compareSgosCodePoints);
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const visited = [];
  while (ready.length) {
    const taskId = ready.shift();
    visited.push(taskId);
    for (const successor of forward.get(taskId)) {
      indegree.set(successor, indegree.get(successor) - 1);
      if (indegree.get(successor) === 0) {
        ready.push(successor);
        ready.sort(compareSgosCodePoints);
      }
    }
  }
  if (visited.length !== ids.length) {
    const cycleTaskIds = ids.filter((id) => !visited.includes(id));
    fail(`workflow dependency graph contains a cycle involving ${cycleTaskIds.join(', ')}.`,
      'SGOS_WORKFLOW_CYCLE', { cycleTaskIds });
  }

  const endTaskIds = ids.filter((id) =>
    tasks[id].opcode === 'END' || String(tasks[id].kind).toLowerCase() === 'end');
  if (!endTaskIds.length) {
    fail('workflow declaration requires at least one explicit END task.',
      'SGOS_WORKFLOW_TERMINAL_REQUIRED');
  }
  const nonTerminalEnds = endTaskIds.filter((id) => forward.get(id).length > 0);
  if (nonTerminalEnds.length) {
    fail('workflow END tasks cannot have successors.', 'SGOS_WORKFLOW_TERMINAL_INVALID', {
      taskIds: nonTerminalEnds
    });
  }
  const canReachEnd = new Set();
  const pending = [...endTaskIds];
  while (pending.length) {
    const taskId = pending.shift();
    if (canReachEnd.has(taskId)) continue;
    canReachEnd.add(taskId);
    pending.push(...tasks[taskId].dependsOn);
    pending.sort(compareSgosCodePoints);
  }
  const stranded = ids.filter((id) => !canReachEnd.has(id));
  if (stranded.length) {
    fail(`workflow tasks cannot reach an END task: ${stranded.join(', ')}.`,
      'SGOS_WORKFLOW_TERMINAL_INVALID', { taskIds: stranded });
  }
}

const COVERAGE_TARGET_KINDS = new Set([
  'workflow-output', 'output', 'task', 'gate', 'human-decision', 'human-request',
  'evidence-contract', 'explicit-non-goal', 'non-goal', 'approved-deferment', 'deferment'
]);
const COVERAGE_SOURCE_KINDS = new Set([
  'intent-clause', 'policy', 'domain-law', 'domain', 'verification', 'recovery',
  'compiler-invariant', 'explicit-non-goal', 'approved-deferment'
]);
const COMPILER_INTENT_ARRAY_FIELDS = INTENT_ARRAY_FIELDS.filter((field) =>
  !['domainCandidates', 'workTypeCandidates'].includes(field));

function intentClauseIdSet(intentIr) {
  const ids = new Set([`${intentIr.intentId}:objective`]);
  for (const field of COMPILER_INTENT_ARRAY_FIELDS) {
    for (const clause of intentIr[field]) ids.add(clause.clauseId ?? clause.id);
  }
  return ids;
}

function workflowTaskIdSet(workflow) {
  if (Array.isArray(workflow.spec.tasks)) {
    return new Set(workflow.spec.tasks.map((task) => task.id ?? task.taskId));
  }
  return new Set(Object.keys(workflow.spec.tasks));
}

function workflowTaskMap(workflow) {
  if (Array.isArray(workflow.spec.tasks)) {
    return new Map(workflow.spec.tasks.map((task) => [task.id ?? task.taskId, task]));
  }
  return new Map(Object.entries(workflow.spec.tasks));
}

function workflowOutputIds(workflow) {
  const ids = new Set();
  for (const task of workflowTaskMap(workflow).values()) {
    for (const output of task.outputs ?? []) {
      const id = typeof output === 'string'
        ? output
        : output?.ref ?? output?.id ?? output?.name ?? null;
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

function assertCoverageTarget({ clauseId, link, taskMap, outputIds, nonGoalIds }) {
  const targetId = link.targetId;
  const task = taskMap.get(targetId);
  if (['task', 'gate'].includes(link.kind) && !task) {
    fail(`Coverage for clause '${clauseId}' references unknown task '${targetId}'.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { clauseId, taskId: targetId });
  }
  if (link.kind === 'evidence-contract' && (!task || !present(task.evidence))) {
    fail(`Coverage for clause '${clauseId}' references no declared task evidence contract.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { clauseId, taskId: targetId });
  }
  if (['human-decision', 'human-request'].includes(link.kind)
      && (!task || (task.opcode !== 'HUMAN_REQUEST'
        && String(task.kind).toLowerCase() !== 'human-request'))) {
    fail(`Coverage for clause '${clauseId}' references no declared Human Request task.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { clauseId, taskId: targetId });
  }
  if (['workflow-output', 'output'].includes(link.kind) && !outputIds.has(targetId)) {
    fail(`Coverage for clause '${clauseId}' references unknown workflow output '${targetId}'.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { clauseId, outputId: targetId });
  }
  if (['explicit-non-goal', 'non-goal'].includes(link.kind)
      && (targetId !== clauseId || !nonGoalIds.has(clauseId))) {
    fail(`Coverage for clause '${clauseId}' does not bind a declared non-goal.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { clauseId, targetId });
  }
  if (['approved-deferment', 'deferment'].includes(link.kind) && targetId !== clauseId) {
    fail(`Coverage deferment for clause '${clauseId}' must target that exact clause.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { clauseId, targetId });
  }
}

function assertCoverageSource({ taskId, link, task, workflow, clauseIds }) {
  const sourceId = link.sourceId;
  if (link.kind === 'intent-clause') return;
  if (link.kind === 'policy' && sourceId !== workflow.policySnapshotSha256) {
    fail(`Coverage for task '${taskId}' does not bind the Workflow's exact policy snapshot.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { taskId, sourceId });
  }
  const domainSources = new Set([
    workflow.metadata.domainPack,
    workflow.metadata.domainPackSha256
  ].filter(Boolean));
  if (['domain-law', 'domain'].includes(link.kind) && !domainSources.has(sourceId)) {
    fail(`Coverage for task '${taskId}' does not bind the Workflow's exact domain pack.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { taskId, sourceId });
  }
  if (link.kind === 'verification'
      && (sourceId !== taskId || !present(task.metadata?.verification))) {
    fail(`Coverage for task '${taskId}' does not bind its declared verification contract.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { taskId, sourceId });
  }
  if (link.kind === 'recovery' && (sourceId !== taskId || !present(task.recovery))) {
    fail(`Coverage for task '${taskId}' does not bind its declared recovery contract.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { taskId, sourceId });
  }
  if (link.kind === 'compiler-invariant'
      && (sourceId !== taskId || !present(task.metadata?.compilerInvariant))) {
    fail(`Coverage for task '${taskId}' does not bind a declared compiler invariant.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { taskId, sourceId });
  }
  if (['explicit-non-goal', 'approved-deferment'].includes(link.kind)
      && !clauseIds.has(sourceId)) {
    fail(`Coverage for task '${taskId}' references unknown intent clause '${sourceId}'.`,
      'SGOS_WORKFLOW_COVERAGE_INVALID', { taskId, sourceId });
  }
}

function canonicalCoverageLinks(links, label) {
  const keyed = new Map();
  for (const link of links) {
    const canonical = canonicalJson(link);
    if (keyed.has(canonical)) {
      fail(`${label} contains a duplicate link.`, 'SGOS_WORKFLOW_COVERAGE_INVALID');
    }
    keyed.set(canonical, link);
  }
  return [...keyed.entries()]
    .sort(([left], [right]) => compareSgosCodePoints(left, right))
    .map(([, link]) => link);
}

function contextualCoverage(intentIr, workflow, value) {
  const shaped = validateSgosIntentWorkflowMap(value);
  const clauseIds = intentClauseIdSet(intentIr);
  const taskIds = workflowTaskIdSet(workflow);
  const taskMap = workflowTaskMap(workflow);
  const outputIds = workflowOutputIds(workflow);
  const nonGoalIds = new Set(intentIr.nonGoals.map((clause) => clause.clauseId ?? clause.id));
  const clauses = {};
  const tasks = {};
  const forwardPairs = new Set();
  const reversePairs = new Set();

  for (const clauseId of Object.keys(shaped.clauses).sort(compareSgosCodePoints)) {
    if (!clauseIds.has(clauseId)) {
      fail(`Intent-to-Workflow coverage references unknown clause '${clauseId}'.`,
        'SGOS_WORKFLOW_COVERAGE_INVALID', { clauseId });
    }
    const links = shaped.clauses[clauseId].map((link) => {
      if (!COVERAGE_TARGET_KINDS.has(link.kind) || link.targetId == null
          || link.sourceId != null) {
        fail(`Coverage for clause '${clauseId}' requires a closed target kind and targetId.`,
          'SGOS_WORKFLOW_COVERAGE_INVALID', { clauseId, link });
      }
      if (link.kind === 'task') {
        forwardPairs.add(`${clauseId}\0${link.targetId}`);
      }
      assertCoverageTarget({ clauseId, link, taskMap, outputIds, nonGoalIds });
      return link;
    });
    clauses[clauseId] = canonicalCoverageLinks(links, `coverage.clauses.${clauseId}`);
  }

  for (const taskId of Object.keys(shaped.tasks).sort(compareSgosCodePoints)) {
    if (!taskIds.has(taskId)) {
      fail(`Intent-to-Workflow coverage references unknown task '${taskId}'.`,
        'SGOS_WORKFLOW_COVERAGE_INVALID', { taskId });
    }
    const links = shaped.tasks[taskId].map((link) => {
      if (!COVERAGE_SOURCE_KINDS.has(link.kind) || link.sourceId == null
          || link.targetId != null) {
        fail(`Coverage for task '${taskId}' requires a closed source kind and sourceId.`,
          'SGOS_WORKFLOW_COVERAGE_INVALID', { taskId, link });
      }
      if (link.kind === 'intent-clause') {
        if (!clauseIds.has(link.sourceId)) {
          fail(`Coverage for task '${taskId}' references unknown clause '${link.sourceId}'.`,
            'SGOS_WORKFLOW_COVERAGE_INVALID', { taskId, clauseId: link.sourceId });
        }
        reversePairs.add(`${link.sourceId}\0${taskId}`);
      }
      assertCoverageSource({
        taskId,
        link,
        task: taskMap.get(taskId),
        workflow,
        clauseIds
      });
      return link;
    });
    tasks[taskId] = canonicalCoverageLinks(links, `coverage.tasks.${taskId}`);
  }
  const unmatched = [...new Set([...forwardPairs, ...reversePairs])]
    .filter((pair) => !forwardPairs.has(pair) || !reversePairs.has(pair))
    .sort(compareSgosCodePoints);
  if (unmatched.length) {
    fail('Intent-to-Workflow task links must be represented in both directions.',
      'SGOS_WORKFLOW_COVERAGE_INVALID', {
        mappings: unmatched.map((pair) => {
          const [clauseId, taskId] = pair.split('\0');
          return { clauseId, taskId };
        })
      });
  }
  return deepFreeze({ clauses, tasks });
}

/** Create a content-addressed Workflow IR candidate only from explicit, finite task declarations. */
export function createSgosWorkflowCandidate(requestValue) {
  const request = cloneSgosValue(requestValue);
  exactKeys(request, ['intentIr', 'policySnapshot', 'declaration'], 'workflow authoring request');
  requireFields(request, ['intentIr', 'policySnapshot', 'declaration'], 'workflow authoring request');
  const intentIr = validateIntentIr(request.intentIr);
  const policySnapshot = validatePolicySnapshot(request.policySnapshot);
  const declaration = request.declaration;
  exactKeys(declaration, ['version', 'metadata', 'spec'], 'workflow declaration');
  requireFields(declaration, ['version', 'metadata', 'spec'], 'workflow declaration');
  if (!plainObject(declaration.spec)) fail('workflow declaration.spec must be an object.');
  if (!plainObject(declaration.spec.tasks)) {
    fail('workflow declaration.spec.tasks must be an explicit object map.');
  }
  const budgets = declaration.spec.budgets;
  if (!plainObject(budgets)) fail('workflow declaration.spec.budgets must be an object.');
  const maximumTasks = budgets.maximumTasks;
  const maximumAttempts = budgets.maximumAttemptsPerTask ?? budgets.maximumAttempts;
  if (!Number.isSafeInteger(maximumTasks) || maximumTasks < 1
      || maximumTasks > SGOS_INSTALLED_LIMITS.maximumTasks) {
    fail('workflow declaration requires a positive maximumTasks within the installed ceiling.',
      'SGOS_WORKFLOW_BOUND_INVALID', {
        maximumTasks: maximumTasks ?? null,
        installedMaximumTasks: SGOS_INSTALLED_LIMITS.maximumTasks
      });
  }
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1
      || maximumAttempts > SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask) {
    fail('workflow declaration requires a positive maximumAttempts within the installed ceiling.',
      'SGOS_WORKFLOW_BOUND_INVALID', {
        maximumAttempts: maximumAttempts ?? null,
        installedMaximumAttempts: SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask
      });
  }
  if (budgets.maximumAttempts != null && budgets.maximumAttemptsPerTask != null
      && budgets.maximumAttempts !== budgets.maximumAttemptsPerTask) {
    fail('workflow maximumAttempts and maximumAttemptsPerTask must agree when both are present.',
      'SGOS_WORKFLOW_BOUND_INVALID');
  }

  const tasks = Object.fromEntries(Object.entries(declaration.spec.tasks)
    .sort(([left], [right]) => compareSgosCodePoints(left, right))
    .map(([taskId, task]) => [
      taskId,
      normalizedTask(taskId, task, policySnapshot.snapshotSha256, maximumAttempts)
    ]));
  if (!Object.keys(tasks).length) fail('workflow declaration must contain at least one task.');
  const expandedTaskBound = declaredTaskBound(tasks);
  if (expandedTaskBound > maximumTasks) {
    fail('workflow task declarations exceed their maximumTasks expansion ceiling.',
      'SGOS_WORKFLOW_BOUND_INVALID', { expandedTaskBound, maximumTasks });
  }
  const known = new Set(Object.keys(tasks));
  const knownClauseIds = intentClauseIdSet(intentIr);
  for (const [taskId, task] of Object.entries(tasks)) {
    const unknown = task.dependsOn.find((predecessor) => !known.has(predecessor));
    if (unknown) {
      fail(`workflow task '${taskId}' depends on unknown task '${unknown}'.`,
        'SGOS_WORKFLOW_TASK_UNKNOWN', { taskId, predecessor: unknown });
    }
    if (task.dependsOn.includes(taskId)) {
      fail(`workflow task '${taskId}' cannot depend on itself.`, 'SGOS_WORKFLOW_CYCLE', { taskId });
    }
    const unknownClauseId = (task.intentClauseIds ?? [])
      .find((clauseId) => !knownClauseIds.has(clauseId));
    if (unknownClauseId) {
      fail(`workflow task '${taskId}' references unknown intent clause '${unknownClauseId}'.`,
        'SGOS_WORKFLOW_COVERAGE_INVALID', { taskId, clauseId: unknownClauseId });
    }
  }
  assertFiniteTaskGraph(tasks);

  digest(declaration.spec.storageRequirements?.profileSha256,
    'workflow declaration.spec.storageRequirements.profileSha256');

  const seed = {
    apiVersion: 'sflow/v1',
    version: declaration.version,
    intentIrSha256: intentIr.intentIrSha256,
    policySnapshotSha256: policySnapshot.snapshotSha256,
    metadata: declaration.metadata,
    spec: { ...declaration.spec, tasks }
  };
  let workflow = createWorkflowIr(seed);
  if (workflow.spec.intentWorkflowMap != null) {
    const intentWorkflowMap = contextualCoverage(
      intentIr,
      workflow,
      workflow.spec.intentWorkflowMap
    );
    workflow = createWorkflowIr({
      ...seed,
      spec: { ...seed.spec, intentWorkflowMap }
    });
  }
  return validateWorkflowIr(workflow);
}

function workflowRatificationInputs(requestValue) {
  const request = cloneSgosValue(requestValue);
  exactKeys(request, [
    'intentIr', 'workflow', 'policySnapshot', 'registrySnapshot', 'storageProfileSha256',
    'coverage'
  ], 'workflow ratification packet request');
  requireFields(request, [
    'intentIr', 'workflow', 'policySnapshot', 'registrySnapshot', 'storageProfileSha256'
  ], 'workflow ratification packet request');
  const intentIr = validateIntentIr(request.intentIr);
  const workflow = validateWorkflowIr(request.workflow);
  const policySnapshot = validatePolicySnapshot(request.policySnapshot);
  const registrySnapshot = validateSgosRegistrySnapshot(request.registrySnapshot);
  if (workflow.intentIrSha256 !== intentIr.intentIrSha256) {
    fail('Workflow IR does not bind the exact Intent IR.', 'SGOS_WORKFLOW_INTENT_MISMATCH', {
      expected: intentIr.intentIrSha256,
      received: workflow.intentIrSha256
    });
  }
  if (workflow.policySnapshotSha256 !== policySnapshot.snapshotSha256) {
    fail('Workflow IR does not bind the exact Policy Snapshot.', 'SGOS_WORKFLOW_POLICY_MISMATCH', {
      expected: policySnapshot.snapshotSha256,
      received: workflow.policySnapshotSha256
    });
  }
  const coverage = contextualCoverage(
    intentIr,
    workflow,
    request.coverage ?? workflow.spec.intentWorkflowMap
  );
  const storageProfileSha256 = digest(request.storageProfileSha256, 'storageProfileSha256');
  const workflowStorageProfileSha256 = workflow.spec.storageRequirements?.profileSha256;
  if (workflowStorageProfileSha256 !== storageProfileSha256) {
    fail('Workflow IR does not bind the exact storage profile selected for ratification.',
      'SGOS_WORKFLOW_STORAGE_MISMATCH', {
        expected: storageProfileSha256,
        received: workflowStorageProfileSha256 ?? null
      });
  }
  return {
    intentIr,
    workflow,
    policySnapshot,
    registrySnapshot,
    storageProfileSha256,
    coverage
  };
}

/** Build the exact packet that binds every compiler authority input for human ratification. */
export function createSgosWorkflowRatificationPacket(requestValue) {
  const inputs = workflowRatificationInputs(requestValue);
  return sealPacket({
    format: SGOS_WORKFLOW_RATIFICATION_FORMAT,
    decision: 'ratified',
    intentIrSha256: inputs.intentIr.intentIrSha256,
    workflowSha256: inputs.workflow.workflowSha256,
    policySnapshotSha256: inputs.policySnapshot.snapshotSha256,
    registrySnapshotSha256: inputs.registrySnapshot.registrySnapshotSha256,
    storageProfileSha256: inputs.storageProfileSha256,
    coverage: inputs.coverage
  }, 'packetSha256');
}

/** Ratify one exact packet through the configured approved authority for workflow.ratify. */
export async function createSgosWorkflowRatification(root, requestValue) {
  const request = cloneSgosValue(requestValue);
  exactKeys(request, [
    'intentIr', 'workflow', 'policySnapshot', 'registrySnapshot', 'storageProfileSha256',
    'coverage', 'confirmationSha256', 'decidedAt'
  ], 'workflow ratification request');
  requireFields(request, [
    'intentIr', 'workflow', 'policySnapshot', 'registrySnapshot', 'storageProfileSha256',
    'confirmationSha256', 'decidedAt'
  ], 'workflow ratification request');
  const packetInput = Object.fromEntries(Object.entries(request).filter(([field]) =>
    !['confirmationSha256', 'decidedAt'].includes(field)));
  const packet = createSgosWorkflowRatificationPacket(packetInput);
  digest(request.confirmationSha256, 'confirmationSha256');
  if (request.confirmationSha256 !== packet.packetSha256) {
    fail('Workflow ratification must confirm the exact current packet hash.',
      'SGOS_WORKFLOW_RATIFICATION_REQUIRED', {
        expected: packet.packetSha256,
        received: request.confirmationSha256
      });
  }
  const principal = await approvedHumanPrincipal(root, 'workflow.ratify');
  return createWorkflowRatification({
    intentIrSha256: packet.intentIrSha256,
    workflowSha256: packet.workflowSha256,
    policySnapshotSha256: packet.policySnapshotSha256,
    registrySnapshotSha256: packet.registrySnapshotSha256,
    storageProfileSha256: packet.storageProfileSha256,
    packetSha256: packet.packetSha256,
    decision: packet.decision,
    principal,
    coverage: packet.coverage,
    decidedAt: timestamp(request.decidedAt, 'decidedAt')
  });
}

function exactProgram(programValue) {
  const program = validateGvmProgram(programValue?.program ?? programValue);
  validateSgosProgramStaticSafety(program, {
    maximumTasks: SGOS_INSTALLED_LIMITS.maximumTasks,
    maximumAttempts: SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask
  });
  return program;
}

/** Preview the exact approved-configuration record path and confirmation for one Program. */
export function createSgosProgramAuthorityProposal(programValue) {
  const program = exactProgram(programValue);
  return sealPacket({
    format: SGOS_PROGRAM_AUTHORITY_PROPOSAL_FORMAT,
    decision: 'approved',
    publicationRequired: 'sflow/config',
    path: sgosProgramAuthorityPath(program),
    programSha256: program.programSha256,
    ratificationSha256: program.ratificationSha256
  }, 'proposalSha256');
}

/**
 * Create the existing Program-authority record after exact-hash confirmation. The returned record
 * is ready to be proposed at `path` on the normal sflow/config review route; this function does not
 * publish it or confer execution authority locally.
 */
export async function approveSgosProgramAuthority(root, requestValue) {
  const request = cloneSgosValue(requestValue);
  exactKeys(request, ['program', 'confirmationSha256', 'approvedAt'],
    'Program authority request');
  requireFields(request, ['program', 'confirmationSha256', 'approvedAt'],
    'Program authority request');
  const programInput = request.program;
  const program = exactProgram(programInput);
  const proposal = createSgosProgramAuthorityProposal(programInput);
  digest(request.confirmationSha256, 'confirmationSha256');
  if (request.confirmationSha256 !== proposal.proposalSha256) {
    fail('Program authority approval must confirm the exact current proposal hash.',
      'SGOS_PROGRAM_AUTHORITY_CONFIRMATION_REQUIRED', {
        expected: proposal.proposalSha256,
        received: request.confirmationSha256
      });
  }
  const record = createTrustedProgramAuthorityRecord(programInput, {
    approvedBy: await approvedHumanPrincipal(root, 'program-authority.approve'),
    approvedAt: timestamp(request.approvedAt, 'approvedAt')
  });
  return deepFreeze({
    authorityStatus: 'proposal-only',
    path: proposal.path,
    proposalSha256: proposal.proposalSha256,
    record
  });
}

// Explicit aliases for callers that describe the records rather than the ceremony.
export const createSgosWorkflowIrFromTasks = createSgosWorkflowCandidate;
export const ratifySgosWorkflow = createSgosWorkflowRatification;
export const createSgosProgramAuthorityRecordProposal = approveSgosProgramAuthority;
