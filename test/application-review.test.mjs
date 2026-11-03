import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeApplicationReview, reviewApplicability, newReviewSession, appendReviewEvent, projectReview,
  reviewDigest, findingRoot, assertCanConfirm, reviewCompletion, reviewReportPages, applicationReviewPolicy } from '../src/application-review-contract.mjs';
import { createApplicationReviewHumanServer, consumeReviewHumanAction, applicationReviewPage } from '../src/application-review-human.mjs';
import { serveReviewBuild, applicationResultHtml, evaluateReviewPage } from '../src/application-review-preview.mjs';
import { recordApplicationReviewAcceptance, applicationReviewSlotResults } from '../src/verification/witness-records.mjs';
import { contractResult } from '../src/verification/contract-results.mjs';
import { applicationReviewAgentView } from '../src/commands/app-review.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { findReviewSession } from '../src/application-review-read.mjs';
import { applicationReviewPhase } from '../src/code-delivery-policy.mjs';

const actor = { name: 'Review User', email: 'review@example.invalid' };
const at = '2026-11-03T10:00:00.000Z';
function fixture(surface = 'backend') {
  const policy = normalizeApplicationReview({ mode: 'required', surface });
  const subject = { kind: 'story-phase', workId: 'review-example', phaseId: 'deliver', generation: 1 };
  const session = newReviewSession({ id: 'ARA-0123456789abcdef01234567', subject, policy });
  const target = { id: 'target-1', subject, assurance: 'host-bound', applicability: reviewApplicability(policy, []),
    policyDigest: reviewDigest(policy),
    plan: { digest: 'plan-1', items: [{ id: 'criterion-1', dimension: 'functional', text: 'Saved name remains after reload' }] },
    snapshot: { digest: 'snapshot-1' }, results: { digest: 'results-1', packet: 'packet-1', ready: true, attempts: [] } };
  const append = (type, payload = {}, actionId = `action-${session.revision + 1}`) => appendReviewEvent(session, { actionId, expectedRevision: session.revision, type, payload, actor, at });
  append('target-ready', { target });
  return { session, target, append };
}

test('ARA is explicit adoption, validates finite limits and rejects authority-shaped extra fields', () => {
  assert.equal(normalizeApplicationReview(undefined), null);
  const policy = normalizeApplicationReview({}); assert.equal(policy.mode, 'optional'); assert.equal(policy.repairAttempts, 2);
  assert.deepEqual(normalizeApplicationReview(policy), policy);
  assert.throws(() => normalizeApplicationReview({ schemaVersion: 2 }), { code: 'SCHEMA_VERSION_FUTURE' });
  assert.throws(() => applicationReviewPolicy({ resolution: { applicationReview: policy, presence: { status: 'required' } } }), { code: 'ARA_AUTHORITY_ADAPTER_UNAVAILABLE' });
  for (const value of [{ mode: 'anything' }, { approvedBy: 'model' }, { repairAttempts: 0 }, { totalRepairAttempts: Infinity },
    { preview: { outputDirectory: '../elsewhere' } }, { capture: { maximumPages: 0 } }, { capture: { viewport: { width: 1, height: 800 } } }]) {
    assert.throws(() => normalizeApplicationReview(value));
  }
});

test('observed UI strengthens a backend profile and unknown scope never becomes inapplicable', () => {
  const backend = normalizeApplicationReview({ surface: 'backend' });
  assert.equal(reviewApplicability(backend, ['src/server.java']).dimensions.visual, 'not-applicable');
  assert.equal(reviewApplicability(backend, ['src/NewDialog.tsx']).dimensions.visual, 'pending');
  assert.equal(reviewApplicability(normalizeApplicationReview({}), ['src/unknown.js']).resolved, false);
});

test('event chain verifies tampering and CAS; transport replay cannot create another event', () => {
  const { session } = fixture();
  const body = { actionId: 'action-feedback', expectedRevision: 1, type: 'feedback-recorded', payload: { finding: { id: 'f1', observed: 'Save disappears', repairRequested: true } }, actor, at };
  assert.equal(appendReviewEvent(session, body).replay, false);
  assert.equal(appendReviewEvent(session, body).replay, true);
  assert.equal(session.revision, 2);
  assert.throws(() => appendReviewEvent(session, { ...body, payload: {} }), { code: 'ARA_IDEMPOTENCY_CONFLICT' });
  assert.throws(() => appendReviewEvent(session, { ...body, actionId: 'other-action' }), { code: 'ARA_REVISION_CONFLICT' });
  session.events[0].payload.target.id = 'tampered';
  assert.throws(() => projectReview(session), { code: 'ARA_RECORD_INVALID' });
});

test('tests and model repair claims never resolve a finding; actual recheck does', () => {
  const { session, append } = fixture();
  append('feedback-recorded', { finding: { id: 'f1', targetId: 'target-1', observed: 'Name lost', repairRequested: true } });
  append('repair-prepared', { attempt: { id: 'attempt-1', findingId: 'f1', rootFindingId: 'f1' } });
  append('repair-observed', { attemptId: 'attempt-1', result: { testsPassed: true, targetId: 'target-2' } });
  assert.equal(projectReview(session).findings[0].state, 'ready-for-recheck');
  append('finding-rechecked', { findingId: 'f1', result: 'cannot-reproduce', targetId: 'target-2' });
  assert.equal(projectReview(session).findings[0].state, 'open');
  append('finding-rechecked', { findingId: 'f1', result: 'fixed', targetId: 'target-2' });
  assert.equal(projectReview(session).findings[0].state, 'resolved');
  assert.equal(projectReview(session).repairAttempts.length, 1);
});

test('duplicates retain the root obligation and reject dangling references and cycles', () => {
  const findings = [{ id: 'a', state: 'open' }, { id: 'b', state: 'duplicate', duplicateOf: 'a' }];
  assert.equal(findingRoot(findings, 'b').state, 'open');
  assert.throws(() => findingRoot([{ id: 'a', duplicateOf: 'b' }, { id: 'b', duplicateOf: 'a' }], 'a'), { code: 'ARA_FINDING_LINEAGE_INVALID' });
  assert.throws(() => findingRoot([{ id: 'a', duplicateOf: 'missing' }], 'a'), { code: 'ARA_FINDING_LINEAGE_INVALID' });
});

test('confirmation requires current target, actual passing tests, coverage and disposed findings', () => {
  const { session, append } = fixture();
  const params = { targetCurrent: true, testsReady: true, dimensions: ['functional'], coverage: ['criterion-1'] };
  assert.doesNotThrow(() => assertCanConfirm(projectReview(session), params));
  for (const invalid of [{ targetCurrent: false }, { testsReady: false }, { dimensions: ['visual'] }, { coverage: [] }]) assert.throws(() => assertCanConfirm(projectReview(session), { ...params, ...invalid }));
  append('feedback-recorded', { finding: { id: 'f1', repairRequested: false } });
  assert.throws(() => assertCanConfirm(projectReview(session), params), { code: 'ARA_FINDINGS_OPEN' });
});

test('capture failure preserves confirmation; new target or finding invalidates acceptance', () => {
  const { session, target, append } = fixture();
  append('review-confirmed', { dimensions: ['functional'], coverage: ['criterion-1'], targetId: target.id, capturePlan: {} });
  const confirmation = projectReview(session).confirmation.id;
  append('capture-blocked', { code: 'ARA_CAPTURE_FAILED', message: 'Browser stopped' });
  assert.equal(projectReview(session).confirmation.id, confirmation);
  assert.equal(reviewCompletion(projectReview(session), { targetCurrent: true, evidenceAvailable: false }).reviewSatisfied, false);
  append('capture-admitted', { receipts: [{ status: 'captured' }] });
  append('acceptance-finalized', { decisions: [{ dimension: 'functional' }] });
  assert.equal(reviewCompletion(projectReview(session), { targetCurrent: true, evidenceAvailable: true }).reviewSatisfied, true);
  append('target-ready', { target: { ...target, id: 'target-2' } });
  assert.equal(projectReview(session).confirmation, null);
  assert.equal(projectReview(session).decisions.length, 0);
  assert.equal(session.events.some(event => event.digest === confirmation), true);
});

test('report pagination preserves real outcomes, discloses limits and never invents missing cases', () => {
  const attempts = [{ attemptId: 'run-1', commandId: 'api', status: 'failed', tests: { discovered: 5 }, occurrences: [
    { name: '<script>unsafe</script>', outcome: 'passed' }, { name: 'Denied request', outcome: 'failed' },
    { name: 'Cancelled', outcome: 'cancelled' }, { name: 'Unexpected', outcome: 'something-new' } ] }];
  const all = reviewReportPages({ attempts }, { casesPerPage: 2, maximumPages: 10 });
  assert.equal(all.missingCases, 1); assert.equal(all.complete, false);
  assert.equal(all.pages.flatMap(page => page.cases).some(item => item.outcome === 'cancelled'), true);
  assert.equal(all.pages.flatMap(page => page.cases).some(item => item.outcome === 'unknown'), true);
  const limited = reviewReportPages({ attempts }, { casesPerPage: 1, maximumPages: 1 });
  assert.ok(limited.omittedPages > 0); assert.equal(limited.complete, false);
  const html = applicationResultHtml(all.pages[1], { id: 't1', snapshot: { digest: 's1' }, results: { packet: 'p1' } });
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
});

test('a local human action is target/revision/input bound, single-use, and cannot be minted by caller text', async t => {
  let handle; let payload; let calls = 0;
  const root = path.resolve(os.tmpdir(), 'ara-human-test');
  const server = await createApplicationReviewHumanServer({ root, sessionId: 'session-1', read: async () => ({ revision: 3, target: { id: 't1' } }),
    render: (_view, form) => JSON.stringify(form), perform: async event => { calls += 1; payload = { dimensions: ['functional'] }; handle = event.grant(payload); return { message: 'Confirmed for test' }; } });
  t.after(server.close);
  const form = await (await fetch(server.url)).json();
  const body = new URLSearchParams({ nonce: form.nonce, actionId: form.actionId, action: 'accept' });
  assert.equal((await fetch(new URL(form.route, server.origin), { method: 'POST', body })).status, 403);
  assert.equal((await fetch(new URL(form.route, server.origin), { method: 'POST', body, headers: { Origin: server.origin, 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 200);
  assert.equal((await fetch(new URL(form.route, server.origin), { method: 'POST', body, headers: { Origin: server.origin, 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 200);
  assert.equal(calls, 1, 'A lost response must not repeat a launch, capture or human decision.');
  const expected = { root, sessionId: 'session-1', revision: 3, action: 'review-confirmed', inputDigest: reviewDigest(payload) };
  assert.throws(() => consumeReviewHumanAction({ actor: 'model', confirmed: true }, expected), { code: 'ARA_HUMAN_ACTION_REQUIRED' });
  assert.doesNotThrow(() => consumeReviewHumanAction(handle, expected));
  assert.throws(() => consumeReviewHumanAction(handle, expected), { code: 'ARA_HUMAN_ACTION_REQUIRED' });
});

test('late feedback keeps its inspected target while acceptance requires a fresh card', async t => {
  let view = { revision: 3, target: { id: 'old-target' } }; let observed;
  const server = await createApplicationReviewHumanServer({ root: os.tmpdir(), sessionId: 'late-feedback', read: async () => view,
    render: (_view, form) => JSON.stringify(form), perform: async event => { observed = event; return { message: 'Retained' }; } });
  t.after(server.close);
  const form = await (await fetch(server.url)).json();
  view = { revision: 5, target: { id: 'replacement-target' } };
  const post = action => fetch(new URL(form.route, server.origin), { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nonce: form.nonce, actionId: form.actionId, action, observed: 'Save did not persist' }) });
  assert.equal((await post('accept')).status, 409);
  assert.equal((await post('report-and-fix')).status, 200);
  assert.equal(observed.expectedRevision, 5); assert.equal(observed.input.targetId, 'old-target');
});

test('partial dimensions remain owed and Copilot gets compact state with exact repair admission', () => {
  const { session, append } = fixture('web');
  append('review-confirmed', { dimensions: ['visual'], coverage: ['criterion-1'] });
  append('acceptance-finalized', { decisions: [{ id: 'd1', dimension: 'visual' }] });
  const view = projectReview(session);
  assert.equal(view.state, 'awaiting-acceptance'); assert.equal(view.dimensions.visual, 'accepted'); assert.equal(view.dimensions.functional, 'pending');
  const packet = applicationReviewAgentView({ resultType: 'sflow-application-review', session: view,
    event: session.events.at(-1), commandGuidance: { copilotCommand: '/sf-app-review', command: 'singularity-flow app-review inspect ARA-0123456789abcdef01234567' } });
  assert.equal(packet.sessionId, session.id); assert.ok(!('target' in packet) && !('event' in packet));
  const admission = agentAct({ resultType: 'sflow-phase-entry', status: 'attention-required', applicationReviewRepair: { findings: [{ id: 'f1' }] } });
  assert.equal(admission.state, 'repair'); assert.ok(admission.read.includes('applicationReviewRepair'));
  assert.equal(agentAct({ resultType: 'sflow-phase-entry', status: 'authoring-entry', applicationReviewRepair: { attempts: [{ id: 'a1' }] } }).state, 'author');
});

test('successor generations and later reporting phases reuse the persistent code-review lineage', () => {
  const { session } = fixture();
  const workflow = { currentPhase: 'release', phaseOrder: ['deliver', 'release'], phases: {
    deliver: { id: 'deliver', generation: 2, generationPolicy: { task: 'code' } }, release: { id: 'release', generation: 0 }
  }, applicationReviews: [session] };
  assert.equal(applicationReviewPhase(workflow), 'deliver');
  assert.equal(findReviewSession(workflow).id, session.id, 'The session root keeps generation 1; its current target may be generation 2.');
});

test('static preview serves only its immutable build, rejects writes and does not read ambient files', async t => {
  const bytes = Buffer.from('<h1>Immutable application</h1>');
  const server = await serveReviewBuild(new Map([['index.html', bytes], ['app.js', Buffer.from('/* actual built bytes */')]]));
  t.after(server.close);
  assert.deepEqual(Buffer.from(await (await fetch(server.origin)).arrayBuffer()), bytes);
  assert.equal((await fetch(server.origin)).headers.get('x-sflow-review-instance'), server.instance);
  assert.equal((await fetch(`${server.origin}/outside.txt`)).status, 404);
  assert.equal((await fetch(server.origin, { method: 'POST' })).status, 403);
  assert.equal(server.manifest.length, 2);
});

test('a non-responsive browser frame has a finite deadline without a fabricated result', async () => {
  await assert.rejects(evaluateReviewPage({ evaluate: () => new Promise(() => {}) }, () => null, 20), { code: 'ARA_TARGET_UNVERIFIED' });
});

test('decision bridge retains live review basis and refuses images captured before confirmation', () => {
  const workflow = {};
  const confirmation = { id: 'confirmation-1', hostAction: { id: 'human-action-1' }, targetId: 'target-1', dimensions: ['functional'],
    reviewedBasis: 'retained-structured-results', at };
  const target = { id: 'target-1', subject: { kind: 'story-phase' } };
  const decisions = [{ id: 'decision-1', dimension: 'functional', confirmation: confirmation.id, targetId: target.id }];
  const captures = [{ confirmation: confirmation.id, targetId: target.id, status: 'captured', capturedAt: '2026-11-03T10:00:01.000Z' }];
  recordApplicationReviewAcceptance(workflow, { confirmation, target, decisions, captures, actor, authorityGroup: 'reviewers', at });
  assert.equal(workflow.applicationAcceptanceRecords[0].screenshotsInspectedByHuman, false);
  assert.equal(workflow.applicationAcceptanceRecords[0].observationBasis, 'retained-structured-results');
  assert.equal(workflow.witnessRecords, undefined);
  assert.throws(() => recordApplicationReviewAcceptance({}, { confirmation, target, decisions, captures: [{ ...captures[0], capturedAt: '2026-11-03T09:59:59.000Z' }], actor, authorityGroup: 'reviewers', at }), { code: 'ARA_ACCEPTANCE_INVALID' });
});

test('live acceptance satisfies its visual contract slots without manufacturing another screenshot review', () => {
  const { target, session } = fixture('web');
  target.plan.items = [{ id: 'visual-item', dimension: 'visual', source: { kind: 'approved-clause', id: 'REVIEW-EXAMPLE:AC-001' }, slots: [{ slot: 'saved-value', target: 'saved value after reload' }] }];
  const workflow = { workItem: { id: 'review-example' }, resolution: { applicationReview: session.policy }, phaseOrder: ['deliver'], phases: { deliver: { generation: 1 } } };
  const confirmation = { id: 'confirmation', targetId: target.id, dimensions: ['visual'], coverage: ['visual-item'], at, reviewedBasis: 'live-application-and-retained-results', hostAction: { channel: 'local-review', id: 'human-click' } };
  const captures = [{ id: 'receipt', confirmation: 'confirmation', targetId: target.id, status: 'captured', capturedAt: '2026-11-03T10:00:01.000Z' }];
  const decision = { id: 'ARA-WIT-' + '0'.repeat(24), dimension: 'visual', confirmation: confirmation.id, targetId: target.id, captureReceipts: ['receipt'] };
  recordApplicationReviewAcceptance(workflow, { confirmation, captures, decisions: [decision], target, actor, authorityGroup: 'reviewers', at });
  const view = { id: session.id, target, decisions: [decision], captures };
  const records = applicationReviewSlotResults(workflow, view, { targetCurrent: true, evidenceAvailable: true });
  assert.equal(records.length, 1); assert.equal(workflow.witnessRecords, undefined, 'No fake answers to the old screenshot checklist.');
  const contract = { combination: 'all', slots: [{ slot: 'saved-value', method: 'visual', role: 'primary', witness: { target: 'saved value after reload' } }] };
  assert.equal(contractResult('REVIEW-EXAMPLE:AC-001', contract, [], { submitted: true, rowSubmitted: true, requiredAssurance: 'source-bound', records }).status, 'met');
  assert.deepEqual(applicationReviewSlotResults(workflow, view, { targetCurrent: false, evidenceAvailable: true }), []);
  assert.deepEqual(applicationReviewSlotResults(workflow, view, { targetCurrent: true, evidenceAvailable: false }), []);
  workflow.phases.deliver.deliveryEvidence = { sourceTreeSha256: 'changed' };
  assert.deepEqual(applicationReviewSlotResults(workflow, view, { targetCurrent: true, evidenceAvailable: true }), []);
});
