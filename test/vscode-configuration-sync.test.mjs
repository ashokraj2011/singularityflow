import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ConfigurationSyncAction, configurationSyncConfirmation, configurationSyncInterruptedMessage } from '../apps/vscode/src/views/configuration-sync-model.ts';
import { compactMessagePresentation } from '../apps/vscode/src/compact-message-presentation.ts';
import { PRIMARY_NAVIGATION } from '../apps/vscode/src/views/sidebar-page.ts';
import { commandClass } from '../apps/vscode/src/cli/client.ts';

const digest = `sha256:${'c'.repeat(64)}`;
const proposal = (name, extra = {}) => ({ branch: `sflow/config-change/workflow/${name}`, commit: `${name[0]}`.repeat(40).replace(/[^a-f0-9]/gu, 'e'),
  merged: false, author: 'Teammate', summary: `edit ${name}`, files: ['singularity/workflow.yml'], ...extra });
const preview = (proposals = [proposal('demo')]) => ({ status: 'preview', confirmation: digest, targetBranch: 'sflow/config',
  baseCommit: 'a'.repeat(40), targetCommit: 'a'.repeat(40), proposals, backupRefs: [], files: ['singularity/workflow.yml'], replacements: [] });
const result = status => ({ status, baseCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), proposals: [], backupRefs: [] });
const PREVIEW = ['configuration', 'recreate-sync', '--json'];
const APPLY = ['configuration', 'recreate-sync', '--apply', '--confirm', digest, '--json'];
/** A host whose preview is `shape` and whose apply returns `applied`. */
const host = ({ shape = preview(), applied = result('synced'), confirm = async () => true, calls = [] } = {}) => ({
  run: async argv => { calls.push(argv); return argv.includes('--apply') ? applied : shape; },
  refresh: async () => calls.push('refresh'), confirm: async value => { calls.push('confirm'); return confirm(value); }
});

test('sync lives in the configuration menu and command palette, and confirms the previewed list before applying', async () => {
  // A sidebar row only opens a screen; this one writes, so it sits inside Configuration.
  assert.equal(PRIMARY_NAVIGATION.find(item => item.id === 'configuration-sync'), undefined);
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some(command => command.command === 'singularityFlow.recreateAndSyncConfiguration'));
  const page = await readFile(new URL('../apps/vscode/src/views/configuration-center-page.ts', import.meta.url), 'utf8');
  assert.match(page, /label: 'Recreate & sync configuration'.*action: 'recreate-sync'/u);
  assert.match(page, /Lists every proposal it will replay, teammates' unreviewed ones included/u);
  assert.doesNotMatch(page, /Asks once, then applies the update/u);
  const source = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(source, /message.action === 'recreate-sync'.*singularityFlow.recreateAndSyncConfiguration/u);
  const handler = source.slice(source.indexOf("'singularityFlow.recreateAndSyncConfiguration': async"),
    source.indexOf('// Backward-compatible command ID for old keybindings'));
  assert.match(handler, /configurationSyncAction.run\(\)/u);
  // No blind question before the preview: the only confirmation is the action's, naming the list.
  assert.doesNotMatch(handler.slice(0, handler.indexOf('configurationSyncAction.run()')), /showCompact\w*Message\(/u);
  assert.doesNotMatch(handler, /show\w*(?:QuickPick|InputBox)\s*\(|Merge exact/iu);
  assert.match(handler, /if \(!result\) return/u, 'a declined review applies nothing and reports nothing as synced');
  assert.match(handler, /cliRefusalCode\(error\) === 'CONFIGURATION_RECREATE_STALE'[\s\S]*showRefusal\(error/u);
  assert.match(handler, /catch \(error\)[\s\S]*configurationSyncInterruptedMessage\(/u);
  assert.match(handler, /error instanceof CliError && error.result[\s\S]*showRefusal\(error/u);
  const wiring = source.slice(source.indexOf('const configurationSyncAction = new ConfigurationSyncAction('),
    source.indexOf('const configurationCleanupAction = new ConfigurationCleanupAction('));
  assert.match(wiring, /confirm: async preview =>[\s\S]*configurationSyncConfirmation\(preview\)/u);
  assert.match(wiring, /showCompactWarningMessage\(review.message, \{ modal: true, compactDetail: review.compactDetail,\s*detail: review.detail \}, 'Recreate & sync'\) === 'Recreate & sync'/u);
  assert.match(source, /await lazyPanels\(\)\.WorkflowStudioPanel\.refreshAfterConfigurationSync\(\)/u);
  assert.equal(commandClass(PREVIEW), 'read');
  assert.equal(commandClass(APPLY), 'mutation');
});

test('a confirmed review applies exactly the previewed digest and reloads only on success', async () => {
  const calls = [];
  let shown = null;
  const action = new ConfigurationSyncAction(host({ calls, confirm: async value => { shown = value; return true; } }));
  await action.run();
  assert.deepEqual(calls, [PREVIEW, 'confirm', APPLY, 'refresh']);
  assert.deepEqual(shown.proposals.map(item => item.branch), ['sflow/config-change/workflow/demo']);
});

test('a declined review, or an unverified preview, never runs apply', async () => {
  const calls = [];
  assert.equal(await new ConfigurationSyncAction(host({ calls, confirm: async () => false })).run(), null);
  assert.deepEqual(calls, [PREVIEW, 'confirm']);
  for (const shape of [{ ...preview(), confirmation: 'invented' }, { ...preview(), status: 'synced' }, { ...preview(), proposals: undefined }]) {
    const seen = [];
    await assert.rejects(new ConfigurationSyncAction(host({ shape, calls: seen })).run(), /No verified recreate preview/u);
    assert.deepEqual(seen, [PREVIEW]);
  }
});

test('nothing pending syncs references with the preview digest and asks nothing', async () => {
  const calls = [];
  const value = await new ConfigurationSyncAction(host({ shape: preview([]), applied: result('current'), calls })).run();
  assert.equal(value.status, 'current');
  assert.deepEqual(calls, [PREVIEW, APPLY, 'refresh']);
});

test('the confirmation names every proposal, tip, author, summary and file it replays', () => {
  const merged = proposal('retired', { merged: true, files: [] });
  const review = configurationSyncConfirmation(preview([proposal('demo'), proposal('beta', { files: ['singularity/agents/a.md'] }), merged]));
  assert.equal(review.message, 'Recreate and sync configuration from 3 proposals?');
  assert.match(review.detail, /Replays 2 pending proposals \(teammates' unreviewed ones included\) onto approved sflow\/config@aaaaaaaaaaaa; retires 1 merged proposal\./u);
  assert.match(review.detail, /sflow\/config-change\/workflow\/demo @ dddddddddddd by Teammate — edit demo\n {4}singularity\/workflow.yml/u);
  assert.match(review.detail, /sflow\/config-change\/workflow\/beta @ bbbbbbbbbbbb by Teammate — edit beta\n {4}singularity\/agents\/a.md/u);
  assert.match(review.detail, /Already merged \(archived and retired only\):\nsflow\/config-change\/workflow\/retired @ eeeeeeeeeeee/u);
  assert.match(review.detail, /Proposals pushed after this preview are refused\./u);
  // The native dialog shows at most five summary lines; the complete list stays one click away.
  const many = configurationSyncConfirmation(preview(['alpha', 'beta', 'cat', 'dog', 'eel'].map(name => proposal(name))));
  assert.ok(many.compactDetail.split('\n').length <= 5, many.compactDetail);
  assert.match(many.compactDetail, /…and 3 more; View details lists every one\./u);
  const shown = compactMessagePresentation(many.message, many.detail, many.compactDetail);
  assert.ok(shown.fullText.includes('sflow/config-change/workflow/eel'), 'View details carries every proposal');
  assert.match(shown.detail, /teammates' unreviewed ones included/u);
});

test('double clicks share one review and apply, and completion permits a later sync', async () => {
  let complete;
  let calls = 0, refreshes = 0;
  const action = new ConfigurationSyncAction({ run: argv => { calls++; return argv.includes('--apply')
    ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(preview()); },
  refresh: async () => { refreshes++; }, confirm: async () => true });
  const first = action.run();
  assert.equal(first, action.run());
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  complete(result('synced'));
  await first;
  assert.equal(calls, 2); assert.equal(refreshes, 1);
  complete = null;
  const later = action.run();
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  complete(result('current')); await later;
  assert.equal(calls, 4); assert.equal(refreshes, 2);
});

test('refused and unknown outcomes do not refresh or claim successful sync', async () => {
  for (const status of ['not-synced', 'outcome-unknown']) {
    const calls = [];
    assert.equal((await new ConfigurationSyncAction(host({ applied: result(status), calls })).run()).status, status);
    assert.equal(calls.includes('refresh'), false);
  }
});

test('a failed transport frees the click gate for an explicit retry', async () => {
  let attempts = 0;
  const action = new ConfigurationSyncAction({ run: async argv => { if (++attempts === 1) throw new Error('offline');
    return argv.includes('--apply') ? result('current') : preview([]); }, refresh: async () => {}, confirm: async () => true });
  await assert.rejects(action.run(), /offline/u);
  assert.equal((await action.run()).status, 'current');
});

test('a failed UI refresh cannot turn a confirmed remote sync into an unknown transaction', async () => {
  const action = new ConfigurationSyncAction({ ...host(), refresh: async () => { throw new Error('panel closed'); } });
  assert.deepEqual(await action.run(), { ...result('synced'), viewRefresh: 'attention' });
});

test('interruption tells the user to reconcile without claiming unchanged or finished remote state', () => {
  assert.match(configurationSyncInterruptedMessage(), /Do not assume it completed or that nothing changed/u);
  assert.match(configurationSyncInterruptedMessage(), /recreate-sync --json, then --apply --confirm with its confirmation/u);
  assert.doesNotMatch(configurationSyncInterruptedMessage(), /recreate-sync --apply --json/u, 'no unbound apply is offered');
  assert.match(configurationSyncInterruptedMessage(), /do not activate an older proposal/u);
  const exact = `cd '/repo' && '/installed/node' '/installed/cli.mjs' 'configuration' 'recreate-sync' '--apply' '--confirm' '${digest}' '--json'`;
  assert.ok(configurationSyncInterruptedMessage(exact).endsWith(exact), 'timeout retry preserves the actually installed executable');
});
