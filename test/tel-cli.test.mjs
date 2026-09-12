import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function call(root, env, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' });
}

test('telemetry enable, probe, status, and disable remain machine-local and JSON-safe', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-tel-cli-'));
  const root = path.join(base, 'outside-git');
  await mkdir(root);
  const preference = path.join(base, 'machine', 'telemetry-preferences.json');
  const env = {
    ...process.env,
    SINGULARITY_FLOW_TELEMETRY_PREFERENCES: preference,
    // A developer may have another workspace selected globally. These commands must neither need
    // it nor be redirected into it while this rootless test is running.
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'missing-active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'missing-workspace-registry.json')
  };

  let result = call(root, env, ['telemetry', 'enable', '--confirm', 'wrong', '--json']);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(preference), false);

  result = call(root, env, ['telemetry', 'enable', '--confirm', 'ENABLE LOCAL USAGE', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const enabled = JSON.parse(result.stdout);
  assert.equal(enabled.status, 'enabled');
  assert.equal(enabled.preference.disclosureAccepted, true);
  assert.match(enabled.disclosure, /Prompts and code are not captured/);

  result = call(root, env, ['telemetry', 'probe', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(result.stdout);
  assert.equal(probe.probes.find((item) => item.host === 'cli').mode, 'launch-injection');
  assert.equal(probe.probes.find((item) => item.host === 'intellij-native').mode, 'external-only');

  result = call(root, env, ['telemetry', 'status', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.schemaVersion, 2);
  assert.equal(status.capture.preference.enabled, true);
  assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  result = call(root, env, ['telemetry', 'disable', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'disabled');
  assert.equal(JSON.parse(await readFile(preference, 'utf8')).enabled, false);

  const doctorRoot = path.join(base, 'ordinary-git-repository');
  await mkdir(doctorRoot);
  spawnSync('git', ['init', '-q'], { cwd: doctorRoot });
  result = call(doctorRoot, env, ['doctor', '--fix', 'telemetry', '--confirm', 'ENABLE LOCAL USAGE', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'enabled');
});
