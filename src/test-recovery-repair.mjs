/**
 * Readiness-repair admission and checkpoint assessment. No state, Git or receipt writes occur here.
 * The caller loads the agreement and readiness evidence through the governed read boundary, then
 * commits a successful assessment in its normal Story transaction. A hash is not authentication.
 */
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { buildRepositoryReadinessPlan } from './initialization/runtime-readiness.mjs';
import { trpDigest, validateTrpRecord } from './test-recovery-policy.mjs';
import { SingularityFlowError } from './util.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

function repositoryRows(readiness) {
  const rows = readiness?.repositories;
  if (Array.isArray(rows)) return rows.map(row => ({ ...row, repositoryId: row.repositoryId ?? row.repository }));
  if (rows && typeof rows === 'object') return Object.entries(rows).map(([repositoryId, row]) => ({ ...row, repositoryId }));
  return [];
}

function requiredAgreementRepositories(agreement, requested) {
  validateTrpRecord(agreement, { kind: 'story-test-recovery-agreement' });
  const required = agreement.repositories.filter(repository => repository.required && repository.codeBearing
    && repository.execution.mode !== 'not-applicable');
  if (new Set(required.map(repository => repository.repositoryId)).size !== required.length) {
    fail('The agreement repeats a required repository.', 'TRP_READINESS_REPOSITORY_INVALID');
  }
  if (requested !== undefined) {
    if (!Array.isArray(requested) || requested.some(id => typeof id !== 'string')
      || new Set(requested).size !== requested.length
      || required.length !== requested.length
      || required.some(repository => !requested.includes(repository.repositoryId))) {
      fail('Readiness repair must cover every required code-bearing repository in the agreement.', 'TRP_READINESS_REPOSITORY_INVALID');
    }
  }
  return required;
}

function repairAction(workId, repositoryId) {
  return {
    id: `readiness-repair:${repositoryId}`, owner: 'story-owner', mode: 'guided',
    label: 'Review the bounded readiness repair and exact validation plan',
    command: 'story', args: ['test-policy', 'repair', '--work-id', workId, '--json']
  };
}

/**
 * Initial pass evidence permits feature admission only. It never becomes a passing observation
 * for publish, submit or approval. verifyDecision is a trusted runtime callback, never a field
 * loaded from workflow JSON; it must check current authority, durability, applicability and expiry.
 */
export function assertTrpFeatureAdmission(workflow, phase, {
  agreement, verifiedDecisions = [], verifyDecision
} = {}) {
  const pin = workflow?.testRecovery;
  if (!pin?.agreementPath && !pin?.agreementSha256) return { enabled: false, featureCodingAllowed: true };
  const currentPhase = typeof phase === 'string' ? workflow.phases?.[phase] : phase;
  if (!currentPhase) fail('Resolve the current phase before feature admission.', 'TRP_READINESS_PHASE_INVALID');
  if (!phaseRequiresCodeDelivery(currentPhase)) return { enabled: true, featureCodingAllowed: true, applicable: false };
  if (!agreement || agreement.recordSha256 !== pin.agreementSha256) {
    fail('Load the exact governed Test and Recovery Agreement before feature admission.', 'TRP_AGREEMENT_REQUIRED');
  }
  const required = requiredAgreementRepositories(agreement);
  const workId = workflow.workItem?.id ?? workflow.workId ?? workflow.id;
  if (workId && workId !== agreement.subject.workId) {
    fail('The agreement belongs to another Story.', 'TRP_AGREEMENT_REQUIRED');
  }
  const rows = repositoryRows(pin.readiness);
  const phaseId = typeof phase === 'string' ? phase : phase?.id ?? workflow.currentPhase;
  const blockers = [];
  const pending = [];
  for (const repository of required) {
    const matching = rows.filter(row => row.repositoryId === repository.repositoryId);
    const row = matching.length === 1 ? matching[0] : null;
    // This is a pinned intake disposition, never a pass or a failure-risk decision. The runtime
    // caller verifies these initial rows against the immutable Story snapshot before admission.
    if (row?.testConfigurationPending === true && COMMIT.test(row.baseCommit ?? '')
        && ['unknown', 'missing', 'stale', 'not-checked', 'no-commands-applicable'].includes(row.status)
        && !row.baselineSha256
        && repository.baselineDisposition === 'fix' && !repository.baselineRefs.length) {
      pending.push(repository.repositoryId);
      continue;
    }
    if (row?.status === 'pass' && COMMIT.test(row.baseCommit ?? '') && SHA256.test(row.receiptSha256 ?? '')) continue;
    const accepted = matching.length <= 1 && typeof verifyDecision === 'function' && verifiedDecisions.some(decision => {
      try {
        validateTrpRecord(decision, { kind: 'phase-risk-decision' });
        return decision.agreementSha256 === agreement.recordSha256
          && decision.subject.workId === agreement.subject.workId
          && decision.subject.repositoryId === repository.repositoryId
          && decision.transitions.includes('generation-admission')
          && (decision.category !== 'known-test-failure' || ['failed', 'failing', 'failing-tests'].includes(row?.status))
          && verifyDecision(decision, { agreement, repository, phaseId, operation: 'generation-admission', readiness: row }) === true;
      } catch { return false; }
    });
    if (accepted) continue;
    blockers.push({
      id: `readiness:${repository.repositoryId}`, category: 'baseline-readiness',
      repositoryId: repository.repositoryId, observedOutcome: row?.status ?? 'unknown',
      disposition: 'repair-required', owner: 'story-owner',
      message: 'Feature coding waits for this repository’s baseline repair or a verified applicable decision.',
      preserved: ['original baseline', 'Story documents', 'published generations', 'approval history'],
      nextAction: repairAction(agreement.subject.workId, repository.repositoryId)
    });
  }
  if (blockers.length) fail('Complete readiness repair in every required repository before feature coding.',
    'TRP_FEATURE_ADMISSION_BLOCKED', { workId: agreement.subject.workId, phaseId,
      agreementSha256: agreement.recordSha256, blockers, supportedNextActions: blockers.map(blocker => blocker.nextAction) });
  return { enabled: true, applicable: true, featureCodingAllowed: true, evidencePurpose: 'baseline-admission-only',
    ...(pending.length ? { testConfigurationPending: pending, testEvidence: 'not-verified' } : {}),
    agreementSha256: agreement.recordSha256, repositories: required.map(repository => repository.repositoryId) };
}

function commitFor(value, repositoryId, label) {
  const commit = typeof value === 'string' ? value : value?.[repositoryId];
  if (!COMMIT.test(commit ?? '')) fail(`A resolved ${label} commit is required for '${repositoryId}'.`, 'TRP_REPAIR_CHECKPOINT_INVALID');
  return commit;
}

/** Assess a loaded, authenticated receipt; content validity cannot replace caller authentication. */
function assertPassingReceipt(receipt, commit, repositoryId) {
  const { receiptSha256, ...core } = receipt ?? {};
  const commands = receipt?.structuredTestContract?.commands;
  const results = receipt?.commandResults;
  const observations = receipt?.testObservations;
  const refused = () => fail(`Repository '${repositoryId}' has no complete passing readiness receipt for the repair checkpoint.`,
    'TRP_REPAIR_EVIDENCE_INVALID', { repositoryId, repairCommit: commit });
  if (receipt?.kind !== 'repository-readiness-receipt' || receipt.status !== 'pass'
    || receipt.sourceTrackedOnly !== true || receipt.sourceCommit !== commit
    || !SHA256.test(receiptSha256 ?? '') || trpDigest(core) !== receiptSha256
    || !SHA256.test(receipt.sourceManifestSha256 ?? '') || !SHA256.test(receipt.planId ?? '')
    || !Array.isArray(commands) || !commands.length || !Array.isArray(results) || !Array.isArray(observations)
    || results.some(result => result.status !== 'pass')
    || results.filter(result => result.purpose === 'test').length !== commands.length
    || observations.length !== commands.length
    || new Set(commands.map(command => command.id)).size !== commands.length) refused();
  for (const command of commands) {
    const matchingResults = results.filter(result => result.purpose === 'test' && result.id === command.id);
    const matchingObservations = observations.filter(observation => observation.commandId === command.id);
    if (matchingResults.length !== 1 || matchingResults[0].exitCode !== 0 || matchingObservations.length !== 1) refused();
    const observation = matchingObservations[0];
    const counts = observation.counts;
    if (observation.status !== 'available' || observation.adapter !== command.adapter
      || !SHA256.test(observation.report?.sha256 ?? '')
      || !['discovered', 'passed', 'failed', 'skipped'].every(key => Number.isSafeInteger(counts?.[key]) && counts[key] >= 0)
      || counts.discovered < Math.max(1, command.minimumDiscovered ?? 1) || counts.passed < 1
      || counts.failed !== 0 || counts.passed + counts.skipped !== counts.discovered) refused();
  }
}

/**
 * Return the checkpoint to commit with the Story. This does not edit the agreement or turn a
 * failed original baseline green. Source may be unchanged after a verified runtime-only repair.
 */
export function completeTrpReadinessRepair({ agreement, currentReadiness, baseCommit, repairCommit,
  requiredRepositories, originalReadiness = null } = {}) {
  const required = requiredAgreementRepositories(agreement, requiredRepositories);
  const rows = repositoryRows(currentReadiness);
  const originals = repositoryRows(originalReadiness);
  const repositories = required.map(repository => {
    const matches = rows.filter(row => row.repositoryId === repository.repositoryId);
    if (matches.length !== 1) fail(`Readiness repair requires exactly one receipt for '${repository.repositoryId}'.`, 'TRP_REPAIR_EVIDENCE_INVALID');
    const row = matches[0];
    const receipt = row.receipt ?? row;
    // A map adds its repository key for lookup; it is not part of the original receipt digest.
    const { repositoryId: ignoredRepositoryId, repository: ignoredRepository, ...receiptFields } = receipt;
    const checkpoint = commitFor(repairCommit, repository.repositoryId, 'repair');
    const originalBase = commitFor(baseCommit, repository.repositoryId, 'original base');
    assertPassingReceipt(receiptFields, checkpoint, repository.repositoryId);
    const prior = originals.find(original => original.repositoryId === repository.repositoryId);
    const originalBaselineRefs = [...new Set([...repository.baselineRefs,
      ...(SHA256.test(prior?.receiptSha256 ?? '') ? [prior.receiptSha256] : []),
      ...(SHA256.test(prior?.baselineSha256 ?? '') ? [prior.baselineSha256] : [])])];
    return { repositoryId: repository.repositoryId, status: 'pass', baseCommit: checkpoint,
      originalBaseCommit: originalBase, featureBaseCommit: checkpoint,
      receiptSha256: receiptFields.receiptSha256, sourceManifestSha256: receiptFields.sourceManifestSha256,
      planId: receiptFields.planId, platform: receiptFields.platform, arch: receiptFields.arch,
      originalBaselineRefs, repairedBaselineRefs: [receiptFields.receiptSha256] };
  });
  const core = { schemaVersion: 1, agreementSha256: agreement.recordSha256,
    evidencePurpose: 'baseline-admission-only', repositories };
  return freeze({ ...core, checkpointSha256: trpDigest(core) });
}

/**
 * Read-only plan for the existing exact-confirmation runner. The caller invokes
 * executeRepositoryReadinessPlan only after review; the runner owns local evidence persistence,
 * and the caller owns the subsequent Story commit. Opening this plan installs/runs nothing.
 */
export async function previewTrpReadinessRepair(root, { agreement, repositoryId, baseCommit,
  repairCommit, scope = 'dependency-test', buildPlan = buildRepositoryReadinessPlan, planOptions = {}
} = {}) {
  const required = requiredAgreementRepositories(agreement);
  if (!ID.test(repositoryId ?? '') || !required.some(repository => repository.repositoryId === repositoryId)) {
    fail('Select a required code-bearing repository in this agreement.', 'TRP_READINESS_REPOSITORY_INVALID');
  }
  if (scope !== 'dependency-test') fail('This repair pilot supports dependency/test readiness only; full execution requires a separate reviewed route.', 'TRP_REPAIR_SCOPE_UNAVAILABLE');
  const originalBase = commitFor(baseCommit, repositoryId, 'original base');
  const checkpoint = commitFor(repairCommit, repositoryId, 'repair');
  const plan = await buildPlan(root, { ...planOptions, scope });
  if (plan.sourceCommit !== checkpoint || !SHA256.test(plan.planId ?? '')) {
    fail('The readiness plan no longer matches the reviewed repair checkpoint.', 'TRP_REPAIR_CHECKPOINT_STALE');
  }
  return freeze({ schemaVersion: 1, workId: agreement.subject.workId, repositoryId,
    agreementSha256: agreement.recordSha256, originalBaseCommit: originalBase,
    repairCommit: checkpoint, plan, confirmation: plan.planId,
    permittedRepairScope: ['dependency-configuration', 'test-infrastructure', 'documents', 'tests'],
    featureCodingAllowed: false, requiresHumanConfirmation: true,
    execution: { function: 'executeRepositoryReadinessPlan', scope, confirmation: plan.planId },
    publication: 'Commit the complete assessment through the normal governed Story transaction.' });
}
