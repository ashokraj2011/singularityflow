import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { physicalProcessProbe } from './helpers/physical-process-probe.mjs';

test('qualification counts Git in both the main CLI and its Node descendants without retaining argv', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-physical-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = await physicalProcessProbe(root);
  const source = `import { spawnSync } from 'node:child_process';
spawnSync('git', ['--version']);
const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import { spawnSync } from 'node:child_process'; spawnSync('git', ['--version']);"]);
if(child.status !== 0) throw new Error(child.stderr.toString());`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: await probe.environment(process.env), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const counts = await probe.counts(result.pid);
  assert.deepEqual(counts.git, { parent: 1, descendants: 1, total: 2 });
  assert.equal(counts.nodeChildren, 1);
  assert.ok(!JSON.stringify(counts).includes(root));
});
