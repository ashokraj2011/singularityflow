import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildChangeRegionManifest } from '../src/comprehension/contracts.mjs';
import {
  comprehensionSourceReference, comprehensionSourceReferences,
  readComprehensionSourceExpansion
} from '../src/comprehension/source-expansion.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'CMP Source']);
  git(root, ['config', 'user.email', 'cmp-source@example.test']);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'service.txt'), 'before service\n');
  await writeFile(path.join(root, 'src', 'deleted.txt'), 'before deletion\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  const after = Buffer.from(`after service\n${'bounded-page\n'.repeat(20)}`);
  await writeFile(path.join(root, 'src', 'service.txt'), after);
  await unlink(path.join(root, 'src', 'deleted.txt'));
  await writeFile(path.join(root, 'src', 'added.bin'), Buffer.from([0, 1, 2, 3, 255]));
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: 'HEAD', subject: { kind: 'comprehension-observation' }
  });
  return { root, after, manifest: buildChangeRegionManifest(changeSet) };
}

async function allPages(root, manifest, reference, maximumBytes = 17) {
  const chunks = [];
  let offset = 0;
  let final;
  do {
    final = await readComprehensionSourceExpansion(root, manifest, reference, {
      offset, maximumBytes
    });
    chunks.push(Buffer.from(final.content, 'base64'));
    offset = final.nextOffset;
  } while (offset !== null);
  return { bytes: Buffer.concat(chunks), final };
}

test('CMP exact-source references bind immutable before and digest-checked after bytes', async (t) => {
  const { root, after, manifest } = await fixture(t);
  const service = manifest.regions.find((region) => region.location.pathAfter === 'src/service.txt');
  const refs = comprehensionSourceReferences(manifest, service);
  assert.deepEqual(refs.map((entry) => entry.side), ['before', 'after']);
  assert.ok(refs.every((entry) => entry.ref.startsWith('sfref:comprehension:source:')));

  const before = await allPages(root, manifest, refs[0].ref, 4);
  assert.equal(before.bytes.toString('utf8'), 'before service\n');
  assert.equal(before.final.complete, true);
  assert.match(before.final.contentSha256, /^sha256:[a-f0-9]{64}$/u);

  const current = await allPages(root, manifest, refs[1].ref, 17);
  assert.deepEqual(current.bytes, after);
  assert.equal(current.final.authoritative, false);
  assert.equal(current.final.lifecycleGate, false);
  assert.equal(current.final.mode, 'observe-only');
});

test('CMP exact-source availability follows each change endpoint without inventing bytes', async (t) => {
  const { root, manifest } = await fixture(t);
  const added = manifest.regions.find((region) => region.location.pathAfter === 'src/added.bin');
  const deleted = manifest.regions.find((region) => region.location.pathBefore === 'src/deleted.txt');
  assert.deepEqual(comprehensionSourceReferences(manifest, added).map((entry) => entry.side), ['after']);
  assert.deepEqual(comprehensionSourceReferences(manifest, deleted).map((entry) => entry.side), ['before']);
  const binary = await readComprehensionSourceExpansion(
    root, manifest, comprehensionSourceReference(manifest, added, 'after').ref
  );
  assert.deepEqual(Buffer.from(binary.content, 'base64'), Buffer.from([0, 1, 2, 3, 255]));
  assert.equal(comprehensionSourceReference(manifest, added, 'before'), null);
  assert.equal(comprehensionSourceReference(manifest, deleted, 'after'), null);
});

test('CMP exact-source expansion refuses stale references, changed bytes, and invalid bounds', async (t) => {
  const { root, manifest } = await fixture(t);
  const service = manifest.regions.find((region) => region.location.pathAfter === 'src/service.txt');
  const reference = comprehensionSourceReference(manifest, service, 'after').ref;
  await assert.rejects(
    readComprehensionSourceExpansion(
      root,
      manifest,
      `${reference.slice(0, -1)}${reference.endsWith('0') ? '1' : '0'}`
    ),
    (error) => error.code === 'CMP_SOURCE_REFERENCE_STALE'
  );
  await assert.rejects(
    readComprehensionSourceExpansion(root, manifest, reference, { maximumBytes: 65 * 1024 }),
    (error) => error.code === 'CMP_SOURCE_LIMIT_INVALID'
  );
  await writeFile(path.join(root, 'src', 'service.txt'), 'changed after manifest\n');
  await assert.rejects(
    readComprehensionSourceExpansion(root, manifest, reference),
    (error) => error.code === 'CMP_SOURCE_DIGEST_MISMATCH'
  );
});
