import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as webview from '../apps/vscode/src/views/webview.ts';
import * as messages from '../apps/vscode/src/views/messages.ts';
import * as journeyModel from '../apps/vscode/src/views/after-install-model.ts';
import * as journeyPage from '../apps/vscode/src/views/after-install-page.ts';
import {
  AfterInstallJourney, afterInstallComplete, productStatus, safeUpgradeComplete
} from '../apps/vscode/src/views/after-install-model.ts';
import { afterInstallHtml, AFTER_INSTALL_SCRIPT, AFTER_INSTALL_STYLE } from '../apps/vscode/src/views/after-install-page.ts';
import { PRIMARY_NAVIGATION, sidebarBody } from '../apps/vscode/src/views/sidebar-page.ts';
import { sidebarDestination } from '../apps/vscode/src/views/sidebar-destination.ts';

const workspace = { id: 'calc', name: 'Calculator', path: '/work/calc', anchorKey: 'calc', active: 'yes' };
const status = {
  workspace: { ...workspace, leadRepository: 'ui' }, healthy: true,
  leadRepositoryPath: '/work/calc/repos/ui',
  repositories: [{ id: 'ui', state: 'ready', absolutePath: '/work/calc/repos/ui', url: 'https://git.example.test/ui.git' }]
};
const product = {
  verdict: 'aligned', next: [], actions: [], split: null,
  surfaces: ['cli', 'vscode', 'copilot'].map(id => ({ id, state: 'aligned', live: 'verified-build' }))
};
const upgrade = {
  resultType: 'workspace-reinitialization', dryRun: true, status: 'preview', planId: 'wrip-exact',
  total: 1, updated: 0, failed: 0, capabilityPortability: { changed: false, status: 'outside-scope-unchanged', plannedLeads: [], results: [] },
  results: [{ repository: 'ui', remote: 'https://git.example.test/ui.git', status: 'preview', files: ['singularity/workflow.yml'] }]
};
const applied = { ...upgrade, dryRun: false, status: 'complete', updated: 1,
  results: upgrade.results.map(repository => ({ ...repository, status: 'updated' })) };
const copy = value => structuredClone(value);

function fixture(overrides = {}) {
  const calls = [], confirmations = [];
  let changed = 0;
  const host = {
    extensionPath: '/installed/vscode',
    confirm: async request => { confirmations.push(request); return true; },
    configurationChanged: async () => { changed++; },
    run: async argv => {
      calls.push(argv);
      if (argv[0] === 'product') return { data: copy(product) };
      if (argv[1] === 'list') return [copy(workspace), { ...workspace, id: 'old', path: '/archived', archivedAt: 'yesterday' }];
      if (argv[1] === 'status') return { ...copy(status), workspace: { ...status.workspace, path: argv[2] } };
      if (argv[1] === 'reinitialize') return copy(argv.includes('--dry-run') ? upgrade : applied);
      if (argv[0] === 'authority') return { data: { result: { status: 'refreshed' } } };
      throw new Error(`Unexpected command: ${argv}`);
    },
    ...overrides
  };
  const journey = new AfterInstallJourney(host, () => {});
  return { journey, host, calls, confirmations, changed: () => changed };
}

async function preview(f) { await f.journey.load(); await f.journey.select(workspace.path); await f.journey.preview(); }
async function apply(f) { await preview(f); await f.journey.apply(); }

test('After install is a contributed, early, repository-independent main menu and configuration route', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.equal(PRIMARY_NAVIGATION.find(item => item.id === 'after-install').command, 'singularityFlow.afterInstall');
  assert.ok(manifest.contributes.commands.some(command => command.command === 'singularityFlow.afterInstall'));
  assert.equal(sidebarDestination('mainThreadWebview-singularityFlow.afterInstall'), 'after-install');
  assert.match(sidebarBody({ navigation: { workspace: null, next: null }, freshness: null, loading: false, pending: null, active: null, favorites: [] }), /data-action="after-install"/);
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const handler = extension.indexOf("'singularityFlow.afterInstall', async");
  assert.ok(handler > 0 && handler < extension.indexOf("if ('reason' in resolved)"));
  assert.match(extension, /message.action === 'after-install'.*singularityFlow.afterInstall/);
  assert.equal((extension.match(/const loadedBundle = new LoadedBundle/g) ?? []).length, 1);
  assert.ok(extension.indexOf('const loadedBundle = new LoadedBundle') < handler);
  assert.match(extension.slice(handler, extension.indexOf('/** Compatibility commands', handler)), /loadedBundle.reloadPending\(\)/);
  const page = await readFile(new URL('../apps/vscode/src/views/configuration-center-page.ts', import.meta.url), 'utf8');
  assert.match(page, /label: 'After install'.*action: 'after-install'/);
});

test('opening the guide reads build status and registry only; never auto-selects or mutates', async () => {
  const f = fixture(); await f.journey.load();
  assert.deepEqual(f.calls, [
    ['product', 'status', '--extension-path', '/installed/vscode', '--json'],
    ['workspace', 'list', '--json']
  ]);
  assert.equal(f.journey.view.selected, null);
  assert.equal(f.journey.view.workspaces.length, 1);
  assert.equal(f.confirmations.length, 0);
  assert.equal(afterInstallComplete(f.journey.view), false);
  await f.journey.select('/not-registered');
  assert.equal(f.calls.length, 2);
});

test('complete flow uses exact workspace/plan and independently confirms local reference refresh', async () => {
  const f = fixture(); await apply(f); await f.journey.refreshReferences();
  assert.deepEqual(f.calls.find(argv => argv.includes('--confirm-plan')), [
    'workspace', 'reinitialize', workspace.path, '--confirm-plan', 'wrip-exact', '--json'
  ]);
  assert.equal(f.confirmations[0].expected, 'wrip-exact');
  assert.equal(f.confirmations[1].expected, 'calc');
  assert.deepEqual(f.calls.find(argv => argv[0] === 'authority'), ['authority', 'refresh', '/work/calc/repos/ui', '--json']);
  assert.equal(afterInstallComplete(f.journey.view), true);
  assert.equal(f.changed(), 2);
  for (const argv of f.calls) assert.ok(!argv.some(arg => ['clone', 'pull', 'checkout', 'start', 'approve', 'publish', 'factory-reset', '--accept-bundled-conflicts'].includes(arg)));
});

test('cancelled confirmation unlocks the guide and makes no upgrade or reference mutation', async () => {
  const f = fixture({ confirm: async () => false }); await preview(f); await f.journey.apply();
  assert.equal(f.journey.view.busy, null);
  assert.equal(f.calls.some(argv => argv.includes('--confirm-plan')), false);
  f.journey.view.upgrade = copy(applied); await f.journey.refreshReferences();
  assert.equal(f.journey.view.busy, null);
  assert.equal(f.calls.some(argv => argv[0] === 'authority'), false);
});

test('a scope change during exact-plan confirmation expires the mutation lease', async () => {
  const f = fixture(); await preview(f);
  f.journey.view.workspaces.push({ ...workspace, id: 'other', path: '/work/other' });
  f.host.confirm = async () => { await f.journey.select('/work/other'); return true; };
  await f.journey.apply();
  assert.equal(f.calls.some(argv => argv.includes('--confirm-plan')), false);
  assert.equal(f.journey.view.selected, '/work/other');
  assert.equal(f.journey.view.upgrade, null);
});

test('modified preview, unsafe ownership transfer and empty scope cannot authorize apply', async () => {
  for (const mutation of [result => { result.capabilityPortability.changed = true; },
    result => { result.results[0].conflicts = [{ path: 'custom', resolution: 'bundled' }]; },
    result => { result.total = 0; result.results = []; }]) {
    const f = fixture(); await preview(f); mutation(f.journey.view.upgrade); await f.journey.apply();
    assert.equal(f.confirmations.length, 0);
    assert.equal(f.calls.some(argv => argv.includes('--confirm-plan')), false);
  }
  const f = fixture(); await preview(f);
  f.host.confirm = async () => { f.journey.view.upgrade.planId = 'changed'; return true; };
  await f.journey.apply();
  assert.equal(f.calls.some(argv => argv.includes('--confirm-plan')), false);
  assert.equal(f.journey.view.busy, null);
});

test('partial and protected-branch results are visible and cannot advance to reference refresh', async () => {
  const f = fixture(); await preview(f);
  const normal = f.host.run;
  f.host.run = async argv => argv.includes('--confirm-plan') ? {
    ...applied, status: 'partial', failed: 1,
    results: [{ ...upgrade.results[0], status: 'review-required', proposalBranch: 'sflow/config-refresh/exact', error: 'protected branch' }]
  } : normal(argv);
  await f.journey.apply(); await f.journey.refreshReferences();
  assert.equal(f.calls.some(argv => argv[0] === 'authority'), false);
  const html = afterInstallHtml(f.journey.view);
  assert.match(html, /sflow\/config-refresh\/exact/);
  assert.match(html, /normal Git review|normal.*Git|normally/);
  assert.match(html, /Upgrade is not complete/);
  assert.doesNotMatch(html, /After-install checks complete/);
});

test('one failed authority refresh does not prevent checking other repositories or claim completion', async () => {
  const f = fixture(); await apply(f);
  f.journey.view.workspace.repositories.push({ id: 'api', state: 'ready', absolutePath: '/work/api', url: 'https://git.example.test/api' });
  const normal = f.host.run;
  f.host.run = async argv => {
    if (argv[0] === 'workspace' && argv[1] === 'status') return copy(f.journey.view.workspace);
    if (argv[0] === 'authority' && argv[2].endsWith('/ui')) { f.calls.push(argv); throw new Error('pin missing: verify and attach'); }
    return normal(argv);
  };
  await f.journey.refreshReferences();
  assert.deepEqual(f.journey.view.references.map(reference => reference.status), ['attention', 'refreshed']);
  assert.equal(afterInstallComplete(f.journey.view), false);
  assert.match(afterInstallHtml(f.journey.view), /pin missing/);
});

test('deferred or unsafe checkout paths are not cloned or refreshed and remain explicit', async () => {
  const f = fixture(); await apply(f);
  f.journey.view.workspace.repositories.push({ id: 'deferred', state: 'missing', absolutePath: '/missing' },
    { id: 'bad', state: 'ready', path: '../untrusted' });
  const normal = f.host.run;
  f.host.run = async argv => argv[0] === 'workspace' && argv[1] === 'status' ? copy(f.journey.view.workspace) : normal(argv);
  await f.journey.refreshReferences();
  assert.deepEqual(f.journey.view.references.map(reference => reference.status), ['refreshed', 'deferred', 'attention']);
  assert.equal(f.calls.filter(argv => argv[0] === 'authority').length, 1);
  assert.equal(afterInstallComplete(f.journey.view), false);
});

test('scope is re-observed after reference confirmation; changed topology refuses writes', async () => {
  const f = fixture(); await apply(f);
  const normal = f.host.run;
  f.host.run = async argv => argv[0] === 'workspace' && argv[1] === 'status' ? { ...copy(status), repositories: [] } : normal(argv);
  await f.journey.refreshReferences();
  assert.equal(f.calls.some(argv => argv[0] === 'authority'), false);
  assert.equal(f.journey.view.busy, null);
  assert.equal(afterInstallComplete(f.journey.view), false);
});

test('changed repository routing and a moved final workspace never report verified completion', async () => {
  for (const moveAt of [1, 2]) {
    const f = fixture(); await apply(f);
    const normal = f.host.run; let reads = 0;
    f.host.run = async argv => {
      if (argv[0] === 'workspace' && argv[1] === 'status') {
        const value = copy(status);
        if (++reads === moveAt) value.repositories[0].absolutePath = '/changed/checkout';
        return value;
      }
      return normal(argv);
    };
    await f.journey.refreshReferences();
    assert.equal(afterInstallComplete(f.journey.view), false);
    assert.match(f.journey.view.error, /changed|moved/);
    assert.equal(f.calls.filter(argv => argv[0] === 'authority').length, moveAt === 1 ? 0 : 1);
  }
});

test('ambiguous apply failure consumes the preview and requires a new one before any retry', async () => {
  const f = fixture(); await preview(f);
  const normal = f.host.run;
  f.host.run = async argv => {
    if (argv.includes('--confirm-plan')) throw new Error('transport interrupted: inspect the retained result');
    return normal(argv);
  };
  await f.journey.apply(); await f.journey.apply();
  assert.equal(f.journey.view.upgrade, null);
  assert.equal(f.confirmations.length, 1);
  assert.match(f.journey.view.error, /interrupted/);
  assert.equal(f.journey.view.busy, null);
});

test('authority refresh accepts Windows absolute checkout paths without converting them to POSIX', async () => {
  const f = fixture(); await apply(f);
  f.journey.view.workspace.repositories[0].absolutePath = 'C:\\Work\\calc\\repos\\ui';
  const normal = f.host.run;
  f.host.run = async argv => argv[0] === 'workspace' && argv[1] === 'status' ? copy(f.journey.view.workspace) : normal(argv);
  await f.journey.refreshReferences();
  assert.deepEqual(f.calls.find(argv => argv[0] === 'authority'), ['authority', 'refresh', 'C:\\Work\\calc\\repos\\ui', '--json']);
  assert.equal(afterInstallComplete(f.journey.view), true);
});

test('malformed or unverified product status leaves recovery visible and prevents repository mutation', async () => {
  assert.throws(() => productStatus({ data: { verdict: 'aligned', surfaces: [] } }), /no verifiable/);
  const f = fixture(); await preview(f);
  f.journey.view.product = { ...product, verdict: 'no-receipt' };
  await f.journey.apply(); assert.equal(f.confirmations.length, 0);
  assert.equal(safeUpgradeComplete({ ...applied, total: 0, results: [] }), false);
  assert.match(afterInstallHtml(f.journey.view), /reinstall the complete matching package/);
});

test('missing installation receipt retains its explicit verdict and recovery without requiring surfaces', async () => {
  const f = fixture({ run: async argv => argv[0] === 'product'
    ? { data: { verdict: 'no-receipt', surfaces: [], next: [], actions: [], split: null } }
    : [] });
  await f.journey.load();
  assert.equal(f.journey.view.product.verdict, 'no-receipt');
  assert.equal(f.journey.view.productError, null);
  assert.match(afterInstallHtml(f.journey.view), /no-receipt.*reinstall the complete matching package/);
  assert.throws(() => productStatus({ ...product, surfaces: [product.surfaces[0], null] }), /no verifiable/);
  assert.throws(() => productStatus({ ...product, next: [null] }), /no verifiable/);
});

test('malformed workspace and upgrade outputs show recovery instead of crashing or authorizing', async () => {
  const f = fixture(); await f.journey.load();
  const normal = f.host.run;
  f.host.run = async argv => argv[0] === 'workspace' && argv[1] === 'status'
    ? { ...copy(status), repositories: [null] } : normal(argv);
  await f.journey.select(workspace.path);
  assert.equal(f.journey.view.workspace, null);
  assert.match(afterInstallHtml(f.journey.view), /workspace check did not return/);
  f.host.run = normal; await f.journey.select(workspace.path);
  f.host.run = async argv => argv[1] === 'reinitialize'
    ? { ...copy(upgrade), results: [{ ...copy(upgrade.results[0]), files: null }] } : normal(argv);
  await f.journey.preview();
  assert.equal(f.journey.view.upgrade, null);
  assert.match(afterInstallHtml(f.journey.view), /unverifiable upgrade result/);
  await f.journey.apply(); assert.equal(f.confirmations.length, 0);
});

test('complete label cannot hide repository, schema or topology failures', () => {
  for (const result of [
    { ...copy(applied), results: [{ ...applied.results[0], status: 'review-required' }] },
    { ...copy(applied), schemaCensuses: [{ healthy: false }] },
    { ...copy(applied), topologyIssues: [{ reason: 'routing moved' }] },
    { ...copy(applied), results: null }
  ]) assert.equal(safeUpgradeComplete(result), false);
});

test('a replacement build while reviewing refuses the write and requests reload', async () => {
  const f = fixture(); await preview(f);
  const normal = f.host.run; let replaced = false;
  f.host.confirm = async () => { replaced = true; return true; };
  f.host.run = async argv => {
    if (replaced) throw new Error('SFlow was updated while this window was open. Reload VS Code.');
    return normal(argv);
  };
  await f.journey.apply();
  assert.equal(f.journey.view.upgrade, null);
  assert.equal(f.calls.some(argv => argv.includes('--confirm-plan')), false);
  assert.match(f.journey.view.error, /Reload VS Code/);
  assert.equal(f.journey.view.busy, null);
});

test('alignment is explicit, never triggered by opening, and requires reload and a new check', async () => {
  const f = fixture(); await f.journey.load();
  f.journey.view.product.verdict = 'repairable'; await f.journey.align();
  assert.equal(f.confirmations[0].expected, 'ALIGN');
  assert.equal(f.journey.view.product, null);
  assert.match(f.journey.view.productError, /Reload VS Code/);
  assert.equal(f.journey.view.busy, null);
});

test('disposal cancels a pending confirmation and never starts its write', async () => {
  const f = fixture(); await preview(f);
  f.host.confirm = async () => { f.journey.dispose(); return true; };
  await f.journey.apply(); assert.equal(f.calls.some(argv => argv.includes('--confirm-plan')), false);
});

test('guided UI escapes diagnostics, bounds details, uses one bridge and explains Story pins', () => {
  const f = fixture(); f.journey.view.error = '<script>unsafe</script>';
  const html = afterInstallHtml(f.journey.view);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  for (const step of ['1. Check', '2. Choose', '3. Upgrade', '4. Refresh']) assert.ok(html.includes(step));
  assert.match(html, /Existing Stories retain their pinned/);
  assert.match(AFTER_INSTALL_STYLE, /max-height:320px/);
  assert.match(AFTER_INSTALL_STYLE, /flex-wrap:wrap; gap:8px/);
  assert.doesNotMatch(AFTER_INSTALL_SCRIPT, /acquireVsCodeApi|fetch\(|executeCommand/);
});

test('real panel messages use host-owned scope and plan, reject forged commands, and dispose leases', async () => {
  const source = await readFile(new URL('../apps/vscode/src/views/after-install-panel.ts', import.meta.url), 'utf8');
  const panels = [], navigations = [];
  const vscode = {
    ViewColumn: { Active: 1 }, Uri: { joinPath: (...parts) => parts.join('/') },
    commands: { executeCommand: async command => navigations.push([command]) },
    window: { createWebviewPanel(id, title, column, options) {
      let disposed = false; const disposal = [];
      const panel = { id, title, column, options,
        webview: { html: '', cspSource: 'vscode-webview:',
          onDidReceiveMessage(callback) { panel.send = callback; return { dispose() {} }; } },
        onDidDispose(callback) { disposal.push(callback); return { dispose() {} }; },
        dispose() { if (!disposed) { disposed = true; disposal.forEach(callback => callback()); } }
      };
      panels.push(panel); return panel;
    } }
  };
  const exports = {};
  const context = vm.createContext({ exports, require(name) {
    const dependencies = {
      vscode, './after-install-model.ts': journeyModel, './after-install-page.ts': journeyPage,
      './webview.ts': webview, './messages.ts': messages,
      './navigate.ts': { navigateTo: (...args) => navigations.push(args) }
    };
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText, context);
  const f = fixture();
  const instance = exports.AfterInstallPanel.show({ extensionUri: '/installed', extensionPath: '/installed' }, f.host);
  await new Promise(setImmediate);
  const panel = panels[0];
  assert.equal(panel.id, 'singularityFlow.afterInstall');
  assert.match(panel.webview.html, /<style nonce=/);
  for (const raw of [null, [], {}, { type: 'execute', command: 'factory-reset' },
    { type: 'select', path: '/forged' }, { type: 'apply', planId: 'forged' }]) await panel.send(raw);
  assert.equal(f.calls.length, 2);
  await panel.send({ type: 'select', path: workspace.path });
  await panel.send({ type: 'preview' });
  await panel.send({ type: 'apply', planId: 'forged', workspacePath: '/forged' });
  assert.equal(f.confirmations[0].expected, 'wrip-exact');
  assert.ok(f.calls.some(argv => argv.includes('--confirm-plan') && argv[2] === workspace.path));
  await panel.send({ type: 'workspaces', workspacePath: '/forged' });
  assert.equal(navigations.at(-1)[1].workspacePath, workspace.path);
  assert.match(panel.webview.html, /4. Refresh workspace references/);
  const before = f.calls.length; panel.dispose();
  await panel.send({ type: 'references' });
  assert.equal(f.calls.length, before, 'disposed host cannot execute a retained page mutation');
  assert.ok(instance);
});
