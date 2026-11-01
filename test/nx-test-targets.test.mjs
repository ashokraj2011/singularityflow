import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveDeliveryQualityCommands } from '../src/delivery-evidence.mjs';
import { inspectRepositoryTestSetup } from '../src/repository-test-setup.mjs';

async function workspace(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-nx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({ 'package.json': { name: 'shop', private: true }, 'nx.json': {}, ...files })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
  }
  return root;
}

const e2e = (extra = {}) => ({ name: 'shop-e2e', implicitDependencies: ['shop'], targets: { e2e: { executor: '@nx/playwright:playwright' } }, ...extra });
const app = { name: 'shop', targets: { serve: { executor: '@nx/js:node' } } };
const changed = (root, ...paths) => resolveDeliveryQualityCommands(root, {
  writeScope: 'source-and-artifact', generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' },
  qualityCommands: [], deliveryEvidence: { sourcePaths: paths.filter((file) => !file.includes('.spec.')), testPaths: paths.filter((file) => file.includes('.spec.')) }
});
const runs = (commands) => commands.map((command) => [command.argv.join(' '), command.affectedRoots.join(',')]);

test('test setup suggests the selected Nx e2e project\'s Playwright target', async (t) => {
  const root = await workspace(t, { 'apps/shop/project.json': app, 'apps/shop-e2e/project.json': e2e(), 'pnpm-lock.yaml': '' });
  const result = await inspectRepositoryTestSetup(root, { sourceRoots: ['apps/shop-e2e'] });
  assert.equal(result.status, 'suggestions-available');
  assert.deepEqual(result.suggestions, [{
    id: 'apps/shop-e2e-playwright-tests', kind: 'test',
    argv: ['pnpm', 'exec', 'nx', 'run', 'shop-e2e:e2e', '--skip-nx-cache', '--reporter=json'],
    workingDirectory: '.', affectedRoots: ['apps/shop-e2e', 'apps/shop'], modelPolicy: 'never',
    result: { adapter: 'playwright-json', path: '.sflow/results/apps-shop-e2e-playwright-tests.json', minimumDiscovered: 1 },
    // Accepted as offered, it stays evidence for JavaScript and TypeScript files only.
    ecosystem: 'node'
  }]);
});

test('an application change alone runs the e2e project that names it, and an unrelated app keeps its old module', async (t) => {
  const root = await workspace(t, {
    'package.json': { name: 'shop', private: true, scripts: { test: 'jest' } },
    'apps/shop/project.json': app, 'apps/shop-e2e/project.json': e2e(),
    'apps/admin/project.json': { name: 'admin', targets: { test: { executor: '@nx/vite:test' } } }
  });
  assert.deepEqual(runs(await changed(root, 'apps/shop/src/cart.ts')),
    [['npx --no-install nx run shop-e2e:e2e --skip-nx-cache --reporter=json', 'apps/shop-e2e,apps/shop']]);
  // No target tests admin (its @nx/vite:test executor is not inferred): its files still resolve to the root package.json's tests.
  assert.deepEqual(runs(await changed(root, 'apps/admin/src/users.ts')), [['npm test -- --json --outputFile .sflow/results/node-tests.json', '.']]);
});

test('targets inferred by @nx/playwright/plugin count; limited plugins and replaced targets do not', async (t) => {
  const plugin = (entry) => ({ 'nx.json': { plugins: [entry] }, 'apps/shop-e2e/project.json': { name: 'shop-e2e' }, 'apps/shop-e2e/playwright.config.ts': 'export default {};\n' });
  const inferred = await workspace(t, plugin({ plugin: '@nx/playwright/plugin', options: { targetName: 'browser' } }));
  assert.deepEqual(runs(await changed(inferred, 'apps/shop-e2e/src/cart.spec.ts')),
    [['npx --no-install nx run shop-e2e:browser --skip-nx-cache --reporter=json', 'apps/shop-e2e']]);
  assert.deepEqual(runs(await changed(await workspace(t, plugin('@nx/playwright/plugin')), 'apps/shop-e2e/src/cart.spec.ts'))[0][0],
    'npx --no-install nx run shop-e2e:e2e --skip-nx-cache --reporter=json');
  assert.deepEqual(await changed(await workspace(t, plugin({ plugin: '@nx/playwright/plugin', include: ['apps/other/**'] })), 'apps/shop-e2e/src/cart.spec.ts'), []);
  const replaced = await workspace(t, { ...plugin('@nx/playwright/plugin'),
    'apps/shop-e2e/project.json': { name: 'shop-e2e', targets: { e2e: { command: 'cypress run' } } } });
  assert.deepEqual(await changed(replaced, 'apps/shop-e2e/src/cart.spec.ts'), []);
});

test('only an unambiguous, plain Playwright target is inferred', async (t) => {
  const target = async (targets, name = 'shop-e2e') => changed(await workspace(t, { 'apps/shop-e2e/project.json': { name, targets } }), 'apps/shop-e2e/src/cart.spec.ts');
  const playwright = { executor: '@nx/playwright:playwright' };
  assert.equal(runs(await target({ e2e: playwright, 'e2e-dev': playwright }))[0][0], 'npx --no-install nx run shop-e2e:e2e --skip-nx-cache --reporter=json');
  assert.deepEqual(await target({ smoke: playwright, regression: playwright }), [], 'several targets and none is e2e');
  assert.equal(runs(await target({ e2e: { executor: 'nx:run-commands', options: { command: 'playwright test -c playwright.config.ts' } } }))[0][0],
    'npx --no-install nx run shop-e2e:e2e --skip-nx-cache --reporter=json');
  assert.deepEqual(await target({ e2e: { executor: 'nx:run-commands', options: { command: 'playwright test && rm -rf out' } } }), []);
  assert.deepEqual(await target({ e2e: { command: 'playwright test', options: { forwardAllArgs: false } } }), [], 'the reporter would not reach Playwright');
  assert.deepEqual(await target({ 'e2e:ci': playwright }), [], 'nx run reads a colon as a configuration');
  assert.deepEqual(await target({ e2e: playwright }, 'shop e2e; rm'), [], 'an unusable project name');
});

test('project.json counts only inside an Nx workspace, and beside package.json still runs through Nx', async (t) => {
  const plain = await workspace(t, { 'nx.json': null, 'apps/shop-e2e/project.json': e2e() });
  await rm(path.join(plain, 'nx.json'));
  assert.deepEqual(await changed(plain, 'apps/shop-e2e/src/cart.spec.ts'), []);
  const packaged = await workspace(t, { 'apps/shop-e2e/package.json': { name: 'shop-e2e' }, 'apps/shop-e2e/project.json': e2e(), 'yarn.lock': '' });
  assert.deepEqual(runs(await changed(packaged, 'apps/shop-e2e/src/cart.spec.ts')),
    [['yarn nx run shop-e2e:e2e --skip-nx-cache --reporter=json', 'apps/shop-e2e']]);
});

test('an application tested by several e2e projects uses <name>-e2e, else none is guessed', async (t) => {
  const api = { name: 'shop-api-e2e', implicitDependencies: ['shop'], targets: { e2e: { executor: '@nx/playwright:playwright' } } };
  const named = await workspace(t, { 'apps/shop/project.json': app, 'apps/shop-e2e/project.json': e2e(), 'apps/shop-api-e2e/project.json': api });
  assert.equal(runs(await changed(named, 'apps/shop/src/cart.ts'))[0][0], 'npx --no-install nx run shop-e2e:e2e --skip-nx-cache --reporter=json');
  const unnamed = await workspace(t, { 'apps/shop/project.json': app, 'apps/shop-ui-e2e/project.json': { ...api, name: 'shop-ui-e2e' }, 'apps/shop-api-e2e/project.json': api });
  assert.deepEqual(await changed(unnamed, 'apps/shop/src/cart.ts'), []);
});
