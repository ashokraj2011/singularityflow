import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CONFIGURATION_BRANCH, STATE_CONFIGURATION_MANIFEST, configurationAssetPaths,
  ensureConfigurationBranch, inspectApprovedSkillPackage, loadStoryConfigurationSnapshot,
  captureVerifiedConfigurationAssetBytes,
  materializeConfigurationSnapshot, resolveStoryConfigurationAuthority,
  withStoryConfigurationSnapshotRead } from '../src/configuration-branch.mjs';
import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { configurationAssetPolicy } from '../src/configuration-assets.mjs';
import { configurationReadRoot, configurationReadScope, configurationReadSnapshot,
  isConfigurationReadPath, withConfigurationReadRoot } from '../src/configuration-read-scope.mjs';
import { gitRepositoryComparisonKey } from '../src/git-repository-identity.mjs';
import { recordSha256 } from '../src/records.mjs';
import { inspectSkillPackageContents, readSealedSkillPackage } from '../src/skp-package.mjs';
import { run } from '../src/util.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';

const skillId = 'mirror-exact-skill';
const entryBytes = Buffer.from('# Exact approved mirror\r\nRead [reference](references/guide.bin).\r\n');
const referenceBytes = Buffer.from([0, 13, 10, 255]);
const skillRoot = `singularity/skills/${skillId}`;
function git(root, ...args) { return run('git', args, { cwd: root }).stdout.trim(); }
function identity(root) {
  git(root, 'config', 'user.name', 'Private capture fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-approved-mirror-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const application = path.join(root, 'application'); const remote = path.join(root, 'authority.git');
  await mkdir(application); git(root, 'init', '-q', '-b', 'main', application); identity(application);
  await writeFile(path.join(application, 'README.md'), '# Application\n');
  git(application, 'add', '-A'); git(application, 'commit', '-qm', 'Application baseline');
  git(root, 'clone', '-q', '--bare', application, remote); await ensureConfigurationBranch(remote);
  const approved = path.join(root, 'approved'); git(root, 'clone', '-q', '-b', CONFIGURATION_BRANCH, remote, approved);
  identity(approved); await mkdir(path.join(approved, skillRoot, 'references'), { recursive: true });
  await writeFile(path.join(approved, skillRoot, 'SKILL.md'), entryBytes);
  await writeFile(path.join(approved, skillRoot, 'references/guide.bin'), referenceBytes);
  git(approved, 'add', '-A'); git(approved, 'commit', '-qm', 'Retain exact approved package');
  git(approved, 'push', '-q', 'origin', CONFIGURATION_BRANCH);
  const sourceCommit = git(approved, 'rev-parse', 'HEAD');
  const mirror = path.join(root, 'mirror'); git(root, 'init', '-q', '-b', 'state', mirror); identity(mirror);
  for (const folder of ['singularity', '.github']) await cp(path.join(approved, folder), path.join(mirror, folder), { recursive: true });
  const entries = new Map(git(approved, 'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)',
    'HEAD', '--', 'singularity', '.github/agents').split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' '); const second = line.indexOf(' ', first + 1);
    return [line.slice(second + 1), { mode: line.slice(0, first), object: line.slice(first + 1, second) }];
  }));
  const files = {}; const assets = {};
  for (const relative of await configurationAssetPaths(mirror)) {
    files[relative] = createHash('sha256').update(await readFile(path.join(mirror, relative))).digest('hex');
    assets[relative] = { ...entries.get(relative), sha256: files[relative] };
  }
  await mkdir(path.join(mirror, 'configuration'), { recursive: true });
  await writeFile(path.join(mirror, STATE_CONFIGURATION_MANIFEST), JSON.stringify({
    format: 'singularity-flow-configuration-mirror/v2', layout: 'canonical-paths',
    subject: { repositoryIdentity: `sha256:${recordSha256({ repositoryKey: gitRepositoryComparisonKey(remote) })}` },
    source: { branch: CONFIGURATION_BRANCH, commit: sourceCommit }, product: { version: 'test', revision: 'test' }, files, assets
  }));
  git(mirror, 'add', '-A'); git(mirror, 'commit', '-qm', 'Mirror exact approved configuration');
  git(mirror, 'remote', 'add', 'origin', remote); git(mirror, 'push', '-q', 'origin', 'state');
  git(remote, 'update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`);
  const checkout = path.join(root, 'checkout'); git(root, 'clone', '-q', '--no-local', '--single-branch', '-b', 'main', remote, checkout);
  const resolved = await resolveStoryConfigurationAuthority(checkout);
  assert.equal(resolved.branch, 'state');
  // Resolution legitimately retains its first verified snapshot. Capture only its exact scalar
  // authority here so the test schedules the independent snapshot read, not the reuse fast path.
  const authority = { remote: resolved.remote, branch: resolved.branch, commit: resolved.commit,
    sourceCommit: resolved.sourceCommit, source: resolved.source };
  return { checkout, remote, sourceCommit, authority };
}

test('ordinary verified recovery-mirror reads omit authoring capture while explicit fresh authoring uses one bounded private capture', async (t) => {
  const value = await fixture(t); const counts = new Map();
  const timer = { increment(name, amount) { counts.set(name, (counts.get(name) ?? 0) + amount); } };
  const refs = git(value.checkout, 'show-ref'); const status = git(value.checkout, 'status', '--porcelain');
  await withCommandTiming(timer, () => withApprovedConfigurationRead(value.checkout, () => {
    const snapshot = configurationReadSnapshot(value.checkout);
    assert.throws(() => captureVerifiedConfigurationAssetBytes(snapshot, { selectPaths: ['singularity/workflow.yml'] }),
      { code: 'APPROVED_CONFIGURATION_EXACT_BYTES_UNAVAILABLE' });
  }, { freshOwnerCapture: true }));
  assert.equal(counts.get('configuration.authoring-byte-capture') ?? 0, 0);
  await withCommandTiming(timer, () => withApprovedConfigurationRead(value.checkout, () => {
    const snapshot = configurationReadSnapshot(value.checkout);
    assert.equal(captureVerifiedConfigurationAssetBytes(snapshot, { selectPaths: ['singularity/workflow.yml'] }).length, 1);
  }, { freshOwnerCapture: true, captureAuthoringBytes: true }));
  assert.equal(counts.get('configuration.authoring-byte-capture'), 1, 'mirror resolution retains its opted-in raw profile for loader reuse');
  assert.equal(git(value.checkout, 'show-ref'), refs); assert.equal(git(value.checkout, 'status', '--porcelain'), status);
});

test('an ordinary retained mirror snapshot cannot be promoted to authoring bytes without another exact verified owner read', async (t) => {
  const value = await fixture(t); const counts = new Map();
  const timer = { increment(name, amount) { counts.set(name, (counts.get(name) ?? 0) + amount); } };
  await withCommandTiming(timer, async () => {
    const authority = await resolveStoryConfigurationAuthority(value.checkout);
    const ordinary = await loadStoryConfigurationSnapshot(authority);
    assert.equal(counts.get('configuration.snapshot-reused'), 1);
    assert.equal(counts.get('configuration.authoring-byte-capture') ?? 0, 0);
    assert.throws(() => captureVerifiedConfigurationAssetBytes(ordinary, { selectPaths: ['singularity/workflow.yml'] }),
      { code: 'APPROVED_CONFIGURATION_EXACT_BYTES_UNAVAILABLE' });
    const explicit = await loadStoryConfigurationSnapshot(authority, { captureAuthoringBytes: true });
    assert.notEqual(explicit, ordinary); assert.equal(explicit.sourceCommit, ordinary.sourceCommit);
    assert.equal(explicit.observedCommit, ordinary.observedCommit);
    assert.equal(counts.get('configuration.authoring-byte-capture'), 1);
    assert.equal(captureVerifiedConfigurationAssetBytes(explicit, { selectPaths: ['singularity/workflow.yml'] }).length, 1);
    assert.throws(() => captureVerifiedConfigurationAssetBytes(ordinary, { selectPaths: ['singularity/workflow.yml'] }),
      { code: 'APPROVED_CONFIGURATION_EXACT_BYTES_UNAVAILABLE' }, 'the original cached snapshot is not mutated or elevated');
  });
});

test('state-mirror package capture uses original verified Git blobs despite a post-hash materialized-file replacement', async (t) => {
  const value = await fixture(t); const before = git(value.checkout, 'status', '--porcelain');
  const beforeRefs = git(value.checkout, 'show-ref');
  const originalReadFile = fsPromises.readFile; const originalWriteFile = fsPromises.writeFile;
  const observations = new Map(); const overwritten = new Set();
  // Test-only deterministic scheduling of the real filesystem TOCTOU: return the bytes that the
  // ordinary mirror hash verifier read, then replace that materialized file before it resumes.
  // This does not claim an OS isolation test or modify the production owner with a fault hook.
  fsPromises.readFile = async function (file, ...options) {
    const bytes = await originalReadFile(file, ...options);
    const relative = typeof file === 'string' ? path.relative(os.tmpdir(), file).split(path.sep) : [];
    const suffix = relative.slice(1).join('/');
    if (relative[0]?.startsWith('sflow-story-config-read-')
        && [ `${skillRoot}/SKILL.md`, `${skillRoot}/references/guide.bin` ].includes(suffix)) {
      observations.set(suffix, (observations.get(suffix) ?? 0) + 1);
      if (!overwritten.has(suffix)) {
        overwritten.add(suffix);
        await originalWriteFile(file, suffix.endsWith('SKILL.md')
          ? '# Unapproved replacement in temporary materialization\n' : Buffer.from([7, 7, 7]));
      }
    }
    return bytes;
  };
  syncBuiltinESMExports();
  let snapshot;
  try { snapshot = await loadStoryConfigurationSnapshot(value.authority); }
  finally { fsPromises.readFile = originalReadFile; syncBuiltinESMExports(); }
  assert.deepEqual([...overwritten].sort(), [`${skillRoot}/SKILL.md`, `${skillRoot}/references/guide.bin`]);
  assert.deepEqual([...observations.values()], [1, 1], 'approved package bytes must never be reread from that mutable path after its hash check');
  const expected = inspectSkillPackageContents(skillId, new Map([['SKILL.md', entryBytes], ['references/guide.bin', referenceBytes]]));
  const captured = await inspectApprovedSkillPackage(snapshot, skillId,
    { expectedPackageSha256: expected.manifest.packageSha256 });
  assert.deepEqual(captured.contents, expected.contents);
  assert.deepEqual(captured.source, { kind: 'approved-configuration', branch: CONFIGURATION_BRANCH, commit: value.sourceCommit });
  const exactBytes = readSealedSkillPackage(captured, { expectedPackageSha256: expected.manifest.packageSha256 });
  assert.deepEqual(exactBytes.contents, expected.contents);
  assert.deepEqual(exactBytes.source, { kind: 'in-memory' }, 'a byte seal never manufactures the separately owned approval provenance');
  assert.equal(git(value.checkout, 'status', '--porcelain'), before);
  assert.equal(git(value.checkout, 'show-ref'), beforeRefs);
});

test('approved package byte ownership cannot invoke public Buffer hooks, yield before capture or be forged by copying snapshot symbols', async (t) => {
  const value = await fixture(t);
  const snapshot = await loadStoryConfigurationSnapshot(value.authority);
  const beforeRefs = git(value.checkout, 'show-ref');
  const expected = inspectSkillPackageContents(skillId, new Map([
    ['SKILL.md', entryBytes], ['references/guide.bin', referenceBytes]
  ]));
  // Copying the public symbol and exact-looking provenance is not an approved owner receipt.
  await assert.rejects(inspectApprovedSkillPackage({ ...snapshot }, skillId),
    { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' });
  const entry = snapshot.assets.find((asset) => asset.relative === `${skillRoot}/SKILL.md`);
  const reference = snapshot.assets.find((asset) => asset.relative === `${skillRoot}/references/guide.bin`);
  let hooks = 0;
  const unexpected = () => { hooks += 1; throw new Error('Public Buffer callback must not run'); };
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'length']) {
    Object.defineProperty(entry.contents, key, { get: unexpected });
  }
  entry.contents.valueOf = () => { hooks += 1; return Buffer.from('# Caller replacement\n'); };
  entry.contents[Symbol.iterator] = unexpected;
  const pending = inspectApprovedSkillPackage(snapshot, skillId,
    { expectedPackageSha256: expected.manifest.packageSha256 });
  // A caller can change its public buffers immediately after invocation, but there is no await
  // boundary before the synchronous hardened byte owner makes its separate exact private copies.
  Uint8Array.prototype.fill.call(entry.contents, 0);
  Uint8Array.prototype.fill.call(reference.contents, 0);
  const captured = await pending;
  assert.equal(hooks, 0);
  assert.deepEqual(captured.contents, expected.contents);
  assert.deepEqual(readSealedSkillPackage(captured).contents, expected.contents);
  assert.deepEqual(captured.source, {
    kind: 'approved-configuration', branch: CONFIGURATION_BRANCH, commit: value.sourceCommit
  });
  await assert.rejects(inspectApprovedSkillPackage(snapshot, skillId),
    { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' });
  assert.equal(git(value.checkout, 'status', '--porcelain'), '');
  assert.equal(git(value.checkout, 'show-ref'), beforeRefs);
});

test('fresh approved reads suspend counterfeit overlays, select actual canonical authority and restore normal nested scope', async (t) => {
  const value = await fixture(t);
  const genuine = await withApprovedConfigurationRead(value.checkout, async (authority) => ({
    authority, policy: configurationReadScope(value.checkout).assetPolicy,
    workflow: await readFile(path.join(configurationReadRoot(value.checkout), 'singularity/workflow.yml'))
  }), { freshOwnerCapture: true });
  const counterfeit = path.join(path.dirname(value.checkout), 'counterfeit');
  await mkdir(counterfeit);
  await initializeDefinition(counterfeit);
  await writeFile(path.join(counterfeit, 'singularity/workflow.yml'), 'version: 1\n# Unverified caller overlay\n');
  const fakeAuthority = { kind: 'approved-configuration-ref', remote: path.join(counterfeit, 'nonexistent.git'),
    ref: 'refs/heads/sflow/config', commit: 'a'.repeat(40) };
  const before = git(value.checkout, 'status', '--porcelain');
  const refs = git(value.checkout, 'show-ref');
  await withConfigurationReadRoot(value.checkout, counterfeit, fakeAuthority, async () => {
    const inherited = await withApprovedConfigurationRead(value.checkout, (authority) => authority);
    assert.equal(inherited, fakeAuthority, 'ordinary nested read semantics remain request-local');
    const fresh = await withApprovedConfigurationRead(value.checkout, async (authority) => ({
      authority, policy: configurationReadScope(value.checkout).assetPolicy,
      workflow: await readFile(path.join(configurationReadRoot(value.checkout), 'singularity/workflow.yml')),
      skill: await readFile(path.join(configurationReadRoot(value.checkout), `${skillRoot}/SKILL.md`)),
      snapshot: configurationReadSnapshot(value.checkout),
      agentPathsAllowed: isConfigurationReadPath('.github/agents/fixture.agent.md')
    }), {
      freshOwnerCapture: true,
      // The owner option forces genuinely fresh canonical admission, not these caller fallbacks.
      preferAuthority: false, refreshAuthority: false, allowLocalHeads: true,
      canonicalRemote: fakeAuthority.remote
    });
    assert.deepEqual(fresh.authority, genuine.authority);
    assert.deepEqual(fresh.policy, genuine.policy);
    assert.deepEqual(fresh.workflow, genuine.workflow);
    assert.deepEqual(fresh.skill, entryBytes);
    assert.equal(fresh.agentPathsAllowed, true, 'ambient counterfeit policy must not contaminate the fresh capture');
    assert.ok(fresh.snapshot);
    assert.equal(configurationReadRoot(value.checkout), counterfeit, 'the caller overlay resumes after the fresh callback');
  }, { assetPolicy: configurationAssetPolicy({ templatesRoot: 'company/counterfeit',
    configurationAssetRoots: ['company/counterfeit'] }) });
  assert.equal(configurationReadScope(value.checkout), null);
  assert.equal(git(value.checkout, 'status', '--porcelain'), before);
  assert.equal(git(value.checkout, 'show-ref'), refs);
});

test('fresh owner absence never inherits a counterfeit or falls back to working-tree bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-owner-absent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const application = path.join(root, 'application');
  await mkdir(application); git(root, 'init', '-q', '-b', 'main', application); identity(application);
  await initializeDefinition(application);
  await writeFile(path.join(application, 'README.md'), '# Local authoring is not remote approval\n');
  git(application, 'add', '-A'); git(application, 'commit', '-qm', 'Local baseline');
  const fake = { kind: 'approved-configuration-ref', remote: path.join(root, 'not-a-repository.git'),
    ref: 'refs/heads/sflow/config', commit: 'a'.repeat(40) };
  const result = await withConfigurationReadRoot(application, application, fake,
    () => withApprovedConfigurationRead(application, (authority) => authority, { freshOwnerCapture: true }));
  assert.equal(result, null);
  assert.equal(git(application, 'status', '--porcelain'), '');
});

test('snapshot mounts and materialization reject copied-symbol lookalikes before callback or destination removal', async (t) => {
  const value = await fixture(t); const snapshot = await loadStoryConfigurationSnapshot(value.authority);
  const forged = { ...snapshot };
  const sentinel = path.join(value.checkout, 'singularity/templates/private-existing.md');
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, '# Must remain untouched\n');
  let invoked = false;
  await assert.rejects(withStoryConfigurationSnapshotRead(value.checkout, forged, () => { invoked = true; }),
    { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' });
  await assert.rejects(materializeConfigurationSnapshot(value.checkout, { snapshot: forged }),
    { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' });
  assert.equal(invoked, false);
  assert.equal(await readFile(sentinel, 'utf8'), '# Must remain untouched\n');
  assert.equal(await stat(path.join(value.checkout, 'singularity/workflow.yml')).catch(() => null), null);
  for (const [selectPaths, code] of [
    [[`${skillRoot}/SKILL.md`], 'APPROVED_CONFIGURATION_SELECTION_INVALID'],
    [['singularity/workflow.yml', 'README.md'], 'APPROVED_CONFIGURATION_SELECTION_INVALID'],
    [['singularity/workflow.yml', 'singularity/templates/absent.md'], 'APPROVED_CONFIGURATION_INCOMPLETE']
  ]) {
    await assert.rejects(withStoryConfigurationSnapshotRead(value.checkout, snapshot,
      () => { invoked = true; }, { selectPaths }), { code });
  }
  assert.equal(invoked, false, 'invalid or incomplete selections never mount a callback');
  const last = snapshot.assets.at(-1);
  Uint8Array.prototype.fill.call(last.contents, 0);
  await assert.rejects(materializeConfigurationSnapshot(value.checkout, { snapshot }),
    { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' });
  assert.equal(await readFile(sentinel, 'utf8'), '# Must remain untouched\n',
    'a mismatch at the end of the closure is refused before any destination cleanup');
});

test('snapshot mounts synchronously own selected native buffers before their first await', async (t) => {
  const value = await fixture(t); const snapshot = await loadStoryConfigurationSnapshot(value.authority);
  const selected = ['singularity/workflow.yml', `${skillRoot}/SKILL.md`];
  const workflow = snapshot.assets.find((entry) => entry.relative === selected[0]);
  const skill = snapshot.assets.find((entry) => entry.relative === selected[1]);
  const expectedWorkflow = Buffer.from(workflow.contents);
  const omitted = snapshot.assets.find((entry) => entry.relative === `${skillRoot}/references/guide.bin`);
  Uint8Array.prototype.fill.call(omitted.contents, 0);
  let hooks = 0;
  const unexpected = () => { hooks += 1; throw new Error('Public Buffer callback must not run'); };
  for (const bytes of [workflow.contents, skill.contents]) {
    for (const key of ['buffer', 'byteLength', 'byteOffset', 'length']) Object.defineProperty(bytes, key, { get: unexpected });
    bytes.valueOf = unexpected; bytes.toString = unexpected; bytes[Symbol.iterator] = unexpected;
  }
  const pending = withStoryConfigurationSnapshotRead(value.checkout, snapshot, async () => ({
    workflow: await readFile(path.join(configurationReadRoot(value.checkout), selected[0])),
    skill: await readFile(path.join(configurationReadRoot(value.checkout), selected[1])),
    omitted: await stat(path.join(configurationReadRoot(value.checkout), omitted.relative)).catch(() => null),
    snapshot: configurationReadSnapshot(value.checkout)
  }), { selectPaths: selected });
  Uint8Array.prototype.fill.call(workflow.contents, 0); Uint8Array.prototype.fill.call(skill.contents, 0);
  const read = await pending;
  assert.equal(hooks, 0);
  assert.deepEqual(read.workflow, expectedWorkflow); assert.deepEqual(read.skill, entryBytes);
  assert.equal(read.omitted, null); assert.equal(read.snapshot, null);
  await assert.rejects(withStoryConfigurationSnapshotRead(value.checkout, snapshot, () => null,
    { selectPaths: selected }), { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' });
  assert.equal(git(value.checkout, 'status', '--porcelain'), '');
});

test('materialization captures the entire verified closure before clearing or yielding to mutable public buffers', async (t) => {
  const value = await fixture(t); const snapshot = await loadStoryConfigurationSnapshot(value.authority);
  const workflow = snapshot.assets.find((entry) => entry.relative === 'singularity/workflow.yml');
  const skill = snapshot.assets.find((entry) => entry.relative === `${skillRoot}/SKILL.md`);
  const expectedWorkflow = Buffer.from(workflow.contents);
  let hooks = 0;
  for (const key of ['length', 'buffer']) Object.defineProperty(skill.contents, key, {
    get() { hooks += 1; throw new Error('Public Buffer callback must not run'); }
  });
  skill.contents.valueOf = () => { hooks += 1; throw new Error('Public Buffer valueOf must not run'); };
  const pending = materializeConfigurationSnapshot(value.checkout, { snapshot });
  for (const asset of snapshot.assets) Uint8Array.prototype.fill.call(asset.contents, 0);
  const result = await pending;
  assert.equal(hooks, 0);
  assert.equal(result.commit, value.sourceCommit);
  assert.deepEqual(await readFile(path.join(value.checkout, workflow.relative)), expectedWorkflow);
  assert.deepEqual(await readFile(path.join(value.checkout, skill.relative)), entryBytes);
  assert.deepEqual(await readFile(path.join(value.checkout, `${skillRoot}/references/guide.bin`)), referenceBytes);
  assert.equal(await readFile(path.join(value.checkout, 'README.md'), 'utf8'), '# Application\n');
  const sentinel = path.join(value.checkout, 'singularity/templates/private-existing.md');
  await writeFile(sentinel, '# Preserve when changed retained bytes refuse\n');
  await assert.rejects(materializeConfigurationSnapshot(value.checkout, { snapshot }),
    { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' });
  assert.equal(await readFile(sentinel, 'utf8'), '# Preserve when changed retained bytes refuse\n');
});
