import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../src/util.mjs';
import { resolveWorldModelHistoryAuthority } from '../src/world-model/history/store.mjs';

function git(root, ...args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-history-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'WMP History Authority');
  git(root, 'config', 'user.email', 'wmp-history-authority@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'source');
  git(root, 'branch', 'state');
  return root;
}

test('history store does not accept a local state branch when the selected remote authority ref is absent', async (t) => {
  const root = await repository(t);
  const localStateCommit = git(root, 'rev-parse', 'refs/heads/state');

  assert.throws(
    () => resolveWorldModelHistoryAuthority(root, localStateCommit, {
      authorityRef: 'refs/remotes/origin/state'
    }),
    (error) => error?.code === 'WMP_AUTHORITY_REFRESH_REQUIRED'
      && error?.details?.authorityRef === 'refs/remotes/origin/state'
  );
});

test('history store admits the exact local branch cut for a deliberately remote-less authority', async (t) => {
  const root = await repository(t);
  const localStateCommit = git(root, 'rev-parse', 'refs/heads/state');

  assert.equal(resolveWorldModelHistoryAuthority(root, localStateCommit, {
    authorityRef: 'refs/heads/state'
  }), localStateCommit);
});
