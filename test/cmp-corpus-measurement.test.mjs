import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildChangeRegionManifest, evaluateComprehensionCoverage } from '../src/comprehension/contracts.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';
import { compareReviewedExpectation } from '../scripts/cmp-corpus-measurement.mjs';

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function repository(parent, name, changed) {
  const root = path.join(parent, name);
  await mkdir(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Private Corpus Person']);
  git(root, ['config', 'user.email', 'private-corpus@example.invalid']);
  await writeFile(path.join(root, 'private-source.txt'), 'before\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  if (changed) {
    await writeFile(path.join(root, 'private-source.txt'), 'after\n');
    await writeFile(path.join(root, 'private-untracked.txt'), 'new\n');
  }
  return root;
}

async function reviewedCase(caseId, root) {
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: base,
    subject: { kind: 'comprehension-observation', workId: null, phase: null }
  });
  const manifest = buildChangeRegionManifest(changeSet);
  const coverage = evaluateComprehensionCoverage({ changeSet, manifest });
  return {
    caseId,
    repository: root,
    base,
    expected: {
      changeSetSha256: changeSet.digest,
      verdict: coverage.verdict,
      resources: manifest.regions.map((region) => ({
        pathBefore: region.location.pathBefore,
        pathAfter: region.location.pathAfter,
        operation: region.operation,
        classification: region.classification.material ? 'material' : 'nonmaterial'
      }))
    }
  };
}

async function writeReviewedManifest(file, cases) {
  await writeFile(file, `${JSON.stringify({
    schema: 'sflow-cmp-real-corpus-input/v2', cases
  }, null, 2)}\n`);
}

test('real CMP corpus measurement aggregates repositories without leaking or changing them', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-real-corpus-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const changed = await repository(parent, 'customer-payments-secret', true);
  const clean = await repository(parent, 'customer-ledger-secret', false);
  const beforeChanged = git(changed, ['status', '--porcelain=v1', '-z']);
  const beforeClean = git(clean, ['status', '--porcelain=v1', '-z']);

  const result = spawnSync(process.execPath, [
    'scripts/cmp-corpus-measurement.mjs', '--samples', '2',
    '--repository', changed, '--repository', clean, '--base', 'HEAD'
  ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'sflow-cmp-real-corpus/v1');
  assert.equal(report.assurance, 'content-free-local-measurement');
  assert.equal(report.authority, 'none');
  assert.equal(report.repositoryCount, 2);
  assert.equal(report.requestedSamplesPerRepository, 2);
  assert.equal(report.completedMeasurements, 4);
  assert.equal(report.counts.repositoriesWithChanges, 1);
  assert.equal(report.counts.repositoriesWithoutChanges, 1);
  assert.equal(report.counts.regions, 2);
  assert.equal(report.counts.materialRegions, 2);
  assert.equal(report.counts.unresolved, 2);
  assert.equal(report.availability.model, 'not-invoked');
  assert.equal(report.availability.structuralExtraction, 'not-invoked');
  assert.equal(report.availability.network, 'not-invoked');
  assert.equal(report.repositoryState, 'unchanged-observed');
  assert.equal(report.lifecycleGate, false);
  assert.equal(report.authoritative, false);
  assert.ok(report.storageBytesPerRepository.recordModePreview.maximum > 0);
  assert.equal(git(changed, ['status', '--porcelain=v1', '-z']), beforeChanged);
  assert.equal(git(clean, ['status', '--porcelain=v1', '-z']), beforeClean);
  assert.equal(await readFile(path.join(changed, 'private-source.txt'), 'utf8'), 'after\n');

  const serialized = JSON.stringify(report);
  for (const forbidden of [
    parent, 'customer-payments-secret', 'customer-ledger-secret', 'private-source.txt',
    'private-untracked.txt', 'Private Corpus Person', 'private-corpus@example.invalid', 'sha256:'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('real CMP corpus measurement refuses unsafe inputs without echoing their path', async () => {
  const secret = path.join(os.tmpdir(), 'definitely-missing-private-corpus');
  const result = spawnSync(process.execPath, [
    'scripts/cmp-corpus-measurement.mjs', '--repository', secret, '--samples', '1'
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CMP_REAL_CORPUS_INVALID/);
  assert.doesNotMatch(result.stderr, /definitely-missing-private-corpus/);
});

test('real CMP corpus measurement refuses ranges, duplicates, and unbounded fan-out', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-real-corpus-bounds-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = await repository(parent, 'one', true);
  for (const args of [
    ['--repository', root, '--base', 'HEAD..main'],
    ['--repository', root, '--repository', root],
    ['--repository', root, '--samples', '21']
  ]) {
    const result = spawnSync(process.execPath, ['scripts/cmp-corpus-measurement.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CMP_REAL_CORPUS_INVALID/);
  }
});

test('reviewed CMP corpus manifest compares exact subjects, classifications, and verdicts without disclosure', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-reviewed-corpus-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const changed = await repository(parent, 'customer-payments-secret', true);
  const clean = await repository(parent, 'customer-ledger-secret', false);
  const cases = [
    await reviewedCase('changed-payments', changed),
    await reviewedCase('clean-ledger', clean)
  ];
  const manifest = path.join(parent, 'private-reviewed-cmp-manifest.json');
  await writeReviewedManifest(manifest, cases);
  const beforeChanged = git(changed, ['status', '--porcelain=v1', '-z']);
  const beforeClean = git(clean, ['status', '--porcelain=v1', '-z']);

  const result = spawnSync(process.execPath, [
    'scripts/cmp-corpus-measurement.mjs', '--manifest', manifest, '--samples', '2'
  ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'sflow-cmp-real-corpus/v2');
  assert.equal(report.assurance, 'content-free-local-reviewed-expectation-comparison');
  assert.equal(report.inputBinding, 'exact-change-set-and-resource-expectations');
  assert.equal(report.reviewAuthentication, 'not-performed');
  assert.equal(report.independentReview, 'not-proven-by-runner');
  assert.equal(report.repositoryCount, 2);
  assert.equal(report.caseCount, 2);
  assert.equal(report.requestedSamplesPerCase, 2);
  assert.equal(report.completedMeasurements, 4);
  assert.equal(report.outcome, 'observed');
  assert.equal(report.counts.casesWithChanges, 1);
  assert.equal(report.counts.casesWithoutChanges, 1);
  assert.equal(report.counts.regions, 2);
  assert.deepEqual(report.counts.expectedVerdicts, {
    complete: 0, incomplete: 1, 'not-applicable': 1
  });
  assert.deepEqual(report.counts.observedVerdicts, {
    complete: 0, incomplete: 1, 'not-applicable': 1
  });
  assert.deepEqual(report.counts.reviewedClassifications, { material: 2, nonmaterial: 0 });
  assert.deepEqual(report.counts.mismatches, {
    cases: 0,
    subject: 0,
    verdict: 0,
    falseComplete: 0,
    falseIncomplete: 0,
    otherVerdict: 0,
    resourceInventory: 0,
    missingExpectedResources: 0,
    unexpectedObservedResources: 0,
    classification: 0,
    falseMaterial: 0,
    falseNonmaterial: 0
  });
  assert.ok(report.storageBytesPerCase.recordModePreview.maximum > 0);
  assert.equal(report.repositoryState, 'unchanged-observed');
  assert.equal(report.lifecycleGate, false);
  assert.equal(report.authoritative, false);
  assert.equal(git(changed, ['status', '--porcelain=v1', '-z']), beforeChanged);
  assert.equal(git(clean, ['status', '--porcelain=v1', '-z']), beforeClean);

  const serialized = `${result.stdout}${result.stderr}`;
  for (const forbidden of [
    parent, manifest, 'private-reviewed-cmp-manifest', 'changed-payments', 'clean-ledger',
    'customer-payments-secret', 'customer-ledger-secret', 'private-source.txt',
    'private-untracked.txt', cases[0].base, cases[0].expected.changeSetSha256, 'sha256:'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('reviewed CMP corpus mismatch is content-free, nonzero, and separates stable failure classes', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-reviewed-mismatch-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = await repository(parent, 'private-mismatch-repository', true);
  const corpusCase = await reviewedCase('private-mismatch-case', root);
  corpusCase.expected.changeSetSha256 = `sha256:${'f'.repeat(64)}`;
  corpusCase.expected.verdict = 'complete';
  corpusCase.expected.resources[0].classification = 'nonmaterial';
  const manifest = path.join(parent, 'private-mismatch-manifest.json');
  await writeReviewedManifest(manifest, [corpusCase]);

  const result = spawnSync(process.execPath, [
    'scripts/cmp-corpus-measurement.mjs', '--manifest', manifest, '--samples', '2'
  ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^CMP_REAL_CORPUS_MISMATCH:/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.outcome, 'mismatch');
  assert.deepEqual(report.counts.mismatches, {
    cases: 1,
    subject: 1,
    verdict: 1,
    falseComplete: 0,
    falseIncomplete: 1,
    otherVerdict: 0,
    resourceInventory: 0,
    missingExpectedResources: 0,
    unexpectedObservedResources: 0,
    classification: 1,
    falseMaterial: 1,
    falseNonmaterial: 0
  });
  const serialized = `${result.stdout}${result.stderr}`;
  for (const forbidden of [
    parent, manifest, 'private-mismatch-case', 'private-mismatch-repository',
    'private-source.txt', corpusCase.base, corpusCase.expected.changeSetSha256, 'sha256:'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('reviewed CMP comparison keeps false-complete and false-nonmaterial distinct', () => {
  const resource = {
    pathBefore: 'src/payment.js',
    pathAfter: 'src/payment.js',
    operation: 'modified',
    classification: 'material'
  };
  const comparison = compareReviewedExpectation({
    expected: {
      changeSetSha256: `sha256:${'a'.repeat(64)}`,
      verdict: 'incomplete',
      resources: [resource]
    }
  }, {
    changeSetSha256: `sha256:${'a'.repeat(64)}`,
    regions: [{
      operation: 'modified',
      location: { pathBefore: 'src/payment.js', pathAfter: 'src/payment.js' },
      classification: { material: false }
    }]
  }, { verdict: 'complete' });
  assert.deepEqual(comparison, {
    subjectMismatches: 0,
    verdictMismatches: 1,
    falseComplete: 1,
    falseIncomplete: 0,
    otherVerdictMismatches: 0,
    missingExpectedResources: 0,
    unexpectedObservedResources: 0,
    falseMaterial: 0,
    falseNonmaterial: 1,
    mismatch: true
  });

  const inventory = compareReviewedExpectation({
    expected: {
      changeSetSha256: `sha256:${'a'.repeat(64)}`,
      verdict: 'incomplete',
      resources: [{ ...resource, pathBefore: 'src/reviewed.js', pathAfter: 'src/reviewed.js' }]
    }
  }, {
    changeSetSha256: `sha256:${'a'.repeat(64)}`,
    regions: [{
      operation: 'modified',
      location: { pathBefore: 'src/observed.js', pathAfter: 'src/observed.js' },
      classification: { material: true }
    }]
  }, { verdict: 'incomplete' });
  assert.equal(inventory.missingExpectedResources, 1);
  assert.equal(inventory.unexpectedObservedResources, 1);
  assert.equal(inventory.mismatch, true);
});

test('reviewed CMP corpus refuses noncanonical, mixed, linked, and repository-local manifests', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-reviewed-invalid-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = await repository(parent, 'private-invalid-repository', true);
  const corpusCase = await reviewedCase('valid-case', root);
  const valid = path.join(parent, 'valid.json');
  await writeReviewedManifest(valid, [corpusCase]);

  const extraField = path.join(parent, 'extra-field.json');
  await writeFile(extraField, `${JSON.stringify({
    schema: 'sflow-cmp-real-corpus-input/v2', cases: [{ ...corpusCase, secretExtra: true }]
  })}\n`);
  const symbolicBase = path.join(parent, 'symbolic-base.json');
  await writeReviewedManifest(symbolicBase, [{ ...corpusCase, base: 'HEAD' }]);
  const numericCaseId = path.join(parent, 'numeric-case-id.json');
  await writeReviewedManifest(numericCaseId, [{ ...corpusCase, caseId: 7 }]);
  const linked = path.join(parent, 'linked.json');
  await symlink(valid, linked);
  const inside = path.join(root, 'private-corpus-manifest.json');
  await writeReviewedManifest(inside, [corpusCase]);

  for (const [manifest, extraArgs = []] of [
    [extraField], [symbolicBase], [numericCaseId], [linked], [inside],
    [valid, ['--repository', root]]
  ]) {
    const result = spawnSync(process.execPath, [
      'scripts/cmp-corpus-measurement.mjs', '--manifest', manifest, ...extraArgs
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^CMP_REAL_CORPUS_INVALID:/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(
      result.stderr,
      /private-invalid-repository|private-corpus-manifest|extra-field|symbolic-base|numeric-case-id|linked\.json|valid-case/
    );
  }
});

test('reviewed CMP corpus ignores replacement refs for its exact reviewed Git subject', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-reviewed-replace-ref-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = await repository(parent, 'private-replacement-repository', true);
  const corpusCase = await reviewedCase('replacement-subject', root);
  const manifest = path.join(parent, 'private-replacement-manifest.json');
  await writeReviewedManifest(manifest, [corpusCase]);

  const replacement = git(root, ['stash', 'create']).trim();
  assert.match(replacement, /^[a-f0-9]{40,64}$/);
  git(root, ['replace', corpusCase.base, replacement]);
  assert.equal(git(root, ['replace', '-l']).trim(), corpusCase.base);

  const result = spawnSync(process.execPath, [
    'scripts/cmp-corpus-measurement.mjs', '--manifest', manifest, '--samples', '1'
  ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).outcome, 'observed');
});
