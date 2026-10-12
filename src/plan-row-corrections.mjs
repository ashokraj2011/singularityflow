/**
 * Plan corrections: rows, tests and paths of an approved plan, corrected in place. `[UIF-M1]`
 *
 * A plan that omits a clause, names a path the work never touches, or lacks a test used to have one
 * way out: reject back to planning and replay every phase after it. Real Stories stopped there,
 * often because the workflow did not even allow the return. Narrow amendments
 * (plan-amendments.mjs) could only add paths to existing rows.
 *
 * A correction is an append-only record on the Story, decided by the owner plan's approvers and
 * bound to that plan's exact generation, map digest and, for an existing row, the row's exact
 * digest. Every plan reader applies it next to evidence corrections, so coverage, delivery evidence
 * and the final gate judge the corrected row as if the plan had said so. Nothing is reset, and a
 * later approved plan generation supersedes its old corrections. Pure: no I/O.
 */
import { z } from 'zod';
import { recordSha256 } from './records.mjs';
import { applyPlanEvidenceAmendments, evidenceOwnerAuthorities } from './plan-evidence-amendments.mjs';
import { normalizeVerificationContracts } from './verification/contracts.mjs';
import { SingularityFlowError, posix } from './util.mjs';

const MAX_OPERATIONS = 20;
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const clause = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}:[A-Z]{2,4}-\d{3}$/u);
const portablePath = z.string().min(1).max(512).refine((value) => !/[\\:*?"<>|\x00-\x1f\x7f]/u.test(value)
  && !value.startsWith('/') && value.split('/').every((part) => part && part !== '.' && part !== '..'));

const Operation = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add-row'), clauseId: clause, claim: z.record(z.string(), z.unknown()) }),
  z.strictObject({ op: z.literal('add-test'), clauseId: clause, test: portablePath, previousClaimSha256: sha }),
  z.strictObject({ op: z.literal('remove-location'), clauseId: clause, path: portablePath, previousClaimSha256: sha }),
  z.strictObject({ op: z.literal('replace-location'), clauseId: clause, from: portablePath, to: portablePath,
    previousClaimSha256: sha })
]);

export const PlanRowCorrectionSchema = z.strictObject({
  id: z.string().regex(/^PRC-\d{3,}$/u), kind: z.literal('plan-row-correction'),
  ownerPhase: z.string().min(1), ownerGeneration: z.number().int().positive(), ownerMapSha256: sha,
  operations: z.array(Operation).min(1).max(MAX_OPERATIONS),
  reason: z.string().trim().min(20).max(1000),
  actor: z.string().min(1), authorityGroup: z.string().min(1), identityAssurance: z.string().nullable(),
  authorizationId: z.string().uuid(), reviewAssurance: z.literal('live-terminal-exact-plan-review'),
  at: z.string().datetime(), upstreamIssue: z.string().regex(/^UPI-\d{3,}$/u).nullable()
});

function invalid(message, details = undefined) {
  throw new SingularityFlowError(message, { code: 'PLAN_ROW_CORRECTION_INTEGRITY', ...(details ? { details } : {}) });
}

function refused(message, details = undefined) {
  throw new SingularityFlowError(message, { code: 'PLAN_ROW_CORRECTION_INVALID', ...(details ? { details } : {}) });
}

function exactPath(value, label) {
  const candidate = posix(String(value ?? '').trim());
  if (!portablePath.safeParse(candidate).success || /[*?[\]{}]/u.test(candidate) || candidate.endsWith('/')) {
    refused(`${label} must be one exact repository-relative file path.`);
  }
  return candidate;
}

/** A row's paths are required unless it is test-only; never leave a row that needs them without one. */
function needsPaths(claim) {
  return claim.fulfillment != null && claim.fulfillment !== 'test-only';
}

/**
 * One operation applied to a cloned record. Shared by recording (which computes each row digest as
 * it goes) and by every reader (which proves the same digests), so the two cannot disagree.
 */
function applyOperation(result, operation, { check }) {
  const id = operation.clauseId;
  if (operation.op === 'add-row') {
    if (result.claims[id]) check(false, `The plan already has a row for ${id}; correct that row instead.`, { clauseId: id });
    result.claims[id] = structuredClone(operation.claim);
    return;
  }
  const claim = result.claims[id];
  if (!claim) return check(false, `The plan has no row for ${id}.`, { clauseId: id });
  check(recordSha256(claim) === operation.previousClaimSha256,
    `The plan row for ${id} is not the row this correction was decided against.`, { clauseId: id });
  if (operation.op === 'add-test') {
    check(claim.testDisposition !== 'non-test',
      `${id} is proven without executable tests; change its proof with an evidence correction or a new plan.`, { clauseId: id });
    check(!(claim.tests ?? []).includes(operation.test), `${operation.test} is already a planned test of ${id}.`, { clauseId: id });
    claim.tests = [...new Set([...(claim.tests ?? []), operation.test])].sort();
    claim.testDisposition = 'applicable';
    claim.testReason = null;
    const stated = (result.verificationContracts ?? []).find((entry) => entry.clauseId === id);
    if (stated) {
      // A stated contract governs the criterion; the added test joins it as a supporting witness.
      const used = new Set(stated.slots.map((entry) => entry.slot));
      let index = 1;
      while (used.has(`added-test-${index}`)) index += 1;
      result.verificationContracts = normalizeVerificationContracts((result.verificationContracts ?? []).map((entry) =>
        entry.clauseId !== id ? entry : { ...entry, slots: [...entry.slots, { slot: `added-test-${index}`, method: 'test',
          role: 'supporting', witness: { path: operation.test }, requiredAssurance: null }] }));
    }
    return;
  }
  const paths = claim.expectedPaths ?? [];
  const removed = operation.op === 'remove-location' ? operation.path : operation.from;
  check(paths.includes(removed), `${removed} is not an expected path of ${id}.`, { clauseId: id });
  const next = paths.filter((entry) => entry !== removed);
  if (operation.op === 'replace-location') {
    check(!paths.includes(operation.to), `${operation.to} is already an expected path of ${id}.`, { clauseId: id });
    next.push(operation.to);
  }
  check(next.length > 0 || !needsPaths(claim),
    `${id} is ${claim.fulfillment}, so it keeps at least one expected path; replace the path instead of removing it.`,
    { clauseId: id });
  claim.expectedPaths = [...new Set(next)].sort();
}

/** The owner plan's approval groups decide; a different plan's reviewers cannot correct this one. */
export function planCorrectionAuthorities(workflow, ownerPhase) {
  return evidenceOwnerAuthorities(workflow, ownerPhase);
}

/**
 * Validate and record one correction against the owner's current planned record (already read and
 * verified by the caller). `normalizeRow(clauseId, rawClaim)` is the plan's own row normalizer, so
 * an added or changed row is refused exactly where a planner's row would be, and `validate(plan)`
 * checks the whole corrected plan (approved verification intent) before anything is recorded.
 */
export function recordPlanRowCorrection(workflow, {
  ownerRecord, ownerMapSha256, operations = [], activeClauseIds = [], normalizeRow, validate = () => {},
  reason, actor, authorityGroup, identityAssurance = null, authorizationId, at, upstreamIssue = null
}) {
  if (!ownerRecord || ownerRecord.kind !== 'planned') refused('A plan correction needs the approved plan it corrects.');
  if (!operations.length || operations.length > MAX_OPERATIONS) {
    refused(`Name 1 to ${MAX_OPERATIONS} corrections with --add-row, --add-test, --remove-location or --replace-location.`);
  }
  const active = new Set(activeClauseIds.map((value) => String(value).toUpperCase()));
  const result = structuredClone(ownerRecord);
  const check = (condition, message, details) => { if (!condition) refused(message, details); };
  const recorded = operations.map((input) => {
    const clauseId = String(input.clauseId ?? '').toUpperCase();
    if (!active.has(clauseId)) refused(`${clauseId || 'That clause'} is not an approved clause of this Story.`, { clauseId });
    let operation;
    if (input.op === 'add-row') {
      const raw = {
        expectedPaths: (input.expectedPaths ?? []).map((value) => exactPath(value, `An expected path of ${clauseId}`)),
        tests: (input.tests ?? []).map((value) => exactPath(value, `A planned test of ${clauseId}`)),
        ...(input.fulfillment ? { fulfillment: input.fulfillment } : {}),
        ...(input.steps?.length ? { steps: input.steps } : {}),
        ...(input.observableResult ? { observableResult: input.observableResult } : {})
      };
      if (!raw.expectedPaths.length && !raw.tests.length) refused(`A new row for ${clauseId} needs expected paths or planned tests.`);
      operation = { op: 'add-row', clauseId, claim: normalizeRow(clauseId, raw) };
    } else if (input.op === 'add-test') {
      operation = { op: 'add-test', clauseId, test: exactPath(input.test, `The planned test for ${clauseId}`) };
    } else if (input.op === 'remove-location') {
      operation = { op: 'remove-location', clauseId, path: exactPath(input.path, `The path to remove from ${clauseId}`) };
    } else if (input.op === 'replace-location') {
      operation = { op: 'replace-location', clauseId, from: exactPath(input.from, `The path to replace in ${clauseId}`),
        to: exactPath(input.to, `The replacement path for ${clauseId}`) };
    } else {
      refused('A plan correction adds a row or a test, or removes or replaces a path.');
    }
    if (operation.op !== 'add-row') {
      if (!result.claims[clauseId]) refused(`The plan has no row for ${clauseId}; add one with --add-row.`, { clauseId });
      operation.previousClaimSha256 = recordSha256(result.claims[clauseId]);
    }
    applyOperation(result, operation, { check });
    return operation;
  });
  // Every row a correction touched must still be a row the planner could have written.
  for (const clauseId of new Set(recorded.map((operation) => operation.clauseId))) normalizeRow(clauseId, result.claims[clauseId]);
  validate(result);
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) refused('Say why the plan is corrected in 20 to 1000 characters with --reason.');
  workflow.planAmendments ??= [];
  const sequence = workflow.planAmendments.filter((entry) => entry?.kind === 'plan-row-correction').length + 1;
  const correction = {
    id: `PRC-${String(sequence).padStart(3, '0')}`, kind: 'plan-row-correction',
    ownerPhase: ownerRecord.phase, ownerGeneration: Number(ownerRecord.generation), ownerMapSha256,
    operations: recorded, reason: text, actor, authorityGroup, identityAssurance, authorizationId,
    reviewAssurance: 'live-terminal-exact-plan-review', at, upstreamIssue
  };
  const checked = PlanRowCorrectionSchema.safeParse(correction);
  if (!checked.success) refused(`The plan correction is not well formed: ${checked.error.issues[0]?.message ?? 'invalid'}.`);
  workflow.planAmendments.push(correction);
  return correction;
}

function applyRowCorrection(record, workflow, value) {
  const checked = PlanRowCorrectionSchema.safeParse(value);
  if (!checked.success) invalid('A plan correction record is not well formed.', { id: value?.id ?? null });
  const correction = checked.data;
  if (!planCorrectionAuthorities(workflow, correction.ownerPhase).includes(correction.authorityGroup)) {
    invalid(`Plan correction ${correction.id} lacks its owner plan's authority.`, { id: correction.id });
  }
  if (correction.ownerPhase !== record.phase || correction.ownerGeneration !== Number(record.generation)) return record;
  const pointer = workflow.phases?.[record.phase]?.claimMaps?.planned;
  if (!pointer || pointer.sha256 !== correction.ownerMapSha256) {
    invalid(`Plan correction ${correction.id} no longer binds its approved plan.`, { id: correction.id });
  }
  const result = structuredClone(record);
  const check = (condition, message, details) => { if (!condition) invalid(`Plan correction ${correction.id}: ${message}`, details); };
  for (const operation of correction.operations) applyOperation(result, operation, { check });
  return result;
}

/**
 * Apply every evidence and row correction of this exact owner generation in recorded order. Each
 * one pins the row it replaces as the readers showed it when it was decided, which includes every
 * earlier correction of either kind, so they must replay in that same order. Later plans supersede them.
 */
export function applyPlanCorrections(record, workflow, options = {}) {
  if (!record || record.amendment) return record;
  let result = record;
  for (const value of workflow?.planAmendments ?? []) {
    if (value?.kind === 'evidence-contract-correction') {
      result = applyPlanEvidenceAmendments(result, { ...workflow, planAmendments: [value] }, options);
    } else if (value?.kind === 'plan-row-correction') {
      result = applyRowCorrection(result, workflow, value);
    }
  }
  return result;
}

/** Corrections in force for a plan generation, for disclosure. */
export function planRowCorrections(workflow, ownerPhase = null) {
  return (workflow?.planAmendments ?? []).filter((entry) => entry?.kind === 'plan-row-correction'
    && (!ownerPhase || entry.ownerPhase === ownerPhase));
}
