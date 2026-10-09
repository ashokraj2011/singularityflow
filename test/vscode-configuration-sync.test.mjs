import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ConfigurationSyncAction, configurationSyncInterruptedMessage } from '../apps/vscode/src/views/configuration-sync-model.ts';
import { PRIMARY_NAVIGATION } from '../apps/vscode/src/views/sidebar-page.ts';

const result = status => ({ status, baseCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
  proposals: [], backupRefs: [] });

test('one-click sync is in the main panel, configuration menu and command palette', async () => {
  assert.equal(PRIMARY_NAVIGATION.find(item => item.id === 'configuration-sync').command,
    'singularityFlow.recreateAndSyncConfiguration');
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some(command => command.command === 'singularityFlow.recreateAndSyncConfiguration'));
  const page = await readFile(new URL('../apps/vscode/src/views/configuration-center-page.ts', import.meta.url), 'utf8');
  assert.match(page, /label: 'Recreate & sync configuration'.*action: 'recreate-sync'/u);
  const source = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(source, /message.action === 'recreate-sync'.*singularityFlow.recreateAndSyncConfiguration/u);
  const handler = source.slice(source.indexOf("'singularityFlow.recreateAndSyncConfiguration': async"),
    source.indexOf('// Backward-compatible command ID for old keybindings'));
  assert.match(handler, /configurationSyncAction.run\(\)/u);
  assert.doesNotMatch(handler, /show\w*(?:QuickPick|InputBox|Confirmation)\s*\(|modal\s*:|confirm\s*:|Merge exact/iu);
  assert.match(handler, /catch \(error\)[\s\S]*configurationSyncInterruptedMessage\(/u);
  assert.match(handler, /error instanceof CliError && error.result[\s\S]*showRefusal\(error/u);
  assert.match(source, /await lazyPanels\(\)\.WorkflowStudioPanel\.refreshAfterConfigurationSync\(\)/u);
});

test('a click executes one exact model-free command with no confirmation and reloads only on success', async () => {
  const calls = [];
  const action = new ConfigurationSyncAction({ run: async argv => { calls.push(argv); return result('synced'); },
    refresh: async () => calls.push('refresh') });
  await action.run();
  assert.deepEqual(calls, [['configuration', 'recreate-sync', '--apply', '--json'], 'refresh']);
});

test('double clicks share one transaction, and completion permits a later no-op sync', async () => {
  let complete;
  let calls = 0, refreshes = 0;
  const action = new ConfigurationSyncAction({ run: () => { calls++; return new Promise(resolve => { complete = resolve; }); },
    refresh: async () => { refreshes++; } });
  const first = action.run();
  assert.equal(first, action.run());
  complete(result('synced'));
  await first;
  assert.equal(calls, 1); assert.equal(refreshes, 1);
  const later = action.run(); complete(result('current')); await later;
  assert.equal(calls, 2); assert.equal(refreshes, 2);
});

test('refused and unknown outcomes do not refresh or claim successful sync', async () => {
  let refreshes = 0;
  for (const status of ['not-synced', 'outcome-unknown']) {
    const action = new ConfigurationSyncAction({ run: async () => result(status), refresh: async () => { refreshes++; } });
    assert.equal((await action.run()).status, status);
  }
  assert.equal(refreshes, 0);
});

test('a failed transport frees the click gate for an explicit retry', async () => {
  let attempts = 0;
  const action = new ConfigurationSyncAction({ run: async () => { if (++attempts === 1) throw new Error('offline'); return result('current'); },
    refresh: async () => {} });
  await assert.rejects(action.run(), /offline/u);
  assert.equal((await action.run()).status, 'current');
});

test('a failed UI refresh cannot turn a confirmed remote sync into an unknown transaction', async () => {
  const action = new ConfigurationSyncAction({ run: async () => result('synced'),
    refresh: async () => { throw new Error('panel closed'); } });
  assert.deepEqual(await action.run(), { ...result('synced'), viewRefresh: 'attention' });
});

test('interruption tells the user to reconcile without claiming unchanged or finished remote state', () => {
  assert.match(configurationSyncInterruptedMessage(), /Do not assume it completed or that nothing changed/u);
  assert.match(configurationSyncInterruptedMessage(), /recreate-sync --apply --json/u);
  assert.match(configurationSyncInterruptedMessage(), /do not activate an older proposal/u);
  const exact = "cd '/repo' && '/installed/node' '/installed/cli.mjs' 'configuration' 'recreate-sync' '--apply' '--json'";
  assert.ok(configurationSyncInterruptedMessage(exact).endsWith(exact), 'timeout retry preserves the actually installed executable');
});
