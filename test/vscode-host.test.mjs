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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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


/**
 * The bundle these tests load must match the sources they are testing.
 *
 * dist/ is not in Git, so a fresh clone has no bundle and a clone that pulled new sources has an old
 * one. An old one is the dangerous case: the tests ran happily against it and failed with assertions
 * about missing tree nodes and unregistered commands, which describe the bundle rather than the bug.
 *
 * So: build it when esbuild is available, and otherwise refuse to pretend. `reason` is non-null only
 * when the bundle cannot be made current, and every test reports that reason rather than skipping in
 * silence.
 */
function bundleState() {
  const extensionRoot = path.join(packageRoot, 'apps', 'vscode');
  const newestSource = (directory) => {
    let newest = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      newest = Math.max(newest, entry.isDirectory() ? newestSource(target) : statSync(target).mtimeMs);
    }
    return newest;
  };

  const sources = newestSource(path.join(extensionRoot, 'src'));
  const built = existsSync(bundle) ? statSync(bundle).mtimeMs : 0;
  if (built > sources) return { reason: null };

  const esbuild = path.join(extensionRoot, 'node_modules', '.bin', 'esbuild');
  if (!existsSync(esbuild)) {
    return {
      reason: built
        ? 'apps/vscode/dist/extension.cjs is older than its sources and esbuild is not installed. Run: npm install && npm run vscode:build'
        : 'apps/vscode/dist/extension.cjs is not built and esbuild is not installed. Run: npm install && npm run vscode:build'
    };
  }
  const build = spawnSync(process.execPath, [path.join(extensionRoot, 'esbuild.mjs')], {
    cwd: extensionRoot, encoding: 'utf8'
  });
  if (build.status !== 0) return { reason: `The extension bundle failed to build: ${build.stderr.trim()}` };
  return { reason: null };
}

const BUNDLE = bundleState();

/** Every test in this file needs a current bundle; none of them may quietly run without one. */
function requireBundle(t) {
  if (!BUNDLE.reason) return true;
  t.skip(BUNDLE.reason);
  return false;
}


/** Wait for a fire-and-forget listener to produce something, or give up with a useful failure. */
async function until(read, { attempts = 60, everyMs = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return read();
}

/** Let a fire-and-forget listener finish when the expected outcome is that nothing happens. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

/** Enough of the VS Code API for activation to complete and for the tree to be read. */
function stubVscode() {
  const registered = { commands: new Map(), trees: new Map(), statusBars: [], errors: [], warnings: [], output: [], inputBoxes: [], panels: [], quickPicks: [], openDialogs: [], answers: [], infos: [], diagnostics: new Map(), saveListeners: [], pickedFile: null, pickedFolder: null };

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
      onDidSaveTextDocument: (listener) => { registered.saveListeners.push(listener); return { dispose() {} }; },
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
    showInformationMessage: async (message) => { registered.infos.push(message); return undefined; },
      showWarningMessage: async (message) => { registered.warnings.push(message); },
      showTextDocument: async () => ({}),
      setStatusBarMessage: () => ({ dispose() {} }),
      withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false })
    },
    commands: {
      registerCommand: (id, handler) => { registered.commands.set(id, handler); return { dispose() {} }; },
      executeCommand: async () => {}
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri, items) => registered.diagnostics.set(String(uri?.fsPath ?? uri), items),
        delete: (uri) => registered.diagnostics.delete(String(uri?.fsPath ?? uri)),
        dispose() {}
      })
    },
    Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
    Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    ViewColumn: { Active: 1 }
  };
  // What a human "types" into the exact-confirmation box, and what they answer to the self-approval
  // modal. Set per test: the default is a person who confirms nothing.
  registered.typed = null;
  registered.selfApprovalAnswer = undefined;
  registered.pickedLens = 'first';
  registered.pickedFile = null;
  registered.pickedFolder = null;
  registered.answers = [];
  api.window.showInputBox = async (options) => {
    registered.inputBoxes.push(options);
    // A scripted queue answers a sequence of prompts; `typed` answers a single one.
    return registered.answers.length ? registered.answers.shift() : registered.typed;
  };
  api.window.showOpenDialog = async (options) => {
    registered.openDialogs.push(options);
    const picked = options?.canSelectFolders ? registered.pickedFolder : registered.pickedFile;
    return picked ? [{ fsPath: picked }] : undefined;
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
  if (!requireBundle(t)) return;
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
  assert.deepEqual(roots.map((node) => node.id), ['initiative:INIT-CHECKOUT', 'configuration'],
    'the Epic, plus the repository configuration that is present either way');
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

test('a folder that is not a Singularity Flow repository still gets a provider that says so', async (t) => {
  if (!requireBundle(t)) return;
  // This test previously asserted that NO tree was registered, which is exactly what made VS Code
  // report "There is no data provider registered that can provide view data" — an error about the
  // extension's internals, shown instead of anything about the reader's repository.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-host-plain-'));
  run('git', ['init', '-q', '-b', 'main', base], { cwd: os.tmpdir() });

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: base } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  // Not a Flow repository is an ordinary state for a folder to be in, not something to shout about.
  assert.deepEqual(registered.errors, []);
  const view = registered.trees.get('singularityFlow.lifecycle');
  assert.ok(view, 'the view always has a provider');

  const [node] = view.treeDataProvider.getChildren();
  assert.match(node.label, /Not a Singularity Flow repository/);
  assert.match(node.tooltip, /singularity\/workflow\.yml/);
  assert.equal(node.contextValue, 'sflow.uninitialized', 'and it offers to initialize one');
  assert.ok(view.treeDataProvider.getTreeItem(node), 'the node renders');
  assert.ok(registered.commands.has('singularityFlow.init'), 'the command it offers exists');
});

test('a window with no folder open explains that, rather than showing no provider', async (t) => {
  if (!requireBundle(t)) return;
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  const view = registered.trees.get('singularityFlow.lifecycle');
  assert.ok(view, 'the view always has a provider');
  assert.match(view.treeDataProvider.getChildren()[0].label, /No folder is open/);
});

test('the view activates on being opened, not only when a workflow file happens to exist', async (t) => {
  if (!requireBundle(t)) return;
  // Without onView, opening the view in any other folder never activates the extension at all, and
  // the contributed view sits there with nothing behind it.
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'apps', 'vscode', 'package.json'), 'utf8'));
  assert.ok(manifest.activationEvents.includes('onView:singularityFlow.lifecycle'));
  assert.equal(manifest.contributes.views.singularityFlow[0].id, 'singularityFlow.lifecycle',
    'the activation event names the view that is actually contributed');
});

test('refusing to open an artifact path that escapes the repository', async (t) => {
  if (!requireBundle(t)) return;
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
  if (!requireBundle(t)) return;
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
  if (!requireBundle(t)) return;
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
  if (!requireBundle(t)) return;
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
  if (!requireBundle(t)) return;
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
  if (!requireBundle(t)) return;
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

test('a placeholder in a suggested action opens a file picker instead of running literally', async (t) => {
  if (!requireBundle(t)) return;
  // The bug this closes: the sources step suggests `--file <PATH>`, and running it verbatim failed
  // on a file literally named "<PATH>".
  const { root, registered } = await activated();
  const brief = path.join(root, 'brief.md');
  await writeFile(brief, '# Brief\n\n- REQ-001 Something is required.\n');
  registered.pickedFile = brief;

  await registered.commands.get('singularityFlow.runAction')({
    kind: 'action',
    command: ['epic', 'sources', 'add', '--epic', 'INIT-CHECKOUT', '--file', '<PATH>']
  });

  assert.equal(registered.openDialogs.length, 1, 'a file picker was opened for the placeholder');
  assert.match(registered.openDialogs[0].title, /--file/);
  assert.deepEqual(registered.errors, [], 'and the command then ran without complaint');

  // The source really is pinned now, with the picked file's bytes.
  const listed = spawnSync(process.execPath,
    [path.join(packageRoot, 'bin', 'singularity-flow.mjs'), 'epic', 'sources', 'list'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Initiative Owner' } });
  assert.match(listed.stdout, /brief\.md/);
  assert.match(listed.stdout, /local/);
});

test('declining the file picker runs nothing', async (t) => {
  if (!requireBundle(t)) return;
  const { root, registered } = await activated();
  registered.pickedFile = null; // the person dismissed the dialog

  await registered.commands.get('singularityFlow.runAction')({
    kind: 'action',
    command: ['epic', 'sources', 'add', '--epic', 'INIT-CHECKOUT', '--file', '<PATH>']
  });
  assert.equal(registered.openDialogs.length, 1);
  assert.deepEqual(registered.errors, [], 'declining is a decision, not a failure');

  const listed = spawnSync(process.execPath,
    [path.join(packageRoot, 'bin', 'singularity-flow.mjs'), 'epic', 'sources', 'list'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Initiative Owner' } });
  assert.doesNotMatch(listed.stdout, /brief\.md/, 'nothing was pinned');
});

test('pinning a source from the editor puts it in the tree', async (t) => {
  if (!requireBundle(t)) return;
  const { root, registered } = await activated();
  const brief = path.join(root, 'research.md');
  await writeFile(brief, '# Research\n');
  registered.pickedFile = brief;

  await registered.commands.get('singularityFlow.addSource')();
  assert.deepEqual(registered.errors, []);

  const provider = registered.trees.get('singularityFlow.lifecycle').treeDataProvider;
  const roots = provider.getChildren();
  const sources = provider.getChildren(roots[0]).find((node) => node.id === 'sources');
  assert.equal(sources.description, '1');
  assert.equal(provider.getChildren(sources)[0].label, 'research.md');
});

test('an Epic can be started and its first source pinned entirely from the editor', async (t) => {
  if (!requireBundle(t)) return;
  // Intake end to end through the extension's own commands: the two steps that had no command at
  // all until now. A repository initialized but with no Epic is where a real user starts.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-intake-'));
  const root = path.join(base, 'platform');
  await mkdir(root);
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# platform\n');
  spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'), 'init'], { cwd: root });
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  // An Epic cannot start until an approval authority has a member; that is the engine's rule and
  // the first thing a new repository has to configure.
  await writeFile(portfolioFile, (await readFile(portfolioFile, 'utf8'))
    .replace(/^  publish: \w+$/m, '  publish: off')
    .replace(/members: \[\]/g, `members: [{ name: Initiative Owner, email: ${EMAIL} }]`));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize'], { cwd: root });

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  // The tree starts by saying there is nothing here, and offering the one thing to do.
  const provider = registered.trees.get('singularityFlow.lifecycle').treeDataProvider;
  assert.match(provider.getChildren()[0].label, /No Epic has been started/);
  assert.equal(provider.getChildren()[0].contextValue, 'sflow.start');

  // Start an Epic: title, description, goal, then profile and working lens.
  registered.answers = ['One-tap checkout', 'Reduce checkout to a single tap', 'Lift completion to 80%'];
  await registered.commands.get('singularityFlow.startEpic')();
  assert.deepEqual(registered.errors, [], 'starting an Epic raised no error');
  assert.equal(registered.inputBoxes.length, 3, 'each answer was asked for, none guessed');
  assert.equal(registered.quickPicks.length, 2, 'profile and working lens both chosen');

  const roots = provider.getChildren();
  assert.equal(roots[0].kind, 'initiative', `expected an Epic, got ${roots[0].label}`);

  // Pin the first source.
  const brief = path.join(root, 'brief.md');
  await writeFile(brief, '# Brief\n\n- REQ-001 A shopper can pay in one tap.\n');
  registered.pickedFile = brief;
  await registered.commands.get('singularityFlow.addSource')();
  assert.deepEqual(registered.errors, []);

  const sources = provider.getChildren(provider.getChildren()[0]).find((node) => node.id === 'sources');
  assert.equal(sources.description, '1');
  assert.equal(provider.getChildren(sources)[0].label, 'brief.md');
});

test('starting an Epic before any approver is named says so first, and offers the file to fix', async (t) => {
  if (!requireBundle(t)) return;
  // The engine refuses this, correctly. What it must not do is refuse *after* five questions with a
  // message naming a YAML key — the precondition is knowable before anything is asked.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-noapprover-'));
  const root = path.join(base, 'platform');
  await mkdir(root);
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# platform\n');
  spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'), 'init'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize'], { cwd: root });

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  registered.selfApprovalAnswer = undefined; // the person dismissed the modal
  await registered.commands.get('singularityFlow.startEpic')();

  assert.equal(registered.inputBoxes.length, 0, 'nothing was asked before the precondition was checked');
  assert.ok(registered.warnings.some((message) => /No approval authority has a member/.test(message)));
  assert.deepEqual(registered.errors, [], 'a missing precondition is not an error dialog');
});

test('creating a workspace is possible before any repository is open', async (t) => {
  if (!requireBundle(t)) return;
  // The command for when there is nothing to serve yet, which is exactly when activation stops
  // early. Registering it after those returns would make it unreachable when it is most needed.
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  for (const id of ['singularityFlow.createWorkspace', 'singularityFlow.init', 'singularityFlow.doctor']) {
    assert.ok(registered.commands.has(id), `${id} is reachable with no repository open`);
  }
});

test('the workspace form opens as a panel and is driven by messages, not prompts', async (t) => {
  if (!requireBundle(t)) return;
  // A workspace is the root concept, and collecting it through a chain of input boxes meant you
  // could not see what you had added, correct a row, or compare repositories before choosing a lead.
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  await registered.commands.get('singularityFlow.createWorkspace')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.workspace');
  assert.ok(panel, 'a workspace panel was created');
  assert.equal(registered.inputBoxes.length, 0, 'nothing is asked through a prompt chain');

  // Same security posture as every other panel.
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|unsafe-eval/);

  // It opens on the empty form, saying what is still outstanding rather than showing a dead button.
  assert.match(panel.webview.html, /New workspace/);
  assert.match(panel.webview.html, /Before this can be created/);
  assert.match(panel.webview.html, /<button data-submit="create" disabled>/);
});

test('saving governed configuration asks the engine, and a broken file is reported where it was typed', async (t) => {
  if (!requireBundle(t)) return;
  // Governed files are edited in ordinary tabs, which skips the check the engine performs when it
  // writes one. Without this the first sign of trouble is a command failing later for a reason that
  // looks unrelated to what was typed.
  const { root, api, registered } = await activated();
  assert.equal(registered.saveListeners.length, 1, 'the extension listens for saves');

  const workflow = path.join(root, 'singularity/workflow.yml');
  const document = { uri: { fsPath: workflow } };

  // Valid to begin with: no diagnostic.
  registered.saveListeners[0](document);
  await settle();
  assert.equal(registered.diagnostics.get(workflow), undefined);

  // Break it, and the engine's own complaint appears against the file. The save listener is
  // fire-and-forget, as VS Code listeners are, so the result is waited for rather than assumed.
  await writeFile(workflow, 'workTypes: "not a mapping"\n');
  registered.saveListeners[0](document);
  const reported = await until(() => registered.diagnostics.get(workflow));
  assert.ok(reported?.length, `no diagnostic; keys=${JSON.stringify([...registered.diagnostics.keys()])}`);
  assert.equal(reported[0].source, 'Singularity Flow');

  // A file that is not configuration is never validated as though it were.
  const readme = { uri: { fsPath: path.join(root, 'README.md') } };
  registered.saveListeners[0](readme);
  await settle();
  assert.equal(registered.diagnostics.get(path.join(root, 'README.md')), undefined);
});

test('the approvals panel opens under the same CSP and leads with what is yours', async (t) => {
  if (!requireBundle(t)) return;
  const { registered } = await activated();
  await registered.commands.get('singularityFlow.openApprovals')();

  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.approvals');
  assert.ok(panel, 'an approvals panel was created');
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(panel.webview.html, /https?:\/\//);
  assert.match(panel.webview.html, /Approvals/);
  // A freshly started Epic has nothing generated, so it says so rather than showing an empty page.
  assert.match(panel.webview.html, /Nothing is waiting|Before this phase can close/);
});
