/** Governed Story risk review. A preview or caller-supplied actor never grants consent. */
import { captureTerminalActionAuthorization } from './action-authorization.mjs';
import { requireApprovalAuthority } from './approval-authority.mjs';
import { head, identity } from './git.mjs';
import { StoryStateStore, storyPublicationPending, workDir } from './state-stores.mjs';
import { sealTrpRecord, trpDigest, trpEnvironmentDigest, validateTrpRecord } from './test-recovery-policy.mjs';
import { appendTrpAuthorityReceipt, appendTrpRecord, consumeTrpAuthority, loadTrpRecords, trpAuthorityReview } from './test-recovery-store.mjs';
import { loadTrpDeliveryAgreement } from './trp-delivery-selection.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';
import { verifyWorkflowSnapshot } from './workflow-snapshots.mjs';
import { documentObligationsForPhase } from './trp-document-policy.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPERATIONS = ['publish', 'submit', 'approve', 'downstream', 'replay'];
const SUPPORTED = ['validation-unavailable', 'new-test-failure', 'known-test-failure', 'reduced-coverage', 'nonessential-document'];
const fail = (message, code = 'TRP_RISK_ARGUMENT_INVALID', details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const reference = ({ kind, id, recordSha256 }) => ({ kind, id, recordSha256 });
const actorPrincipal = (actor) => String(actor.email ?? actor.login ?? '').trim().toLowerCase();
const recoverAction = (workId) => ({ id: 'inspect-publication', label: 'Recover the exact pending Story publication', command: 'recover', args: [workId, '--json'] });

/** Risk authority never falls back to an ordinary phase approver or Git author. */
export function storyTestRiskAuthorityContext(workflow, agreement) {
  const pin = workflow.resolution?.testRecovery;
  if (!pin?.enabled || !pin.riskAuthorities?.length || !workflow.resolution?.approvalAuthorities) {
    fail('The pinned Story policy has no explicit risk-review authority delegation.', 'TRP_AUTHORITY_REQUIRED');
  }
  return { policy: { enabled: true, authoritySha256: agreement.policyAuthoritySha256,
    enabledRiskCategories: pin.enabledRiskCategories ?? [], maxRiskDays: pin.maxRiskDays ?? 30,
    allowEvidenceReuse: pin.allowEvidenceReuse ?? false, maxEvidenceAgeSeconds: pin.maxEvidenceAgeSeconds ?? 86400,
    requiredApproval: true }, pinnedAuthorities: workflow.resolution.approvalAuthorities,
    delegation: { minimum: 1, minimumAssurance: 'configured-local-review', authorities: pin.riskAuthorities,
      categories: pin.enabledRiskCategories ?? [], transitions: [...OPERATIONS, 'generation-admission'] } };
}

function validateOptions(options, extra = []) {
  const allowed = new Set(['phaseId', 'repositoryId', 'obligationId', 'operation', 'issueId', 'reason', 'expiresAt', 'followUpOwner', 'remediationRef', ...extra]);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !allowed.has(key))) fail('Unsupported Story risk options.');
  for (const key of ['phaseId', 'repositoryId', 'issueId', 'obligationId']) {
    if (options[key] != null && (!ID.test(options[key]) || options[key].includes('..'))) fail(`Invalid ${key}.`);
  }
  if (options.operation != null && !OPERATIONS.includes(options.operation)) fail('Select a supported exact transition.');
  for (const key of ['reason', 'followUpOwner', 'remediationRef']) {
    if (options[key] != null && (typeof options[key] !== 'string' || options[key].length > (key === 'reason' ? 2000 : 2048))) fail(`Invalid ${key}.`);
  }
  if (options.expiresAt != null && (typeof options.expiresAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(options.expiresAt)
    || !Number.isFinite(Date.parse(options.expiresAt)))) fail('Expiry must be a UTC RFC 3339 timestamp.');
  for (const key of ['confirmation', 'recordSha256']) {
    if (options[key] != null && !HASH.test(options[key])) fail(`Invalid ${key}.`);
  }
  if (options.apply != null && typeof options.apply !== 'boolean') fail('apply must be boolean.');
}

async function acceptedAgreement(root, config, workflow) {
  const snapshot = await verifyWorkflowSnapshot(root, config, workflow, { requireAccepted: true });
  if (!snapshot.enrolled) fail('Risk review requires an accepted Story workflow snapshot.', 'TRP_RISK_SNAPSHOT_REQUIRED');
  const agreement = await loadTrpDeliveryAgreement(root, config, workflow);
  if (!agreement) fail('This Story has no pinned Test and Recovery Agreement.', 'TRP_NOT_ENABLED');
  return agreement;
}

function reviewIdentity(root, authority, record = null) {
  const actor = identity(root);
  requireApprovalAuthority(authority.pinnedAuthorities, { authorities: authority.delegation.authorities }, actor);
  const principal = actorPrincipal(actor);
  if (!principal) fail('A named delegated terminal reviewer is required.', 'TRP_AUTHORITY_REQUIRED');
  if (record && record.kind !== 'story-test-recovery-agreement' && principal !== record.issuer.principal.toLowerCase()) fail(
    `This immutable record belongs to '${record.issuer.principal}'. That original reviewer must re-attest it; use a separately governed replacement to change its principal.`,
    'TRP_RISK_ORIGINAL_REVIEWER_REQUIRED');
  return principal;
}

function decisionTerms(context, options) {
  const issue = context.evaluation.issues.find((entry) => entry.id === options.issueId);
  const observation = context.observations.find((entry) => entry.recordSha256 === issue?.observationRef);
  const knownBaseline = issue?.category === 'known-test-failure' ? context.baselines.find(entry =>
    context.agreement.repositories.some(repo => repo.repositoryId === context.subject.repositoryId && repo.baselineRefs.includes(entry.recordSha256))
    && entry.subject.phaseId === context.subject.phaseId && entry.obligationId === observation?.obligationId
    && entry.commandSha256 === observation?.commandSha256 && entry.selectorSha256 === observation?.selectorSha256) : null;
  const blockers = [];
  if (!issue) blockers.push('Select an issue from the current phase risk inspection.');
  if (issue && (!issue.riskEligible || issue.severity !== 'noncritical' || !SUPPORTED.includes(issue.category))) blockers.push(issue.riskReason || 'This issue has no supported risk adapter.');
  if (issue && !context.policy.enabledRiskCategories.includes(issue.category)) blockers.push('This category is not enabled by the pinned repository policy.');
  if (!observation) blockers.push('An authenticated exact current observation is required.');
  if (issue?.category === 'known-test-failure' && !knownBaseline) blockers.push('An authenticated immutable intake baseline is required for known-failure review.');
  if ((options.reason ?? '').trim().length < 15) blockers.push('Provide a substantive reason of at least 15 characters.');
  if (!(options.followUpOwner ?? '').trim()) blockers.push('Name the follow-up owner.');
  if (!(options.remediationRef ?? '').trim()) blockers.push('Name the remediation reference.');
  const anchorTime = Date.parse(observation?.createdAt ?? context.agreement.createdAt);
  const maximumExpiry = anchorTime + context.policy.maxRiskDays * 86400000;
  const expiresAt = new Date(Math.min(options.expiresAt ? Date.parse(options.expiresAt) : maximumExpiry, maximumExpiry)).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(context.evaluation.createdAt)) blockers.push('This risk plan has expired; capture and review fresh evidence.');
  const terms = { subject: context.subject, agreementSha256: context.agreement.recordSha256,
    policyAuthoritySha256: context.policy.authoritySha256, issueId: issue?.id ?? null,
    category: issue?.category ?? null, severity: issue?.severity ?? null,
    anchorObservationDigest: knownBaseline?.recordSha256 ?? observation?.recordSha256 ?? null, obligationId: issue?.obligationId ?? null,
    transitions: [options.operation ?? 'publish'], reason: (options.reason ?? '').trim(), expiresAt,
    followUpOwner: (options.followUpOwner ?? '').trim(), remediationRef: (options.remediationRef ?? '').trim(),
    applicability: observation ? { carryForward: Boolean(knownBaseline), phaseIds: [context.subject.phaseId],
      dependencies: knownBaseline?.dependencies.some(entry => entry.id === 'baseline-compatibility')
        ? knownBaseline.dependencies.filter(entry => entry.id === 'baseline-compatibility') : observation.dependencies,
      environmentSha256: trpEnvironmentDigest(knownBaseline?.environment ?? observation.environment), baselineSha256: knownBaseline?.recordSha256 ?? null,
      acceptedFailures: observation.cases.filter((entry) => entry.outcome === 'failed').map((entry) => ({
        testId: entry.id, semanticsSha256: entry.semanticsSha256, causeSha256: entry.causeSha256 })),
      allowedTestIds: observation.expectedTestIds,
      excludedTestIds: issue?.category === 'reduced-coverage'
        ? [...new Set([...(context.selection?.exclusions ?? []).map(entry => entry.testId),
          ...observation.cases.filter(entry => ['skipped', 'not-run'].includes(entry.outcome)).map(entry => entry.id)])] : [],
      maxFailed: observation.counts.failed,
      commandSha256: observation.commandSha256, selectorSha256: observation.selectorSha256,
      maxObservationAgeSeconds: context.policy.maxEvidenceAgeSeconds } : null };
  return { terms, issue, observation, blockers };
}

async function resolveRiskPlan(root, config, workflow, options) {
  const documentObligations = documentObligationsForPhase(workflow, options.phaseId ?? workflow.currentPhase);
  const phase = workflow.phases?.[options.phaseId ?? workflow.currentPhase];
  const testValidationAvailable = Boolean(phase?.qualityCommands?.some(command => command?.kind === 'test'));
  const obligationId = options.obligationId ?? null;
  if (!obligationId && !testValidationAvailable && documentObligations.length) return { preview: {
    schemaVersion: 1, resultType: 'story-test-risk-plan', workId: workflow.workItem.id,
    phaseId: phase.id, operation: options.operation ?? 'publish', obligationId: null,
    testValidationAvailable, documentObligations, status: 'choose-obligation', ready: false,
    blockers: ['Select a supplemental document obligation to inspect.'], issues: [], decisions: [],
    executed: false, stateChanged: false
  } };
  const loader = obligationId
    ? (await import('./trp-document-runtime.mjs')).loadStoryDocumentRiskContext
    : (await import('./test-recovery-runtime.mjs')).loadStoryTestRiskContext;
  const context = await loader(root, config, workflow, {
    phaseId: options.phaseId, repositoryId: options.repositoryId, obligationId,
    operation: options.operation ?? 'publish' });
  const { terms, issue, observation, blockers } = decisionTerms(context, options);
  const planDigest = trpDigest({ kind: 'story-test-risk-plan', action: 'accept', ...terms });
  const agreementAuthority = context.verifyAuthority?.(context.agreement, { policy: context.policy, capability: 'trp-agreement' });
  if (!agreementAuthority || agreementAuthority.revokedAt) blockers.push('Authorize the current immutable agreement in a direct terminal before accepting a risk.');
  return { context, terms, observation, preview: { schemaVersion: 1, resultType: 'story-test-risk-plan',
    workId: workflow.workItem.id, phaseId: context.subject.phaseId, repositoryId: context.subject.repositoryId,
    operation: options.operation ?? 'publish', obligationId: obligationId ?? null, testValidationAvailable, documentObligations,
    status: blockers.length ? 'blocked' : 'ready', ready: blockers.length === 0,
    planDigest, decision: terms, issues: context.evaluation.issues, decisions: context.decisions,
    observedOutcome: observation?.observedOutcome ?? 'not-run', remainingBlockers: context.evaluation.remainingBlockers,
    blockers, agreementAuthorization: { recordSha256: context.agreement.recordSha256, principal: context.agreement.issuer.principal,
      status: agreementAuthority && !agreementAuthority.revokedAt ? 'verified' : 'review-required' },
    legalActions: !agreementAuthority ? [{ id: 'attest-test-agreement', label: 'Authorize the immutable agreement through its pinned risk-review authority',
      command: 'story', args: ['test-policy', 'attest-risk', '--work-id', workflow.workItem.id,
        '--record-sha256', context.agreement.recordSha256, '--json'] }] : [], executed: false, stateChanged: false } };
}

/** Inspection neither executes tests nor interprets a reason or digest as consent. */
export async function planStoryTestRisk(root, config, workflow, options = {}) {
  validateOptions(options);
  const resolved = await resolveRiskPlan(root, config, workflow, options);
  const pending = await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
  if (pending) return { ...resolved.preview, ready: false, status: 'publication-pending', pending,
    legalActions: [recoverAction(workflow.workItem.id)] };
  return resolved.preview;
}

async function ensureNoPending(root, config, workflow) {
  const pending = await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
  if (pending) fail('Recover the exact pending Story publication before another risk mutation.', 'TRP_PUBLICATION_PENDING',
    { pending, legalActions: [recoverAction(workflow.workItem.id)] });
}

async function publishReview(root, config, workflow, { record, authority, planDigest, review, authorization, initialHead, refresh, action }) {
  const transaction = await new StoryStateStore(root, config).transact(workflow, {
    type: `test-risk-${action}`, phaseId: record.subject.phaseId ?? workflow.currentPhase,
    payload: { planDigest, record: reference(record), agreementSha256: record.agreementSha256 ?? record.recordSha256 }
  }, `Record Story test risk ${action} for ${workflow.workItem.id}`, async (current) => {
    const freshAuthority = await refresh(current);
    const witness = await consumeTrpAuthority(root, { record, ...(freshAuthority ?? authority), review, token: authorization.token });
    const workRoot = workDir(root, config, current.workItem.id);
    await appendTrpRecord(workRoot, record);
    const saved = await appendTrpAuthorityReceipt(workRoot, witness);
    const entry = { action, planDigest, record: reference(record), authorityReceipt: reference(saved.receipt), reviewedAt: saved.receipt.issuedAt };
    current.testRecovery.riskReviews ??= [];
    current.testRecovery.riskReviews.push(entry);
    return entry;
  }, { expectedLocalHead: initialHead });
  const pending = await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
  return { schemaVersion: 1, resultType: 'story-test-risk-result', workId: workflow.workItem.id,
    status: pending ? 'publication-pending' : action, planDigest, record: reference(record), review: transaction.value,
    publication: transaction.publication, pending: pending ?? null, stateChanged: true, executed: false,
    observedOutcome: 'unchanged', normalApprovalRequired: true,
    legalActions: pending ? [recoverAction(workflow.workItem.id)] : [] };
}

export async function acceptStoryTestRisk(root, config, workflow, options = {}) {
  validateOptions(options, ['confirmation']);
  if (!HASH.test(options.confirmation ?? '')) fail('Preview the exact risk first, then supply its confirmation digest.', 'TRP_RISK_CONFIRMATION_REQUIRED');
  await ensureNoPending(root, config, workflow);
  const initialHead = head(root);
  const resolved = await resolveRiskPlan(root, config, workflow, options);
  if (resolved.preview.planDigest !== options.confirmation) fail('The exact risk plan changed. Review its current scope.', 'TRP_RISK_REVIEW_STALE', { preview: resolved.preview });
  if (!resolved.preview.ready) fail('The selected issue cannot currently be accepted.', 'TRP_RISK_NOT_ELIGIBLE', { preview: resolved.preview });
  const authority = storyTestRiskAuthorityContext(workflow, resolved.context.agreement);
  const principal = reviewIdentity(root, authority);
  const existing = resolved.context.decisions.find((entry) => entry.confirmationSha256 === options.confirmation
    && Date.parse(entry.expiresAt) > Date.now() && resolved.context.verifyAuthority?.(entry, { policy: authority.policy })?.revokedAt === null);
  if (existing) return { status: 'already-accepted', workId: workflow.workItem.id, record: reference(existing), stateChanged: false, executed: false };
  const createdAt = nowIso();
  const suffix = trpDigest({ planDigest: options.confirmation, createdAt, principal }).slice(7, 39);
  const record = sealTrpRecord({ schemaVersion: 1, kind: 'phase-risk-decision', id: `risk-${suffix}`, createdAt,
    issuer: { principal, channel: 'terminal' }, provenance: { authorityRef: authority.policy.authoritySha256,
      evidenceRefs: [resolved.context.agreement.recordSha256, resolved.observation.recordSha256] },
    ...resolved.terms, authorityRef: authority.policy.authoritySha256, authorizationRef: `risk-review-${suffix}`,
    confirmationSha256: options.confirmation });
  const review = trpAuthorityReview(record, authority.policy);
  const authorization = await captureTerminalActionAuthorization(root, review.plan, review.action, { label: 'Accept Story test risk' });
  if (!authorization) return { status: 'cancelled', workId: workflow.workItem.id, stateChanged: false, executed: false };
  return publishReview(root, config, workflow, { record, authority, planDigest: options.confirmation, review, authorization,
    initialHead, action: 'accepted', refresh: async (current) => {
      const fresh = await resolveRiskPlan(root, config, current, options);
      if (!fresh.preview.ready || fresh.preview.planDigest !== options.confirmation) fail('Candidate, evidence, policy or issue changed during review.', 'TRP_RISK_REVIEW_STALE');
      const materialize = fresh.context.adapter === 'document'
        ? (await import('./trp-document-runtime.mjs')).materializeStoryDocumentRiskEvidence
        : (await import('./test-recovery-runtime.mjs')).materializeStoryTestRiskEvidence;
      await materialize(root, config, current, fresh.context);
      return storyTestRiskAuthorityContext(current, fresh.context.agreement);
    } });
}

async function recordReviewPlan(root, config, workflow, options, action) {
  const agreement = await acceptedAgreement(root, config, workflow);
  const authority = storyTestRiskAuthorityContext(workflow, agreement);
  const records = await loadTrpRecords(workDir(root, config, workflow.workItem.id));
  const target = records.find((record) => record.recordSha256 === (options.recordSha256 ?? agreement.recordSha256));
  const kinds = action === 'revoked' ? ['phase-risk-decision'] : ['story-test-recovery-agreement', 'phase-risk-decision', 'phase-risk-revocation'];
  if (!target || !kinds.includes(target.kind) || target.subject.workId !== workflow.workItem.id
    || (target.kind === 'story-test-recovery-agreement' ? target.recordSha256 !== agreement.recordSha256 : target.agreementSha256 !== agreement.recordSha256)) {
    fail('Select an immutable record in the current Story agreement.', 'TRP_RISK_RECORD_REQUIRED');
  }
  validateTrpRecord(target);
  const blockers = [];
  if (action === 'revoked' && (options.reason ?? '').trim().length < 15) blockers.push('Provide a substantive revocation reason of at least 15 characters.');
  if (action === 'attested') {
    try { reviewIdentity(root, authority, target); } catch (error) { blockers.push(error.message); }
  }
  const core = { action, workId: workflow.workItem.id, recordSha256: target.recordSha256,
    agreementSha256: agreement.recordSha256, policyAuthoritySha256: authority.policy.authoritySha256,
    reason: action === 'revoked' ? (options.reason ?? '').trim() : null };
  const preview = { schemaVersion: 1, resultType: 'story-test-risk-record-plan', ...core,
    planDigest: trpDigest(core), status: blockers.length ? 'blocked' : 'ready', ready: blockers.length === 0,
    principal: target.issuer.principal, blockers, record: target, executed: false, stateChanged: false };
  return { agreement, authority, target, preview };
}

async function reviewExistingRecord(root, config, workflow, options, action) {
  validateOptions(options, ['recordSha256', 'confirmation', 'apply']);
  if (options.confirmation && !options.apply) fail('A confirmation digest requires an explicit apply operation.');
  if (options.apply && !HASH.test(options.confirmation ?? '')) fail('Preview first, then confirm the exact record plan.', 'TRP_RISK_CONFIRMATION_REQUIRED');
  const initialHead = head(root);
  const resolved = await recordReviewPlan(root, config, workflow, options, action);
  if (!options.apply) return resolved.preview;
  await ensureNoPending(root, config, workflow);
  if (resolved.preview.planDigest !== options.confirmation) fail('The immutable review plan changed.', 'TRP_RISK_REVIEW_STALE');
  if (!resolved.preview.ready) fail('The selected record cannot currently be reviewed.', 'TRP_AUTHORITY_REQUIRED', { preview: resolved.preview });
  const principal = reviewIdentity(root, resolved.authority, action === 'attested' ? resolved.target : null);
  const createdAt = nowIso();
  const suffix = trpDigest({ confirmation: options.confirmation, createdAt, principal }).slice(7, 39);
  const record = action === 'attested' ? resolved.target : sealTrpRecord({ schemaVersion: 1, kind: 'phase-risk-revocation',
    id: `revocation-${suffix}`, subject: resolved.target.subject, createdAt, effectiveAt: createdAt,
    issuer: { principal, channel: 'terminal' }, provenance: { authorityRef: resolved.authority.policy.authoritySha256,
      evidenceRefs: [resolved.target.recordSha256] }, agreementSha256: resolved.agreement.recordSha256,
    policyAuthoritySha256: resolved.authority.policy.authoritySha256, decisionSha256: resolved.target.recordSha256,
    category: resolved.target.category, transitions: resolved.target.transitions,
    authorizationRef: `revoke-review-${suffix}`, confirmationSha256: options.confirmation, reason: options.reason.trim() });
  const review = trpAuthorityReview(record, resolved.authority.policy);
  const authorization = await captureTerminalActionAuthorization(root, review.plan, review.action,
    { label: action === 'attested' ? 'Re-attest Story test risk' : 'Revoke Story test risk' });
  if (!authorization) return { status: 'cancelled', workId: workflow.workItem.id, stateChanged: false, executed: false };
  return publishReview(root, config, workflow, { record, authority: resolved.authority, planDigest: options.confirmation,
    review, authorization, initialHead, action, refresh: async (current) => {
      const fresh = await recordReviewPlan(root, config, current, options, action);
      if (!fresh.preview.ready || fresh.preview.planDigest !== options.confirmation) fail('The accepted Story moved during review.', 'TRP_RISK_REVIEW_STALE');
      return fresh.authority;
    } });
}

export async function revokeStoryTestRisk(root, config, workflow, options = {}) {
  return reviewExistingRecord(root, config, workflow, options, 'revoked');
}
export async function attestStoryTestRisk(root, config, workflow, options = {}) {
  return reviewExistingRecord(root, config, workflow, options, 'attested');
}
