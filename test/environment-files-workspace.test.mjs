import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { placeEnvironmentFilesForRun } from '../src/environment-files.mjs';
import { cliRunner, git, machineEnvironment, withMachineState, writeFiles } from './helpers/environment-files-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const APP = `schemaVersion: 1
environments:
  dev:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://dev.example.test" }
    localFiles: [.env.dev]
  uat:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://uat.example.test" }
    localFiles: [.env.uat]
`;
const API = `schemaVersion: 1
environments:
  dev:
    requires:
      - { name: DB_URL, kind: endpoint, value: "https://db.dev.example.test" }
    localFiles: [config/dev.yml]
`;

async function source(base, name, files) {
  const bare = path.join(base, `${name}.git`);
  git(base, ['init', '--bare', '-q', '-b', 'main', bare]);
  const seed = path.join(base, `seed-${name}`);
  git(base, ['init', '-q', '-b', 'main', seed]);
  await writeFiles(seed, { 'README.md': `# ${name}\n`, ...files });
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['push', '-q', bare, 'main']);
  return bare;
}

async function workspace(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'sflow-envf-ws-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = machineEnvironment(base);
  const app = await source(base, 'app', { 'singularity/environments.yml': APP });
  const api = await source(base, 'api', { 'singularity/environments.yml': API });
  const workspaces = path.join(base, 'workspaces');
  const { sflow } = cliRunner(env, base);
  const created = sflow(['workspace', 'create', '--local', '--id', 'team', '--base', workspaces, '--lead', 'app',
    '--repository', `app=${app}`, '--repository', `api=${api}`, '--confirm', 'team', '--clone', '--json']);
  assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
  const directory = path.join(workspaces, 'team');
  const used = sflow(['workspace', 'use', directory, '--repository', 'app', '--json']);
  assert.equal(used.status, 0, used.stderr);
  const appCheckout = path.join(directory, 'repos', 'app');
  const apiCheckout = path.join(directory, 'repos', 'api');
  return { base, env, directory, appCheckout, apiCheckout, ...cliRunner(env, appCheckout) };
}

test('a two-repository workspace: one store per repository, one view across them, a folder per environment and workspace-level files', slowLane({ timeout: 240_000 }), async (t) => {
  const ws = await workspace(t);
  const view = ws.json(['env', 'files', '--workspace']);
  assert.equal(view.status, 0, view.stderr);
  assert.equal(view.value.scope, 'workspace');
  assert.deepEqual(view.value.repositories.map((repository) => [repository.id, repository.declaration]), [['api', 'ready'], ['app', 'ready']]);
  const files = (id) => view.value.repositories.find((repository) => repository.id === id).apps.flatMap((app) => app.environments
    .flatMap((environment) => environment.files.map((file) => `${environment.name}:${file.path}:${file.status}`)));
  assert.deepEqual(files('app'), ['dev:.env.dev:missing', 'uat:.env.uat:missing']);
  assert.deepEqual(files('api'), ['dev:config/dev.yml:missing']);
  assert.equal(view.value.workspace.id, 'local--team');
  assert.deepEqual(view.value.workspace.files, []);

  // From the app checkout, a file of the api repository goes to api's own store and checkout.
  const apiFile = ws.json(['env', 'files', 'create', 'dev', 'config/dev.yml', '--repository', 'api']);
  assert.equal(apiFile.status, 0, apiFile.stderr);
  assert.equal(apiFile.value.repository, 'api');
  assert.equal(apiFile.value.location, path.join(ws.apiCheckout, '.git', 'singularity-flow', 'environment-files', 'v1', 'dev', 'config', 'dev.yml'));
  assert.equal(await readlink(path.join(ws.apiCheckout, 'config', 'dev.yml')), apiFile.value.location);
  assert.match(await readFile(path.join(ws.apiCheckout, '.git', 'info', 'exclude'), 'utf8'), /^\/config\/dev\.yml$/mu);
  assert.equal(ws.json(['env', 'files', 'create', 'dev', '.env.dev', '--repository', 'nope']).value.error.code, 'ENV_FILES_REPOSITORY_UNKNOWN');

  // A folder for uat across every repository: <root>/<repository-id>/<path>.
  const folder = path.join(ws.base, 'team-secrets', 'uat');
  await mkdir(folder, { recursive: true });
  const root = ws.json(['env', 'files', 'root', 'uat', folder]);
  assert.equal(root.status, 0, root.stderr);
  assert.deepEqual([root.value.workspace.id, root.value.root], ['local--team', folder]);
  const settings = await readFile(root.value.settings, 'utf8');
  assert.equal(path.dirname(path.dirname(path.dirname(root.value.settings))), path.join(ws.base, 'state'), 'beside the workspace registry');
  assert.match(settings, /"local--team"/u);
  assert.equal((await lstat(root.value.settings)).mode & 0o777, 0o600);
  const expected = ws.json(['env', 'files', 'path', 'uat', '.env.uat']).value;
  assert.deepEqual([expected.source, expected.location, expected.exists], ['root', path.join(folder, 'app', '.env.uat'), false]);
  const created = ws.json(['env', 'files', 'create', 'uat', '.env.uat']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.value.location, path.join(folder, 'app', '.env.uat'));
  assert.equal((await lstat(created.value.location)).mode & 0o777, 0o600);
  assert.equal(await readlink(path.join(ws.appCheckout, '.env.uat')), created.value.location);
  assert.equal(ws.json(['env', 'files', 'root', 'uat', ws.apiCheckout]).value.error.code, 'ENV_FILES_ROOT_INVALID', 'never inside a repository');

  // A workspace-level file outside every repository, in the workspace-level private store.
  assert.equal(ws.json(['env', 'files', 'add', 'dev', '.env', '--personal', '--workspace']).status, 0);
  assert.equal(ws.json(['env', 'files', 'add', 'dev', 'repos/app/x.env', '--personal', '--workspace']).value.error.code, 'ENV_FILE_IN_REPOSITORY');
  const level = ws.json(['env', 'files', 'create', 'dev', '.env', '--workspace']);
  assert.equal(level.status, 0, level.stderr);
  assert.equal(level.value.scope, 'workspace');
  const levelStore = path.join(ws.base, 'state', 'environment-files', 'v1', 'workspaces', 'local--team', 'dev', '.env');
  assert.equal(level.value.location, levelStore);
  assert.equal((await lstat(levelStore)).mode & 0o777, 0o600);
  for (const directory of [path.dirname(levelStore), path.join(ws.base, 'state', 'environment-files')]) assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal(await readlink(path.join(ws.directory, '.env')), levelStore);

  // Placing for the workspace: each repository's files in its checkout, plus the workspace's own.
  ws.json(['env', 'files', 'create', 'dev', '.env.dev']);
  const placed = ws.json(['env', 'files', 'place', 'dev', '--workspace']);
  assert.equal(placed.status, 0, placed.stderr);
  assert.deepEqual(placed.value.repositories.map((repository) => [repository.id, repository.files]), [['api', ['config/dev.yml']], ['app', ['.env.dev']]]);
  assert.deepEqual(placed.value.workspace.files, ['.env']);
  const after = ws.json(['env', 'files', 'dev', '--workspace']).value;
  assert.deepEqual(after.workspace.files.map((file) => [file.path, file.kind, file.status, file.excluded]), [['.env', 'personal', 'placed-here', null]]);
  assert.deepEqual(after.workspace.roots, { uat: folder });
  assert.deepEqual(after.roots, { uat: folder });
  assert.deepEqual(after.environments, ['dev', 'uat'], 'every declared environment, with files or not');
  assert.deepEqual(after.files.map((file) => [file.repository, file.environment, file.path, file.status]), [
    ['api', 'dev', 'config/dev.yml', 'placed-here'], ['app', 'dev', '.env.dev', 'placed-here'], [null, 'dev', '.env', 'placed-here']]);

  // A run in a member repository places the workspace-level file too.
  await rm(path.join(ws.directory, '.env'));
  const run = await withMachineState(ws.env, () => placeEnvironmentFilesForRun(ws.appCheckout, 'dev'));
  assert.deepEqual(run.workspace, { id: 'local--team', placed: ['.env'], unmanaged: [] });
  assert.equal(await readlink(path.join(ws.directory, '.env')), levelStore);
  for (const checkout of [ws.appCheckout, ws.apiCheckout]) assert.equal(git(checkout, ['status', '--porcelain']).stdout, '');
});
