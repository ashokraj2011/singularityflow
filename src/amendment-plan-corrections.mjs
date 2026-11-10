/**
 * The plan rows an intent amendment carries [PHR:REQ-008], owner decision 4 (2026-11-10).
 *
 * An amendment that adds or removes a clause leaves a separate approved plan without a row for the
 * new clause, or with a row for one the specification no longer holds. The amendment's step made that
 * gap, so it owns the repair: the proposal carries the rows (the decision plan flags --add-row and
 * --remove-row), the plan's approvers sign them as part of their decision on the same amendment, and
 * the plan keeps its approval. Nothing waits on the plan later and nothing runs again. A proposal that
 * would leave a gap is refused where it is made, naming the rows to carry.
 *
 * Each signed correction is an ordinary plan row correction (plan-row-corrections.mjs), bound to its
 * amendment: every plan reader applies it once the amendment is approved, and never before. Loaded
 * only where an amendment is proposed or decided.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { planCorrectionOperations } from './commands/plan-correction.mjs';
import { upheldIntentRows } from './phase-finding-dispute.mjs';
import { ownerStepChecks, scopeStepOf } from './phase-roles.mjs';
import { planClauseGaps } from './plan-clause-gaps.mjs';
import { applyPlanCorrections, PlanRowCorrectionSchema, planCorrectionAuthorities, recordPlanRowCorrection } from './plan-row-corrections.mjs';
import { requireApprovalAuthority } from './approval-authority.mjs';
import { countedRecords } from './presence/counted.mjs';
import { extractClauses, loadActiveSpecRecords, normalizeClaimMap } from './specifications.mjs';
import { requiredRepoPath } from './story-state-validation.mjs';
import { workDir, workDirRelative } from './story-paths.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';
import { validatePlannedVerification } from './verification/intent.mjs';

const CARRIED = Object.freeze(['add-row', 'remove-row']);
const upper = (value) => String(value ?? '').toUpperCase();

function refused(message, details = undefined) {
  throw new SingularityFlowError(message, { code: 'INTENT_AMENDMENT_PLAN_CORRECTION_INVALID', ...(details ? { details } : {}) });
}

/** The command that proposes the amendment again, carrying `flags`. */
function proposeCommand(workflow, file, flags) {
  return [`singularity-flow story intent-amendment propose --work-id ${workflow.workItem.id}`,
    `--file ${file ? JSON.stringify(file) : '<FILE>'}`, '--reason "<why the specification changes>"', ...flags].join(' ');
}

/** The decision plan flags that plan `unplanned` and remove `removed`: one --test per new row. */
function rowFlags(unplanned, removed) {
  const added = [...new Set(unplanned)];
  return [...added.map((id) => `--add-row ${id}=<PATH>`),
    ...(added.length === 1 ? ['--test <TEST>'] : added.map((id) => `--test ${id}=<TEST>`)),
    ...[...new Set(removed)].map((id) => `--remove-row ${id}`)];
}

/**
 * The rows a proposal carries for each separate approved plan it would part from, checked exactly as
 * decision plan checks them but against the amended clauses, and the gaps it still leaves. Only for a
 * Story that pinned the owner-step checks; one started before keeps its policy and carries nothing.
 */
export async function carriedPlanCorrections(root, config, workflow, { afterClauses, options, proposalId, reason, file = null }) {
  const operations = planCorrectionOperations(options);
  if (!ownerStepChecks(workflow)) {
    if (operations.length) {
      refused('This Story started before an amendment carried its plan rows; propose it without them, and the plan runs again as before.',
        { recoveryCommand: proposeCommand(workflow, file, []) });
    }
    return { corrections: [], uncovered: [] };
  }
  const misplaced = operations.find((operation) => !CARRIED.includes(operation.op));
  if (misplaced) {
    refused(`An amendment carries only the rows a separate plan lacks for a clause it adds, or holds for one it removes; ${misplaced.op} ${misplaced.clauseId} is a correction for decision plan once it is approved.`,
      { recoveryCommand: proposeCommand(workflow, file, []) });
  }
  const scope = scopeStepOf(workflow);
  const plans = (workflow.phaseOrder ?? []).filter((id) => id !== scope?.id && workflow.phases?.[id]?.status === 'approved'
    && workflow.phases[id].claimMaps?.planned?.sha256);
  // No separate approved plan: nothing can part from the amended clauses, and nothing is read.
  if (!plans.length && !operations.length) return { corrections: [], uncovered: [] };
  const policy = workflow.resolution?.spec ?? config.spec ?? {};
  // The plans as every reader shows them (their corrections applied); a later plan still being written binds nothing yet.
  const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
  // The clauses the Story holds once the amendment is approved: the proposed scope's and every other document's.
  const clauses = [...(records.indexes ?? []).filter((index) => index.phase !== scope?.id).flatMap((index) => index.clauses ?? []), ...afterClauses];
  const clauseIds = [...new Set(clauses.map((clause) => upper(clause.id)))];
  const normalizeRow = (clauseId, raw) => normalizeClaimMap({ claims: { [clauseId]: raw } }, { kind: 'planned', clauseIds, policy }).claims[clauseId];
  const used = new Set();
  const corrections = [];
  const uncovered = [];
  for (const id of plans) {
    const owner = workflow.phases[id];
    const ownerRecord = (records.planned ?? []).find((record) => !record.amendment && record.phase === id);
    if (!ownerRecord) continue;
    const gap = planClauseGaps(workflow, id, ownerRecord.claims, clauseIds);
    const mine = operations.filter((operation, index) => {
      const hit = (operation.op === 'add-row' ? gap.unplanned : gap.removed).includes(upper(operation.clauseId));
      if (hit) used.add(index);
      return hit;
    });
    const carried = new Set(mine.map((operation) => `${operation.op}:${upper(operation.clauseId)}`));
    const left = { phase: id, unplanned: gap.unplanned.filter((clause) => !carried.has(`add-row:${clause}`)),
      removed: gap.removed.filter((clause) => !carried.has(`remove-row:${clause}`)) };
    if (left.unplanned.length || left.removed.length) uncovered.push(left);
    if (!mine.length) continue;
    // Rows the plan's approvers upheld against the approved intent stay upheld through the correction [PHR:REQ-003].
    const ownerText = await readFile(path.join(root, requiredRepoPath(config, workflow, owner)), 'utf8').catch(() => null);
    const upheld = ownerText == null ? new Set() : await upheldIntentRows(root, config, workflow, owner, { text: ownerText, clauses });
    const correction = recordPlanRowCorrection(structuredClone(workflow), {
      ownerRecord, ownerMapSha256: owner.claimMaps.planned.sha256, operations: mine, activeClauseIds: clauseIds, normalizeRow,
      validate: (plan) => validatePlannedVerification(plan.claims, plan.verificationContracts ?? [], clauses, { upheld }),
      reason: amendmentReason(proposalId, reason), actor: 'preview', authorityGroup: 'preview',
      authorizationId: '00000000-0000-4000-8000-000000000000', at: nowIso()
    });
    corrections.push({ ownerPhase: id, ownerGeneration: Number(owner.generation), ownerMapSha256: owner.claimMaps.planned.sha256,
      operations: correction.operations });
  }
  const stray = operations.filter((_, index) => !used.has(index));
  if (stray.length) {
    refused(`${stray.map((operation) => `${operation.op} ${upper(operation.clauseId)}`).join(', ')}: no separate approved plan lacks that row for a clause this amendment adds, or holds it for one it removes.`,
      { recoveryCommand: proposeCommand(workflow, file, rowFlags(uncovered.flatMap((gap) => gap.unplanned), uncovered.flatMap((gap) => gap.removed))) });
  }
  return { corrections, uncovered };
}

/** The reason each carried correction records: the amendment's, under its id. */
export function amendmentReason(proposalId, reason) {
  return `Intent amendment ${proposalId}: ${String(reason ?? '').trim()}`.slice(0, 1000);
}

/** A proposal that would leave a separate plan with a gap, refused where it is made with the rows to carry. */
export function uncorrectedPlanRefusal(workflow, uncovered, { file = null } = {}) {
  const unplanned = uncovered.flatMap((gap) => gap.unplanned);
  const removed = uncovered.flatMap((gap) => gap.removed);
  const parts = uncovered.map((gap) => `${gap.phase} ${[gap.unplanned.length ? `has no row for ${gap.unplanned.join(', ')}` : null,
    gap.removed.length ? `still has rows for ${gap.removed.join(', ')}, which it removes` : null].filter(Boolean).join(' and ')}`);
  const command = proposeCommand(workflow, file, rowFlags(unplanned, removed));
  return new SingularityFlowError(`This amendment would leave the approved plan apart from the clauses it holds: ${parts.join('; ')}. `
    + 'The amendment carries those rows, so the plan keeps its approval and its approvers sign them when they decide it. '
    + 'Propose it again with each row (the decision plan flags). Nothing was proposed.', {
    code: 'INTENT_AMENDMENT_PLAN_UNCORRECTED',
    details: { phase: workflow.currentPhase ?? null, ownerPhase: workflow.currentPhase ?? null, repairScope: 'current-draft',
      plans: uncovered, recoveryCommand: command, nextAction: command }
  });
}

/** The corrections already signed for this amendment, as counted. */
export function signedAmendmentCorrections(workflow, proposalId) {
  return countedRecords(workflow, workflow?.planAmendments)
    .filter((entry) => entry?.kind === 'plan-row-correction' && entry.intentAmendment === proposalId);
}

/** The plans whose carried rows nobody has signed yet. */
export function unsignedPlanCorrections(workflow, proposal) {
  const signed = new Set(signedAmendmentCorrections(workflow, proposal.id).map((entry) => entry.ownerPhase));
  return (proposal.planCorrections ?? []).filter((carried) => !signed.has(carried.ownerPhase));
}

/** The groups that sign a plan's carried rows: the ones that correct that plan. */
export function planSignOffAuthorities(workflow, ownerPhase) {
  return planCorrectionAuthorities(workflow, ownerPhase);
}

/** The command an approver of a plan runs to sign its carried rows, deciding the amendment. */
export function planSignOffCommand(workflow, proposal) {
  return `singularity-flow story intent-amendment decide ${proposal.id} --decision approve --confirm ${proposal.id} --work-id ${workflow.workItem.id}`;
}

/**
 * Whether the carried rows still apply to each plan as it is now, read by the reader every step uses
 * with the amendment taken as approved: `stale` names a plan they no longer bind, `uncovered` a gap
 * they no longer close. Checked at each approver's decision, before anything is recorded.
 */
export async function amendmentPlanReadiness(root, config, workflow, proposal, clauseIds) {
  const scratch = structuredClone(workflow);
  // Every carried row counts here as it will once signed, the ones nobody signed yet too; nothing below writes.
  for (const carried of unsignedPlanCorrections(workflow, proposal)) {
    scratch.planAmendments = [...(scratch.planAmendments ?? []), amendmentPlanCorrection(scratch, {
      carried, reason: amendmentReason(proposal.id, proposal.reason), actor: 'readiness',
      authorityGroup: planCorrectionAuthorities(workflow, carried.ownerPhase)[0] ?? 'readiness', at: nowIso(), intentAmendment: proposal.id })];
  }
  scratch.resolution = { ...(scratch.resolution ?? {}), presence: undefined };
  scratch.intentAmendments = (scratch.intentAmendments ?? []).map((entry) => (entry.id === proposal.id ? { ...entry, status: 'approved' } : entry));
  const scope = scopeStepOf(workflow);
  const stale = [];
  const uncovered = [];
  for (const id of workflow.phaseOrder ?? []) {
    const owner = workflow.phases?.[id];
    const pointer = owner?.claimMaps?.planned;
    if (id === scope?.id || owner?.status !== 'approved' || !pointer?.path) continue;
    const carried = (proposal.planCorrections ?? []).find((entry) => entry.ownerPhase === id);
    if (carried && (carried.ownerGeneration !== Number(owner.generation) || carried.ownerMapSha256 !== pointer.sha256)) {
      stale.push({ phase: id, reason: `${id} was planned again after ${proposal.id} was proposed` });
      continue;
    }
    let claims;
    try {
      const raw = JSON.parse(await readFile(path.join(root, pointer.path), 'utf8'));
      claims = applyPlanCorrections(raw, scratch, { evidenceRoot: `${workDirRelative(config, workflow.workItem.id)}/evidence` })?.claims ?? null;
    } catch (error) {
      if (error?.code !== 'PLAN_ROW_CORRECTION_INTEGRITY') throw error;
      stale.push({ phase: id, reason: error.message });
      continue;
    }
    const gap = claims ? planClauseGaps(workflow, id, claims, clauseIds) : null;
    if (gap && (gap.unplanned.length || gap.removed.length)) uncovered.push({ phase: id, unplanned: gap.unplanned, removed: gap.removed });
  }
  return { stale, uncovered };
}

/** The carried rows no longer fit a plan: rejected and proposed again against the plan as it is now. */
export function stalePlanCorrectionRefusal(workflow, proposal, { stale, uncovered }) {
  const reject = `singularity-flow story intent-amendment decide ${proposal.id} --decision reject --confirm ${proposal.id} --work-id ${workflow.workItem.id} --reason "<why>"`;
  const again = proposeCommand(workflow, null, rowFlags(uncovered.flatMap((gap) => gap.unplanned), uncovered.flatMap((gap) => gap.removed)));
  const parts = [...stale.map((entry) => entry.reason),
    ...uncovered.map((gap) => `${gap.phase} would still part from the amended clauses (${[...gap.unplanned, ...gap.removed].join(', ')})`)];
  return new SingularityFlowError(`${proposal.id}'s plan rows no longer fit the approved plan: ${parts.join('; ')}. `
    + `Nothing was recorded. Reject ${proposal.id} and propose it again with the rows the plan needs now.`, {
    code: 'INTENT_AMENDMENT_PLAN_STALE',
    details: { phase: workflow.currentPhase ?? null, amendment: proposal.id, stale, uncovered,
      recoveryCommands: [{ command: reject, label: `Reject ${proposal.id}; the specification stays as approved.` },
        { command: again, label: 'Then propose it again, carrying the plan\'s rows as the plan is now.' }] }
  });
}

/**
 * The record of rows an intent amendment carries for one plan, signed by an approver of that plan in
 * their decision on the amendment [PHR:REQ-008]. The caller proved the rows against the plan as every
 * reader shows it and checked the person's authority over the plan.
 */
export function amendmentPlanCorrection(workflow, { carried, reason, actor, authorityGroup, identityAssurance = null, at, intentAmendment }) {
  const sequence = (workflow.planAmendments ?? []).filter((entry) => entry?.kind === 'plan-row-correction').length + 1;
  const correction = {
    id: `PRC-${String(sequence).padStart(3, '0')}`, kind: 'plan-row-correction',
    ownerPhase: carried.ownerPhase, ownerGeneration: Number(carried.ownerGeneration), ownerMapSha256: carried.ownerMapSha256,
    operations: structuredClone(carried.operations), reason, actor, authorityGroup, identityAssurance, authorizationId: null,
    reviewAssurance: 'intent-amendment-decision', intentAmendment, at, upstreamIssue: null
  };
  const checked = PlanRowCorrectionSchema.safeParse(correction);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new SingularityFlowError(`The plan rows of ${intentAmendment} are not well formed: ${issue?.path?.length ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'invalid'}.`,
      { code: 'PLAN_ROW_CORRECTION_INVALID' });
  }
  return correction;
}

/** The carried plans nobody signed yet that `actor` may sign, each with their authority over that plan. */
export function planSigners(workflow, proposal, actor, authorities) {
  return unsignedPlanCorrections(workflow, proposal).flatMap((entry) => {
    try {
      return [{ carried: entry, authority: requireApprovalAuthority(authorities,
        { mode: 'required', authorities: planSignOffAuthorities(workflow, entry.ownerPhase), requiredAuthorities: [], minimum: 1 }, actor) }];
    } catch { return []; }
  });
}

/**
 * At an approver's decision on the amendment: prove the carried rows against each plan as it is now (refused,
 * with nothing recorded, when they no longer fit), then record the rows this person signs, beside their decision.
 */
export async function recordCarriedRows(root, config, workflow, proposal, decision, { signing, specification, candidate, actor, agent, at }) {
  const others = (await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow)).indexes
    .filter((index) => index.phase !== specification.id).flatMap((index) => index.clauses ?? []);
  const amendedClauseIds = [...others, ...extractClauses(candidate.proposedText, { sourcePath: candidate.specificationPath })]
    .map((clause) => upper(clause.id));
  const readiness = await amendmentPlanReadiness(root, config, workflow, proposal, amendedClauseIds);
  if (readiness.stale.length || readiness.uncovered.length) throw stalePlanCorrectionRefusal(workflow, proposal, readiness);
  const records = [];
  for (const { carried, authority } of signing) {
    const record = amendmentPlanCorrection(workflow, { carried, reason: amendmentReason(proposal.id, proposal.reason),
      actor, authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null, at, intentAmendment: proposal.id });
    workflow.planAmendments = [...(workflow.planAmendments ?? []), record];
    records.push(record);
    workflow.history.push({ at, actor, agent, event: 'plan_amended', phase: workflow.currentPhase ?? null,
      detail: `${record.id} carries ${proposal.id}'s rows for ${record.ownerPhase}: ${record.operations.map((operation) => `${operation.op} ${operation.clauseId}`).join('; ')}; in force once ${proposal.id} is approved.` });
  }
  if (records.length) decision.planCorrections = records.map((entry) => entry.id);
  return records;
}
