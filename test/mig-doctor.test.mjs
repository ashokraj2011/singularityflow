import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { doctorSnapshot } from '../src/doctor.mjs';
import { schemaCensus } from '../src/schema-census.mjs';

test('census-flags-out-of-range', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mig-doctor-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Schema Tester'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'schema@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Schema fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const state = path.join(root, '.git', 'singularity-flow');
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'session.json'), '{"schemaVersion":999}\n');

  const census = await schemaCensus(root);
  assert.equal(census.totals.outsideRange, 1);
  assert.equal(census.families.find((entry) => entry.family === 'session-registry').versions['999'], 1);

  const report = await doctorSnapshot(root, { offline: true });
  const check = report.checks.find((entry) => entry.id === 'schema-migrations');
  assert.equal(check.status, 'fail');
  assert.match(check.message, /1 outside the readable range/);
});
