import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('skill inspect works outside a Git repository and never admits the package', async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-cli-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const selected = path.join(outside, 'selected-skill');
  await mkdir(selected);
  await writeFile(path.join(selected, 'SKILL.md'), '# Selected skill\n## Outputs\n- `artifacts/report.md`\n');

  const result = spawnSync(process.execPath, [CLI, 'skill', 'inspect', selected, '--json'], {
    cwd: outside, encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'skill.inspect');
  assert.equal(response.operation.classification, 'read');
  assert.deepEqual(Object.values(response.effects), [false, false, false, false]);
  assert.equal(response.data.inspection.executable, false);
  assert.equal(response.data.inspection.confirmationRequired, true);
  assert.equal(response.data.inspection.manifest.files.length, 1);
  assert.match(response.data.inspection.manifest.packageSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(response.data.inspection.metrics.gitRequests, 0);
  assert.equal(response.data.inspection.metrics.remoteCalls, 0);
  assert.equal(response.data.inspection.metrics.modelCalls, 0);
});

test('skill inspect refuses extra actions instead of treating them as activation', async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-cli-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const selected = path.join(outside, 'selected-skill');
  await mkdir(selected);
  await writeFile(path.join(selected, 'SKILL.md'), '# Selected skill\n');

  const result = spawnSync(process.execPath, [CLI, 'skill', 'inspect', selected, '--confirm', 'yes'], {
    cwd: outside, encoding: 'utf8', timeout: 10000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SKP_OPTION_UNSUPPORTED|does not support '--confirm'/);

  const missingId = spawnSync(process.execPath, [CLI, 'skill', 'inspect', selected, '--skill-id'], {
    cwd: outside, encoding: 'utf8', timeout: 10000
  });
  assert.notEqual(missingId.status, 0);
  assert.match(missingId.stderr, /SKP_OPTION_UNSUPPORTED|--skill-id requires/);

  const unsupportedAction = spawnSync(process.execPath, [CLI, 'skill', 'activate', selected], {
    cwd: outside, encoding: 'utf8', timeout: 10000
  });
  assert.notEqual(unsupportedAction.status, 0);
  assert.match(unsupportedAction.stderr, /SKP_ACTION_UNKNOWN|Unknown skill action/);
});
