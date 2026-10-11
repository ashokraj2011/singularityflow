import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ConfigurationCleanupAction } from '../apps/vscode/src/views/configuration-cleanup-model.ts';
import { commandClass } from '../apps/vscode/src/cli/client.ts';

const preview = () => ({ status: 'preview', confirmation: `sha256:${'a'.repeat(64)}`,
  candidates: [{ branch: 'sflow/config-history/test', commit: 'a'.repeat(40), archiveRef: 'refs/tags/test' }],
  retained: [], remaining: 0 });

test('cleanup is offered in Configuration and the command palette with exact confirmation', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some(command => command.command === 'singularityFlow.cleanupConfigurationHistory'));
  const page = await readFile(new URL('../apps/vscode/src/views/configuration-center-page.ts', import.meta.url), 'utf8');
  assert.match(page, /label: 'Clean configuration history'.*action: 'cleanup-history'/u);
  assert.equal(commandClass(['configuration', 'cleanup-history', '--json']), 'read');
  assert.equal(commandClass(['configuration', 'cleanup-history', '--apply', '--confirm', preview().confirmation]), 'mutation');
});

test('cancelled or empty previews never mutate; one confirmation binds one apply with no duplicate clicks', async () => {
  for (const state of ['cancel', 'empty', 'confirm']) {
    const calls = []; let complete;
    const action = new ConfigurationCleanupAction({
      run: async argv => { calls.push(argv); return argv.includes('--apply')
        ? { ...preview(), status: 'cleaned' } : { ...preview(), candidates: state === 'empty' ? [] : preview().candidates }; },
      confirm: () => new Promise(resolve => { complete = resolve; })
    });
    const first = action.run(); assert.equal(first, action.run());
    await Promise.resolve(); await Promise.resolve();
    if (state !== 'empty') complete(state === 'confirm');
    await first;
    assert.deepEqual(calls[0], ['configuration', 'cleanup-history', '--json']);
    assert.equal(calls.length, state === 'confirm' ? 2 : 1);
    if (state === 'confirm') assert.deepEqual(calls[1], ['configuration', 'cleanup-history', '--apply', '--confirm', preview().confirmation, '--json']);
  }
});

test('unverified preview cannot authorize cleanup and the action recovers after a failed read', async () => {
  let count = 0, confirmations = 0;
  const action = new ConfigurationCleanupAction({ run: async () => ++count === 1
    ? { ...preview(), confirmation: 'invented' } : { ...preview(), candidates: [] },
  confirm: async () => { confirmations++; return true; } });
  await assert.rejects(action.run(), /verified cleanup/u);
  assert.equal((await action.run()).status, 'preview');
  assert.equal(confirmations, 0);
});
