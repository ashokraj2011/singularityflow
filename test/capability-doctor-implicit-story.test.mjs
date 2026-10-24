import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initializeDefinition } from '../src/config.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// A code-only base whose configuration comes only from an approved sflow/config branch has no
// capability map, so the Story binds the implicit repository-root capability (map.path null).
// Doctor resolved that null path and failed with diagnostic-read "paths[1] ... Received null";
// a Story branch with a slash then failed again as an invalid initiative ID.
test('capabilities doctor diagnoses a capability-free Story pinned to sflow/config, on any branch name', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-doctor-implicit-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const remote = path.join(parent, 'origin.git');
  const app = path.join(parent, 'app');
  const config = path.join(parent, 'config');
  const machine = path.join(parent, 'machine');
  const env = {
    ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Doctor Tester', NO_COLOR: '1',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json')
  };
  const spawnCli = (...args) => spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: app, encoding: 'utf8', env });
  const cli = (...args) => {
    const result = spawnCli(...args);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  git(parent, 'init', '-q', '--bare', '-b', 'main', remote);
  await mkdir(app);
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'config', 'user.name', 'Doctor Tester'); git(app, 'config', 'user.email', 'doctor@example.invalid');
  await writeFile(path.join(app, 'README.md'), '# Application\n');
  await writeFile(path.join(app, 'package.json'), `${JSON.stringify({ type: 'module', private: true })}\n`);
  git(app, 'add', '.'); git(app, 'commit', '-qm', 'application');
  git(app, 'remote', 'add', 'origin', remote); git(app, 'push', '-q', '-u', 'origin', 'main');
  await mkdir(config);
  git(config, 'init', '-q', '-b', 'sflow/config');
  git(config, 'config', 'user.name', 'Doctor Tester'); git(config, 'config', 'user.email', 'doctor@example.invalid');
  await initializeDefinition(config);
  git(config, 'add', '-A'); git(config, 'commit', '-qm', 'approved configuration');
  git(config, 'remote', 'add', 'origin', remote); git(config, 'push', '-q', 'origin', 'sflow/config');

  for (const [work, ref] of [['CL-0', null], ['CL-1', 'feature/cl-1']]) {
    git(app, 'switch', '-q', 'main');
    cli('start', work, ...(ref ? ['--ref', ref] : []), '--from-branch', 'main', '--work-type', 'spec-driven-standard',
      '--target-url', 'https://staging.example.test', '--title', 'T', '--description', 'D');
    assert.equal(git(app, 'branch', '--show-current'), ref ?? work);
    for (const offline of [[], ['--offline']]) {
      const report = JSON.parse(cli('capabilities', 'doctor', '--json', ...offline));
      const checks = new Map(report.checks.map(item => [item.id, item]));
      const label = `${work} ${offline.join(' ')}\n${JSON.stringify(report.checks, null, 2)}`;
      assert.equal(report.valid, true, label);
      assert.equal(checks.has('diagnostic-read'), false, label);
      assert.equal(checks.get('configuration-pin')?.status, 'pass', label);
      assert.equal(checks.get('binding')?.status, 'pass', label);
      assert.match(checks.get('binding').summary, /implicit 'repository-root' capability/);
      assert.equal(checks.get('binding').detail, report.capability.resolutionSha256, 'binding names the implicit resolution');
      assert.equal(checks.has('map-pin'), false, 'an implicit capability has no map to compare');
      assert.equal(checks.get('lifecycle-pin')?.status, 'pass', label);
      assert.equal(report.capability.mode, 'implicit');
      assert.deepEqual({ type: report.lifecycle.type, id: report.lifecycle.id, capability: report.lifecycle.capability.id },
        { type: 'story', id: work, capability: 'repository-root' });
    }
  }

  // A detached HEAD has no branch to name an initiative: no lifecycle, and still no read failure.
  git(app, 'switch', '-q', '--detach', 'CL-0');
  const detached = JSON.parse(spawnCli('capabilities', 'doctor', '--json', '--offline').stdout);
  assert.equal(detached.lifecycle, null);
  assert.equal(detached.checks.some(item => item.id === 'diagnostic-read'), false, JSON.stringify(detached.checks, null, 2));
  assert.equal(detached.checks.find(item => item.id === 'binding')?.status, 'pass');
});
