import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { artifactChangeInventory } from '../src/git.mjs';
import { removeTemporaryTree } from '../src/util.mjs';

test('one artifact inventory retains staged, unstaged, deleted, renamed and untracked paths without changing the index', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-artifact-inventory-'));
  t.after(() => removeTemporaryTree(root));
  const git = (...args) => {
    const observed = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(observed.status, 0, observed.stderr);
    return observed.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Inventory Fixture');
  git('config', 'user.email', 'inventory@example.invalid');
  for (const name of ['staged.md', 'unstaged.md', 'delete.md', 'old name.md']) await writeFile(path.join(root, name), `${name}\n`);
  git('add', '.'); git('commit', '-qm', 'initial');
  await writeFile(path.join(root, 'staged.md'), 'staged change\n');
  git('add', 'staged.md');
  await writeFile(path.join(root, 'unstaged.md'), 'unstaged change\n');
  await unlink(path.join(root, 'delete.md'));
  git('mv', 'old name.md', 'new name.md');
  const unusual = process.platform === 'win32' ? 'untracked ü.md' : 'untracked\tü\n.md';
  await mkdir(path.join(root, 'evidence'));
  await writeFile(path.join(root, 'evidence', unusual), 'untracked evidence\n');
  const index = await readFile(path.join(root, '.git/index'));
  const observed = artifactChangeInventory(root);
  assert.deepEqual(observed.paths, ['delete.md', `evidence/${unusual}`, 'new name.md', 'old name.md', 'staged.md', 'unstaged.md'].sort());
  assert.deepEqual([...observed.untracked], [`evidence/${unusual}`]);
  assert.deepEqual(await readFile(path.join(root, '.git/index')), index);
});
