import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeSourceHashExcludedRoots, normalizeTestConfigurationPaths } from '../src/source-path-policy.mjs';
import { sourceTreeHash, testInputTreeHash } from '../src/state.mjs';
import { sourcePathIncluded } from '../src/source-scope.mjs';
import { resolveCapabilitySourceScope, validateCapabilities } from '../src/capabilities.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('capability path controls refuse unsafe and nonportable exclusions', () => {
  assert.deepEqual(normalizeSourceHashExcludedRoots(['test/fixtures', 'generated']), ['generated', 'test/fixtures']);
  for (const invalid of ['..', '../outside', '/tmp', 'C:/temp', 'singularity', '.git/config', 'test\\fixtures', 'test/*']) {
    assert.throws(() => normalizeSourceHashExcludedRoots([invalid]));
    assert.throws(() => normalizeTestConfigurationPaths([invalid]));
  }
});

test('source hash and separately bound test inputs change independently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-source-policy-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    await mkdir(path.join(root, 'src/test/resources'), { recursive: true });
    await mkdir(path.join(root, 'generated'), { recursive: true });
    await writeFile(path.join(root, 'src/main.java'), 'class Main {}\n');
    await writeFile(path.join(root, 'src/test/resources/application-test.yml'), 'feature: false\n');
    await writeFile(path.join(root, 'generated/fixture.txt'), 'old\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'baseline');
    const workflow = { resolution: { capability: { sourceScope: {
      sourceHashExcludedRoots: ['generated'],
      testConfigurationPaths: ['src/test/resources/application-test.yml']
    } } } };
    const source = await sourceTreeHash(root, {}, workflow);
    const inputs = await testInputTreeHash(root, {}, workflow);
    await assert.rejects(testInputTreeHash(root, {}, { resolution: { capability: { sourceScope: {
      testConfigurationPaths: ['src/test/resources/missing.yml']
    } } } }), { code: 'TEST_CONFIGURATION_PATH_UNAVAILABLE' });
    await writeFile(path.join(root, 'generated/fixture.txt'), 'new\n');
    assert.equal(await sourceTreeHash(root, {}, workflow), source);
    assert.notEqual(await testInputTreeHash(root, {}, workflow), inputs);
    const changedInputs = await testInputTreeHash(root, {}, workflow);
    await writeFile(path.join(root, 'src/test/resources/application-test.yml'), 'feature: true\n');
    assert.equal(await sourceTreeHash(root, {}, workflow), source);
    assert.notEqual(await testInputTreeHash(root, {}, workflow), changedInputs);
    const finalInputs = await testInputTreeHash(root, {}, workflow);
    await writeFile(path.join(root, 'src/main.java'), 'class Main { int value; }\n');
    assert.notEqual(await sourceTreeHash(root, {}, workflow), source);
    assert.equal(await testInputTreeHash(root, {}, workflow), finalInputs);
    assert.equal(await readFile(path.join(root, 'generated/fixture.txt'), 'utf8'), 'new\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('World Model excludes an approved directory but retains explicit test configuration', () => {
  const definition = { worldModel: {
    sourceHashExcludedRoots: ['generated'],
    testConfigurationPaths: ['generated/test-config.yml']
  } };
  assert.equal(sourcePathIncluded('generated/fixture.txt', definition), false);
  assert.equal(sourcePathIncluded('generated/test-config.yml', definition), true);
  assert.equal(sourcePathIncluded('src/main.java', definition), true);
});

test('approved capability mapping pins separate test-input paths into the Story source scope', () => {
  const definition = validateCapabilities({ version: 2, management: { mode: 'sflow-cli' },
    capabilities: { app: { name: 'App', kind: 'delivery', repository: 'app',
      sourceRoots: ['src'], sourceHashExcludedRoots: ['src/test/fixtures'],
      testConfigurationPaths: ['src/test/resources/application-test.yml'] } } });
  assert.deepEqual(resolveCapabilitySourceScope(definition, 'app'), {
    sourceRoots: ['src'], sharedRoots: [], sourceHashExcludedRoots: ['src/test/fixtures'],
    testConfigurationPaths: ['src/test/resources/application-test.yml']
  });
  assert.throws(() => validateCapabilities({ version: 2, management: { mode: 'sflow-cli' },
    capabilities: { app: { name: 'App', kind: 'delivery', repository: 'app',
      sourceHashExcludedRoots: ['../outside'] } } }));
  const inherited = validateCapabilities({ version: 2, management: { mode: 'sflow-cli' },
    capabilities: {
      app: { name: 'App', kind: 'delivery', repository: 'app',
        sourceHashExcludedRoots: ['generated'] },
      child: { name: 'Child', kind: 'delivery', parent: 'app', repository: 'app',
        testConfigurationPaths: ['src/test/resources/application-test.yml'] }
    } });
  assert.deepEqual(resolveCapabilitySourceScope(inherited, 'child'), {
    sourceRoots: [], sharedRoots: [], sourceHashExcludedRoots: ['generated'],
    testConfigurationPaths: ['src/test/resources/application-test.yml']
  });
});
