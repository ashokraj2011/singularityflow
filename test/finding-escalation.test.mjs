/**
 * A finding that keeps returning after repairs says to stop and hand it on. `[recoverable-findings M3]`
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ESCALATION_THRESHOLD, escalateRefusalEnvelope, findingEscalation, findingFingerprint, observeFindingStreak, worktreeAttempt
} from '../src/finding-escalation.mjs';
import { canonicalFindingId } from '../src/finding-identity.mjs';
import { refusalEnvelope, renderRefusalPlan } from '../src/refusal-remediation.mjs';

test('a repeat counts only when the attempt changed, and a different finding starts again', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-streak-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Streak Tester', '-c', 'user.email=streak@example.test', 'commit', '-q', '--allow-empty', '-m', 'initial');
  const same = findingFingerprint([{ code: 'CODE_DELIVERY_EVIDENCE_REQUIRED', details: { findingIds: [canonicalFindingId({ code: 'code.delivery.acceptance-test-missing' })] } }]);
  const other = findingFingerprint([{ code: 'CODE_DELIVERY_EVIDENCE_REQUIRED', details: { findingIds: [canonicalFindingId({ code: 'code.delivery.product-source-missing' })] } }]);
  const observe = (fingerprint, attempt) => observeFindingStreak(root, { workId: 'ESC-1', phaseId: 'implementation', generation: 1, fingerprint, attempt });
  assert.equal(observe(same, 'a'), 1);
  assert.equal(observe(same, 'a'), 1, 'a recheck with nothing changed is not a repair');
  assert.equal(observe(same, 'b'), 2);
  assert.equal(observe(same, 'c'), ESCALATION_THRESHOLD);
  assert.equal(observe(other, 'd'), 1, 'a different finding is progress');
  // A refused command retried counts every time (no attempt): the protocol forbids unchanged retries.
  assert.equal(observeFindingStreak(root, { workId: 'ESC-2', phaseId: 'p', fingerprint: same }), 1);
  assert.equal(observeFindingStreak(root, { workId: 'ESC-2', phaseId: 'p', fingerprint: same }), 2);

  await writeFile(path.join(root, 'file.txt'), 'one\n');
  const before = worktreeAttempt(root, 'draft');
  assert.equal(worktreeAttempt(root, 'draft'), before);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(root, 'file.txt'), 'one two\n');
  assert.notEqual(worktreeAttempt(root, 'draft'), before, 'an edit is a new attempt');
});

test('the fingerprint is the finding identity, never its wording [SDA-AC-022]', () => {
  const tag = canonicalFindingId({ code: 'code.delivery.acceptance-tag-unattached', value: 'W:AC-001' });
  const gate = (problems, findingIds, message = 'Phase implementation has no publishable code delivery.') =>
    findingFingerprint([{ code: 'CODE_DELIVERY_EVIDENCE_REQUIRED', message, details: { problems, findingIds } }]);
  const first = gate(['@ac:W:AC-001 is not on a test: test/a.test.mjs:4 (no declaration)'], [tag]);
  assert.equal(gate(['@ac:W:AC-001 sits on no test at test/a.test.mjs:9'], [tag], 'Reworded refusal.'), first,
    'a reworded sentence, a moved line or a new message is the same finding');
  assert.notEqual(gate(['@ac:W:AC-002 is not on a test'], [canonicalFindingId({ code: 'code.delivery.acceptance-tag-unattached', value: 'W:AC-002' })]), first);
  const product = canonicalFindingId({ code: 'code.delivery.product-source-missing' });
  assert.equal(gate(['a', 'b'], [tag, product]), gate(['b', 'a'], [product, tag]), 'the IDs are a set');
  // Without IDs a finding is its code, path and value; its message never counts.
  const plain = (message) => findingFingerprint([{ code: 'artifact.heading.empty', path: 'a.md', value: 'Scope', message }]);
  assert.equal(plain('Heading Scope is empty.'), plain('The Scope heading has no text.'));
  assert.notEqual(plain('x'), findingFingerprint([{ code: 'artifact.heading.empty', path: 'b.md', value: 'Scope', message: 'x' }]));
  assert.equal(findingFingerprint([{ code: 'SOME_REFUSAL', message: 'one wording' }]), findingFingerprint([{ code: 'SOME_REFUSAL', message: 'another' }]));
});

test('the escalation names a dispute only where the gate honours one, and always the documentation', () => {
  assert.equal(findingEscalation({ count: ESCALATION_THRESHOLD - 1, code: 'CODE_DELIVERY_EVIDENCE_REQUIRED', workId: 'W', phaseId: 'p' }), null);
  const disputable = findingEscalation({ count: ESCALATION_THRESHOLD, code: 'CODE_DELIVERY_EVIDENCE_REQUIRED', workId: 'W', phaseId: 'p' });
  assert.equal(disputable.required, true);
  assert.deepEqual(disputable.routes.map((route) => route.kind), ['dispute', 'documentation', 'inspect']);
  assert.match(disputable.routes[0].command, /appeal risk-prepare --work-id W --phase p --finding CODE_DELIVERY_EVIDENCE_REQUIRED --evidence-file <PATH>/u);
  assert.match(disputable.instruction, /Nothing was accepted or waived\.$/u);
  const other = findingEscalation({ count: 4, code: 'artifact.placeholder.unresolved', workId: 'W', phaseId: 'p' });
  assert.deepEqual(other.routes.map((route) => route.kind), ['documentation', 'inspect']);
  assert.match(other.routes[0].command, /explain findings --section "Document quality findings"/u);
});

test('the escalation step carries every route field, so the text plan names its Copilot route', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-escalation-render-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const error = Object.assign(new Error('Delivery evidence is missing.'), { code: 'CODE_DELIVERY_EVIDENCE_REQUIRED',
    details: { workId: 'ESC-3', phase: 'implementation', problems: ['no acceptance test'] } });
  const argv = ['phase', 'publish', 'implementation'];
  let envelope;
  for (let count = 0; count < ESCALATION_THRESHOLD; count += 1) envelope = escalateRefusalEnvelope(refusalEnvelope(error, argv), error, root);
  const [step] = envelope.remediationPlan.steps;
  assert.equal(step.id, 'escalate-repeated-finding');
  assert.equal(step.copilotCommand, '/sf-docs findings');
  const text = renderRefusalPlan(envelope.remediationPlan);
  assert.doesNotMatch(text, /undefined/u);
  assert.match(text, /- Copilot: \/sf-docs findings\n\s+- Shell: singularity-flow explain findings --section/u);
});
