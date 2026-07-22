import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(cwd, args, persona = 'product-owner') {
  return run(process.execPath, [bin, ...args], cwd, { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Handoff Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona }) });
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
  const configPath = path.join(first, '.singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.singularity'], first);
  run('git', ['commit', '-m', 'configure workflow'], first);
  run('git', ['push', '-u', 'origin', 'main'], first);
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  flow(first, ['start', 'HAND-101', '--title', 'Handoff test']);
  const intakePath = path.join(first, '.singularity', 'work-items', 'HAND-101', 'artifacts', 'intake', 'intake.md');
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
  assert.match(flow(second, ['session', 'attach', 'HAND-101']).stdout, /Attached to HAND-101 from origin\/HAND-101/);
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'HAND-101');
  let session = JSON.parse(flow(second, ['session', 'status', '--json']).stdout);
  assert.equal(session.workItemSelectionRequired, false);
  assert.equal(session.selectionRequired, true);
  flow(second, ['persona', 'HAND-101'], 'architect');
  session = JSON.parse(flow(second, ['session', 'status', '--json']).stdout);
  assert.equal(session.ready, true);
  assert.equal(session.activePersona, 'architect');
  const workflow = JSON.parse(await readFile(path.join(second, '.singularity', 'work-items', 'HAND-101', 'workflow.json'), 'utf8'));
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
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /Working tree is not clean/);
  assert.equal(await readFile(path.join(second, 'local-only.txt'), 'utf8'), 'preserve me\n');
  await unlink(path.join(second, 'local-only.txt'));

  await writeFile(path.join(second, 'ahead.txt'), 'local commit must survive\n');
  run('git', ['add', 'ahead.txt'], second);
  run('git', ['commit', '-m', 'local unpushed work'], second);
  const aheadHead = run('git', ['rev-parse', 'HEAD'], second).stdout.trim();
  const ahead = spawnSync(process.execPath, [bin, 'session', 'attach', 'HAND-101'], { cwd: second, encoding: 'utf8' });
  assert.equal(ahead.status, 1);
  assert.match(ahead.stderr, /contains commits that are not on origin\/HAND-101/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], second).stdout.trim(), aheadHead);
  assert.equal(await readFile(path.join(second, 'ahead.txt'), 'utf8'), 'local commit must survive\n');
});
