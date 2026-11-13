/** Application-review event, report and capture rules. No storage, provider, process or ambient clock. */
import {canonicalJson,textDigestCapability,recordJsonSyntax,admitRecordSchemaVersion,APPLICATION_REVIEW_POLICY_SCHEMA,APPLICATION_REVIEW_SESSION_SCHEMA} from '../foundation/record-schema.mjs';
import {ARA_VERSION,araFail,createApplicationReviewPolicyValidator} from './configuration-policy.mjs';
export const APPLICATION_REVIEW_VALUES_PROFILE='sflow-application-review-values/v1';
export function applicationReviewPolicies(recordBytes,digests){
  const syntax=recordJsonSyntax(recordBytes),hashing=textDigestCapability(digests),
    recordSha256=value=>hashing.sha256Utf8(canonicalJson(value)),normalizeApplicationReview=createApplicationReviewPolicyValidator(recordBytes);
  const readRecord=(familyId,value)=>admitRecordSchemaVersion(familyId==='application-review-policy'?APPLICATION_REVIEW_POLICY_SCHEMA:APPLICATION_REVIEW_SESSION_SCHEMA,syntax.parseObject(value));
const reviewDigest = value => `sha256:${recordSha256(value)}`;

function applicationReviewPolicy(workflow) {
  const policy = workflow?.resolution?.applicationReview;
  if (policy && policy.mode !== 'off' && workflow.resolution.presence && workflow.resolution.presence.status !== 'off') {
    araFail('ARA_AUTHORITY_ADAPTER_UNAVAILABLE', 'This Story requires signed person-presence records. The local application-review adapter does not implement that signing boundary; no unsigned acceptance can substitute for it. Use a qualified signed-review adapter.');
  }
  return policy ? readRecord('application-review-policy', policy).record : null;
}

function reviewSubject(workflow, phaseId = workflow?.currentPhase) {
  if (workflow?.kind === 'run') araFail('ARA_SUBJECT_UNSUPPORTED', 'Execution-run review needs an installed EXR subject adapter; no Story was synthesized.');
  const phase = workflow?.phases?.[phaseId];
  if (!workflow?.workItem?.id || !phase) araFail('ARA_SUBJECT_UNAVAILABLE', 'Select a Story and its existing code-bearing phase.');
  return { kind: 'story-phase', workId: workflow.workItem.id, phaseId, generation: phase.generation };
}

/** Observed UI always strengthens a declared non-UI profile. Unknown auto scope stays unresolved. */
function reviewApplicability(policy, paths) {
  const ui = paths.some(file => /\.(?:jsx|tsx|vue|svelte|html|css|scss)$/iu.test(file) && !/\.(?:test|spec)\./iu.test(file));
  const surface = ui ? 'web' : policy?.surface ?? 'auto';
  const resolved = surface !== 'auto';
  return { resolved, surface, reason: ui ? 'Observed user-facing source changes' : resolved ? 'Explicit adopted review profile' : 'Change surface requires an explicit review profile',
    dimensions: { visual: surface === 'web' ? 'pending' : resolved ? 'not-applicable' : 'pending', functional: 'pending' } };
}

/** Versioned events are immutable, content addressed and chained under the owner's transaction. */
function appendReviewEvent(session, { actionId, expectedRevision, type, payload = {}, actor, at }) {
  if (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(actionId)) araFail('ARA_ACTION_REQUIRED', 'Use the original host action ID when retrying this operation.');
  const requestSha256 = reviewDigest({ type, payload, actor });
  const prior = session.events.find(event => event.actionId === actionId);
  if (prior) {
    if (prior.requestSha256 !== requestSha256) araFail('ARA_IDEMPOTENCY_CONFLICT', 'This action ID already refers to a different review action.');
    return { event: prior, replay: true };
  }
  if (session.revision !== expectedRevision) araFail('ARA_REVISION_CONFLICT', 'The review changed. Refresh it and preserve your unsaved feedback.', { actualRevision: session.revision });
  if (session.events.length >= 2000) araFail('ARA_EVENT_LIMIT', 'This review reached its 2,000-event limit. Preserve it and ask its owner to resolve the outstanding work; no budget or evidence was reset.');
  if (!actor || !Number.isFinite(Date.parse(at))) araFail('ARA_EVENT_INVALID', 'A review event needs its host-resolved actor and time.');
  const body = { schemaVersion: ARA_VERSION, kind: 'application-review-event', sessionId: session.id,
    subject: session.subject, revision: session.revision + 1, previous: session.events.at(-1)?.digest ?? null,
    actionId, requestSha256, type, payload: structuredClone(payload), actor: structuredClone(actor), at };
  const event = { ...body, digest: reviewDigest(body) };
  session.events.push(event); session.revision += 1;
  return { event, replay: false };
}

function validateReviewSession(session) {
  readRecord('application-review-session', session);
  if (session.kind !== 'application-review-session' || !Array.isArray(session.events)
      || session.events.length > 2000 || session.revision !== session.events.length) araFail('ARA_RECORD_INVALID', 'The application review session has an invalid version or event sequence.');
  const policyDigest = reviewDigest(readRecord('application-review-policy', session.policy).record);
  let previous = null;
  const actions = new Set();
  for (const [index, event] of session.events.entries()) {
    const { digest, ...body } = event;
    if (digest !== reviewDigest(body) || event.sessionId !== session.id || event.revision !== index + 1 || event.previous !== previous
        || reviewDigest(event.subject) !== reviewDigest(session.subject) || actions.has(event.actionId)) araFail('ARA_RECORD_INVALID', 'The application review event chain could not be verified.');
    if (event.type === 'target-ready' && event.payload.target?.policyDigest !== policyDigest) araFail('ARA_RECORD_INVALID', 'The immutable review policy or repair budget differs from the recorded target.');
    actions.add(event.actionId); previous = digest;
  }
  return session;
}

function newReviewSession({ id, subject, policy }) {
  return { schemaVersion: ARA_VERSION, kind: 'application-review-session', id, subject: structuredClone(subject), policy: structuredClone(policy), revision: 0, events: [] };
}

/** Resolve duplicates by root, detecting both cycles and missing authoritative findings. */
function findingRoot(findings, id) {
  const seen = new Set();
  let finding = findings.find(item => item.id === id);
  while (finding?.duplicateOf) {
    if (seen.has(finding.id)) araFail('ARA_FINDING_LINEAGE_INVALID', 'Finding duplicate references contain a cycle.');
    seen.add(finding.id); finding = findings.find(item => item.id === finding.duplicateOf);
  }
  if (!finding) araFail('ARA_FINDING_LINEAGE_INVALID', 'The authoritative finding is missing.');
  return finding;
}

/** Merging duplicate lineages never gives their consumed attempts a new root budget. */
function findingRepairAttempts(view, findingId) {
  const root = findingRoot(view.findings, findingId).id;
  return view.repairAttempts.filter(attempt => findingRoot(view.findings, attempt.rootFindingId).id === root);
}

function projectReview(session) {
  validateReviewSession(session);
  const view = { id: session.id, subject: session.subject, revision: session.revision, state: 'offered', target: null,
    findings: [], coverage: [], confirmation: null, captures: [], decisions: [], repairAttempts: [], error: null };
  for (const event of session.events) {
    const p = event.payload;
    if (event.type === 'target-preparing') { view.state = 'preparing'; view.pendingOperation = p; }
    else if (event.type === 'target-blocked') { view.state = 'blocked'; view.error = p; }
    else if (event.type === 'target-ready') {
      view.target = structuredClone(p.target); view.subject = p.target.subject; view.coverage = p.target.plan.items.map(item => ({ ...item, status: 'pending' }));
      view.confirmation = null; view.captures = []; view.decisions = []; view.error = null;
      for (const finding of view.findings) if (finding.state === 'repairing') finding.state = 'ready-for-recheck';
      view.state = view.findings.some(item => !['resolved', 'dismissed'].includes(item.state)) ? 'awaiting-recheck' : 'inspecting';
    } else if (event.type === 'feedback-recorded') {
      view.findings.push({ ...p.finding, reportedBy: event.actor, reportedAt: event.at, state: p.finding.repairRequested ? 'ready-for-repair' : 'open' });
      view.confirmation = null; view.decisions = []; view.state = 'inspecting';
    } else if (event.type === 'repair-prepared') {
      view.repairAttempts.push({ ...p.attempt, event: event.digest, actionId: event.actionId, admissionRevision: event.revision - 1 });
      const finding = view.findings.find(item => item.id === p.attempt.findingId);
      if (finding) { finding.state = 'repairing'; finding.obligationRefs = p.attempt.obligationRefs;
        finding.classification = 'proposed-covered-defect'; finding.scopeStatus = 'admitted-current-grant';
        finding.mappingProvenance = { actionId: event.actionId, actor: event.actor, at: event.at }; }
      view.state = 'repairing'; view.confirmation = null; view.decisions = [];
    } else if (event.type === 'finding-repair-requested') {
      const finding = view.findings.find(item => item.id === p.findingId);
      if (finding) { finding.state = 'ready-for-repair'; finding.repairRequested = true; }
      view.state = 'inspecting'; view.confirmation = null; view.decisions = [];
    } else if (event.type === 'repair-observed') {
      const attempt = view.repairAttempts.find(item => item.id === p.attemptId);
      if (attempt) Object.assign(attempt, { result: p.result });
      const finding = view.findings.find(item => item.id === attempt?.findingId);
      if (finding) finding.state = p.result.targetId ? 'ready-for-recheck' : 'blocked';
      view.state = p.result.targetId ? 'awaiting-recheck' : 'blocked';
    } else if (event.type === 'finding-rechecked') {
      const finding = view.findings.find(item => item.id === p.findingId);
      if (finding) { finding.recheck = { ...p, actor: event.actor, at: event.at }; finding.state = p.result === 'fixed' ? 'resolved' : p.result === 'blocked' ? 'blocked' : 'open'; }
      view.state = 'inspecting'; view.confirmation = null; view.decisions = [];
    } else if (event.type === 'finding-dispositioned') {
      const finding = view.findings.find(item => item.id === p.findingId);
      if (finding) Object.assign(finding, { state: p.disposition, duplicateOf: p.duplicateOf ?? null, disposition: { ...p, actor: event.actor } });
      view.confirmation = null; view.decisions = [];
    } else if (event.type === 'review-confirmed') {
      if (!view.decisions.length) view.captures = [];
      view.confirmation = { ...p, id: event.digest, actor: event.actor, at: event.at };
      view.coverage = view.coverage.map(item => p.coverage.includes(item.id) ? { ...item, status: 'reviewed' } : item);
      view.state = 'confirmed-awaiting-capture'; view.error = null;
    } else if (event.type === 'capture-started') view.state = 'capturing-evidence';
    else if (event.type === 'capture-blocked') { view.state = 'capture-blocked'; view.error = p; }
    else if (event.type === 'acceptance-blocked') { view.state = 'blocked'; view.error = p; }
    else if (event.type === 'capture-admitted') {
      view.captures = [...new Map([...view.captures, ...p.receipts].map(item => [item.id, item])).values()]; view.state = 'confirmed-awaiting-capture'; view.error = null;
    }
    else if (event.type === 'acceptance-finalized') {
      view.decisions = [...new Map([...view.decisions, ...p.decisions].map(item => [item.dimension, item])).values()];
      view.state = Object.entries(view.target.applicability.dimensions).every(([dimension, status]) => status === 'not-applicable'
        || view.decisions.some(item => item.dimension === dimension)) ? 'accepted' : 'awaiting-acceptance';
    }
    else if (event.type === 'review-stale') { view.state = 'stale'; view.error = p; }
    else if (event.type === 'review-deferred') view.state = 'deferred';
    else if (event.type === 'review-cancelled') view.state = 'cancelled';
    else araFail('ARA_RECORD_INVALID', `Unsupported review event '${event.type}'.`);
  }
  for (const finding of view.findings) findingRoot(view.findings, finding.id);
  view.dimensions = Object.fromEntries(Object.entries(view.target?.applicability?.dimensions ?? {}).map(([dimension, status]) => [dimension,
    status === 'not-applicable' ? status : view.decisions.some(item => item.dimension === dimension) ? 'accepted' : 'pending']));
  return view;
}

function reviewCompletion(view, { targetCurrent, evidenceAvailable, decisionsCurrent = true }) {
  const applicabilityResolved = view.target?.applicability?.resolved === true;
  const coverageSatisfied = view.coverage.length > 0 && view.coverage.every(item => ['reviewed', 'not-applicable'].includes(item.status));
  const findingsDisposed = view.findings.every(item => ['resolved', 'dismissed'].includes(findingRoot(view.findings, item.id).state));
  const required = Object.entries(view.target?.applicability?.dimensions ?? {}).filter(([, state]) => state !== 'not-applicable').map(([key]) => key);
  const requiredDecisionsSatisfied = required.length > 0 && decisionsCurrent && required.every(dimension => view.decisions.some(item => item.dimension === dimension));
  const evidenceAdmitted = evidenceAvailable && view.captures.length > 0 && view.captures.every(item => item.status === 'captured');
  return { applicabilityResolved, targetCurrent, coverageSatisfied, findingsDisposed, requiredDecisionsSatisfied, evidenceAdmitted,
    reviewSatisfied: applicabilityResolved && targetCurrent && coverageSatisfied && findingsDisposed && requiredDecisionsSatisfied && evidenceAdmitted };
}

function assertCanConfirm(view, { targetCurrent, dimensions, coverage, testsReady }) {
  if (!targetCurrent || !view.target?.applicability?.resolved || !['host-bound', 'attested'].includes(view.target.assurance)) araFail('ARA_REVIEW_STALE', 'Inspect a current, verified review target before saying All good.');
  if (['repairing', 'stale', 'cancelled'].includes(view.state)) araFail('ARA_REVIEW_NOT_READY', 'This review needs a current inspection or repair recheck.');
  if (!testsReady) araFail('ARA_CHECKS_NOT_READY', 'Review the authoritative submitted test results first. All good cannot waive failed, missing or incomplete checks.');
  if (view.findings.some(item => !['resolved', 'dismissed'].includes(findingRoot(view.findings, item.id).state))) araFail('ARA_FINDINGS_OPEN', 'Recheck or explicitly dispose the open findings before acceptance.');
  const required = Object.entries(view.target.applicability.dimensions).filter(([, status]) => status !== 'not-applicable').map(([dimension]) => dimension);
  if (!dimensions.length || dimensions.some(dimension => !required.includes(dimension))) araFail('ARA_DIMENSION_INVALID', 'Confirm only the applicable review dimensions.');
  if (view.coverage.some(item => dimensions.includes(item.dimension) && !coverage.includes(item.id))) araFail('ARA_COVERAGE_PENDING', 'Inspect every required journey and state for the selected dimensions.');
}

/** A deterministic, finite report; missing cases are disclosed rather than synthesized. */
function reviewReportPages(results, limits) {
  const rows = results.attempts.flatMap(attempt => (attempt.occurrences ?? []).map((item, index) => ({
    id: `${attempt.attemptId}:${index}`, attemptId: attempt.attemptId, commandId: attempt.commandId,
    name: String(item.name ?? 'Unnamed reported case'), suite: item.suitePath ?? item.className ?? null,
    outcome: ['passed', 'failed', 'errored', 'skipped', 'cancelled', 'timed-out', 'unknown'].includes(item.outcome) ? item.outcome : 'unknown',
    durationMs: item.durationMs ?? null, detail: attempt.caseMessages?.[index] ?? null
  })));
  const pages = [{ kind: 'test-results', id: 'summary', cases: [], summary: results.attempts.map(attempt => ({ attemptId: attempt.attemptId,
    commandId: attempt.commandId, status: attempt.status, tests: attempt.tests ?? null, startedAt: attempt.process?.startedAt ?? null,
    completedAt: attempt.process?.completedAt ?? null, reportedCases: attempt.occurrences?.length ?? 0 })) }];
  for (let index = 0; index < rows.length; index += limits.casesPerPage) pages.push({ kind: 'test-results', id: `cases-${index}`, cases: rows.slice(index, index + limits.casesPerPage) });
  for (const row of rows.filter(item => ['failed', 'errored', 'timed-out'].includes(item.outcome))) pages.push({ kind: 'test-case-detail', id: `detail-${row.id}`, cases: [row] });
  const missingCases = results.attempts.reduce((total, attempt) => total + Math.max(0, Number(attempt.tests?.discovered ?? 0) - (attempt.occurrences?.length ?? 0)), 0);
  return { pages: pages.slice(0, limits.maximumPages), complete: pages.length <= limits.maximumPages && missingCases === 0,
    requiredPages: pages.length, omittedPages: Math.max(0, pages.length - limits.maximumPages), missingCases, cases: rows.length };
}

/** Validate the whole declared set, not only the presence of a PNG or a caller's success label. */
function validateReviewCaptureSet(view, receipts, policy) {
  if (!view.confirmation || !Array.isArray(receipts)) araFail('ARA_CAPTURE_INVALID', 'Capture needs a retained confirmation and a complete receipt set.');
  const report = reviewReportPages(view.target.results, policy.capture);
  if (!report.complete || reviewDigest(report) !== view.confirmation.capturePlan.reportDigest) araFail('ARA_CAPTURE_INCOMPLETE', 'The confirmed report plan is incomplete or changed.');
  const expected = new Map(report.pages.map(page => [page.id, { kind: page.kind, cases: page.cases.map(item => item.id) }]));
  if (view.confirmation.capturePlan.applicationUi) expected.set('reviewed-current-page', { kind: 'application-ui', cases: [] });
  const seen = new Set();
  for (const receipt of receipts) {
    const { id, ...body } = receipt;
    const item = expected.get(receipt.captureItem);
    if (!item || seen.has(receipt.captureItem) || id !== reviewDigest(body) || receipt.confirmation !== view.confirmation.id
        || receipt.trigger !== view.confirmation.hostAction.id || receipt.targetId !== view.target.id || receipt.captureKind !== item.kind
        || reviewDigest(receipt.cases) !== reviewDigest(item.cases) || receipt.sourceSnapshot !== view.target.snapshot.digest
        || receipt.resultsDigest !== view.target.results.digest || reviewDigest(receipt.subject) !== reviewDigest(view.target.subject)
        || receipt.status !== 'captured' || !Number.isFinite(Date.parse(receipt.capturedAt)) || Date.parse(receipt.capturedAt) < Date.parse(view.confirmation.at)
        || !/^sha256:[a-f0-9]{64}$/u.test(receipt.sha256) || receipt.artifactRef?.digest !== receipt.sha256
        || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.image?.format !== 'png'
        || !Number.isSafeInteger(receipt.image.width) || !Number.isSafeInteger(receipt.image.height)) araFail('ARA_CAPTURE_INVALID', 'A capture receipt does not bind the confirmed target, report cases and actual post-confirmation image.');
    seen.add(receipt.captureItem);
  }
  if (seen.size !== expected.size) araFail('ARA_CAPTURE_INCOMPLETE', 'Required confirmed capture items are missing; no acceptance was finalized.');
  if (receipts.reduce((sum, receipt) => sum + receipt.bytes, 0) > policy.capture.maximumBytes) araFail('ARA_CAPTURE_INCOMPLETE', 'The complete image set exceeds its adopted byte bound.');
  return receipts;
}

return Object.freeze({profile:APPLICATION_REVIEW_VALUES_PROFILE,normalizeApplicationReview,reviewDigest,applicationReviewPolicy,reviewSubject,reviewApplicability,appendReviewEvent,validateReviewSession,newReviewSession,findingRoot,findingRepairAttempts,projectReview,reviewCompletion,assertCanConfirm,reviewReportPages,validateReviewCaptureSet});
}
