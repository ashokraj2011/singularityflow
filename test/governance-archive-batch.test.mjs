import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../src/util.mjs';
import { committedFilesAtRevisions } from '../src/git.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { GOVERNANCE_ARCHIVE_PATH, GOVERNANCE_ARCHIVE_VERSION,
  assertStoryNotArchived, governanceArchiveEntry } from '../src/governance-archive.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-archive-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, { cwd: root }).stdout.trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Archive fixture');
  git('config', 'user.email', 'archive@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Archive batch fixture\n');
  git('add', '.'); git('commit', '-qm', 'Base without archive');
  const base = git('rev-parse', 'HEAD');
  const workflow = { workItem: { id: 'ARCHIVE-1', createdAt: '2026-10-09',
    baseBranch: 'main', baseRemote: 'custom' }, resolution: { ledger: { branch: 'ledger', remote: 'state-origin' } } };
  const registry = (overrides = {}) => ({ schema: GOVERNANCE_ARCHIVE_VERSION, rebuilds: [], stories: [{
    id: workflow.workItem.id, createdAt: workflow.workItem.createdAt, archivedBy: 'rebuild-fixture', ...overrides
  }] });
  async function commitRegistry(value) {
    git('switch', '-q', '--detach', base);
    await mkdir(path.join(root, path.dirname(GOVERNANCE_ARCHIVE_PATH)), { recursive: true });
    await writeFile(path.join(root, GOVERNANCE_ARCHIVE_PATH), JSON.stringify(value));
    git('add', '.'); git('commit', '-qm', 'Archive fixture');
    const commit = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    return commit;
  }
  return { root, git, base, workflow, registry, commitRegistry };
}

test('an archive-free guard resolves all refs in one Git process, and does not cache absence', async t => {
  const f = await fixture(t);
  const timer = commandTimer('start');
  await withCommandTiming(timer, () => {
    assert.equal(governanceArchiveEntry(f.root, f.workflow), null);
    assert.equal(governanceArchiveEntry(f.root, f.workflow), null);
  });
  assert.equal(timer.finish().gitSpawns, 2, 'one batch resolution per guard, not five per-ref reads');
  const commit = await f.commitRegistry(f.registry());
  f.git('update-ref', 'refs/remotes/state-origin/ledger', commit);
  assert.equal(governanceArchiveEntry(f.root, f.workflow)?.archivedBy, 'rebuild-fixture',
    'a newly moved authority ref is read even after a prior negative result');
  assert.throws(() => assertStoryNotArchived(f.root, f.workflow), { code: 'STORY_ARCHIVED_BY_REBUILD' });
});

test('each supported archive ref is independently observed with exact Story incarnation matching', async t => {
  const f = await fixture(t);
  const commit = await f.commitRegistry(f.registry());
  for (const ref of ['refs/heads/main', 'refs/remotes/custom/main', 'refs/remotes/custom/sflow/config',
    'refs/heads/sflow/config', 'refs/remotes/state-origin/ledger']) {
    f.git('update-ref', ref, commit);
    // Keep the worktree archive absent so only the committed source answers.
    assert.equal(governanceArchiveEntry(f.root, f.workflow)?.id, 'ARCHIVE-1', ref);
    assert.equal(governanceArchiveEntry(f.root, { ...f.workflow,
      workItem: { ...f.workflow.workItem, createdAt: 'different-incarnation' } }), null);
    if (ref === 'refs/heads/main') f.git('update-ref', ref, f.base);
    else f.git('update-ref', '-d', ref);
    assert.equal(governanceArchiveEntry(f.root, f.workflow), null, 'removed archive refs are not retained');
  }
});

test('a registry above the view byte budget still enforces all-incarnation retirement', async t => {
  const f = await fixture(t);
  const commit = await f.commitRegistry({ ...f.registry({ allIncarnations: true }),
    notes: 'x'.repeat(4 * 1024 * 1024 + 1) });
  f.git('update-ref', 'refs/heads/sflow/config', commit);
  assert.equal(governanceArchiveEntry(f.root, { ...f.workflow,
    workItem: { ...f.workflow.workItem, createdAt: 'new-incarnation' } })?.allIncarnations, true);
});

test('one damaged copy does not prevent another committed archive from enforcing retirement', async t => {
  const f = await fixture(t);
  const damaged = await f.commitRegistry(f.registry({ archivedBy: 'damaged' }));
  const damagedBlob = f.git('rev-parse', `${damaged}:${GOVERNANCE_ARCHIVE_PATH}`);
  const valid = await f.commitRegistry(f.registry({ archivedBy: 'valid-copy' }));
  f.git('update-ref', 'refs/remotes/custom/main', damaged);
  f.git('update-ref', 'refs/heads/sflow/config', valid);
  await unlink(path.join(f.root, '.git/objects', damagedBlob.slice(0, 2), damagedBlob.slice(2)));
  assert.equal(governanceArchiveEntry(f.root, f.workflow)?.archivedBy, 'valid-copy');
});

test('strict batch reads distinguish byte-limit refusal from a positively absent file', async t => {
  const f = await fixture(t);
  const commit = await f.commitRegistry(f.registry());
  const requests = [{ key: 'archive', ref: commit, path: GOVERNANCE_ARCHIVE_PATH }];
  assert.equal(committedFilesAtRevisions(f.root, requests, { maximumObjectBytes: 1 }).size, 0,
    'ordinary bounded projections retain their optional-file behavior');
  assert.throws(() => committedFilesAtRevisions(f.root, requests,
    { maximumObjectBytes: 1, requireCompleteRead: true }), { code: 'GIT_COMMITTED_FILE_LIMIT' });
  assert.equal(committedFilesAtRevisions(f.root, [{ ...requests[0], ref: f.base }],
    { requireCompleteRead: true }).size, 0, 'an absent file does not trigger fallback');
});
