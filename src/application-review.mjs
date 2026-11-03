/** ARA coordinator. Every durable write goes through the existing Story transaction/provider. */
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { identity } from './git.mjs';
import { workDirRelative } from './story-paths.mjs';
import { writeAtomicExclusive } from './util.mjs';
import { canonicalJson } from './records.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { requireApprovalAuthority } from './approval-authority.mjs';
import { applicationReviewPhase } from './code-delivery-policy.mjs';
import { applicationReviewPlan, applicationReviewStatus, applicationReviewResults, findReviewSession, reviewTargetCurrent,
  reviewEvidenceAvailable, reviewLocalRoot, localCheckoutIdentity, bytesDigest, compactReviewResults, reviewSnapshotReference } from './application-review-read.mjs';
import { araFail, appendReviewEvent, newReviewSession, projectReview, reviewDigest, findingRoot, findingRepairAttempts, assertCanConfirm, validateReviewCaptureSet, applicationReviewPolicy } from './application-review-contract.mjs';

const MAX_SESSIONS = 100;
const actorKey = actor => actor?.email ?? actor?.login ?? actor?.name;

export function reviewAuthority(config, workflow, phaseId, actor) {
  const groups = workflow.resolution?.applicationReview?.authorities;
  return requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
    groups ? { authorities: groups, requiredAuthorities: [], minimum: 1 } : workflow.phases[phaseId].approvalPolicy, actor);
}

/** A narrow metadata transaction never sweeps unfinished source, documents or local images. */
async function writeEvent(root, config, workflow, session, event, snapshotRecord = null) {
  const relative = `${workDirRelative(config, workflow.workItem.id)}/context/application-reviews/${event.digest.slice(7)}.json`;
  const snapshotPath = snapshotRecord ? event.payload.target?.snapshot?.path : null;
  const { transactStory } = await import('./story-publication-store.mjs');
  const result = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, phaseId: session.subject.phaseId, generation: projectReview(session).subject.generation,
    actor: event.actor, agent: null, authorityGroup: event.payload.authorityGroup ?? null,
    payload: { kind: 'application-review', sessionId: session.id, eventSha256: event.digest, actionId: event.actionId }
  }, `[${workflow.workItem.id}][app-review] ${event.type}`, async aggregate => {
    const existing = (aggregate.applicationReviews ?? []).find(item => item.id === session.id);
    if (existing && existing.revision !== event.revision - 1) araFail('ARA_REVISION_CONFLICT', 'The review changed before its event could be recorded.');
    if (event.type === 'review-confirmed' || event.type === 'acceptance-finalized') {
      const target = projectReview(session).target;
      if (!await reviewTargetCurrent(root, config, aggregate, target)) araFail('ARA_REVIEW_STALE', 'Source or submitted results changed before this decision.');
      reviewAuthority(config, aggregate, session.subject.phaseId, event.actor);
    }
    if (snapshotRecord) {
      const { digest, ...content } = snapshotRecord;
      if (event.type !== 'target-ready' || reviewDigest(content) !== digest || event.payload.target.snapshot.digest !== digest
          || reviewSnapshotReference(config, aggregate, snapshotRecord).path !== snapshotPath) araFail('ARA_SNAPSHOT_INVALID', 'The owner snapshot record does not match this target.');
      await mkdir(path.dirname(path.join(root, snapshotPath)), { recursive: true });
      try { await writeAtomicExclusive(path.join(root, snapshotPath), canonicalJson(content)); }
      catch (error) { if (error.code !== 'EEXIST' || await readFile(path.join(root, snapshotPath), 'utf8') !== canonicalJson(content)) throw error; }
    }
    aggregate.applicationReviews ??= [];
    const index = aggregate.applicationReviews.findIndex(item => item.id === session.id);
    if (index >= 0) aggregate.applicationReviews[index] = session;
    else aggregate.applicationReviews.push(session);
    aggregate.history ??= [];
    aggregate.history.push({ at: event.at, actor: actorKey(event.actor), agent: null, event: 'application_review_recorded',
      phase: session.subject.phaseId, detail: `${event.type}: ${session.id} (${event.digest})` });
    if (event.type === 'acceptance-finalized') {
      const view = projectReview(session);
      if (!await reviewEvidenceAvailable(root, view.captures)) araFail('ARA_EVIDENCE_UNAVAILABLE', 'The admitted local capture files are missing or changed.');
      const { recordApplicationReviewAcceptance } = await import('./verification/witness-records.mjs');
      recordApplicationReviewAcceptance(aggregate, { confirmation: view.confirmation, captures: view.captures.filter(item => item.confirmation === view.confirmation.id),
        decisions: event.payload.decisions, target: view.target, actor: event.actor, authorityGroup: event.payload.authorityGroup, at: event.at });
    }
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    try { await writeAtomicExclusive(path.join(root, relative), canonicalJson(event)); }
    catch (error) { if (error.code !== 'EEXIST' || await readFile(path.join(root, relative), 'utf8') !== canonicalJson(event)) throw error; }
  }, { exactWorkItemPaths: [relative, ...(snapshotPath ? [snapshotPath] : [])] });
  return { event, publication: result.publication };
}

/** Actual host action identity is retained; repeat transport delivery cannot duplicate effects. */
export async function mutateApplicationReview(root, { workId = null, sessionId, actionId, expectedRevision, type, input = {}, prepare, human = null }) {
  const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  if (!applicationReviewPolicy(workflow) || workflow.resolution.applicationReview.mode === 'off') araFail('ARA_NOT_ADOPTED', 'Application review is not adopted for this Story. No review mutation was recorded.');
  const original = findReviewSession(workflow, sessionId);
  const session = structuredClone(original);
  const actor = identity(root, { offline: true });
  const prior = session.events.find(item => item.actionId === actionId);
  if (prior) {
    if (prior.type !== type || prior.payload.inputDigest !== reviewDigest(input) || actorKey(prior.actor) !== actorKey(actor)) araFail('ARA_IDEMPOTENCY_CONFLICT', 'This action already belongs to different input or a different person.');
    return { replay: true, event: prior, session: projectReview(session) };
  }
  let humanAuthority = null;
  if (human) {
    const { consumeReviewHumanAction } = await import('./application-review-human.mjs');
    consumeReviewHumanAction(human, { root, sessionId, revision: expectedRevision, action: type, inputDigest: reviewDigest(input) });
    if (!['feedback-recorded', 'finding-repair-requested'].includes(type)) humanAuthority = reviewAuthority(config, workflow, session.subject.phaseId, actor);
  } else if (['review-confirmed', 'finding-rechecked', 'finding-dispositioned', 'finding-repair-requested'].includes(type)) {
    araFail('ARA_HUMAN_ACTION_REQUIRED', 'Use the live review surface or your interactive terminal. Model-supplied consent, actor and roles are not accepted.');
  }
  const { snapshotRecord = null, ...preparedPayload } = await prepare({ config, workflow, session, view: projectReview(session), actor });
  const payload = { ...preparedPayload,
    ...(humanAuthority ? { authorityGroup: humanAuthority.authorityGroup } : {}), inputDigest: reviewDigest(input) };
  const { event } = appendReviewEvent(session, { actionId, expectedRevision, type, payload, actor, at: new Date().toISOString() });
  const written = await writeEvent(root, config, workflow, session, event, snapshotRecord);
  return { ...written, session: projectReview(session) };
}

export async function startApplicationReview(root, { workId = null, actionId, phaseId = null } = {}) {
  const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const plan = await applicationReviewPlan(root, config, workflow, { phaseId: phaseId ?? applicationReviewPhase(workflow) });
  if (plan.status === 'not-adopted') araFail('ARA_NOT_ADOPTED', 'Application review is not pinned into this Story. Adopt it for a new Story through workflow configuration; existing work is unchanged.');
  // One persistent phase lineage: cancellation or a new generation cannot reset repair budgets.
  const id = `ARA-${reviewDigest({ workId: plan.subject.workId, phaseId: plan.subject.phaseId }).slice(7, 31)}`;
  const existing = (workflow.applicationReviews ?? []).find(item => item.id === id);
  if (existing) return { replay: true, session: projectReview(existing) };
  if ((workflow.applicationReviews?.length ?? 0) >= MAX_SESSIONS) araFail('ARA_SESSION_LIMIT', 'This Story reached its review-session bound; preserve it and use the existing recovery route.');
  const session = newReviewSession({ id, subject: plan.subject, policy: plan.policy });
  const { event } = appendReviewEvent(session, { actionId, expectedRevision: 0, type: 'target-ready', actor: identity(root, { offline: true }), at: new Date().toISOString(),
    payload: { inputDigest: reviewDigest({ actionId }), target: { id: reviewDigest({ plan: { ...plan, capabilities: undefined }, checkout: localCheckoutIdentity(root) }),
      subject: plan.subject, snapshot: reviewSnapshotReference(config, workflow, plan.snapshot), results: compactReviewResults(plan.results), applicability: plan.applicability, changedSurfaces: plan.changedSurfaces,
      references: plan.documents.references, referencesDigest: reviewDigest(plan.documents.references), plan: { items: plan.items, digest: reviewDigest(plan.items) },
      policyDigest: reviewDigest(plan.policy), assurance: plan.applicability.surface === 'web' ? 'unverified' : 'host-bound',
      binding: { adapter: plan.applicability.surface === 'web' ? 'static-web' : 'test-results', checkout: localCheckoutIdentity(root), instance: null } } } });
  const written = await writeEvent(root, config, workflow, session, event, { ...plan.snapshot, schemaVersion: 1, kind: 'application-review-snapshot' });
  return { ...written, session: projectReview(session), capabilities: plan.capabilities };
}

export async function recordApplicationFeedback(root, options) {
  const { observed, expected = '', intent = 'report-only', targetId } = options.input;
  if (typeof observed !== 'string' || observed.trim().length < 3 || observed.length > 16000 || typeof expected !== 'string' || expected.length > 16000
      || !['report-only', 'report-and-fix'].includes(intent)) araFail('ARA_FEEDBACK_INVALID', 'Describe the observed behavior and choose Report only or Report and fix.');
  if (intent === 'report-and-fix' && !options.human) araFail('ARA_REPAIR_DIRECTION_REQUIRED', 'Report and fix must come from the actual local human action. A model may retain an observation but cannot manufacture a repair instruction.');
  return mutateApplicationReview(root, { ...options, type: 'feedback-recorded', prepare: ({ view, session }) => {
    if (!view.target || !session.events.some(event => event.type === 'target-ready' && event.payload.target.id === targetId)) araFail('ARA_REVIEW_STALE', 'Record this observation against a retained target you actually inspected.');
    if (view.findings.length >= 200) araFail('ARA_FINDING_LIMIT', 'This review retains 200 findings. Resolve existing observations before adding more; nothing was discarded.');
    return { finding: { id: `ARF-${reviewDigest({ session: view.id, action: options.actionId }).slice(7, 27)}`, targetId,
      observed: observed.trim(), expected: expected.trim(), repairRequested: intent === 'report-and-fix',
      provenance: options.human ? 'actual-local-user-action' : 'submitted-observation', classification: 'unresolved', obligationRefs: [] } };
  } });
}

export async function prepareApplicationRepair(root, options) {
  const prepared = await mutateApplicationReview(root, { ...options, type: 'repair-prepared', prepare: async ({ config, workflow, view }) => {
    const finding = view.findings.find(item => item.id === options.input.findingId);
    if (!finding || !finding.repairRequested) araFail('ARA_REPAIR_NOT_AUTHORIZED', 'Report and fix authorizes an in-scope repair; Report only does not.');
    if (finding.state !== 'ready-for-repair') araFail('ARA_REPAIR_NOT_READY', 'An existing attempt or recheck is still owed. Continue it, or have the person explicitly request another repair of this same finding; its budget is preserved.');
    const rootFinding = findingRoot(view.findings, finding.id);
    if (findingRepairAttempts(view, finding.id).length >= findReviewSession(workflow, options.sessionId).policy.repairAttempts
        || (workflow.applicationReviews ?? []).flatMap(item => projectReview(item).repairAttempts).length >= findReviewSession(workflow, options.sessionId).policy.totalRepairAttempts) {
      araFail('ARA_REPAIR_LIMIT_REACHED', 'The persistent automatic repair budget is exhausted. Preserve the draft and use manual repair or an authorized policy continuation.',
        { nextAction: { command: `singularity-flow appeal prepare --work-id ${workflow.workItem.id} --phase ${view.subject.phaseId} --json`, label: 'Prepare an owner-reviewed continuation; the automatic counter is preserved.' } });
    }
    const phase = workflow.phases[view.subject.phaseId];
    if (workflow.currentPhase !== phase.id || !['in_progress', 'awaiting_approval'].includes(phase.status)) {
      araFail('ARA_SUCCESSOR_REQUIRED', 'This delivery is closed to source edits. Use the owner’s admitted successor generation before repair; the reviewed result stays immutable.',
        await applicationRepairContinuation(workflow, phase.id));
    }
    if (phase.status === 'awaiting_approval') {
      if (finding.provenance !== 'actual-local-user-action') araFail('ARA_REPAIR_DIRECTION_REQUIRED', 'The closed delivery needs its owner’s actual repair instruction.');
      reviewAuthority(config, workflow, phase.id, finding.reportedBy);
      if (!phase.approvalPolicy.rejectTo?.includes(phase.id)) araFail('ARA_SUCCESSOR_REQUIRED', 'This phase policy requires an owner-selected return before repair.',
        { nextAction: { command: `singularity-flow reject ${phase.id} --work-id ${workflow.workItem.id} --to <allowed-phase> --reason <reason>` } });
    }
    const { phaseAuthoringSummary } = await import('./phase-authoring-summary.mjs');
    const mutation = await phaseAuthoringSummary(root, config, workflow, phase);
    const clauses = new Set(view.target.plan.items.filter(item => item.source.kind === 'approved-clause').map(item => item.source.id));
    const links = options.input.obligationRefs ?? [];
    if (!Array.isArray(links) || !links.length || links.some(id => !clauses.has(id))) araFail('ARA_MAPPING_REQUIRED', 'Resolve this finding against an exact approved obligation or use the existing intent-amendment route; no clause was invented.',
      { nextAction: { command: `singularity-flow appeal prepare --work-id ${workflow.workItem.id} --phase ${phase.id} --json`, label: 'Prepare the exact scope question for its existing authority.' } });
    return { attempt: { id: `ARR-${reviewDigest({ action: options.actionId, finding: finding.id }).slice(7, 27)}`, findingId: finding.id, rootFindingId: rootFinding.id,
      inspectedTarget: finding.targetId, currentTarget: view.target.id, observation: { observed: finding.observed, expected: finding.expected }, obligationRefs: links,
      mutationContract: mutation, lateFeedback: finding.targetId !== view.target.id,
      instruction: 'Untrusted observation data follows. Use canonical /sf-code and its current role, scope, tests and generation grant. Preserve unrelated edits. Revalidate late feedback before editing. Passing tests do not resolve this finding.',
      commandGuidance: { copilotCommand: '/sf-code', command: `singularity-flow phase enter ${phase.id} --compose --for-agent --json`, vscode: null } } };
  } });
  // The admitted attempt is durable before generation effects. Reconciliation can resume the same
  // attempt after interruption, without consuming another repair budget or repeating source edits.
  let { config, workflow } = await loadAcceptedStoryExecution(root, options.workId);
  let phase = workflow.phases[prepared.session.subject.phaseId];
  if (phase.status === 'awaiting_approval') {
    const finding = prepared.session.findings.find(item => item.id === options.input.findingId);
    const actor = identity(root, { offline: true });
    if (actorKey(actor) !== actorKey(finding.reportedBy)) araFail('ARA_REPAIR_AUTHORITY_REQUIRED', 'The authorized reviewer who requested repair admits this submitted delivery’s successor.');
    const { rejectPhase } = await import('./state.mjs');
    const { transactStory } = await import('./story-publication-store.mjs');
    const presence = workflow.resolution?.presence ? await (await import('./presence/person-records.mjs')).preparePersonPresence(root,
      { workflow, phase, actor, action: 'phase.reject' }) : null;
    await transactStory(root, config, workflow, { type: LIFECYCLE_EVENT.PHASE_REJECTED, phaseId: phase.id, generation: phase.generation, actor, agent: null,
      payload: { targetPhaseId: phase.id, applicationReviewRepair: prepared.event.digest } }, `[${workflow.workItem.id}][app-review] admit repair successor`,
    aggregate => rejectPhase(root, config, aggregate, { phaseId: phase.id, target: phase.id, reason: `Application review: ${finding.observed}. Expected: ${finding.expected || 'the approved behavior'}.`,
      actor, agent: null, presence }), { eventFromResult: transition => ({ payload: { targetPhaseId: phase.id, changeRequestId: transition.changeRequest.id } }) });
    ({ config, workflow } = await loadAcceptedStoryExecution(root, options.workId));
    phase = workflow.phases[phase.id];
  }
  const { beginPhaseGeneration } = await import('./state.mjs');
  const { storyDraftTransaction } = await import('./commands/shared/story-draft-transaction.mjs');
  const { saveStoryDraft } = await import('./state-stores.mjs');
  const generationIntent = await storyDraftTransaction(root, config, workflow, `app-review-repair:${phase.id}`, async () => {
    const intent = await beginPhaseGeneration(root, config, workflow, { phaseId: phase.id });
    await saveStoryDraft(root, config, workflow);
    return intent;
  });
  return { ...prepared, generationIntent };
}

/** Reuse the owner's routes that are legal now; never suggest rolling over an approved phase. */
export async function applicationRepairContinuation(workflow, phaseId) {
  const workId = workflow.workItem.id;
  if (['completed', 'cancelled'].includes(workflow.status)) return { nextAction: {
    command: `singularity-flow reopen ${workId} --reason <reason> --to ${phaseId}`,
    label: 'An authorized owner reopens this existing Story for the reported correction.' } };
  const { upstreamChangeRoutes } = await import('./upstream-routes.mjs');
  const continuation = upstreamChangeRoutes(workflow, phaseId);
  return { nextAction: continuation.routes[0] ?? {
    command: `singularity-flow phase enter --work-id ${workId} --for-agent --json`,
    label: 'Inspect the current phase and its owner-authorized continuation.' }, notes: continuation.notes };
}

export async function confirmApplicationReview(root, options) {
  return mutateApplicationReview(root, { ...options, type: 'review-confirmed', prepare: async ({ config, workflow, view }) => {
    const results = await applicationReviewResults(root, config, workflow, view.subject.phaseId);
    const current = await reviewTargetCurrent(root, config, workflow, view.target);
    assertCanConfirm(view, { targetCurrent: current, dimensions: options.input.dimensions, coverage: options.input.coverage, testsReady: results.confirmable });
    if (view.target.binding.checkout !== localCheckoutIdentity(root)) araFail('ARA_REVIEW_STALE', 'This laptop must establish its own preview and review binding.');
    return { dimensions: options.input.dimensions, coverage: options.input.coverage, targetId: view.target.id, planDigest: view.target.plan.digest,
      resultsDigest: results.digest, reviewedBasis: view.target.applicability.surface === 'web' ? 'live-application-and-retained-results' : 'retained-structured-results',
      capturePlan: options.input.capturePlan, hostAction: { channel: 'local-review', id: options.actionId }, phaseApproval: 'separate' };
  } });
}

export async function finalizeApplicationReview(root, options) {
  return mutateApplicationReview(root, { ...options, type: 'acceptance-finalized', prepare: async ({ config, workflow, view, actor }) => {
    if (!view.confirmation || !view.captures.length || !await reviewEvidenceAvailable(root, view.captures)) araFail('ARA_EVIDENCE_UNAVAILABLE', 'Confirmation is retained; finish its automatic capture before acceptance.');
    assertCanConfirm(view, { targetCurrent: await reviewTargetCurrent(root, config, workflow, view.target), dimensions: view.confirmation.dimensions,
      coverage: view.confirmation.coverage, testsReady: view.target.results.ready });
    if (actorKey(actor) !== actorKey(view.confirmation.actor)) araFail('ARA_AUTHORITY_CHANGED', 'The confirming reviewer must resume this finalization under their current authority.');
    const fullResults = await applicationReviewResults(root, config, workflow, view.subject.phaseId);
    validateReviewCaptureSet({ ...view, target: { ...view.target, results: fullResults } }, view.captures.filter(item => item.confirmation === view.confirmation.id),
      findReviewSession(workflow, options.sessionId).policy);
    const authority = reviewAuthority(config, workflow, view.subject.phaseId, actor);
    return { authorityGroup: authority.authorityGroup, decisions: view.confirmation.dimensions.map(dimension => ({
      id: `ARA-WIT-${reviewDigest({ confirmation: view.confirmation.id, dimension }).slice(7, 31)}`, dimension, confirmation: view.confirmation.id,
      targetId: view.target.id, reviewedBasis: view.confirmation.reviewedBasis,
      captureReceipts: view.captures.filter(receipt => receipt.confirmation === view.confirmation.id).map(receipt => receipt.id) })) };
  } });
}

export async function assertApplicationReviewComplete(root, config, workflow, phase) {
  if (workflow.resolution?.applicationReview?.mode !== 'required') return;
  const { phaseRequiresCodeDelivery } = await import('./code-delivery-policy.mjs');
  if (!phaseRequiresCodeDelivery(phase)) return;
  let status;
  try { status = await applicationReviewStatus(root, config, workflow, findReviewSession(workflow, null, phase.id).id); }
  catch (error) {
    if (error.code !== 'ARA_SESSION_NOT_FOUND') throw error;
  }
  if (!status?.completion.reviewSatisfied) araFail('ARA_REVIEW_REQUIRED', status?.localEvidence === 'missing-on-this-laptop'
    ? 'Review evidence is local to the other laptop. Establish and inspect a fresh local target; the Story and earlier reviews are preserved.'
    : 'Application inspection, rechecks or acceptance evidence remain owed. Open the review and continue in this phase.',
  { nextAction: { command: status ? `singularity-flow app-review inspect ${status.id}` : `singularity-flow app-review start --work-id ${workflow.workItem.id}` }, status: status?.state ?? 'offered' });
}

/** Packet added to /sf-code entry; no additional model call or second publication. */
export function applicationReviewRepairContext(workflow, phase) {
  const pending = (workflow.applicationReviews ?? []).filter(session => session.subject.phaseId === phase.id).map(projectReview)
    .flatMap(view => view.repairAttempts.filter(attempt => !attempt.result && view.findings.some(finding => finding.id === attempt.findingId && finding.state === 'repairing'))
      .map(attempt => ({ sessionId: view.id, ...attempt })));
  const findings = (workflow.applicationReviews ?? []).filter(session => session.subject.phaseId === phase.id).map(projectReview)
    .flatMap(view => view.findings.filter(finding => finding.state === 'ready-for-repair').map(finding => ({ sessionId: view.id, revision: view.revision, ...finding,
      availableObligations: view.target?.plan.items.filter(item => item.source.kind === 'approved-clause').map(item => ({ id: item.source.id, text: item.text })) ?? [],
      repairActionId: `repair-${reviewDigest({ session: view.id, finding: finding.id, revision: view.revision }).slice(7, 39)}`,
      admission: 'Propose exact obligation references, then use app-review repair with this session revision and returned repairActionId before editing source. --input-json carries only findingId and obligationRefs; no staging-path guess or extra model invocation.' })));
  return pending.length || findings.length ? { kind: 'application-review-repair', untrustedObservations: true, attempts: pending.slice(0, 10),
    findings: findings.slice(0, 10), omitted: Math.max(0, pending.length - 10) + Math.max(0, findings.length - 10) } : null;
}
