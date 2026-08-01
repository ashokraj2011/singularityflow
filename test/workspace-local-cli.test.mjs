import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
