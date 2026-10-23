import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inferModuleTestCommand } from '../src/code-delivery-tests.mjs';
import { resolveDeliveryQualityCommands } from '../src/delivery-evidence.mjs';
import { inspectRepositoryTestSetup } from '../src/repository-test-setup.mjs';

async function workspace(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-nx-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({ 'package.json': { name: 'shop', private: true }, 'nx.json': {}, ...files })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
  }
  return root;
}

const jest = { executor: '@nx/jest:jest', options: { jestConfig: 'apps/admin/jest.config.ts' } };
const e2e = { name: 'shop-e2e', implicitDependencies: ['shop'], targets: { e2e: { executor: '@nx/playwright:playwright' } } };
const changed = (root, ...paths) => resolveDeliveryQualityCommands(root, {
  writeScope: 'source-and-artifact', generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' },
  qualityCommands: [], deliveryEvidence: { sourcePaths: paths.filter((file) => !file.includes('.spec.')), testPaths: paths.filter((file) => file.includes('.spec.')) }
});
const runs = (commands) => commands.map((command) => [command.argv.join(' '), command.workingDirectory, command.affectedRoots.join(','), command.result.path]);
const admin = (t, targets, extra = {}) => workspace(t, { 'apps/admin/project.json': { name: 'admin', targets }, ...extra });
const report = (name) => `.sflow/results/${name}.json`;

test('the Jest executor runs in the workspace root, so its report path is the workspace one', async (t) => {
  assert.deepEqual(await changed(await admin(t, { test: jest }), 'apps/admin/src/users.ts'), [{
    id: 'apps/admin-jest-tests', kind: 'test',
    argv: ['npx', '--no-install', 'nx', 'run', 'admin:test', '--skip-nx-cache', '--json', '--outputFile=.sflow/results/apps-admin-jest-tests.json'],
    workingDirectory: '.', affectedRoots: ['apps/admin'], modelPolicy: 'never',
    result: { adapter: 'jest-json', path: '.sflow/results/apps-admin-jest-tests.json', minimumDiscovered: 1 }
  }]);
  assert.deepEqual(runs(await changed(await admin(t, { unit: { executor: '@nrwl/jest:jest' } }, { 'pnpm-lock.yaml': '' }), 'apps/admin/src/users.ts')), [[
    'pnpm exec nx run admin:unit --skip-nx-cache --json --outputFile=.sflow/results/apps-admin-jest-tests.json', '.', 'apps/admin', report('apps-admin-jest-tests')
  ]]);
  // A nested workspace runs from its nx.json directory and reads the report there; a plugin's
  // target runs in the project root, which Nx counts from that directory.
  const nested = await workspace(t, {
    'nx.json': null, 'web/nx.json': { plugins: ['@nx/jest/plugin'] }, 'web/package.json': { name: 'web' },
    'web/apps/admin/project.json': { name: 'admin', targets: { test: jest } },
    'web/libs/ui/project.json': { name: 'ui' }, 'web/libs/ui/jest.config.cts': 'module.exports = {};\n'
  });
  await rm(path.join(nested, 'nx.json'));
  assert.deepEqual(runs(await changed(nested, 'web/apps/admin/src/users.ts', 'web/libs/ui/src/button.ts')), [[
    'npx --no-install nx run admin:test --skip-nx-cache --json --outputFile=.sflow/results/web-apps-admin-jest-tests.json', 'web', 'web/apps/admin', report('web-apps-admin-jest-tests')
  ], [
    'npx --no-install nx run ui:test --skip-nx-cache --json --outputFile=../../.sflow/results/web-libs-ui-jest-tests.json', 'web', 'web/libs/ui', report('web-libs-ui-jest-tests')
  ]]);
});

test('a plain jest command writes its report relative to the directory Jest runs in', async (t) => {
  const inProject = '--outputFile=../../.sflow/results/apps-admin-jest-tests.json';
  const argv = async (targets, extra) => (await changed(await admin(t, targets, extra), 'apps/admin/src/users.ts')).map((command) => command.argv.slice(4).join(' '));
  // @nx/jest/plugin infers `jest` run in the project root for a project holding a jest.config.*.
  const plugin = (entry, extra = {}) => ({ 'nx.json': { plugins: [entry] }, 'apps/admin/jest.config.ts': 'export default {};\n', ...extra });
  assert.deepEqual(await argv(undefined, plugin('@nx/jest/plugin')), [`admin:test --skip-nx-cache --json ${inProject}`]);
  assert.deepEqual(await argv(undefined, plugin({ plugin: '@nx/jest/plugin', options: { targetName: 'unit' } })), [`admin:unit --skip-nx-cache --json ${inProject}`]);
  assert.deepEqual(await argv(undefined, { 'nx.json': { plugins: ['@nx/jest/plugin'] } }), [], 'no jest.config.*, no inferred target');
  assert.deepEqual(await argv(undefined, plugin({ plugin: '@nx/jest/plugin', include: ['libs/**'] })), [], 'a limited plugin');
  // A project.json entry merges into the inferred target unless it names another command.
  assert.deepEqual(await argv({ test: { options: { ci: true } } }, plugin('@nx/jest/plugin')), [`admin:test --skip-nx-cache --json ${inProject}`]);
  assert.deepEqual(await argv({ test: { command: 'jest' } }, plugin('@nx/jest/plugin')), [`admin:test --skip-nx-cache --json ${inProject}`]);
  assert.deepEqual(await argv({ test: { command: 'jest --ci' } }, plugin('@nx/jest/plugin')),
    ['admin:test --skip-nx-cache --json --outputFile=.sflow/results/apps-admin-jest-tests.json'], 'a replacing command runs in the workspace root');
  // nx:run-commands and the `command` shorthand run in options.cwd, else the workspace root.
  assert.deepEqual(await argv({ test: { executor: 'nx:run-commands', options: { command: 'jest --ci', cwd: 'apps/admin' } } }), [`admin:test --skip-nx-cache --json ${inProject}`]);
  assert.deepEqual(await argv({ test: { command: 'npx jest', options: { cwd: '{projectRoot}' } } }), [`admin:test --skip-nx-cache --json ${inProject}`]);
  assert.deepEqual(await argv({ test: { command: 'jest', options: { cwd: '{workspaceRoot}/apps' } } }),
    ['admin:test --skip-nx-cache --json --outputFile=../.sflow/results/apps-admin-jest-tests.json']);
  assert.deepEqual(await argv({ test: { command: 'jest -c apps/admin/jest.config.ts' } }),
    ['admin:test --skip-nx-cache --json --outputFile=.sflow/results/apps-admin-jest-tests.json']);
});

test('only an unambiguous, plain Jest or Vitest target with forwarded arguments is inferred', async (t) => {
  const none = async (targets, why) => assert.deepEqual(await changed(await admin(t, targets), 'apps/admin/src/users.ts'), [], why);
  await none({ test: { command: 'jest && rm -rf coverage' } }, 'shell composition');
  await none({ test: { command: 'jest --watch' } }, 'watch mode');
  await none({ test: { command: 'jest --json --outputFile=out.json' } }, 'its own report');
  await none({ test: { command: 'jest', options: { cwd: '../outside' } } }, 'a directory outside the workspace');
  await none({ test: { command: 'jest', options: { cwd: '/tmp' } } }, 'an absolute directory');
  await none({ test: { command: 'jest', options: { forwardAllArgs: false } } }, 'arguments not forwarded');
  await none({ test: { executor: 'nx:run-commands', options: { commands: ['jest'] } } }, 'a command list');
  await none({ test: { executor: '@nx/vite:test' } }, 'reporter forwarding through @nx/vite:test is unproven');
  await none({ 'test:ci': jest }, 'nx run reads a colon as a configuration');
  await none({ unit: jest, integration: jest }, 'several targets and none is test');
  await none({ test: { executor: '@nx/vite:test' }, 'test-jest': jest }, 'another target would test only part of the project');
  for (const command of ['vitest watch', 'vitest --config other.config.ts', 'vitest run -r src', 'vitest --ui', 'vitest run --reporter=verbose']) {
    await none({ test: { command, options: { cwd: 'apps/admin' } } }, command);
  }
  assert.equal(runs(await changed(await admin(t, { test: jest, 'test-ci': jest }), 'apps/admin/src/users.ts'))[0][0],
    'npx --no-install nx run admin:test --skip-nx-cache --json --outputFile=.sflow/results/apps-admin-jest-tests.json');
});

test('Vitest targets run once, with the report relative to Vitest\'s root', async (t) => {
  const argv = async (targets, extra) => (await changed(await admin(t, targets, extra), 'apps/admin/src/users.ts')).map((command) => [command.argv.slice(4).join(' '), command.result.adapter]);
  const inProject = '--outputFile=../../.sflow/results/apps-admin-vitest-tests.json';
  const vite = (entry, config = 'export default { test: { environment: \'node\' } };\n', name = 'vite.config.ts') => ({ 'nx.json': { plugins: [entry] }, [`apps/admin/${name}`]: config });
  assert.deepEqual(await argv(undefined, vite({ plugin: '@nx/vite/plugin', options: { buildTargetName: 'build' } })),
    [[`admin:test --skip-nx-cache --run --reporter=json ${inProject}`, 'vitest-json']]);
  assert.deepEqual(await argv(undefined, vite({ plugin: '@nx/vite/plugin', options: { testTargetName: 'unit' } }, 'export default {};\n', 'vitest.config.mts')),
    [[`admin:unit --skip-nx-cache --run --reporter=json ${inProject}`, 'vitest-json']]);
  assert.deepEqual(await argv(undefined, vite('@nx/vite/plugin', 'export default { server: { port: 4200 } };\n')), [], 'a vite.config.* with no test block infers no test target');
  assert.deepEqual(await argv({ test: { executor: 'nx:run-commands', options: { command: 'vitest run', cwd: 'apps/admin' } } }),
    [[`admin:test --skip-nx-cache --run --reporter=json ${inProject}`, 'vitest-json']]);
  assert.deepEqual(await argv({ test: { command: 'vitest --coverage' } }),
    [['admin:test --skip-nx-cache --run --reporter=json --outputFile=.sflow/results/apps-admin-vitest-tests.json', 'vitest-json']]);
});

test('an Nx application runs its unit target and the e2e project that tests it', async (t) => {
  const files = { 'apps/shop/project.json': { name: 'shop', targets: { test: jest } }, 'apps/shop-e2e/project.json': e2e };
  const root = await workspace(t, files);
  const both = [
    ['npx --no-install nx run shop:test --skip-nx-cache --json --outputFile=.sflow/results/apps-shop-jest-tests.json', '.', 'apps/shop', report('apps-shop-jest-tests')],
    ['npx --no-install nx run shop-e2e:e2e --skip-nx-cache --reporter=json', '.', 'apps/shop-e2e,apps/shop', report('apps-shop-e2e-playwright-tests')]
  ];
  assert.deepEqual(runs(await changed(root, 'apps/shop/src/cart.ts')), both);
  assert.deepEqual(runs(await changed(root, 'apps/shop/src/cart.ts', 'apps/shop/src/cart.spec.ts', 'apps/shop-e2e/src/cart.spec.ts')), both, 'one run each');
  assert.deepEqual(runs(await changed(root, 'apps/shop-e2e/src/cart.spec.ts')), [both[1]], 'an e2e change alone runs only the browser tests');
  assert.deepEqual((await inspectRepositoryTestSetup(root, { sourceRoots: ['apps/shop'] })).suggestions.map((entry) => entry.id),
    ['apps/shop-jest-tests', 'apps/shop-e2e-playwright-tests']);
  // A project with its own package.json runs both through Nx too; a library with no tester runs its unit target alone.
  const packaged = await workspace(t, { ...files, 'apps/shop/package.json': { name: 'shop' }, 'libs/ui/project.json': { name: 'ui', targets: { test: { command: 'vitest run', options: { cwd: 'libs/ui' } } } } });
  assert.deepEqual(runs(await changed(packaged, 'apps/shop/src/cart.ts')), both);
  assert.deepEqual(runs(await changed(packaged, 'libs/ui/src/button.ts')), [[
    'npx --no-install nx run ui:test --skip-nx-cache --run --reporter=json --outputFile=../../.sflow/results/libs-ui-vitest-tests.json', '.', 'libs/ui', report('libs-ui-vitest-tests')
  ]]);
});

test('unit-only inference returns an Nx unit target and never a Playwright one', async (t) => {
  const root = await workspace(t, { 'apps/shop/project.json': { name: 'shop', targets: { test: jest } }, 'apps/shop-e2e/project.json': e2e });
  const shop = { root: 'apps/shop', system: 'nx', manifest: 'project.json' };
  const shopE2e = { root: 'apps/shop-e2e', system: 'nx', manifest: 'project.json' };
  const adapter = async (module, options) => (await inferModuleTestCommand(root, module, options))?.result.adapter ?? null;
  assert.equal(await adapter(shop, { unitOnly: true }), 'jest-json');
  assert.equal(await adapter(shop, { nodeScript: 'e2e' }), 'playwright-json', 'the separate browser run');
  assert.equal(await adapter(shop, { unitOnly: true, nodeScript: 'e2e' }), null);
  assert.equal(await adapter(shopE2e), 'playwright-json');
  assert.equal(await adapter(shopE2e, { unitOnly: true }), null);
});
