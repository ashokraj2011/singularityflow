import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectSkillPackage, inspectSkillPackageContents, readSealedSkillPackage,
  sealSkillPackageContents, skillInspectionView, SKP_CAPTURE_LIMITS, verifySkillPackage } from '../src/skp-package.mjs';

const supplied = () => new Map([
  ['SKILL.md', Buffer.from('# Exact\r\nRead [reference](references/exact.bin).\r\n')],
  ['references/exact.bin', Buffer.from([0, 10, 13, 255])],
  ['scripts/never-execute.mjs', Buffer.from('throw new Error("This retained source must never execute");\n')]
]);

test('sealed byte profile preserves existing package digest, literal resources and inert script findings', () => {
  const entries = supplied(); const ordinary = inspectSkillPackageContents('exact-skill', entries);
  const seal = sealSkillPackageContents('exact-skill', entries,
    { expectedPackageSha256: ordinary.manifest.packageSha256 });
  assert.equal(Object.isFrozen(seal), true);
  assert.deepEqual(Object.keys(seal).sort(), ['kind', 'packageSha256', 'skillId']);
  assert.equal(seal.kind, 'skill-package-byte-seal'); assert.equal('contents' in seal, false);
  const captured = readSealedSkillPackage(seal, { expectedPackageSha256: seal.packageSha256 });
  assert.deepEqual(captured.manifest, ordinary.manifest); assert.deepEqual(captured.contents, ordinary.contents);
  assert.deepEqual(captured.proposals, ordinary.proposals); assert.deepEqual(captured.findings, ordinary.findings);
  assert.equal(verifySkillPackage(captured).verified, true);
  assert.ok(captured.findings.some((finding) => finding.code === 'SKP_EFFECT_UNSUPPORTED'));
  assert.deepEqual(skillInspectionView(captured).captureProfile, {
    profile: 'copied-inert-bytes/v1', byteOwnership: 'private-copy',
    liveDirectoryContainment: 'not-established', approval: 'not-established', execution: 'not-admitted'
  });
  assert.deepEqual(captured.source, { kind: 'in-memory' });
  assert.equal(captured.metrics.fileReads, 0); assert.equal(captured.metrics.gitRequests, 0);
  assert.equal(captured.metrics.remoteCalls, 0); assert.equal(captured.metrics.modelCalls, 0);
});

test('input and every public extraction are disposable copies of the privately sealed exact bytes', () => {
  const entries = supplied(); const original = inspectSkillPackageContents('exact-skill', entries);
  const expectedManifest = structuredClone(original.manifest);
  const expectedContents = new Map([...original.contents].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  entries.get('SKILL.md').fill(0); entries.clear();
  original.contents.get('references/exact.bin').fill(1); original.contents.delete('SKILL.md');
  original.manifest.packageSha256 = `sha256:${'0'.repeat(64)}`;
  original.manifest.files.length = 0; original.findings.length = 0;
  original.source = { kind: 'approved-configuration', commit: 'f'.repeat(40) };
  original.metrics.remoteCalls = 99;
  const first = readSealedSkillPackage(original);
  assert.deepEqual(first.manifest, expectedManifest); assert.deepEqual(first.contents, expectedContents);
  assert.deepEqual(first.source, { kind: 'in-memory' }); assert.equal(first.metrics.remoteCalls, 0);
  first.contents.get('SKILL.md').fill(2); first.manifest.files.length = 0; first.proposals.push({ forged: true });
  const second = readSealedSkillPackage(first);
  assert.deepEqual(second.manifest, expectedManifest); assert.deepEqual(second.contents, expectedContents);
  assert.equal(second.proposals.some((row) => row.forged), false);
  assert.equal(verifySkillPackage(second).verified, true);
});

test('caller JSON, cloned handles, digest matches and source tags cannot manufacture a private byte seal', () => {
  const seal = sealSkillPackageContents('exact-skill', supplied());
  for (const forged of [JSON.parse(JSON.stringify(seal)), structuredClone(seal),
    { ...seal, source: { kind: 'approved-configuration' } },
    { manifest: readSealedSkillPackage(seal).manifest, contents: supplied() }, null, '/local/skill']) {
    assert.throws(() => readSealedSkillPackage(forged), { code: 'SKP_CAPTURE_UNQUALIFIED' });
  }
  assert.throws(() => readSealedSkillPackage(seal, { expectedPackageSha256: `sha256:${'0'.repeat(64)}` }),
    { code: 'SKP_SKILL_DRIFT' });
  assert.throws(() => sealSkillPackageContents('exact-skill', '/local/skill'), { code: 'SKP_PACKAGE_CORRUPT' });
});

test('live directory inspection remains explicitly unqualified even with an ancestor alias and rewritten metadata', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-seal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actualParent = path.join(root, 'actual'); const aliasParent = path.join(root, 'selected');
  await mkdir(path.join(actualParent, 'exact-skill'), { recursive: true }); await mkdir(aliasParent);
  await writeFile(path.join(actualParent, 'exact-skill', 'SKILL.md'), '# Literal candidate only\n');
  await symlink(actualParent, path.join(aliasParent, 'ancestor'), process.platform === 'win32' ? 'junction' : 'dir');
  const capture = await inspectSkillPackage(path.join(aliasParent, 'ancestor', 'exact-skill'));
  assert.equal(verifySkillPackage(capture).verified, true);
  const before = skillInspectionView(capture).captureProfile;
  assert.equal(before.liveDirectoryContainment, 'unqualified'); assert.equal(before.approval, 'not-established');
  capture.source = { kind: 'in-memory' }; capture.captureProfile = { profile: 'copied-inert-bytes/v1' };
  assert.deepEqual(skillInspectionView(capture).captureProfile, before);
  assert.throws(() => readSealedSkillPackage(capture,
    { expectedPackageSha256: capture.manifest.packageSha256 }), { code: 'SKP_CAPTURE_UNQUALIFIED' });
});

test('SharedArrayBuffer storage cannot masquerade as immutable bytes through own-property metadata', () => {
  const shared = Buffer.from(new SharedArrayBuffer(64)); shared.set(Buffer.from('# Shared\n'));
  Object.defineProperty(shared, 'buffer', { get() { throw new Error('Caller property must never be read'); } });
  for (const capture of [inspectSkillPackageContents, sealSkillPackageContents]) {
    assert.throws(() => capture('exact-skill', new Map([['SKILL.md', shared]])), { code: 'SKP_CAPTURE_UNSTABLE' });
  }
});

test('native byte copying never invokes caller buffer getters, valueOf or iterator hooks', () => {
  const entry = Buffer.from('# Literal\r\n'); const reference = Buffer.from('keep\r\n');
  const originalEntry = Buffer.from(entry); const originalReference = Buffer.from(reference);
  let hooks = 0;
  const unexpected = () => { hooks += 1; reference.fill(0); throw new Error('Buffer hook must not execute'); };
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'length']) {
    Object.defineProperty(entry, key, { get: unexpected });
  }
  entry.valueOf = unexpected; entry[Symbol.iterator] = unexpected;
  const capture = inspectSkillPackageContents('exact-skill', new Map([['SKILL.md', entry], ['references/ref.md', reference]]));
  assert.equal(hooks, 0); assert.deepEqual(capture.contents.get('SKILL.md'), originalEntry);
  assert.deepEqual(capture.contents.get('references/ref.md'), originalReference);
  assert.equal(verifySkillPackage(readSealedSkillPackage(capture)).verified, true);
});

test('exotic maps, proxies and capture-option accessors refuse before invoking caller hooks', () => {
  let calls = 0;
  class CallerMap extends Map {
    get size() { calls += 1; throw new Error('Map size hook'); }
    [Symbol.iterator]() { calls += 1; throw new Error('Map iterator hook'); }
  }
  const custom = new CallerMap([['SKILL.md', Buffer.from('# Exact\n')]]);
  const overridden = supplied(); overridden[Symbol.iterator] = () => { calls += 1; throw new Error('Own iterator'); };
  const proxied = new Proxy(supplied(), { get() { calls += 1; throw new Error('Proxy hook'); } });
  for (const entries of [custom, overridden, proxied]) {
    assert.throws(() => inspectSkillPackageContents('exact-skill', entries), { code: 'SKP_PACKAGE_CORRUPT' });
  }
  const proxyBytes = new Proxy(Buffer.from('# Exact\n'), {
    getPrototypeOf() { calls += 1; throw new Error('Proxy Buffer prototype hook'); }
  });
  assert.throws(() => inspectSkillPackageContents('exact-skill', new Map([['SKILL.md', proxyBytes]])),
    { code: 'SKP_PACKAGE_CORRUPT' });
  const options = Object.defineProperty({}, 'expectedPackageSha256', { enumerable: true,
    get() { calls += 1; throw new Error('Option getter'); } });
  for (const capture of [inspectSkillPackageContents, sealSkillPackageContents]) {
    assert.throws(() => capture('exact-skill', supplied(), options), { code: 'SKP_PACKAGE_CORRUPT' });
    assert.throws(() => capture('exact-skill', supplied(), { approved: true }), { code: 'SKP_PACKAGE_CORRUPT' });
  }
  assert.equal(calls, 0);
});

test('internal byte lengths enforce allocation budgets even when caller metadata claims a smaller file', () => {
  const entry = Buffer.alloc(SKP_CAPTURE_LIMITS.entryBytes + 1);
  Object.defineProperty(entry, 'byteLength', { value: 1 });
  assert.throws(() => sealSkillPackageContents('exact-skill', new Map([['SKILL.md', entry]])),
    (error) => error.code === 'SKP_BUDGET_EXCEEDED' && error.details?.dimension === 'entryBytes'
      && error.details.actual === SKP_CAPTURE_LIMITS.entryBytes + 1);
  const tooMany = new Map(Array.from({ length: SKP_CAPTURE_LIMITS.files + 1 }, (_, index) =>
    [`file-${index}.md`, Buffer.alloc(0)]));
  assert.throws(() => sealSkillPackageContents('exact-skill', tooMany),
    (error) => error.code === 'SKP_BUDGET_EXCEEDED' && error.details?.dimension === 'files');
});
