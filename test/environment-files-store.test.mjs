import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  commandScope, placeEnvironmentFilesForRun, templateCandidates, templateFor
} from '../src/environment-files.mjs';
import { writeMutablePrivateSidecar } from '../src/private-sidecar.mjs';
import { git, repository, withMachineState, writeFiles } from './helpers/environment-files-fixture.mjs';

const SPRING = 'services/api/src/main/resources/application-dev.yml';
const TEMPLATE_TEXT = 'spring:\n  datasource:\n    password: CHANGE_ME\n';

const mode = async (target) => (await lstat(target)).mode & 0o777;
const exclude = (root) => readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');

test('create from template writes a private store file, links it here, excludes it once, and records paths only', async (t) => {
  const repo = await repository(t, { files: { 'services/api/src/main/resources/application-dev.example.yml': TEMPLATE_TEXT } });
  const created = repo.json(['env', 'files', 'create', 'dev', SPRING, '--from-template']);
  assert.equal(created.status, 0, created.stderr);
  const store = path.join(repo.root, '.git', 'singularity-flow', 'environment-files', 'v1');
  const { entry, ...result } = created.value;
  assert.deepEqual(result, {
    schemaVersion: 1, resultType: 'sflow-env-file-created', scope: 'repository', repository: null, workspace: null,
    environment: 'dev', path: SPRING, kind: 'declared', source: 'store', location: path.join(store, 'dev', ...SPRING.split('/')),
    fromTemplate: 'services/api/src/main/resources/application-dev.example.yml',
    placement: { placed: [SPRING], unchanged: [], unmanaged: [], excluded: [SPRING], notes: [] }
  });
  // The resulting entry, shaped as env files lists it.
  assert.deepEqual(entry, {
    repository: null, app: null, environment: 'dev', path: SPRING, kind: 'declared', template: 'services/api/src/main/resources/application-dev.example.yml',
    source: 'store', location: result.location, status: 'placed-here', excluded: true, placedFor: 'dev', placement: 'symlink', problem: null
  });
  assert.equal(await readFile(created.value.location, 'utf8'), TEMPLATE_TEXT);
  assert.equal(await mode(created.value.location), 0o600);
  // Every private directory from environment-files down is 0700, and the registry is 0600.
  let cursor = path.dirname(created.value.location);
  while (cursor !== path.join(repo.root, '.git', 'singularity-flow')) {
    assert.equal(await mode(cursor), 0o700, cursor);
    cursor = path.dirname(cursor);
  }
  assert.equal(await mode(path.join(store, 'registry.json')), 0o600);
  const registry = JSON.parse(await readFile(path.join(store, 'registry.json'), 'utf8'));
  assert.deepEqual(Object.keys(registry.entries[0]).sort(), ['changedAt', 'createdAt', 'environment', 'linkedPath', 'origin', 'path', 'source']);
  assert.doesNotMatch(JSON.stringify(registry), /CHANGE_ME|datasource/u, 'the registry never holds contents');
  // The path is a link to the private file; Git does not see it, and the exclude line is written once.
  assert.equal(await readlink(path.join(repo.root, SPRING)), created.value.location);
  assert.equal(git(repo.root, ['status', '--porcelain']).stdout, '');
  assert.equal(repo.json(['env', 'files', 'place', 'dev']).status, 1, 'the other dev files are still missing');
  repo.json(['env', 'files', 'create', 'dev', '.env']);
  repo.json(['env', 'files', 'create', 'dev', 'apps/web/.env.dev']);
  const placed = repo.json(['env', 'files', 'place', 'dev']);
  assert.equal(placed.status, 0, placed.stderr);
  assert.deepEqual(placed.value.repositories[0].unchanged.sort(), ['.env', 'apps/web/.env.dev', SPRING].sort());
  const lines = (await exclude(repo.root)).split('\n');
  assert.equal(lines.filter((line) => line === `/${SPRING}`).length, 1);
  assert.equal(lines.filter((line) => line.startsWith('# Singularity Flow')).length, 1);
  // A second create never overwrites the file.
  const again = repo.json(['env', 'files', 'create', 'dev', SPRING]);
  assert.equal(again.status, 1);
  assert.equal(again.value.error.code, 'ENV_FILE_EXISTS');
  assert.equal(await readFile(created.value.location, 'utf8'), TEMPLATE_TEXT);
});

test('env files lists each file with its status, source, location, template and exclusion, never contents', async (t) => {
  const repo = await repository(t, { files: { 'apps/web/.env.dev.example': 'API_TOKEN=\n' } });
  repo.json(['env', 'files', 'create', 'dev', 'apps/web/.env.dev', '--from-template']);
  await writeFile(path.join(repo.root, '.env'), 'SECRET_VALUE_IN_UNMANAGED=1\n');
  const listed = repo.json(['env', 'files']);
  assert.equal(listed.status, 0, listed.stderr);
  const [listedRepository] = listed.value.repositories;
  assert.equal(listed.value.resultType, 'sflow-env-files');
  assert.equal(listedRepository.declaration, 'ready');
  assert.deepEqual(listedRepository.environments, ['dev', 'uat']);
  const [app] = listedRepository.apps;
  assert.deepEqual({ id: app.id, kind: app.kind }, { id: null, kind: 'repository' });
  const dev = Object.fromEntries(app.environments.find((entry) => entry.name === 'dev').files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(dev).sort(), ['.env', 'apps/web/.env.dev', SPRING].sort(), 'globs stay protection only');
  assert.deepEqual({ ...dev['apps/web/.env.dev'], location: null }, {
    path: 'apps/web/.env.dev', kind: 'declared', template: 'apps/web/.env.dev.example', source: 'store', location: null,
    status: 'placed-here', excluded: true, placedFor: 'dev', placement: 'symlink', problem: null
  });
  assert.equal(dev['.env'].status, 'unmanaged');
  assert.equal(dev[SPRING].status, 'missing');
  assert.equal(dev[SPRING].excluded, false);
  const uat = app.environments.find((entry) => entry.name === 'uat').files.find((file) => file.path === 'apps/web/.env.uat');
  assert.equal(uat.status, 'missing');
  assert.doesNotMatch(JSON.stringify(listed.value), /SECRET_VALUE_IN_UNMANAGED|API_TOKEN/u);
  const one = repo.json(['env', 'files', 'uat']);
  assert.deepEqual(one.value.repositories[0].apps[0].environments.map((entry) => entry.name), ['uat']);
  // The flat view the editor page reads: every file with its repository and app, every environment, the folders.
  assert.deepEqual(listed.value.environments, ['dev', 'uat']);
  assert.deepEqual(listed.value.roots, {});
  assert.deepEqual(listed.value.files.map((file) => `${file.environment}:${file.path}:${file.status}`), [
    'dev:.env:unmanaged', 'dev:apps/web/.env.dev:placed-here', `dev:${SPRING}:missing`,
    'uat:.env:unmanaged', 'uat:apps/web/.env.uat:missing', 'uat:services/api/src/main/resources/application-uat.yml:missing']);
  assert.deepEqual(Object.keys(listed.value.files[0]), ['repository', 'app', 'environment', 'path', 'kind', 'template', 'source', 'location',
    'status', 'excluded', 'placedFor', 'placement', 'problem']);
  const unknown = repo.json(['env', 'files', 'staging']);
  assert.equal(unknown.value.error.code, 'ENVIRONMENT_UNKNOWN');
});

test('templates are found by name: example, template, sample, before the last extension or appended, first wins', async (t) => {
  assert.deepEqual(templateCandidates('config/application-uat.yml'), [
    'config/application-uat.example.yml', 'config/application-uat.yml.example', 'config/application-uat.template.yml',
    'config/application-uat.yml.template', 'config/application-uat.sample.yml', 'config/application-uat.yml.sample']);
  assert.deepEqual(templateCandidates('.env.uat').slice(0, 2), ['.env.example.uat', '.env.uat.example']);
  assert.deepEqual(templateCandidates('.env'), ['.env.example', '.env.template', '.env.sample']);
  const repo = await repository(t, { files: { 'config/application-uat.yml.sample': 'a: 1\n', 'config/application-uat.yml.template': 'a: 2\n', '.env.uat.example': 'X=\n' } });
  assert.equal(await templateFor(repo.root, 'config/application-uat.yml'), 'config/application-uat.yml.template');
  assert.equal(await templateFor(repo.root, '.env.uat'), '.env.uat.example');
  await symlink(path.join(repo.root, 'README.md'), path.join(repo.root, '.env.example'));
  assert.equal(await templateFor(repo.root, '.env'), null, 'a template is a regular file, never a link');
  const refused = repo.json(['env', 'files', 'create', 'dev', '.env', '--from-template']);
  assert.equal(refused.value.error.code, 'ENV_FILE_TEMPLATE_MISSING');
});

test('a missing file refuses with ENV_FILE_MISSING naming the file, its template and both fixes', async (t) => {
  const repo = await repository(t, { files: { 'apps/web/.env.uat.example': 'API_TOKEN=\n' } });
  const refused = repo.json(['env', 'files', 'place', 'uat']);
  assert.equal(refused.status, 1);
  assert.equal(refused.value.error.code, 'ENV_FILE_MISSING');
  const { details } = refused.value.error;
  assert.equal(details.environment, 'uat');
  assert.equal(details.path, '.env');
  assert.equal(details.template, null);
  assert.deepEqual(details.commands, ['singularity-flow env files create uat .env', 'singularity-flow env files link uat .env --to <FILE>']);
  assert.deepEqual(details.files.find((entry) => entry.path === 'apps/web/.env.uat'), {
    path: 'apps/web/.env.uat', template: 'apps/web/.env.uat.example',
    commands: ['singularity-flow env files create uat apps/web/.env.uat --from-template', 'singularity-flow env files link uat apps/web/.env.uat --to <FILE>']
  });
  assert.match(refused.value.error.message, /Nothing ran\.$/u);
  assert.ok(refused.value.remediationPlan.steps.some((step) => step.command === 'singularity-flow env files create uat .env'));
  assert.equal(await lstat(path.join(repo.root, '.env')).catch(() => null), null, 'nothing was placed');
});

test('an unmanaged file is never overwritten; adopt moves it into the store and links it back', async (t) => {
  const repo = await repository(t);
  await writeFile(path.join(repo.root, '.env'), 'MINE=1\n');
  repo.json(['env', 'files', 'create', 'dev', 'apps/web/.env.dev']);
  repo.json(['env', 'files', 'create', 'dev', SPRING]);
  const placed = repo.json(['env', 'files', 'place', 'dev']);
  assert.equal(placed.status, 0, placed.stderr);
  assert.deepEqual(placed.value.repositories[0].unmanaged, ['.env']);
  assert.match(placed.value.repositories[0].notes.join('\n'), /singularity-flow env files adopt dev \.env/u);
  assert.equal(await readFile(path.join(repo.root, '.env'), 'utf8'), 'MINE=1\n');
  assert.ok((await lstat(path.join(repo.root, '.env'))).isFile());
  const adopted = repo.json(['env', 'files', 'adopt', 'dev', '.env']);
  assert.equal(adopted.status, 0, adopted.stderr);
  const location = path.join(repo.root, '.git', 'singularity-flow', 'environment-files', 'v1', 'dev', '.env');
  assert.equal(adopted.value.location, location);
  assert.equal(await readFile(location, 'utf8'), 'MINE=1\n');
  assert.equal(await mode(location), 0o600);
  assert.equal(await readlink(path.join(repo.root, '.env')), location);
  assert.equal(repo.json(['env', 'files', 'adopt', 'dev', '.env']).value.error.code, 'ENV_FILE_NOT_UNMANAGED');
  // A directory at a path is unmanaged too, and never replaced.
  await mkdir(path.join(repo.root, 'apps/web/.env.uat'), { recursive: true });
  repo.json(['env', 'files', 'create', 'uat', '.env']);
  repo.json(['env', 'files', 'create', 'uat', SPRING.replace('dev', 'uat')]);
  const uat = repo.json(['env', 'files', 'place', 'uat']);
  assert.equal(uat.status, 1, 'apps/web/.env.uat has no real file');
  assert.ok((await lstat(path.join(repo.root, 'apps/web/.env.uat'))).isDirectory());
});

test('a tracked path is a declaration error, refused before anything is placed', async (t) => {
  const repo = await repository(t, { files: { 'apps/web/.env.dev': 'TRACKED=1\n' } });
  repo.json(['env', 'files', 'create', 'dev', '.env']);
  repo.json(['env', 'files', 'create', 'dev', SPRING]);
  const refused = repo.json(['env', 'files', 'place', 'dev']);
  assert.equal(refused.value.error.code, 'ENV_FILE_TRACKED');
  assert.deepEqual(refused.value.error.details.paths, ['apps/web/.env.dev']);
  assert.equal(repo.json(['env', 'files', 'add', 'dev', 'README.md', '--personal']).value.error.code, 'ENV_FILE_TRACKED');
});

test('personal files: added and excluded at once, created, then removed with the link and the real file kept', async (t) => {
  const repo = await repository(t);
  const refusedTeam = repo.json(['env', 'files', 'add', 'dev', 'notes/mine.env']);
  assert.equal(refusedTeam.value.error.code, 'ENV_FILES_PERSONAL_REQUIRED');
  const added = repo.json(['env', 'files', 'add', 'dev', 'notes/mine.env', '--personal']);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.value.added, true);
  assert.deepEqual(added.value.placement.excluded, ['notes/mine.env']);
  assert.deepEqual(added.value.next, ['singularity-flow env files create dev notes/mine.env', 'singularity-flow env files link dev notes/mine.env --to <FILE>']);
  assert.match(await exclude(repo.root), /^\/notes\/mine\.env$/mu);
  assert.equal(repo.json(['env', 'files', 'add', 'dev', 'notes/mine.env', '--personal']).value.added, false);
  assert.equal(repo.json(['env', 'files', 'add', 'dev', '.env', '--personal']).value.error.code, 'ENV_FILE_ALREADY_DECLARED');
  assert.equal(repo.json(['env', 'files', 'add', 'qa', 'x.env', '--personal']).value.error.code, 'ENVIRONMENT_UNKNOWN');
  const created = repo.json(['env', 'files', 'create', 'dev', 'notes/mine.env']);
  assert.equal(created.value.kind, 'personal');
  const listed = repo.json(['env', 'files', 'dev']).value.repositories[0].apps[0].environments[0].files.find((file) => file.path === 'notes/mine.env');
  assert.deepEqual([listed.kind, listed.status], ['personal', 'placed-here']);
  const removed = repo.json(['env', 'files', 'remove', 'dev', 'notes/mine.env', '--personal']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual([removed.value.removed, removed.value.removedLink, removed.value.kept, removed.value.entry], [true, true, created.value.location, null]);
  assert.equal(await lstat(path.join(repo.root, 'notes/mine.env')).catch(() => null), null);
  assert.ok((await lstat(created.value.location)).isFile(), 'the real file is kept');
  assert.equal(repo.json(['env', 'files', 'remove', 'dev', '.env', '--personal']).value.error.code, 'ENV_FILE_NOT_PERSONAL');
});

test('link uses an existing readable file, refuses directories, loops, unreadable, tracked and in-checkout files, and unlink stops', async (t) => {
  const repo = await repository(t);
  const outside = path.join(repo.base, 'mine');
  await writeFiles(outside, { 'dev.env': 'TOKEN=abc\n', 'locked.env': 'X=1\n' });
  const linked = repo.json(['env', 'files', 'link', 'dev', '.env', '--to', path.join(outside, 'dev.env')]);
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(linked.value.source, 'linked');
  assert.equal(await readlink(path.join(repo.root, '.env')), path.join(outside, 'dev.env'));
  const where = repo.json(['env', 'files', 'path', 'dev', '.env']).value;
  assert.deepEqual([where.source, where.location, where.status, where.exists], ['linked', path.join(outside, 'dev.env'), 'placed-here', true]);
  const refusal = (to) => repo.json(['env', 'files', 'link', 'dev', SPRING, '--to', to]).value.error;
  assert.equal(refusal(outside).details?.reason ?? refusal(outside).code, 'ENV_FILE_LINK_INVALID');
  assert.match(refusal(outside).message, /is a directory/u);
  await symlink(path.join(outside, 'loop-b'), path.join(outside, 'loop-a'));
  await symlink(path.join(outside, 'loop-a'), path.join(outside, 'loop-b'));
  assert.match(refusal(path.join(outside, 'loop-a')).message, /symbolic link loop/u);
  await chmod(path.join(outside, 'locked.env'), 0o000);
  if (process.getuid?.() !== 0) assert.match(refusal(path.join(outside, 'locked.env')).message, /cannot be read/u);
  assert.match(refusal(path.join(repo.root, 'README.md')).message, /inside a checkout of this repository/u);
  const other = path.join(repo.base, 'other');
  git(repo.base, ['init', '-q', '-b', 'main', other]);
  await writeFiles(other, { 'tracked.env': 'T=1\n' });
  git(other, ['add', '-A']);
  git(other, ['commit', '-q', '-m', 'other']);
  assert.match(refusal(path.join(other, 'tracked.env')).message, /is tracked in the Git repository/u);
  const cleared = repo.json(['env', 'files', 'unlink', 'dev', '.env']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual([cleared.value.resultType, cleared.value.source, cleared.value.exists, cleared.value.entry.status], ['sflow-env-file-unlinked', 'store', false, 'missing']);
  assert.equal(repo.json(['env', 'files', 'link', 'dev', '.env', '--clear']).status, 0, 'link --clear stays an alias of unlink');
  assert.equal(await lstat(path.join(repo.root, '.env')).catch(() => null), null, 'the link to the file no longer used is removed');
  assert.equal(await readFile(path.join(outside, 'dev.env'), 'utf8'), 'TOKEN=abc\n', 'the linked file itself is never touched');
});

test('a Story worktree gets links into the one shared store, excluded through the common .git/info/exclude', async (t) => {
  const repo = await repository(t);
  for (const file of ['.env', 'apps/web/.env.dev', SPRING]) repo.json(['env', 'files', 'create', 'dev', file]);
  const worktree = path.join(repo.base, 'story-worktree');
  git(repo.root, ['worktree', 'add', '-q', '-b', 'story/QF-1', worktree]);
  const placed = repo.json(['env', 'files', 'place', 'dev'], { cwd: worktree });
  assert.equal(placed.status, 0, placed.stderr);
  assert.deepEqual(placed.value.repositories[0].placed.sort(), ['.env', 'apps/web/.env.dev', SPRING].sort());
  const store = path.join(await realpath(path.join(repo.root, '.git')), 'singularity-flow', 'environment-files', 'v1');
  assert.equal(await readlink(path.join(worktree, '.env')), path.join(store, 'dev', '.env'));
  assert.equal(git(worktree, ['status', '--porcelain']).stdout, '');
  assert.equal(git(worktree, ['check-ignore', '-q', 'apps/web/.env.dev'], { allowFailure: true }).status, 0);
  const where = repo.json(['env', 'files', 'path', 'dev', '.env'], { cwd: worktree }).value;
  assert.equal(where.location, path.join(store, 'dev', '.env'));
  assert.equal(where.status, 'placed-here');
});

test('a shared path switches environment, refused while an app started in the other environment still uses it', async (t) => {
  const repo = await repository(t);
  for (const environment of ['dev', 'uat']) {
    for (const file of ['.env', 'apps/web/.env.' + environment, SPRING.replace('dev', environment)]) repo.json(['env', 'files', 'create', environment, file]);
  }
  const dev = repo.json(['env', 'files', 'place', 'dev']);
  assert.equal(dev.status, 0, dev.stderr);
  const store = path.join(repo.root, '.git', 'singularity-flow', 'environment-files', 'v1');
  assert.equal(await readlink(path.join(repo.root, '.env')), path.join(store, 'dev', '.env'));
  const uat = repo.json(['env', 'files', 'place', 'uat']);
  assert.equal(uat.status, 0, uat.stderr);
  assert.equal(await readlink(path.join(repo.root, '.env')), path.join(store, 'uat', '.env'));
  const status = repo.json(['env', 'files']).value.repositories[0].apps[0].environments;
  assert.equal(status.find((entry) => entry.name === 'dev').files.find((file) => file.path === '.env').placedFor, 'uat');
  // An application started from SFlow in uat holds the shared .env of this checkout.
  await writeMutablePrivateSidecar(repo.root, path.join(repo.root, '.git', 'singularity-flow', 'app', 'web', 'web.json'), JSON.stringify({
    format: 'sflow-app-run/v1', capability: 'web', id: 'web', pid: process.pid, url: 'http://127.0.0.1:1/', startedAt: new Date().toISOString(),
    commandSha256: `sha256:${'a'.repeat(64)}`, environment: 'uat', environmentFiles: { checkout: await realpath(repo.root), paths: ['.env'] }
  }), { maximumBytes: 16_384 });
  const refused = repo.json(['env', 'files', 'place', 'dev']);
  assert.equal(refused.value.error.code, 'ENV_FILE_IN_USE');
  assert.deepEqual([refused.value.error.details?.paths, refused.value.remediationPlan.steps[0].command], [['.env'], 'singularity-flow app stop web --capability web']);
  assert.equal(await readlink(path.join(repo.root, '.env')), path.join(store, 'uat', '.env'), 'nothing switched');
  assert.equal(repo.json(['env', 'files', 'place', 'uat']).status, 0, 'the same environment still places');
});

test('Windows: the file is copied, refreshed at each run and noted; a copy someone edited is left alone', async (t) => {
  const repo = await repository(t);
  for (const file of ['.env', 'apps/web/.env.dev', SPRING]) repo.json(['env', 'files', 'create', 'dev', file]);
  const store = path.join(repo.root, '.git', 'singularity-flow', 'environment-files', 'v1', 'dev');
  await writeFile(path.join(store, '.env'), 'API_TOKEN=first-value-1234\n');
  // The created links are replaced by copies on the first Windows run.
  const first = await withMachineState(repo.env, () => placeEnvironmentFilesForRun(repo.root, 'dev', { platform: 'win32' }));
  assert.deepEqual(first.placed.sort(), ['.env', 'apps/web/.env.dev', SPRING].sort());
  assert.ok(first.notes.some((note) => /\.env is a copy of .*refreshed at each run on Windows; edit the real file, never the copy\./u.test(note)));
  const copy = await lstat(path.join(repo.root, '.env'));
  assert.ok(copy.isFile() && !copy.isSymbolicLink());
  assert.equal(await readFile(path.join(repo.root, '.env'), 'utf8'), 'API_TOKEN=first-value-1234\n');
  assert.equal(git(repo.root, ['status', '--porcelain']).stdout, '');
  await writeFile(path.join(store, '.env'), 'API_TOKEN=second-value-5678\n');
  const second = await withMachineState(repo.env, () => placeEnvironmentFilesForRun(repo.root, 'dev', { platform: 'win32' }));
  assert.ok(second.placed.includes('.env'));
  assert.equal(await readFile(path.join(repo.root, '.env'), 'utf8'), 'API_TOKEN=second-value-5678\n');
  const listed = repo.json(['env', 'files', 'dev']).value.repositories[0].apps[0].environments[0].files.find((file) => file.path === '.env');
  assert.deepEqual([listed.status, listed.placement], ['placed-here', 'copy']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(repo.root, '.env'), 'EDITED_COPY=1\n');
  const third = await withMachineState(repo.env, () => placeEnvironmentFilesForRun(repo.root, 'dev', { platform: 'win32' }));
  assert.deepEqual(third.unmanaged, ['.env']);
  assert.equal(await readFile(path.join(repo.root, '.env'), 'utf8'), 'EDITED_COPY=1\n');
});

test('env files refuses unknown options and positional words, and reads the scope of any checkout', async (t) => {
  const repo = await repository(t);
  const options = repo.json(['env', 'files', 'create', 'dev', '.env', '--to', 'x']);
  assert.equal(options.value.error.code, 'ENV_FILES_INVALID');
  assert.match(options.value.error.message, /--to is not accepted/u);
  assert.equal(repo.json(['env', 'files', 'create', 'dev']).value.error.code, 'ENV_FILES_INVALID');
  assert.equal(repo.json(['env', 'files', 'path', 'dev', '../x']).value.error.code, 'ENV_FILES_INVALID');
  assert.equal(repo.json(['env', 'files', 'path', 'dev', 'config/*.local.yml']).value.error.code, 'ENV_FILES_INVALID');
  assert.equal(repo.json(['env', 'files', 'path', 'dev', 'other/file.env']).value.error.code, 'ENV_FILE_UNDECLARED');
  assert.equal(repo.json(['env', 'files', '--workspace']).value.error.code, 'ENV_FILES_WORKSPACE_REQUIRED');
  assert.equal(repo.json(['env', 'files', 'root', 'dev', repo.base]).value.error.code, 'ENV_FILES_WORKSPACE_REQUIRED');
  const scope = await withMachineState(repo.env, () => commandScope(repo.root));
  assert.equal(scope.kind, 'repository');
  assert.equal(repo.sflow(['env', 'files']).status, 0);
});
