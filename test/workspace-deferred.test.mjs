// SPEC-SDA §11 Phase B: a workspace defers every application checkout until work needs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTemporaryTree, run } from '../src/util.mjs';
import {
  createWorkspace, createWorkspaceConfiguration, repairWorkspace, rememberWorkspace, saveWorkspaceConfiguration,
  workspaceStatus
} from '../src/workspace.mjs';
import { prepareWorkspaceBootstrap } from '../src/workspace-bootstrap.mjs';
import { activateWorkspaceContext } from '../src/workspace-context.mjs';
import { activeWorkspaceRepositoryRoot } from '../src/cli-entry.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

async function bareRepository(base, name) {
  const bare = path.join(base, `${name}.git`);
  const seed = path.join(base, `${name}-seed`);
  run('git', ['init', '--bare', '-q', '-b', 'main', bare], { cwd: base });
  run('git', ['init', '-q', '-b', 'main', seed], { cwd: base });
  run('git', ['config', 'user.name', 'T'], { cwd: seed });
  run('git', ['config', 'user.email', 't@example.com'], { cwd: seed });
  await writeFile(path.join(seed, 'README.md'), `# ${name}\n`);
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'init'], { cwd: seed });
  run('git', ['push', '-q', bare, 'main'], { cwd: seed });
  return bare;
}

/** Two members, an isolated registry and selection, removed after the test. */
async function environment(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-ws-deferred-'));
  t.after(() => removeTemporaryTree(base));
  return {
    base,
    app: await bareRepository(base, 'app'),
    api: await bareRepository(base, 'api'),
    env: {
      ...process.env,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'registry.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
      SINGULARITY_FLOW_AUTOMATIC_CLEANUP: 'off'
    }
  };
}

function configuration(fixture, id = 'deferred') {
  return {
    baseDirectory: path.join(fixture.base, 'workspaces'), id, name: id, leadRepository: 'app',
    repositories: {
      app: { url: fixture.app, defaultBranch: 'main', required: true, path: 'repos/app' },
      api: { url: fixture.api, defaultBranch: 'main', required: true, path: 'repos/api' }
    }
  };
}

function cli(args, env, { allowFailure = false, cwd } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env, cwd });
  if (!allowFailure) assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

const absent = async (target) => assert.equal(await stat(target).catch(() => null), null, `${target} was cloned`);
/** Neither member checkout exists (the workspace's own repos/ folder does). */
const noCheckouts = async (workspacePath) => {
  for (const id of ['app', 'api']) await absent(path.join(workspacePath, 'repos', id));
};

test('programmatic creation defers every checkout and reports it healthy with the action that clones it', async (t) => {
  const fixture = await environment(t);
  const created = await createWorkspaceConfiguration(configuration(fixture), { confirmation: 'deferred' });
  assert.equal(created.created, true);
  assert.deepEqual(created.status.repositories.map((repository) => repository.state), ['deferred', 'deferred']);
  assert.equal(created.status.healthy, true);
  assert.equal(created.status.counts.deferred, 2);
  assert.deepEqual(created.status.deferred.map((entry) => entry.repository).sort(), ['api', 'app']);
  assert.match(created.status.deferred.find((entry) => entry.repository === 'api').command,
    /^singularity-flow workspace repair ".+" --repository api$/);
  assert.deepEqual(created.codeIndex, [], 'no code index is built for a checkout that does not exist');
  await noCheckouts(created.workspace.path);
  const journal = JSON.parse(await readFile(path.join(created.workspace.path, 'logs', 'workspace-materialization.json'), 'utf8'));
  assert.deepEqual(journal.operations.map((operation) => operation.status), ['planned', 'planned']);

  // Materializing one member leaves its sibling planned, not an apparently failed clone.
  const repaired = await repairWorkspace(created.workspace.path, { repositoryIds: ['app'], statusLevel: 'readiness' });
  assert.deepEqual(repaired.repaired.map((entry) => [entry.repository, entry.status]), [['app', 'cloned']]);
  const states = Object.fromEntries(repaired.status.repositories.map((repository) => [repository.id, repository.state]));
  assert.deepEqual(states, { app: 'ready', api: 'deferred' });
  const after = JSON.parse(await readFile(path.join(created.workspace.path, 'logs', 'workspace-materialization.json'), 'utf8'));
  assert.equal(after.operations.find((operation) => operation.repository === 'api').status, 'planned');
  await absent(path.join(created.workspace.path, 'repos', 'api'));

  // A clone that existed and is gone is damage, not deferral.
  await rm(path.join(created.workspace.path, 'repos', 'app'), { recursive: true, force: true });
  const damaged = await workspaceStatus(created.workspace.path, { level: 'readiness' });
  assert.equal(damaged.repositories.find((repository) => repository.id === 'app').state, 'missing');
  assert.equal(damaged.healthy, false);
});

test('saving a configuration and preparing a bootstrap defer by default', async (t) => {
  const fixture = await environment(t);
  const saved = await saveWorkspaceConfiguration(configuration(fixture, 'saved'), { confirmation: 'saved' });
  assert.deepEqual(saved.repair, []);
  assert.equal(saved.materializationError, null);
  assert.ok(saved.status.repositories.every((repository) => repository.state === 'deferred'));
  await noCheckouts(saved.workspace.path);

  const prepared = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.app },
    createInput: configuration(fixture, 'bootstrapped')
  }, { env: { ...fixture.env, SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(fixture.base, 'bootstrap'),
    SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1' } });
  assert.equal(prepared.plan.checkout.enabled, false);
  const explicit = await prepareWorkspaceBootstrap({
    source: { kind: 'remote', reference: fixture.app },
    createInput: configuration(fixture, 'initialized'), initialize: true
  }, { env: { ...fixture.env, SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(fixture.base, 'bootstrap'),
    SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1' } });
  assert.equal(explicit.plan.checkout.enabled, true, 'state initialization still plans the checkout it writes into');
});

test('an existing cloned workspace is unchanged by the deferred default', async (t) => {
  const fixture = await environment(t);
  const input = configuration(fixture, 'cloned');
  const created = await createWorkspaceConfiguration(input, { confirmation: 'cloned', clone: true });
  assert.ok(created.status.repositories.every((repository) => repository.state === 'ready'));
  const readme = path.join(created.workspace.path, 'repos', 'api', 'README.md');
  await writeFile(readme, 'local work\n');
  const reopened = await createWorkspaceConfiguration(input, { confirmation: 'cloned' });
  assert.equal(reopened.resumed, true);
  assert.ok(reopened.status.repositories.every((repository) => repository.state === 'ready'));
  assert.equal(await readFile(readme, 'utf8'), 'local work\n', 'nothing in an existing checkout is replaced or removed');
  assert.equal((await createWorkspace({
    baseDirectory: input.baseDirectory,
    anchor: reopened.workspace.anchor,
    name: reopened.workspace.name,
    repositories: reopened.workspace.repositories,
    leadRepository: reopened.workspace.leadRepository,
    capabilities: reopened.workspace.capabilities ?? []
  }, { confirmation: 'cloned' })).status.healthy, true);
});

test('reads on a deferred workspace answer without a clone and without a refusal', async (t) => {
  const fixture = await environment(t);
  const created = JSON.parse(cli(['workspace', 'create', '--local', '--id', 'reads', '--base',
    path.join(fixture.base, 'workspaces'), '--lead', 'app', '--repository', `app=${fixture.app}`,
    '--repository', `api=${fixture.api}`, '--confirm', 'reads', '--json'], fixture.env).stdout);
  const workspacePath = created.workspace.path;
  const status = JSON.parse(cli(['workspace', 'status', workspacePath, '--json'], fixture.env).stdout);
  assert.equal(status.healthy, true);
  assert.deepEqual(status.repositories.map((repository) => repository.state), ['deferred', 'deferred']);

  const selected = cli(['workspace', 'use', workspacePath, '--repository', 'app'], fixture.env);
  assert.match(selected.stdout, /checkout deferred until work starts/);
  assert.doesNotMatch(selected.stdout, /Repair it before/);
  const current = JSON.parse(cli(['workspace', 'current', '--json'], fixture.env).stdout);
  assert.equal(current.repositoryState, 'deferred');

  const session = JSON.parse(cli(['session', 'current', '--json'], fixture.env, { cwd: fixture.base }).stdout);
  assert.equal(session.ready, false);
  assert.equal(session.reason, 'workspace-repository-deferred');
  assert.equal(session.repositoryPath, null, 'never a checkout path that does not exist');
  assert.match(session.materialize, /--repository app$/);

  const sessionWorkspace = JSON.parse(cli(['session', 'workspace', workspacePath, '--repository', 'app', '--json'],
    fixture.env, { cwd: fixture.base }).stdout);
  assert.equal(sessionWorkspace.attached, true);
  assert.equal(sessionWorkspace.repositoryState, 'deferred');
  assert.equal(sessionWorkspace.repositoryPath, null);

  const inbox = JSON.parse(cli(['inbox', '--offline', '--json'], fixture.env, { cwd: fixture.base }).stdout);
  assert.equal(inbox.repositoryState, 'deferred');
  assert.equal(inbox.count, 0);
  assert.match(inbox.detail, /not cloned yet/);

  const home = cli(['home', '--json'], fixture.env, { cwd: fixture.base });
  assert.ok(JSON.parse(home.stdout));
  const goals = JSON.parse(cli(['goal', 'list', '--json'], fixture.env, { cwd: fixture.base }).stdout);
  assert.ok(goals);
  const journal = JSON.parse(cli(['journal', 'refresh', '--json'], fixture.env, { cwd: fixture.base }).stdout);
  assert.equal(journal.data.reason, 'repository-deferred');

  const routed = cli(['status', '--json'], fixture.env, { cwd: fixture.base, allowFailure: true });
  assert.notEqual(routed.status, 0);
  assert.equal(JSON.parse(routed.stdout).error.code, 'ACTIVE_WORKSPACE_REPOSITORY_DEFERRED',
    'a read names the action that clones the member instead of reporting a broken path');
  await noCheckouts(workspacePath);
});

test('work clones only the member it runs in', async (t) => {
  const fixture = await environment(t);
  const created = await createWorkspaceConfiguration(configuration(fixture, 'work'), { confirmation: 'work' });
  await rememberWorkspace(fixture.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, created.workspace, created.status);
  await activateWorkspaceContext(fixture.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY,
    fixture.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, created.workspace.path, { repositoryId: 'app' });
  const app = path.join(created.workspace.path, 'repos', 'app');
  const api = path.join(created.workspace.path, 'repos', 'api');

  await assert.rejects(() => activeWorkspaceRepositoryRoot('nextsteps', { env: fixture.env }),
    (error) => error.code === 'ACTIVE_WORKSPACE_REPOSITORY_DEFERRED');
  await assert.rejects(() => activeWorkspaceRepositoryRoot('configuration', {
    env: fixture.env, subcommand: 'set', options: { 'dry-run': true }
  }), (error) => error.code === 'ACTIVE_WORKSPACE_REPOSITORY_DEFERRED');
  await absent(app);
  const root = await activeWorkspaceRepositoryRoot('configuration', { env: fixture.env, subcommand: 'set' });
  assert.equal(root, app, 'a repository-changing command clones the selected member and runs in it');
  assert.ok(await stat(path.join(app, '.git')));
  await absent(api);
  assert.equal(await activeWorkspaceRepositoryRoot('nextsteps', { env: fixture.env }), app);

  // Listing a sibling's environment files is a read: it reports the member as not cloned yet.
  const listed = JSON.parse(cli(['env', 'files', '--repository', 'api', '--json'], fixture.env, { cwd: app }).stdout);
  assert.deepEqual(listed.repositories.map((entry) => [entry.id, entry.repositoryState, entry.checkout]),
    [['api', 'deferred', null]]);
  assert.match(listed.repositories[0].materialize, /--repository api$/);
  await absent(api);
});

test('workspace copilot clones only its selected deferred member, and its preview clones nothing', async (t) => {
  if (process.platform === 'win32') return t.skip('the stand-in Copilot executable is a POSIX script');
  const fixture = await environment(t);
  const created = await createWorkspaceConfiguration(configuration(fixture, 'copilot'), { confirmation: 'copilot' });
  await rememberWorkspace(fixture.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, created.workspace, created.status);
  const api = path.join(created.workspace.path, 'repos', 'api');
  const preview = JSON.parse(cli(['--no-model', 'workspace', 'copilot', created.workspace.path, '--repository', 'api',
    '--dry-run'], fixture.env, { cwd: fixture.base }).stdout);
  assert.equal(preview.materialization.state, 'deferred');
  assert.equal(preview.materialization.clonedOnLaunch, true);
  await noCheckouts(created.workspace.path);

  const refused = cli(['--no-model', 'workspace', 'copilot', created.workspace.path, '--repository', 'api'],
    fixture.env, { cwd: fixture.base, allowFailure: true });
  assert.notEqual(refused.status, 0);
  await noCheckouts(created.workspace.path);

  const tools = path.join(fixture.base, 'tools');
  await mkdir(tools);
  await writeFile(path.join(tools, 'copilot'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(tools, 'copilot'), 0o755);
  cli(['workspace', 'copilot', created.workspace.path, '--repository', 'api'],
    { ...fixture.env, PATH: `${tools}${path.delimiter}${fixture.env.PATH}` }, { cwd: fixture.base });
  assert.ok(await stat(path.join(api, '.git')), 'the selected member is cloned for the session');
  await absent(path.join(created.workspace.path, 'repos', 'app'));
  const status = await workspaceStatus(created.workspace.path, { level: 'readiness' });
  assert.deepEqual(Object.fromEntries(status.repositories.map((repository) => [repository.id, repository.state])),
    { app: 'deferred', api: 'ready' });
});
