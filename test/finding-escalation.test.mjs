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
  ESCALATION_THRESHOLD, findingEscalation, findingFingerprint, observeFindingStreak, worktreeAttempt
} from '../src/finding-escalation.mjs';

test('a repeat counts only when the attempt changed, and a different finding starts again', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-streak-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Streak Tester', '-c', 'user.email=streak@example.test', 'commit', '-q', '--allow-empty', '-m', 'initial');
  const same = findingFingerprint([{ code: 'CODE_DELIVERY_EVIDENCE_REQUIRED', details: { problems: ['no acceptance test'] } }]);
  const other = findingFingerprint([{ code: 'CODE_DELIVERY_EVIDENCE_REQUIRED', details: { problems: ['a different problem'] } }]);
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
