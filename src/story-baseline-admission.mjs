/** Re-review an existing baseline admission without reviving an expired or revoked grant. */
import path from 'node:path';
import { captureTerminalActionAuthorization } from './action-authorization.mjs';
import { requireApprovalAuthority } from './approval-authority.mjs';
import { exactFileAtObject, head, identity } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { StoryStateStore } from './state-stores.mjs';
import { storyTestRiskAuthorityContext } from './story-test-risk.mjs';
import { buildBaselineRiskDecision, qualifiedTrpIntakeDecisions } from './test-recovery-admission.mjs';
import { trpDigest } from './test-recovery-policy.mjs';
import { appendTrpAuthorityReceipt, appendTrpRecord, consumeTrpAuthority, loadTrpRecords, trpAuthorityReview } from './test-recovery-store.mjs';
import { SingularityFlowError } from './util.mjs';

const fail = (message, code = 'TRP_BASELINE_REVIEW_INVALID') => { throw new SingularityFlowError(message, { code }); };
const ref = ({ kind, id, recordSha256 }) => ({ kind, id, recordSha256 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

async function resolve(root, config, workflow, options) {
  const { loadStoryTestRecoveryAgreement, sourceTreeHash, storyPublicationPending, workDir } = await import('./state.mjs');
  const { inspectTrpIntakeBaseline } = await import('./test-recovery-runtime.mjs');
  const { verifyWorkflowSnapshot } = await import('./workflow-snapshots.mjs');
  await verifyWorkflowSnapshot(root, config, workflow, { requireAccepted: true });
  const agreement = await loadStoryTestRecoveryAgreement(root, config, workflow);
  if (!agreement) fail('This Story has no immutable test recovery agreement.');
  const phaseId = options.phaseId ?? workflow.currentPhase;
  if (!ID.test(phaseId ?? '') || !workflow.phases?.[phaseId]) fail('Select an exact Story phase.');
  const repository = options.repositoryId == null ? (agreement.repositories.length === 1 ? agreement.repositories[0] : null)
    : agreement.repositories.find(entry => entry.repositoryId === options.repositoryId);
  if (!repository || repository.baselineDisposition !== 'accept-known-failures') fail('Select a repository whose immutable intake explicitly accepted known baseline failures.');
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.recordSha256 ?? '') || !repository.baselineRefs.includes(options.recordSha256)) fail('Select an exact baseline reference in the immutable intake agreement.');
  const authority = storyTestRiskAuthorityContext(workflow, agreement);
  if (!authority.policy.enabledRiskCategories.includes('known-test-failure')) fail('The pinned policy does not delegate known-failure review.');
  const workRoot = workDir(root, config, workflow.workItem.id);
  const records = await loadTrpRecords(workRoot);
  const baseline = records.find(record => record.kind === 'test-baseline-manifest' && record.recordSha256 === options.recordSha256);
  if (!baseline || baseline.subject.phaseId !== phaseId || baseline.observedOutcome !== 'failed'
    || baseline.identityCompleteness !== 'complete' || !baseline.inventoryComplete || baseline.counts.notRun || baseline.counts.skipped) fail('A complete exact failed baseline is required for this phase.');
  const committed = exactFileAtObject(root, head(root), path.relative(root, path.join(workRoot, 'context/test-recovery/baselines', `${baseline.id}.json`)).split(path.sep).join('/'));
  if (!committed || committed.toString('utf8') !== canonicalJson(baseline)) fail('The baseline must be durably committed before it can be re-reviewed.');
  const row = workflow.resolution.testRecoveryInitialReadiness.repositories.find(entry => entry.repositoryId === repository.repositoryId);
  await inspectTrpIntakeBaseline(root, { recordSha256: baseline.recordSha256, workId: workflow.workItem.id,
    repositoryId: repository.repositoryId, baseCommit: row?.baseCommit,
    definition: { ...config, testRecovery: workflow.resolution.testRecovery, approvalAuthorities: workflow.resolution.approvalAuthorities,
      phases: Object.fromEntries(workflow.resolution.phases.map(entry => [entry.id, entry])) },
    phaseId, acceptedWorkflow: workflow });
  // Also proves agreement delegation and transport durability; absent/expired/revoked decisions are intentionally allowed here.
  await qualifiedTrpIntakeDecisions(root, config, workflow, agreement, workflow.phases[phaseId]);
  const pending = await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
  if (pending) fail('Recover the exact pending publication before reviewing baseline admission.', 'TRP_PUBLICATION_PENDING');
  const choices = { reason: options.reason ?? '', followUpOwner: options.followUpOwner ?? '', remediationRef: options.remediationRef ?? '', expiresAt: options.expiresAt ?? null };
  const blockers = [];
  for (const [key, minimum, maximum] of [['reason', 15, 2000], ['followUpOwner', 1, 2048], ['remediationRef', 1, 2048]]) {
    if (typeof choices[key] !== 'string' || choices[key].trim().length < minimum || choices[key].length > maximum || /[\x00-\x1f\x7f]/u.test(choices[key])) blockers.push(`Provide an ordinary bounded ${key}.`);
    else choices[key] = choices[key].trim();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(choices.expiresAt ?? '')
    || !Number.isFinite(Date.parse(choices.expiresAt)) || Date.parse(choices.expiresAt) <= Date.now()
    || Date.parse(choices.expiresAt) > Date.now() + authority.policy.maxRiskDays * 86400000) blockers.push('Provide a future UTC expiry within the pinned risk-duration limit.');
  const core = { kind: 'baseline-admission-review', workId: workflow.workItem.id, phaseId, repositoryId: repository.repositoryId,
    agreementSha256: agreement.recordSha256, baselineSha256: baseline.recordSha256,
    sourceManifestSha256: await sourceTreeHash(root, config, workflow),
    validationEpoch: workflow.testRecovery.validationEpoch ?? 1, choices, transitions: ['generation-admission'] };
  const planDigest = trpDigest(core);
  return { agreement, baseline, authority, choices, preview: { schemaVersion: 1, resultType: 'baseline-admission-review',
    ...core, planDigest, status: blockers.length ? 'blocked' : 'ready', ready: !blockers.length,
    blockers, observedOutcome: 'failed', baselineCreatedAt: baseline.createdAt, counts: baseline.counts,
    failedCases: baseline.cases.filter(entry => entry.outcome === 'failed'),
    stateChanged: false, executed: false, message: 'Re-review permits only feature admission. It does not rerun tests or revive any prior grant; later transitions still need their own valid decisions.' } };
}

export async function reviewStoryBaselineAdmission(root, config, workflow, options = {}) {
  const allowed = new Set(['phaseId', 'repositoryId', 'recordSha256', 'reason', 'followUpOwner', 'remediationRef', 'expiresAt', 'apply', 'confirmation']);
  if (Object.keys(options).some(key => !allowed.has(key)) || options.apply != null && typeof options.apply !== 'boolean') fail('Unsupported baseline-admission review options.');
  const initialHead = head(root);
  const context = await resolve(root, config, workflow, options);
  if (!options.apply) return context.preview;
  if (!context.preview.ready || context.preview.planDigest !== options.confirmation) fail('Review and confirm the exact current baseline-admission plan.', 'TRP_RISK_REVIEW_STALE');
  const actor = identity(root);
  requireApprovalAuthority(context.authority.pinnedAuthorities, { authorities: context.authority.delegation.authorities }, actor);
  const principal = String(actor.email ?? actor.login ?? '').trim().toLowerCase();
  if (!principal) fail('A named delegated baseline reviewer is required.', 'TRP_AUTHORITY_REQUIRED');
  const record = buildBaselineRiskDecision(context.agreement, context.baseline, { authority: context.authority,
    choices: context.choices, principal, planDigest: context.preview.planDigest, transitions: ['generation-admission'],
    validationEpoch: workflow.testRecovery.validationEpoch ?? 1 });
  const review = trpAuthorityReview(record, context.authority.policy);
  const authorization = await captureTerminalActionAuthorization(root, review.plan, review.action, { label: 'Re-review baseline admission' });
  if (!authorization) return { ...context.preview, status: 'cancelled' };
  const { workDir, storyPublicationPending } = await import('./state.mjs');
  const transaction = await new StoryStateStore(root, config).transact(workflow, {
    type: 'test-risk-accepted', phaseId: record.subject.phaseId,
    payload: { planDigest: context.preview.planDigest, record: ref(record), agreementSha256: context.agreement.recordSha256 }
  }, `Re-review exact baseline admission for ${workflow.workItem.id}`, async current => {
    const fresh = await resolve(root, config, current, options);
    if (!fresh.preview.ready || fresh.preview.planDigest !== options.confirmation) fail('Baseline, candidate or policy changed during review.', 'TRP_RISK_REVIEW_STALE');
    const witness = await consumeTrpAuthority(root, { record, ...fresh.authority, review, token: authorization.token });
    await appendTrpRecord(workDir(root, config, current.workItem.id), record);
    const saved = await appendTrpAuthorityReceipt(workDir(root, config, current.workItem.id), witness);
    const entry = { action: 'accepted', planDigest: options.confirmation, record: ref(record), authorityReceipt: ref(saved.receipt), reviewedAt: saved.receipt.issuedAt };
    current.testRecovery.riskReviews ??= []; current.testRecovery.riskReviews.push(entry); return entry;
  }, { expectedLocalHead: initialHead });
  const pending = await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
  return { ...context.preview, status: pending ? 'publication-pending' : 'accepted', stateChanged: true,
    record: ref(record), publication: transaction.publication, pending };
}
