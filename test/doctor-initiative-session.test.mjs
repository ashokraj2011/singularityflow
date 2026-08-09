import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition } from '../src/config.mjs';
import { doctorSnapshot } from '../src/doctor.mjs';

test('doctor recognizes an active Initiative session without calling it a missing Story', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-doctor-initiative-'));
  execFileSync('git', ['init', '-q', '-b', 'EPIC-1'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Demo Owner'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'demo.owner@example.test'], { cwd: root });
  await initializeDefinition(root);

  const initiativeDirectory = path.join(root, 'singularity', 'initiatives', 'EPIC-1');
  await mkdir(initiativeDirectory, { recursive: true });
  await writeFile(path.join(initiativeDirectory, 'state.json'), `${JSON.stringify({
    schemaVersion: 1,
    initiative: { id: 'EPIC-1', branch: 'EPIC-1' },
    phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', status: 'in_progress' } }
  }, null, 2)}\n`);

  const sessionDirectory = path.join(root, '.git', 'singularity-flow');
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(path.join(sessionDirectory, 'session.json'), `${JSON.stringify({
    schemaVersion: 2,
    agent: 'product-owner',
    workId: 'EPIC-1'
  }, null, 2)}\n`);

  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initiative fixture'], { cwd: root });

  const report = await doctorSnapshot(root, { offline: true });
  assert.deepEqual(report.subject, { kind: 'initiative', id: 'EPIC-1' });
  assert.equal(report.workId, 'EPIC-1');
  assert.match(report.checks.find((entry) => entry.id === 'workflow-state').message, /Initiative EPIC-1 is active/);
  const session = report.checks.find((entry) => entry.id === 'session');
  assert.equal(session.status, 'pass');
  assert.match(session.message, /active for initiative EPIC-1/);
});
