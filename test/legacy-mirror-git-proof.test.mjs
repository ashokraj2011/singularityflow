import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { configurationAssetPaths, configurationTreeEntries, legacyStateMirrorMatchesRepository,
  loadStoryConfigurationSnapshot, STATE_CONFIGURATION_FORMAT, STATE_CONFIGURATION_MANIFEST,
  stateConfigurationHistoryBranch } from '../src/configuration-branch.mjs';
import { run } from '../src/util.mjs';

function git(root, ...args) { return run('git', args, { cwd: root }).stdout.trim(); }
function identity(root) {
  git(root, 'config', 'user.name', 'Exact legacy fixture');
  git(root, 'config', 'user.email', 'legacy@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
}
async function fixture(t, { portfolio = 'own', oversized = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-legacy-git-proof-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const approved = path.join(base, 'approved'); const mirror = path.join(base, 'mirror');
  const remote = path.join(base, 'authority.git');
  await mkdir(approved); git(base, 'init', '-q', '-b', 'sflow/config', approved); identity(approved);
  await initializeDefinition(approved);
  const repository = { url: portfolio === 'foreign' ? path.join(base, 'foreign.git') : remote };
  await writeFile(path.join(approved, 'singularity/portfolio.yml'), YAML.stringify({ version: 1,
    repositories: { authority: repository, ...(portfolio === 'duplicate' ? { second: repository } : {}) } }));
  await writeFile(path.join(approved, 'singularity/reviewed.md'), '# Exact historical policy\n');
  if (oversized) await writeFile(path.join(approved, 'singularity/large.bin'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  git(approved, 'add', '-A'); git(approved, 'commit', '-qm', 'Exact approved legacy source');
  const sourceCommit = git(approved, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', '--bare', approved, remote);
  const historyBranch = stateConfigurationHistoryBranch(sourceCommit);
  git(remote, 'update-ref', `refs/heads/${historyBranch}`, sourceCommit);
  await mkdir(mirror); git(base, 'init', '-q', '-b', 'state', mirror); identity(mirror);
  const entries = configurationTreeEntries(approved);
  const files = {}; const assets = {};
  for (const relative of await configurationAssetPaths(approved)) {
    const target = path.join(mirror, relative); await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(approved, relative), target);
    files[relative] = createHash('sha256').update(await readFile(target)).digest('hex');
    const { object, mode } = entries.get(relative); assets[relative] = { object, mode, sha256: files[relative] };
  }
  const manifest = { format: STATE_CONFIGURATION_FORMAT, layout: 'canonical-paths',
    source: { branch: 'sflow/config', commit: sourceCommit },
    history: { branch: historyBranch, commit: sourceCommit }, files, assets };
  const publish = async () => {
    await mkdir(path.join(mirror, 'configuration'), { recursive: true });
    await writeFile(path.join(mirror, STATE_CONFIGURATION_MANIFEST), `${JSON.stringify(manifest)}\n`);
    git(mirror, 'add', '-A'); git(mirror, 'commit', '-qm', 'Exact fixture mirror');
    const commit = git(mirror, 'rev-parse', 'HEAD');
    // Populate only this fixture's bare object database; no provider/network push is involved.
    await cp(path.join(mirror, '.git/objects'), path.join(remote, 'objects'), { recursive: true });
    git(remote, 'update-ref', 'refs/heads/state', commit);
    git(remote, 'update-ref', '-d', 'refs/heads/sflow/config');
    return { remote, branch: 'state', commit, sourceCommit, source: 'verified-state-mirror' };
  };
  return { approved, mirror, remote, manifest, historyBranch, publish };
}

test('generic no-checkout reader accepts a strict legitimate unbound legacy mirror without migration', async (t) => {
  const f = await fixture(t); const authority = await f.publish();
  const before = git(f.remote, 'show-ref');
  const snapshot = await loadStoryConfigurationSnapshot(authority);
  assert.equal(snapshot.sourceCommit, authority.sourceCommit); assert.equal(snapshot.observedCommit, authority.commit);
  assert.ok(snapshot.assets.some((entry) => entry.relative === 'singularity/portfolio.yml'));
  assert.equal(git(f.remote, 'show-ref'), before, 'a read never republishes a subject or moves authority refs');
  const retainedManifest = JSON.parse(git(f.remote, 'show', `state:${STATE_CONFIGURATION_MANIFEST}`));
  assert.equal(retainedManifest.subject, undefined, 'the old manifest remains unmodified');
  assert.equal(await legacyStateMirrorMatchesRepository(f.mirror, f.remote), true,
    'the existing checked-out/onboarding compatibility owner remains usable');
});

test('foreign and ambiguous portfolio identities cannot bind an unbound legacy mirror', async (t) => {
  for (const portfolio of ['foreign', 'duplicate']) await t.test(portfolio, async (child) => {
    const f = await fixture(child, { portfolio }); const authority = await f.publish();
    await assert.rejects(loadStoryConfigurationSnapshot(authority), { code: 'STATE_CONFIGURATION_MIRROR_SUBJECT_MISMATCH' });
  });
});

test('current tree descriptors and retained historical Git modes are independently exact', async (t) => {
  for (const which of ['descriptor', 'historical']) await t.test(which, async (child) => {
    const f = await fixture(child); const relative = 'singularity/reviewed.md';
    f.manifest.assets[relative].mode = '100755';
    if (which === 'historical') { await chmod(path.join(f.mirror, relative), 0o755); git(f.mirror, 'update-index', '--add', '--chmod=+x', relative); }
    const authority = await f.publish();
    await assert.rejects(loadStoryConfigurationSnapshot(authority), {
      code: which === 'descriptor' ? 'STATE_CONFIGURATION_MIRROR_INVALID' : 'STATE_CONFIGURATION_MIRROR_SUBJECT_MISMATCH'
    });
  });
});

test('a resealed mirror cannot substitute changed bytes for the exact retained source', async (t) => {
  const f = await fixture(t); const relative = 'singularity/reviewed.md';
  const bytes = Buffer.from('# Different state policy\n'); await writeFile(path.join(f.mirror, relative), bytes);
  f.manifest.files[relative] = createHash('sha256').update(bytes).digest('hex');
  f.manifest.assets[relative] = { mode: '100644', object: git(f.mirror, 'hash-object', '-w', relative),
    sha256: f.manifest.files[relative] };
  await assert.rejects(loadStoryConfigurationSnapshot(await f.publish()), { code: 'STATE_CONFIGURATION_MIRROR_SUBJECT_MISMATCH' });
});

test('missing history and wrong source-addressed history OIDs never become compatibility proof', async (t) => {
  for (const which of ['missing', 'wrong']) await t.test(which, async (child) => {
    const f = await fixture(child); const authority = await f.publish();
    git(f.remote, 'update-ref', ...(which === 'missing' ? ['-d', `refs/heads/${f.historyBranch}`]
      : [`refs/heads/${f.historyBranch}`, authority.commit]));
    await assert.rejects(loadStoryConfigurationSnapshot(authority), { code: 'STATE_CONFIGURATION_MIRROR_SUBJECT_MISMATCH' });
  });
});

test('legacy exact Git proof refuses oversized selected blobs rather than using live files', async (t) => {
  const f = await fixture(t, { oversized: true });
  await assert.rejects(loadStoryConfigurationSnapshot(await f.publish()), { code: 'STATE_CONFIGURATION_MIRROR_SUBJECT_MISMATCH' });
});
