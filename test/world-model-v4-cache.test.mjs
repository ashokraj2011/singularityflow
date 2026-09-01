import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat, mkdtemp, readFile, rm, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createConservativeWorldModelStalenessReceipt,
  deriveWorldModelViewCacheKey,
  inspectWorldModelViewCache,
  readWorldModelViewCache,
  storeConservativeWorldModelStalenessReceipt,
  verifyWorldModelStalenessReceipt,
  VIEW_CACHE_KEY_FIELDS,
  worldModelViewCacheRoot,
  writeWorldModelViewCache
} from '../src/world-model/cache.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { run } from '../src/util.mjs';
import { WMB_V4_VALIDATION_CHECK_IDS } from '../src/world-model/validate/candidate.mjs';

const HASH = (character) => `sha256:${character.repeat(64)}`;

function canonicalViewSha256(value) {
  return `sha256:${recordSha256({ utf8: Buffer.from(value).toString('utf8') })}`;
}

function keyComponents(overrides = {}) {
  return {
    sourceManifestSha256: HASH('1'),
    scopeManifestSha256: HASH('2'),
    viewId: 'dev.impact',
    viewVersion: 4,
    viewSpecSha256: HASH('3'),
    viewFactLedgerSha256: HASH('4'),
    consumerProfileSha256: HASH('5'),
    composerCoreSha256: HASH('6'),
    compositionCandidateSchemaSha256: HASH('7'),
    validatorSha256: HASH('8'),
    outputBudgetSha256: HASH('9'),
    executionProfileSha256: HASH('a'),
    ...overrides
  };
}

function validationReceipt(components, view) {
  const composed = compositionCandidate(components, view);
  const core = {
    schemaVersion: 1,
    kind: 'world-model-view-validation-receipt',
    viewId: components.viewId,
    viewVersion: components.viewVersion,
    candidateSha256: `sha256:${recordSha256(composed)}`,
    candidateSchemaSha256: components.compositionCandidateSchemaSha256,
    viewSpecSha256: components.viewSpecSha256,
    factLedgerSha256: components.viewFactLedgerSha256,
    scopeSha256: components.scopeManifestSha256,
    checks: WMB_V4_VALIDATION_CHECK_IDS.map((id) => ({ id, status: 'pass' })),
    status: 'passed',
    validatorSha256: components.validatorSha256
  };
  return { ...core, receiptSha256: `sha256:${recordSha256(core)}` };
}

function compositionCandidate(components, view) {
  return {
    schemaVersion: 1,
    kind: 'world-model-composition-candidate',
    view: components.viewId,
    viewVersion: components.viewVersion,
    title: 'Cache fixture',
    tldrMarkdown: view,
    sections: [{ sectionId: 'fixture', markdown: view }],
    usedFactIds: []
  };
}

function cacheInput(components, view, createdAt) {
  return {
    view,
    candidate: compositionCandidate(components, view),
    validationReceipt: validationReceipt(components, view),
    createdAt
  };
}

async function repository(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q'], { cwd: root });
  return root;
}

test('v4 view cache key is canonical and every section 50 component participates', () => {
  const components = keyComponents();
  assert.deepEqual(Object.keys(components), VIEW_CACHE_KEY_FIELDS);
  const first = deriveWorldModelViewCacheKey(components);
  const reordered = Object.fromEntries(Object.entries(components).reverse());
  assert.equal(deriveWorldModelViewCacheKey(reordered).cacheKeySha256, first.cacheKeySha256);

  const changes = {
    sourceManifestSha256: HASH('b'),
    scopeManifestSha256: HASH('c'),
    viewId: 'dev.hotspots',
    viewVersion: 5,
    viewSpecSha256: HASH('d'),
    viewFactLedgerSha256: HASH('e'),
    consumerProfileSha256: HASH('f'),
    composerCoreSha256: HASH('b'),
    compositionCandidateSchemaSha256: HASH('c'),
    validatorSha256: HASH('d'),
    outputBudgetSha256: HASH('e'),
    executionProfileSha256: null
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(
      deriveWorldModelViewCacheKey(keyComponents({ [field]: value })).cacheKeySha256,
      first.cacheKeySha256,
      `${field} must participate in cache identity`
    );
  }

  const incomplete = { ...components };
  delete incomplete.validatorSha256;
  assert.throws(
    () => deriveWorldModelViewCacheKey(incomplete),
    (error) => error.code === 'WMB_CACHE_KEY_INCOMPLETE'
  );
  assert.throws(
    () => deriveWorldModelViewCacheKey({ ...components, ambientValue: 'not-keyed' }),
    (error) => error.code === 'WMB_CACHE_KEY_INCOMPLETE'
  );
});

test('exact hit returns the original validated artifact and kernel stamp without rewriting it', async (t) => {
  const root = await repository(t, 'sflow-wmb-v4-cache-hit-');
  const components = keyComponents();
  const view = '# Development impact\n\nkernel-stamp: original-stamp\n';
  const receipt = validationReceipt(components, view);
  const createdAt = '2026-09-01T10:00:00.000Z';

  const written = await writeWorldModelViewCache(root, components, {
    ...cacheInput(components, view, createdAt), validationReceipt: receipt
  });
  assert.equal(written.hit, true);
  assert.equal(written.written, true);
  assert.equal(written.viewBytes.toString('utf8'), view);
  assert.equal(written.record.createdAt, createdAt);
  assert.equal(written.record.lastUsedAt, createdAt);
  assert.ok(written.recordPath.startsWith(worldModelViewCacheRoot(root)));

  const hit = await readWorldModelViewCache(root, components);
  assert.equal(hit.hit, true);
  assert.equal(hit.viewBytes.toString('utf8'), view);
  assert.deepEqual(hit.validationReceipt, receipt);
  assert.deepEqual(hit.record, written.record);
  assert.deepEqual(hit.components, components);

  const inspected = await inspectWorldModelViewCache(root);
  assert.equal(inspected.problems.length, 0);
  assert.equal(inspected.entries.length, 1);
  assert.deepEqual(inspected.entries[0].components, components);
  assert.equal(inspected.entries[0].record.viewSha256, written.record.viewSha256);

  const attemptedReplacement = await writeWorldModelViewCache(root, components,
    cacheInput(components, '# replacement must not win\n', '2026-09-01T11:00:00.000Z'));
  assert.equal(attemptedReplacement.written, false);
  assert.equal(attemptedReplacement.viewBytes.toString('utf8'), view);
  assert.deepEqual(attemptedReplacement.record, written.record);

  for (const target of [
    written.recordPath, written.keyPath, written.viewPath, written.receiptPath, written.candidatePath
  ]) {
    const info = await lstat(target);
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
  }
});

test('persisted cache-key identity makes model-composed entries exactly inspectable', async (t) => {
  const root = await repository(t, 'sflow-wmb-v4-cache-model-identity-');
  const components = keyComponents({ executionProfileSha256: HASH('b') });
  const view = '# Model composed view\n\nkernel-stamp: exact\n';
  const installed = await writeWorldModelViewCache(
    root,
    components,
    cacheInput(components, view, '2026-09-01T11:30:00.000Z')
  );

  const inspected = await inspectWorldModelViewCache(root);
  assert.equal(inspected.problems.length, 0);
  assert.equal(inspected.entries.length, 1);
  assert.deepEqual(inspected.entries[0].components, components);
  assert.equal(inspected.entries[0].record.viewSha256, installed.record.viewSha256);

  const key = JSON.parse(await readFile(installed.keyPath, 'utf8'));
  key.executionProfileSha256 = HASH('c');
  await writeFile(installed.keyPath, canonicalJson(key));
  const corrupt = await inspectWorldModelViewCache(root);
  assert.equal(corrupt.entries.length, 0);
  assert.equal(corrupt.problems.length, 1);
  assert.match(corrupt.problems[0].reason, /content address/);
});

test('miss and corrupt cache objects are explicit, canonicality is checked, and rebuild repairs them', async (t) => {
  const root = await repository(t, 'sflow-wmb-v4-cache-corrupt-');
  const components = keyComponents();
  const view = '# Cached view\n\nkernel-stamp: exact\n';
  const receipt = validationReceipt(components, view);

  const absent = await readWorldModelViewCache(root, components);
  assert.equal(absent.hit, false);
  assert.equal(absent.status, 'miss');
  assert.equal(absent.code, 'WMB_CACHE_ENTRY_MISS');

  const installed = await writeWorldModelViewCache(root, components, {
    ...cacheInput(components, view, '2026-09-01T12:00:00.000Z'), validationReceipt: receipt
  });
  const parsed = JSON.parse(await readFile(installed.recordPath, 'utf8'));
  const nonCanonical = Object.fromEntries(Object.entries(parsed).reverse());
  await writeFile(installed.recordPath, `${JSON.stringify(nonCanonical, null, 2)}\n`);
  const reordered = await readWorldModelViewCache(root, components);
  assert.equal(reordered.hit, false);
  assert.equal(reordered.status, 'corrupt');
  assert.equal(reordered.code, 'WMB_CACHE_ENTRY_CORRUPT');
  assert.match(reordered.reason, /canonical JSON/);

  const repaired = await writeWorldModelViewCache(root, components, {
    ...cacheInput(components, view, '2026-09-01T12:30:00.000Z'), validationReceipt: receipt
  });
  assert.equal(repaired.hit, true);
  assert.equal(repaired.written, true);

  await writeFile(repaired.viewPath, '# digest mismatch\n');
  const alteredView = await readWorldModelViewCache(root, components);
  assert.equal(alteredView.status, 'corrupt');
  assert.match(alteredView.reason, /content hash/);

  const hashRepaired = await writeWorldModelViewCache(root, components, {
    ...cacheInput(components, view, '2026-09-01T12:40:00.000Z'), validationReceipt: receipt
  });
  const parsedReceipt = JSON.parse(await readFile(hashRepaired.receiptPath, 'utf8'));
  await writeFile(
    hashRepaired.receiptPath,
    `${JSON.stringify(Object.fromEntries(Object.entries(parsedReceipt).reverse()), null, 2)}\n`
  );
  const nonCanonicalReceipt = await readWorldModelViewCache(root, components);
  assert.equal(nonCanonicalReceipt.status, 'corrupt');
  assert.match(nonCanonicalReceipt.reason, /canonical JSON/);

  const canonicalRepaired = await writeWorldModelViewCache(root, components, {
    ...cacheInput(components, view, '2026-09-01T12:50:00.000Z'), validationReceipt: receipt
  });

  const outside = path.join(root, 'outside-view.md');
  await writeFile(outside, view);
  await rm(canonicalRepaired.viewPath);
  await symlink(outside, canonicalRepaired.viewPath);
  const linked = await readWorldModelViewCache(root, components);
  assert.equal(linked.hit, false);
  assert.equal(linked.status, 'corrupt');
  assert.match(linked.reason, /symbolic link|real regular file/i);

  const relinked = await writeWorldModelViewCache(root, components, {
    ...cacheInput(components, view, '2026-09-01T13:00:00.000Z'), validationReceipt: receipt
  });
  assert.equal(relinked.hit, true);
  assert.equal((await lstat(relinked.viewPath)).isSymbolicLink(), false);
  assert.equal(relinked.viewBytes.toString('utf8'), view);
});

test('concurrent writers publish one complete immutable winner without torn record/object pairs', async (t) => {
  const root = await repository(t, 'sflow-wmb-v4-cache-race-');
  const components = keyComponents();
  const views = [
    '# Candidate A\n\nkernel-stamp: stamp-a\n',
    '# Candidate B\n\nkernel-stamp: stamp-b\n'
  ];

  const results = await Promise.all(views.map((view, index) => writeWorldModelViewCache(
    root,
    components,
    cacheInput(components, view, `2026-09-01T14:00:0${index}.000Z`)
  )));
  assert.equal(results.filter((result) => result.written).length, 1);
  assert.equal(results.every((result) => result.hit), true);
  assert.equal(results[0].viewBytes.equals(results[1].viewBytes), true);

  const winner = await readWorldModelViewCache(root, components);
  assert.equal(winner.hit, true);
  assert.equal(views.includes(winner.viewBytes.toString('utf8')), true);
  assert.equal(winner.record.viewSha256, canonicalViewSha256(winner.viewBytes));
  assert.equal(winner.record.validationReceiptSha256, winner.validationReceipt.receiptSha256);
  assert.equal(path.basename(winner.recordPath), 'record.json');
});

test('explicit rebuild replaces the exact cache entry by hash-CAS and refuses a stale replacement', async (t) => {
  const root = await repository(t, 'sflow-wmb-v4-cache-replace-');
  const components = keyComponents();
  const originalView = '# Original generated view\n\nkernel-stamp: original\n';
  const replacementView = '# Regenerated view\n\nkernel-stamp: replacement\n';
  const original = await writeWorldModelViewCache(
    root,
    components,
    cacheInput(components, originalView, '2026-09-01T15:00:00.000Z')
  );

  const replacement = await writeWorldModelViewCache(root, components, {
    ...cacheInput(components, replacementView, '2026-09-01T15:01:00.000Z'),
    replaceExisting: true,
    expectedRecordSha256: original.record.recordSha256
  });
  assert.equal(replacement.written, true);
  assert.equal(replacement.replaced, true);
  assert.equal(replacement.viewBytes.toString('utf8'), replacementView);
  assert.notEqual(replacement.record.recordSha256, original.record.recordSha256);

  await assert.rejects(
    writeWorldModelViewCache(root, components, {
      ...cacheInput(components, '# stale paid output\n', '2026-09-01T15:02:00.000Z'),
      replaceExisting: true,
      expectedRecordSha256: original.record.recordSha256
    }),
    (error) => error.code === 'WMB_CACHE_REPLACE_STALE'
      && error.details.currentRecordSha256 === replacement.record.recordSha256
  );
  const current = await readWorldModelViewCache(root, components);
  assert.equal(current.viewBytes.toString('utf8'), replacementView);
  assert.equal(current.record.recordSha256, replacement.record.recordSha256);

  const racingViews = ['# Regenerate A\n', '# Regenerate B\n'];
  const raced = await Promise.allSettled(racingViews.map((view, index) => (
    writeWorldModelViewCache(root, components, {
      ...cacheInput(components, view, `2026-09-01T15:03:0${index}.000Z`),
      replaceExisting: true,
      expectedRecordSha256: replacement.record.recordSha256
    })
  )));
  assert.equal(raced.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((entry) => (
    entry.status === 'rejected' && entry.reason.code === 'WMB_CACHE_REPLACE_STALE'
  )).length, 1);
  const racedWinner = await readWorldModelViewCache(root, components);
  assert.ok(racingViews.includes(racedWinner.viewBytes.toString('utf8')));
});

test('conservative staleness receipt marks the whole view stale and stores canonically by hash', async (t) => {
  const root = await repository(t, 'sflow-wmb-v4-stale-');
  const input = {
    previousViewSha256: HASH('a'),
    cause: {
      kind: 'fact-ledger-change',
      previousSha256: HASH('b'),
      currentSha256: HASH('c')
    },
    affectedFactIds: ['fact:z', 'fact:a', 'fact:z'],
    viewId: 'dev.impact'
  };
  const receipt = createConservativeWorldModelStalenessReceipt(input);
  assert.equal(receipt.status, 'stale');
  assert.deepEqual(receipt.affectedFactIds, ['fact:a', 'fact:z']);
  assert.deepEqual(receipt.unaffectedFactIds, []);
  assert.deepEqual(receipt.nextAction, {
    operation: 'world-model.regenerate-view', view: 'dev.impact'
  });
  assert.equal(verifyWorldModelStalenessReceipt(receipt), true);
  assert.equal(verifyWorldModelStalenessReceipt({ ...receipt, status: 'current' }), false);

  const first = await storeConservativeWorldModelStalenessReceipt(root, receipt);
  const second = await storeConservativeWorldModelStalenessReceipt(root, receipt);
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(first.path, second.path);
  assert.ok(first.path.startsWith(worldModelViewCacheRoot(root)));
  const info = await lstat(first.path);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(await readFile(first.path, 'utf8'), canonicalJson(receipt));
});
