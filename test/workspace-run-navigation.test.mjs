import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { repository, git, withMachineState } from './helpers/environment-files-fixture.mjs';
import { workspaceRuntimeInventory, resolveWorkspaceRuntimeTarget } from '../src/workspace-runtime.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { runtimeInventory, runtimeTargetArgs, safeRuntimeRelative } from '../apps/vscode/src/views/workspace-runtime-model.ts';
import { workspaceRuntimeHtml } from '../apps/vscode/src/views/workspace-runtime-page.ts';
import { appPlanFrom, startConfirmationRequest, testsConfirmationRequest } from '../apps/vscode/src/views/run-and-test-model.ts';
import { commandClass } from '../apps/vscode/src/cli/client.ts';

const sha = `sha256:${'a'.repeat(64)}`;
const plan = (id, extras = {}) => ({ capability: 'web', id, argv: ['node', `${id}.mjs`], workingDirectory: '.', url: 'http://127.0.0.1:3000/', ready: { http: '/' }, environments: [], commandSha256: sha, ...extras });

test('workspace run inventory is local and starts no Git process or checkout creation', async t => {
  const repo = await repository(t);
  const root = path.join(repo.base, 'workspace'), checkout = path.join(root, 'repos/web');
  await mkdir(path.dirname(checkout), { recursive: true });
  git(repo.base, ['clone', '-q', repo.root, checkout]);
  await writeFile(path.join(root, 'workspace.json'), JSON.stringify({ version: 1, id: 'local--runtime', name: 'Runtime workspace', anchor: { provider: 'workspace', key: 'runtime' }, leadRepository: 'web', repositories: { web: { url: repo.root, path: 'repos/web', defaultBranch: 'main' } } }));
  await withMachineState(repo.env, async () => {
    const timer = commandTimer('runtime-local', { commandClass: 'read' });
    const inventory = await withCommandTiming(timer, () => workspaceRuntimeInventory(root));
    const timing = timer.finish();
    assert.equal(timing.counters['git.spawns'] ?? 0, 0);
    assert.equal(timing.counters['git.remote.total'] ?? 0, 0);
    assert.equal(inventory.targets.length, 1);
    assert.equal(inventory.remoteChecked, false); assert.equal(inventory.materializesCheckout, false);
    assert.equal(inventory.targets[0].checkoutPath, checkout);
    const started = performance.now();
    const cli = repo.json(['workspace', 'runtime', '--workspace', root]);
    const coldMs = performance.now() - started;
    assert.equal(cli.status, 0, cli.stderr);
    const repeated = performance.now();
    const again = repo.json(['workspace', 'runtime', '--workspace', root]);
    const warmMs = performance.now() - repeated;
    assert.equal(again.status, 0, again.stderr);
    assert.equal(cli.value.targets[0].id, inventory.targets[0].id);
    t.diagnostic(`Separate CLI processes: first ${coldMs.toFixed(1)} ms; repeated ${warmMs.toFixed(1)} ms (OS-warm, no resident worker)`);
    const changes = repo.json(['workspace', 'runtime', '--workspace', root, '--target', inventory.targets[0].id, '--changes']);
    assert.equal(changes.status, 0, changes.stderr);
    assert.deepEqual(changes.value.changes, []);
    const selected = await resolveWorkspaceRuntimeTarget(root, inventory.targets[0].id);
    assert.equal(selected.checkoutPath, checkout);
    assert.equal(selected.repositoryId, 'web');
    await assert.rejects(resolveWorkspaceRuntimeTarget(root, '0'.repeat(64)), { code: 'WORKSPACE_RUNTIME_TARGET_UNAVAILABLE' });
    t.diagnostic(`Local inventory: ${timing.durationMs.toFixed(1)} ms; Git spawns: 0`);
  });
});

test('navigation accepts engine target IDs and contained relative paths only', () => {
  const target = { id: 'a'.repeat(64), repositoryId: 'web', checkoutPath: path.resolve('fixture'), available: true, workId: null, title: 'Base', phase: null, role: 'base' };
  assert.ok(runtimeInventory({ workspace: { id: 'test', name: 'Test', path: path.resolve('workspace') }, targets: [target] }));
  assert.equal(runtimeInventory({ workspace: { path: 'relative' }, targets: [target] }), null);
  assert.throws(() => runtimeTargetArgs(path.resolve('workspace'), '../../other'));
  for (const bad of ['../outside', 'src/../../outside', '.git/config', 'a\\b', '/root/file', 'x\0y']) assert.equal(safeRuntimeRelative(bad), null);
  assert.equal(safeRuntimeRelative('src/main.ts'), 'src/main.ts');
  const html = workspaceRuntimeHtml({ inventory: { workspace: { id: 'test', name: 'Test', path: path.resolve('workspace') }, targets: [target] }, selected: { ...target, title: '<script>bad()</script>' }, error: '<broken>', busy: null, section: '', files: [], folder: '', localFiles: [], evidence: false });
  assert.doesNotMatch(html, /<script>bad/); assert.match(html, /&lt;script&gt;/); assert.match(html, /Preview results never satisfy/);
});

test('launch confirmation exposes required service argv and refuses an unreadable dependency plan', () => {
  const raw = plan('web', { dependencies: [plan('api', { resolved: { beforeLaunch: [{ argv: ['node', 'build.mjs'], workingDirectory: 'services/api' }], envNames: [] } })] });
  const parsed = appPlanFrom({ entries: [raw] }); assert.deepEqual(parsed.dropped, []);
  const confirm = startConfirmationRequest(parsed.entries[0], null);
  assert.match(confirm.detail, /Required service: api/); assert.match(confirm.detail, /api\.mjs/); assert.match(confirm.detail, /build\.mjs/);
  assert.deepEqual(appPlanFrom({ entries: [plan('web', { dependencies: [{ id: 'missing-command' }] })] }).dropped, ['web']);
});

test('Story evidence confirmation names the exact checkout, phase and task argv; previews remain distinct', () => {
  const argv = ['tests', 'run', '--work-id', 'STORY-1', '--phase', 'implementation'];
  const request = testsConfirmationRequest('web', [], [], null, { workId: 'STORY-1', phase: 'implementation', checkout: path.resolve('story'), argv });
  assert.match(request.title, /STORY-1.*implementation/); assert.match(request.detail, /--work-id STORY-1/); assert.doesNotMatch(request.detail, /--capability|run is a local preview/);
  assert.match(testsConfirmationRequest('web', [], [], null).detail, /local preview/);
  for (const args of [['workspace', 'runtime', '--json'], ['app', 'connections', '--environment', 'dev', '--json']]) assert.equal(commandClass(args), 'read');
  for (const args of [['app', 'config', 'save-local'], ['app', 'config', 'reset-local'], ['env', 'files', 'override', 'dev', '.env']]) assert.equal(commandClass(args), 'mutation');
});


test('personal settings review shows the private destination and actual save-local command', async () => {
  const suggestions = await import('../apps/vscode/src/views/run-suggestions-model.ts');
  const configs = await import('../apps/vscode/src/views/run-configurations-model.ts');
  const block = { start: [], tests: [], other: {}, known: true };
  const draft = configs.draftFrom('web', block);
  const request = configs.configurationsReviewRequest({ capability: 'web', draft, block, route: { kind: 'personal' } });
  assert.match(request.summary, /personal.*checkout only/i);
  assert.match(request.detail, /app config save-local/);
  assert.doesNotMatch(request.detail, /Written to: singularity\/capabilities.yml|capability set/);
  assert.deepEqual(suggestions.applicationWriteArgv({ kind: 'personal' }, 'web', 'draft.yml'), ['app', 'config', 'save-local', '--capability', 'web', '--application-file', 'draft.yml', '--json']);
});
