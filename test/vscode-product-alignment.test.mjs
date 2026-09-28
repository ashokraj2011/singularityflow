import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  alignProductSurfaces, codeLauncher, LoadedBundle, packagedExtension, PRODUCT_CHECK_KEY, productCheckDue
} from '../apps/vscode/src/product-alignment.ts';

const BUILD = 'abc1234 2026-09-28T10:00Z';
const DAY = 24 * 60 * 60 * 1000;

async function extension(t, { packaged = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-product-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'dist', 'extension.cjs'), 'module.exports = {};\n');
  if (packaged) {
    await mkdir(path.join(directory, 'cli'), { recursive: true });
    await writeFile(path.join(directory, 'cli', 'package.json'), '{"name":"singularity-flow"}');
  }
  return directory;
}

function host(extensionPath, responses, { choice = undefined, now = 1_000_000 } = {}) {
  const state = new Map();
  const events = [];
  return {
    events,
    state,
    extensionPath,
    now: () => now,
    run: async (args) => {
      events.push(['run', args.join(' ')]);
      const response = responses[args[1]];
      if (response instanceof Error) throw response;
      return { data: typeof response === 'function' ? response() : response };
    },
    log: (line) => events.push(['log', line]),
    progress: async (title, task) => { events.push(['progress', title]); return task(); },
    inform: async (message, ...actions) => { events.push(['inform', message, actions]); return choice; },
    warn: async (message) => { events.push(['warn', message]); return undefined; },
    reload: async () => { events.push(['reload']); },
    remembered: (key) => state.get(key),
    remember: async (key, value) => { state.set(key, value); }
  };
}

const surfaces = (state) => [
  { id: 'vscode', state, live: '0.9.0 (a)' }, { id: 'cli', state: 'aligned' }, { id: 'copilot', state: 'aligned' }
];

test('the launcher is VS Code\'s own, and only when it exists', async (t) => {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-app-'));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  assert.equal(codeLauncher(appRoot, 'darwin'), null);
  await mkdir(path.join(appRoot, 'bin'));
  await writeFile(path.join(appRoot, 'bin', 'code'), '');
  assert.equal(codeLauncher(appRoot, 'darwin'), path.join(appRoot, 'bin', 'code'));
  assert.equal(codeLauncher(appRoot, 'win32'), null, 'Windows uses code.cmd');
  assert.equal(codeLauncher(undefined), null);
});

test('a window notices when its own bundle is replaced and offers one reload', async (t) => {
  const directory = await extension(t);
  const file = path.join(directory, 'dist', 'extension.cjs');
  const bundle = new LoadedBundle(file);
  const item = host(directory, {}, { choice: 'Reload' });
  assert.equal(bundle.replaced(), false);
  assert.equal(await bundle.offerReload(item), false, 'nothing to reload while the bundle is unchanged');
  await writeFile(file, 'module.exports = { replaced: true };\n');
  assert.equal(bundle.replaced(), true);
  assert.equal(await bundle.offerReload(item), true);
  assert.deepEqual(item.events.filter(([kind]) => kind === 'reload'), [['reload']]);
  assert.equal(await bundle.offerReload(item), false, 'one offer per window');
});

test('a development host and an unstamped build never check or align', async (t) => {
  const development = await extension(t, { packaged: false });
  assert.equal(packagedExtension(development), false);
  const item = host(development, {});
  assert.equal(await alignProductSurfaces(item, { loadedBuild: BUILD, bundle: new LoadedBundle('/missing') }),
    'skipped-development');
  const packaged = await extension(t);
  assert.equal(await alignProductSurfaces(host(packaged, {}), { loadedBuild: 'unstamped', bundle: new LoadedBundle('/missing') }),
    'skipped-development');
  assert.deepEqual(item.events, []);
});

test('a repairable machine is aligned in the background and the window offers a reload after its VSIX is replaced', async (t) => {
  const directory = await extension(t);
  const item = host(directory, {
    status: { verdict: 'repairable', surfaces: surfaces('repair'), actions: [{ surface: 'vscode', kind: 'install-vscode' }], split: null, next: [] },
    align: {
      verdict: 'aligned', surfaces: surfaces('aligned'), actions: [], split: null, next: [], status: 'aligned',
      steps: [{ surface: 'vscode', kind: 'install-vscode', outcome: 'aligned' }]
    }
  }, { choice: 'Reload' });
  const outcome = await alignProductSurfaces(item, { loadedBuild: BUILD, bundle: new LoadedBundle(path.join(directory, 'dist', 'extension.cjs')) });
  assert.equal(outcome, 'repaired');
  assert.deepEqual(item.events.filter(([kind]) => kind === 'run').map(([, args]) => args), [
    `product status --json --extension-path ${directory}`,
    `product align --json --extension-path ${directory} --trigger vscode-activation`
  ]);
  assert.ok(item.events.some(([kind]) => kind === 'progress'));
  assert.ok(item.events.some(([kind]) => kind === 'reload'), 'the replaced window reloads onto the installed build');
  assert.equal(item.state.get(PRODUCT_CHECK_KEY).build, BUILD);
});

test('a failed alignment warns with the retry command and never reloads', async (t) => {
  const directory = await extension(t);
  const item = host(directory, {
    status: { verdict: 'repairable', surfaces: surfaces('repair'), actions: [{ surface: 'cli', kind: 'install-cli' }], split: null, next: [] },
    align: {
      verdict: 'repairable', surfaces: surfaces('repair'), actions: [], split: null, next: [], status: 'failed',
      steps: [{ surface: 'cli', kind: 'install-cli', outcome: 'failed', reason: 'npm refused.' }]
    }
  });
  assert.equal(await alignProductSurfaces(item, { loadedBuild: BUILD, bundle: new LoadedBundle('/missing') }), 'failed');
  const warning = item.events.find(([kind]) => kind === 'warn');
  assert.match(warning[1], /cli surface: npm refused\. Run `singularity-flow product align` to retry\./u);
  assert.ok(!item.events.some(([kind]) => kind === 'reload'));
});

test('a split install is reported once, and a recent check is not repeated', async (t) => {
  const directory = await extension(t);
  const status = {
    verdict: 'split', surfaces: surfaces('aligned'), actions: [], split: { cli: 'b', vscode: 'a' },
    next: [{ command: 'Run a full install from /checkout.', reason: 'VS Code and the terminal hold different installed builds.' }]
  };
  const item = host(directory, { status });
  const bundle = new LoadedBundle('/missing');
  assert.equal(await alignProductSurfaces(item, { loadedBuild: BUILD, bundle }), 'split');
  assert.match(item.events.find(([kind]) => kind === 'inform')[1], /Run a full install from \/checkout\./u);
  assert.equal(await alignProductSurfaces(item, { loadedBuild: BUILD, bundle }), 'skipped-recent');
  const tomorrow = host(directory, { status }, { now: 1_000_000 + DAY });
  for (const [key, value] of item.state) tomorrow.state.set(key, value);
  assert.equal(await alignProductSurfaces(tomorrow, { loadedBuild: BUILD, bundle }), 'split-reported',
    'the same split is not announced twice');
  assert.equal(productCheckDue(tomorrow, 'another build'), true, 'a newly loaded build always checks');
});

test('an unavailable CLI leaves the check due for the next window', async (t) => {
  const directory = await extension(t);
  const item = host(directory, { status: new Error('spawn failed') });
  assert.equal(await alignProductSurfaces(item, { loadedBuild: BUILD, bundle: new LoadedBundle('/missing') }), 'unavailable');
  assert.equal(item.state.get(PRODUCT_CHECK_KEY), undefined);
});
