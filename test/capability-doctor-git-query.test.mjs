import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { capabilityDoctor } from '../src/capability-doctor.mjs';

test('capability doctor selects a lifecycle only from the checked-out branch', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'CAP-1'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Demo Owner'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'demo.owner@example.test'], { cwd: root });

  const initiativeDirectory = path.join(root, 'singularity', 'initiatives', 'CAP-1');
  await mkdir(initiativeDirectory, { recursive: true });
  await writeFile(path.join(initiativeDirectory, 'state.json'), `${JSON.stringify({
    schemaVersion: 1,
    initiative: { id: 'CAP-1', branch: 'CAP-1' },
    phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', status: 'in_progress' } }
  })}\n`);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initiative fixture'], { cwd: root });

  const attached = await capabilityDoctor(root, { offline: true });
  assert.deepEqual(attached.lifecycle, { type: 'initiative', id: 'CAP-1', capability: null });

  execFileSync('git', ['switch', '--detach', '--quiet', 'HEAD'], { cwd: root });
  const detached = await capabilityDoctor(root, { offline: true });
  assert.equal(detached.lifecycle, null, 'detached HEAD must not resolve a lifecycle by the old branch');
});
