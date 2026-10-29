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
import { childTimeout } from './helpers/child-timeout.mjs';

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

test('a module lists its unit command and the separate Playwright run publication adds beside it', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'web', 'package.json'), JSON.stringify({
    scripts: { test: 'vitest run', 'test:e2e': 'playwright test' }, devDependencies: { '@playwright/test': '^1.0.0' }
  }));
  const result = await inspectRepositoryTestSetup(root, { sourceRoots: ['apps/web'] });
  assert.deepEqual(result.suggestions.map(entry => [entry.id, entry.workingDirectory, entry.result.adapter]), [
    ['apps/web-node-tests', 'apps/web', 'vitest-json'], ['apps/web-playwright-tests', 'apps/web', 'playwright-json']
  ]);
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
    cwd: root, encoding: 'utf8', timeout: childTimeout(30000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_PROMPT_LOG: 'off' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).baseline, 'not-observed');
  assert.equal(skillForCommandLine('singularity-flow capability test-setup --json'), 'sf-test-setup');
  const operation = resolveOperation({ requestedCommand: 'capability', positionals: ['capability', 'test-setup'], options: {} });
  assert.equal(operation.classification, 'read');
  assert.equal(operation.modelPolicy, 'never');
});

// An office Copilot turn got only "invalid structured test configuration" and the generic recover plan,
// so it could not tell what was wrong and went looking for the CLI's source (2026-10-29).
test('a proposed test command that is not runnable names the field and the inspection that lists runnable ones', async () => {
  const { planTestCommandProposal } = await import('../src/test-setup-proposal.mjs');
  const { refusalRemediationPlan } = await import('../src/refusal-remediation.mjs');
  const command = { id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter: 'mystery', path: 'reports/unit.xml' } };
  const refused = await planTestCommandProposal(process.cwd(), { step: 'implementation', command }).then(() => null, (error) => error);
  assert.equal(refused?.code, 'TEST_SETUP_COMMAND_INVALID');
  assert.match(refused.message, /^Test command 'unit' cannot be proposed: the command\.result\.adapter must be /u);
  assert.doesNotMatch(refused.message, /invalid structured test configuration/u);
  assert.equal(refused.details.nextAction, 'singularity-flow capability test-setup --json');
  const plan = refusalRemediationPlan(refused, ['capability', 'test-setup', '--step', 'implementation', '--id', 'unit']);
  assert.deepEqual(plan.steps.map((entry) => entry.command)[0], 'singularity-flow capability test-setup --json');
});

// An office repository's server and client Jest suites refused the gate's guess, and the inspection the
// refusal names refused with the same error, so nothing could be proposed (2026-10-29).
test('two runners with different configurations are each suggested; the gate still guesses neither', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'client'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'split', private: true, scripts: {
    'test-server': 'jest --config "./jest.config.ts" --detectOpenHandles',
    'test-client': 'jest --config "./client/jest.config.ts" --detectOpenHandles',
    'test-unit': 'npm run test-server && npm run test-client'
  }, devDependencies: { jest: '29.7.0' } }));
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  await writeFile(path.join(root, 'jest.config.ts'), "export default { roots: ['<rootDir>/server'] };\n");
  await writeFile(path.join(root, 'client', 'jest.config.ts'), 'export default {};\n');
  const inspection = await inspectRepositoryTestSetup(root);
  assert.equal(inspection.status, 'suggestions-available');
  const byId = Object.fromEntries(inspection.suggestions.map((entry) => [entry.id, entry]));
  assert.deepEqual(Object.keys(byId).sort(), ['test-client-tests', 'test-server-tests']);
  assert.notEqual(byId['test-server-tests'].result.path, byId['test-client-tests'].result.path, 'each writes its own report');
  assert.ok(byId['test-server-tests'].argv.includes(byId['test-server-tests'].result.path));
  assert.ok(inspection.diagnostics.some((entry) => entry.code === 'TEST_MODULE_AMBIGUOUS' && /A step may run several/u.test(entry.message)));
  // A written command naming one of them is completed from that script alone.
  const { inferModuleTestCommand } = await import('../src/code-delivery-tests.mjs');
  const server = await inferModuleTestCommand(root, { root: '.', system: 'node', manifest: 'package.json' }, { nodeScript: 'test-server' });
  assert.deepEqual(server.argv.slice(0, 3), ['npm', 'run', 'test-server']);
  // The gate's own inference still never picks one.
  await assert.rejects(inferModuleTestCommand(root, { root: '.', system: 'node', manifest: 'package.json' }), { code: 'TEST_MODULE_AMBIGUOUS' });
});
