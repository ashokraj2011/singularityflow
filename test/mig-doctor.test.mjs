import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { doctorSnapshot } from '../src/doctor.mjs';
import { schemaCensus } from '../src/schema-census.mjs';
import { currentSchemaVersion, familyForStoredPath } from '../src/schema-migrations.mjs';
import { SGOS_RECORD_INDEX_FAMILIES } from '../src/sgos/contracts.mjs';

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

test('schema census and doctor classify every persisted SGOS sidecar family', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mig-sgos-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Schema Tester'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'schema@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# SGOS schema fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });

  const process = path.join(root, '.git', 'singularity-flow', 'sgos', 'processes', 'PROC-schema-census');
  const records = [
    ['state.json', 'gvm-process'],
    ['programs', 'gvm-program'],
    ['candidate-snapshots', 'candidate-snapshot'],
    ['bindings', 'process-binding'],
    ['record-indexes', 'sgos-record-index'],
    ['control-events', 'sgos-control-event'],
    ['control-next', 'sgos-control-successor'],
    ['transition-intent.json', 'sgos-transition-intent'],
    ['attempts', 'gvm-task-attempt'],
    ['receipts', 'gvm-task-receipt'],
    ['checkpoints', 'gvm-checkpoint'],
    ['human-requests', 'human-request'],
    ['human-responses', 'human-response'],
    ['agent-proposals', 'agent-proposal'],
    ['evidence', 'action-evidence'],
    ['execution-leases', 'sgos-execution-lease']
  ];
  for (const [location, family] of records) {
    const file = location.endsWith('.json')
      ? path.join(process, location)
      : path.join(process, location, `${'a'.repeat(64)}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ schemaVersion: currentSchemaVersion(family) })}\n`);
  }
  const reservationDirectory = path.join(process, 'record-reservations');
  await mkdir(reservationDirectory, { recursive: true });
  for (const family of SGOS_RECORD_INDEX_FAMILIES) {
    await writeFile(
      path.join(reservationDirectory, `${family}--${'b'.repeat(64)}.json`),
      `${JSON.stringify({ schemaVersion: currentSchemaVersion(family) })}\n`
    );
  }

  const census = await schemaCensus(root);
  assert.equal(census.totals.registeredRecords,
    records.length + SGOS_RECORD_INDEX_FAMILIES.length);
  assert.equal(census.totals.unregistered, 0);
  assert.equal(census.totals.outsideRange, 0);
  assert.equal(census.totals.unreadable, 0);
  for (const [, family] of records) {
    assert.equal(census.families.find((entry) => entry.family === family)?.records,
      SGOS_RECORD_INDEX_FAMILIES.includes(family) ? 2 : 1, family);
  }

  const report = await doctorSnapshot(root, { offline: true, probeModelProvider: false });
  const check = report.checks.find((entry) => entry.id === 'schema-migrations');
  assert.equal(check.status, 'pass');
  assert.match(check.message, new RegExp(
    `${records.length + SGOS_RECORD_INDEX_FAMILIES.length} registered durable record\\(s\\)`
  ));
});

test('SGOS record reservations retain the exact underlying immutable family', () => {
  const prefix = '$git/sgos/processes/PROC-reservations/record-reservations';
  for (const family of SGOS_RECORD_INDEX_FAMILIES) {
    assert.equal(
      familyForStoredPath(`${prefix}/${family}--${'a'.repeat(64)}.json`)?.id,
      family
    );
    assert.equal(
      familyForStoredPath(`${prefix.replaceAll('/', '\\')}\\${family}--${'b'.repeat(64)}.json`)?.id,
      family
    );
  }
  for (const malformed of [
    `${prefix}/unknown-family--${'a'.repeat(64)}.json`,
    `${prefix}/gvm-program-${'a'.repeat(64)}.json`,
    `${prefix}/gvm-program--${'a'.repeat(63)}.json`,
    `${prefix}/gvm-program--${'A'.repeat(64)}.json`,
    `${prefix}/gvm-program--${'a'.repeat(64)}.json.pending-1`,
    `${prefix}/gvm-program--${'a'.repeat(64)}.json/payload.json`
  ]) {
    assert.equal(familyForStoredPath(malformed), null, malformed);
  }
});

test('SGOS path classification is separator-independent and excludes staging files', () => {
  assert.equal(
    familyForStoredPath(`$git\\sgos\\processes\\PROC-windows\\bindings\\${'b'.repeat(64)}.json`)?.id,
    'process-binding'
  );
  assert.equal(
    familyForStoredPath(`$git/sgos/processes/PROC-windows/programs/${'c'.repeat(64)}.json`)?.id,
    'gvm-program'
  );
  assert.equal(
    familyForStoredPath(`$git\\sgos\\processes\\PROC-windows\\record-indexes\\${'d'.repeat(64)}.json`)?.id,
    'sgos-record-index'
  );
  assert.equal(
    familyForStoredPath(`$git/sgos/processes/PROC-windows/programs/${'c'.repeat(64)}.json.pending-42`),
    null
  );
});
