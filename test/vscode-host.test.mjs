/**
 * The built extension, activated against a stub editor host.
 *
 * The data tests in vscode-extension.test.mjs cover the tree's shape; nothing there touches the two
 * files that talk to the editor. This loads `apps/vscode/dist/extension.cjs` — the artifact that
 * actually ships — with `require('vscode')` intercepted, then activates it against a real
 * Singularity Flow repository built on disk. So it exercises the whole path end to end: activation,
 * repository validation, CLI resolution, a real `snapshot --json` subprocess, the store, and
 * the TreeItems the editor would draw.
 *
 * `vscode` is an external in the bundle precisely because the host injects it, which is what makes
 * this substitution possible rather than a hack.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
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

/*
 * Every machine-wide file the extension reads is redirected before any test runs.
 *
 * The workspace registry was already redirected per-test; the *selection* — which workspace you are
 * working in — was not, because until recently the resolver read a field the CLI does not emit and
 * therefore never consulted it. Fixing that turned the person's own active workspace into an input
 * to this suite: tests asserting on the folder they had just built started reporting whatever the
 * developer happened to be working in.
 *
 * Redirected here rather than per-test on purpose. A test that forgets is a test that reads the
 * real machine, and it fails only for whoever has a workspace selected.
 */
const machineState = mkdtempSync(path.join(os.tmpdir(), 'sflow-host-machine-'));
process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = path.join(machineState, 'active-workspace.json');
process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY ??= path.join(machineState, 'registry.json');
process.env.SINGULARITY_FLOW_LEAD_REGISTRY ??= path.join(machineState, 'leads.json');
process.env.SINGULARITY_FLOW_VSCODE_RESET_MARKER = path.join(machineState, 'vscode-fresh-reset-pending.json');

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(packageRoot, 'apps', 'vscode', 'dist', 'extension.cjs');

/*
 * The extension deliberately loads heavyweight webview modules only when their command runs. Those
 * modules import `vscode` after activation has returned, so the host substitution must live for the
 * lifetime of this isolated test process rather than only around the initial `require(bundle)`.
 * Each test file has its own Node process; updating this pointer between tests cannot leak into a
 * different suite or a real extension host.
 */
const hostRequire = createRequire(import.meta.url);
const HostModule = hostRequire('node:module');
const originalHostLoad = HostModule._load;
let activeVscodeApi = null;
HostModule._load = function loadWithVscodeHost(request, parent, isMain) {
  if (request === 'vscode' && activeVscodeApi) return activeVscodeApi;
  return originalHostLoad.call(this, request, parent, isMain);
};


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


/**
 * Wait for a fire-and-forget listener to produce something, or fail saying what never arrived.
 *
 * The budget is deliberately generous. Nearly everything waited on here is a panel that has spawned
 * several CLI processes, each of which loads the whole engine; three seconds was comfortable on an
 * idle machine and not comfortable at all with the rest of the suite running beside it. A test that
 * passes alone and fails in the suite is worse than a slow one, and the ceiling only costs time on
 * the runs that were going to fail anyway.
 *
 * Giving up throws rather than returning the empty value, because the assertion that follows would
 * otherwise report the consequence — `expected /Commerce/, got null` — and say nothing at all about
 * the wait that actually failed.
 */
async function until(read, { attempts = 600, everyMs = 50, what = '' } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  const last = read();
  if (last) return last;
  // No call site passes a description, so the reader's own source is the description: it names the
  // condition exactly, and it cannot drift out of date the way a hand-written label would.
  const described = what || read.toString().replace(/\s+/g, ' ').trim().slice(0, 160);
  throw new Error(`Timed out after ${Math.round((attempts * everyMs) / 1000)}s waiting for: ${described}`);
}

/** Accept the one capability review proposal currently based on sflow/config. */
function mergeCapabilityProposal(remote, branchPrefix) {
  const branches = run('git', ['for-each-ref', '--format=%(refname:short)',
    `refs/heads/sflow/config-change/capability/${branchPrefix}*`], { cwd: remote }).stdout.trim().split('\n').filter(Boolean);
  assert.equal(branches.length, 1, `one ${branchPrefix} review branch is available`);
  const baseCommit = run('git', ['rev-parse', `${branches[0]}^`], { cwd: remote }).stdout.trim();
  const baseBranches = run('git', ['for-each-ref', '--format=%(refname:short)',
    '--points-at', baseCommit, 'refs/heads'], { cwd: remote }).stdout.trim().split('\n')
    .filter((branch) => branch && !branch.startsWith('sflow/config-change/'));
  assert.equal(baseBranches.length, 1, 'the proposal has one unchanged base branch');
  const [defaultBranch] = baseBranches;
  const checkout = path.join(mkdtempSync(path.join(os.tmpdir(), 'sflow-review-')), 'checkout');
  run('git', ['clone', '-q', '--branch', defaultBranch, remote, checkout]);
  run('git', ['fetch', '-q', 'origin', branches[0]], { cwd: checkout });
  run('git', ['merge', '--ff-only', `origin/${branches[0]}`], { cwd: checkout });
  run('git', ['push', '-q', 'origin', `HEAD:${defaultBranch}`], { cwd: checkout });
  return branches[0];
}

/** Let a fire-and-forget listener finish when the expected outcome is that nothing happens. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

/** Enough of the VS Code API for activation to complete and for the tree to be read. */
function stubVscode() {
  const registered = { commands: new Map(), trees: new Map(), webviewViews: new Map(), statusBars: [], errors: [], warnings: [], output: [], inputBoxes: [], panels: [], quickPicks: [], openDialogs: [], openedDocuments: [], answers: [], infos: [], diagnostics: new Map(), saveListeners: [], watchers: [], executedCommands: [], pickedFile: null, pickedFolder: null };

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
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    Uri: { file: (value) => ({ fsPath: value, scheme: 'file' }) },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    ExtensionContext: null,
    workspace: {
      workspaceFolders: null,
      getConfiguration: () => ({ get: () => '' }),
      onDidSaveTextDocument: (listener) => { registered.saveListeners.push(listener); return { dispose() {} }; },
      createFileSystemWatcher: (pattern) => {
        const create = new EventEmitter(); const change = new EventEmitter(); const remove = new EventEmitter();
        const watcher = {
          pattern, create, change, remove,
          onDidCreate: create.event, onDidChange: change.event, onDidDelete: remove.event,
          dispose() { create.dispose(); change.dispose(); remove.dispose(); }
        };
        registered.watchers.push(watcher);
        return watcher;
      },
      openTextDocument: async (target) => {
        registered.openedDocuments.push(target);
        return { target };
      },
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
    showInformationMessage: async (message) => {
      registered.infos.push(message);
      return registered.informationAnswer;
    },
      showWarningMessage: async (message) => { registered.warnings.push(message); },
      showTextDocument: async () => ({}),
      setStatusBarMessage: () => ({ dispose() {} }),
      withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false })
    },
    commands: {
      registerCommand: (id, handler) => { registered.commands.set(id, handler); return { dispose() {} }; },
      // Dispatches, like the real one. It used to be inert, which quietly made every command that
      // leads to another command untestable: a screen whose button chains through executeCommand
      // could be asserted on and the assertion could not fail, because nothing was ever going to
      // happen. Built-ins nobody registered — `vscode.openFolder` and friends — still do nothing,
      // which is the correct outcome for a stub rather than a hidden one.
      executeCommand: async (id, ...args) => {
        registered.executedCommands.push({ id, args });
        return registered.commands.get(id)?.(...args);
      },
      getCommands: async () => [...registered.commands.keys()]
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
  registered.informationAnswer = undefined;
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
  registered.warningActions = [];
  api.window.showWarningMessage = async (message, ...rest) => {
    registered.warnings.push(message);
    registered.warningActions.push(rest.filter((item) => typeof item === 'string'));
    return registered.selfApprovalAnswer;
  };
  api.window.createWebviewPanel = (id, title, column, options) => {
    // The handler is kept, not discarded: a panel that is only ever rendered is half-tested. Driving
    // a real message through it is what proves the button on the page reaches the engine.
    let handler = null;
    const panel = {
      id, title, options,
      webview: {
        html: '', cspSource: 'vscode-resource:',
        onDidReceiveMessage: (listener) => { handler = listener; return { dispose() { handler = null; } }; }
      },
      post: async (message) => { await handler?.(message); },
      reveal() {}, onDidDispose: () => ({ dispose() {} }), dispose() {}
    };
    registered.panels.push(panel);
    return panel;
  };
  api.window.registerWebviewViewProvider = (id, provider, options) => {
    let handler = null;
    const view = {
      id, provider, options,
      webview: {
        html: '', cspSource: 'vscode-resource:', options: {},
        onDidReceiveMessage: (listener) => { handler = listener; return { dispose() { handler = null; } }; }
      },
      post: async (message) => { await handler?.(message); }
    };
    registered.webviewViews.set(id, view);
    provider.resolveWebviewView(view);
    return { dispose() { registered.webviewViews.delete(id); } };
  };
  api.Uri.joinPath = (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') });
  return { api, registered };
}

/** Load the shipped bundle with `vscode` swapped for the stub. */
function loadExtension(api) {
  activeVscodeApi = api;
  delete hostRequire.cache[hostRequire.resolve(bundle)];
  return hostRequire(bundle);
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

/**
 * The provider feeding a Navigator section.
 *
 * These assertions used to reach `section(registered, 'lifecycle')`, a contributed
 * tree view gated on a context key set nowhere — so it had never rendered for any user, while eight
 * tests proved its provider worked. That is why the dead surface survived: deleting it looked like
 * a regression. Same providers, reached through the sidebar that actually renders them.
 */
const section = (registered, name) =>
  registered.webviewViews.get('singularityFlow.navigation')?.provider?.sourceFor(name) ?? null;

function context(values = new Map()) {
  const root = path.join(packageRoot, 'apps', 'vscode');
  return {
    subscriptions: [],
    extensionPath: root,
    extensionUri: { fsPath: root },
    globalState: {
      get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      update: async (key, value) => { values.set(key, value); }
    },
    secrets: {
      get: async (key) => values.get(`secret:${key}`),
      store: async (key, value) => { values.set(`secret:${key}`, value); },
      delete: async (key) => { values.delete(`secret:${key}`); },
      onDidChange: () => ({ dispose() {} })
    }
  };
}

test('the built extension activates against a real repository and populates the tree', async (t) => {
  if (!requireBundle(t)) return;
  const root = await demoRepository();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];

  const extension = loadExtension(api);
  await extension.activate(context());

  // The tree view was registered under the id package.json contributes.
  const view = section(registered, 'lifecycle');
  assert.ok(view, 'the lifecycle tree view is registered');

  // Every contributed command has a handler; a contributed command with none is a broken menu item.
  for (const id of ['singularityFlow.refresh', 'singularityFlow.openArtifact', 'singularityFlow.showImpact']) {
    assert.ok(registered.commands.has(id), `${id} is registered`);
  }

  // The tree is populated from a real `snapshot --json` subprocess, not a fixture.
  const provider = view;
  const roots = provider.getChildren();
  assert.deepEqual(roots.map((node) => node.id), ['initiative:INIT-CHECKOUT', 'workspace:impact'],
    'Lifecycle keeps advisory workspace exploration separate from the selected governed work');
  const initiativeRoot = roots.find((node) => node.id === 'initiative:INIT-CHECKOUT');
  assert.ok(initiativeRoot, 'the active Initiative is present without a duplicate My Work entry');
  assert.equal(initiativeRoot.label, 'INIT-CHECKOUT');

  const configuration = section(registered, 'configuration');
  assert.ok(configuration, 'repository settings have a dedicated Configuration view');
  const configurationRoots = configuration.getChildren();
  assert.deepEqual(configurationRoots.map((node) => node.id), ['configuration:center']);

  // The section is one entry, so "discoverable under Configuration" now means discoverable in the
  // Center it opens. Driven through the real command rather than asserted against the page source.
  await registered.commands.get('singularityFlow.configureTemplates')();
  const centerPanel = registered.panels.find((entry) => entry.id === 'singularityFlow.configurationCenter');
  assert.ok(centerPanel, 'the Configuration Center opens from the single Configuration entry');
  assert.match(centerPanel.webview.html, /Agents and prompts/, 'agents are discoverable in the Center');

  // And the editor-facing mapping produces a usable TreeItem.
  const item = provider.getTreeItem(initiativeRoot);
  assert.equal(item.label, 'INIT-CHECKOUT');
  assert.equal(item.collapsibleState, api.TreeItemCollapsibleState.Expanded, 'the Epic opens expanded');
  assert.equal(item.iconPath.id, 'rocket');
  assert.equal(item.description, 'One-tap checkout');

  const lifecycle = provider.getChildren(initiativeRoot).find((node) => node.id === 'phases');
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
  const packs = provider.getChildren(initiativeRoot).find((node) => node.id === 'packs');
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

test('a legacy workflow blocks Lifecycle but leaves all repairable configuration visible', async (t) => {
  if (!requireBundle(t)) return;
  const root = await demoRepository();
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.version = 1;
  await writeFile(workflowFile, YAML.stringify(workflow));
  run('git', ['add', 'singularity/workflow.yml'], { cwd: root });
  run('git', ['commit', '-m', 'Use retired workflow schema'], { cwd: root });

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  const lifecycleProvider = section(registered, 'lifecycle');
  assert.match(lifecycleProvider.getChildren()[0].label, /version must be 2/);
  const lifecycleReset = lifecycleProvider.getChildren()
    .find((node) => node.id === 'lifecycle:error:reinitialize');
  assert.equal(lifecycleProvider.getTreeItem(lifecycleReset).command.command, 'singularityFlow.reinitialize');

  const configurationProvider = section(registered, 'configuration');
  const roots = configurationProvider.getChildren();
  assert.match(roots[0].label, /version must be 2/);
  assert.ok(roots.some((node) => node.id === 'configuration:center'),
    'Configuration remains reachable below the validation finding');

  /**
   * Configuration is how a refused repository gets repaired, so a v1 workflow must not take away the
   * files whose editing is the fix. The inventory moved into the Center, so that is where the
   * guarantee is now checked — with the definition actually refused, not with a hand-built snapshot.
   */
  await registered.commands.get('singularityFlow.configureTemplates')();
  const centerPanel = registered.panels.find((entry) => entry.id === 'singularityFlow.configurationCenter');
  assert.ok(centerPanel, 'the Configuration Center opens against a refused definition');
  for (const heading of ['Artifact templates', 'Repository prompts', 'Skills and prompt packs', 'Agents and prompts']) {
    assert.ok(centerPanel.webview.html.includes(heading), `${heading} remain visible`);
  }
  // The designers live on the overview tab, so switch to it rather than asserting one tab's markup
  // contains another's.
  await registered.commands.get('singularityFlow.openConfigurationCenter')();
  assert.match(centerPanel.webview.html, /data-action="open-designer"/, 'workflow and phase design remains reachable');
  assert.ok(registered.commands.has('singularityFlow.reinitialize'), 'the no-migration recovery command is registered');

  registered.selfApprovalAnswer = 'Reset and reinitialize';
  registered.typed = `RESET ${path.basename(root)} ${run('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root }).stdout.trim()}`;
  await registered.commands.get('singularityFlow.reinitialize')();
  assert.equal(YAML.parse(await readFile(workflowFile, 'utf8')).version, 2,
    'the guarded editor action installs workflow v2 from the bundled CLI');
  assert.equal(registered.errors.length, 0, registered.errors.join('\n'));
  assert.deepEqual(registered.errors, [], 'degraded configuration is rendered rather than raised as an editor error');
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
  const view = section(registered, 'lifecycle');
  assert.ok(view, 'the view always has a provider');

  const [node] = view.getChildren();
  assert.match(node.label, /Not a Singularity Flow repository/);
  assert.match(node.tooltip, /singularity\/workflow\.yml/);
  assert.equal(node.contextValue, 'sflow.uninitialized', 'and it offers to initialize one');
  assert.ok(view.getTreeItem(node), 'the node renders');
  assert.ok(registered.commands.has('singularityFlow.init'), 'the command it offers exists');
});

test('a window with nothing open and no active workspace says which of the two to fix', async (t) => {
  if (!requireBundle(t)) return;
  // "Open the repository that contains singularity/workflow.yml" was a demand, and the wrong one:
  // nobody opens that repository as their editor folder. A workspace is the thing to have.
  const empty = await mkdtemp(path.join(os.tmpdir(), 'sflow-noreg-'));
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = path.join(empty, 'registry.json');
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  const view = section(registered, 'lifecycle');
  assert.ok(view, 'the view always has a provider');
  const [noWorkspaceNode] = view.getChildren();
  assert.equal(noWorkspaceNode.label, 'Choose a workspace to begin');
  assert.equal(view.getTreeItem(noWorkspaceNode).command.command,
    'singularityFlow.openWorkspaces', 'the compact empty state is itself the recovery action');

  const configuration = section(registered, 'configuration');
  const configurationActions = configuration.getChildren();
  assert.equal(configurationActions[0].label, 'Create first capability');
  assert.equal(configuration.getTreeItem(configurationActions[0]).command.command,
    'singularityFlow.mapCapability', 'capability setup does not depend on a workspace');
  assert.equal(configurationActions[1].label, 'Choose a workspace');
  assert.equal(configuration.getTreeItem(configurationActions[1]).command.command,
    'singularityFlow.openWorkspaces');
  assert.equal(configurationActions[2].label, 'Review capability proposals');
  assert.equal(configuration.getTreeItem(configurationActions[2]).command.command,
    'singularityFlow.reviewCapabilityProposals',
    'pending organisation changes remain reviewable without an active workspace');
});

test('a selected workspace with a missing lead repository offers repair instead of claiming no workspace is active', async (t) => {
  if (!requireBundle(t)) return;
  const org = await organisation();
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-missing-lead-'));
  const registryFile = path.join(base, 'registry.json');
  const selectionFile = path.join(base, 'active.json');
  const env = {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registryFile,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selectionFile
  };
  const create = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'workspace', 'create', '--local', '--json', '--id', 'missing-lead',
    '--base', path.join(base, 'workspaces'), '--lead', 'platform',
    '--repository', `platform=${org.lead}`, '--confirm', 'missing-lead', '--no-clone'], {
    encoding: 'utf8', env
  });
  assert.equal(create.status, 0, create.stderr);
  const use = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'workspace', 'use', 'missing-lead', '--json'], { encoding: 'utf8', env });
  assert.equal(use.status, 0, use.stderr);

  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selectionFile;
  t.after(() => {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
  });

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  const lifecycle = section(registered, 'lifecycle');
  const [problem] = lifecycle.getChildren();
  assert.match(problem.label, /Workspace repository is missing/);
  assert.doesNotMatch(problem.label, /No workspace is active/);
  assert.match(problem.tooltip, /missing-lead/);
  assert.equal(lifecycle.getTreeItem(problem).command.command, 'singularityFlow.repairWorkspace');

  const [configuration] = section(registered, 'configuration').getChildren();
  assert.match(configuration.label, /Workspace repository is missing/);
  assert.equal(section(registered, 'configuration')
    .getTreeItem(configuration).command.command, 'singularityFlow.repairWorkspace');

  const workspaceProvider = section(registered, 'workspaces');
  const selected = await until(() => workspaceProvider.getChildren()[0]?.description ? workspaceProvider.getChildren()[0] : null);
  assert.equal(selected.description, 'selected · repository missing');
  assert.equal(selected.icon, 'statusWarning');
  assert.ok(registered.commands.has('singularityFlow.repairWorkspace'));
});

test('the view activates on being opened, not only when a workflow file happens to exist', async (t) => {
  if (!requireBundle(t)) return;
  // Without onView, opening the view in any other folder never activates the extension at all, and
  // the contributed view sits there with nothing behind it.
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'apps', 'vscode', 'package.json'), 'utf8'));
  const contributed = new Set(Object.values(manifest.contributes.views).flat().map((view) => view.id));

  /**
   * Every `onView:` names a view that exists, and every view has one.
   *
   * Asserted as a pairing rather than by listing ids, which is what the previous version did and
   * what let five of them rot: the views were gated on a context key set nowhere, so they never
   * rendered, and their activation events named things a user could not open. Removing the views
   * left the events behind — caught here, which is the test doing its job.
   */
  const onView = manifest.activationEvents.filter((event) => event.startsWith('onView:'))
    .map((event) => event.slice('onView:'.length));
  assert.deepEqual(onView.filter((id) => !contributed.has(id)), [],
    'an activation event names a view nothing contributes');
  assert.deepEqual([...contributed].filter((id) => !onView.includes(id)), [],
    'a contributed view has no activation event, so opening it activates nothing');

  // Workspaces leads: work happens in one, and everything else is scoped to it.
  assert.equal(manifest.contributes.views.singularityFlowNavigator[0].id, 'singularityFlow.navigation');
});

test('the visible sidebar is one branded, scrollable navigation surface', async (t) => {
  if (!requireBundle(t)) return;
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  const navigation = registered.webviewViews.get('singularityFlow.navigation');
  assert.ok(navigation, 'the visible webview provider is registered');
  assert.match(navigation.webview.html, /<small>Singularity<\/small><strong>Flow<\/strong>/);
  for (const [section, label] of Object.entries({
    workspaces: 'Workspaces', lifecycle: 'Lifecycle', inbox: 'Inbox',
    configuration: 'Configuration', help: 'Help'
  })) {
    assert.match(navigation.webview.html, new RegExp(`data-section="${section}"`));
    assert.match(navigation.webview.html, new RegExp(`<span>${label}<\\/span>`),
      `${label} is rendered in readable title case`);
  }
  const sectionTitleRule = navigation.webview.html.match(/\.section-title \{[^}]+\}/)?.[0] ?? '';
  assert.match(sectionTitleRule, /font-weight:500/,
    'section names use a restrained medium weight rather than full bold');
  assert.doesNotMatch(sectionTitleRule, /text-transform:uppercase/,
    'section names are not forced to all caps');
  assert.match(navigation.webview.html, /default-src 'none'/);
  assert.doesNotMatch(navigation.webview.html, /unsafe-inline|unsafe-eval/);
  assert.match(navigation.webview.html, /prefers-reduced-motion/);
});

test('Help is available without a workspace and opens the canonical offline manual', async (t) => {
  if (!requireBundle(t)) return;
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  const help = section(registered, 'help');
  assert.ok(help, 'Help has a provider even before workspace selection');
  assert.ok(help.getChildren().some((node) => node.id === 'help:all'));
  await registered.commands.get('singularityFlow.openHelp')({ id: 'help:story-intake' });
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.helpCenter');
  assert.ok(panel, 'the searchable Help Center opened');
  assert.match(panel.webview.html, /Story intake/);
  assert.match(panel.webview.html, /CLI command reference/);
  assert.match(panel.webview.html, /\/sf-story-start/);
});

test('every shared screen destination is connected through a real webview message', async (t) => {
  if (!requireBundle(t)) return;
  const root = await demoRepository();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  await registered.commands.get('singularityFlow.openHelp')({ id: 'help:all' });
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.helpCenter');
  assert.ok(panel, 'a real full-page panel opened');

  const destinations = {
    journey: 'singularityFlow.openJourney',
    approvals: 'singularityFlow.openApprovals',
    configuration: 'singularityFlow.openConfigurationCenter',
    doctor: 'singularityFlow.doctor',
    help: 'singularityFlow.openHelp'
  };
  for (const [to, command] of Object.entries(destinations)) {
    await panel.post({ type: 'navigate', to });
    await until(() => registered.executedCommands.some((entry) => entry.id === command));
  }
});

test('a failing shared destination reports an actionable error instead of becoming a dead link', async (t) => {
  if (!requireBundle(t)) return;
  const root = await demoRepository();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  await registered.commands.get('singularityFlow.openHelp')({ id: 'help:all' });
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.helpCenter');
  registered.commands.set('singularityFlow.openJourney', async () => {
    throw new Error('journey data is unavailable');
  });
  await panel.post({ type: 'navigate', to: 'journey' });
  await until(() => registered.errors.find((message) => message.includes('journey data is unavailable')));
  assert.match(registered.errors.at(-1), /Could not open the Singularity Flow view/);
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

  /**
   * The guard fires and the reader is told why — now as a card rather than a toast.
   *
   * The refusal is what this test is about, so it asserts the refusal reached a surface, not which
   * surface. Asserting `registered.errors` was asserting the transport; a security guard whose test
   * breaks when the presentation improves is testing the wrong thing.
   */
  assert.deepEqual(registered.errors, [], 'a refusal is a card, not a toast');
  const refusal = registered.panels.find((entry) => entry.id === 'singularityFlow.result');
  assert.ok(refusal, 'the refusal was shown');
  assert.match(refusal.webview.html, /leaves the repository/);
  assert.match(refusal.webview.html, /etc&#47;passwd|etc\/passwd/);
});

test('packaged agents open from the active CLI without weakening the repository boundary', async (t) => {
  if (!requireBundle(t)) return;
  const root = await demoRepository();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  const open = registered.commands.get('singularityFlow.openArtifact');
  await open({
    path: '../../../../../.vscode/extensions/singularity-flow/architect.agent.md',
    packagePath: 'templates/agents/architect.agent.md',
    readOnly: true
  });
  assert.equal(registered.errors.length, 0);
  assert.equal(registered.openedDocuments.at(-1).fsPath,
    path.join(packageRoot, 'templates', 'agents', 'architect.agent.md'));
  assert.equal(registered.panels.filter((entry) => entry.id === 'singularityFlow.result').length, 0,
    'a permitted open raises no refusal');

  await open({
    path: '../../../../../etc/passwd', packagePath: '../../../../../etc/passwd', readOnly: true
  });
  const refusal = registered.panels.find((entry) => entry.id === 'singularityFlow.result');
  assert.ok(refusal, 'the engine boundary refused, and said so');
  assert.match(refusal.webview.html, /outside the installed Singularity Flow engine/);
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
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ agent: 'product-owner' }) }
  });
  for (const args of [
    ['initiative', 'resume', 'INIT-CHECKOUT'],
    ['initiative', 'phase'],
    ['initiative', 'phase', 'publish', 'discover-define']
  ]) {
    const result = cli(args);
    assert.equal(result.status, 0, `${args.join(' ')} failed:\n${result.stderr}`);
  }

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
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ agent: 'product-owner' }) }
  });
  for (const args of [
    ['initiative', 'resume', 'INIT-CHECKOUT'],
    ['initiative', 'phase'],
    ['initiative', 'phase', 'publish', 'discover-define']
  ]) {
    const result = cli(args);
    assert.equal(result.status, 0, `${args.join(' ')} failed:\n${result.stderr}`);
  }

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
  const provider = section(registered, 'lifecycle');
  const roots = provider.getChildren();
  const initiative = roots.find((node) => node.kind === 'initiative');
  assert.ok(initiative);
  const lifecycle = provider.getChildren(initiative).find((node) => node.id === 'phases');
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

  const provider = section(registered, 'lifecycle');
  const roots = provider.getChildren();
  const initiative = roots.find((node) => node.id === 'initiative:INIT-CHECKOUT');
  assert.ok(initiative);
  const sources = await until(() => {
    const refreshedInitiative = provider.getChildren().find((node) => node.kind === 'initiative');
    if (!refreshedInitiative) return null;
    const current = provider.getChildren(refreshedInitiative).find((node) => node.id === 'sources');
    return current?.description === '1' ? current : null;
  }, { what: 'the pinned Epic source to appear in the refreshed tree' });
  assert.equal(sources.description, '1');
  assert.equal(provider.getChildren(sources)[0].label, 'research.md');
});

test('the guided evidence manager shows attachment choices and pins a selected file to the active Epic', async (t) => {
  if (!requireBundle(t)) return;
  const { root, registered } = await activated();
  const design = path.join(root, 'checkout-design.png');
  await writeFile(design, 'pinned design bytes');
  registered.pickedFile = design;
  registered.informationAnswer = 'Attach evidence';

  await registered.commands.get('singularityFlow.attachEvidence')();

  const manager = registered.panels.find((entry) => entry.id === 'singularityFlow.evidenceManager');
  assert.ok(manager, 'the sidebar action opens the complete evidence manager');
  assert.match(manager.webview.html, /Evidence &amp; designs/);
  assert.match(manager.webview.html, /Files, images &amp; PDFs/);
  assert.match(manager.webview.html, /Figma export package/);
  assert.match(manager.webview.html, /Figma design link/);
  assert.match(manager.webview.html, /HTTPS reference/);
  await manager.post({ type: 'attach', targetKey: 'epic:INIT-CHECKOUT', source: 'files' });

  assert.deepEqual(registered.errors, []);
  assert.equal(registered.openDialogs.length, 1, 'the editor collected the local evidence');
  assert.equal(registered.openDialogs[0].canSelectMany, true, 'the same action accepts a complete evidence set');
  const provider = section(registered, 'lifecycle');
  const roots = provider.getChildren();
  const initiative = roots.find((node) => node.id === 'initiative:INIT-CHECKOUT');
  assert.ok(initiative);
  const sources = provider.getChildren(initiative).find((node) => node.id === 'sources');
  assert.equal(sources.description, '1');
  assert.equal(provider.getChildren(sources)[0].label, 'checkout-design.png');
  assert.ok(registered.infos.some((message) => /Attached 1 path to Epic/.test(message)));
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
  const provider = section(registered, 'lifecycle');
  const initialRoots = provider.getChildren();
  assert.match(initialRoots.find((node) => node.id === 'no-initiative')?.label ?? '', /No work has been started/);
  assert.equal(initialRoots.find((node) => node.contextValue === 'sflow.start')?.contextValue, 'sflow.start');

  // Start work. One screen covers all six ways it starts, so nothing is asked through a prompt and
  // every answer stays visible and correctable until the work is actually started.
  await registered.commands.get('singularityFlow.startWork')();
  const intakePanel = registered.panels.find((entry) => entry.id === 'singularityFlow.intake');
  assert.ok(intakePanel, 'a start-work panel was created');
  assert.match(intakePanel.webview.html, /default-src 'none'/);
  // All three shapes are offered, and this repository has no Jira, which is said rather than hidden.
  const loaded = await until(() =>
    (intakePanel.webview.html.includes('data-choose-profile') || intakePanel.webview.html.includes('epic-intake')
      ? intakePanel.webview.html : null));
  assert.match(loaded, /data-shape="initiative"/);
  assert.match(loaded, /data-shape="story"/);
  // The profiles came from this repository, with the phases each one runs.
  assert.match(loaded, /data-profile="epic-planning"/);
  assert.match(loaded, /epic-intake/);

  // Story intake reads workflow.yml through `workflow list`, selects the repository's familiar
  // default, and therefore never asks the non-interactive extension to answer a terminal prompt.
  await intakePanel.post({ type: 'shape', value: 'story' });
  const storyForm = await until(() =>
    (intakePanel.webview.html.includes('data-work-type="feature"') ? intakePanel.webview.html : null));
  assert.match(storyForm, /Story workflow/);
  assert.match(storyForm, /data-work-type="feature"[^>]*checked/);
  assert.match(storyForm, /implementation/);

  await intakePanel.post({ type: 'shape', value: 'epic' });
  await intakePanel.post({ type: 'tracker', value: 'none' });
  await intakePanel.post({ type: 'field', field: 'title', value: 'One-tap checkout' });
  await intakePanel.post({ type: 'field', field: 'description', value: 'Reduce checkout to a single tap' });
  await intakePanel.post({ type: 'field', field: 'goal', value: 'Lift completion to 80%' });
  await intakePanel.post({ type: 'profile', value: 'epic-planning' });
  await intakePanel.post({ type: 'field', field: 'lens', value: 'developer' });
  await intakePanel.post({ type: 'start' });
  await until(() => (provider.getChildren().some((node) => node.kind === 'initiative') ? true : null));

  assert.deepEqual(registered.errors, [], 'starting an Epic raised no error');
  assert.equal(registered.inputBoxes.length, 0, 'nothing was asked through a prompt');
  assert.equal(registered.quickPicks.length, 0, 'nothing was asked through a picker');

  const roots = provider.getChildren();
  const initiative = roots.find((node) => node.kind === 'initiative');
  assert.ok(initiative, `expected an Epic, got ${roots.map((node) => node.label).join(', ')}`);

  // Pin the first source.
  const brief = path.join(root, 'brief.md');
  await writeFile(brief, '# Brief\n\n- REQ-001 A shopper can pay in one tap.\n');
  registered.pickedFile = brief;
  await registered.commands.get('singularityFlow.addSource')();
  assert.deepEqual(registered.errors, []);

  const sources = await until(() => {
    const refreshedInitiative = provider.getChildren().find((node) => node.kind === 'initiative');
    if (!refreshedInitiative) return null;
    const current = provider.getChildren(refreshedInitiative).find((node) => node.id === 'sources');
    return current?.description === '1' ? current : null;
  }, { what: 'the pinned Epic source to appear in the refreshed tree' });
  assert.equal(sources.description, '1');
  assert.equal(provider.getChildren(sources)[0].label, 'brief.md');
});

test('Story intake refuses a dirty target before opening the form', async (t) => {
  if (!requireBundle(t)) return;
  const { root, registered } = await activated();
  await writeFile(path.join(root, 'unfinished-change.txt'), 'not ready to govern\n');
  registered.selfApprovalAnswer = 'Open Source Control';

  await registered.commands.get('singularityFlow.startWork')();

  assert.equal(registered.panels.some((entry) => entry.id === 'singularityFlow.intake'), false,
    'the form is not shown for a target the engine will refuse');
  const warning = registered.warnings.find((message) => /Cannot start work/.test(message));
  assert.match(warning ?? '', /checkout/);
  assert.match(warning ?? '', /INIT-CHECKOUT/);
  assert.match(warning ?? '', /unfinished-change\.txt/);
  assert.ok(registered.executedCommands.some((entry) => entry.id === 'workbench.view.scm'),
    'the refusal offers the relevant recovery surface');
});

test('a manual Story is submitted end to end from the editor', async (t) => {
  if (!requireBundle(t)) return;
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-intake-'));
  const root = path.join(base, 'service');
  await mkdir(root);
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# service\n');
  const initialized = spawnSync(process.execPath,
    [path.join(packageRoot, 'bin', 'singularity-flow.mjs'), 'init'],
    { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);

  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  await writeFile(portfolioFile, (await readFile(portfolioFile, 'utf8'))
    .replace(/^  publish: \w+$/m, '  publish: off')
    .replace(/members: \[\]/g, `members: [{ name: Initiative Owner, email: ${EMAIL} }]`));
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.git.publish = 'off';
  workflow.worldModel.grounding = 'off';
  await writeFile(workflowFile, YAML.stringify(workflow));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize'], { cwd: root });

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  await registered.commands.get('singularityFlow.startWork')();
  const intakePanel = registered.panels.find((entry) => entry.id === 'singularityFlow.intake');
  assert.ok(intakePanel, 'a clean repository opens Story intake');
  await intakePanel.post({ type: 'shape', value: 'story' });
  await until(() => intakePanel.webview.html.includes('data-work-type="feature"') ? true : null);
  await intakePanel.post({ type: 'tracker', value: 'none' });
  await intakePanel.post({ type: 'field', field: 'id', value: 'STORY-UI' });
  await intakePanel.post({ type: 'field', field: 'title', value: 'Area operator' });
  await intakePanel.post({ type: 'field', field: 'description', value: 'Add an operator called area' });
  await intakePanel.post({ type: 'field', field: 'acceptanceCriteria', value: 'Testing proves the result' });
  await intakePanel.post({ type: 'start' });

  await until(() => run('git', ['branch', '--show-current'], { cwd: root }).stdout.trim() === 'STORY-UI'
    ? true : null, { what: 'the Story branch to be created' });
  await until(() => registered.infos.find((message) => /Story STORY-UI started/.test(message)) ?? null,
    { what: 'the editor to report the started Story' });
  assert.deepEqual(registered.errors, []);
  assert.deepEqual(registered.warnings, []);
  assert.equal(run('git', ['log', '-1', '--pretty=%s'], { cwd: root }).stdout.trim(),
    '[STORY-UI][init] start feature workflow');
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout.trim(), '');
});

test('starting work before any approver is named says so first, and offers the file to fix', async (t) => {
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
  await registered.commands.get('singularityFlow.startWork')();

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

  for (const id of ['singularityFlow.createWorkspace', 'singularityFlow.init', 'singularityFlow.reinitialize', 'singularityFlow.doctor']) {
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
  assert.match(panel.webview.html, /Your local profile/);
  assert.match(panel.webview.html, /data-field="profile-name"/);
  assert.match(panel.webview.html, /data-field="profile-role"/);
  assert.match(panel.webview.html, /approval records always use the Git identity/);
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

test('the Inbox is a first-class sidebar view and opens the generated-artifact catalog', async (t) => {
  if (!requireBundle(t)) return;
  const { registered } = await activated();
  const provider = section(registered, 'inbox');
  assert.ok(provider, 'the Inbox has a registered sidebar provider');
  const rows = provider.getChildren();
  assert.equal(rows[0].runCommand, 'singularityFlow.openInbox');
  assert.match(rows[0].description, /waiting.*generated/);

  await registered.commands.get('singularityFlow.openInbox')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.inboxPanel');
  assert.ok(panel, 'the business Inbox panel was created');
  assert.match(panel.webview.html, /SINGULARITY/);
  assert.match(panel.webview.html, /Everything generated/);
  assert.match(panel.webview.html, /Generated artifacts/);
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|unsafe-eval/);
});

test('the Stories panel opens and offers the push once a plan exists', async (t) => {
  if (!requireBundle(t)) return;
  const { registered } = await activated();
  await registered.commands.get('singularityFlow.openStories')();

  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.stories');
  assert.ok(panel, 'a stories panel was created');
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|unsafe-eval/);

  // The demo Epic has a two-repository plan with a real dependency.
  assert.match(panel.webview.html, /SFLOW-DEMO-API|API-1|STORY-001|Stories/);
  assert.match(panel.webview.html, /Push these Stories|Merge order|repository/);
});

test('the impact panel supports workspace advisory analysis and governed plan reconciliation', async (t) => {
  if (!requireBundle(t)) return;
  const { registered } = await activated();
  await registered.commands.get('singularityFlow.openImpact')();

  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.impact');
  assert.ok(panel, 'an impact panel was created');
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|unsafe-eval/);
  assert.match(panel.webview.html, /Impact analysis/);
  assert.match(panel.webview.html, /No Work ID or branch required|Select a workspace to analyze/);
  // It renders synchronously before the subprocess answers, rather than showing a blank page.
  assert.match(panel.webview.html, /Computing impact|Reconciliation|Nothing governed/);
});

test('the Flow Impact panel exposes governed measurement and aggregate reporting', async (t) => {
  if (!requireBundle(t)) return;
  const { registered } = await activated();
  await registered.commands.get('singularityFlow.openFlowImpact')();

  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.flowImpact');
  assert.ok(panel, 'a dedicated Flow Impact panel was created');
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|unsafe-eval/);
  assert.match(panel.webview.html, /Flow Impact/);
  assert.match(panel.webview.html, /Story measurement/);
  assert.match(panel.webview.html, /Study reports/);
  assert.match(panel.webview.html, /Configuration/);
});

test('the capability editor delegates creation to the mapping form that accepts a Git URL', async (t) => {
  if (!requireBundle(t)) return;
  // The designer runs in an application checkout, but the map's authority is the lead repository's
  // sflow/config branch. Prove the complete reviewed path and, critically, prove that the Story or
  // Initiative checkout was not used as a convenient back door around that authority.
  const root = await demoRepository();
  const capabilitiesFile = path.join(root, 'singularity/capabilities.yml');
  const before = await readFile(capabilitiesFile, 'utf8');
  const remote = path.join(path.dirname(root), 'organisation.git');
  await mkdir(remote);
  run('git', ['init', '-b', 'main', '--bare', remote], { cwd: path.dirname(root) });
  run('git', ['push', '-q', remote, 'main:refs/heads/sflow/config'], { cwd: root });
  const registry = path.join(path.dirname(root), 'leads.json');
  await writeFile(registry, JSON.stringify(
    { schemaVersion: 1, leads: [{ url: remote, usedAt: '2026-01-01T00:00:00.000Z' }] }));
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry;
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  await registered.commands.get('singularityFlow.openCapabilities')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.capabilities');
  assert.ok(panel, 'a capabilities panel was created');
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|unsafe-eval/);
  assert.match(panel.webview.html, /Capability portfolio/);
  assert.match(panel.webview.html, /Organisation at a glance/);
  assert.ok(panel.webview.html.indexOf('Capability portfolio') < panel.webview.html.indexOf('data-select="enterprise"'),
    'the capability dashboard is above the map');
  // A fresh repository is seeded with a root and a product beneath it.
  assert.match(panel.webview.html, /data-select="enterprise"/);
  assert.match(panel.webview.html, /data-select="product"/);

  await panel.post({ type: 'add', parent: 'product' });
  const mapping = await until(() => registered.panels.find((entry) =>
    entry.id === 'singularityFlow.mapCapability') ?? null);
  assert.ok(mapping, 'adding opens the governed capability mapping form');
  assert.match(mapping.webview.html, /Repository it ships from/);
  assert.match(mapping.webview.html, /choose Delivery above; the Git clone URL field will appear here/,
    'a Collection explains how to expose repository entry instead of silently hiding it');
  await mapping.post({ type: 'field', field: 'kind', value: 'delivery' });
  await mapping.post({ type: 'redraw' });
  assert.match(mapping.webview.html, /Clone URL/,
    'the creation path has an explicit place for a new Git repository URL');
  assert.doesNotMatch(panel.webview.html, /New capability/,
    'the editor no longer exposes the duplicate repository-ID-only creation form');
  assert.equal(await readFile(capabilitiesFile, 'utf8'), before,
    'opening the mapping flow did not edit the application checkout');
});

test('the capability screen shows the policy that applies, not only the policy that was written', async (t) => {
  if (!requireBundle(t)) return;
  // Inheritance is monotonic and silent: a capability asking for one approval beneath a parent
  // demanding two is held to two, and the file gives no hint of it.
  const { root, registered } = await activated();
  await writeFile(path.join(root, 'singularity/capabilities.yml'), [
    'version: 1',
    'capabilities:',
    '  enterprise:',
    '    name: Enterprise',
    '    kind: collection',
    '    parent: null',
    '    policy: { gateSeverity: block, approvalMinimum: 2, protectedPaths: [singularity/workflow.yml] }',
    '  checkout:',
    '    name: Checkout',
    '    kind: collection',
    '    parent: enterprise',
    '    policy: { approvalMinimum: 1, protectedPaths: [src/checkout/**] }',
    ''
  ].join('\n'));

  await registered.commands.get('singularityFlow.refresh')();
  await registered.commands.get('singularityFlow.openCapabilities')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.capabilities');
  await panel.post({ type: 'select', id: 'checkout' });

  assert.match(panel.webview.html, /overridden by an ancestor and will not apply as written/);
  assert.match(panel.webview.html, /<td class="muted">1<\/td>\s*<td><strong>2<\/strong><\/td>/);
  assert.match(panel.webview.html, /the largest demanded by any ancestor/);
  // The union of protected paths, which is also not what this capability wrote.
  assert.match(panel.webview.html, /singularity\/workflow\.yml, src\/checkout\/\*\*/);
  // Severity was never declared here, so inheriting it is not an override.
  assert.match(panel.webview.html, /Gate severity/);
});


/**
 * A lead repository holding a real capability map, plus the repositories it refers to.
 *
 * Built as bare remotes with actual commits, because the whole point of this flow is that nothing is
 * checked out: the map and the portfolio are read over the wire from a repository nobody has cloned.
 */
async function organisation() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-org-'));
  const bare = async (name, branch = 'main') => {
    const dir = path.join(base, name);
    await mkdir(dir);
    run('git', ['init', '-b', branch, '--bare', dir], { cwd: base });
    const seed = path.join(base, `${name}-seed`);
    await mkdir(seed);
    run('git', ['init', '-b', branch, seed], { cwd: base });
    await writeFile(path.join(seed, 'README.md'), `# ${name}\n`);
    run('git', ['add', '-A'], { cwd: seed });
    run('git', ['-c', 'user.email=org@example.com', '-c', 'user.name=Org',
      'commit', '-qm', 'Initial'], { cwd: seed });
    run('git', ['push', '-q', dir, `${branch}:${branch}`], { cwd: seed });
    return { dir, seed };
  };

  const api = await bare('api.git');
  const web = await bare('web.git', 'trunk');
  const lead = await bare('platform.git');

  await mkdir(path.join(lead.seed, 'singularity'), { recursive: true });
  await writeFile(path.join(lead.seed, 'singularity/capabilities.yml'), [
    'version: 1',
    'capabilities:',
    '  commerce: { name: Commerce, kind: collection, parent: null }',
    '  payments: { name: Payments, kind: collection, parent: commerce }',
    '  payments-api: { name: Payments API, kind: delivery, parent: payments, repository: api }',
    '  storefront: { name: Storefront, kind: collection, parent: commerce }',
    '  storefront-web: { name: Storefront Web, kind: delivery, parent: storefront, repository: web }',
    ''
  ].join('\n'));
  await writeFile(path.join(lead.seed, 'singularity/portfolio.yml'), [
    'version: 1',
    'repositories:',
    `  api: { url: "${api.dir}", defaultBranch: main }`,
    `  web: { url: "${web.dir}", defaultBranch: trunk }`,
    ''
  ].join('\n'));
  run('git', ['add', '-A'], { cwd: lead.seed });
  run('git', ['-c', 'user.email=org@example.com', '-c', 'user.name=Org',
    'commit', '-qm', 'Capability map'], { cwd: lead.seed });
  run('git', ['push', '-q', lead.dir, 'main:main'], { cwd: lead.seed });
  run('git', ['push', '-q', lead.dir, 'HEAD:sflow/config'], { cwd: lead.seed });

  // Remembered the way `capability map` remembers it: the workspace form offers the organisations
  // already mapped rather than asking for a URL, so a fixture that is not in the registry is an
  // organisation nobody has mapped.
  const registry = path.join(base, 'leads.json');
  await writeFile(registry, JSON.stringify(
    { schemaVersion: 1, leads: [{ url: lead.dir, usedAt: '2026-01-01T00:00:00.000Z' }] }));
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry;

  return { base, lead: lead.dir, api: api.dir, web: web.dir, registry };
}

test('a workspace is chosen as capabilities, and its repositories follow', async (t) => {
  if (!requireBundle(t)) return;
  // A workspace is capabilities plus a working directory. The repositories are not the thing being
  // chosen — they are what the chosen capabilities ship from, and the map that says so is read from
  // an organisation already mapped, so the form opens with the tree rather than with a URL field.
  const org = await organisation();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());
  await registered.commands.get('singularityFlow.createWorkspace')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.workspace');
  assert.ok(panel, 'a workspace panel was created');

  const read = await until(() => (panel.webview.html.includes('Commerce') ? panel.webview.html : null));

  // The whole tree came back from a repository nobody cloned, and is offered as a dropdown with
  // the hierarchy kept in the option labels. Nothing was typed to get it.
  assert.match(read, /data-capability-pick/);
  assert.match(read, /<option value="commerce"/);
  assert.match(read, /<option value="payments-api"/);
  assert.match(read, /<option value="storefront-web"/);
  assert.equal(registered.inputBoxes.length, 0, 'nothing was asked through a prompt');
  assert.doesNotMatch(read, /Add a repository/, 'repositories are never named by hand');
  assert.doesNotMatch(read, /data-draft="lead"/, 'no lead-repository URL field');
  // One organisation is stated rather than asked about.
  assert.doesNotMatch(read, /<select data-field="organisation">/);
  // Nothing is chosen yet, so it says what is outstanding rather than offering a dead button.
  assert.match(read, /Choose the capabilities this workspace is for/);

  // Choosing a grouping takes everything beneath it, and the repositories appear.
  await panel.post({ type: 'capability', id: 'payments', selected: true });
  assert.match(panel.webview.html, /data-capability-remove="payments"/);
  assert.match(panel.webview.html, /1 beneath it/, 'the pick says what it dragged in');
  // What is already covered stops being offered: picking a child of a chosen parent adds nothing.
  const include = panel.webview.html.slice(
    panel.webview.html.indexOf('data-capability-pick'), panel.webview.html.indexOf('</select>'));
  assert.doesNotMatch(include, /<option value="payments-api"/);
  assert.doesNotMatch(include, /<option value="payments"/);
  assert.match(panel.webview.html, new RegExp(escapeRegExp(org.api)));
  assert.doesNotMatch(panel.webview.html, new RegExp(escapeRegExp(org.web)),
    'storefront was not chosen, so its repository is not cloned');

  // One shipping capability, so the lead is settled without being asked, and the state branch is
  // stated as the consequence it is.
  assert.match(panel.webview.html, /Lead capability/);
  assert.match(panel.webview.html, /<option value="payments-api" selected>/);
  assert.doesNotMatch(panel.webview.html, /data-draft="state-branch"/);
  assert.match(panel.webview.html, /orphan\s+<code>state<\/code> branch is created\s+in <code>api<\/code> and pushed/);

  registered.pickedFolder = org.base;
  await panel.post({ type: 'choose', what: 'base' });
  await panel.post({ type: 'field', field: 'id', value: 'commerce-platform' });
  await panel.post({ type: 'field', field: 'profile-name', value: 'Casey Contributor' });
  await panel.post({ type: 'field', field: 'profile-role', value: 'developer' });
  await settle();
  assert.match(panel.webview.html, /1 repository will be cloned/, 'what payments ships, and only that');
  assert.match(panel.webview.html, /led by <code>Payments API<\/code>/);
  assert.match(panel.webview.html, /<button data-submit="create" >/, 'nothing outstanding');
});

test('when several capabilities ship, one of them is named the lead', async (t) => {
  if (!requireBundle(t)) return;
  // The lead is the workspace's centre of gravity: its repository is where the orphan state branch
  // is created. With more than one candidate it is a choice, and it is offered as one.
  const org = await organisation();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());
  await registered.commands.get('singularityFlow.createWorkspace')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.workspace');
  await until(() => (panel.webview.html.includes('Commerce') ? panel.webview.html : null));

  await panel.post({ type: 'capability', id: 'commerce', selected: true });
  const html = panel.webview.html;
  assert.match(html, /<option value="payments-api"[^>]*>Payments API \(api\)/);
  assert.match(html, /<option value="storefront-web"[^>]*>Storefront Web \(web\)/);
  // Defaulted rather than demanded, so the form is never blocked on it.
  assert.match(html, /<option value="payments-api" selected>/);
  assert.match(html, /in <code>api<\/code>/);

  await panel.post({ type: 'field', field: 'lead-capability', value: 'storefront-web' });
  assert.match(panel.webview.html, /<option value="storefront-web" selected>/);
  assert.match(panel.webview.html, /in <code>web<\/code>/);

  // A grouping cannot lead: leading means carrying the state branch, and it has no repository.
  await panel.post({ type: 'field', field: 'lead-capability', value: 'commerce' });
  assert.match(panel.webview.html, /<option value="storefront-web" selected>/, 'the pick stood');
});

/** Paths contain regex metacharacters; matching one literally has to say so. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('an organisation that has not described what it builds says so, and where to fix it', async (t) => {
  if (!requireBundle(t)) return;
  // A new organisation has no map yet. That is a state, not a failure — but a workspace over
  // capabilities nobody has mapped is a step out of order, so the form says which step and offers
  // it, rather than falling back to naming repositories by hand.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-ws-nomap-'));
  const origin = path.join(base, 'payments-api.git');
  await mkdir(origin);
  run('git', ['init', '-b', 'trunk', '--bare', origin], { cwd: base });
  const seed = path.join(base, 'seed');
  await mkdir(seed);
  run('git', ['init', '-b', 'trunk', seed], { cwd: base });
  run('git', ['-c', 'user.email=seed@example.com', '-c', 'user.name=Seed',
    'commit', '-q', '--allow-empty', '-m', 'Initial'], { cwd: seed });
  run('git', ['push', '-q', origin, 'trunk:trunk'], { cwd: seed });
  const registry = path.join(base, 'leads.json');
  await writeFile(registry, JSON.stringify(
    { schemaVersion: 1, leads: [{ url: origin, usedAt: '2026-01-01T00:00:00.000Z' }] }));
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry;

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());
  await registered.commands.get('singularityFlow.createWorkspace')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.workspace');

  const html = await until(() =>
    (panel.webview.html.includes('Create first capability')
      ? panel.webview.html : null));

  assert.match(html, /This organisation does not describe what it builds yet/);
  assert.match(html, /Create first capability/);
  assert.match(html, /data-open="capabilities"/);
  assert.doesNotMatch(html, /Add a repository/, 'no by-URL fallback to walk into');
  assert.equal(registered.inputBoxes.length, 0, 'nothing was asked through a prompt');
  assert.equal(registered.warnings.length, 0, 'reported on the form rather than over it');
  assert.match(html, /<button data-submit="create" disabled>/);

  // The form fixes its own blocker instead of sending the user to hunt through Configuration.
  await panel.post({ type: 'field', field: 'id', value: 'rules-workspace' });
  await panel.post({ type: 'open', what: 'capabilities' });
  const capabilityPanel = await until(() =>
    registered.panels.find((entry) => entry.id === 'singularityFlow.mapCapability'));
  await until(() => (capabilityPanel.webview.html.includes('0 capabilities available as parents')
    ? capabilityPanel.webview.html : null));
  await capabilityPanel.post({ type: 'field', field: 'capabilityId', value: 'payments-api' });
  await capabilityPanel.post({ type: 'field', field: 'name', value: 'Payments API' });
  await capabilityPanel.post({ type: 'field', field: 'kind', value: 'delivery' });
  await capabilityPanel.post({ type: 'field', field: 'repositoryUrl', value: origin });
  await capabilityPanel.post({ type: 'map' });

  // Mapping is a review proposal: the retained workspace form must not see it until the proposal
  // reaches the remote's approved configuration branch through normal review controls.
  await until(() => run('git', ['for-each-ref', '--format=%(refname:short)',
    'refs/heads/sflow/config-change/capability/map-payments-api-*'], { cwd: origin }).stdout.trim() || null,
  { attempts: 200 });
  mergeCapabilityProposal(origin, 'map-payments-api');
  await registered.commands.get('singularityFlow.createWorkspace')();

  const refreshed = await until(() =>
    (panel.webview.html.includes('<option value="payments-api"') ? panel.webview.html : null),
  { attempts: 200 });
  assert.match(refreshed, /value="rules-workspace"/, 'the workspace draft survived capability setup');
  assert.match(refreshed, /Payments API/, 'the reviewed capability is selectable after refreshing the form');
});

test('with no organisation mapped at all, the form offers the screen that maps one', async (t) => {
  if (!requireBundle(t)) return;
  // The chicken-and-egg case, answered rather than hit.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-ws-empty-'));
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(base, 'leads.json');

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());
  await registered.commands.get('singularityFlow.createWorkspace')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.workspace');
  const html = await until(() =>
    (panel.webview.html.includes('No organisation has been mapped') ? panel.webview.html : null));
  assert.match(html, /data-open="capabilities"/);

  // And the button leads somewhere: it opens the screen that maps one.
  await panel.post({ type: 'open', what: 'capabilities' });
  await until(() => registered.panels.find((entry) => entry.id === 'singularityFlow.mapCapability'));
});

test('creating a workspace asks nothing through a prompt', async (t) => {
  if (!requireBundle(t)) return;
  // The state branch used to be an input box that opened after the panel had closed. Everything the
  // form needs is now on the form — and the state branch is not asked at all, because it is what
  // initialising a workspace does rather than a decision anybody makes.
  const org = await organisation();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());
  await registered.commands.get('singularityFlow.createWorkspace')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.workspace');
  await until(() => (panel.webview.html.includes('Commerce') ? panel.webview.html : null));

  assert.doesNotMatch(panel.webview.html, /data-draft="state-branch"/);

  registered.pickedFolder = org.base;
  await panel.post({ type: 'choose', what: 'base' });
  await panel.post({ type: 'field', field: 'id', value: 'commerce-platform' });
  await panel.post({ type: 'field', field: 'profile-name', value: 'Casey Contributor' });
  await panel.post({ type: 'field', field: 'profile-role', value: 'developer' });
  await panel.post({ type: 'capability', id: 'payments', selected: true });
  await settle();
  assert.match(panel.webview.html, /<button data-submit="create" >/);
  assert.match(panel.webview.html, /orphan\s+<code>state<\/code> branch is created\s+in <code>api<\/code> and pushed/);

  // Not one input box, from opening the panel to being ready to create.
  assert.equal(registered.inputBoxes.length, 0,
    `asked ${registered.inputBoxes.length} prompts: ${registered.inputBoxes.map((box) => box.title).join(', ')}`);
});

test('a workspace can be renamed and copied from the editor, and never onto another', async (t) => {
  if (!requireBundle(t)) return;
  // A workspace is local and disposable: renaming and copying one are ordinary. What is not
  // ordinary is two of them in one directory, so the copy is refused before the command runs.
  const org = await organisation();
  const registry = path.join(org.base, 'registry.json');
  const workspaces = path.join(org.base, 'workspaces');
  const cli = (args) => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry }
    });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    return result.stdout;
  };
  cli(['workspace', 'create', '--local', '--json', '--id', 'commerce', '--base', workspaces,
    '--lead', 'platform', '--repository', `platform=${org.lead}`,
    '--capability', 'payments', '--confirm', 'commerce', '--no-clone']);

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  // The panel reads the machine-wide registry, so the test's own has to be the one it finds.
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registry;
  const extension = loadExtension(api);
  await extension.activate(context());
  await registered.commands.get('singularityFlow.openWorkspaces')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.workspaces');
  assert.ok(panel, 'a workspaces panel was created');
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.match(panel.webview.html, /commerce/);

  const workspaceRoot = path.join(await realpath(workspaces), 'commerce');
  await panel.post({ type: 'select', path: workspaceRoot });
  assert.match(panel.webview.html, /Copy this workspace/);

  // Copying onto a directory that is already a workspace is refused without running anything.
  await panel.post({ type: 'duplicate', path: workspaceRoot, id: 'commerce', base: '' });
  await settle();
  assert.match(panel.webview.html, /No two workspaces may share a working directory/);

  // A free directory works, and the copy carries what the workspace is for.
  await panel.post({ type: 'duplicate', path: workspaceRoot, id: 'commerce-spike', base: '' });
  const copied = path.join(await realpath(workspaces), 'commerce-spike');
  await until(() => (existsSync(path.join(copied, 'workspace.json')) ? true : null));
  const manifest = JSON.parse(readFileSync(path.join(copied, 'workspace.json'), 'utf8'));
  assert.deepEqual(manifest.capabilities, ['payments'], 'what it is for came with it');
  assert.equal(manifest.leadRepository, 'platform');
  // Both are listed, on their own directories.
  await until(() => (panel.webview.html.includes('commerce-spike') ? true : null));
  assert.doesNotMatch(panel.webview.html, /shared directory/);

  // Editing is explicit and keeps all current capabilities while changing the local label.
  await panel.post({ type: 'edit', path: workspaceRoot });
  assert.match(panel.webview.html, /data-field="edit-name"/);
  assert.match(panel.webview.html, /data-edit-remove="payments"/);
  await panel.post({ type: 'edit-draft', field: 'edit-name', value: 'Commerce platform' });
  await panel.post({ type: 'edit-save', path: workspaceRoot });
  await until(() => (panel.webview.html.includes('Commerce platform') ? true : null));
  assert.match(readFileSync(path.join(workspaceRoot, 'workspace.json'), 'utf8'), /Commerce platform/);
  assert.equal(registered.inputBoxes.length, 0, 'nothing was asked through a prompt');
});

/** Every command package.json contributes. The palette offers all of them, always. */
function contributedCommands() {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'apps/vscode/package.json'), 'utf8'));
  return manifest.contributes.commands.map((command) => command.command);
}

test('every contributed command exists, whatever state the window is in', async (t) => {
  if (!requireBundle(t)) return;
  // They were registered after activation had decided it had a repository, so in a window without
  // one the palette advertised thirteen commands that did not exist and running one reported
  // "command not found" — which describes the extension's internals and nothing about the folder.
  const states = [
    ['no folder open', undefined],
    ['a folder that is not a Flow repository', [{ uri: { fsPath: await mkdtemp(path.join(os.tmpdir(), 'sflow-plain-')) } }]]
  ];

  for (const [label, folders] of states) {
    const { api, registered } = stubVscode();
    api.workspace.workspaceFolders = folders;
    const extension = loadExtension(api);
    await extension.activate(context());

    const missing = contributedCommands().filter((id) => !registered.commands.has(id));
    assert.deepEqual(missing, [], `${label}: ${missing.join(', ')} would report "command not found"`);

    // And running one says why — in exactly the words the view is showing, so a command and the
    // tree can never disagree about what is wrong with the folder.
    const provider = section(registered, 'lifecycle');
    const [explanation] = provider.getChildren();
    const detail = explanation.tooltip;
    assert.ok(detail, `${label}: the tree explains itself`);

    await registered.commands.get('singularityFlow.openCapabilities')();
    assert.equal(registered.panels.length, 0, `${label}: nothing was opened`);
    assert.equal(registered.warnings.at(-1), `Singularity Flow: ${detail}`);
  }
});

test('with a repository, every contributed command actually does something', async (t) => {
  if (!requireBundle(t)) return;
  // The other half: a command registered but never given a handler would be silently inert, which
  // is the same defect wearing a different face.
  const { registered } = await activated();
  const missing = contributedCommands().filter((id) => !registered.commands.has(id));
  assert.deepEqual(missing, []);

  await registered.commands.get('singularityFlow.openCapabilities')();
  assert.ok(registered.panels.find((entry) => entry.id === 'singularityFlow.capabilities'),
    'openCapabilities opened its panel rather than warning');
  assert.doesNotMatch(registered.warnings.join(' '), /Open the repository that contains/);
});

/** Every view package.json contributes, in the order the sidebar will show them. */
function contributedViews() {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'apps/vscode/package.json'), 'utf8'));
  return manifest.contributes.views.singularityFlowNavigator.map((view) => view.id);
}

test('every contributed view has a provider, whatever state the window is in', async (t) => {
  if (!requireBundle(t)) return;
  // A contributed view with no provider is what makes VS Code report that no data provider is
  // registered — a sentence about the extension's internals rather than about the folder. It was
  // fixed for the lifecycle view; adding two more views is exactly how that regresses.
  for (const folders of [undefined, [{ uri: { fsPath: await mkdtemp(path.join(os.tmpdir(), 'sflow-plain-')) } }]]) {
    const { api, registered } = stubVscode();
    api.workspace.workspaceFolders = folders;
    const extension = loadExtension(api);
    await extension.activate(context());

    const missing = contributedViews().filter((id) =>
      !registered.trees.has(id) && !registered.webviewViews.has(id));
    assert.deepEqual(missing, [], `${missing.join(', ')} would report "no data provider registered"`);

    // Workspaces contains only real saved workspaces. Repository configuration is not represented
    // as a second, differently-shaped pseudo-workspace.
    const workspace = section(registered, 'workspaces');
    assert.equal(workspace.getChildren().some((node) => node.id === 'workspace:scope'), false);
  }
});

test('Configuration opens the capability editor and creates new capabilities', async (t) => {
  if (!requireBundle(t)) return;
  const { root, registered } = await activated();
  await writeFile(path.join(root, 'singularity/capabilities.yml'), [
    'version: 1',
    'capabilities:',
    '  commerce: { name: Commerce, kind: collection, parent: null }',
    '  payments: { name: Payments, kind: collection, parent: commerce }',
    '  payments-api: { name: Payments API, kind: delivery, parent: payments, repository: api }',
    ''
  ].join('\n'));
  await registered.commands.get('singularityFlow.refresh')();

  // Configuration is one entry now, and it leads to the Center, which is where capabilities live.
  const configuration = section(registered, 'configuration');
  const [entry, ...rest] = configuration.getChildren();
  assert.equal(entry.id, 'configuration:center');
  assert.equal(rest.length, 0, 'the Configuration section is a single entry');
  assert.equal(configuration.getTreeItem(entry).command.command, 'singularityFlow.openConfigurationCenter');

  await registered.commands.get('singularityFlow.openConfigurationCenter')();
  const center = registered.panels.find((item) => item.id === 'singularityFlow.configurationCenter');
  assert.ok(center, 'the Configuration Center opens');
  assert.match(center.webview.html, /data-action="capabilities"/);

  // The overview is an index, not a wall of competing creation shortcuts. Follow its real message
  // path into the capability editor, where the context-aware Add action belongs.
  assert.doesNotMatch(center.webview.html, /data-action="add-capability"/);
  await center.post({ type: 'action', action: 'capabilities' });
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.capabilities');
  assert.ok(panel, 'the capability editor is reachable from Configuration navigation');
  assert.match(panel.webview.html, /Commerce/);
  assert.match(panel.webview.html, /Payments API/);
  assert.match(panel.webview.html, /data-add=/, 'the capability editor owns its Add capability action');
});

test('Configuration bootstraps the first capability instead of opening an unusable editor', async (t) => {
  if (!requireBundle(t)) return;
  const { root, registered } = await activated();
  await writeFile(path.join(root, 'singularity/capabilities.yml'), [
    'version: 1',
    'capabilities: {}',
    ''
  ].join('\n'));
  await registered.commands.get('singularityFlow.refresh')();

  // With the Configuration tree collapsed to one entry, the bootstrap decision lives only in the
  // command — which is where it always had to be correct anyway, since the Command Palette and the
  // Center's card both reach it without a tree node to pre-decide for them.
  await registered.commands.get('singularityFlow.addCapability')();
  assert.ok(registered.panels.find((entry) => entry.id === 'singularityFlow.mapCapability'),
    'the first capability opens the bootstrap panel that can establish an organisation lead');
  assert.equal(registered.panels.some((entry) => entry.id === 'singularityFlow.capabilities'), false,
    'the editor that requires an existing lead was not opened');
});

test('the sidebar lists workspaces even with no repository open', async (t) => {
  if (!requireBundle(t)) return;
  // The registry is machine-wide, which is exactly why this is useful in a window that has nothing
  // open yet — it is how a person finds the workspace they already have.
  const org = await organisation();
  const registryFile = path.join(org.base, 'registry.json');
  spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'workspace', 'create', '--local', '--json', '--id', 'commerce',
    '--base', path.join(org.base, 'workspaces'), '--lead', 'platform',
    '--repository', `platform=${org.lead}`, '--confirm', 'commerce', '--no-clone'], {
    encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registryFile }
  });

  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  const provider = section(registered, 'workspaces');
  const rows = await until(() => {
    const nodes = provider.getChildren();
    return nodes[0]?.label === 'commerce' ? nodes : null;
  });
  assert.equal(rows[0].label, 'commerce');
  assert.match(rows[0].tooltip, /workspaces\/commerce/);
  assert.equal(provider.getTreeItem(rows[0]).contextValue, 'sflow.workspace');
  // Its lead repository is what opening it means.
  assert.match(rows[0].openPath, /workspaces\/commerce\/repos\/platform/);
});

test('the lifecycle analytics dashboard opens and reports the repository it is actually in', async (t) => {
  if (!requireBundle(t)) return;
  // Everything on it was already available from doctor, inbox, initiative status and the agent
  // lock — four commands whose answers a person had to hold in their head at once.
  const { registered } = await activated();
  await registered.commands.get('singularityFlow.openDashboard')();

  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.dashboard');
  assert.ok(panel, 'a lifecycle analytics panel was created');
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|unsafe-eval/);
  assert.match(panel.webview.html, /Lifecycle analytics/);
  // Real diagnostics from a real subprocess, not a fixture.
  assert.match(panel.webview.html, /diagnostics pass|Would stop governed work/);
  assert.match(panel.webview.html, /Approvals/);
  assert.match(panel.webview.html, /Governance/);
  assert.match(panel.webview.html, /Start or attach a Story to see phase progress/);
});

test('the designer opens, reads the real lifecycle, and creates a template through the engine', async (t) => {
  if (!requireBundle(t)) return;
  // The value it adds over the YAML is knowing who is standing on a file. The value it must not
  // lose is that a template is governed configuration: writing one goes through the engine, which
  // validates before it writes, rather than the editor writing the file itself.
  const { root, registered } = await activated();
  await registered.commands.get('singularityFlow.openDesigner')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.designer');
  assert.ok(panel, 'a designer panel was created');
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|unsafe-eval/);

  // Real phases from this repository's own portfolio.
  assert.match(panel.webview.html, /Workflow designer/);
  assert.match(panel.webview.html, /data-profile-pick/);
  assert.match(panel.webview.html, /Intake|Discover/);

  await panel.post({ type: 'tab', tab: 'templates' });
  assert.match(panel.webview.html, /Artifact template designer/);
  assert.match(panel.webview.html, /Live document preview/);
  assert.match(panel.webview.html, /data-template-filter/);

  const artifact = {
    type: 'save-artifact', phase: 'initiative:discover-define', outputId: 'release-checklist',
    outputLabel: 'Release checklist', outputPath: 'release-checklist.md',
    fileName: 'initiatives/release-checklist.md', title: 'Release checklist',
    purpose: 'Confirm release scope and evidence.', required: true,
    sections: [
      { kind: 'checklist', title: 'Completion checklist', guidance: 'Name the exact evidence.' },
      { kind: 'evidence', title: 'Evidence', guidance: 'Use the approved phase inputs.' }
    ]
  };
  // A path the designer refuses never reaches configuration save.
  await panel.post({ ...artifact, fileName: '../escape.md' });
  await settle();
  assert.match(panel.webview.html, /safe \.md path/);
  assert.equal(existsSync(path.join(root, 'singularity/templates/initiatives/escape.md')), false);

  await panel.post(artifact);
  // Written beside the templates a profile already points at, not beside whichever file happened to
  // be first — this repository's templates root holds work-item templates too, and an initiative
  // artifact written among those is a file nothing can ever reference.
  const created = path.join(root, 'singularity/templates/initiatives/release-checklist.md');
  await until(() => (existsSync(created) ? true : null));
  const text = readFileSync(created, 'utf8');
  // Written in the shape every other artifact template follows, so it is usable immediately.
  assert.match(text, /singularity-flow:initiative-metadata/);
  assert.match(text, /\{\{initiative\.id\}\} — Release checklist/);
  assert.match(text, /## Completion checklist/);
  assert.match(text, /\{\{inputs\}\}/);
  assert.equal(registered.inputBoxes.length, 0, 'nothing was asked through a prompt');
});

test('the instruction designer exposes all four libraries and saves repository prompts through the engine', async (t) => {
  if (!requireBundle(t)) return;
  const { root, registered } = await activated();
  await registered.commands.get('singularityFlow.openInstructionDesigner')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.instructionDesigner');
  assert.ok(panel, 'the instruction designer panel was created');
  assert.match(panel.webview.html, /Agents, prompts &amp; skills/);
  assert.match(panel.webview.html, /Prompt packs/);
  assert.match(panel.webview.html, /Prompt composition/);
  assert.match(panel.webview.html, /default-src 'none'/);

  await panel.post({ type: 'tab', tab: 'prompts' });
  assert.match(panel.webview.html, /Repository library/);
  await panel.post({ type: 'new' });
  await panel.post({ type: 'save-prompt', id: 'demo-impact', body: '# Impact\n\nUse repository evidence.' });
  const created = path.join(root, 'singularity/prompts/demo-impact.md');
  await until(() => (existsSync(created) ? true : null));
  assert.equal(readFileSync(created, 'utf8'), '# Impact\n\nUse repository evidence.\n');

  await panel.post({ type: 'tab', tab: 'packs' });
  assert.match(panel.webview.html, /Packaged library/);
  assert.match(panel.webview.html, /Copy into repository/);
});

test('a window with nothing open keeps workspace setup out of Lifecycle', async (t) => {
  if (!requireBundle(t)) return;
  // Everything Singularity Flow does needs a repository, so a state that explains that and offers
  // nothing is a dead end — and it is the state a person is in the first time they open the editor.
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  const provider = section(registered, 'lifecycle');
  const [explanation] = provider.getChildren();
  const actions = [explanation].filter((row) => row.runCommand);
  assert.deepEqual(actions.map((row) => row.runCommand), ['singularityFlow.openWorkspaces'],
    'Lifecycle starts at intake; workspace selection stays outside it');
  for (const action of actions) assert.ok(registered.commands.has(action.runCommand));

  // Clicking a row runs its command rather than trying to open it as an artifact.
  const item = provider.getTreeItem(actions[0]);
  assert.equal(item.command.command, 'singularityFlow.openWorkspaces');

  // And a repository command names the ways forward rather than only what is wrong.
  await registered.commands.get('singularityFlow.openDesigner')();
  await settle();
  assert.match(registered.warnings.at(-1) ?? '', /Singularity Flow: /);
  assert.deepEqual(registered.warningActions.at(-1), ['Map a capability', 'Find a workspace']);
});

test('an ungoverned folder still directs Lifecycle to workspace selection', async (t) => {
  if (!requireBundle(t)) return;
  const plain = await mkdtemp(path.join(os.tmpdir(), 'sflow-plain-'));
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: plain } }];
  const extension = loadExtension(api);
  await extension.activate(context());

  const provider = section(registered, 'lifecycle');
  const rows = provider.getChildren();
  assert.deepEqual(rows.filter((row) => row.runCommand).map((row) => row.runCommand),
    ['singularityFlow.openWorkspaces']);
});

test('the first explicit workspace selection loads Lifecycle in the same window', async (t) => {
  if (!requireBundle(t)) return;
  // Choosing where you are working is not the same as opening code, and it used to be: selecting a
  // workspace reloaded the window or opened a folder, which threw away every open editor to change
  // one string. Somebody comparing two workspaces paid for the comparison twice.
  const org = await organisation();
  const registryFile = path.join(org.base, 'registry.json');
  const selectionFile = path.join(org.base, 'active-workspace.json');
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selectionFile;
  t.after(() => {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
  });
  spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'workspace', 'create', '--local', '--json', '--id', 'commerce',
    '--base', path.join(org.base, 'workspaces'), '--lead', 'platform',
    '--repository', `platform=${org.lead}`, '--confirm', 'commerce'], {
    encoding: 'utf8', env: process.env
  });

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const issued = [];
  const dispatch = api.commands.executeCommand;
  api.commands.executeCommand = async (command, ...args) => {
    issued.push(command);
    return dispatch(command, ...args);
  };
  const extension = loadExtension(api);
  await extension.activate(context());

  const provider = section(registered, 'workspaces');
  const rows = await until(() => {
    const nodes = provider.getChildren();
    return nodes[0]?.label === 'commerce' ? nodes : null;
  });
  const item = provider.getTreeItem(rows[0]);
  assert.equal(item.command.command, 'singularityFlow.switchWorkspace',
    'clicking an inactive workspace selects its governed scope');
  await registered.commands.get(item.command.command)(...item.command.arguments);

  assert.equal(issued.includes('vscode.openFolder'), false, 'no folder was opened');
  assert.equal(issued.includes('workbench.action.reloadWindow'), true,
    'the current window reloads once because activation originally had no repository services');
  assert.deepEqual(registered.errors, []);
  // And the choice took: the tree says which one is being worked in, and it is this one.
  const chosen = await until(() =>
    provider.getChildren().find((row) => row.description === 'working here') ?? null);
  assert.equal(chosen.label, 'commerce');

  // Diagnostics must follow that machine-wide choice too. This window deliberately has no open
  // folder—the exact state that used to stop here with "Open a repository first" even though every
  // other Singularity view had already resolved the selected workspace.
  await initializeDefinition(chosen.openPath);
  await registered.commands.get('singularityFlow.doctor')();
  const report = await until(() => registered.openedDocuments
    .find((document) => typeof document?.content === 'string'
      && document.content.includes('CAPABILITY AND STATE DIAGNOSTICS')) ?? null);
  assert.match(report.content, /CAPABILITY AND STATE DIAGNOSTICS/);
  assert.equal(registered.warnings.some((message) => /Open a repository first/i.test(message)), false);
});

test('the Copilot handoff switches this window to the governed repository before opening chat', async (t) => {
  if (!requireBundle(t)) return;
  const org = await organisation();
  const registryFile = path.join(org.base, 'registry.json');
  const selectionFile = path.join(org.base, 'active-workspace.json');
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selectionFile;
  t.after(() => {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
  });

  const created = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'workspace', 'create', '--local', '--json', '--id', 'commerce',
    '--base', path.join(org.base, 'workspaces'), '--lead', 'platform',
    '--repository', `platform=${org.lead}`, '--confirm', 'commerce'], {
    encoding: 'utf8', env: process.env
  });
  assert.equal(created.status, 0, created.stderr);
  const selected = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'workspace', 'use', 'commerce', '--json'], { encoding: 'utf8', env: process.env });
  assert.equal(selected.status, 0, selected.stderr);

  // Reproduce the reported case: Singularity Flow's own source happens to be open, while the
  // selected workspace points at a different governed repository.
  const unrelated = await mkdtemp(path.join(os.tmpdir(), 'sflow-unrelated-window-'));
  const values = new Map();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: unrelated } }];
  const extension = loadExtension(api);
  await extension.activate(context(values));
  await registered.commands.get('singularityFlow.openCopilot')();

  const open = registered.executedCommands.find((entry) => entry.id === 'vscode.openFolder');
  assert.ok(open, 'the same VS Code window is moved to the Story repository first');
  assert.equal(open.args[1], false, 'the handoff replaces this window instead of opening another one');
  const pending = values.get('singularityFlow.pendingCopilotHandoff');
  assert.equal(path.resolve(pending.repository), path.resolve(open.args[0].fsPath));
  assert.equal(registered.executedCommands.some((entry) => entry.id === 'workbench.action.chat.open'), false,
    'chat is not opened against the unrelated repository before the window reloads');
  assert.match(registered.infos.at(-1), /Switching this window to that repository/);
});

test('a command-palette action attaches Copilot to any saved workspace', async (t) => {
  if (!requireBundle(t)) return;
  const org = await organisation();
  const registryFile = path.join(org.base, 'registry.json');
  const selectionFile = path.join(org.base, 'active-workspace.json');
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selectionFile;
  t.after(() => {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
  });
  const created = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'workspace', 'create', '--local', '--json', '--id', 'commerce',
    '--base', path.join(org.base, 'workspaces'), '--lead', 'platform',
    '--repository', `platform=${org.lead}`, '--confirm', 'commerce'], {
    encoding: 'utf8', env: process.env
  });
  assert.equal(created.status, 0, created.stderr);

  const unrelated = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-session-window-'));
  const values = new Map();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: unrelated } }];
  const extension = loadExtension(api);
  await extension.activate(context(values));
  await registered.commands.get('singularityFlow.attachSessionToWorkspace')();

  const open = registered.executedCommands.find((entry) => entry.id === 'vscode.openFolder');
  assert.ok(open, 'the chosen workspace repository replaces the unrelated folder');
  assert.equal(open.args[1], false, 'attachment stays in the same VS Code window');
  const pending = values.get('singularityFlow.pendingCopilotHandoff');
  assert.equal(path.resolve(pending.repository), path.resolve(open.args[0].fsPath));
  assert.equal(pending.workspaceName, 'commerce');
  assert.equal(pending.workId, null);
  assert.match(registered.infos.at(-1), /commerce attached/);
});

test('a workspace-only handoff opens a fresh chat that asks for explicit Story selection', async (t) => {
  if (!requireBundle(t)) return;
  const root = await demoRepository();
  const isolated = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-only-handoff-'));
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = path.join(isolated, 'registry.json');
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = path.join(isolated, 'active.json');
  t.after(() => {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
  });
  const values = new Map([['singularityFlow.pendingCopilotHandoff', {
    repository: root, workId: null, workspaceName: 'Commerce', requestedAt: new Date().toISOString()
  }]]);
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context(values));

  const opened = registered.executedCommands.find((entry) => entry.id === 'workbench.action.chat.open');
  assert.ok(opened, 'the workspace handoff opens Copilot after the correct repository is active');
  assert.match(opened.args[0].query, /Workspace: Commerce/);
  assert.match(opened.args[0].query, /Working directory:/);
  assert.match(opened.args[0].query, /run \/sf-session/);
  assert.match(opened.args[0].query, /no governed Story is selected yet/);
  assert.equal(values.get('singularityFlow.pendingCopilotHandoff'), undefined);
});

test('a pending Copilot handoff resumes in a fresh chat after the repository window reloads', async (t) => {
  if (!requireBundle(t)) return;
  const root = await demoRepository();
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.git = { ...(workflow.git ?? {}), publish: 'off' };
  workflow.phases.intake.worldModel.depth = 'light';
  await writeFile(workflowFile, YAML.stringify(workflow));
  run('git', ['add', workflowFile], { cwd: root });
  run('git', ['commit', '-m', 'Use local publication for handoff test'], { cwd: root });
  const started = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'start', 'STORY-001', '--title', 'Checkout Story', '--description', 'Complete checkout',
    '--acceptance-criteria', 'Checkout succeeds', '--work-type', 'feature', '--agent', 'developer',
    '--base', 'INIT-CHECKOUT'], {
    cwd: root, encoding: 'utf8', env: process.env
  });
  assert.equal(started.status, 0, started.stderr);
  const grounded = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'wm', 'light', '--phase', 'intake'], { cwd: root, encoding: 'utf8', env: process.env });
  assert.equal(grounded.status, 0, grounded.stderr);
  const isolated = await mkdtemp(path.join(os.tmpdir(), 'sflow-copilot-resume-'));
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = path.join(isolated, 'registry.json');
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = path.join(isolated, 'active.json');
  t.after(() => {
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
  });
  const values = new Map([['singularityFlow.pendingCopilotHandoff', {
    repository: root, workId: 'STORY-001', requestedAt: new Date().toISOString()
  }]]);
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const extension = loadExtension(api);
  await extension.activate(context(values));

  const fresh = registered.executedCommands.find((entry) => entry.id === 'workbench.action.chat.newChat');
  const opened = registered.executedCommands.find((entry) => entry.id === 'workbench.action.chat.open');
  assert.deepEqual(registered.errors, [], 'prompt composition succeeds after the repository reload');
  assert.ok(fresh, 'an unrelated previous Copilot agent conversation is not reused');
  assert.ok(opened, 'the governed prompt opens after the owning repository is active');
  const canonicalRoot = await realpath(root);
  assert.ok(opened.args[0].query.includes(`Working directory: ${canonicalRoot}`));
  assert.match(opened.args[0].query, /Story: STORY-001/);
  assert.match(opened.args[0].query, /Do not inspect or modify another repository/);
  assert.equal(values.get('singularityFlow.pendingCopilotHandoff'), undefined,
    'the one-shot handoff cannot reopen chat on every later reload');
});

test('opening a workspace explicitly replaces the current window rather than scattering new ones', async (t) => {
  if (!requireBundle(t)) return;
  // "Open this workspace" is the separate, explicit act — go there and edit the code. It means what
  // VS Code's own Open Folder means. Forcing a new window every time left a person with windows
  // they did not ask for and had to close.
  const org = await organisation();
  const registryFile = path.join(org.base, 'registry.json');
  spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'workspace', 'create', '--local', '--json', '--id', 'commerce',
    '--base', path.join(org.base, 'workspaces'), '--lead', 'platform',
    '--repository', `platform=${org.lead}`, '--confirm', 'commerce', '--no-clone'], {
    encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registryFile }
  });
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const opened = [];
  api.commands.executeCommand = async (command, ...args) => { opened.push({ command, args }); };
  const extension = loadExtension(api);
  await extension.activate(context());

  const provider = section(registered, 'workspaces');
  const rows = await until(() => {
    const nodes = provider.getChildren();
    return nodes[0]?.label === 'commerce' ? nodes : null;
  });
  const item = provider.getTreeItem(rows[0]);
  assert.equal(item.collapsibleState, api.TreeItemCollapsibleState.None,
    'a workspace is a choice, not an expandable folder');
  assert.equal(item.command.command, 'singularityFlow.switchWorkspace',
    'clicking an inactive workspace selects it; opening code remains a separate action');
  await registered.commands.get('singularityFlow.openWorkspace')(rows[0]);

  const folder = opened.find((entry) => entry.command === 'vscode.openFolder');
  assert.ok(folder, 'a folder was opened');
  assert.equal(folder.args[1], false, 'the documented boolean signature reuses this window');
  // The lead repository, which is where everything the extension reads actually lives.
  assert.match(folder.args[0].fsPath, /workspaces\/commerce\/repos\/platform$/);
});

test('opening a workspace directory works: its lead repository is what gets governed', async (t) => {
  if (!requireBundle(t)) return;
  // Opening the workspace folder from a file manager is the obvious thing to do, and it is not a
  // repository — but it knows exactly where the one somebody wanted is, so it is simply used.
  const org = await organisation();
  const workspaces = path.join(org.base, 'workspaces');
  spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    // Cloned for real: a lead repository that is not on disk is not one this can govern, and
    // pretending otherwise would test the fixture rather than the resolution.
    'workspace', 'create', '--local', '--json', '--id', 'commerce', '--base', workspaces,
    '--lead', 'platform', '--repository', `platform=${org.lead}`,
    '--confirm', 'commerce'], {
    encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(org.base, 'r.json') }
  });

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: path.join(workspaces, 'commerce') } }];
  // The manifest is read through the editor's own file system, so the stub has to serve it.
  api.workspace.fs.readFile = async (uri) => readFileSync(uri.fsPath);
  const extension = loadExtension(api);
  await extension.activate(context());

  // Used, not described. Every screen operates on the workspace's lead repository, so opening the
  // workspace folder is a perfectly good way to work — the alternative was telling somebody the path
  // of a folder and asking them to go and open it themselves.
  const provider = section(registered, 'lifecycle');
  const [first] = provider.getChildren();
  assert.doesNotMatch(first.label, /not a repository/);
  assert.ok(registered.output.some((line) =>
    /Governed repository: .*commerce\/repos\/platform \(the lead repository of the workspace directory you have open\)/
      .test(String(line))), `the repository and where it came from are stated: ${registered.output.join(' | ')}`);
});

test('a window with nothing open can map a capability from scratch', async (t) => {
  if (!requireBundle(t)) return;
  // The product's one chicken-and-egg problem, in the worst possible place: to use the tool you
  // needed a governed repository, and to get one you needed the tool. This drives the whole way out
  // of it — empty window, a URL, a capability, a map the rest of the product can read. Nothing is
  // checked out: the lead is borrowed for the length of the edit and given back.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-boot-'));
  const bare = path.join(base, 'acme-platform.git');
  await mkdir(bare);
  run('git', ['init', '-q', '--bare', bare], { cwd: base });
  const seed = path.join(base, 'seed');
  await mkdir(seed);
  run('git', ['init', '-q', '-b', 'main', seed], { cwd: base });
  await writeFile(path.join(seed, 'README.md'), '# Acme\n');
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['-c', 'user.email=a@b.com', '-c', 'user.name=A B', 'commit', '-qm', 'Initial'], { cwd: seed });
  run('git', ['push', '-q', bare, 'main:main'], { cwd: seed });
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(base, 'leads.json');

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  // Mapping belongs to the Workspace toolbar, not the Lifecycle empty state.
  await registered.commands.get('singularityFlow.mapCapability')();
  const panel = registered.panels.find((entry) => entry.id === 'singularityFlow.mapCapability');
  assert.ok(panel, 'a map-a-capability panel was created');
  assert.match(panel.webview.html, /default-src 'none'/);
  // No folder to choose: mapping a capability checks nothing out, so there is nowhere to put it.
  assert.doesNotMatch(panel.webview.html, /data-choose="base"/);
  assert.doesNotMatch(panel.webview.html, /Workflow state branch/);
  // Kind is a closed structural choice, so it is a dropdown rather than free text.
  assert.match(panel.webview.html, /<select data-map="kind">/);
  assert.doesNotMatch(panel.webview.html, /Where the map lives|Read the map/,
    'repository selection is part of the capability form rather than a separate setup step');

  // With no registered map, the first shipping repository is the only possible candidate and is
  // selected in place. There is no second URL field or button to press.
  await panel.post({ type: 'field', field: 'kind', value: 'delivery' });
  await panel.post({ type: 'redraw' });
  await panel.post({ type: 'field', field: 'repositoryUrl', value: bare });
  await panel.post({ type: 'repositoryCommitted', value: bare });
  await until(() => (panel.webview.html.includes('0 capabilities available as parents')
    ? panel.webview.html : null));
  assert.match(panel.webview.html, /data-use-shipping-repository checked/,
    'the first shipping repository also holds the capability map by default');

  // Continue with a grouping capability to prove that changing kind does not forget the selected
  // map even though a Collection correctly clears the shipping property.
  await panel.post({ type: 'field', field: 'kind', value: 'collection' });
  await panel.post({ type: 'redraw' });

  await panel.post({ type: 'field', field: 'capabilityId', value: 'commerce' });
  await panel.post({ type: 'field', field: 'name', value: 'Commerce' });
  await panel.post({ type: 'field', field: 'kind', value: 'collection' });
  await panel.post({ type: 'map' });

  // The map reaches a review branch. Approved configuration remains untouched until normal review
  // controls merge that proposal into sflow/config.
  await until(() => run('git', ['for-each-ref', '--format=%(refname:short)',
    'refs/heads/sflow/config-change/capability/map-commerce-*'], { cwd: bare }).stdout.trim() || null,
  { attempts: 200 });
  const firstReview = mergeCapabilityProposal(bare, 'map-commerce-');
  assert.match(firstReview, /^sflow\/config-change\/capability\/map-commerce-/);

  // Once reviewed, the first capability governs the repository it was mapped into: the whole
  // singularity/ folder is there, which is the circular dependency this breaks.
  assert.ok(run('git', ['show', 'sflow/config:singularity/workflow.yml'], { cwd: bare }).stdout.includes('phases'));
  assert.match(run('git', ['show', 'sflow/config:singularity/workflow.yml'], { cwd: bare }).stdout,
    /branch: state/, 'the orphan branch is named, and made when a workspace is initialised');
  // A grouping ships from nothing, so it names no repository. Giving one to a capability that does
  // not have one is how a portfolio fills up with repositories nobody clones.
  assert.doesNotMatch(run('git', ['show', 'sflow/config:singularity/capabilities.yml'], { cwd: bare }).stdout,
    /repository:/);

  // A capability that ships names its repository, and that is what puts one in the portfolio. The
  // panel closes on a successful map, so this is a second visit to the screen — which is also the
  // real shape of mapping an organisation: one capability at a time.
  await registered.commands.get('singularityFlow.mapCapability')();
  const second = registered.panels.filter((entry) => entry.id === 'singularityFlow.mapCapability').at(-1);
  assert.notEqual(second, panel, 'the screen reopened rather than reusing a disposed panel');
  assert.match(second.webview.html, /Selected automatically because it is the only available capability map/,
    'the only known map repository is selected without another prompt');
  // The capability just mapped is offered as a parent, which is how a tree gets built at all.
  const reloaded = await until(() =>
    (second.webview.html.includes('<option value="commerce"') ? second.webview.html : null));
  assert.ok(reloaded, 'the map was read back, with the capability just mapped in it');

  const panel2 = second;
  await panel2.post({ type: 'field', field: 'capabilityId', value: 'platform-api' });
  await panel2.post({ type: 'field', field: 'name', value: 'Platform API' });
  await panel2.post({ type: 'field', field: 'kind', value: 'delivery' });
  await panel2.post({ type: 'field', field: 'parent', value: 'commerce' });
  await panel2.post({ type: 'field', field: 'repositoryUrl', value: bare });
  await panel2.post({ type: 'map' });

  await until(() => run('git', ['for-each-ref', '--format=%(refname:short)',
    'refs/heads/sflow/config-change/capability/map-platform-api-*'], { cwd: bare }).stdout.trim() || null,
  { attempts: 200 });
  mergeCapabilityProposal(bare, 'map-platform-api-');
  const map = run('git', ['show', 'sflow/config:singularity/capabilities.yml'], { cwd: bare }).stdout;
  assert.ok(map, 'the second capability reached the remote');
  const portfolio = run('git', ['show', 'sflow/config:singularity/portfolio.yml'], { cwd: bare }).stdout;
  assert.match(map, /parent: commerce/, 'and it was placed under the capability chosen as its parent');
  assert.equal(registered.inputBoxes.length, 0, 'nothing was asked through a prompt');
});

test('a window with nothing open shows only real workspaces', async (t) => {
  if (!requireBundle(t)) return;
  // The map lives in the lead repository, not in the open folder — so "not a Git repository" is a
  // fact about the window and not about whether there is anything to show. Sending somebody to find
  // a checkout for a map that was never in one is the whole confusion this avoids.
  const org = await organisation();
  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = undefined;
  const extension = loadExtension(api);
  await extension.activate(context());

  const tree = section(registered, 'workspaces');
  assert.equal(tree.getChildren().some((node) => node.id === 'workspace:scope'), false,
    'configuration is not duplicated as a synthetic workspace row');
});

test('the loaded build identifies itself, because the version cannot', async (t) => {
  if (!requireBundle(t)) return;
  // The extension's version does not change between development reinstalls, so neither VS Code, the
  // person reloading, nor whoever is helping them can tell two builds apart — which turns "did the
  // fix land?" into guesswork on both sides.
  const { registered } = await activated();
  const stamp = registered.output.find((line) => String(line).startsWith('Singularity Flow — build '));
  assert.ok(stamp, 'the build stamp is the first thing in the output channel');
  assert.match(stamp, /build [0-9a-f]{7}(\+local)? \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z/);
});

test('terminal lifecycle writes refresh every VS Code view through one watched snapshot', async (t) => {
  if (!requireBundle(t)) return;
  const { root, registered } = await activated();
  assert.equal(registered.watchers.length, 1, 'the governed repository is watched once');
  assert.equal(await realpath(registered.watchers[0].pattern.base.fsPath), await realpath(root));
  assert.equal(registered.watchers[0].pattern.pattern, 'singularity/**/*');

  const statePath = path.join(root, 'singularity', 'initiatives', 'INIT-CHECKOUT', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.initiative.title = 'Changed from Copilot CLI';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  registered.watchers[0].change.fire({ fsPath: statePath });

  const provider = section(registered, 'lifecycle');
  await until(() => provider.getChildren().find((node) => node.kind === 'initiative')?.description === 'Changed from Copilot CLI');
  assert.equal(provider.getChildren().find((node) => node.kind === 'initiative')?.description, 'Changed from Copilot CLI');
});

test('a workspace chosen while the views are already bound re-points them without reloading', async (t) => {
  if (!requireBundle(t)) return;
  // The steady state, which is where the cost was. The first selection after activation finds no
  // repository services and reloads once, deliberately; every selection after that must not, or
  // comparing two workspaces throws away every open editor twice. This guarantee had a regression
  // test, the test was deleted in a later refactor, and the behaviour it protects has already
  // shipped broken once.
  const root = await demoRepository();
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-repoint-'));
  const registryFile = path.join(base, 'registry.json');
  spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
    'workspace', 'create', '--local', '--json', '--id', 'here', '--base', path.join(base, 'ws'),
    '--lead', 'lead', '--repository', `lead=${root}`, '--confirm', 'here', '--no-clone'], {
    encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registryFile }
  });
  // Set before activation: the workspace tree is populated once, when the extension starts.
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registryFile;

  const { api, registered } = stubVscode();
  api.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  const issued = [];
  const dispatch = api.commands.executeCommand;
  api.commands.executeCommand = async (command, ...args) => {
    issued.push(command);
    return dispatch(command, ...args);
  };
  const extension = loadExtension(api);
  await extension.activate(context());

  const provider = section(registered, 'workspaces');
  const rows = await until(() => {
    const nodes = provider.getChildren();
    return nodes[0]?.label === 'here' ? nodes : null;
  });
  // Command Palette invocation has no tree node. It must ask which workspace to use rather than
  // silently doing nothing (the row-click path is covered by the first-selection test above).
  await registered.commands.get('singularityFlow.switchWorkspace')();

  assert.equal(issued.includes('workbench.action.reloadWindow'), false,
    'the window is not reloaded once the views are already bound');
  assert.equal(issued.includes('vscode.openFolder'), false, 'and no folder is opened');
  assert.equal(registered.quickPicks.at(-1)?.options?.title,
    'Work in a Singularity Flow workspace');
  assert.deepEqual(registered.errors, []);
});
