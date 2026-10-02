import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertRefusalChanged, forgetRefusal, gateRefusal, GATE_REFUSAL_VERSION, projectGateRefusal, refusalFingerprint, rememberRefusal
} from '../src/evidence/gate-refusal.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { SingularityFlowError } from '../src/util.mjs';

const obligation = (id, responsibility, status, owningSteps = ['build']) => ({
  id, responsibility, subject: id.split(':').at(-1), status, owningSteps,
  facets: { coverage: 'linked', execution: 'not-run', assurance: 'none', review: 'pending', freshness: 'current', exception: 'none' }
});
const evaluation = (obligations, findings = []) => ({
  inputSha256: `sha256:${'a'.repeat(64)}`,
  rows: [{ id: 'W-1:AC-001', obligations }],
  findings
});

test('a gate refusal names the open obligations, the responsible step, what recovers it and what it left untouched', () => {
  const refusal = gateRefusal({
    code: 'STORY_COMPLETION_REFUSED', gate: 'terminal',
    subject: { workId: 'W-1', phase: 'verify', generation: 2 },
    evaluation: evaluation([
      obligation('OBL:W-1:plan:AC-001', 'plan', 'met', ['scope']),
      obligation('OBL:W-1:verify:AC-001', 'verify', 'failed', ['build']),
      obligation('OBL:W-1:review:AC-001', 'review', 'pending', ['verify'])
    ]),
    findings: ['verify approval is missing identity-assurance metadata'],
    actions: ['singularity-flow evidence matrix']
  });
  assert.equal(refusal.schema, GATE_REFUSAL_VERSION);
  assert.deepEqual(refusal.obligations.map((entry) => [entry.id, entry.status]), [
    ['OBL:W-1:verify:AC-001', 'failed'], ['OBL:W-1:review:AC-001', 'pending']
  ], 'only open obligations are named');
  assert.equal(refusal.checkpoint, 'build');
  assert.equal(refusal.recoveryClass, 'repair-implementation');
  assert.deepEqual(refusal.preserved, { state: 'unchanged', description: 'Nothing was recorded; the Story stays where it was.' });
  assert.deepEqual(refusal.actions, [{ command: 'singularity-flow evidence matrix', confirmation: null }]);
  assert.deepEqual(refusal.risk, { eligible: false, authorities: [], maximumDays: null });
  assert.equal(refusal.nonWaivable, false);
  assert.equal(refusal.evaluationInputSha256, `sha256:${'a'.repeat(64)}`);
  assert.ok(Object.isFrozen(refusal));
  assert.throws(() => gateRefusal({ code: 'X', gate: 'somewhere' }), /Unknown gate/);
});

test('the recovery class follows what unblocks the most, and untrusted records are never waivable', () => {
  const classOf = (obligations, findings = []) => gateRefusal({ code: 'X', gate: 'approval', evaluation: evaluation(obligations, findings) }).recoveryClass;
  assert.equal(classOf([obligation('OBL:W-1:scope:story', 'scope', 'pending')],
    [{ code: 'APPLICABILITY_DECISION_REQUIRED', message: 'decide', blocking: true }]), 'decide-applicability');
  assert.equal(classOf([obligation('OBL:W-1:verify:AC-001', 'verify', 'inconclusive')]), 'rerun-verification');
  assert.equal(classOf([obligation('OBL:W-1:plan:AC-001', 'plan', 'missing')]), 'amend-scope-or-plan');
  assert.equal(classOf([obligation('OBL:W-1:review:AC-001', 'review', 'pending')]), 're-review');
  const untrusted = gateRefusal({
    code: 'X', gate: 'terminal', risk: { eligible: true, authorities: ['quality-reviewers'], maximumDays: 14 },
    evaluation: evaluation([obligation('OBL:W-1:verify:AC-001', 'verify', 'inconclusive')],
      [{ code: 'EVIDENCE_RECORDS_UNTRUSTED', category: 'records', blocking: true, message: 'binding mismatch' }])
  });
  assert.equal(untrusted.nonWaivable, true);
  assert.equal(untrusted.recoveryClass, 'repair-records');
  assert.equal(untrusted.risk.eligible, false, 'a forged record can never be accepted as a risk');
});

test('only the v1 fields cross the process boundary, bounded, and a refusal envelope carries them', () => {
  const refusal = gateRefusal({
    code: 'STORY_COMPLETION_REFUSED', gate: 'terminal', subject: { workId: 'W-1' },
    evaluation: evaluation(Array.from({ length: 60 }, (_, index) => obligation(`OBL:W-1:verify:AC-${index}`, 'verify', 'missing')))
  });
  const projected = projectGateRefusal({ ...refusal, secret: 'token-123', subject: { ...refusal.subject, extra: 'x' } });
  assert.equal(projected.secret, undefined);
  assert.equal(projected.subject.extra, undefined);
  assert.equal(projected.obligations.length, 50);
  assert.equal(projectGateRefusal({ ...refusal, schema: 'gate-refusal/v2' }), null);
  assert.equal(projectGateRefusal({ ...refusal, gate: 'elsewhere' }), null);

  const error = new SingularityFlowError('refused', { code: 'STORY_COMPLETION_REFUSED', details: { gate: refusal, password: 'hunter2' } });
  const envelope = refusalEnvelope(error, ['approve', '--json']);
  assert.equal(envelope.error.details.gate.schema, GATE_REFUSAL_VERSION);
  assert.equal(envelope.error.details.gate.obligations.length, 50);
  assert.equal(JSON.stringify(envelope).includes('hunter2'), false);
});

test('an identical retry of a refused transition is answered from memory until something changes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refusal-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Refusal Tester'); git('config', 'user.email', 'refusal@example.test');
  await writeFile(path.join(root, 'README.md'), '# Refusals\n');
  git('add', '.'); git('commit', '-qm', 'base');
  await writeFile(path.join(root, 'notes.md'), 'draft\n');
  const subject = { operation: 'approve', workId: 'W-1', phase: 'verify', actor: 'reviewer@example.test', args: [] };
  const first = await refusalFingerprint(root, subject);
  assert.equal(await refusalFingerprint(root, subject), first, 'nothing changed, so nothing differs');
  assert.notEqual(await refusalFingerprint(root, { ...subject, actor: 'someone-else@example.test' }), first, 'another person may be allowed');

  await assertRefusalChanged(root, 'W-1', first);
  const refusal = gateRefusal({ code: 'STORY_COMPLETION_REFUSED', gate: 'terminal', subject: { workId: 'W-1' },
    evaluation: evaluation([obligation('OBL:W-1:scope:story', 'scope', 'pending')]), actions: ['singularity-flow decision applicability --responsibility scope --reason "<reason>"'] });
  await rememberRefusal(root, 'W-1', first, refusal, '2026-10-03T00:00:00.000Z');
  await assert.rejects(assertRefusalChanged(root, 'W-1', first), (error) => error.code === 'REFUSAL_UNCHANGED'
    && error.exitCode === 2 && error.details.gate.code === 'REFUSAL_UNCHANGED'
    && /nothing it depends on has changed since \(the first: OBL:W-1:scope:story\)/.test(error.message)
    && /decision applicability --responsibility scope/.test(error.message));

  // The same bytes rewritten by a rollback are no change; an edit or a commit is.
  await writeFile(path.join(root, 'notes.md'), 'draft\n');
  assert.equal(await refusalFingerprint(root, subject), first);
  await writeFile(path.join(root, 'notes.md'), 'draft, revised\n');
  const edited = await refusalFingerprint(root, subject);
  assert.notEqual(edited, first);
  await assertRefusalChanged(root, 'W-1', edited);
  git('add', '.'); git('commit', '-qm', 'decide');
  assert.notEqual(await refusalFingerprint(root, subject), edited);

  await forgetRefusal(root, 'W-1');
  await assertRefusalChanged(root, 'W-1', first);
});
