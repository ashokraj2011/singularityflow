import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  alignProductSurfaces, codeLauncher, CONFIGURATION_REVIEW_KEY, LoadedBundle, openConfigurationReviews,
  packagedExtension, PRODUCT_CHECK_KEY, productCheckDue
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

test('a required build that could not be installed is warned once per attempt', async (t) => {
  const directory = await extension(t);
  let requirements = [
    { repository: '/work/app', verdict: 'failed', checkedAt: '2026-09-28T10:00:00.000Z', reason: 'The release does not meet the required build.' },
    { repository: '/work/lib', verdict: 'satisfied', checkedAt: '2026-09-28T10:00:00.000Z' }
  ];
  const item = host(directory, {
    status: () => ({ verdict: 'aligned', surfaces: surfaces('aligned'), actions: [], split: null, next: [], requirements })
  });
  const bundle = new LoadedBundle(path.join(directory, 'dist', 'extension.cjs'));
  const warnings = () => item.events.filter(([kind]) => kind === 'warn').map(([, message]) => message);
  assert.equal(await alignProductSurfaces(item, { loadedBuild: BUILD, bundle }), 'aligned');
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0], /could not install the build app requires: The release does not meet the required build\. It keeps working on the current build/u);

  item.now = () => 1_000_000 + DAY;
  await alignProductSurfaces(item, { loadedBuild: BUILD, bundle });
  assert.equal(warnings().length, 1, 'the same attempt is not warned again at the next daily check');

  requirements = [{ ...requirements[0], checkedAt: '2026-09-29T10:00:00.000Z' }];
  item.now = () => 1_000_000 + 2 * DAY;
  await alignProductSurfaces(item, { loadedBuild: BUILD, bundle });
  assert.equal(warnings().length, 2, 'a later failed attempt is its own warning');
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

function refreshHost(extensionPath, { preview, bound = { planId: 'plan-1' }, opened, fail = false }) {
  const item = host(extensionPath, {});
  item.run = async (args) => {
    item.events.push(['run', args.join(' ')]);
    if (fail) throw new Error('offline');
    if (args.includes('--review-only')) return opened;
    return args.includes('--repository') ? bound : preview;
  };
  return item;
}

test('a new build opens a configuration review for each lagging repository, once, and applies nothing', async (t) => {
  const directory = await extension(t);
  const item = refreshHost(directory, {
    preview: { results: [
      { status: 'would-update', repository: 'app', configurationChanged: true },
      { status: 'would-update', repository: 'state-only', configurationChanged: false },
      { status: 'current', repository: 'lib', configurationChanged: false }
    ] },
    opened: { results: [{ status: 'review-required', repository: 'app', proposalBranch: 'sflow/config-refresh/r1-aaaa-bbbb' }] }
  });
  assert.equal(await openConfigurationReviews(item, { loadedBuild: BUILD }), 'reviews-opened');
  assert.deepEqual(item.events.filter(([kind]) => kind === 'run').map(([, args]) => args), [
    'workspace refresh-configuration --dry-run --json',
    'workspace refresh-configuration --repository app --dry-run --json',
    'workspace refresh-configuration --repository app --confirm-plan plan-1 --review-only --json'
  ], 'the plan is bound to exactly the lagging repository, and the apply is review-only');
  assert.match(item.events.find(([kind]) => kind === 'inform')[1], /app → sflow\/config-refresh\/r1-aaaa-bbbb.*Nothing changes until each review is merged/u);
  assert.equal(item.state.get(CONFIGURATION_REVIEW_KEY), BUILD);
  assert.equal(await openConfigurationReviews(item, { loadedBuild: BUILD }), 'skipped-recent', 'once per build');
});

test('a window waiting to reload onto a newer build opens no configuration review', async (t) => {
  const directory = await extension(t);
  const item = refreshHost(directory, {
    preview: { results: [{ status: 'would-update', repository: 'app', configurationChanged: true }] },
    opened: { results: [{ status: 'review-required', repository: 'app', proposalBranch: 'sflow/config-refresh/r1-aaaa-bbbb' }] }
  });
  const bundle = new LoadedBundle(path.join(directory, 'dist', 'extension.cjs'));
  assert.equal(bundle.reloadPending(), false);
  // Alignment installed this window's VSIX and offered the reload, which was dismissed.
  assert.equal(await bundle.offerReload(item, true), true);
  assert.equal(bundle.reloadPending(), true);
  assert.equal(await openConfigurationReviews(item, { loadedBuild: BUILD, bundle }), 'skipped-reload-pending');
  assert.deepEqual(item.events.filter(([kind]) => kind === 'run'), [], 'the stale window proposes nothing');
  assert.equal(item.state.get(CONFIGURATION_REVIEW_KEY), undefined, 'the reloaded build still opens its own reviews');

  const replacedInPlace = new LoadedBundle(path.join(directory, 'dist', 'extension.cjs'));
  await writeFile(path.join(directory, 'dist', 'extension.cjs'), 'module.exports = { replaced: true };\n');
  assert.equal(replacedInPlace.reloadPending(), true, 'files replaced in place count before any offer');
});

test('a build whose configuration is current opens nothing, and an unavailable check retries next window', async (t) => {
  const directory = await extension(t);
  const current = refreshHost(directory, { preview: { results: [{ status: 'current', repository: 'app' }] } });
  assert.equal(await openConfigurationReviews(current, { loadedBuild: BUILD }), 'current');
  assert.equal(current.events.filter(([kind]) => kind === 'run').length, 1);
  const offline = refreshHost(directory, { fail: true });
  assert.equal(await openConfigurationReviews(offline, { loadedBuild: BUILD }), 'unavailable');
  assert.equal(offline.state.get(CONFIGURATION_REVIEW_KEY), undefined);
  assert.equal(await openConfigurationReviews(refreshHost(await extension(t, { packaged: false }), { preview: {} }), { loadedBuild: BUILD }),
    'skipped-development');
});

