/**
 * The Repository brief reads the committed source, but never a file the repository declares
 * environment-local (secrets, machine settings) and never anything under `worldModel.excludedRoots`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readKnowledgeSource } from '../src/knowledge/source.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, environments) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-knowledge-environment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'knowledge-environment@example.invalid');
  git(root, 'config', 'user.name', 'Knowledge Environment');
  for (const directory of ['src', 'config', 'generated/client', 'singularity']) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const application = true;\n');
  await writeFile(path.join(root, 'config', 'local-settings.mjs'), "export const token = 'historically-tracked';\n");
  await writeFile(path.join(root, 'generated', 'client', 'api.mjs'), 'export const generated = true;\n');
  await writeFile(path.join(root, '.env.local.mjs'), "export const secret = 'tracked';\n");
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'worldModel:\n  excludedRoots: [generated]\n');
  if (environments) await writeFile(path.join(root, 'singularity', 'environments.yml'), environments);
  // Raw Git simulates a repository that tracked local content before it declared it.
  git(root, 'add', '-f', '.');
  git(root, 'commit', '-qm', 'tracked environment-local content');
  return root;
}

const DECLARATION = [
  'schemaVersion: 1',
  'environments:',
  '  qa:',
  '    requires:',
  '      - name: API_TOKEN',
  '        kind: secret',
  '    localFiles:',
  '      - config/local-*.mjs',
  'checks: {}',
  'neverCommit:',
  '  - .env*',
  ''
].join('\n');

test('declared environment-local files and excluded roots are never read', async (t) => {
  const root = await fixture(t, DECLARATION);
  const listed = await readKnowledgeSource(root, { listOnly: true });
  assert.ok(listed.paths.includes('src/app.mjs'));
  for (const hidden of ['config/local-settings.mjs', '.env.local.mjs', 'generated/client/api.mjs']) {
    assert.equal(listed.paths.includes(hidden), false, hidden);
  }
  const read = await readKnowledgeSource(root);
  assert.deepEqual(read.files.map((file) => file.path).filter((file) => !file.startsWith('src/')), []);
});

test('without a declaration only the excluded roots are skipped', async (t) => {
  const root = await fixture(t, null);
  const listed = await readKnowledgeSource(root, { listOnly: true });
  assert.ok(listed.paths.includes('config/local-settings.mjs'));
  assert.equal(listed.paths.includes('generated/client/api.mjs'), false);
});

test('a declaration that cannot be read stops the read instead of reading what it would exclude', async (t) => {
  const root = await fixture(t, 'schemaVersion: 99\n');
  await assert.rejects(readKnowledgeSource(root, { listOnly: true }), (error) => error.code === 'KNOWLEDGE_SCOPE_INVALID'
    && /environments\.yml could not be read/u.test(error.message));
});
