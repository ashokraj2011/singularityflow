import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configurationAssetPolicyFromRef } from '../src/configuration-branch.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { run } from '../src/util.mjs';

/**
 * Story start derived the asset policy of the application commit from the main checkout and the
 * new Story worktree; when that commit holds no policy files (configuration lives on its own
 * branch) every call read both files again. One shared object store now derives it once, and only
 * after the commit itself is proven present.
 */
async function spawned(work) {
  const timer = commandTimer('policy-memo', { commandClass: 'read' });
  const value = await withCommandTiming(timer, async () => work());
  return { value, spawns: timer.finish().counters['git.spawns'] ?? 0 };
}

test('a commit without policy files is derived once per object store, and an absent commit never is', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-policy-memo-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repository');
  const linked = path.join(base, 'linked');
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  run('git', ['config', 'user.name', 'Policy Memo'], { cwd: root });
  run('git', ['config', 'user.email', 'policy@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# application without policy files\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-qm', 'initial'], { cwd: root });
  run('git', ['worktree', 'add', '-q', '-b', 'STORY-MEMO', linked], { cwd: root });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();

  const first = await spawned(() => configurationAssetPolicyFromRef(root, commit));
  assert.equal(first.spawns, 3, 'two policy reads and one presence proof');
  const again = await spawned(() => [configurationAssetPolicyFromRef(linked, commit), configurationAssetPolicyFromRef(root, commit)]);
  assert.equal(again.spawns, 0, 'the linked worktree shares the main checkout object store');
  assert.equal(again.value[0], first.value);

  const absent = 'f'.repeat(40);
  const missing = await spawned(() => configurationAssetPolicyFromRef(root, absent));
  const missingAgain = await spawned(() => configurationAssetPolicyFromRef(root, absent));
  assert.equal(missingAgain.spawns, missing.spawns, 'an absent commit is read again, never remembered');
  assert.ok(missingAgain.spawns > 0);
});
