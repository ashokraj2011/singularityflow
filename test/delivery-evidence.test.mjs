import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inferRepositoryTestCommands, phaseRequiresCodeDelivery
} from '../src/delivery-evidence.mjs';
import { blockingConformanceVerdicts } from '../src/conformance-verdicts.mjs';

test('explicit code tasks require delivery evidence without changing legacy non-code phases', () => {
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', requiredArtifact: { kind: 'implementation-summary' }
  }), false);
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'file' }
  }), true);
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', generationPolicy: { task: 'analyze' }, requiredArtifact: { kind: 'test-evidence' }
  }), false);
});

test('repository-native Maven and Node tests are inferred without a model', async () => {
  const maven = await mkdtemp(path.join(os.tmpdir(), 'sflow-maven-quality-'));
  await writeFile(path.join(maven, 'pom.xml'), '<project/>\n');
  assert.deepEqual(await inferRepositoryTestCommands(maven), [
    { id: 'maven-tests', argv: ['mvn', '-q', 'test'], modelPolicy: 'never' }
  ]);

  const node = await mkdtemp(path.join(os.tmpdir(), 'sflow-node-quality-'));
  await writeFile(path.join(node, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(await inferRepositoryTestCommands(node), [
    { id: 'node-tests', argv: ['npm', 'test'], modelPolicy: 'never' }
  ]);
});

test('blocking conformance verdicts are parsed from comparison table rows only', () => {
  const report = [
    'The prose may discuss missing context without declaring a verdict.',
    '| Clause ID | Requirement | Code | Tests | Verdict | Deviation |',
    '|---|---|---|---|---|---|',
    '| `APP:AC-001` | x | y | z | `matched` | |',
    '| `APP:AC-002` | x | y | z | `partial` | needs work |',
    '| `APP:AC-003` | x | y | z | `missing` | absent |'
  ].join('\n');
  assert.deepEqual(blockingConformanceVerdicts(report), [
    { clauseId: 'APP:AC-002', verdict: 'partial' },
    { clauseId: 'APP:AC-003', verdict: 'missing' }
  ]);
});
