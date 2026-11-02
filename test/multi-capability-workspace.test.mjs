import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../src/util.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

/** One machine: its own HOME, registries and caches under `root`, and a fixture Git identity. */
function machine(root) {
  return {
    ...isolatedTestEnvironment(root),
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Capability Reviewer',
    SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(root, 'organisation-cache'),
    SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(root, 'bootstrap'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(root, 'transport-outbox'),
    SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Capability Reviewer',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'capability.reviewer@example.com'
  };
}

async function remoteRepository(base, name, files) {
  const source = path.join(base, 'sources', name);
  const remote = path.join(base, 'remotes', `${name}.git`);
  await mkdir(source, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], { cwd: source });
  run('git', ['config', 'user.name', 'Fixture Author'], { cwd: source });
  run('git', ['config', 'user.email', 'fixture.author@example.com'], { cwd: source });
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), text);
  }
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'application baseline'], { cwd: source });
  await mkdir(path.dirname(remote), { recursive: true });
  run('git', ['clone', '-q', '--bare', source, remote], { cwd: base });
  return remote;
}

function invokeJson(env, cwd, args, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd, env, encoding: 'utf8', timeout: childTimeout(180_000)
  });
  assert.equal(result.status, expectStatus,
    `singularity-flow ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const text = result.status === 0 ? result.stdout : (result.stdout.trim() || result.stderr);
  try { return JSON.parse(text); } catch (error) {
    return assert.fail(`Command did not return JSON (${error.message}):\n${result.stdout}\n${result.stderr}`);
  }
}

function mapAndActivate(env, cwd, lead, id, extra) {
  const mapped = invokeJson(env, cwd, ['capability', 'map', id, '--lead', lead, ...extra]);
  const activated = invokeJson(env, cwd, [
    'capability', 'activate', mapped.branch, '--lead', lead, '--confirm', mapped.commit, '--acknowledge-unprotected'
  ]);
  assert.equal(activated.status, 'activated', JSON.stringify(activated));
  return { mapped, activated };
}

/** The approved map as `{ id: { parent, repository, sourceRoots } }`, read from the authority. */
function approvedMap(env, cwd, lead) {
  const organisation = invokeJson(env, cwd, ['capability', 'organisation', lead, '--refresh']);
  const flat = {};
  const walk = (nodes, parent = null) => {
    for (const node of nodes ?? []) {
      flat[node.id] = { parent, repository: node.repository ?? null, sourceRoots: node.sourceRoots ?? [] };
      walk(node.children, node.id);
    }
  };
  walk(organisation.capabilities);
  return flat;
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-multi-capability-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = machine(path.join(base, 'machine-a'));
  const platform = await remoteRepository(base, 'platform', { 'README.md': '# platform\n' });
  const payments = await remoteRepository(base, 'payments-api', {
    'package.json': '{ "name": "payments", "scripts": { "test": "node --test" } }\n',
    'src/pay.js': 'export const pay = () => 1;\n'
  });
  const orders = await remoteRepository(base, 'orders-svc', {
    'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>o</groupId><artifactId>orders</artifactId><version>1</version></project>\n',
    'core/src/main/java/Core.java': 'class Core {}\n',
    'reporting/src/main/java/Report.java': 'class Report {}\n'
  });
  const analytics = await remoteRepository(base, 'analytics', {
    'pyproject.toml': '[project]\nname = "analytics"\nversion = "0.1"\n',
    'analytics/a.py': 'X = 1\n'
  });
  return { base, env, platform, payments, orders, analytics };
}

function startStory(env, cwd, id, capability) {
  return invokeJson(env, cwd, [
    'start', id, '--title', `Change ${capability}`, '--description', `Change ${capability}.`,
    '--acceptance-criteria', `${capability} still works.`, '--from-branch', 'main', '--work-type', 'feature',
    '--capability', capability
  ]);
}

function pinnedSource(cwd, id) {
  return JSON.parse(run('git', ['show', `${id}:singularity/configuration-source.json`], { cwd }).stdout);
}

test('capabilities added one after another keep every earlier mapping, attach to one workspace and each start a Story', slowLane({
  timeout: 600_000
}), async (t) => {
  const { base, env, platform, payments, orders, analytics } = await fixture(t);

  // Each addition is its own reviewed proposal; every earlier capability survives unchanged.
  const additions = [
    ['payments', ['--name', 'Payments', '--kind', 'delivery', '--repository', payments]],
    ['commerce', ['--name', 'Commerce', '--kind', 'collection']],
    ['orders-core', ['--name', 'Orders core', '--kind', 'delivery', '--repository', orders,
      '--parent', 'commerce', '--source-roots', 'core']],
    ['orders-reporting', ['--name', 'Orders reporting', '--kind', 'delivery', '--repository', orders,
      '--parent', 'commerce', '--source-roots', 'reporting']],
    ['analytics', ['--name', 'Analytics', '--kind', 'delivery', '--repository', analytics, '--app-id', 'APP-77']]
  ];
  let previous = {};
  for (const [id, extra] of additions) {
    mapAndActivate(env, base, platform, id, extra);
    const map = approvedMap(env, base, platform);
    for (const [earlier, value] of Object.entries(previous)) {
      assert.deepEqual(map[earlier], value, `${earlier} is unchanged after adding ${id}`);
    }
    assert.ok(map[id], `${id} is in the approved map`);
    assert.equal(Object.keys(map).length, Object.keys(previous).length + 1, 'nothing duplicated or lost');
    previous = map;
  }
  assert.deepEqual(previous['orders-core'], { parent: 'commerce', repository: 'orders-svc', sourceRoots: ['core'] });
  assert.deepEqual(previous['orders-reporting'], { parent: 'commerce', repository: 'orders-svc', sourceRoots: ['reporting'] });
  const organisation = invokeJson(env, base, ['capability', 'organisation', platform]);
  const analyticsNode = organisation.capabilities.find((node) => node.id === 'analytics');
  assert.equal(analyticsNode.appId, 'APP-77', 'tracking fields stay on their own capability');
  assert.equal(organisation.capabilities.find((node) => node.id === 'payments').appId ?? null, null);
  const fsck = invokeJson(env, base, ['capability', 'fsck', '--lead', platform]);
  assert.equal(fsck.valid, true, JSON.stringify(fsck.checks));

  // One workspace, then every other capability attached to it.
  const prepared = invokeJson(env, base, [
    'workspace', 'prepare', platform, '--id', 'commerce-work', '--name', 'Commerce Work',
    '--base', path.join(base, 'workspaces'), '--capability', 'payments', '--lead-capability', 'payments',
    '--clone', '--initialize'
  ]);
  const ready = invokeJson(env, base, ['workspace', 'bootstrap', 'resume', prepared.bootstrapId, '--confirm', 'commerce-work']);
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const workspacePath = ready.result.workspace.path;
  for (const capability of ['orders-core', 'orders-reporting', 'analytics', 'commerce']) {
    const preview = invokeJson(env, base, ['workspace', 'attach-capability', workspacePath, capability, '--dry-run']);
    const attached = invokeJson(env, base, [
      'workspace', 'attach-capability', workspacePath, capability, '--confirm-plan', preview.planId
    ]);
    assert.equal(attached.changed, true, capability);
  }
  const manifest = JSON.parse(await readFile(path.join(workspacePath, 'workspace.json'), 'utf8'));
  assert.deepEqual([...manifest.capabilities].sort(),
    ['analytics', 'commerce', 'orders-core', 'orders-reporting', 'payments']);
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.repositories)
    .map(([id, repository]) => [id, [...repository.capabilities].sort()])), {
    'payments-api': ['payments'],
    'orders-svc': ['orders-core', 'orders-reporting'],
    analytics: ['analytics']
  }, 'two capabilities in one repository share its single clone');

  // A Story against each delivery capability, pinned to the organisation authority.
  const platformConfiguration = run('git', ['rev-parse', 'sflow/config'], { cwd: platform }).stdout.trim();
  let number = 0;
  for (const [capability, repositoryId] of [['payments', 'payments-api'], ['orders-core', 'orders-svc'],
    ['orders-reporting', 'orders-svc'], ['analytics', 'analytics']]) {
    number += 1;
    const checkout = path.join(workspacePath, manifest.repositories[repositoryId].path);
    invokeJson(env, base, ['workspace', 'use', 'commerce-work', '--repository', repositoryId]);
    const started = startStory(env, checkout, `MC-${number}`, capability);
    assert.equal(started.outcome.status, 'succeeded');
    const source = pinnedSource(checkout, `MC-${number}`);
    assert.equal(source.repository, platform);
    assert.equal(source.commit, platformConfiguration);
    const workflow = JSON.parse(run('git', ['show', `MC-${number}:singularity/work-items/MC-${number}/workflow.json`],
      { cwd: checkout }).stdout);
    assert.equal(workflow.resolution.capability.id, capability);
    assert.equal(workflow.resolution.capability.repositoryId, repositoryId);
    run('git', ['checkout', '-q', 'main'], { cwd: checkout });
  }

  // A second capability map: a capability lands only in the map chosen for it.
  const second = await remoteRepository(base, 'platform-two', { 'README.md': '# platform two\n' });
  const before = approvedMap(env, base, platform);
  mapAndActivate(env, base, second, 'billing', ['--name', 'Billing', '--kind', 'delivery', '--repository', payments]);
  assert.deepEqual(Object.keys(approvedMap(env, base, second)), ['billing']);
  assert.deepEqual(approvedMap(env, base, platform), before, 'the first map is untouched');
});

test('two machines proposing capabilities against the same map both land, and a second machine sees all of them', slowLane({
  timeout: 300_000
}), async (t) => {
  const { base, env, platform, payments, orders, analytics } = await fixture(t);
  const other = machine(path.join(base, 'machine-b'));
  mapAndActivate(env, base, platform, 'payments', ['--name', 'Payments', '--kind', 'delivery', '--repository', payments]);
  const fromA = invokeJson(env, base, ['capability', 'map', 'orders-core', '--lead', platform,
    '--name', 'Orders core', '--kind', 'delivery', '--repository', orders]);
  const fromB = invokeJson(other, base, ['capability', 'map', 'analytics', '--lead', platform,
    '--name', 'Analytics', '--kind', 'delivery', '--repository', analytics]);
  assert.equal(fromA.baseCommit, fromB.baseCommit, 'both proposals start from the same approved map');
  for (const [machineEnv, proposal] of [[env, fromA], [other, fromB]]) {
    const activated = invokeJson(machineEnv, base, ['capability', 'activate', proposal.branch, '--lead', platform,
      '--confirm', proposal.commit, '--acknowledge-unprotected']);
    assert.equal(activated.status, 'activated');
  }
  for (const machineEnv of [env, other]) {
    assert.deepEqual(Object.keys(approvedMap(machineEnv, base, platform)).sort(), ['analytics', 'orders-core', 'payments']);
  }
  const prepared = invokeJson(other, base, ['workspace', 'prepare', platform, '--id', 'b-work', '--name', 'B Work',
    '--base', path.join(base, 'b-workspaces'), '--capability', 'payments', '--capability', 'orders-core',
    '--capability', 'analytics', '--lead-capability', 'payments', '--clone']);
  const ready = invokeJson(other, base, ['workspace', 'bootstrap', 'resume', prepared.bootstrapId, '--confirm', 'b-work']);
  assert.deepEqual(Object.fromEntries(Object.entries(ready.result.workspace.repositories)
    .map(([id, repository]) => [id, repository.capabilities])), {
    'payments-api': ['payments'], 'orders-svc': ['orders-core'], analytics: ['analytics']
  });
});

test('a workspace checkout with no workspace selected is governed by its workspace authority, not its own configuration', slowLane({
  timeout: 300_000
}), async (t) => {
  const { base, env, platform, payments, orders } = await fixture(t);
  mapAndActivate(env, base, platform, 'payments', ['--name', 'Payments', '--kind', 'delivery', '--repository', payments]);
  mapAndActivate(env, base, platform, 'orders-core', ['--name', 'Orders core', '--kind', 'delivery', '--repository', orders]);
  const prepared = invokeJson(env, base, ['workspace', 'prepare', platform, '--id', 'w1', '--name', 'W1',
    '--base', path.join(base, 'workspaces'), '--capability', 'payments', '--lead-capability', 'payments',
    '--clone', '--initialize']);
  const ready = invokeJson(env, base, ['workspace', 'bootstrap', 'resume', prepared.bootstrapId, '--confirm', 'w1']);
  const workspacePath = ready.result.workspace.path;
  const preview = invokeJson(env, base, ['workspace', 'attach-capability', workspacePath, 'orders-core', '--dry-run']);
  invokeJson(env, base, ['workspace', 'attach-capability', workspacePath, 'orders-core', '--confirm-plan', preview.planId]);
  const manifest = JSON.parse(await readFile(path.join(workspacePath, 'workspace.json'), 'utf8'));
  // Initialization gave the lead delivery repository configuration of its own. Without a
  // selection, a Story there must still follow the workspace's organisation authority.
  assert.match(run('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/sflow/config'], { cwd: payments }).stdout,
    /sflow\/config/);
  assert.equal(await readFile(env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, 'utf8').catch((error) => error.code), 'ENOENT',
    'no workspace is selected on this machine');
  const platformConfiguration = run('git', ['rev-parse', 'sflow/config'], { cwd: platform }).stdout.trim();
  for (const [id, capability, repositoryId] of [['W-1', null, 'payments-api'], ['W-2', 'payments', 'payments-api'],
    ['W-3', 'orders-core', 'orders-svc']]) {
    const checkout = path.join(workspacePath, manifest.repositories[repositoryId].path);
    const started = capability ? startStory(env, checkout, id, capability)
      : invokeJson(env, checkout, ['start', id, '--title', 'No capability', '--description', 'Plain.',
        '--acceptance-criteria', 'Works.', '--from-branch', 'main', '--work-type', 'feature']);
    assert.equal(started.outcome.status, 'succeeded', `${id}: ${JSON.stringify(started)}`);
    assert.deepEqual(pinnedSource(checkout, id).repository, platform,
      `${id} is pinned to the workspace's capability authority`);
    assert.equal(pinnedSource(checkout, id).commit, platformConfiguration);
    run('git', ['checkout', '-q', 'main'], { cwd: checkout });
  }
});
