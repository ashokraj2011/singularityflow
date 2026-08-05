import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/util.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

/** A bare repository to act as the workspace's source, and an isolated registry. */
async function environment() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-ws-local-'));
  const source = path.join(base, 'source.git');
  run('git', ['init', '--bare', '-q', source], { cwd: base });
  const seed = path.join(base, 'seed');
  run('git', ['init', '-q', '-b', 'main', seed], { cwd: base });
  run('git', ['config', 'user.name', 'T'], { cwd: seed });
  run('git', ['config', 'user.email', 't@example.com'], { cwd: seed });
  await writeFile(path.join(seed, 'README.md'), '# app\n');
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'init'], { cwd: seed });
  run('git', ['push', '-q', source, 'main'], { cwd: seed });
  return {
    base,
    source,
    env: {
      ...process.env,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'registry.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json')
    }
  };
}

function cli(args, env, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env });
  if (!allowFailure) assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('a workspace can be created with no tracker at all', async () => {
  // The local anchor must remain reachable through the public CLI so a Jira-less team can
  // not create a workspace once the desktop is out of the picture.
  const { base, source, env } = await environment();
  const workspaces = path.join(base, 'workspaces');
  cli(['workspace', 'create', '--local', '--id', 'demo-team', '--name', 'Demo team',
    '--base', workspaces, '--lead', 'app', '--repository', `app=${source}`, '--confirm', 'demo-team'], env);

  const listed = cli(['workspace', 'list'], env);
  assert.match(listed.stdout, /demo-team/);
  // The anchor records the local provider rather than pretending to be a tracker key.
  const status = JSON.parse(cli(['workspace', 'status', path.join(workspaces, 'demo-team'), '--json'], env).stdout);
  assert.equal(status.repositories.length, 1);
  assert.equal(status.repositories[0].id, 'app');
});

test('workspace create still refuses an ambiguous invocation', async () => {
  const { env } = await environment();
  const failure = cli(['workspace', 'create'], env, { allowFailure: true });
  assert.notEqual(failure.status, 0);
  // The error now names both routes rather than demanding a Jira key that may not exist.
  assert.match(failure.stderr, /--jira KEY, or --local --id ID/);
});

test('--dry-run previews a local workspace without creating it', async () => {
  const { base, source, env } = await environment();
  const workspaces = path.join(base, 'workspaces-dry');
  const preview = JSON.parse(cli(['workspace', 'create', '--local', '--id', 'dry-team',
    '--base', workspaces, '--lead', 'app', '--repository', `app=${source}`, '--dry-run'], env).stdout);
  assert.equal(preview.manifest.anchor.provider, 'workspace');
  assert.equal(preview.manifest.anchor.key, 'dry-team');
  const listed = cli(['workspace', 'list'], env);
  assert.doesNotMatch(listed.stdout, /dry-team/, 'a preview must not register anything');
});

test('archive and restore round-trip, and archiving demands exact confirmation', async () => {
  const { base, source, env } = await environment();
  const workspaces = path.join(base, 'workspaces');
  cli(['workspace', 'create', '--local', '--id', 'demo-team',
    '--base', workspaces, '--lead', 'app', '--repository', `app=${source}`, '--confirm', 'demo-team'], env);
  const directory = path.join(workspaces, 'demo-team');

  const refused = cli(['workspace', 'archive', directory, '--confirm', 'wrong'], env, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires exact confirmation 'demo-team'/);

  cli(['workspace', 'use', directory], env);
  const archived = cli(['workspace', 'archive', directory, '--confirm', 'demo-team'], env);
  assert.match(archived.stdout, /Archived/);
  assert.match(archived.stdout, /checkout and artifacts are untouched/, 'archiving is a registry action, not a delete');
  assert.match(archived.stdout, /active workspace selection was cleared/);
  assert.deepEqual(JSON.parse(cli(['workspace', 'current', '--json'], env).stdout), { active: false });

  cli(['workspace', 'rename', directory, '--name', 'Archived demo team', '--confirm', 'demo-team'], env);
  const archivedEntry = JSON.parse(cli(['workspace', 'list', '--json'], env).stdout)
    .find((entry) => entry.anchorKey === 'demo-team');
  assert.equal(archivedEntry.name, 'Archived demo team');
  assert.ok(archivedEntry.archivedAt, 'renaming an archived workspace must not restore it');

  const restored = cli(['workspace', 'restore', directory], env);
  assert.match(restored.stdout, /Restored/);
});

test('forgetting the active workspace also clears the active selection', async () => {
  const { base, source, env } = await environment();
  const workspaces = path.join(base, 'workspaces');
  const directory = path.join(workspaces, 'throwaway');
  cli(['workspace', 'create', '--local', '--id', 'throwaway', '--base', workspaces,
    '--lead', 'app', '--repository', `app=${source}`, '--confirm', 'throwaway'], env);
  cli(['workspace', 'use', directory], env);

  const forgotten = cli(['workspace', 'forget', directory], env);
  assert.match(forgotten.stdout, /active selection cleared/);
  const current = JSON.parse(cli(['workspace', 'current', '--json'], env).stdout);
  assert.deepEqual(current, { active: false });
});

test('a repository describes itself, so a workspace never has to be told its URL', async () => {
  // Adding a repository by typing an identifier and a clone URL is how a workspace ends up pointing
  // at the wrong fork, or at a branch nobody uses. These rules belong in the engine, where
  // neither the CLI nor the editor could reach them.
  const { base, source, env } = await environment();
  const checkout = path.join(base, 'Payments API');
  run('git', ['clone', '-q', source, checkout], { cwd: base });

  const inspected = JSON.parse(cli(['workspace', 'inspect', checkout, '--json'], env).stdout);
  assert.equal(inspected.url, source, 'the origin is read from the checkout');
  assert.equal(inspected.defaultBranch, 'main');
  assert.equal(inspected.id, 'payments-api', 'the identifier is derived from the folder, safely');
  assert.equal(inspected.localPath, await realpath(checkout));
});

test('a folder that cannot join a workspace says so while you are choosing', async () => {
  const { base, env } = await environment();

  const plain = path.join(base, 'not-a-repo');
  await mkdir(plain, { recursive: true });
  const notGit = cli(['workspace', 'inspect', plain], env, { allowFailure: true });
  assert.notEqual(notGit.status, 0);
  assert.match(notGit.stderr, /not a safe Git repository/);

  // A repository with no origin cannot be cloned into a workspace, which is better said now than
  // when the clone fails.
  const orphan = path.join(base, 'no-origin');
  await mkdir(orphan, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', orphan], { cwd: base });
  const noOrigin = cli(['workspace', 'inspect', orphan], env, { allowFailure: true });
  assert.notEqual(noOrigin.status, 0);
  assert.match(noOrigin.stderr, /no origin remote/);

  // A nested folder would clone the wrong tree.
  const nested = path.join(orphan, 'src');
  await mkdir(nested, { recursive: true });
  const inner = cli(['workspace', 'inspect', nested], env, { allowFailure: true });
  assert.notEqual(inner.status, 0);
  assert.match(inner.stderr, /repository root instead of a nested folder|not a safe Git repository/);
});

test('a repository can be inspected by URL, without cloning it first', async () => {
  // Requiring a checkout first is backwards: the repositories a team governs are named by URL long
  // before anyone clones them. ls-remote answers both questions the form needs over the network.
  const { source, env } = await environment();
  const inspected = JSON.parse(cli(['workspace', 'inspect', `file://${source}`, '--json'], env).stdout);
  assert.equal(inspected.url, `file://${source}`);
  assert.equal(inspected.defaultBranch, 'main', 'read from the remote HEAD, not assumed');
  assert.equal(inspected.localPath, null, 'nothing was cloned to answer this');
  assert.equal(inspected.hasStateBranch, false, 'this remote has no workflow state branch yet');
  assert.equal(inspected.id, 'source', 'the identifier comes from the last path segment');
});

test('inspection reports whether the workflow state branch already exists', async () => {
  // Whether a repository is joining a workspace that already records governance history, or
  // starting one, is decided at this moment and is worth showing while somebody is adding it.
  const { base, source, env } = await environment();
  const work = path.join(base, 'seed-state');
  run('git', ['clone', '-q', source, work], { cwd: base });
  run('git', ['checkout', '-q', '--orphan', 'state'], { cwd: work });
  spawnSync('git', ['rm', '-rqf', '.'], { cwd: work });
  await writeFile(path.join(work, 'README.md'), '# ledger\n');
  run('git', ['add', '-A'], { cwd: work });
  run('git', ['commit', '-qm', 'state'], { cwd: work });
  run('git', ['push', '-q', source, 'state'], { cwd: work });

  const inspected = JSON.parse(cli(['workspace', 'inspect', `file://${source}`, '--json'], env).stdout);
  assert.equal(inspected.hasStateBranch, true);
  assert.equal(inspected.stateBranch, 'state');
});

test('a URL that cannot be reached is refused while it is being typed', async () => {
  const { base, env } = await environment();
  const missing = cli(['workspace', 'inspect', `file://${path.join(base, 'no-such-repo.git')}`, '--json'],
    env, { allowFailure: true });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Cannot reach/);

  // A bare word is not a URL, so it is read as a path — and refused as one.
  const nonsense = cli(['workspace', 'inspect', 'not-a-url', '--json'], env, { allowFailure: true });
  assert.notEqual(nonsense.status, 0);
  assert.match(nonsense.stderr, /is not available|not a safe Git repository|is not a clone URL/);
});

test('a bare repository path is somewhere to clone from, not a checkout to read', async () => {
  // `file://` is a scheme people rarely type. A plain absolute path to a bare repository — a local
  // mirror, a network share, a fixture — was read as a working checkout and refused with "not a safe
  // Git repository", which describes the wrong thing entirely: it is a perfectly good remote.
  const { source, env } = await environment();
  const inspected = JSON.parse(cli(['workspace', 'inspect', source, '--json'], env).stdout);
  assert.equal(inspected.url, source);
  assert.equal(inspected.defaultBranch, 'main', 'read from the remote HEAD');
  assert.equal(inspected.localPath, null, 'nothing was cloned to answer this');

  // A path that does not exist is a remote nobody answers, reported as such rather than as a
  // complaint about the local filesystem.
  const missing = cli(['workspace', 'inspect', path.join(path.dirname(source), 'absent.git'), '--json'],
    env, { allowFailure: true });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Cannot reach/);
});

/** Push a capability map and a portfolio into the source repository. */
async function describe(base, source, { portfolio = true } = {}) {
  const seed = path.join(base, 'describe');
  run('git', ['clone', '-q', '-b', 'main', source, seed], { cwd: base });
  run('git', ['config', 'user.name', 'T'], { cwd: seed });
  run('git', ['config', 'user.email', 't@example.com'], { cwd: seed });
  await mkdir(path.join(seed, 'singularity'), { recursive: true });
  await writeFile(path.join(seed, 'singularity/capabilities.yml'), [
    'version: 1',
    'capabilities:',
    '  commerce: { name: Commerce, kind: collection, parent: null }',
    '  payments-api: { name: Payments API, kind: delivery, parent: commerce, repository: api }',
    '  storefront-web: { name: Storefront Web, kind: delivery, parent: commerce, repository: web }',
    ''
  ].join('\n'));
  if (portfolio) {
    await writeFile(path.join(seed, 'singularity/portfolio.yml'), [
      'version: 1',
      'repositories:',
      '  api: { url: "https://example.com/api.git", defaultBranch: main }',
      ''
    ].join('\n'));
  }
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'describe'], { cwd: seed });
  run('git', ['push', '-q', source, 'main'], { cwd: seed });
}

test('a lead repository reports what the organisation builds without being cloned', async () => {
  // A workspace is chosen as capabilities, and the map that lists them is inside the lead. Reading
  // it has to happen before anything is cloned, or the choice comes after the consequence.
  const { base, source, env } = await environment();
  await describe(base, source);

  const map = JSON.parse(cli(['workspace', 'capabilities', source, '--json'], env).stdout);
  assert.equal(map.reason, null);
  assert.deepEqual(map.capabilities.map((entry) => entry.id), ['commerce']);
  assert.deepEqual(map.capabilities[0].children.map((entry) => entry.id), ['payments-api', 'storefront-web']);

  // Each delivery carries where it is cloned from, because a capability you cannot clone is not a
  // choice — and the one the portfolio does not declare says so rather than going missing.
  const api = map.deliveries.find((entry) => entry.id === 'payments-api');
  assert.equal(api.repository, 'api');
  assert.equal(api.url, 'https://example.com/api.git');
  assert.equal(api.defaultBranch, 'main');
  const web = map.deliveries.find((entry) => entry.id === 'storefront-web');
  assert.equal(web.repository, 'web');
  assert.equal(web.url, null, 'the portfolio does not declare it');
});

test('a lead repository with no map says so, which is a state and not a failure', async () => {
  // A new organisation has not described itself yet. Refusing to proceed would make the product
  // unusable on day one, so this reports the absence and lets the caller offer its fallback.
  const { source, env } = await environment();
  const map = JSON.parse(cli(['workspace', 'capabilities', source, '--json'], env).stdout);
  assert.equal(map.capabilities, null);
  assert.match(map.reason, /does not contain singularity\/capabilities\.yml/);
  assert.deepEqual(map.deliveries, []);
});

test('a workspace records the capabilities it is for, not only the repositories it holds', async () => {
  // "Workspace is capabilities plus a working directory" is the concept; a manifest that recorded
  // only the repositories would have lost what the workspace was actually about.
  const { base, source, env } = await environment();
  const created = JSON.parse(cli([
    'workspace', 'create', '--local', '--json', '--id', 'commerce-platform',
    '--base', path.join(base, 'workspaces'), '--lead', 'platform',
    '--repository', `platform=${source}`,
    '--capability', 'payments', '--capability', 'commerce', '--capability', 'payments',
    '--confirm', 'commerce-platform', '--no-clone'
  ], env).stdout);

  // Deduplicated and ordered, so the same selection always reads the same way.
  assert.deepEqual(created.workspace.capabilities, ['commerce', 'payments']);

  const manifest = JSON.parse(await readFile(
    path.join(created.workspace.path, 'workspace.json'), 'utf8'));
  assert.deepEqual(manifest.capabilities, ['commerce', 'payments']);

  const refused = cli([
    'workspace', 'create', '--local', '--json', '--id', 'bad-capability',
    '--base', path.join(base, 'workspaces'), '--lead', 'platform',
    '--repository', `platform=${source}`, '--capability', 'Not Kebab',
    '--confirm', 'bad-capability', '--no-clone'
  ], env, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /must be lower-case kebab-case/);
});

test('a workspace can be copied into a different working directory', async () => {
  // A workspace is local and disposable: the same capabilities and repositories, somewhere else to
  // work on them. Nothing governed lives in it that a second copy would fork.
  const { base, source, env } = await environment();
  const workspaces = path.join(base, 'workspaces');
  cli(['workspace', 'create', '--local', '--json', '--id', 'commerce',
    '--base', workspaces, '--lead', 'platform', '--repository', `platform=${source}`,
    '--capability', 'payments', '--capability', 'commerce',
    '--confirm', 'commerce', '--no-clone'], env);

  const copied = JSON.parse(cli(['workspace', 'duplicate', path.join(workspaces, 'commerce'),
    '--id', 'commerce-spike', '--no-clone', '--json'], env).stdout);

  assert.equal(copied.workspace.path, path.join(await realpath(workspaces), 'commerce-spike'));
  assert.deepEqual(copied.workspace.capabilities, ['commerce', 'payments'], 'what it is for comes with it');
  assert.deepEqual(Object.keys(copied.workspace.repositories), ['platform']);
  assert.equal(copied.workspace.leadRepository, 'platform');
  // Named after its identifier, because the identifier is what decides the directory: a copy called
  // "commerce (copy)" would land in `commerce-spike--commerce-copy` rather than `commerce-spike`.
  assert.equal(copied.workspace.name, 'commerce-spike');

  // The original is untouched — a copy is not a move.
  const original = JSON.parse(await readFile(path.join(workspaces, 'commerce/workspace.json'), 'utf8'));
  assert.deepEqual(original.capabilities, ['commerce', 'payments']);
  assert.equal(original.name, 'commerce');
});

test('no two workspaces may share a working directory', async () => {
  // `workspace create` resumes when it finds the same workspace already there, which is right for
  // creation and wrong for copying: a duplicate landing on its own source would silently return the
  // original and report success.
  const { base, source, env } = await environment();
  const workspaces = path.join(base, 'workspaces');
  for (const id of ['alpha', 'beta']) {
    cli(['workspace', 'create', '--local', '--json', '--id', id, '--base', workspaces,
      '--lead', 'platform', '--repository', `platform=${source}`, '--confirm', id, '--no-clone'], env);
  }

  const onItself = cli(['workspace', 'duplicate', path.join(workspaces, 'alpha'),
    '--id', 'alpha', '--no-clone'], env, { allowFailure: true });
  assert.notEqual(onItself.status, 0);
  assert.match(onItself.stderr, /already workspace 'local--alpha'/);
  assert.match(onItself.stderr, /two workspaces cannot share one/);

  const onSibling = cli(['workspace', 'duplicate', path.join(workspaces, 'alpha'),
    '--id', 'beta', '--no-clone'], env, { allowFailure: true });
  assert.notEqual(onSibling.status, 0);
  assert.match(onSibling.stderr, /already workspace 'local--beta'/);

  // Refused before anything was written: beta is still beta.
  const beta = JSON.parse(await readFile(path.join(workspaces, 'beta/workspace.json'), 'utf8'));
  assert.equal(beta.id, 'local--beta');

  // The directory checked is the workspace's own root, not the base above it: a copy lands in a
  // fresh subdirectory, so a base with other workspaces in it is entirely normal.
  const elsewhere = path.join(base, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  await writeFile(path.join(elsewhere, 'unrelated.md'), '# notes\n');
  const beside = cli(['workspace', 'duplicate', path.join(workspaces, 'alpha'),
    '--id', 'alpha', '--base', elsewhere, '--no-clone'], env, { allowFailure: true });
  assert.equal(beside.status, 0, `a free subdirectory is fine: ${beside.stderr}`);

  // But a root that already holds something is refused, because a workspace lays out its own tree
  // and would otherwise be mixed in with whatever was there.
  const occupied = path.join(base, 'occupied', 'alpha');
  await mkdir(occupied, { recursive: true });
  await writeFile(path.join(occupied, 'notes.md'), '# notes\n');
  const onOccupied = cli(['workspace', 'duplicate', path.join(workspaces, 'alpha'),
    '--id', 'alpha', '--base', path.join(base, 'occupied'), '--no-clone'], env, { allowFailure: true });
  assert.notEqual(onOccupied.status, 0);
  assert.match(onOccupied.stderr, /not empty/);
});

test('a copy can be given a different name and a different base', async () => {
  const { base, source, env } = await environment();
  const workspaces = path.join(base, 'workspaces');
  const elsewhere = path.join(base, 'elsewhere');
  cli(['workspace', 'create', '--local', '--json', '--id', 'commerce', '--base', workspaces,
    '--lead', 'platform', '--repository', `platform=${source}`, '--confirm', 'commerce', '--no-clone'], env);

  const copied = JSON.parse(cli(['workspace', 'duplicate', path.join(workspaces, 'commerce'),
    '--id', 'commerce', '--base', elsewhere, '--name', 'Commerce spike',
    '--no-clone', '--json'], env).stdout);
  assert.equal(copied.workspace.name, 'Commerce spike');
  // The same identifier in a different base is fine — the directory is what must be unique. A name
  // that differs from the identifier is folded into the directory, which is why a copy left unnamed
  // is named after its identifier.
  assert.match(copied.workspace.path, /elsewhere\/commerce--commerce-spike$/);

  // Both are registered, and they are two workspaces rather than one moved.
  const listed = JSON.parse(cli(['workspace', 'list', '--json'], env).stdout);
  const paths = listed.map((entry) => entry.path);
  assert.ok(paths.includes(copied.workspace.path), 'the copy is registered');
  assert.ok(paths.some((entry) => entry.endsWith('/workspaces/commerce')), 'the original still is');
  assert.equal(new Set(paths).size, paths.length, 'no two registry entries share a directory');
});

test('a workspace can be renamed without restating everything about it', async () => {
  // Renaming is the safest edit there is, and it did not work: `workspace update --name` passed no
  // repositories to the validator and was refused for having none. An edit changes what it names.
  const { base, source, env } = await environment();
  const workspaces = path.join(base, 'workspaces');
  cli(['workspace', 'create', '--local', '--json', '--id', 'commerce', '--base', workspaces,
    '--lead', 'platform', '--repository', `platform=${source}`,
    '--capability', 'payments', '--confirm', 'commerce', '--no-clone'], env);
  const workspace = path.join(workspaces, 'commerce');

  cli(['workspace', 'update', workspace, '--name', 'Commerce platform', '--confirm', 'commerce', '--json'], env);
  let manifest = JSON.parse(await readFile(path.join(workspace, 'workspace.json'), 'utf8'));
  assert.equal(manifest.name, 'Commerce platform');
  assert.deepEqual(Object.keys(manifest.repositories), ['platform'], 'untouched');
  assert.equal(manifest.leadRepository, 'platform', 'untouched');
  assert.deepEqual(manifest.capabilities, ['payments'], 'untouched');

  // What a workspace is for is a local decision, and it changes as work moves on.
  cli(['workspace', 'update', workspace, '--capability', 'storefront', '--capability', 'checkout',
    '--confirm', 'commerce', '--json'], env);
  manifest = JSON.parse(await readFile(path.join(workspace, 'workspace.json'), 'utf8'));
  assert.deepEqual(manifest.capabilities, ['checkout', 'storefront']);
  assert.equal(manifest.name, 'Commerce platform', 'untouched');

  // The directory never moves: it was fixed at creation, and moving it is a copy.
  assert.equal(manifest.path, await realpath(workspace));
});

test('a clone URL written with a trailing slash still yields a clean identifier', async () => {
  // `.git$` does not match a string ending in a slash, so stripping the suffix before the slash
  // left `platform.git` as the repository identifier — and identifiers end up in paths, in the
  // capability map, and in every Story record.
  const { source, env } = await environment();
  const inspected = JSON.parse(cli(['workspace', 'inspect', `${source}/`, '--json'], env).stdout);
  assert.equal(inspected.id, 'source');
});
