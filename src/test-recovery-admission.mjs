/** Exact pre-feature failure review. No serialized value substitutes for host evidence or live consent. */
import { captureTerminalActionAuthorization } from './action-authorization.mjs';
import { requireApprovalAuthority } from './approval-authority.mjs';
import { exactFileAtObject, exactRemoteBranchObservationAsync, head, identity } from './git.mjs';
import path from 'node:path';
import { canonicalJson } from './records.mjs';
import { storyTestRiskAuthorityContext } from './story-test-risk.mjs';
import { sealTrpRecord, trpDigest, trpEnvironmentDigest, trpIssueIdentity } from './test-recovery-policy.mjs';
import { appendTrpAuthorityReceipt, appendTrpRecord, consumeTrpAuthority, loadTrpAuthorityVerifier,
  loadTrpRecords, trpAuthorityReview } from './test-recovery-store.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';

const fail = (message, code = 'TRP_INTAKE_BASELINE_INVALID') => { throw new SingularityFlowError(message, { code }); };
const TRANSITIONS = ['generation-admission', 'publish', 'submit', 'approve', 'downstream', 'replay'];

/** Pure record construction grants no authority; the caller must separately consume a live review. */
export function buildBaselineRiskDecision(agreement, baseline, { authority, choices, principal, planDigest,
  createdAt = nowIso(), transitions = TRANSITIONS, validationEpoch = 1 } = {}) {
  const suffix = trpDigest({ baseline: baseline.recordSha256, agreement: agreement.recordSha256, principal, createdAt }).slice(7, 39);
  const compatible = baseline.dependencies.find(entry => entry.id === 'baseline-compatibility');
  return sealTrpRecord({ schemaVersion: 1, kind: 'phase-risk-decision', id: `baseline-risk-${suffix}`,
    subject: { ...baseline.subject, generation: 0, validationEpoch }, createdAt,
    issuer: { principal, channel: 'terminal-intake' },
    provenance: { authorityRef: authority.policy.authoritySha256, evidenceRefs: [agreement.recordSha256, baseline.recordSha256] },
    agreementSha256: agreement.recordSha256, policyAuthoritySha256: authority.policy.authoritySha256,
    issueId: trpIssueIdentity({ category: 'known-test-failure', obligationId: baseline.obligationId,
      message: 'Required check failed', observation: baseline }).id,
    category: 'known-test-failure', severity: 'noncritical', anchorObservationDigest: baseline.recordSha256,
    obligationId: baseline.obligationId, transitions,
    authorityRef: authority.policy.authoritySha256, authorizationRef: `baseline-review-${suffix}`,
    confirmationSha256: planDigest, reason: choices.reason.trim(), expiresAt: choices.expiresAt,
    followUpOwner: choices.followUpOwner.trim(), remediationRef: choices.remediationRef.trim(),
    applicability: { carryForward: true, phaseIds: [baseline.subject.phaseId],
      dependencies: compatible ? [compatible] : baseline.dependencies,
      environmentSha256: trpEnvironmentDigest(baseline.environment), baselineSha256: baseline.recordSha256,
      acceptedFailures: baseline.cases.filter(entry => entry.outcome === 'failed').map(entry => ({
        testId: entry.id, semanticsSha256: entry.semanticsSha256, causeSha256: entry.causeSha256 })),
      allowedTestIds: baseline.expectedTestIds, excludedTestIds: [], maxFailed: baseline.counts.failed,
      commandSha256: baseline.commandSha256, selectorSha256: baseline.selectorSha256,
      maxObservationAgeSeconds: authority.policy.maxEvidenceAgeSeconds }
  });
}

/** Review occurs before creation writes; opaque witnesses are consumed only by the append-only store. */
export async function authorizeTrpIntake(root, workflow, agreement, preview) {
  if (preview.choices.baselineDisposition !== 'accept-known-failures') return null;
  const authority = storyTestRiskAuthorityContext(workflow, agreement);
  const actor = identity(root);
  requireApprovalAuthority(authority.pinnedAuthorities, { authorities: authority.delegation.authorities }, actor);
  const principal = String(actor.email ?? actor.login ?? '').trim().toLowerCase();
  if (!principal) fail('An identified delegated baseline reviewer is required.', 'TRP_AUTHORITY_REQUIRED');
  const baselines = preview.repositories.flatMap(repo => repo.baselineRecords ?? []);
  if (!baselines.length) fail('No authenticated baseline was bound to this intake.');
  const records = [agreement];
  for (const baseline of baselines) {
    records.push(buildBaselineRiskDecision(agreement, baseline, { authority, choices: preview.choices,
      principal, planDigest: preview.planDigest }));
  }
  const witnesses = [];
  for (const record of records) {
    const review = trpAuthorityReview(record, authority.policy);
    const authorization = await captureTerminalActionAuthorization(root, review.plan, review.action, {
      label: record.kind === 'story-test-recovery-agreement' ? 'Authorize Story test agreement' : 'Accept known baseline failures'
    });
    if (!authorization) fail('Baseline acceptance was cancelled. No Story was created.', 'TRP_INTAKE_REVIEW_CANCELLED');
    witnesses.push(await consumeTrpAuthority(root, { record, ...authority, review, token: authorization.token }));
  }
  return { records, witnesses, baselineRefs: baselines.map(record => record.recordSha256) };
}

export async function materializeTrpIntake(root, config, workflow, review) {
  if (!review) return;
  const { workDir } = await import('./state.mjs');
  const { materializeTrpIntakeBaseline } = await import('./test-recovery-runtime.mjs');
  const workRoot = workDir(root, config, workflow.workItem.id);
  for (const recordSha256 of review.baselineRefs) await materializeTrpIntakeBaseline(root, config, workflow, { recordSha256 });
  for (let index = 0; index < review.records.length; index++) {
    await appendTrpRecord(workRoot, review.records[index]);
    await appendTrpAuthorityReceipt(workRoot, review.witnesses[index]);
  }
}

/** Every feature entry independently checks the immutable baseline, current host, delegation and Git durability. */
export async function qualifiedTrpIntakeDecisions(root, config, workflow, agreement, phase) {
  const required = agreement.repositories.filter(repo => repo.baselineDisposition === 'accept-known-failures');
  if (!required.length) return { verifiedDecisions: [], verifyDecision: () => false };
  const { storyPublicationPending, workflowPublicationBranch, workDir } = await import('./state.mjs');
  const { inspectTrpIntakeBaseline } = await import('./test-recovery-runtime.mjs');
  if (await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false })) fail('Baseline risk publication must be acknowledged before feature admission.', 'TRP_PUBLICATION_PENDING');
  const workRoot = workDir(root, config, workflow.workItem.id);
  const authority = storyTestRiskAuthorityContext(workflow, agreement);
  const localOnly = config.git?.publish === 'off' && workflow.resolution?.capability?.policy?.gitPublication !== 'required';
  const remote = localOnly ? null : await exactRemoteBranchObservationAsync(root, config.git?.remote ?? 'origin', workflowPublicationBranch(root, workflow));
  const records = await loadTrpRecords(workRoot);
  const verifyAuthority = await loadTrpAuthorityVerifier({ root, workRoot, ...authority, localCommit: head(root),
    localOnly, remoteAcknowledgedCommit: remote?.sha ?? remote?.commit ?? null, records });
  const at = nowIso();
  const agreementReceipt = verifyAuthority(agreement, { policy: authority.policy });
  if (!agreementReceipt || agreementReceipt.revokedAt && Date.parse(agreementReceipt.revokedAt) <= Date.parse(at)) fail('The initial agreement needs its delegated durable authority receipt.', 'TRP_AUTHORITY_REQUIRED');
  const baselines = new Map();
  for (const repo of required) {
    const row = workflow.resolution.testRecoveryInitialReadiness.repositories.find(entry => entry.repositoryId === repo.repositoryId);
    for (const recordSha256 of repo.baselineRefs) {
      const retained = records.find(record => record.recordSha256 === recordSha256 && record.kind === 'test-baseline-manifest');
      if (!retained || retained.subject.phaseId !== phase.id) continue;
      const relative = path.relative(root, path.join(workRoot, 'context/test-recovery/baselines', `${retained.id}.json`)).split(path.sep).join('/');
      const committed = exactFileAtObject(root, head(root), relative, { maximumBytes: 4 * 1024 * 1024 });
      if (!committed || committed.toString('utf8') !== canonicalJson(retained)) continue;
      const inspected = await inspectTrpIntakeBaseline(root, { recordSha256, workId: workflow.workItem.id,
        repositoryId: repo.repositoryId, baseCommit: row?.baseCommit, phaseId: phase.id,
        acceptedWorkflow: workflow,
        definition: { ...config, testRecovery: workflow.resolution.testRecovery, approvalAuthorities: workflow.resolution.approvalAuthorities,
          phases: Object.fromEntries(workflow.resolution.phases.map(entry => [entry.id, entry])) } });
      if (inspected?.authenticated === true && canonicalJson(inspected.record) === canonicalJson(retained)) baselines.set(recordSha256, retained);
    }
  }
  const verifiedDecisions = records.filter(record => {
    if (record.kind !== 'phase-risk-decision' || record.category !== 'known-test-failure'
      || record.agreementSha256 !== agreement.recordSha256 || record.subject.workId !== workflow.workItem.id
      || record.subject.phaseId !== phase.id || record.subject.validationEpoch !== (workflow.testRecovery.validationEpoch ?? 1)
      || !record.applicability.phaseIds.includes(phase.id) || !record.transitions.includes('generation-admission')
      || Date.parse(record.createdAt) > Date.parse(at) || Date.parse(record.expiresAt) <= Date.parse(at)
      || Date.parse(record.expiresAt) - Date.parse(record.createdAt) > authority.policy.maxRiskDays * 86400000) return false;
    const baseline = baselines.get(record.applicability.baselineSha256);
    const repo = required.find(entry => entry.repositoryId === record.subject.repositoryId);
    if (!baseline || !repo?.baselineRefs.includes(baseline.recordSha256) || record.anchorObservationDigest !== baseline.recordSha256
      || record.obligationId !== baseline.obligationId || record.applicability.commandSha256 !== baseline.commandSha256
      || record.applicability.selectorSha256 !== baseline.selectorSha256
      || record.applicability.environmentSha256 !== trpEnvironmentDigest(baseline.environment)
      || record.applicability.maxFailed !== baseline.counts.failed
      || canonicalJson(record.applicability.acceptedFailures.map(entry => ({ id: entry.testId, semanticsSha256: entry.semanticsSha256, causeSha256: entry.causeSha256 })).sort((a,b) => a.id.localeCompare(b.id)))
        !== canonicalJson(baseline.cases.filter(entry => entry.outcome === 'failed').map(({ id, semanticsSha256, causeSha256 }) => ({ id, semanticsSha256, causeSha256 })).sort((a,b) => a.id.localeCompare(b.id)))) return false;
    const receipt = verifyAuthority(record, { policy: authority.policy });
    return receipt?.capability === 'trp-risk-decision' && receipt.principal === record.issuer.principal
      && receipt.transitions.includes('generation-admission') && receipt.confirmationSha256 === record.confirmationSha256
      && receipt.authorizationRef === record.authorizationRef && Date.parse(receipt.issuedAt) <= Date.parse(at)
      && (!receipt.revokedAt || Date.parse(receipt.revokedAt) > Date.parse(at));
  });
  const accepted = new Set(verifiedDecisions.map(record => record.recordSha256));
  return { verifiedDecisions, verifyDecision: record => accepted.has(record.recordSha256) };
}

/** Existing tests may be proposed, never reported as changed/new or as a current passing execution. */
export async function qualifiedTrpBaselineTestPaths(root, config, workflow, phase) {
  if (Number(phase.generation ?? 0) > 0 || workflow.resolution?.testRecovery?.enabled !== true) return [];
  const { loadStoryTestRecoveryAgreement } = await import('./state.mjs');
  const agreement = await loadStoryTestRecoveryAgreement(root, config, workflow);
  if (!agreement?.repositories.some(repo => repo.baselineDisposition === 'accept-known-failures')) return [];
  const { verifiedDecisions } = await qualifiedTrpIntakeDecisions(root, config, workflow, agreement, phase);
  const paths = [];
  for (const decision of verifiedDecisions) {
    const inventory = workflow.resolution.testRecovery.caseInventory?.find(entry =>
      entry.phaseId === phase.id && entry.commandId === decision.obligationId);
    for (const entry of inventory?.tests ?? []) if (decision.applicability.allowedTestIds.includes(entry.id)) paths.push(entry.path);
  }
  return [...new Set(paths)].sort();
}
