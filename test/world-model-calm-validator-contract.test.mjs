import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CALM_SCHEMA_URI, DEFAULT_SCHEMA_ROOT, createCalmToolchainLock,
  validateCalmWithOfficialToolchain } from '../src/world-model/projections/calm/validator.mjs';

const projection = { $schema: CALM_SCHEMA_URI, nodes: [], relationships: [] };
const clean = { hasErrors: false, hasWarnings: false,
  jsonSchemaValidationOutputs: [], spectralSchemaValidationOutputs: [] };
const warning = { severity: 'warning', path: '/nodes', message: 'Style warning.', code: 'style' };
const error = { severity: 'error', path: '/nodes', message: 'Invalid node.', code: 'schema' };
const runner = (status, report, extra = {}) => async () => ({ status,
  stdout: typeof report === 'string' ? report : JSON.stringify(report), stderr: '',
  timedOut: false, aborted: false, error: null, ...extra });

test('validator fails closed for missing, malformed, contradictory or unexplained results', async () => {
  const cases = [
    [0, ''], [0, 'not json'], [0, { hasErrors: false }], [0, []],
    [0, { ...clean, hasErrors: true }],
    [0, { ...clean, spectralSchemaValidationOutputs: [error] }],
    [0, { ...clean, hasWarnings: true }],
    [1, clean], [2, clean], [null, clean], [0, clean, { signal: 'SIGTERM' }],
    [0, 'x'.repeat(1024 * 1024 + 1)]
  ];
  for (const [status, report, extra] of cases) {
    await assert.rejects(validateCalmWithOfficialToolchain(projection, {
      runCommand: runner(status, report, extra)
    }), (failure) => failure.code === 'WMC_CALM_VALIDATOR_UNAVAILABLE');
  }
  await assert.rejects(validateCalmWithOfficialToolchain(projection, {
    runCommand: runner(0, { ...clean, hasErrors: true, jsonSchemaValidationOutputs: [error] })
  }), (failure) => failure.code === 'WMC_CALM_SCHEMA_INVALID');
});

test('only genuine strict-mode warning exits may produce a passing receipt', async () => {
  const report = { ...clean, hasWarnings: true, spectralSchemaValidationOutputs: [warning] };
  assert.equal((await validateCalmWithOfficialToolchain(projection, {
    runCommand: runner(0, clean)
  })).status, 'passed');
  const strict = await validateCalmWithOfficialToolchain(projection, { runCommand: runner(1, report) });
  assert.equal(strict.status, 'passed');
  assert.equal(strict.normalizedResult.hasWarnings, true);
  await assert.rejects(validateCalmWithOfficialToolchain(projection, {
    strict: false, runCommand: runner(1, report)
  }), (failure) => failure.code === 'WMC_CALM_VALIDATOR_UNAVAILABLE');
});

test('a malformed output file cannot be masked by a passing stdout report', async () => {
  await assert.rejects(validateCalmWithOfficialToolchain(projection, {
    runCommand: async (_command, args) => {
      await writeFile(args[args.indexOf('--output') + 1], 'broken');
      return runner(0, clean)();
    }
  }), (failure) => failure.code === 'WMC_CALM_VALIDATOR_UNAVAILABLE');
});

test('changed, missing, extra or symlinked schemas and changed URL mappings are refused', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-calm-schema-lock-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const kind of ['changed', 'missing', 'extra', 'mapping', 'symlink']) {
    const root = path.join(temporary, kind);
    await cp(DEFAULT_SCHEMA_ROOT, root, { recursive: true });
    const schema = path.join(root, 'release', '1.2', 'meta', 'calm.json');
    if (kind === 'changed') {
      const data = JSON.parse(await readFile(schema, 'utf8'));
      data.description = 'Unreviewed schema';
      await writeFile(schema, JSON.stringify(data));
    } else if (kind === 'missing') await rm(schema);
    else if (kind === 'extra') await writeFile(path.join(root, 'unreviewed.json'), '{}');
    else if (kind === 'mapping') {
      const mappingPath = path.join(root, 'url-map.json');
      const mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
      mapping[CALM_SCHEMA_URI] = 'release/1.2/meta/core.json';
      await writeFile(mappingPath, JSON.stringify(mapping));
    } else {
      await rm(schema);
      await symlink(path.join(DEFAULT_SCHEMA_ROOT, 'release', '1.2', 'meta', 'calm.json'), schema);
    }
    await assert.rejects(createCalmToolchainLock({ schemaRoot: root }),
      (failure) => failure.code === 'WMC_CALM_VALIDATOR_UNAVAILABLE');
  }
  assert.ok((await createCalmToolchainLock()).lock.schema.bundleSha256);
});
