import assert from 'node:assert/strict';
import test from 'node:test';
import { storyRiskApplyArgs, storyRiskChoices, storyRiskPreviewArgs } from '../apps/vscode/src/views/story-test-risk.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const subject = { workId: 'recovery', phaseId: 'implementation' };
const terms = { issueId: 'issue-one', operation: 'publish', reason: 'The exact unavailable check was reviewed',
  followUpOwner: 'maintainer', remediationRef: 'Restore the approved runner' };
const base = { schemaVersion: 1, resultType: 'story-test-risk-plan', workId: subject.workId, phaseId: subject.phaseId,
  operation: 'publish', status: 'ready', ready: true, executed: false, stateChanged: false, planDigest: digest };
const preview = { ...base, decision: { ...terms, category: 'validation-unavailable' } };

test('risk UI constructs only fixed read commands and exact subject/transition/terms', () => {
  assert.deepEqual(storyRiskPreviewArgs('risks', subject, { operation: 'submit' }), [
    'story', 'test-policy', 'risks', '--work-id', 'recovery', '--phase', 'implementation', '--operation', 'submit', '--json'
  ]);
  assert.ok(!storyRiskPreviewArgs('accept-risk', subject, terms).includes('--apply'));
  assert.throws(() => storyRiskPreviewArgs('shell', subject));
  assert.throws(() => storyRiskPreviewArgs('risks', { ...subject, workId: '../other' }));
  assert.throws(() => storyRiskPreviewArgs('accept-risk', subject, { ...terms, reason: 'short' }));
  assert.throws(() => storyRiskPreviewArgs('accept-risk', subject, { ...terms, followUpOwner: 'admin\nactor' }));
  assert.throws(() => storyRiskPreviewArgs('revoke-risk', subject, { reason: terms.reason }));
});

test('only eligible unavailable validation has an accept card; integrity and actual failures are not waived', () => {
  const rows = storyRiskChoices({ ...base, issues: [
    { id: 'issue-one', category: 'validation-unavailable', riskEligible: true, severity: 'noncritical' },
    { id: 'issue-two', category: 'identity', riskEligible: true, severity: 'critical' },
    { id: 'issue-three', category: 'new-test-failure', riskEligible: true, severity: 'noncritical' },
    { id: 'issue-four', category: 'validation-unavailable', riskEligible: false, severity: 'noncritical' },
    { id: 'issue-five;evil', category: 'validation-unavailable', riskEligible: true, severity: 'noncritical' }
  ], legalActions: [{ command: 'sh', args: ['-c', 'untrusted'] }] }, subject);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].terms.issueId, 'issue-one');
  assert.equal(rows[0].action, 'accept-risk');
});

test('agreement authorization and exact revocation/reattest cards never infer missing IDs', () => {
  const rows = storyRiskChoices({ ...base, agreementAuthorization: { status: 'review-required', recordSha256: digest },
    decisions: [{ kind: 'phase-risk-decision', recordSha256: digest, subject: { workId: subject.workId } },
      { kind: 'phase-risk-decision', recordSha256: digest, subject: { workId: 'other' } }] }, subject);
  assert.deepEqual(rows.map(row => row.action), ['attest-risk', 'revoke-risk', 'attest-risk']);
  assert.ok(rows.every(row => row.terms.recordSha256 === digest));
});

test('risk terminal preparation requires ready exact preview, subject, issue, terms and transition', () => {
  const args = storyRiskApplyArgs(preview, 'accept-risk', subject, terms);
  assert.deepEqual(args, [...storyRiskPreviewArgs('accept-risk', subject, terms).slice(0, -1), '--apply', '--confirm', digest]);
  assert.deepEqual(storyRiskApplyArgs({ resultType: 'command-result', data: preview }, 'accept-risk', subject, terms), args);
  for (const change of [{ workId: 'other' }, { phaseId: 'verification' }, { operation: 'approve' }, { status: 'blocked' },
    { ready: false }, { stateChanged: true }, { executed: true }, { planDigest: 'bad' }, { resultType: 'other' },
    { decision: { ...preview.decision, reason: 'Different reviewed reason' } },
    { decision: { ...preview.decision, category: 'new-test-failure' } }]) {
    assert.equal(storyRiskApplyArgs({ ...preview, ...change }, 'accept-risk', subject, terms), null);
  }
  assert.equal(storyRiskApplyArgs(base, 'risks', subject, {}), null);
});

test('revocation and reattestation terminal command is bound to exact record and action', () => {
  const record = { ...base, resultType: 'story-test-risk-record-plan', action: 'revoked', recordSha256: digest, reason: terms.reason };
  const selection = { recordSha256: digest, reason: terms.reason };
  assert.ok(storyRiskApplyArgs(record, 'revoke-risk', subject, selection).includes('--apply'));
  assert.equal(storyRiskApplyArgs({ ...record, recordSha256: `sha256:${'b'.repeat(64)}` }, 'revoke-risk', subject, selection), null);
  assert.equal(storyRiskApplyArgs(record, 'attest-risk', subject, selection), null);
  assert.ok(storyRiskApplyArgs({ ...record, action: 'attested' }, 'attest-risk', subject, selection).includes('--apply'));
});

test('stale, malformed or pending-publication risk inspection has no actionable card', () => {
  const valid = { ...base, agreementAuthorization: { status: 'review-required', recordSha256: digest } };
  for (const change of [{ workId: 'elsewhere' }, { phaseId: 'verification' }, { schemaVersion: 2 }, { resultType: 'other' },
    { executed: true }, { stateChanged: true }, { status: 'publication-pending' }]) {
    assert.deepEqual(storyRiskChoices({ ...valid, ...change }, subject), []);
  }
});
