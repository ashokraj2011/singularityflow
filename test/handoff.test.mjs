import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { bootstrapRepository } from '../src/bootstrap.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(cwd, args, agent = 'product-owner') {
  return run(process.execPath, [bin, ...args], cwd, { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Handoff Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent }) });
}

function identity(root, name) {
  run('git', ['config', 'user.name', name], root);
  run('git', ['config', 'user.email', `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`], root);
}

test('another clone discovers a remote work ID, attaches safely, and fast-forwards each new Copilot session', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-handoff-'));
  const remote = path.join(base, 'remote.git');
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');

  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', first], base);
  identity(first, 'First Contributor');
  await writeFile(path.join(first, 'README.md'), '# Handoff test\n');
  run('git', ['add', 'README.md'], first);
  run('git', ['commit', '-m', 'initial'], first);
  run('git', ['remote', 'add', 'origin', remote], first);
  flow(first, ['init']);
  const configPath = path.join(first, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'singularity', '.github/agents'], first);
  run('git', ['commit', '-m', 'configure workflow'], first);
  run('git', ['push', '-u', 'origin', 'main'], first);
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  flow(first, ['start', 'HAND-101', '--from-branch', 'main', '--ref', 'story/HAND-101-delivery', '--title', 'Handoff test']);
  const intakePath = path.join(first, 'singularity', 'work-items', 'HAND-101', 'artifacts', 'intake', 'intake.md');
  const intake = (await readFile(intakePath, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete handoff evidence and measurable outcomes for another terminal.');
  await writeFile(intakePath, intake);
  flow(first, ['phase', 'publish', 'intake']);
  flow(first, ['submit']);
  const pending = JSON.parse(flow(first, ['inbox', '--json']).stdout);
  assert.equal(pending.remote, 'origin');
  assert.equal(pending.count, 1);
  assert.equal(pending.items[0].id, 'HAND-101');
  assert.equal(pending.items[0].phase, 'intake');
  assert.equal(pending.items[0].approvalsReceived, 0);
  assert.equal(pending.items[0].approvalsRequired, 1);
  assert.match(pending.items[0].artifact, /HAND-101\/artifacts\/intake\/intake\.md$/);
  assert.match(pending.items[0].commands.attach, /session attach HAND-101/);
  assert.match(flow(first, ['inbox']).stdout, /Pending approval inbox[\s\S]*HAND-101[\s\S]*intake/);
  flow(first, ['approve', '--yes']);
  assert.equal(JSON.parse(flow(first, ['inbox', '--json']).stdout).count, 0);

  run('git', ['clone', '--no-hardlinks', remote, second], base);
  identity(second, 'Second Contributor');
  const started = spawnSync(process.execPath, [bin, 'hook', 'session-start'], {
    cwd: second, encoding: 'utf8', input: JSON.stringify({ cwd: second, sessionId: 'copilot-second-1', source: 'startup' }),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Second Contributor' }
  });
  assert.equal(started.status, 0);
  assert.match(JSON.parse(started.stdout).additionalContext, /work-item selection is required/);
  const candidates = JSON.parse(flow(second, ['session', 'candidates', '--json']).stdout);
  assert.ok(candidates.some((item) => item.id === 'HAND-101' && item.phase === 'requirements'));
  assert.match(flow(second, ['session', 'attach', 'HAND-101']).stdout, /Attached to HAND-101 from origin\/story\/HAND-101-delivery/);
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'story/HAND-101-delivery');
  let session = JSON.parse(flow(second, ['session', 'status', '--json']).stdout);
  assert.equal(session.workItemSelectionRequired, false);
  assert.equal(session.selectionRequired, false);
  assert.equal(session.ready, true);
  assert.equal(session.activeAgent, 'product-owner');
  flow(second, ['agent', 'HAND-101', '--agent', 'architect']);
  session = JSON.parse(flow(second, ['session', 'status', '--json']).stdout);
  assert.equal(session.ready, true);
  assert.equal(session.activeAgent, 'architect');
  const workflow = JSON.parse(await readFile(path.join(second, 'singularity', 'work-items', 'HAND-101', 'workflow.json'), 'utf8'));
  assert.equal(workflow.currentPhase, 'requirements');

  await writeFile(path.join(first, 'handoff-note.txt'), 'Remote handoff update\n');
  run('git', ['add', 'handoff-note.txt'], first);
  run('git', ['commit', '-m', 'HAND-101 add handoff note'], first);
  run('git', ['push'], first);

  const restarted = spawnSync(process.execPath, [bin, 'hook', 'session-start'], {
    cwd: second, encoding: 'utf8', input: JSON.stringify({ cwd: second, sessionId: 'copilot-second-2', source: 'startup' }),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Second Contributor' }
  });
  assert.match(JSON.parse(restarted.stdout).additionalContext, /work-item selection is required/);
  flow(second, ['session', 'attach', 'HAND-101']);
  assert.equal(await readFile(path.join(second, 'handoff-note.txt'), 'utf8'), 'Remote handoff update\n');
  assert.equal(run('git', ['status', '--porcelain'], second).stdout.trim(), '');

  await writeFile(path.join(second, 'local-only.txt'), 'preserve me\n');
  const dirty = spawnSync(process.execPath, [bin, 'session', 'attach', 'HAND-101'], { cwd: second, encoding: 'utf8' });
  assert.equal(dirty.status, 0);
  assert.match(dirty.stdout, /Attached to HAND-101 from origin\/story\/HAND-101-delivery/);
  assert.equal(await readFile(path.join(second, 'local-only.txt'), 'utf8'), 'preserve me\n');
  await unlink(path.join(second, 'local-only.txt'));

  run('git', ['switch', 'main'], second);
  await writeFile(path.join(second, 'wrong-branch-change.txt'), 'must not cross branches\n');
  const dirtyCheckout = spawnSync(process.execPath, [bin, 'session', 'attach', 'HAND-101'], { cwd: second, encoding: 'utf8' });
  assert.equal(dirtyCheckout.status, 1);
  assert.match(dirtyCheckout.stderr, /Working tree is not clean/);
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'main');
  assert.equal(await readFile(path.join(second, 'wrong-branch-change.txt'), 'utf8'), 'must not cross branches\n');
  await unlink(path.join(second, 'wrong-branch-change.txt'));
  flow(second, ['session', 'attach', 'HAND-101']);

  await writeFile(path.join(second, 'ahead.txt'), 'local commit must survive\n');
  run('git', ['add', 'ahead.txt'], second);
  run('git', ['commit', '-m', 'local unpushed work'], second);
  const aheadHead = run('git', ['rev-parse', 'HEAD'], second).stdout.trim();
  const ahead = spawnSync(process.execPath, [bin, 'session', 'attach', 'HAND-101'], { cwd: second, encoding: 'utf8' });
  assert.equal(ahead.status, 1);
  assert.match(ahead.stderr, /contains commits that are not on origin\/story\/HAND-101-delivery/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], second).stdout.trim(), aheadHead);
  assert.equal(await readFile(path.join(second, 'ahead.txt'), 'utf8'), 'local commit must survive\n');
});

test('a fresh production-bootstrap clone discovers and attaches a published Story', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-bootstrap-handoff-'));
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  const second = path.join(base, 'second');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', seed], base);
  identity(seed, 'Bootstrap Seed');
  await writeFile(path.join(seed, 'README.md'), '# Bootstrap handoff\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '-m', 'initial'], seed);
  run('git', ['push', remote, 'main:main'], seed);
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  const boot = await bootstrapRepository(remote, {
    capabilityId: 'handoff', capabilityName: 'Handoff', base: path.join(base, 'work'), stateBranch: null
  });
  assert.equal(spawnSync('git', ['cat-file', '-e', 'main:singularity/workflow.yml'], {
    cwd: boot.root, encoding: 'utf8'
  }).status, 128, 'production main intentionally has no workflow definition');
  flow(boot.root, [
    'start', 'BOOT-101', '--from-branch', 'main', '--title', 'Bootstrap handoff', '--work-type', 'feature'
  ]);

  run('git', ['clone', '--no-hardlinks', remote, second], base);
  identity(second, 'Second Bootstrap Contributor');
  const isolated = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Second Bootstrap Contributor',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json')
  };
  const started = spawnSync(process.execPath, [bin, 'hook', 'session-start'], {
    cwd: second, encoding: 'utf8', input: JSON.stringify({ cwd: second, sessionId: 'bootstrap-second-1' }),
    env: isolated
  });
  assert.equal(started.status, 0);
  assert.match(JSON.parse(started.stdout).additionalContext, /work-item selection is required/);
  const candidates = JSON.parse(run(process.execPath, [bin, 'session', 'candidates', '--json'], second, isolated).stdout);
  assert.ok(candidates.some((item) => item.id === 'BOOT-101'));
  assert.match(run(process.execPath, [bin, 'resume', 'BOOT-101', '--fetch'], second, isolated).stdout, /BOOT-101/);
  run('git', ['switch', 'main'], second);
  run('git', ['remote', 'set-url', 'origin', path.join(base, 'temporarily-offline.git')], second);
  assert.match(run(process.execPath, [bin, 'start', 'BOOT-101'], second, isolated).stdout, /BOOT-101/);
  run('git', ['remote', 'set-url', 'origin', remote], second);
  run('git', ['switch', 'main'], second);
  assert.match(run(process.execPath, [bin, 'start', 'BOOT-101'], second, isolated).stdout, /BOOT-101/);
  run('git', ['switch', 'main'], second);
  assert.match(run(process.execPath, [bin, 'session', 'attach', 'BOOT-101'], second, isolated).stdout,
    /Attached to BOOT-101 from origin\/BOOT-101/);
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'BOOT-101');
  assert.equal(run('git', ['rev-parse', 'HEAD'], second).stdout, run('git', ['rev-parse', 'origin/BOOT-101'], second).stdout);
});

test('remote Story discovery uses each branch pinned ID policy and state root', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-pinned-handoff-'));
  const remote = path.join(base, 'remote.git');
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', first], base);
  identity(first, 'First Pinned Contributor');
  await writeFile(path.join(first, 'README.md'), '# Pinned handoff\n');
  flow(first, ['init']);
  run('git', ['add', '.'], first);
  run('git', ['commit', '-m', 'initial governance'], first);
  run('git', ['remote', 'add', 'origin', remote], first);
  run('git', ['push', '-u', 'origin', 'main'], first);
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  flow(first, ['start', 'OLD-101', '--from-branch', 'main', '--title', 'Pinned Story']);

  run('git', ['switch', 'main'], first);
  const definitionPath = path.join(first, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.idPattern = '^NEW-[0-9]+$';
  definition.workItemRoot = 'governed/items';
  await writeFile(definitionPath, YAML.stringify(definition));
  run('git', ['add', definitionPath], first);
  run('git', ['commit', '-m', 'change policy for future Stories'], first);
  run('git', ['push', 'origin', 'main'], first);

  run('git', ['clone', '--no-hardlinks', remote, second], base);
  identity(second, 'Second Pinned Contributor');
  const candidates = JSON.parse(flow(second, ['session', 'candidates', '--json']).stdout);
  assert.ok(candidates.some((item) => item.id === 'OLD-101'));
  assert.match(flow(second, ['resume', 'OLD-101', '--fetch']).stdout, /OLD-101/);
  run('git', ['switch', 'main'], second);
  assert.match(flow(second, ['start', 'OLD-101']).stdout, /OLD-101/);
  run('git', ['switch', 'main'], second);
  assert.match(flow(second, ['session', 'attach', 'OLD-101']).stdout,
    /Attached to OLD-101 from origin\/OLD-101/);
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'OLD-101');
});

test('session attach fails non-zero when no governed repository can be resolved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-no-session-repository-'));
  run('git', ['init', '-b', 'main'], root);
  const result = spawnSync(process.execPath, [bin, 'session', 'attach', 'MISSING-1'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, 'active-workspace.json')
    }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot attach a Story because no governed repository is active/);
});
