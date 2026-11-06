/**
 * A publish after a publish is a no-op, through the real CLI [bin-opr2]: `phase prepublish --publish-if-ready`
 * published, then a model ran `phase publish`, and planning went 1, 2, 3, 4, each pair seconds apart.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { withoutPublishOffer } from '../src/commands/phase-publish-if-ready.mjs';
import { repository } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

test('the prepublish fields after a publication offer it no more', () => {
  const after = withoutPublishOffer({ status: 'ready', commands: { publish: 'singularity-flow phase publish planning', next: 'x' },
    commandGuidance: { publish: { command: 'singularity-flow phase publish planning' }, next: { command: 'x' } },
    testExecution: { status: 'not-run', handoff: { runnerStatus: 'ready', command: 'singularity-flow phase publish planning' } } });
  assert.equal(after.commands.publish, null);
  assert.equal(after.commands.next, 'x');
  assert.equal(after.commandGuidance.publish, null);
  assert.equal(after.testExecution.handoff.command, null);
  assert.doesNotMatch(JSON.stringify(after), /phase publish/u);
});

test('publishing unchanged says so and records nothing, and a changed draft publishes its next generation', slowLane({ timeout: 240_000 }), async (t) => {
  const repo = await repository(t, { implementCommands: false });
  const { root, must, sflow, sflowJson } = repo;
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  const artifact = path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md');
  const words = (problem) => ['# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', problem, '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');
  await writeFile(artifact, words('The value must be 2; change the exported constant.'));
  const publish = (...flags) => sflowJson('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place', ...flags);
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const commits = () => must('git', ['rev-list', '--count', 'HEAD']).trim();
  const before = commits();

  // The same words again: nothing happens, and it says which generation stands.
  const again = publish();
  assert.equal(again.status, 0, JSON.stringify(again.value));
  assert.equal(again.value.status, 'retained');
  assert.equal(again.value.generation, 1);
  assert.equal(again.value.effects.committed, false);
  assert.match(again.value.message, /^Already published as generation 1; nothing changed since, so nothing was recorded\.$/u);
  assert.equal(commits(), before, 'no commit');
  const text = sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  assert.match(text, /Already published as generation 1/u);
  assert.equal(commits(), before, 'no commit from text mode either');

  // A real change still publishes the next generation.
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace('change the exported constant', 'change the exported constant to 2'));
  const changed = publish();
  assert.equal(changed.status, 0, JSON.stringify(changed.value));
  assert.equal(changed.value.generation ?? 2, 2);
  assert.notEqual(commits(), before);
  assert.match(sflow('phase', 'show', 'intake'), /generation 2|Generation: 2/iu);
});
