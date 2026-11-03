import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { run } from '../src/util.mjs';
import { discoverCommitPolicy } from '../src/repository-commit-policy/discovery.mjs';

test('effective inherited hooks and setup are observed without executing scripts or JavaScript config', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rcp-discover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', root]);
  const hooks = path.join(root, 'team-hooks'); await mkdir(hooks);
  await writeFile(path.join(hooks, 'commit-msg'), '#!/bin/sh\ntouch EXECUTED\n'); await chmod(path.join(hooks, 'commit-msg'), 0o755);
  await writeFile(path.join(root, 'commitlint.config.cjs'), "require('node:fs').writeFileSync('JS-EXECUTED','bad'); module.exports={};\n");
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { prepare: 'touch INSTALLED' } }));
  const inherited = path.join(root, 'inherited.conf'); await writeFile(inherited, '[core]\n\thooksPath = team-hooks\n');
  run('git', ['config', 'include.path', inherited], { cwd: root });
  const before = await readFile(path.join(root, '.git/config'));
  const found = await discoverCommitPolicy(root);
  assert.equal(found.effectiveHooksPath, await realpath(hooks));
  assert.equal(found.hooks.find(hook => hook.stage === 'commit-msg').status, 'present');
  assert.equal(found.hooks.find(hook => hook.stage === 'commit-msg').execution, 'not-executed');
  assert.ok(found.configuration.some(row => row.origin.includes('inherited.conf') && row.name === 'core.hookspath'));
  for (const marker of ['EXECUTED', 'JS-EXECUTED', 'INSTALLED']) await assert.rejects(readFile(path.join(root, marker)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(root, '.git/config')), before);
  assert.ok(found.setup.some(row => row.path === 'commitlint.config.cjs' && row.classification === 'recognized'));
});

test('checked-in Husky setup remains separate from missing installed native hooks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rcp-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', root]); await mkdir(path.join(root, '.husky'));
  await writeFile(path.join(root, '.husky', 'pre-commit'), '#!/bin/sh\nnpm test\n');
  const found = await discoverCommitPolicy(root);
  assert.equal(found.hooks.find(hook => hook.stage === 'pre-commit').status, 'missing');
  assert.ok(found.setup.some(row => row.path === '.husky/pre-commit'));
  assert.equal(found.observationsOnly, true);
});
