import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
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

test('schema census proves a readable legacy record through the non-writing migration path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mig-census-readable-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const state = path.join(root, '.git', 'singularity-flow');
  await mkdir(state, { recursive: true });
  const target = path.join(state, 'session.json');
  const stored = '{"schemaVersion":1,"privateMaterial":"must-not-appear"}\n';
  await writeFile(target, stored);

  const census = await schemaCensus(root);

  assert.equal(census.healthy, true);
  assert.equal(census.totals.registeredRecords, 1);
  assert.equal(census.totals.validatedRecords, 1);
  assert.equal(census.totals.readTimeMigrationRecords, 1);
  assert.equal(census.totals.readTimeMigrationSteps, 1);
  const session = census.families.find((entry) => entry.family === 'session-registry');
  assert.equal(session.validatedRecords, 1);
  assert.equal(session.readTimeMigrationRecords, 1);
  assert.equal(session.readTimeMigrationSteps, 1);
  assert.equal(await readFile(target, 'utf8'), stored, 'census must preserve the exact stored bytes');
});

test('schema census makes an in-range legacy migration failure unhealthy without exposing record content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mig-census-corrupt-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Schema Tester'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'schema@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Corrupt migration fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const state = path.join(root, '.git', 'singularity-flow', 'sgos', 'learning', 'a'.repeat(64));
  await mkdir(state, { recursive: true });
  const target = path.join(state, 'progress.json');
  const stored = JSON.stringify({
    schemaVersion: 1,
    progressSha256: 'sha256:invalid',
    privateMaterial: 'must-not-appear'
  });
  await writeFile(target, `${stored}\n`);

  const census = await schemaCensus(root);

  assert.equal(census.healthy, false);
  assert.equal(census.totals.registeredRecords, 1);
  assert.equal(census.totals.validatedRecords, 0);
  assert.equal(census.totals.readTimeMigrationRecords, 0);
  assert.equal(census.totals.unreadable, 1);
  assert.deepEqual(census.unreadable, [{
    path: `$git/sgos/learning/${'a'.repeat(64)}/progress.json`,
    family: 'learning-progress',
    storedVersion: 1,
    code: 'SCHEMA_MIGRATION_SOURCE_CORRUPT',
    reason: 'registered learning-progress v1 record failed non-writing migration validation (SCHEMA_MIGRATION_SOURCE_CORRUPT)'
  }]);
  assert.doesNotMatch(JSON.stringify(census), /must-not-appear|sha256:invalid/);
  assert.equal(await readFile(target, 'utf8'), `${stored}\n`, 'failed migration must not rewrite immutable evidence');

  const report = await doctorSnapshot(root, { offline: true, probeModelProvider: false });
  const check = report.checks.find((entry) => entry.id === 'schema-migrations');
  assert.equal(check.status, 'fail');
  assert.match(check.message, /1 unreadable/);
  assert.match(check.message, /0 validated through registered readers/);
  assert.match(check.fix, /never hand-edit immutable evidence/);
});

test('schema census never echoes malformed JSON or JSONL record bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mig-census-malformed-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const governed = path.join(root, 'singularity');
  await mkdir(governed, { recursive: true });
  await writeFile(
    path.join(governed, 'malformed.json'),
    '{"apiKey":"must-not-appear",broken}'
  );
  await writeFile(
    path.join(governed, 'malformed.jsonl'),
    [
      '{"schemaVersion":1}',
      '{"accessToken":"must-also-not-appear",broken}',
      ''
    ].join('\n')
  );

  const census = await schemaCensus(root);

  assert.equal(census.healthy, false);
  assert.equal(census.totals.unreadable, 2);
  assert.deepEqual(census.unreadable, [
    {
      path: 'singularity/malformed.json',
      code: 'SCHEMA_CENSUS_JSON_INVALID',
      reason: 'record is not valid JSON'
    },
    {
      path: 'singularity/malformed.jsonl#L2',
      code: 'SCHEMA_CENSUS_JSON_INVALID',
      reason: 'record is not valid JSON'
    }
  ]);
  assert.doesNotMatch(
    JSON.stringify(census),
    /must-not-appear|must-also-not-appear|apiKey|accessToken/
  );
});

test('schema census refuses a registered durable record with no schema version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mig-census-unversioned-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const ledger = path.join(root, 'singularity', 'ledger');
  await mkdir(ledger, { recursive: true });
  const target = path.join(ledger, 'missing-version.json');
  const stored = '{"privateMaterial":"must-not-appear"}\n';
  await writeFile(target, stored);

  const census = await schemaCensus(root);
  assert.equal(census.healthy, false);
  assert.equal(census.totals.registeredRecords, 1);
  assert.equal(census.totals.validatedRecords, 0);
  assert.equal(census.totals.unreadable, 1);
  const ledgerFamily = census.families.find((entry) => entry.family === 'ledger-entry');
  assert.equal(ledgerFamily.unversionedRecords, 1);
  assert.deepEqual(ledgerFamily.versions, {});
  assert.deepEqual(census.unreadable, [{
    path: 'singularity/ledger/missing-version.json',
    family: 'ledger-entry',
    storedVersion: null,
    code: 'SCHEMA_VERSION_MISSING',
    reason: 'registered ledger-entry unversioned record failed non-writing migration validation (SCHEMA_VERSION_MISSING)'
  }]);
  assert.doesNotMatch(JSON.stringify(census), /must-not-appear|privateMaterial/);
  assert.equal(await readFile(target, 'utf8'), stored);
});

test('schema census refuses a non-object at a registered durable-record path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mig-census-non-object-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const ledger = path.join(root, 'singularity', 'ledger');
  await mkdir(ledger, { recursive: true });
  await writeFile(path.join(ledger, 'array.json'), '["must-not-appear"]\n');
  const census = await schemaCensus(root);
  assert.equal(census.healthy, false);
  assert.equal(census.totals.registeredRecords, 1);
  assert.equal(census.totals.unreadable, 1);
  assert.deepEqual(census.unreadable, [{
    path: 'singularity/ledger/array.json',
    family: 'ledger-entry',
    storedVersion: null,
    code: 'SCHEMA_RECORD_INVALID',
    reason: 'registered ledger-entry unversioned record failed non-writing migration validation (SCHEMA_RECORD_INVALID)'
  }]);
  assert.doesNotMatch(JSON.stringify(census), /must-not-appear/);
});

test('schema census never copies invalid schema-version content into diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mig-census-invalid-version-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const ledger = path.join(root, 'singularity', 'ledger');
  await mkdir(ledger, { recursive: true });
  await writeFile(path.join(ledger, 'invalid-version.json'), JSON.stringify({
    schemaVersion: { accessToken: 'registered-secret-must-not-appear' }
  }));
  await writeFile(path.join(root, 'singularity', 'unknown.json'), JSON.stringify({
    schemaVersion: { apiKey: 'unregistered-secret-must-not-appear' }
  }));

  const census = await schemaCensus(root);
  assert.equal(census.healthy, false);
  assert.equal(census.totals.registeredRecords, 1);
  assert.equal(census.totals.unreadable, 1);
  assert.equal(census.totals.unregistered, 1);
  assert.deepEqual(census.unreadable, [{
    path: 'singularity/ledger/invalid-version.json',
    family: 'ledger-entry',
    storedVersion: null,
    code: 'SCHEMA_VERSION_INVALID',
    reason: 'registered ledger-entry record with invalid schema version failed non-writing migration validation (SCHEMA_VERSION_INVALID)'
  }]);
  assert.deepEqual(census.unregistered, [{
    path: 'singularity/unknown.json',
    schemaVersion: null,
    code: 'SCHEMA_VERSION_INVALID'
  }]);
  assert.doesNotMatch(
    JSON.stringify(census),
    /registered-secret|unregistered-secret|accessToken|apiKey/
  );
});

test('schema census refuses a governed root symlink without traversing its target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mig-census-root-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-mig-census-outside-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await writeFile(path.join(outside, 'secret.json'), '{"secret":"must-not-appear"}\n');
  await symlink(outside, path.join(root, 'singularity'), process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(schemaCensus(root), (error) => {
    assert.equal(error.code, 'SCHEMA_CENSUS_ROOT_UNSAFE');
    assert.match(error.message, /refused a governed root/);
    assert.doesNotMatch(JSON.stringify({
      message: error.message,
      code: error.code,
      details: error.details
    }), /must-not-appear|secret\.json|sflow-mig-census-outside/);
    return true;
  });
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
