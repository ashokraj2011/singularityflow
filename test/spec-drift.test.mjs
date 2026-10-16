/**
 * Spec drift: a closed Story's approved clauses checked against the code and tests now, and the
 * notice a later Story gets when its change touches one of them. Advisory throughout.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { runFirstRunGuide } from '../src/first-run-guide.mjs';
import { parseZeroContextPatch, rangeTouches } from '../src/spec-drift.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('a zero-context patch gives old-coordinate ranges, insertions, additions and deletions', () => {
  const files = parseZeroContextPatch([
    'diff --git a/greeting.mjs b/greeting.mjs', '--- a/greeting.mjs', '+++ b/greeting.mjs',
    '@@ -2 +2 @@', '-old', '+new', '@@ -5,0 +6,2 @@', '+a', '+b', '@@ -9,3 +11,0 @@', '-x', '-y', '-z',
    'diff --git a/gone.mjs b/gone.mjs', '--- a/gone.mjs', '+++ /dev/null', '@@ -1,4 +0,0 @@',
    'diff --git a/new.mjs b/new.mjs', '--- /dev/null', '+++ b/new.mjs', '@@ -0,0 +1 @@',
    'diff --git a/with space.mjs b/with space.mjs', '--- a/with space.mjs\t', '+++ b/with space.mjs\t', '@@ -1 +1 @@'
  ].join('\n'));
  assert.deepEqual(files.get('greeting.mjs').ranges, [{ start: 2, end: 2 }, { start: 5, end: 5, insertion: true }, { start: 9, end: 11 }]);
  assert.equal(files.get('gone.mjs').deleted, true);
  assert.equal(files.get('new.mjs').added, true);
  assert.ok(files.has('with space.mjs'));
  assert.equal(rangeTouches({ start: 2, end: 2 }, 1, 2), true);
  assert.equal(rangeTouches({ start: 3, end: 4 }, 1, 2), false);
  assert.equal(rangeTouches({ start: 1, end: 1, insertion: true }, 1, 2), true, 'an insertion between bound lines changes them');
  assert.equal(rangeTouches({ start: 2, end: 2, insertion: true }, 1, 2), false, 'an insertion after the last bound line does not');
});

test('a closed Story reads in sync, drifted or orphaned as its code changes, and a later Story is told what it touches', { timeout: 300_000 }, async (t) => {
  const guide = await runFirstRunGuide({ keep: true });
  const root = guide.repository;
  t.after(() => rm(path.dirname(root), { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(path.dirname(root), 'home'), NODE_ENV: 'production', NO_COLOR: '1', SINGULARITY_FLOW_NO_MODEL: '1' };
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 180_000 });
  const sflow = (...args) => {
    const result = run(args);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const drift = (...args) => JSON.parse(sflow('spec', 'drift', '--json', ...args)).data.drift;
  const clause = (report) => report.stories.find((story) => story.workId === 'TOY-001').clauses.find((entry) => entry.clauseId === 'TOY-001:AC-001');
  const source = path.join(root, 'greeting.mjs');
  const testFile = path.join(root, 'tests/greeting.test.mjs');
  const approvedSource = await readFile(source, 'utf8');
  const approvedTest = await readFile(testFile, 'utf8');

  // Untouched: the clause, its tag and its acceptance test read in sync.
  const clean = drift();
  assert.deepEqual([clean.summary.stories, clean.summary.clauses, clean.summary['in-sync']], [1, 1, 1]);
  assert.match(sflow('spec', 'drift'), /0 in sync|1 in sync/u);

  // Changing the code that delivered the clause drifts it; the committed tree still reads in sync.
  await writeFile(source, approvedSource.replace('Hello, Singularity Flow!', 'Hi there!'));
  const changed = clause(drift());
  assert.equal(changed.status, 'drifted');
  assert.deepEqual(changed.findings.map((finding) => finding.code), ['bound-code-changed']);
  assert.equal(clause(drift('--ref', 'HEAD')).status, 'in-sync');
  assert.match(sflow('spec', 'drift'), /TOY-001:AC-001\s+drifted\n\s+- Lines 1-\d+ of greeting\.mjs that delivered TOY-001:AC-001 changed\./u);

  // Changing its acceptance test is drift too; dropping the tag or the test orphans the clause.
  await writeFile(testFile, approvedTest.replace(/assert\.equal\(greeting, .*\);/u, "assert.equal(greeting, 'Hi there!');"));
  assert.ok(clause(drift()).findings.some((finding) => finding.code === 'acceptance-test-changed'));
  await writeFile(source, "export const greeting = 'Hi there!';\n");
  const orphaned = clause(drift());
  assert.equal(orphaned.status, 'orphaned');
  assert.ok(orphaned.findings.some((finding) => finding.code === 'tag-missing'));
  await rm(testFile);
  assert.ok(clause(drift()).findings.some((finding) => finding.code === 'acceptance-test-missing'));

  // Restored, it reads in sync again: drift is never stored, only computed.
  await writeFile(source, approvedSource);
  await writeFile(testFile, approvedTest);
  assert.equal(clause(drift()).status, 'in-sync');
  assert.equal(JSON.parse(sflow('spec', 'drift', '--json', '--work-id', 'TOY-001')).data.drift.stories.length, 1);
  assert.equal(JSON.parse(run(['spec', 'drift', '--json', '--work-id', 'NOPE-1']).stdout).error.code, 'SPEC_DRIFT_STORY_UNKNOWN');

  // A later Story whose change rewrites TOY-001's bound line is told so at prepublish, as advice only.
  const story = path.join(path.dirname(root), 'story-2.yml');
  await writeFile(story, YAML.stringify({ title: 'Make the greeting louder', description: 'Add an exclamation.',
    desiredOutcome: 'The greeting is louder.', acceptanceCriteria: ['The greeting ends with two exclamation marks.'], risk: 'low', repositoryCount: 1 }));
  // As a team would: the closed Story is merged into main, and the next Story starts from there.
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  };
  git('checkout', '-q', 'main'); git('merge', '-q', '--ff-only', 'TOY-001'); git('push', '-q', 'origin', 'main');
  assert.equal(clause(drift()).status, 'in-sync', 'main carries the closed Story and its records');
  sflow('start', 'TOY-002', '--from-branch', 'main', '--story-file', story, '--work-type', 'quick-fix', '--agent', 'developer');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/TOY-002/artifacts/intake/intake.md'), [
    '# TOY-002 — Quick fix scope and plan', '', '## Problem and fix', '', 'The greeting should be louder.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [TOY-002:AC-001] | The greeting ends with two exclamation marks. |', '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    '| `TOY-002:AC-001` | `greeting.mjs` | `tests/greeting.test.mjs` |', '',
    '## Out of scope', '', 'Nothing but the greeting and its test changes.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('prepare', 'implement');
  await writeFile(source, "// @clause:TOY-002:AC-001 the greeting is louder\nexport const greeting = 'Hello, Singularity Flow!!';\n");
  const prepublish = JSON.parse(sflow('phase', 'prepublish', 'implement', '--json'));
  const advisories = prepublish.advisories ?? prepublish.data?.advisories ?? [];
  const foreign = advisories.filter((advisory) => advisory.code === 'spec.drift.foreign-clause');
  assert.ok(foreign.length >= 1, JSON.stringify(advisories.map((advisory) => advisory.code)));
  assert.match(foreign[0].message, /This change touches TOY-001:AC-001 of closed Story TOY-001: .*Advisory only\./u);
  assert.equal(foreign.every((advisory) => advisory.blocking === false), true);
});
