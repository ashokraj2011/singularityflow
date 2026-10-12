/**
 * `decision plan` corrections: someone in the group that approves a plan adds a missing row or
 * test, or removes or replaces a wrong path, after reviewing the exact before/after rows in a live
 * terminal. Nothing is reset; every plan reader applies the correction. `[UIF-M1]`
 */
import path from 'node:path';
import { head, identity } from '../git.mjs';
import { recordSha256 } from '../records.mjs';
import { loadBoundActiveSpecRecords, normalizeClaimMap } from '../specifications.mjs';
import { validatePlannedVerification } from '../verification/intent.mjs';
import { planCorrectionAuthorities, recordPlanRowCorrection } from '../plan-row-corrections.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { captureTerminalActionAuthorization, consumeActionAuthorization } from '../action-authorization.mjs';
import { assertNoPendingPublication, actorKey, transactStory } from '../state-stores.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { nowIso, optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const FLAGS = ['add-row', 'add-test', 'remove-location', 'replace-location'];

function refused(message, details = undefined) {
  throw new SingularityFlowError(message, { code: 'PLAN_ROW_CORRECTION_INVALID', ...(details ? { details } : {}) });
}

function list(value) {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function pair(entry, flag, separator = '=') {
  const at = String(entry).indexOf(separator);
  if (at < 1) refused(`${flag} must be <clause>${separator}<path>; got '${entry}'.`);
  return [String(entry).slice(0, at).trim(), String(entry).slice(at + 1).trim()];
}

export function planCorrectionRequested(options) {
  return FLAGS.some((flag) => optionStrings(options, flag).length);
}

/** The operations named on the command line, in the order the flags list them. */
export function planCorrectionOperations(options) {
  const rows = optionStrings(options, 'add-row');
  const rowFields = { tests: optionStrings(options, 'test').flatMap(list), fulfillment: optionString(options, 'fulfillment'),
    steps: list(optionString(options, 'steps')), observableResult: optionString(options, 'observable-result') };
  const usesRowFields = rowFields.tests.length || rowFields.fulfillment || rowFields.steps.length || rowFields.observableResult;
  if (usesRowFields && rows.length !== 1) {
    refused('--test, --fulfillment, --steps and --observable-result describe one new row; name exactly one --add-row.');
  }
  return [
    ...rows.map((entry) => {
      const [clauseId, paths] = String(entry).includes('=') ? pair(entry, '--add-row') : [String(entry).trim(), ''];
      return { op: 'add-row', clauseId, expectedPaths: list(paths), ...rowFields };
    }),
    ...optionStrings(options, 'add-test').map((entry) => {
      const [clauseId, test] = pair(entry, '--add-test');
      return { op: 'add-test', clauseId, test };
    }),
    ...optionStrings(options, 'remove-location').map((entry) => {
      const [clauseId, file] = pair(entry, '--remove-location');
      return { op: 'remove-location', clauseId, path: file };
    }),
    ...optionStrings(options, 'replace-location').map((entry) => {
      const [clauseId, change] = pair(entry, '--replace-location');
      const [from, to] = pair(change, '--replace-location <clause>=<from>', ':');
      return { op: 'replace-location', clauseId, from, to };
    })
  ];
}

/** The approved plan this correction binds; several plans need --owner. */
function correctionOwner(workflow, requested) {
  const plannedPolicy = workflow.resolution?.plannedClaims;
  const order = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  const owners = (plannedPolicy?.mode === 'required'
    ? [...new Set(Object.values(plannedPolicy.owners ?? {}))]
    : order.filter((id) => workflow.phases?.[id]?.claimMaps?.planned))
    .filter((id) => workflow.phases?.[id]?.status === 'approved' && workflow.phases[id].generation > 0);
  if (requested && !owners.includes(requested)) {
    refused(`${requested} is not an approved plan of this Story${owners.length ? `; approved plans: ${owners.join(', ')}` : ''}.`);
  }
  if (!requested && owners.length !== 1) {
    refused(owners.length ? `This Story has several approved plans; name one with --owner (${owners.join(', ')}).`
      : 'This Story has no approved plan to correct.');
  }
  const owner = workflow.phases[requested ?? owners[0]];
  if (!owner.claimMaps?.planned?.sha256) refused(`Plan ${owner.id} has no bound claim map, so it cannot be corrected.`);
  return owner;
}

/** Validate against the current plan; nothing is recorded. The same preview is shown for review. */
async function preview(root, config, workflow, options) {
  const owner = correctionOwner(workflow, optionString(options, 'owner'));
  const policy = workflow.resolution?.spec ?? config.spec ?? {};
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const records = await loadBoundActiveSpecRecords(root, itemDirectory, workflow, policy, { plannedOnly: true });
  const ownerRecord = (records.planned ?? []).find((record) => !record.amendment && record.phase === owner.id);
  if (!ownerRecord) refused(`The approved plan of ${owner.id} could not be read.`);
  const clauses = records.indexes.flatMap((index) => index.clauses ?? []);
  const clauseIds = clauses.map((clause) => String(clause.id).toUpperCase());
  const normalizeRow = (clauseId, raw) => normalizeClaimMap({ claims: { [clauseId]: raw } },
    { kind: 'planned', clauseIds, policy }).claims[clauseId];
  const operations = planCorrectionOperations(options);
  const scratch = structuredClone(workflow);
  const correction = recordPlanRowCorrection(scratch, {
    ownerRecord, ownerMapSha256: owner.claimMaps.planned.sha256, operations, activeClauseIds: clauseIds, normalizeRow,
    validate: (plan) => validatePlannedVerification(plan.claims, plan.verificationContracts ?? [], clauses),
    reason: optionString(options, 'reason') ?? '', actor: 'preview', authorityGroup: 'preview',
    authorizationId: '00000000-0000-4000-8000-000000000000', at: nowIso(),
    upstreamIssue: optionString(options, 'upstream-issue') ?? null
  });
  return { owner, ownerRecord, operations, correction, normalizeRow, clauses, clauseIds,
    previewSha256: recordSha256({ owner: owner.id, generation: owner.generation, map: owner.claimMaps.planned.sha256,
      operations: correction.operations, reason: correction.reason, upstreamIssue: correction.upstreamIssue }) };
}

export async function runPlanCorrection({ root, config, workflow, options }, {
  capture = captureTerminalActionAuthorization, consume = consumeActionAuthorization
} = {}) {
  const id = workflow.workItem.id;
  if (optionStrings(options, 'add-location').length || optionStrings(options, 'add-supporting').length) {
    refused('Record a plan correction and a narrow amendment as two decisions.');
  }
  const groups = planCorrectionAuthorities(workflow, correctionOwner(workflow, optionString(options, 'owner')).id);
  if (!groups.length) refused('The plan has no approval group, so nobody can correct it.');
  const reviewed = await preview(root, config, workflow, options);
  const { owner, correction } = reviewed;
  if (optionBoolean(options, 'dry-run')) {
    emitCommandResult(commandResult({
      operation: { id: 'decision.plan', classification: 'mutation' }, subject: { kind: 'story', id },
      outcome: succeeded('decision.plan.correction-previewed', { owner: owner.id, operations: String(correction.operations.length) }),
      effects: noEffects(),
      data: { dryRun: true, previewSha256: reviewed.previewSha256, ownerPhase: owner.id, ownerGeneration: owner.generation,
        operations: correction.operations, authorityGroups: groups }
    }), { json: optionBoolean(options, 'json'), postState: workflow });
    return;
  }
  const actor = identity(root);
  const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  const actionId = `PRC-${reviewed.previewSha256.slice(0, 24)}`;
  const card = { plan: { planId: actionId, planHash: reviewed.previewSha256, reviewer: actorKey(actor),
    subject: { workId: id, phaseId: owner.id }, revision: head(root),
    ownerPhase: owner.id, ownerGeneration: owner.generation, operations: correction.operations,
    rowsBefore: Object.fromEntries(correction.operations.map((operation) =>
      [operation.clauseId, reviewed.ownerRecord.claims[operation.clauseId] ?? null])),
    reason: correction.reason, testsWaived: false, phaseApproved: false },
  action: { actionId, confirmation: { required: true } } };
  const grant = await capture(root, card.plan, card.action, { label: `Correct plan ${owner.id}` });
  if (!grant) {
    emitCommandResult(commandResult({
      operation: { id: 'decision.plan', classification: 'mutation' }, subject: { kind: 'story', id },
      outcome: succeeded('decision.plan.correction-cancelled', { owner: owner.id }), effects: noEffects(), data: { cancelled: true }
    }), { json: optionBoolean(options, 'json'), postState: workflow });
    return;
  }
  const { value: recorded, publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
    actor, agent: null, authorityGroup: authority.authorityGroup, payload: { decision: 'plan' }
  }, `[${id}][plan:correct] ${owner.id} ${correction.operations.length} change(s)`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'correct the plan');
    const fresh = await preview(root, config, aggregate, options);
    if (fresh.previewSha256 !== reviewed.previewSha256) {
      refused('The plan changed during review. Nothing was recorded; review the correction again.');
    }
    const authorization = await consume(root, grant.token, card.plan, card.action, { requireTerminalPresentation: true });
    const record = recordPlanRowCorrection(aggregate, {
      ownerRecord: fresh.ownerRecord, ownerMapSha256: owner.claimMaps.planned.sha256, operations: fresh.operations,
      activeClauseIds: fresh.clauseIds, normalizeRow: fresh.normalizeRow,
      validate: (plan) => validatePlannedVerification(plan.claims, plan.verificationContracts ?? [], fresh.clauses),
      reason: correction.reason, actor: actorKey(actor), authorityGroup: authority.authorityGroup,
      identityAssurance: authority.identityAssurance ?? null, authorizationId: authorization.authorizationId,
      at: nowIso(), upstreamIssue: correction.upstreamIssue
    });
    aggregate.history.push({ at: record.at, actor: record.actor, agent: null, event: 'plan_amended', phase: aggregate.currentPhase ?? null,
      detail: `${record.id} corrects ${owner.id}: ${record.operations.map((operation) => `${operation.op} ${operation.clauseId}`).join('; ')}. ${record.reason}` });
    return record;
  }, {
    eventFromResult: (record) => ({ actor, agent: null, authorityGroup: record.authorityGroup, identityAssurance: record.identityAssurance,
      payload: { decision: 'plan', amendment: record.id, reviewPacketSha256: null } })
  });
  emitCommandResult(commandResult({
    operation: { id: 'decision.plan', classification: 'mutation' }, subject: { kind: 'story', id },
    outcome: succeeded('decision.plan.corrected', { correction: recorded.id, owner: owner.id, operations: String(recorded.operations.length) }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, correction: recorded }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
