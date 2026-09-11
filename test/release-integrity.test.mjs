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

test('artifacts build once while platform verification and promotion consume exact bytes', async () => {
  const [release, receipt, mergedReceipt, builder, vsixSmoke, gitignore] = await Promise.all([
    readFile(path.join(root, 'scripts/release.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/verification-receipt.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/merge-verification-receipts.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/build-release-artifacts.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/packaged-vsix-engine-smoke.mjs'), 'utf8'),
    readFile(path.join(root, '.gitignore'), 'utf8')
  ]);
  assert.ok(release.indexOf('recoverReleaseDirectoryPromotion(dist)')
      < release.indexOf('assertReleaseCheckoutClean(root'),
  'interrupted dist recovery must run before clean-tree admission can observe its journal');
  for (const reserved of [
    '/.dist-candidate-*/', '/.dist.release-previous/', '/.dist.release-promotion.json'
  ]) assert.match(gitignore, new RegExp(reserved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok((release.match(/assertReleaseCheckoutClean\(/g) ?? []).length >= 2,
    'promotion must check the source before and after exact artifact consumption');
  assert.match(release, /verifyReleaseArtifactReceipt\(/);
  assert.match(release, /createVerifiedReleaseArtifactSnapshot\(/,
    'promotion must execute and copy only private descriptor-verified snapshots');
  assert.match(release, /promoteReleaseDirectory\(candidateDist, dist\)/,
    'promotion must publish its complete candidate through the crash-recoverable swap journal');
  assert.match(receipt, /createVerifiedReleaseArtifactSnapshot\(/,
    'platform verification must execute only private descriptor-verified snapshots');
  assert.ok((release.match(/readStableReleaseJson\(/g) ?? []).length >= 2,
    'promotion must read signed handoff JSON through bounded no-follow descriptors');
  assert.ok((receipt.match(/readStableReleaseJson\(/g) ?? []).length >= 3,
    'platform verification must read handoff evidence through bounded no-follow descriptors');
  assert.ok((mergedReceipt.match(/readStableReleaseJson\(/g) ?? []).length >= 2,
    'matrix merge must read every signed handoff through bounded no-follow descriptors');
  assert.match(receipt, /writeReleaseJsonNoClobber\(output, receipt\)/,
    'a platform receipt must publish complete bytes through an atomic no-clobber claim');
  assert.match(mergedReceipt, /writeReleaseJsonNoClobber\(output, aggregate\)/,
    'a matrix receipt must publish complete bytes through an atomic no-clobber claim');
  assert.doesNotMatch(release, /must\('npm', \['pack'/,
    'promotion must never repackage the npm artifact');
  assert.doesNotMatch(release, /vscode-dev\.mjs[^\n]*--package/,
    'promotion must never rebuild the VSIX');

  assert.ok((receipt.match(/verifyReleaseArtifactReceipt\(/g) ?? []).length >= 2,
    'a platform cell must verify the immutable pair before and after its tests');
  assert.doesNotMatch(receipt, /run\('npm', \['pack'/,
    'platform verification must never repackage the npm artifact');
  assert.doesNotMatch(receipt, /vscode:package/,
    'platform verification must never rebuild the VSIX');
  assert.match(builder, /materializeExactHead\(/,
    'the one artifact builder must materialize exact Git blobs');
  assert.equal((builder.match(/'pack', '--ignore-scripts'/g) ?? []).length, 1,
    'the canonical builder contains one npm pack operation');
  assert.match(builder, /packer\.entry, 'ci',[\s\S]*?'--omit=dev'/,
    'the canonical builder must materialize the locked production closure before packing');
  assert.match(builder, /new Set\(pack\.bundled \?\? \[\]\)/,
    'the canonical builder must prove every declared bundle entered the tarball');
  assert.equal((builder.match(/'--package'/g) ?? []).length, 1,
    'the canonical builder contains one VSIX package operation');
  assert.match(builder, /SINGULARITY_FLOW_PACKAGING_NPM_CLI: packer\.entry/,
    'the VSIX builder must consume the same private exact npm toolchain');
  assert.doesNotMatch(builder, /worktree', 'prune'/,
    'artifact cleanup must not mutate unrelated stale-worktree metadata');
  assert.match(builder, /new TextDecoder\('utf-8', \{ fatal: true \}\)/,
    'exact tree paths must reject invalid UTF-8 rather than replacing bytes');
  assert.ok(vsixSmoke.indexOf('opened.size > MAX_VSIX_BYTES') < vsixSmoke.indexOf('handle.readFile()'),
    'the standalone VSIX smoke must fstat and bound the opened descriptor before allocating its bytes');

  assert.match(receipt, /const npmTest = parseReleaseTestSummary\(testOutput\)/);
  assert.match(receipt, /--platform-evidence/,
    'a signed receipt must require separately reviewed physical platform evidence');
  assert.ok((receipt.match(/validateReleasePlatformEvidence\(/g) ?? []).length >= 2,
    'physical evidence must be checked before execution and rebound to the consumed artifact digests');
  assert.ok((receipt.match(/requireSgosEndToEnd: true/g) ?? []).length >= 2,
    'new signed release evidence must bind SGOS end-to-end journeys before and after packaging');
  assert.match(release, /requireSgosEndToEnd: true/,
    'release promotion must reject a platform matrix that omits SGOS end-to-end evidence');
  assert.match(receipt, /SINGULARITY_FLOW_WEL_BENCHMARK_OUT/,
    'the signed receipt must retain the exact WEL benchmark produced inside the release gate');
  assert.match(receipt, /validateWelBenchmarkEvidence\(/,
    'the retained WEL benchmark must be validated before it enters signed evidence');
  assert.match(receipt, /welBenchmarkSha256/,
    'the signed receipt must bind the canonical WEL benchmark digest');
  assert.doesNotMatch(receipt, /(?:failed|skipped|cancelled|todo): count\([^\n]+\) \?\? 0/,
    'missing output counters must never be rewritten as observed zeroes');
});
