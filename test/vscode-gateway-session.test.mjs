/**
 * The gateway running inside the extension host.
 *
 * These exercise the bundled extension against the stubbed VS Code API — the same harness the rest
 * of `vscode-host` uses — so what is under test is the shipped bundle, activated, with the command
 * invoked. That matters here more than usual: the whole question is whether the core survives being
 * bundled into CommonJS, and only the bundle can answer it.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { codeOnly } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'apps', 'vscode');
const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-gateway-bundle-'));
const isolatedExtension = path.join(isolatedRoot, 'apps', 'vscode');
const isolatedBundle = path.join(isolatedExtension, 'dist');
await mkdir(isolatedBundle, { recursive: true });
// A packaged extension has its staged CLI beside dist. Preserve that layout in the isolated
// bundle fixture so loading the runtime can verify its package root without relying on source cwd.
await symlink(root, path.join(isolatedExtension, 'cli'), process.platform === 'win32' ? 'junction' : 'dir');
const build = spawnSync(process.execPath, ['esbuild.mjs'], {
  cwd: extension,
  encoding: 'utf8',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_VSCODE_TEST_OUTDIR: isolatedBundle
  }
});
assert.equal(build.status, 0, `isolated VS Code gateway build failed:\n${build.stdout}${build.stderr}`);
after(async () => { await rm(isolatedRoot, { recursive: true, force: true }); });

test('the packaged lazy gateway runtime contains the in-process handle authority', async () => {
  /**
   * The bridge, asserted at its narrowest point. A handle is signed per session and revalidated at
   * the moment of use; it cannot survive a process that exits after every command. Either the
   * kernel is in this bundle or nothing in the editor re-resolves anything.
   */
  const bundle = await readFile(path.join(isolatedBundle, 'gateway-runtime.cjs'), 'utf8');
  assert.ok(bundle.includes('sflow-result'), 'the result contract is bundled');
  assert.ok(bundle.includes('A handle requires the operation it resolved to'),
    'the handle authority is bundled');
  assert.ok(bundle.includes('gateway.planner-unavailable'), 'the kernel is bundled');
});

test('shipped bundles share the managed resolver and defer the locked ACP SDK until invocation', async () => {
  const sources = async name => JSON.parse(await readFile(path.join(isolatedBundle, `${name}.cjs.map`), 'utf8')).sources;
  for (const name of ['extension', 'lazy-panels-runtime']) {
    assert.ok(!(await sources(name)).some(source => /runtime\/resolve\.cjs$/u.test(source)),
      `${name} must not copy the managed resolver`);
    assert.match(await readFile(path.join(isolatedBundle, `${name}.cjs`), 'utf8'),
      /require\(["']\.\/gateway-context-runtime\.cjs["']\)/u);
  }
  assert.equal((await sources('gateway-context-runtime')).filter(source => /runtime\/resolve\.cjs$/u.test(source)).length, 1);
  assert.ok(!(await sources('gateway-runtime')).some(source => source.includes('@agentclientprotocol/sdk/')),
    'the gateway must not parse protocol schemas just to render a read-only card');
});

test('the shared packaged resolver freshly selects an installed pair and never hides a broken upgrade', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-shared-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { resolveManagedEngine } = createRequire(import.meta.url)(path.join(isolatedBundle, 'gateway-context-runtime.cjs'));
  const environment = { SINGULARITY_FLOW_ENGINE_HOME: directory };
  assert.equal(resolveManagedEngine({ environment }), null);
  const runtime = `node-v26.12.0-${process.platform}-${process.arch}`;
  const runtimeRoot = path.join(directory, 'runtimes', runtime);
  const executable = path.join(runtimeRoot, ...(process.platform === 'win32' ? ['node.exe'] : ['bin/node']));
  await mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
  await writeFile(executable, 'test runtime', { mode: 0o600 });
  for (const release of ['a'.repeat(64), 'b'.repeat(64)]) {
    const cli = path.join(directory, 'releases', release, 'node_modules/singularity-flow/bin/singularity-flow.mjs');
    await mkdir(path.dirname(cli), { recursive: true, mode: 0o700 });
    await writeFile(cli, 'test CLI', { mode: 0o600 });
    await writeFile(path.join(directory, 'active'), `1|${runtime}|${release}\n`, { mode: 0o600 });
    const selected = resolveManagedEngine({ environment });
    assert.equal(selected.release, release, 'each lookup must follow the latest atomic installation selection');
    assert.equal(path.basename(selected.executable), path.basename(executable));
    assert.equal(selected.cli, await realpath(cli));
  }
  await writeFile(path.join(directory, 'active'), 'broken upgrade\n');
  assert.throws(() => resolveManagedEngine({ environment }), /selection is invalid/u);
});

test('the packaged status worker loads its sibling gateway runtime and replies over IPC', async (t) => {
  const workerFile = path.join(isolatedBundle, 'gateway-status-worker.cjs');
  const workerBundle = await readFile(workerFile, 'utf8');
  assert.match(workerBundle, /require\(["']\.\/gateway-runtime\.cjs["']\)/);
  const child = fork(workerFile, [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  t.after(() => child.kill());
  let childError = '';
  child.stderr?.on('data', (chunk) => { childError = (childError + String(chunk)).slice(0, 4096); });
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Status worker did not answer over IPC.')), 5_000);
    const finish = (callback) => (value) => { clearTimeout(timer); callback(value); };
    child.once('error', finish(reject));
    child.once('exit', finish((code) => reject(new Error(`Status worker exited before replying: ${code}; ${childError}`))));
    child.once('message', finish(resolve));
    child.send({ id: 17, route: null, workId: null, lens: 'today' });
  });
  assert.deepEqual(response, { id: 17, value: null });
});

test('the editor bundles the shared docs planner with a verified package root', async () => {
  /**
   * `help-explain` now receives the same package-root contract as every other surface. It must be
   * present in the lazy gateway CommonJS bundle rather than falling back to a second host-specific
   * resolver.
   */
  const source = await readFile(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts'), 'utf8');
  const imported = [...source.matchAll(/planners\/([a-z-]+)\.mjs/g)].map(([, name]) => name).sort();
  assert.deepEqual(imported, ['ast-intelligence', 'compare', 'context-brief', 'developer-next', 'executors', 'governed-goal', 'help-explain', 'home-overview', 'impact-quick', 'impact-what-if', 'intent-trace', 'problem-investigate', 'repository-explore', 'repository-query', 'review-open', 'review-packet', 'watches', 'work-continue', 'work-list',
    'work-readiness', 'work-return', 'work-start', 'work-start-intake', 'workspace-list', 'workspace-reliability-surface', 'workspace-switch']);
  assert.ok(codeOnly(source).includes('help-explain'), 'the docs planner is imported');
  assert.ok(codeOnly(source).includes("['intent-trace', intentTracePlanner]"),
    'the model-free intent trace is available to the editor host');

  /**
   * Checked by a marker from inside the module, not by its filename.
   *
   * A first pass grepped for `docs-manifest` and failed — on `docs-manifest.json`, which the Help
   * Center `require`s at runtime from a computed path and which is data, not a bundled module. A
   * substring of a filename cannot tell "this code is here" from "this name is mentioned".
   */
  const bundle = await readFile(path.join(isolatedBundle, 'gateway-runtime.cjs'), 'utf8');
  const topics = await readFile(path.join(root, 'src', 'docs-topics.mjs'), 'utf8');
  const marker = topics.match(/export function (\w+)/)?.[1];
  assert.ok(marker, 'docs-topics.mjs exports something to look for');
  const map = JSON.parse(await readFile(path.join(isolatedBundle, 'gateway-runtime.cjs.map'), 'utf8'));
  assert.ok(map.sources.some(source => source.endsWith('/src/docs-topics.mjs')));
  assert.ok(bundle.includes(JSON.stringify(marker)), 'the shared documentation subsystem retains its runtime name');
});

test('compact packaged locals preserve public function names and their behavior', () => {
  const load = createRequire(import.meta.url);
  const runtime = load(path.join(isolatedBundle, 'gateway-runtime.cjs'));
  const context = load(path.join(isolatedBundle, 'gateway-context-runtime.cjs'));
  for (const [name, value] of Object.entries(runtime)) assert.equal(value.name, name);
  assert.equal(context.activeRepositoryContext.name, 'activeRepositoryContext');
  context.setActiveRepositoryContext({ root: '/fixture', workspaceId: null, workspaceName: null, repositoryId: null, origin: 'test' });
  assert.equal(context.activeRepositoryContext().root, '/fixture');
  context.setActiveRepositoryContext(null);
  assert.equal(context.activeRepositoryContext(), null);
  assert.equal(runtime.primaryAction({ next: [] }), null);
});

test('the host gateway refuses to start without being told which planners exist', async () => {
  const { createHostGateway } = await import('../src/gateway/host.mjs');
  assert.throws(() => createHostGateway({ root: '/tmp', hostSessionId: 's' }),
    /requires the map of planners/);
  /**
   * It used to default to all seven, which made `host.mjs` statically import the docs subsystem and
   * silently decided the module could only run in one kind of host. Which planners a build has was
   * always the caller's fact; the default hid that.
   */
  const source = await readFile(path.join(root, 'src', 'gateway', 'host.mjs'), 'utf8');
  assert.ok(!source.includes("from './planners/index.mjs'"),
    'host.mjs must not pull the full planner set');
});

test('a card carries its handle in the model and never in the markup', async () => {
  const model = await import(pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'views', 'result-card-model.ts')).href);
  const { workReadinessResult } = await import('../src/gateway/planners/work-readiness.mjs');
  const result = workReadinessResult({
    id: 'PAY-1187', kind: 'story', phase: 'implement', generation: 1, group: 'active',
    blockers: ['required-artifact-missing'],
    nextAction: { operation: 'work.continue', reasonCode: 'work.resume-phase' }, lastMaterialEvent: null
  });
  const card = model.buildResultCard(result);
  const action = card.checklist.find((row) => row.action)?.action;
  assert.ok(action.handle, 'the model has the handle to dispatch with');

  const { resultCardHtml } = await import(pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'views', 'result-card-page.ts')).href);
  assert.ok(!resultCardHtml(card).includes(action.handle), 'the webview never sees it');
});

test('origin travels with the showing, not with the card', async () => {
  /**
   * A gateway result was resolved moments ago and its handles are live; a CLI result came from a
   * process that has exited and its handles are dead. The dispatcher must not guess which it holds,
   * and the card itself cannot know — the same view can arrive either way.
   */
  const panel = await readFile(path.join(root, 'apps', 'vscode', 'src', 'views', 'result-panel.ts'), 'utf8');
  assert.match(panel, /export type ResultOrigin = 'gateway' \| 'cli'/);
  assert.match(panel, /origin: currentOrigin/);

  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /if \(route && origin === 'gateway'\)/,
    'the executor path is taken only for results whose handles are live');
  assert.match(extension, /showResultCard\(buildResultCard\(envelope\), \{ origin: 'gateway' \}\)/,
    'My Work marks its own result as one the executor can re-resolve');
});

test('every gateway surface uses the validated active repository context', async () => {
  const session = await readFile(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts'), 'utf8');
  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');

  assert.doesNotMatch(codeOnly(session), /workspaceFolders/,
    'the gateway session never derives its repository from the editor folder');
  assert.match(session, /export function setActiveRepositoryContext/);
  assert.match(session, /sessionWorkspaceId === workspaceId/,
    'workspace identity participates in session reuse');
  assert.match(codeOnly(extension), /gatewaySession\(route\)/,
    'rootless Home supplies an explicit route rather than deriving one from an editor folder');
  assert.match(codeOnly(extension), /gatewaySession\(active\)/,
    'repository-backed surfaces supply the validated active context');
  assert.match(extension,
    /No workspace or repository is selected\. Choose a workspace or open a repository\./,
    'the empty-state message describes both supported resolution paths');
});

test('changing workspace identity retires the previous gateway session', async () => {
  const gateway = await import(pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts')).href);
  const first = {
    root: '/tmp/sflow-context-root', workspaceId: 'workspace-a', workspaceName: 'A',
    repositoryId: 'lead', origin: 'test'
  };
  gateway.setActiveRepositoryContext(first);
  const original = gateway.gatewaySession(first);
  assert.equal(gateway.gatewaySession(first), original,
    'an unchanged context reuses its handle authority');

  const second = { ...first, workspaceId: 'workspace-b', workspaceName: 'B' };
  gateway.setActiveRepositoryContext(second);
  const replaced = gateway.gatewaySession(second);
  assert.notEqual(replaced, original,
    'the same checkout under another workspace receives a new handle authority');
  assert.deepEqual(gateway.activeRepositoryContext(), second);
});

test('changing the Goal-owning lead repository retires handles even when the selected member stays put', async () => {
  const gateway = await import(pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts')).href);
  const first = {
    root: '/tmp/sflow-member-repository', leadRepositoryPath: '/tmp/sflow-lead-a',
    workspaceId: 'workspace-a', workspaceName: 'A', repositoryId: 'member', origin: 'test'
  };
  gateway.setActiveRepositoryContext(first);
  const original = gateway.gatewaySession(first);
  const second = { ...first, leadRepositoryPath: '/tmp/sflow-lead-b' };
  gateway.setActiveRepositoryContext(second);
  assert.notEqual(gateway.gatewaySession(second), original,
    'a Goal branch must never be read through handles bound to the previous lead repository');
});
