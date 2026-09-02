import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseCheckoutClean, parseReleaseTestSummary
} from '../src/verification-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(directory, args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-release-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, ['init', '-q', '-b', 'main']);
  git(directory, ['config', 'user.name', 'Release Test']);
  git(directory, ['config', 'user.email', 'release@example.test']);
  await writeFile(path.join(directory, 'tracked.txt'), 'original\n');
  git(directory, ['add', 'tracked.txt']);
  git(directory, ['commit', '-q', '-m', 'Initial']);
  return directory;
}

test('release checkout proof rejects worktree, index, and clean HEAD drift', async (t) => {
  const directory = await repository(t);
  const baseline = assertReleaseCheckoutClean(directory, { label: 'Test release' });
  assert.match(baseline.commit, /^[a-f0-9]{40}$/);
  assert.match(baseline.tree, /^[a-f0-9]{40}$/);

  await writeFile(path.join(directory, 'tracked.txt'), 'changed after tests\n');
  assert.throws(() => assertReleaseCheckoutClean(directory, {
    expectedCommit: baseline.commit, expectedTree: baseline.tree, label: 'Post-test check'
  }), (error) => error.code === 'VERIFICATION_CHECKOUT_CHANGED'
    && /tracked\.txt/.test(error.message));
  git(directory, ['add', 'tracked.txt']);
  assert.throws(() => assertReleaseCheckoutClean(directory, {
    expectedCommit: baseline.commit, expectedTree: baseline.tree, label: 'Post-test index check'
  }), (error) => error.code === 'VERIFICATION_CHECKOUT_CHANGED'
    && /tracked\.txt/.test(error.message));

  const untracked = await repository(t);
  await writeFile(path.join(untracked, 'new-package-input.mjs'), 'export default true;\n');
  assert.throws(() => assertReleaseCheckoutClean(untracked, { label: 'Pre-pack check' }),
    (error) => error.code === 'VERIFICATION_CHECKOUT_CHANGED'
      && /new-package-input\.mjs/.test(error.message));

  const second = await repository(t);
  const beforeCommit = assertReleaseCheckoutClean(second);
  await writeFile(path.join(second, 'tracked.txt'), 'committed mutation\n');
  git(second, ['add', 'tracked.txt']);
  git(second, ['commit', '-q', '-m', 'Unexpected advance']);
  assert.throws(() => assertReleaseCheckoutClean(second, {
    expectedCommit: beforeCommit.commit, expectedTree: beforeCommit.tree, label: 'Pre-sign check'
  }), (error) => error.code === 'VERIFICATION_CHECKOUT_CHANGED'
    && /HEAD changed/.test(error.message)
    && /HEAD tree changed/.test(error.message));
});

test('release test summary requires every explicit zero-outcome counter', () => {
  const spec = [
    'ℹ tests 12', 'ℹ pass 12', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'
  ].join('\n');
  assert.deepEqual(parseReleaseTestSummary(spec), {
    passed: 12, failed: 0, cancelled: 0, skipped: 0, todo: 0
  });

  const tap = ['# pass 4', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'].join('\n');
  assert.equal(parseReleaseTestSummary(tap).passed, 4);

  for (const label of ['pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const incomplete = spec.split('\n').filter((line) => !line.includes(` ${label} `)).join('\n');
    assert.throws(() => parseReleaseTestSummary(incomplete),
      (error) => error.code === 'VERIFICATION_TEST_SUMMARY_INCOMPLETE');
  }

  for (const label of ['fail', 'cancelled', 'skipped', 'todo']) {
    const failed = spec.replace(`ℹ ${label} 0`, `ℹ ${label} 1`);
    assert.throws(() => parseReleaseTestSummary(failed),
      (error) => error.code === 'VERIFICATION_TEST_SUMMARY_FAILED');
  }
});

test('release and receipt scripts recheck the exact checkout around packaging and signing', async () => {
  const [release, receipt] = await Promise.all([
    readFile(path.join(root, 'scripts/release.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/verification-receipt.mjs'), 'utf8')
  ]);
  assert.ok((release.match(/assertReleaseCheckoutClean\(/g) ?? []).length >= 4,
    'release must check at start, before packing, and after both package surfaces');
  assert.ok(release.indexOf("label: 'Release pre-pack check'") < release.indexOf("must('npm', ['pack', '--json']"));
  assert.ok(release.indexOf("label: 'Release npm-package check'") > release.indexOf("must('npm', ['pack', '--json']"));
  assert.ok(release.indexOf("label: 'Release VSIX-package check'") > release.indexOf("'--package'"));

  assert.ok((receipt.match(/assertReleaseCheckoutClean\(/g) ?? []).length >= 3,
    'signed evidence must check at start, immediately before pack, and after packaging');
  assert.match(receipt, /const npmTest = parseReleaseTestSummary\(testOutput\)/);
  assert.match(receipt, /--platform-evidence/,
    'a signed receipt must require separately reviewed physical platform evidence');
  assert.ok((receipt.match(/validateReleasePlatformEvidence\(/g) ?? []).length >= 2,
    'physical evidence must be checked before execution and rebound to the produced artifact digests');
  assert.doesNotMatch(receipt, /(?:failed|skipped|cancelled|todo): count\([^\n]+\) \?\? 0/,
    'missing output counters must never be rewritten as observed zeroes');
});
