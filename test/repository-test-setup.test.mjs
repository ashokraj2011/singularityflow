import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectRepositoryTestSetup } from '../src/repository-test-setup.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { skillForCommandLine } from '../src/command-skills.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('test setup reads a runner without executing scripts or manufacturing a baseline', async t => {
  const root = await fixture(t);
  const manifest = JSON.stringify({ scripts: { test: 'node --test test/*.test.mjs' } });
  await writeFile(path.join(root, 'package.json'), manifest);
  const before = await readdir(root);
  const result = await inspectRepositoryTestSetup(root);
  assert.equal(result.status, 'suggestions-available');
  assert.equal(result.testsExecuted, false);
  assert.equal(result.baseline, 'not-observed');
  assert.equal(result.suggestions[0].result.adapter, 'node-tap');
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), manifest);
});

test('nested applications are inspected explicitly, never by recursive monorepo scanning', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'apps', 'client'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'client', 'package.json'), JSON.stringify({ scripts: { test: 'ng test' }, devDependencies: { karma: '6.4.4' } }));
  const defaultResult = await inspectRepositoryTestSetup(root);
  assert.equal(defaultResult.status, 'pending-configuration');
  const result = await inspectRepositoryTestSetup(root, { sourceRoots: ['apps/client'] });
  assert.equal(result.suggestions[0].workingDirectory, 'apps/client');
  assert.equal(result.suggestions[0].result.adapter, 'karma-text');
  assert.deepEqual(result.suggestions[0].affectedRoots, ['apps/client']);
});

test('empty repositories, unsupported scripts and ambiguous modules return pending suggestions', async t => {
  const root = await fixture(t);
  assert.equal((await inspectRepositoryTestSetup(root)).status, 'pending-configuration');
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app', 'package.json'), JSON.stringify({ scripts: { test: 'custom-tool test' } }));
  await writeFile(path.join(root, 'app', 'pom.xml'), '<project/>');
  const result = await inspectRepositoryTestSetup(root, { sourceRoots: ['app'] });
  assert.equal(result.diagnostics[0].code, 'TEST_MODULE_AMBIGUOUS');
  assert.equal(result.testsExecuted, false);
});

test('inspection rejects escaping, glob, missing and symlinked module scopes', async t => {
  const root = await fixture(t);
  for (const scope of ['../other', '/tmp', 'C:/other', 'app/*', 'app\\client', 'app/../other']) {
    await assert.rejects(inspectRepositoryTestSetup(root, { sourceRoots: [scope] }));
  }
  await assert.rejects(inspectRepositoryTestSetup(root, { sourceRoots: Array(21).fill('.') }));
  await assert.rejects(inspectRepositoryTestSetup(root, { sourceRoots: ['missing'] }));
  await symlink(os.tmpdir(), path.join(root, 'outside'), 'dir');
  await assert.rejects(inspectRepositoryTestSetup(root, { sourceRoots: ['outside'] }), { code: 'REPOSITORY_PATH_UNSAFE' });
});

test('Windows suggestions use portable wrapper arguments without executing the wrapper', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'pom.xml'), '<project/>');
  await writeFile(path.join(root, 'mvnw.cmd'), '@echo SHOULD_NOT_RUN');
  const result = await inspectRepositoryTestSetup(root, { platform: 'win32' });
  assert.deepEqual(result.suggestions[0].argv, ['.\\mvnw.cmd', 'test']);
});

test('the new CLI inspection is model-free, read-only and has a packaged Copilot equivalent', async t => {
  const root = await fixture(t);
  const git = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(git.status, 0);
  const binary = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [binary, 'capability', 'test-setup', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_PROMPT_LOG: 'off' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).baseline, 'not-observed');
  assert.equal(skillForCommandLine('singularity-flow capability test-setup --json'), 'sf-test-setup');
  const operation = resolveOperation({ requestedCommand: 'capability', positionals: ['capability', 'test-setup'], options: {} });
  assert.equal(operation.classification, 'read');
  assert.equal(operation.modelPolicy, 'never');
});
