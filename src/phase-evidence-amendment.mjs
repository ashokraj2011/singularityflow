/** One reviewed evidence-contract correction path for built-in and future workflow steps. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { branch, head, identity, exactFileAtObject } from './git.mjs';
import { recordSha256, canonicalJson } from './records.mjs';
import { readBoundSpecificationClaimMap } from './specifications.mjs';
import { EvidenceAmendmentSchema, evidenceCorrectionProjection, evidenceOwnerAuthorities } from './plan-evidence-amendments.mjs';
import { requiresProspectivePhaseInspection, phaseInspectionGeneration } from './code-submission-evidence.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { verifyOpenGenerationIntent } from './generation-boundary.mjs';
import { readRepositoryManifest, resolveRepositoryManifest } from './repository-manifest.mjs';
import { worktreeFingerprint, assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import { requireApprovalAuthority } from './approval-authority.mjs';
import { captureTerminalActionAuthorization } from './action-authorization.mjs';
import { consumeAndRetainHumanReview } from './human-review-origin.mjs';
import { assertNoPendingPublication, actorKey, transactStory } from './state-stores.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { nowIso, secureRepositoryPath, writeText, SingularityFlowError } from './util.mjs';

const digest = value => `sha256:${recordSha256(value)}`;
const fail = (message, code = 'PLAN_EVIDENCE_CORRECTION_INVALID', details = {}) => {
  throw new SingularityFlowError(message, { code, details });
};
const itemRoot = (config, workflow) => `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}`;

export function correctionOwner(workflow, phase) {
  const ownerId = workflow.resolution?.plannedClaims?.owners?.[phase.id];
  const owner = workflow.phases?.[ownerId];
  const order = workflow.phaseOrder ?? [];
  return owner?.status === 'approved' && owner.generation > 0
    && order.indexOf(ownerId) >= 0 && order.indexOf(ownerId) < order.indexOf(phase.id) ? owner : null;
}

async function readOwnedPlan(root, config, workflow, phase) {
  const owner = correctionOwner(workflow, phase);
  if (!owner) fail('No preceding approved plan owns this phase. Use its planning author or workflow owner; no mapping is inferred.');
  return { owner, record: await readBoundSpecificationClaimMap(root, path.join(root, itemRoot(config, workflow)), workflow, owner, 'planned', {
    policy: workflow.resolution?.spec ?? config.spec ?? {}, requireCommitted: true
  }) };
}

export async function assertApprovedDocumentsIntact(root, config, workflow, phase) {
  const revision = head(root);
  const prefix = `${itemRoot(config, workflow)}/`;
  for (const id of workflow.phaseOrder.slice(0, workflow.phaseOrder.indexOf(phase.id))) {
    const previous = workflow.phases[id];
    if (previous.status !== 'approved') continue;
    // Source files may legitimately change in a successor. Only the approved governed
    // documents are immutable; a correction must never hide tampering with those inputs.
    for (const artifact of previous.artifacts ?? []) {
      if (!artifact.path.startsWith(prefix)) continue;
      const committed = exactFileAtObject(root, revision, artifact.path, { regularOnly: true, maximumBytes: 16 * 1024 * 1024 });
      const current = await readRepositoryManifest(root, artifact.path, { maxBytes: 16 * 1024 * 1024 });
      if (!committed || current.links?.length || !current.bytes.equals(committed)
          || current.bytes.length !== artifact.size
          || createHash('sha256').update(current.bytes).digest('hex') !== String(artifact.sha256).replace(/^sha256:/u, '')) {
        fail(`Approved input ${artifact.path} changed. Restore reviewed bytes or use its original authority.`, 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY');
      }
    }
  }
}

/** Read-only exact preview; no tests, source edits, commits, or automatic acceptance. */
export async function prepareEvidenceContractCorrection(root, config, workflow, {
  phaseId = workflow.currentPhase, clauseId, evidencePath, method = 'visual', reason
} = {}) {
  const phase = workflow.phases?.[phaseId];
  if (!phase || phase.id !== workflow.currentPhase || workflow.status !== 'in_progress'
      || !requiresProspectivePhaseInspection(workflow, phase) || branch(root) !== workflow.workItem.branch) {
    fail('Evidence typing is corrected only in the current unpublished draft. Preserve published/submitted work and use its successor or authorized return.', 'PLAN_EVIDENCE_CORRECTION_LIFECYCLE');
  }
  if (phaseRequiresCodeDelivery(phase)) await verifyOpenGenerationIntent(root, workflow, phase);
  await assertApprovedDocumentsIntact(root, config, workflow, phase);
  if (typeof reason !== 'string' || reason.trim().length < 20 || reason.trim().length > 1000
      || /[\x00-\x1f\x7f]/u.test(reason)) fail('Explain the evidence classification correction in 20–1000 characters.');
  clauseId = String(clauseId ?? '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u.test(clauseId) || !['visual', 'inspection'].includes(method)) {
    fail('Choose one exact approved acceptance criterion and visual or inspection.');
  }
  const prefix = `${itemRoot(config, workflow)}/evidence/`;
  if (typeof evidencePath !== 'string' || !evidencePath.startsWith(prefix)) fail('The exact retained file must belong to this Story\'s evidence directory.');
  const pathSchema = EvidenceAmendmentSchema.shape.path;
  if (!pathSchema.safeParse(evidencePath).success) fail('Use one exact portable evidence-file path; no traversal, links, or wildcards.');
  assertNoHiddenWorktreeChanges(root, 'Evidence correction');
  const guards = [...(config.governance?.protectedPaths ?? []), ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])];
  if (guards.some(guard => evidencePath.toLowerCase() === String(guard).toLowerCase()
      || evidencePath.toLowerCase().startsWith(`${String(guard).replace(/\/$/u, '').toLowerCase()}/`))) {
    fail('Protected evidence needs its original authority; this correction cannot account for it.', 'PLAN_EVIDENCE_CORRECTION_PROTECTED');
  }
  const resolved = await resolveRepositoryManifest(root, evidencePath);
  if (resolved.links.length) fail('Linked files or linked parents cannot become owned evidence.');
  const captured = await readRepositoryManifest(root, evidencePath, { maxBytes: 16 * 1024 * 1024 });
  const { owner, record } = await readOwnedPlan(root, config, workflow, phase);
  const claim = record.claims?.[clauseId];
  if (!claim || ((claim.steps ?? []).length && !claim.steps.includes(phase.id))) fail('The approved plan does not allocate this exact criterion to the current phase.');
  if (claim.fulfillment === 'evidence' && claim.expectedPaths?.includes(evidencePath)) fail('This file already has an evidence contract. Repair its actual witness/gate instead of repeating classification.');
  const groups = evidenceOwnerAuthorities(workflow, owner.id);
  if (!groups.length) fail('There is no pinned plan approval authority.', 'PLAN_EVIDENCE_CORRECTION_AUTHORITY');
  const proposed = evidenceCorrectionProjection(clauseId, claim, evidencePath, method);
  const core = {
    schemaVersion: 1, kind: 'evidence-contract-correction-preview', workId: workflow.workItem.id,
    phaseId: phase.id, generation: phaseInspectionGeneration(workflow, phase), intentId: phase.generationIntent?.id ?? null,
    ownerPhase: owner.id, ownerGeneration: owner.generation, ownerMapSha256: owner.claimMaps.planned.sha256,
    clauseId, previousClaimSha256: recordSha256(claim), previousClaim: claim,
    previousContract: record.verificationContracts?.find(entry => entry.clauseId === clauseId) ?? null,
    proposedClaim: proposed.claim, proposedContract: proposed.contract,
    path: evidencePath, method, reason: reason.trim(), authorityGroups: groups,
    reviewedFile: { size: captured.bytes.length, sha256: createHash('sha256').update(captured.bytes).digest('hex') },
    head: head(root), worktreeSha256: worktreeFingerprint(root, { fresh: true }).sha256,
    workflowSha256: recordSha256(workflow),
    changes: 'Replace only this criterion\'s delivery classification/path with evidence; preserve planned test files as supporting witnesses. Require an exact source-bound primary visual/inspection witness.',
    testsWaived: false, phaseApproved: false, priorPublicationsChanged: false
  };
  const packetSha256 = digest(core);
  const preview = { ...core, packetSha256 };
  const guidance = safeCommandGuidance({ executable: 'singularity-flow', argv: ['appeal', 'evidence-accept',
    '--phase', phase.id, '--clause', clauseId, '--path', evidencePath, '--method', method,
    '--reason', core.reason, '--confirm', packetSha256, '--json'] });
  return { ...preview, acceptance: guidance, copilotCommand: guidance?.copilotCommand ?? null,
    humanReview: { required: true, surface: 'human-terminal', execution: 'human-relay-only',
      confirmationText: `Correct evidence PEA-${packetSha256.slice(7, 31)}` },
    reviewRequired: 'An authorized human must inspect the exact file and the before/after contract. This classifies delivery; it does not attest that the screen satisfies the criterion.' };
}

export async function acceptEvidenceContractCorrection(root, config, workflow, options = {}) {
  await assertNoPendingPublication(root, config, workflow, 'correct an evidence contract');
  const preview = await prepareEvidenceContractCorrection(root, config, workflow, options);
  if (options.confirm !== preview.packetSha256) fail('Review and confirm a fresh exact evidence correction packet.', 'PLAN_EVIDENCE_CORRECTION_STALE', { packetSha256: preview.packetSha256 });
  const actor = identity(root);
  const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: preview.authorityGroups, requiredAuthorities: [], minimum: 1 }, actor);
  const id = `PEA-${preview.packetSha256.slice(7, 31)}`;
  const card = { plan: { planId: id, planHash: digest({ preview, actor, authority }),
    subject: { workId: workflow.workItem.id, phaseId: preview.phaseId }, revision: preview.head, preview,
    testsWaived: false, phaseApproved: false }, action: { actionId: id, confirmation: { required: true } } };
  const grant = await captureTerminalActionAuthorization(root, card.plan, card.action, { label: `Correct evidence ${id}` });
  if (!grant) return { status: 'cancelled', stateChanged: false };
  const recordPath = `${itemRoot(config, workflow)}/appeals/evidence/${id}.json`;
  const { value: decision, publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: preview.phaseId, generation: preview.generation,
    actor, agent: null, authorityGroup: authority.authorityGroup,
    payload: { decision: 'evidence-contract-correction', packetSha256: preview.packetSha256 }
  }, `[${workflow.workItem.id}][evidence-contract] ${preview.clauseId}`, async aggregate => {
    const fresh = await prepareEvidenceContractCorrection(root, config, aggregate, options);
    if (fresh.packetSha256 !== preview.packetSha256) fail('Evidence, plan, policy or worktree changed during review. Nothing was adopted.', 'PLAN_EVIDENCE_CORRECTION_STALE');
    const record = EvidenceAmendmentSchema.parse({ id, kind: 'evidence-contract-correction',
      ownerPhase: preview.ownerPhase, ownerGeneration: preview.ownerGeneration, ownerMapSha256: preview.ownerMapSha256,
      clauseId: preview.clauseId, previousClaimSha256: preview.previousClaimSha256, path: preview.path,
      method: preview.method, reason: preview.reason, reviewedFile: preview.reviewedFile,
      actor: actorKey(actor), authorityGroup: authority.authorityGroup, authorizationId: grant.authorizationId,
      reviewAssurance: 'live-terminal-exact-evidence-review',
      at: nowIso(), recordPath, testsWaived: false, phaseApproved: false });
    const secured = await secureRepositoryPath(root, recordPath, { type: 'file', label: 'Evidence correction decision' });
    if (secured.exists) fail('This exact decision already exists. Inspect it; never overwrite it.');
    await consumeAndRetainHumanReview(root, record, card, grant.token);
    await writeText(secured.absolute, canonicalJson(record));
    aggregate.planAmendments ??= []; aggregate.planAmendments.push(record);
    aggregate.history.push({ at: record.at, actor: record.actor, agent: null,
      event: 'evidence_contract_corrected', phase: preview.phaseId, detail: `${id}: ${preview.clauseId}` });
    return record;
  }, { exactWorkItemPaths: [recordPath] });
  const commandGuidance = safeCommandGuidance({ command: `singularity-flow recover ${workflow.workItem.id} --phase ${preview.phaseId} --json` });
  return { status: 'evidence-contract-corrected', stateChanged: true, decision, publication,
    next: { command: commandGuidance.command, commandGuidance, copilotCommand: commandGuidance.copilotCommand },
    testsWaived: false, phaseApproved: false };
}

/** Preview route for exact unknown evidence, never a directory exemption or a decision. */
export async function evidenceContractRecoveryActions(root, config, workflow, phase, worktree) {
  if (!phase || !correctionOwner(workflow, phase) || !requiresProspectivePhaseInspection(workflow, phase)) return [];
  const prefix = `${itemRoot(config, workflow)}/evidence/`;
  const paths = (worktree.unexpectedPaths ?? []).filter(candidate => candidate.startsWith(prefix));
  if (!paths.length) return [];
  let record;
  try { ({ record } = await readOwnedPlan(root, config, workflow, phase)); } catch { return []; }
  const clauses = Object.keys(record.claims ?? {}).filter(id => /:AC-\d{3}$/u.test(id)
    && (!(record.claims[id].steps ?? []).length || record.claims[id].steps.includes(phase.id)));
  return paths.map(evidencePath => ({ id: `review-evidence-contract:${phase.id}:${evidencePath}`,
    safe: false, automatic: false, mode: 'guided', confirmation: 'human-authority', skill: '/sf-appeal',
    command: safeCommandGuidance({ executable: 'singularity-flow', argv: ['appeal', 'evidence-prepare',
      '--phase', phase.id, '--path', evidencePath, '--clause', '<CLAUSE-ID>', '--method', 'visual', '--reason', '<reason>', '--json'] })?.command ?? null,
    evidence: { path: evidencePath, eligibleClauseIds: clauses },
    detail: 'Preserve and inspect this exact file. If the approved plan misclassified a screenshot/inspection obligation, preview its evidence-contract correction and have the plan authority review it. No automatic adoption, passing visual evidence, test waiver or phase approval.' }));
}
