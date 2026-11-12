import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { register } from 'node:module';
import test from 'node:test';
import YAML from 'yaml';

import { apmProjectStatus } from '../src/apm-project.mjs';

// The panel host runs against a `vscode` stub, as in vscode-instruction-designer.test.mjs; every
// prompt it shows answers from `ui`, and every CLI command it runs goes to a recording client.
const ui = { reset() { Object.assign(this, { picks: [], confirms: [], infos: [], errors: [], pick: () => undefined, folder: undefined, input: undefined, confirm: undefined }); } };
ui.reset();
let createdPanel = null;
globalThis.__sfApmTestVscode = {
  ViewColumn: { Active: 1 },
  Uri: { file: (fsPath) => ({ fsPath }), joinPath: () => ({}) },
  commands: { executeCommand: async () => undefined },
  workspace: { fs: { stat: async () => ({}) } },
  window: {
    createWebviewPanel: () => {
      let receive = () => {};
      let disposed = () => {};
      createdPanel = {
        visible: true,
        webview: { html: '', cspSource: 'vscode-resource:', onDidReceiveMessage(listener) { receive = listener; return { dispose() {} }; } },
        post: (message) => receive(message),
        onDidDispose(listener) { disposed = listener; return { dispose() {} }; },
        reveal() {}, dispose() { disposed(); }
      };
      return createdPanel;
    },
    showQuickPick: async (items, options) => { ui.picks.push({ items, options }); return ui.pick(items, options); },
    showOpenDialog: async () => ui.folder,
    showInputBox: async () => ui.input,
    showInformationMessage: async (message, options, ...items) => {
      if (options?.modal) { ui.confirms.push({ message, detail: options.detail, items }); return items.includes(ui.confirm) ? ui.confirm : undefined; }
      ui.infos.push(message);
      return undefined;
    },
    showErrorMessage: async (message) => { ui.errors.push(message); }
  }
};
const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  const api = globalThis.__sfApmTestVscode;
  export const ViewColumn = api.ViewColumn, Uri = api.Uri, commands = api.commands, workspace = api.workspace, window = api.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));

const { apmAttachResult, apmPublishDetail, apmPublishResult, apmView, kebabName, packageSpec, shellArgument } = await import('../apps/vscode/src/views/apm-packages-model.ts');
const { apmPackagesHtml, APM_PACKAGES_SCRIPT } = await import('../apps/vscode/src/views/apm-packages-page.ts');
const { ApmPackagesPanel } = await import('../apps/vscode/src/views/apm-packages.ts');

// APM A7 (2026-10-30): the Agent Packages panel reads `apm status --json`. The status below is built
// by the engine itself from a repository with an installed package, a binding that applies, one that
// waits, and an agent SFlow cannot read, so the page and the CLI can never disagree about the shape.
const sha = (text) => createHash('sha256').update(text).digest('hex');
const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
};

async function status(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-apm-panel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    '.github/agents/reviewer.agent.md': '---\nname: reviewer\ndescription: Reviews <b>the</b> change\n---\nReview it.\n',
    '.github/agents/planner.agent.md': '---\nname: planner\n---\nPlan it.\n'
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'apm:\n  agents:\n    reviewer:\n      defaultFor: [verification]\n    ghost:\n      defaultFor: [design]\n');
  await writeFile(path.join(root, 'apm.yml'), 'name: consumer\nversion: 1.0.0\ndependencies:\n  apm:\n    - reviewer@team-catalog\n');
  await writeFile(path.join(root, 'apm.lock.yaml'), YAML.stringify({
    lockfile_version: '1', apm_version: '0.35.0',
    dependencies: [{ repo_url: 'acme/team-catalog', virtual_path: 'plugins/reviewer', resolved_commit: 'a'.repeat(40), version: '1.0.1',
      discovered_via: 'team-catalog', marketplace_plugin_name: 'reviewer',
      deployed_files: Object.keys(files), deployed_file_hashes: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, `sha256:${sha(text)}`])) }]
  }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Packager', '-c', 'user.email=packager@example.com', 'commit', '-q', '-m', 'init');
  return apmProjectStatus(root, { cliVersion: () => null });
}

test('the panel reads apm status as the engine writes it: packages, bindings that apply or wait, agents SFlow cannot use', async (t) => {
  const raw = await status(t);
  const view = apmView(raw);
  assert.ok(view, 'the engine\'s own result is read');
  assert.equal(view.state, 'intact');
  assert.deepEqual(view.packages.map(({ label, version, commit }) => [label, version, commit]), [['reviewer@team-catalog', '1.0.1', 'a'.repeat(40)]]);
  assert.deepEqual(view.bindings.map(({ agent, active }) => [agent, active]), [['reviewer', true], ['ghost', false]]);
  assert.equal(view.unusable[0].name, 'planner');
  assert.equal(apmView({ schemaVersion: 2, resultType: 'command-result', data: raw })?.state, 'intact', 'a wrapped result is read too');
  assert.equal(apmView({ resultType: 'sflow-apm-install' }), null);

  const html = apmPackagesHtml(view, null);
  assert.match(html, /Every deployed file matches apm\.lock\.yaml and is committed\./u);
  assert.match(html, /<strong>reviewer@team-catalog<\/strong> <span class="meta">1\.0\.1<\/span>/u, 'a package reads by its version, never its commit');
  assert.match(html, /<strong>reviewer<\/strong> drafts verification\./u);
  assert.match(html, /<strong>ghost<\/strong> would draft design, but APM did not deploy \.github\/agents\/ghost\.agent\.md\.\s*<p class="meta">Until then each step keeps its workflow's own agent; nothing is blocked\./u);
  assert.match(html, /Agents SFlow cannot use[\s\S]*planner[\s\S]*requires a non-empty description/u);
  for (const action of ['refresh', 'install', 'update', 'studio', 'open-manifest', 'open-lock']) assert.match(html, new RegExp(`data-apm="${action}"`, 'u'));
  assert.deepEqual(view.apmAgents, ['reviewer'], 'Attach offers the agents a package deployed that SFlow can use');
  assert.match(html, /<button type="button" class="secondary" data-apm="attach" data-agent="reviewer">Attach reviewer to a step…<\/button>/u);
  assert.doesNotMatch(html, /data-agent="planner"|data-agent="ghost"/u, 'never an agent SFlow cannot use, or one APM did not deploy');
  assert.doesNotMatch(html, /data-apm="share"/u, 'nothing to share when every agent came from APM');
  assert.doesNotMatch(html, /<b>the<\/b>/u, 'text from the files is escaped');
  assert.match(html, /No APM CLI on this machine; installing and updating need it, reading does not\./u);
  assert.match(APM_PACKAGES_SCRIPT, /postMessage\(\{ type: 'action', action: target\.dataset\.apm, agent: target\.dataset\.agent \|\| null \}\)/u);

  const own = apmView({ ...raw, unmanagedAgents: ['.github/agents/checker.agent.md', '.github/agents/notes.md', '.github/agents/Bad_Name.md'] });
  assert.deepEqual(own.ownAgents, ['checker', 'notes'], 'own agents by ID, as apm publish names them');
  const shared = apmPackagesHtml(own, null);
  assert.match(shared, /Share this repository's agents[\s\S]*this repository's own, not from APM: checker, notes\.[\s\S]*Nothing is pushed\.[\s\S]*data-apm="share"/u);
  const many = apmPackagesHtml({ ...own, ownAgents: Array.from({ length: 11 }, (_, index) => `agent-${index + 1}`) }, null);
  assert.match(many, /not from APM: agent-1, agent-2, agent-3, agent-4, agent-5, agent-6, agent-7, agent-8 and 3 more\./u, 'a long list names eight; the picker shows all');

  const absent = apmPackagesHtml(apmView({ ...raw, state: 'absent', manifest: null, lock: null, packages: [], findings: [], agents: { bindings: {}, unusable: [] } }), null);
  assert.match(absent, /This repository has no APM project yet/u);
  assert.match(absent, /data-apm="install"/u);
  assert.doesNotMatch(absent, /data-apm="update"|data-apm="open-lock"/u, 'nothing to update or open without packages');
  assert.match(apmPackagesHtml(null, 'The APM files could not be read: boom <x>'), /class="notice error" role="status">The APM files could not be read: boom &lt;x&gt;/u);
});

test('a package typed into the panel is one argument, never an option or two words', () => {
  assert.equal(packageSpec(' reviewer@team-catalog '), 'reviewer@team-catalog');
  assert.equal(packageSpec('--force'), null);
  assert.equal(packageSpec('two words'), null);
  assert.equal(packageSpec(''), null);
  assert.equal(shellArgument('acme/review-pack#v1.2.0'), 'acme/review-pack#v1.2.0');
  assert.equal(shellArgument("../it's here"), "'../it'\\''s here'");
});

/** The real panel, a recording CLI client, and the window context the extension gives it. */
async function openPanel(t, raw, { kind = 'remote-approved', results = {} } = {}) {
  createdPanel?.dispose();
  ui.reset();
  const calls = [];
  const refreshed = [];
  const client = { repository: '/repository', run: async (args) => {
    calls.push(args);
    const key = args.join(' ');
    if (key === 'apm status --json') return raw;
    const answer = Object.entries(results).find(([prefix]) => key.startsWith(prefix))?.[1];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(args) : answer;
  } };
  ApmPackagesPanel.show(client, {
    steps: () => [{ id: 'design', label: 'Design' }, { id: 'verification', label: 'Verification' }],
    authorityKind: () => kind,
    refresh: async () => { refreshed.push(true); }
  });
  const panel = createdPanel;
  t.after(() => panel.dispose());
  const settle = async () => { for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve)); };
  await settle();
  return { calls, refreshed, html: () => panel.webview.html, send: async (message) => { panel.post(message); await settle(); } };
}

test('Attach previews apm attach, asks, and proposes it for review where configuration is approved', async (t) => {
  const raw = await status(t);
  const plan = { resultType: 'workflow-studio-plan', valid: true, summary: ['APM agent reviewer drafts Design.'], problems: [] };
  const panel = await openPanel(t, raw, { results: {
    'apm attach reviewer --step design --dry-run': plan,
    'apm attach reviewer --step design --propose': { schemaVersion: 2, resultType: 'command-result', data: { reviewRequired: true, branch: 'sflow/config-change/studio/apm-reviewer-1' } }
  } });
  assert.match(panel.html(), /data-apm="attach" data-agent="reviewer"/u);

  ui.pick = (items) => items.find((item) => item.id === 'design');
  ui.confirm = 'Propose';
  await panel.send({ type: 'action', action: 'attach', agent: 'reviewer' });
  assert.deepEqual(ui.picks[0].items.map((item) => item.id), ['design', 'verification'], 'every step of the configuration shown');
  assert.deepEqual(panel.calls.filter((args) => args[1] === 'attach'), [
    ['apm', 'attach', 'reviewer', '--step', 'design', '--dry-run', '--json'],
    ['apm', 'attach', 'reviewer', '--step', 'design', '--propose', '--json']
  ]);
  assert.equal(ui.confirms[0].message, 'reviewer drafts Design?');
  assert.match(ui.confirms[0].detail, /APM agent reviewer drafts Design\.\nIt is proposed for review, and applies once the proposal is approved\./u);
  assert.match(ui.infos.at(-1), /^Proposed: reviewer drafts Design \(sflow\/config-change\/studio\/apm-reviewer-1\)\. It applies once the proposal is approved\.$/u);
  assert.equal(panel.refreshed.length, 1, 'configuration is read again after the change');

  // Declined, nothing runs past the dry run; an agent SFlow cannot use is never attached.
  ui.confirm = undefined;
  await panel.send({ type: 'action', action: 'attach', agent: 'reviewer' });
  await panel.send({ type: 'action', action: 'attach', agent: 'planner' });
  assert.equal(panel.calls.filter((args) => args[1] === 'attach' && !args.includes('--dry-run')).length, 1);
  assert.equal(panel.calls.filter((args) => args[1] === 'attach').length, 3);
});

test('Attach writes this checkout where it is the configuration authority, and a change that does not check is never run', async (t) => {
  const raw = await status(t);
  const panel = await openPanel(t, raw, { kind: 'working-tree', results: {
    'apm attach reviewer --step verification --dry-run': { valid: true, summary: [], problems: [] },
    'apm attach reviewer --step verification --json': { schemaVersion: 2, resultType: 'command-result', data: {} },
    'apm attach reviewer --step design --dry-run': { valid: false, summary: [], problems: [{ code: 'X', message: 'Design already has an APM agent.' }] }
  } });
  ui.pick = (items) => items.find((item) => item.id === 'verification');
  ui.confirm = 'Attach';
  await panel.send({ type: 'action', action: 'attach', agent: 'reviewer' });
  assert.deepEqual(panel.calls.filter((args) => args[1] === 'attach').at(-1), ['apm', 'attach', 'reviewer', '--step', 'verification', '--json']);
  assert.match(ui.confirms[0].detail, /changes this checkout's singularity\/workflow\.yml; review and commit it\./u);
  assert.match(ui.infos.at(-1), /reviewer now drafts Verification in this checkout/u);

  ui.pick = (items) => items.find((item) => item.id === 'design');
  await panel.send({ type: 'action', action: 'attach', agent: 'reviewer' });
  assert.equal(ui.errors.at(-1), 'reviewer cannot draft Design: Design already has an APM agent.');
  assert.equal(ui.confirms.length, 1, 'nothing to confirm');
});

test('Share previews apm publish of the chosen agents to a marketplace checkout, asks, and publishes', async (t) => {
  const raw = { ...(await status(t)), unmanagedAgents: ['.github/agents/checker.agent.md', '.github/agents/notes.agent.md'] };
  const preview = { resultType: 'sflow-apm-publish', package: 'review-pack', version: '1.0.0', previousVersion: null, marketplace: 'team-catalog', branch: 'apm/publish-review-pack-1.0.0',
    dryRun: true, unchanged: false, files: [{ path: 'plugins/review-pack/.apm/agents/checker.agent.md', bytes: 410 }, { path: 'plugins/review-pack/apm.yml', bytes: 220 }],
    stepsKeptHere: [{ agent: 'checker', steps: ['verification'] }] };
  const panel = await openPanel(t, raw, { results: {
    'apm publish checker notes --marketplace /catalog --package review-pack --dry-run': preview,
    'apm publish checker notes --marketplace /catalog --package review-pack --json': { ...preview, dryRun: false, committed: true }
  } });
  ui.pick = (items) => items;
  ui.folder = [{ fsPath: '/catalog' }];
  ui.input = 'review-pack';
  ui.confirm = 'Publish';
  await panel.send({ type: 'action', action: 'share' });
  assert.deepEqual(ui.picks[0].items.map((item) => item.label), ['checker', 'notes']);
  assert.equal(ui.picks[0].options.canPickMany, true);
  assert.deepEqual(panel.calls.filter((args) => args[1] === 'publish'), [
    ['apm', 'publish', 'checker', 'notes', '--marketplace', '/catalog', '--package', 'review-pack', '--dry-run', '--json'],
    ['apm', 'publish', 'checker', 'notes', '--marketplace', '/catalog', '--package', 'review-pack', '--json']
  ]);
  assert.equal(ui.confirms[0].message, 'Publish review-pack 1.0.0 to team-catalog?');
  assert.match(ui.confirms[0].detail, /review-pack 1\.0\.0 \(new\), on apm\/publish-review-pack-1\.0\.0[\s\S]*checker\.agent\.md \(410 bytes\)[\s\S]*checker's steps here \(verification\) stay in this repository[\s\S]*Nothing is pushed\./u);
  assert.match(ui.infos.at(-1), /^Published review-pack 1\.0\.0 to team-catalog: committed on apm\/publish-review-pack-1\.0\.0 in its checkout\. Nothing was pushed/u);

  // Unchanged, nothing is published; a refused publish is reported, never retried.
  const again = await openPanel(t, raw, { results: { 'apm publish checker --marketplace /catalog --dry-run': { ...preview, package: 'checker', unchanged: true } } });
  ui.pick = (items) => items.slice(0, 1); ui.folder = [{ fsPath: '/catalog' }]; ui.confirm = 'Publish';
  await again.send({ type: 'action', action: 'share' });
  assert.deepEqual(again.calls.filter((args) => args[1] === 'publish'), [['apm', 'publish', 'checker', '--marketplace', '/catalog', '--dry-run', '--json']]);
  assert.match(ui.infos.at(-1), /already has exactly these files; nothing to publish/u);
  const refused = await openPanel(t, raw, { results: { 'apm publish checker --marketplace /catalog --dry-run': new Error('/catalog is not an APM marketplace.') } });
  ui.pick = (items) => items.slice(0, 1); ui.folder = [{ fsPath: '/catalog' }];
  await refused.send({ type: 'action', action: 'share' });
  assert.equal(ui.errors.at(-1), 'The agents were not shared: /catalog is not an APM marketplace.');
});

test('the attach and publish readers take what the CLI prints, and names are checked as the CLI checks them', () => {
  assert.deepEqual(apmAttachResult({ schemaVersion: 2, resultType: 'command-result', data: { branch: 'b' } }), { valid: true, summary: [], problems: [], branch: 'b' });
  assert.deepEqual(apmAttachResult({ valid: false, summary: ['x'], problems: [{ message: 'no' }, {}] }), { valid: false, summary: ['x'], problems: ['no'], branch: null });
  assert.equal(apmPublishResult({ resultType: 'sflow-apm-status' }), null);
  assert.match(apmPublishDetail(apmPublishResult({ package: 'p', version: '1.1.0', previousVersion: '1.0.0', marketplace: 'm', branch: null, files: [] })), /^p 1\.1\.0 \(was 1\.0\.0\), on a new branch/u);
  assert.equal(kebabName(' review-pack '), 'review-pack');
  for (const bad of ['Review', 'review_pack', '-x', 'x-', 'a'.repeat(65)]) assert.equal(kebabName(bad), null, bad);
});

