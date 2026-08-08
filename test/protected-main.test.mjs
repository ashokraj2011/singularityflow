import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition } from '../src/config.mjs';
import { publishEditorConfiguration } from '../src/editor.mjs';
import { defaultBranchName } from '../src/git.mjs';
import { validateId } from '../src/state.mjs';
import { attachStoryBranch } from '../src/story-lineage.mjs';
import { run } from '../src/util.mjs';

async function repository(branch = 'main') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-protected-main-'));
  run('git', ['init', '-q', '-b', branch], { cwd: root });
  run('git', ['config', 'user.name', 'Protected Main Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'protected@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# protected branch fixture\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

test('the detected remote default is used instead of assuming main', async () => {
  const root = await repository('trunk');
  run('git', ['remote', 'add', 'origin', root], { cwd: root });
  run('git', ['update-ref', 'refs/remotes/origin/trunk', 'HEAD'], { cwd: root });
  run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], { cwd: root });
  assert.equal(defaultBranchName(root), 'trunk');
  assert.equal(defaultBranchName(root, { defaultBaseBranch: 'release' }), 'release');
});

test('application branch names cannot become governed Work IDs', () => {
  const config = { idPattern: '^[A-Za-z0-9._-]+$', defaultBaseBranch: 'trunk' };
  for (const id of ['main', 'master', 'trunk']) {
    assert.throws(() => validateId(config, id), /reserved for application integration/);
  }
  assert.doesNotThrow(() => validateId(config, 'STORY-123'));
});

test('Story attachment is refused on the application branch before state is loaded', async () => {
  const root = await repository();
  await assert.rejects(
    () => attachStoryBranch(root, { defaultBaseBranch: 'main' }, { parentStoryId: 'STORY-1' }),
    /cannot run on protected application branch 'main'/
  );
});

test('editor publication is refused before staging or committing on the application branch', async () => {
  const root = await repository();
  await initializeDefinition(root);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', 'governed configuration fixture'], { cwd: root });
  const before = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  await assert.rejects(
    () => publishEditorConfiguration(root),
    /cannot run on protected application branch 'main'/
  );
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout, '');
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim(), before);
});
