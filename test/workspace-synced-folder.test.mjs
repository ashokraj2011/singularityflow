import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { run } from '../src/util.mjs';
import { assertWorkspaceLocationLocal, previewWorkspaceConfiguration } from '../src/workspace.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');
// The two platforms with a synced folder to fake: iCloud's Documents link on macOS, OneDrive's
// variable on Windows.
const supported = process.platform === 'darwin' || process.platform === 'win32';

/** A home whose Documents folder this platform treats as synced, plus isolated machine state. */
async function syncedHome(t) {
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-synced-folder-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const synced = path.join(home, process.platform === 'win32' ? 'OneDrive - Example' : 'Documents');
  await mkdir(synced, { recursive: true });
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'state', 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, 'state', 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, 'state', 'leads.json'),
    SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(root, 'state', 'bootstrap'),
    SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
    SINGULARITY_FLOW_WORKSPACE_ROOT: '',
    SINGULARITY_FLOW_NO_MODEL: '1'
  };
  if (process.platform === 'win32') {
    for (const name of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) delete env[name];
    env.OneDriveCommercial = synced;
  } else {
    const drive = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    await mkdir(drive, { recursive: true });
    await symlink(synced, path.join(drive, 'Documents'));
  }
  const remote = path.join(root, 'app.git');
  run('git', ['init', '--bare', '-q', remote], { cwd: root });
  const cwd = path.join(root, 'cwd');
  await mkdir(cwd);
  const sflow = (...args) => run(process.execPath, [cli, ...args], { cwd, env, allowFailure: true });
  return { root, home, synced, env, remote, sflow };
}

const createArgs = (fixture, id, base) => [
  'workspace', 'create', '--local', '--id', id, '--base', base,
  '--repository', `app=${fixture.remote}`, '--lead', 'app', '--confirm', id, '--json'
];

function refusal(result) {
  assert.notEqual(result.status, 0, result.stdout);
  return JSON.parse(result.stdout).error;
}

test('a planned workspace in a synced folder is refused unless the person chose it', async () => {
  const facts = { platform: 'darwin', homeDirectory: '/Users/someone', env: {}, iCloudHomeFolders: ['Documents'] };
  const input = {
    baseDirectory: '/Users/someone/Documents/ws', id: 'payments', leadRepository: 'app', capabilities: [],
    repositories: { app: { url: 'https://git.example.test/app.git', defaultBranch: 'main', required: true, path: 'repos/app' } }
  };
  await assert.rejects(assertWorkspaceLocationLocal(previewWorkspaceConfiguration(input), { facts }),
    (error) => error.code === 'WORKSPACE_SYNCED_FOLDER' && error.details.locations[0].knownFolder === 'Documents');
  const allowed = previewWorkspaceConfiguration(input);
  const found = await assertWorkspaceLocationLocal(allowed, { facts, allowSyncedFolder: true });
  assert.equal(found.length, 1);
  assert.deepEqual(allowed.syncedFolders, found, 'a dry run with the override still shows the folder');
  const local = previewWorkspaceConfiguration({ ...input, baseDirectory: '/Users/someone/Singularity Workspaces' });
  assert.deepEqual(await assertWorkspaceLocationLocal(local, { facts }), []);
  assert.equal(local.syncedFolders, undefined);
});

test('workspace create, dry run, duplicate and adopt refuse a synced folder; the override creates it', { skip: !supported }, async (t) => {
  const fixture = await syncedHome(t);
  const base = path.join(fixture.synced, 'ws');

  const dryRun = refusal(fixture.sflow(...createArgs(fixture, 'payments', base), '--dry-run'));
  assert.equal(dryRun.code, 'WORKSPACE_SYNCED_FOLDER');
  assert.ok(dryRun.message.includes(fixture.synced), dryRun.message);
  assert.ok(dryRun.message.includes(path.join(fixture.home, 'Singularity Workspaces')), dryRun.message);
  assert.match(dryRun.message, /--allow-synced-folder/);
  const create = refusal(fixture.sflow(...createArgs(fixture, 'payments', base)));
  assert.equal(create.code, 'WORKSPACE_SYNCED_FOLDER');
  assert.equal(existsSync(path.join(base, 'payments')), false, 'nothing was created');

  const created = JSON.parse(fixture.sflow(...createArgs(fixture, 'payments', base), '--allow-synced-folder').stdout);
  assert.equal(created.created, true);
  const workspace = created.workspace.path;

  const status = JSON.parse(fixture.sflow('workspace', 'status', workspace, '--json').stdout);
  const warning = status.warnings.find((entry) => entry.code === 'workspace-synced-folder');
  assert.ok(warning, JSON.stringify(status.warnings));
  assert.equal(warning.folder, fixture.synced);
  assert.match(warning.message, /workspace archive-status ".+" --fetch/);
  assert.equal(status.warnings.filter((entry) => entry.code === 'workspace-synced-folder').length, 1,
    'the repositories inside it add no second warning');
  const text = fixture.sflow('workspace', 'status', workspace);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Warning: .+ syncs\./);

  const doctor = JSON.parse(fixture.sflow('workspace', 'doctor', '--json').stdout);
  const finding = doctor.machine.findings.find((entry) => entry.id === 'workspace.synced-folder');
  assert.equal(finding?.severity, 'warning');
  assert.equal(doctor.healthy, true, 'a warning does not fail doctor');

  const duplicate = refusal(fixture.sflow('workspace', 'duplicate', workspace, '--id', 'copy', '--base', path.join(fixture.synced, 'other'), '--json'));
  assert.equal(duplicate.code, 'WORKSPACE_SYNCED_FOLDER');
  const copied = fixture.sflow('workspace', 'duplicate', workspace, '--id', 'copy', '--base', path.join(fixture.root, 'local'), '--json');
  assert.equal(copied.status, 0, copied.stdout);

  const clone = path.join(fixture.synced, 'app');
  run('git', ['clone', '-q', fixture.remote, clone], { cwd: fixture.root, env: fixture.env });
  run('git', ['-c', 'user.name=Synced Tester', '-c', 'user.email=synced@example.test', 'commit', '-q', '--allow-empty', '-m', 'seed'], { cwd: clone });
  run('git', ['push', '-q', 'origin', 'HEAD'], { cwd: clone, env: fixture.env });
  const adopt = refusal(fixture.sflow('workspace', 'adopt', clone, '--id', 'adopted', '--base', path.join(fixture.root, 'local'), '--dry-run', '--json'));
  assert.equal(adopt.code, 'WORKSPACE_SYNCED_FOLDER');
  assert.ok(adopt.message.startsWith(`${clone} is in`), 'the adopted clone, not the local workspace shell, is named');
  assert.match(adopt.message, /Clone the repository again under/);
});

test('workspace prepare blocks a synced base in preflight; the override is recorded and resumes', { skip: !supported }, async (t) => {
  const fixture = await syncedHome(t);
  const base = path.join(fixture.synced, 'ws');
  const blocked = JSON.parse(fixture.sflow('workspace', 'prepare', fixture.remote, '--id', 'blocked', '--base', base, '--branch', 'main', '--json').stdout);
  assert.equal(blocked.preflight.ready, false);
  const finding = blocked.preflight.findings.find((entry) => entry.id === 'workspace.base.synced-folder');
  assert.equal(finding?.severity, 'blocker');
  assert.match(finding.message, /--allow-synced-folder/, 'VS Code shows only the message, so it carries the remedy');
  assert.equal(blocked.preflight.checks.find((check) => check.id === 'workspace-storage').status, 'fail');
  assert.equal(blocked.plan.storage, undefined, 'plans without the override keep their earlier shape');

  const allowed = JSON.parse(fixture.sflow('workspace', 'prepare', fixture.remote, '--id', 'allowed', '--base', base, '--branch', 'main', '--allow-synced-folder', '--json').stdout);
  assert.equal(allowed.preflight.ready, true);
  assert.deepEqual(allowed.plan.storage, { allowSyncedFolder: true });
  assert.equal(allowed.preflight.findings.find((entry) => entry.id === 'workspace.base.synced-folder').severity, 'warning');
  const resumed = JSON.parse(fixture.sflow('workspace', 'bootstrap', 'resume', allowed.bootstrapId, '--confirm', 'allowed', '--json').stdout);
  assert.equal(resumed.status, 'registered');
});
