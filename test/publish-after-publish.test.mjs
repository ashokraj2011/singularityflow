/**
 * A publish after a publish is a no-op, through the real CLI [bin-opr2]: `phase prepublish --publish-if-ready`
 * published, then a model ran `phase publish`, and planning went 1, 2, 3, 4, each pair seconds apart.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('publishing unchanged says so and records nothing, and a changed draft is its next version, opened only on the person\'s yes', slowLane({ timeout: 240_000 }), async (t) => {
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

  // Asked plainly, prepublish does not offer it again either: its next step is the route.
  for (const flags of [[], ['--for-agent']]) {
    const plain = sflowJson('phase', 'prepublish', 'intake', ...flags);
    assert.equal(plain.status, 0, JSON.stringify(plain.value));
    assert.equal(plain.value.commands.publish, null, JSON.stringify(plain.value.commands));
    assert.equal(plain.value.commandGuidance.publish, null);
    assert.notEqual(plain.value.act?.state, 'publish', JSON.stringify(plain.value.act));
    assert.ok(plain.value.commands.next, JSON.stringify(plain.value.commands));
    assert.doesNotMatch(JSON.stringify([plain.value.commands.next, plain.value.act?.do]), /phase publish/u);
  }

  // A real change is the next version: publishing it would open version 2 with nobody asked. It opens only on the
  // person's yes, through the step's own preview; the edit and version 1 both stay [D3, OSA:REQ-014, REQ-030].
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace('change the exported constant', 'change the exported constant to 2'));
  const consent = (result, why) => {
    assert.notEqual(result.status, 0, why);
    assert.equal(result.value.error?.code, 'VERSION_CONSENT_REQUIRED', JSON.stringify(result.value));
    assert.match(result.value.error.message, /^The next version of intake opens only on the person's yes\. Nothing was opened\./u);
    assert.match(result.value.remediationPlan.steps[0].command, /^singularity-flow phase rollover intake\b.*--json$/u, why);
  };
  consent(publish(), 'a changed draft never publishes in place');
  // Preparing its inputs would reserve that next draft just the same; reading them (--dry-run) stays open.
  consent(sflowJson('inputs', 'intake'), 'inputs never opens the next draft');
  assert.equal(sflowJson('inputs', 'intake', '--dry-run').status, 0);
  assert.equal(commits(), before, 'nothing was recorded');
  assert.match(sflow('phase', 'show', 'intake'), /generation 1|Generation: 1/iu);
  assert.match(await readFile(artifact, 'utf8'), /change the exported constant to 2/u, 'the edit is kept');

  // The same words with something new to carry are no repeat either: what a publication would commit can sit in the
  // Story's context (a capture for the next version), and a sibling can already be committed beside the document.
  await writeFile(artifact, words('The value must be 2; change the exported constant.'));
  const story = path.join(root, 'singularity/work-items/QF-1');
  await mkdir(path.join(story, 'context'), { recursive: true });
  await writeFile(path.join(story, 'context/capture.json'), '{}\n');
  consent(publish(), 'an uncommitted file in the Story is new work, so the next version');
  await rm(path.join(story, 'context/capture.json'), { force: true });
  await writeFile(path.join(story, 'artifacts/intake/extra.md'), '# Extra\n');
  must('git', ['add', path.join(story, 'artifacts/intake/extra.md')]);
  must('git', ['commit', '-q', '-m', 'A sibling document']);
  consent(publish(), 'a sibling committed since the publication is new work, so the next version');
});
