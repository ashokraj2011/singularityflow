import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { appendTrpRecord, readTrpRecord, loadTrpRecords, appendTrpAuthorityReceipt, consumeTrpAuthority, trpAuthorityReview, loadTrpAuthorityVerifier } from '../src/test-recovery-store.mjs';
import { sealTrpRecord } from '../src/test-recovery-policy.mjs';
import { createTrpFixture } from './test-recovery-policy.fixture.mjs';
import { canonicalJson } from '../src/records.mjs';
import { authorizeTrpRecord, TRP_TERMINAL_AVAILABLE } from './test-recovery-terminal.fixture.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-trp-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'TRP Reviewer'); git(root, 'config', 'user.email', 'reviewer@example.com');
  const workRoot = path.join(root, 'custom-work', 'story-1'); await mkdir(workRoot, { recursive: true });
  return { root, workRoot };
}
const delegation = { authorities: ['risk-reviewers'], minimum: 1, minimumAssurance: 'configured-local-review', categories: ['known-test-failure'], transitions: ['publish', 'submit'] };
const pinnedAuthorities = { 'risk-reviewers': { label: 'Risk reviewers', allowAnyGitIdentity: false, members: [{ email: 'reviewer@example.com' }] } };

test('append-only records use resolved custom work roots and round trip idempotently', async (t) => {
  const { workRoot } = await workspace(t); const fixture = createTrpFixture();
  const created = await appendTrpRecord(workRoot, fixture.agreement);
  assert.equal(created.created, true); assert.match(created.relativePath, /agreements[/\\]revision-1.json$/u);
  assert.equal((await appendTrpRecord(workRoot, fixture.agreement)).created, false);
  assert.deepEqual(await readTrpRecord(workRoot, fixture.agreement), fixture.agreement);
  await appendTrpRecord(workRoot, fixture.observation);
  assert.equal((await loadTrpRecords(workRoot)).length, 2);
  const changed = sealTrpRecord({ ...fixture.agreement, confirmedPlanSha256: fixture.hash('other confirmed plan') });
  await assert.rejects(appendTrpRecord(workRoot, changed), { code: 'TRP_IMMUTABLE_RECORD' });
  assert.deepEqual(await readTrpRecord(workRoot, fixture.agreement), fixture.agreement);
});

test('path traversal, symlink parents and symlink records are refused without changing targets', async (t) => {
  const { root, workRoot } = await workspace(t); const fixture = createTrpFixture();
  await assert.rejects(readTrpRecord(workRoot, { kind: 'phase-risk-decision', id: '../outside' }));
  const outside = path.join(root, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(workRoot, 'context'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(appendTrpRecord(workRoot, fixture.agreement), /ordinary directory/u);
  await rm(path.join(workRoot, 'context'));
  await appendTrpRecord(workRoot, fixture.agreement);
  const target = path.join(outside, 'preserved.txt'); await writeFile(target, 'preserved');
  const link = path.join(workRoot, 'context', 'test-recovery', 'agreements', 'revision-2.json');
  await symlink(target, link);
  const revised = sealTrpRecord({ ...fixture.agreement, id: 'agreement-2', revision: 2, parentRevision: 1 });
  await assert.rejects(appendTrpRecord(workRoot, revised), /ordinary file/u);
  assert.equal(await readFile(target, 'utf8'), 'preserved');
});

test('tampered stored bytes and mismatched requested identities fail verification', async (t) => {
  const { workRoot } = await workspace(t); const fixture = createTrpFixture();
  const stored = await appendTrpRecord(workRoot, fixture.observation);
  await assert.rejects(readTrpRecord(workRoot, { ...fixture.observation, recordSha256: fixture.hash('wrong') }), /requested identity/u);
  await writeFile(stored.path, JSON.stringify({ ...fixture.observation, observedOutcome: 'passed' }));
  await assert.rejects(readTrpRecord(workRoot, fixture.observation), /digest mismatch/u);
  await assert.rejects(loadTrpRecords(workRoot), /digest mismatch/u);
});

test('interrupted temporary writes preserve diagnosis and never poison an immutable final record', async (t) => {
  const { workRoot } = await workspace(t); const fixture = createTrpFixture();
  const directory = path.join(workRoot, 'context', 'test-recovery', 'runs'); await mkdir(directory, { recursive: true });
  const interrupted = path.join(directory, 'run-1.json.pending-interrupted');
  await writeFile(interrupted, '{"partial":');
  const writes = await Promise.all([appendTrpRecord(workRoot, fixture.observation), appendTrpRecord(workRoot, fixture.observation)]);
  assert.equal(writes.filter((entry) => entry.created).length, 1);
  assert.deepEqual(await readTrpRecord(workRoot, fixture.observation), fixture.observation);
  assert.equal(await readFile(interrupted, 'utf8'), '{"partial":');
  assert.deepEqual((await readdir(directory)).sort(), ['run-1.json', 'run-1.json.pending-interrupted']);
  assert.equal((await loadTrpRecords(workRoot)).length, 1);
});

test('review card binds exact decision, plan confirmation, and selected transitions', () => {
  const fixture = createTrpFixture(); const review = trpAuthorityReview(fixture.decision, fixture.policy);
  assert.equal(review.action.confirmation.required, true);
  assert.equal(review.action.recordSha256, fixture.decision.recordSha256);
  assert.equal(review.plan.record.reason, fixture.decision.reason);
  const changed = sealTrpRecord({ ...fixture.decision, transitions: ['publish'] });
  assert.notEqual(trpAuthorityReview(changed, fixture.policy).plan.planHash, review.plan.planHash);
});

test('plain actor objects and fabricated witness objects cannot append authority receipts', async (t) => {
  const { workRoot } = await workspace(t);
  await assert.rejects(appendTrpAuthorityReceipt(workRoot, { principal: 'reviewer@example.com', authorized: true }), { code: 'TRP_AUTHORITY_REQUIRED' });
  await assert.rejects(appendTrpRecord(workRoot, { kind: 'trp-authority-receipt' }), { code: 'TRP_AUTHORITY_REQUIRED' });
});

test('risk consumption requires exact review and live terminal witness, even for a pinned actor', async (t) => {
  const { root } = await workspace(t); const fixture = createTrpFixture();
  const decision = sealTrpRecord({ ...fixture.decision, issuer: { principal: 'reviewer@example.com', channel: 'terminal' }, transitions: ['publish', 'submit'] });
  const review = trpAuthorityReview(decision, fixture.policy);
  const args = { record: decision, policy: fixture.policy, pinnedAuthorities, delegation, review, token: '00000000-0000-4000-8000-000000000000' };
  await assert.rejects(consumeTrpAuthority(root, args), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  await assert.rejects(consumeTrpAuthority(root, { ...args, review: { ...review, plan: { ...review.plan, planHash: fixture.hash('changed') } } }), { code: 'TRP_REVIEW_STALE' });
  await assert.rejects(consumeTrpAuthority(root, { ...args, delegation: { ...delegation, minimumAssurance: 'signed-human' } }), { code: 'TRP_AUTHORITY_REQUIRED' });
  await assert.rejects(consumeTrpAuthority(root, { ...args, delegation: { ...delegation, categories: [] } }), { code: 'TRP_AUTHORITY_REQUIRED' });
});

test('durability refuses pending publication and uncommitted records', async (t) => {
  const { root, workRoot } = await workspace(t); const fixture = createTrpFixture();
  await appendTrpRecord(workRoot, fixture.agreement); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Record agreement');
  const localCommit = git(root, 'rev-parse', 'HEAD');
  await assert.rejects(loadTrpAuthorityVerifier({ root, workRoot, policy: fixture.policy, pinnedAuthorities, delegation, localCommit }), { code: 'TRP_PUBLICATION_PENDING' });
  const verifier = await loadTrpAuthorityVerifier({ root, workRoot, policy: fixture.policy, pinnedAuthorities, delegation, localCommit, localOnly: true });
  assert.equal(verifier(fixture.agreement, { policy: fixture.policy }), null);
});

test('fabricated public receipt and ordinary Git commit cannot manufacture terminal origin', async (t) => {
  const { root, workRoot } = await workspace(t); const fixture = createTrpFixture();
  const agreement = sealTrpRecord({ ...fixture.agreement, issuer: { principal: 'reviewer@example.com', channel: 'terminal' } });
  const review = trpAuthorityReview(agreement, fixture.policy);
  // Public receipt hashes, actor identity and even committed exact bytes are not consent.
  const receipt = sealTrpRecord({ ...fixture.envelope('trp-authority-receipt', 'receipt-1', agreement.subject), issuer: agreement.issuer,
    authorizedRecordSha256: agreement.recordSha256, policyAuthoritySha256: fixture.policy.authoritySha256,
    confirmationSha256: agreement.confirmedPlanSha256, capability: 'trp-agreement', transitions: [], issuedAt: agreement.createdAt,
    authorizationRef: 'receipt-1', authorityGroup: 'risk-reviewers', assurance: 'configured-local-review', reviewPlanSha256: review.plan.planHash,
    reviewActionId: review.action.actionId, actionAuthorizationId: 'authorization-1', questionId: 'question-1', answerReceipt: 'answer-1',
    actor: { name: 'TRP Reviewer', email: 'reviewer@example.com', login: null } });
  await appendTrpRecord(workRoot, agreement);
  const authDir = path.join(workRoot, 'context', 'test-recovery', 'authorizations'); await mkdir(authDir);
  await writeFile(path.join(authDir, 'receipt-1.json'), canonicalJson(receipt));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Published review receipt'); const localCommit = git(root, 'rev-parse', 'HEAD');
  const options = { root, workRoot, policy: fixture.policy, pinnedAuthorities, delegation, localCommit, remoteAcknowledgedCommit: localCommit };
  const verifier = await loadTrpAuthorityVerifier(options);
  assert.equal(verifier(agreement, { policy: fixture.policy }), null);
});

test('real terminal origin survives restart and binds pin, exact bytes, host and revocation', { skip: !TRP_TERMINAL_AVAILABLE }, async (t) => {
  const { root, workRoot } = await workspace(t); const fixture = createTrpFixture();
  const agreement = sealTrpRecord({ ...fixture.agreement, issuer: { principal: 'reviewer@example.com', channel: 'terminal' } });
  const receipt = await authorizeTrpRecord(root, workRoot, agreement, { policy: fixture.policy, pinnedAuthorities, delegation });
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Published reviewed receipt'); const localCommit = git(root, 'rev-parse', 'HEAD');
  const options = { root, workRoot, policy: fixture.policy, pinnedAuthorities, delegation, localCommit, remoteAcknowledgedCommit: localCommit };
  const verifier = await loadTrpAuthorityVerifier(options);
  assert.equal(verifier(agreement, { policy: fixture.policy }).durable, true);
  assert.equal(verifier(agreement, { policy: { ...fixture.policy, authoritySha256: fixture.hash('other-pin') } }), null);
  const authDir = path.join(workRoot, 'context', 'test-recovery', 'authorizations');
  const changed = sealTrpRecord({ ...receipt, actor: { ...receipt.actor, email: 'attacker@example.com' } });
  await writeFile(path.join(authDir, `${receipt.id}.json`), canonicalJson(changed));
  const uncommitted = await loadTrpAuthorityVerifier(options);
  assert.equal(uncommitted(agreement, { policy: fixture.policy }), null);
  const revoked = await loadTrpAuthorityVerifier({ ...options, records: [agreement, receipt], revokedAtByRecord: new Map([[agreement.recordSha256, '2026-10-03T00:00:00Z']]) });
  assert.equal(revoked(agreement, { policy: fixture.policy }).revokedAt, '2026-10-03T00:00:00Z');
  const clone = path.join(root, 'other-host'); git(root, 'clone', '-q', root, clone);
  const cloneVerifier = await loadTrpAuthorityVerifier({ ...options, root: clone, workRoot: path.join(clone, 'custom-work', 'story-1') });
  assert.equal(cloneVerifier(agreement, { policy: fixture.policy }), null, 'a public clone must re-review on its host');
  const origin = path.join(root, '.git', 'singularity-flow', 'trp-review-origins', `${receipt.recordSha256.slice(7)}.origin`);
  await writeFile(origin, '0'.repeat(64));
  const alteredOrigin = await loadTrpAuthorityVerifier({ ...options, records: [agreement, receipt] });
  assert.equal(alteredOrigin(agreement, { policy: fixture.policy }), null, 'a fabricated origin cannot replay');
});

test('a delegated reviewer authorizes an agreement without impersonating its immutable author', { skip: !TRP_TERMINAL_AVAILABLE }, async (t) => {
  const { root, workRoot } = await workspace(t); const fixture = createTrpFixture();
  const agreement = sealTrpRecord({ ...fixture.agreement, issuer: { principal: 'story-author@example.com', channel: 'confirmed-story-intake' } });
  const original = canonicalJson(agreement);
  const receipt = await authorizeTrpRecord(root, workRoot, agreement, { policy: fixture.policy, pinnedAuthorities, delegation });
  assert.equal(receipt.issuer.principal, 'reviewer@example.com');
  assert.equal(receipt.actor.email, 'reviewer@example.com');
  assert.equal(canonicalJson(agreement), original);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Authorize exact agreement');
  const localCommit = git(root, 'rev-parse', 'HEAD');
  const options = { root, workRoot, policy: fixture.policy, pinnedAuthorities, delegation, localCommit, localOnly: true };
  const verifier = await loadTrpAuthorityVerifier(options);
  assert.equal(verifier(agreement, { policy: fixture.policy }).principal, 'reviewer@example.com');
  const wrongGroup = await loadTrpAuthorityVerifier({ ...options,
    pinnedAuthorities: { 'risk-reviewers': { label: 'Different reviewers', allowAnyGitIdentity: false, members: [{ email: 'someone-else@example.com' }] } } });
  assert.equal(wrongGroup(agreement, { policy: fixture.policy }), null);
  const forged = sealTrpRecord({ ...receipt, issuer: { principal: 'story-author@example.com', channel: 'terminal' } });
  await writeFile(path.join(workRoot, 'context', 'test-recovery', 'authorizations', `${receipt.id}.json`), canonicalJson(forged));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Forged author assertion');
  const tampered = await loadTrpAuthorityVerifier({ ...options, localCommit: git(root, 'rev-parse', 'HEAD') });
  assert.equal(tampered(agreement, { policy: fixture.policy }), null);
});

test('durable authenticated revocations remain effective when callers provide a narrowed record set', { skip: !TRP_TERMINAL_AVAILABLE }, async (t) => {
  const { root, workRoot } = await workspace(t); const fixture = createTrpFixture();
  const decision = sealTrpRecord({ ...fixture.decision, transitions: delegation.transitions,
    issuer: { principal: 'reviewer@example.com', channel: 'terminal' } });
  const authority = { policy: fixture.policy, pinnedAuthorities, delegation };
  const decisionReceipt = await authorizeTrpRecord(root, workRoot, decision, authority);
  const effectiveAt = new Date().toISOString();
  const revocation = sealTrpRecord({ ...fixture.envelope('phase-risk-revocation', 'revoke-1'),
    createdAt: effectiveAt, effectiveAt, issuer: decision.issuer,
    agreementSha256: decision.agreementSha256, policyAuthoritySha256: decision.policyAuthoritySha256,
    decisionSha256: decision.recordSha256, category: decision.category, transitions: decision.transitions,
    authorizationRef: 'revocation-authorization', confirmationSha256: fixture.hash('revoke-plan'),
    reason: 'The review is withdrawn pending a fresh engineering investigation.' });
  await authorizeTrpRecord(root, workRoot, revocation, authority);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Publish immutable grant and revocation');
  const localCommit = git(root, 'rev-parse', 'HEAD');
  const options = { root, workRoot, ...authority, localCommit, localOnly: true,
    records: [decision, decisionReceipt] };
  const verifier = await loadTrpAuthorityVerifier(options);
  assert.equal(verifier(decision, { policy: fixture.policy }).revokedAt, effectiveAt);
  assert.equal((await readTrpRecord(workRoot, referenceFor(decision))).recordSha256, decision.recordSha256);
  const clone = path.join(root, 'clone'); git(root, 'clone', '-q', root, clone);
  git(clone, 'config', 'user.name', 'TRP Reviewer'); git(clone, 'config', 'user.email', 'reviewer@example.com');
  const cloneWorkRoot = path.join(clone, 'custom-work', 'story-1');
  const clonedReceipt = await authorizeTrpRecord(clone, cloneWorkRoot, decision, authority);
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'Re-attest original grant');
  const cloneVerifier = await loadTrpAuthorityVerifier({ ...options, root: clone, workRoot: cloneWorkRoot,
    localCommit: git(clone, 'rev-parse', 'HEAD'), records: [decision, clonedReceipt] });
  assert.equal(cloneVerifier(decision, { policy: fixture.policy }), null, 're-attesting a grant cannot discard its durable revocation');
});

function referenceFor(record) { return { kind: record.kind, id: record.id, recordSha256: record.recordSha256 }; }
