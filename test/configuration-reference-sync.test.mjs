import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncConfigurationReferences } from '../src/configuration-reference-sync.mjs';

const remote = 'https://git.example.test/config.git';
const commit = 'a'.repeat(40);
function fixture(overrides = {}) {
  const calls = [];
  const services = {
    readRegistry: async () => [{ path: '/workspace', leadRepositoryPath: '/workspace/repos/ui' }, { path: '/unrelated' }],
    readWorkspace: async path => { calls.push(['workspace', path]); return { path,
      repositories: { ui: { path: 'repos/ui' }, api: { path: 'repos/api' } } }; },
    git: (_exe, _args, { cwd }) => ({ status: 0,
      stdout: cwd.includes('story-worktrees') ? `${cwd}/private-git\n/workspace/repos/ui/.git\n` : `${cwd}/.git\n.git\n` }),
    readAttachment: async path => { calls.push(['pin', path]); return { descriptor: { route: { kind: 'remote' }, authority: { locator: remote } } }; },
    refresh: async (path, options) => { calls.push(['refresh', path, options]); return { status: 'refreshed', descriptor: { authority: { sourceCommit: commit } } }; },
    ...overrides
  };
  return { calls, services };
}

test('one sync updates known selected-workspace pins, not Story pins or unrelated workspaces', async () => {
  const f = fixture();
  const root = '/workspace/.singularity-flow/story-worktrees/story';
  const result = await syncConfigurationReferences(root, remote, commit, { services: f.services });
  assert.equal(result.status, 'complete');
  // Paths as this platform spells them: on Windows `/workspace` is a directory on the current drive.
  assert.ok(result.results.some(item => item.path === path.resolve(root) && item.status === 'preserved'));
  assert.deepEqual(f.calls.filter(item => item[0] === 'refresh'), [
    ['refresh', path.join('/workspace', 'repos/ui'), { expectedConfigCommit: commit }],
    ['refresh', path.join('/workspace', 'repos/api'), { expectedConfigCommit: commit }]
  ]);
  assert.equal(f.calls.some(item => item[1] === '/unrelated'), false);
});

test('a workspace registered under another spelling of its directory is still the selected one', async (t) => {
  // A registration keeps the spelling it was made with (a Windows 8.3 short name, here a link; a
  // junction needs no privilege on Windows), while the checkout's root is Git's spelling.
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-reference-sync-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'workspace');
  await mkdir(path.join(workspace, 'repos', 'ui'), { recursive: true });
  const alias = path.join(base, 'alias');
  await symlink(workspace, alias, 'junction');
  const f = fixture({ readRegistry: async () => [{ path: alias }] });
  const root = path.join(workspace, 'repos', 'ui');
  await syncConfigurationReferences(root, remote, commit, { services: f.services });
  assert.deepEqual(f.calls.filter((item) => item[0] === 'workspace'), [['workspace', alias]]);
});

test('missing, unattached and differently pinned checkouts are not cloned or redirected', async () => {
  const f = fixture({ readRegistry: async () => [], readAttachment: async () => null });
  let result = await syncConfigurationReferences('/repo', remote, commit, { services: f.services });
  assert.equal(result.results[0].status, 'not-attached');
  const other = fixture({ readRegistry: async () => [], readAttachment: async () => ({ descriptor: {
    route: { kind: 'remote' }, authority: { locator: 'https://git.example.test/other.git' } } }) });
  result = await syncConfigurationReferences('/repo', remote, commit, { services: other.services });
  assert.equal(result.results[0].status, 'preserved');
  assert.equal([...f.calls, ...other.calls].some(item => item[0] === 'refresh'), false);
});

test('a pin mismatch or refresh failure is disclosed and never called complete', async () => {
  const f = fixture({ readRegistry: async () => [], refresh: async () => ({ status: 'refreshed', descriptor: { authority: { sourceCommit: 'b'.repeat(40) } } }) });
  const result = await syncConfigurationReferences('/repo', remote, commit, { services: f.services });
  assert.equal(result.status, 'attention');
  assert.match(result.results[0].reason, /exact synchronized configuration/u);
});
