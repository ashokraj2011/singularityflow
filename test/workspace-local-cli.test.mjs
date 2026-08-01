import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
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
  // The local anchor existed but was reachable only from the desktop app, so a Jira-less team could
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

  const archived = cli(['workspace', 'archive', directory, '--confirm', 'demo-team'], env);
  assert.match(archived.stdout, /Archived/);
  assert.match(archived.stdout, /files are untouched/, 'archiving is a registry action, not a delete');

  const restored = cli(['workspace', 'restore', directory], env);
  assert.match(restored.stdout, /Restored/);
});

test('a repository describes itself, so a workspace never has to be told its URL', async () => {
  // Adding a repository by typing an identifier and a clone URL is how a workspace ends up pointing
  // at the wrong fork, or at a branch nobody uses. These rules lived in the Electron layer, where
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
