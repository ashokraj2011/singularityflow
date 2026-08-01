/**
 * The built extension, activated against a stub editor host.
 *
 * The data tests in vscode-extension.test.mjs cover the tree's shape; nothing there touches the two
 * files that talk to the editor. This loads `apps/vscode/dist/extension.cjs` — the artifact that
 * actually ships — with `require('vscode')` intercepted, then activates it against a real
 * Singularity Flow repository built on disk. So it exercises the whole path end to end: activation,
 * repository validation, CLI resolution, a real `desktop snapshot --json` subprocess, the store, and
 * the TreeItems the editor would draw.
 *
 * `vscode` is an external in the bundle precisely because the host injects it, which is what makes
 * this substitution possible rather than a hack.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { createInitiative, initiativeDir, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

process.env.NODE_ENV = 'test';
process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Initiative Owner';
const EMAIL = 'initiative.owner@example.com';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(packageRoot, 'apps', 'vscode', 'dist', 'extension.cjs');

/** Enough of the VS Code API for activation to complete and for the tree to be read. */
function stubVscode() {
  const registered = { commands: new Map(), trees: new Map(), statusBars: [], errors: [], warnings: [], output: [], inputBoxes: [], panels: [], quickPicks: [] };

  class EventEmitter {
    constructor() { this.listeners = new Set(); }
    get event() { return (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }

  class TreeItem {
    constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; }
  }

  const api = {
    EventEmitter,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    Uri: { file: (value) => ({ fsPath: value, scheme: 'file' }) },
    ExtensionContext: null,
    workspace: {
      workspaceFolders: null,
      getConfiguration: () => ({ get: () => '' }),
      openTextDocument: async (target) => ({ target }),
      fs: {}
    },
    window: {
      createOutputChannel: () => ({
        append: (text) => registered.output.push(text),
        appendLine: (text) => registered.output.push(text),
        dispose() {}
      }),
      createTreeView: (id, options) => { registered.trees.set(id, options); return { dispose() {} }; },
      createStatusBarItem: () => {
        const item = { text: '', tooltip: '', command: '', show() { this.shown = true; }, hide() {}, dispose() {} };
        registered.statusBars.push(item);
        return item;
      },
      showErrorMessage: async (message) => { registered.errors.push(message); },
      showWarningMessage: async (message) => { registered.warnings.push(message); },
      showTextDocument: async () => ({}),
      setStatusBarMessage: () => ({ dispose() {} }),
      withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false })
    },
    commands: {
      registerCommand: (id, handler) => { registered.commands.set(id, handler); return { dispose() {} }; },
      executeCommand: async () => {}
    },
    ViewColumn: { Active: 1 }
  };
  // What a human "types" into the exact-confirmation box, and what they answer to the self-approval
  // modal. Set per test: the default is a person who confirms nothing.
  registered.typed = null;
  registered.selfApprovalAnswer = undefined;
  registered.pickedLens = 'first';
  api.window.showInputBox = async (options) => {
    registered.inputBoxes.push(options);
    return registered.typed;
  };
  api.window.showQuickPick = async (items, options) => {
    registered.quickPicks.push({ items, options });
    return registered.pickedLens === null ? undefined : (items[0] ?? undefined);
  };
  api.window.showWarningMessage = async (message, ...rest) => {
    registered.warnings.push(message);
    return registered.selfApprovalAnswer;
  };
  api.window.createWebviewPanel = (id, title, column, options) => {
    const panel = {
      id, title, options,
      webview: { html: '', cspSource: 'vscode-resource:', onDidReceiveMessage: () => ({ dispose() {} }) },
      reveal() {}, onDidDispose: () => ({ dispose() {} }), dispose() {}
    };
    registered.panels.push(panel);
    return panel;
  };
  api.Uri.joinPath = (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') });
  return { api, registered };
}

/** Load the shipped bundle with `vscode` swapped for the stub. */
function loadExtension(api) {
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return api;
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(bundle)];
    return require(bundle);
  } finally {
    Module._load = original;
  }
}

/** A real repository with an enterprise-delivery Epic, generated artifacts, and Stories. */
async function demoRepository() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-host-'));
  const child = async (name) => {
    const dir = path.join(base, name);
    await mkdir(dir);
    run('git', ['init', '-b', 'main', '--bare', dir], { cwd: base });
    return dir;
  };
  const mobile = await child('mobile.git');
  const api = await child('api.git');

  const root = path.join(base, 'checkout');
  await mkdir(root);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Checkout\n');
  await initializeDefinition(root);

  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Initiative Owner', email: EMAIL }];
  }
  portfolio.repositories = {
    mobile: { url: mobile, defaultBranch: 'main', required: true, lead: true },
    api: { url: api, defaultBranch: 'main', required: true }
  };
  portfolio.git = { ...(portfolio.git ?? {}), publish: 'off' };
  await writeFile(portfolioFile, YAML.stringify(portfolio));

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.worldModel.grounding = 'off';
  await writeFile(workflowFile, YAML.stringify(workflow));

  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-CHECKOUT'], { cwd: root });

  const created = await createInitiative(root, { id: 'INIT-CHECKOUT', profile: 'enterprise-delivery' });
  created.initiative.initiative.title = 'One-tap checkout';
  await saveInitiative(root, created.portfolio, created.initiative);
  await writeFile(path.join(initiativeDir(root, created.portfolio, 'INIT-CHECKOUT'), 'breakdown.yml'), YAML.stringify({
    version: 1,
    initiativeId: 'INIT-CHECKOUT',
    epics: [{
      id: 'EPIC-CHECKOUT',
      title: 'One-tap checkout',
      stories: [
        { id: 'API-1', title: 'Payment intent endpoint', repository: 'api', blocking: true },
        {
          id: 'MOB-1', title: 'One-tap purchase sheet', repository: 'mobile', blocking: true,
          dependsOn: [{ story: 'API-1', requiredPhase: 'implementation-spec' }]
        }
      ]
    }]
  }));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Breakdown'], { cwd: root });
  return root;
}

function context() {
  const root = path.join(packageRoot, 'apps', 'vscode');
  return { subscriptions: [], extensionPath: root, extensionUri: { fsPath: root } };
}

test('the built extension activates against a real repository and populates the tree', async (t) => {
  if (!existsSync(bundle)) {
    t.skip('apps/vscode/dist/extension.cjs is not built; run npm run vscode:build');
    return;
  }
  const root = await demoRepository();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];

  const extension = loadExtension(api);
  await extension.activate(context());

  // The tree view was registered under the id package.json contributes.
  const view = registered.trees.get('singularityFlow.lifecycle');
  assert.ok(view, 'the lifecycle tree view is registered');

  // Every contributed command has a handler; a contributed command with none is a broken menu item.
  for (const id of ['singularityFlow.refresh', 'singularityFlow.openArtifact', 'singularityFlow.showImpact']) {
    assert.ok(registered.commands.has(id), `${id} is registered`);
  }

  // The tree is populated from a real `desktop snapshot --json` subprocess, not a fixture.
  const provider = view.treeDataProvider;
  const roots = provider.getChildren();
  assert.equal(roots.length, 1, `expected one Epic, got ${JSON.stringify(roots.map((n) => n.label))}`);
  assert.equal(roots[0].label, 'INIT-CHECKOUT');

  // And the editor-facing mapping produces a usable TreeItem.
  const item = provider.getTreeItem(roots[0]);
  assert.equal(item.label, 'INIT-CHECKOUT');
  assert.equal(item.collapsibleState, api.TreeItemCollapsibleState.Expanded, 'the Epic opens expanded');
  assert.equal(item.iconPath.id, 'rocket');
  assert.equal(item.description, 'One-tap checkout');

  const lifecycle = provider.getChildren(roots[0]).find((node) => node.id === 'phases');
  assert.ok(lifecycle, 'the lifecycle group is present');
  const phases = provider.getChildren(lifecycle);
  assert.equal(phases.length, 7, 'all seven enterprise-delivery phases');
  // Every phase renders an icon and a description: the bug that shipped was phases rendering neither.
  for (const phase of phases) {
    const rendered = provider.getTreeItem(phase);
    assert.ok(rendered.iconPath?.id, `${phase.label} has an icon`);
    assert.ok(rendered.description, `${phase.label} has a description`);
  }

  // Packs reach the tree, which only works because the resolution pins them.
  const packs = provider.getChildren(roots[0]).find((node) => node.id === 'packs');
  assert.ok(packs, 'artifact packs are present for enterprise-delivery');
  assert.equal(provider.getChildren(packs).length, 7);

  // An artifact node carries the command the editor invokes to open it.
  const firstPhase = phases[0];
  const artifact = provider.getChildren(firstPhase)[0];
  const artifactItem = provider.getTreeItem(artifact);
  assert.equal(artifactItem.command?.command, 'singularityFlow.openArtifact');

  // The status bar reports the Epic and the phase it is in.
  const [status] = registered.statusBars;
  assert.match(status.text, /INIT-CHECKOUT/);
  assert.match(status.text, /discover-define/);

  assert.deepEqual(registered.errors, [], 'activation raised no error dialogs');
});

test('a folder that is not a Singularity Flow repository activates quietly', async (t) => {
  if (!existsSync(bundle)) { t.skip('bundle not built'); return; }
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-host-plain-'));
  run('git', ['init', '-q', '-b', 'main', base], { cwd: os.tmpdir() });

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: base } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  // Not a Flow repository is an ordinary state for a folder to be in, not something to shout about.
  assert.deepEqual(registered.errors, []);
  assert.equal(registered.trees.size, 0, 'no tree is registered for a folder it cannot serve');
  assert.ok(registered.output.some((line) => /Not activating/.test(line)), 'the reason is recorded for anyone who expected otherwise');
});

test('refusing to open an artifact path that escapes the repository', async (t) => {
  if (!existsSync(bundle)) { t.skip('bundle not built'); return; }
  const root = await demoRepository();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  const open = registered.commands.get('singularityFlow.openArtifact');
  await open({ path: '../../../../etc/passwd' });
  assert.equal(registered.errors.length, 1);
  assert.match(registered.errors[0], /outside the repository/);
});

/** Activate against a repo and hand back everything a test needs to drive it. */
async function activated() {
  const root = await demoRepository();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context());
  return { root, api, registered, extension };
}

test('the journey panel opens with a strict CSP and no remote origins', async (t) => {
  if (!existsSync(bundle)) { t.skip('bundle not built'); return; }
  const { registered } = await activated();
  await registered.commands.get('singularityFlow.openJourney')();

  const [panel] = registered.panels;
  assert.ok(panel, 'a webview panel was created');
  // Nothing outside the extension's own media directory is loadable.
  assert.equal(panel.options.localResourceRoots.length, 1);
  assert.match(panel.options.localResourceRoots[0].fsPath, /apps\/vscode\/media$/);

  const html = panel.webview.html;
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.match(html, /style-src 'nonce-[0-9a-f]{32}'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /https?:\/\//, 'no remote origin is referenced anywhere in the page');
  // It rendered the real Epic, not a placeholder.
  assert.match(html, /INIT-CHECKOUT/);
  assert.match(html, /Discover &amp; Define/, 'engine labels are HTML-escaped on the way in');
});

test('approving from the editor still demands the exact confirmation a terminal would', async (t) => {
  if (!existsSync(bundle)) { t.skip('bundle not built'); return; }
  // The whole point of the B5 escapes was that a GUI *can* answer these prompts, not that it may
  // skip them. If this ever passes without a human typing the string, the guard is gone.
  const { registered } = await activated();
  const node = {
    kind: 'artifact',
    approve: {
      initiativeId: 'INIT-CHECKOUT', subject: 'business-case',
      expected: 'discover-define:business-case', summary: 'Approve Business case'
    }
  };

  registered.typed = null; // the person dismissed the box
  await registered.commands.get('singularityFlow.approve')(node);
  assert.equal(registered.inputBoxes.length, 1, 'the confirmation was asked for');
  assert.match(registered.inputBoxes[0].prompt, /discover-define:business-case/);
  assert.deepEqual(registered.errors, [], 'declining to confirm is not an error');

  // And the box refuses anything that is not the exact string.
  const { validateInput } = registered.inputBoxes[0];
  assert.match(validateInput('discover-define:business'), /Type exactly/);
  assert.equal(validateInput('discover-define:business-case'), null);
  assert.equal(validateInput(''), null, 'an empty box is not yet an error, just not a confirmation');
});

test('a self-approval is refused by the engine and re-asked as an explicit acknowledgement', async (t) => {
  if (!existsSync(bundle)) { t.skip('bundle not built'); return; }
  // The engine refuses rather than silently recording a non-independent approval. The editor must
  // surface that refusal as a decision, not paper over it by always passing the flag.
  const { root, registered } = await activated();

  // Generate and publish so there is something real to approve.
  const cli = (args) => spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'), ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Initiative Owner',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ persona: 'product-owner' }) }
  });
  cli(['initiative', 'resume', 'INIT-CHECKOUT']);
  cli(['initiative', 'phase']);
  cli(['initiative', 'phase', 'publish', 'discover-define']);

  const node = {
    kind: 'artifact',
    approve: {
      initiativeId: 'INIT-CHECKOUT', subject: 'business-case',
      expected: 'discover-define:business-case', summary: 'Approve Business case'
    }
  };
  registered.typed = 'discover-define:business-case';
  registered.selfApprovalAnswer = undefined; // the person declined the modal

  await registered.commands.get('singularityFlow.approve')(node);
  assert.ok(registered.warnings.some((message) => /not independent review/.test(message)),
    'the self-approval was surfaced as a modal decision');
  assert.deepEqual(registered.errors, [], 'declining is a decision, not a failure');

  // Nothing was approved.
  const status = JSON.parse(cli(['initiative', 'status', '--json']).stdout);
  assert.notEqual(status.initiative.phases['discover-define'].outputs['business-case'].status, 'approved');
});

test('a confirmed and acknowledged approval actually lands, and the views refresh', async (t) => {
  if (!existsSync(bundle)) { t.skip('bundle not built'); return; }
  // The mirror of the previous test: proving it refuses is only half the claim. This proves the
  // editor can complete a governed approval, and that what it recorded is a real approval.
  const { root, registered } = await activated();
  const cli = (args) => spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'), ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Initiative Owner',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ persona: 'product-owner' }) }
  });
  cli(['initiative', 'resume', 'INIT-CHECKOUT']);
  cli(['initiative', 'phase']);
  cli(['initiative', 'phase', 'publish', 'discover-define']);

  registered.typed = 'discover-define:business-case';
  registered.selfApprovalAnswer = 'Approve anyway';
  await registered.commands.get('singularityFlow.approve')({
    kind: 'artifact',
    approve: {
      initiativeId: 'INIT-CHECKOUT', subject: 'business-case',
      expected: 'discover-define:business-case', summary: 'Approve Business case'
    }
  });

  assert.deepEqual(registered.errors, []);
  const status = JSON.parse(cli(['initiative', 'status', '--json']).stdout);
  assert.equal(status.initiative.phases['discover-define'].outputs['business-case'].status, 'approved');

  // The record says it was not independent review, exactly as a terminal approval would.
  const report = JSON.parse(cli(['initiative', 'report', '--format', 'json']).stdout);
  assert.equal(report.approvals.selfApprovals.length, 1);

  // And the tree reflects it without anyone asking for a refresh.
  const provider = registered.trees.get('singularityFlow.lifecycle').treeDataProvider;
  const roots = provider.getChildren();
  const lifecycle = provider.getChildren(roots[0]).find((node) => node.id === 'phases');
  const discover = provider.getChildren(lifecycle)[0];
  const businessCase = provider.getChildren(discover).find((node) => node.id.endsWith('/business-case'));
  assert.equal(businessCase.readOnly, true, 'an approved artifact is now hash-pinned');
  assert.equal(businessCase.command, undefined, 'and offers no second approval');
});

test('the reconciliation panel opens under the same CSP as the journey', async (t) => {
  if (!existsSync(bundle)) { t.skip('bundle not built'); return; }
  // One shared implementation of the security posture, so a second panel cannot quietly relax it.
  const { registered } = await activated();
  await registered.commands.get('singularityFlow.openReconciliation')();

  const [panel] = registered.panels;
  assert.ok(panel, 'a webview panel was created');
  assert.equal(panel.options.localResourceRoots.length, 1);
  assert.match(panel.options.localResourceRoots[0].fsPath, /apps\/vscode\/media$/);

  const html = panel.webview.html;
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /https?:\/\//);

  // It rendered the four levels against the real Epic, and reported honestly that a freshly
  // started Epic has nothing to compare rather than claiming everything agrees.
  assert.match(html, /INIT-CHECKOUT/);
  for (const label of ['Child branch', 'Story → Epic', 'Cross-repository', 'Spec ↔ code']) {
    assert.match(html, new RegExp(label.replace(/[→↔]/g, '.')), `${label} is present`);
  }
  assert.match(html, /nothing to compare/);
  assert.doesNotMatch(html, /levels have drifted/);
});
