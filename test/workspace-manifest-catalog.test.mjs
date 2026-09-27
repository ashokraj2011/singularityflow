import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run as workspaceCommand } from '../src/commands/workspace.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { workspaceAuthorityChoices } from '../apps/vscode/src/views/workspace-authority-matching.ts';

test('workspace choices read validated manifests with no per-workspace Git status or authority calls', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-manifest-catalog-'));
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'selection.json');
  const before = {
    registry: process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY,
    selection: process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE
  };
  t.after(async () => {
    for (const [key, value] of [
      ['SINGULARITY_FLOW_WORKSPACE_REGISTRY', before.registry],
      ['SINGULARITY_FLOW_ACTIVE_WORKSPACE', before.selection]
    ]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registry;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selection;
  const entries = [];
  for (let index = 0; index < 48; index += 1) {
    const id = `team-${index}`;
    const directory = path.join(root, id);
    await mkdir(directory);
    await writeFile(path.join(directory, 'workspace.json'), JSON.stringify({
      version: 1, id, name: id, anchor: { provider: 'workspace', key: id, title: id },
      leadRepository: 'app', capabilityAuthority: { url: 'https://code.example/teams/catalog.git' },
      repositories: { app: { url: `https://code.example/apps/${id}.git`, defaultBranch: 'main', path: 'repos/app' } }
    }));
    entries.push({ id, name: id, path: directory,
      // A stale/tampered registry hint must never replace the validated manifest's URL.
      capabilityAuthorityUrl: 'https://wrong.example/catalog.git' });
  }
  const broken = path.join(root, 'broken');
  await mkdir(broken);
  await writeFile(path.join(broken, 'workspace.json'), '{not-json');
  entries.push({ id: 'broken', name: 'broken', path: broken });
  await writeFile(registry, JSON.stringify(entries));
  const registryBytes = await readFile(registry, 'utf8');
  const timer = commandTimer('workspace');
  const output = [];
  const originalLog = console.log;
  try {
    console.log = (value) => output.push(value);
    await withCommandTiming(timer, () => workspaceCommand(['workspace', 'list', '--json'], {
      positionals: ['workspace', 'list'], options: { json: true }
    }));
  } finally { console.log = originalLog; }
  const rows = JSON.parse(output.join('\n'));
  assert.equal(rows.length, 49);
  assert.equal(rows.filter((row) => row.manifestStatus === 'read').length, 48);
  assert.ok(rows.slice(0, 48).every((row) => row.capabilityAuthorityUrl === 'https://code.example/teams/catalog.git'));
  assert.equal(rows.find((row) => row.id === 'broken').manifestStatus, 'unavailable');
  assert.equal(timer.finish({ outcome: 'succeeded' }).counters['git.spawns'] ?? 0, 0);
  assert.equal(await readFile(registry, 'utf8'), registryBytes, 'read-only listing must not rewrite registrations');
  const choices = workspaceAuthorityChoices(rows, 'https://code.example/teams/catalog.git');
  assert.equal(choices.matchingPaths.length, 48);
  assert.deepEqual(choices.unreadable.map((row) => row.id), ['broken']);
});

test('manifest choice matching reports unknown/unreadable rows and excludes archived rows', () => {
  const rows = [
    { id: 'one', name: 'one', path: '/one', anchorKey: 'one', manifestStatus: 'read',
      capabilityAuthorityUrl: 'https://code.example/team/catalog.git' },
    { id: 'two', name: 'two', path: '/two', anchorKey: 'two', manifestStatus: 'read',
      leadRepositoryUrl: 'https://code.example/elsewhere/catalog.git' },
    { id: 'old-cli', name: 'old-cli', path: '/old', anchorKey: 'old-cli' },
    { id: 'empty', name: 'empty', path: '/empty', anchorKey: 'empty', manifestStatus: 'read' },
    { id: 'archived', name: 'archived', path: '/archived', anchorKey: 'archived', archivedAt: '2026-09-01' }
  ];
  const result = workspaceAuthorityChoices(rows, 'https://code.example/team/catalog.git');
  assert.deepEqual(result.matchingPaths, ['/one']);
  assert.deepEqual(result.unreadable.map((row) => row.id), ['old-cli', 'empty']);
});

test('extension demand-loads readiness and matches attachment choices without the all-workspace scan', async () => {
  const source = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const startup = source.slice(source.indexOf('const startAuxiliaryReadsAfterConfirmedSnapshot'),
    source.indexOf('context.subscriptions.push(store.onDidChange', source.indexOf('const startAuxiliaryReadsAfterConfirmedSnapshot')));
  assert.doesNotMatch(startup, /void refreshReadiness\(/u);
  const attachment = source.slice(source.indexOf('const requestGeneration = ++openWorkspacesRequestGeneration'),
    source.indexOf('const onMessage = async (message: WorkspacesMessage)'));
  assert.match(attachment, /workspaceAuthorityChoices\(entries, requestedAuthority.leadUrl\)/u);
  assert.doesNotMatch(attachment, /Promise\.all\(candidates\.map|statusOnly\(/u);
  assert.match(attachment, /readController\.signal/u);
  assert.match(attachment, /cancellable: true/u);
  assert.match(attachment, /token\.onCancellationRequested\(\(\) => readController\.abort\(\)\)/u);
  assert.match(attachment, /requestGeneration === openWorkspacesRequestGeneration && !readController\.signal\.aborted/u);
  assert.match(attachment, /const list = \(\): Promise<WorkspaceEntry\[\]> => readEntries\(\)/u,
    'retained panel refresh must not inherit a transient opening signal');
  assert.match(attachment, /if \(initialCatalogue\) inspectedAuthorityOrganisation = null/u,
    'verified advisory catalog is consumed once, never a retained authority cache');
  assert.match(source, /openCapabilities[\s\S]{0,180}void refreshReadiness\(\)/u);
  const panel = await readFile(new URL('../apps/vscode/src/views/workspace-panel.ts', import.meta.url), 'utf8');
  assert.match(panel, /loadOrganisations\(options\.refresh === true/u);
  assert.match(panel, /refreshCapabilityMap\(\{\}, \{ reveal: false, refresh: true \}\)/u);
});
