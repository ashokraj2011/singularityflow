import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acceptanceIds, inferRepositoryTestCommands, isTestQualityCommand, phaseRequiresCodeDelivery
} from '../src/delivery-evidence.mjs';
import { blockingConformanceVerdicts } from '../src/conformance-verdicts.mjs';

test('explicit and legacy implementation phases require delivery evidence', () => {
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', requiredArtifact: { kind: 'implementation-summary' }
  }), true);
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'artifact-only', requiredArtifact: { kind: 'implementation-summary' }
  }), true, 'an unsafe legacy phase must fail closed at its scope check');
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'file' }
  }), true);
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', generationPolicy: { task: 'analyze' }, requiredArtifact: { kind: 'implementation-summary' }
  }), false, 'an explicit non-code task is the compatibility opt-out');
  assert.equal(phaseRequiresCodeDelivery({
    writeScope: 'source-and-artifact', generationPolicy: { task: 'analyze' }, requiredArtifact: { kind: 'test-evidence' }
  }), false);
});

test('code validation distinguishes executable tests from lint and compile-only checks', () => {
  for (const command of [
    { id: 'maven-tests', argv: ['mvn', '-q', 'test'] },
    { id: 'acceptance-tests', argv: ['npm', 'run', 'acceptance'] },
    { id: 'playwright', argv: ['npx', 'playwright', 'test'] },
    { id: 'verification', argv: ['./mvnw', 'verify'] },
    ['go', 'test', './...'],
    { id: 'shell-tests', argv: ['bash', 'scripts/acceptance-tests.sh'] }
  ]) assert.equal(isTestQualityCommand(command), true, JSON.stringify(command));

  for (const command of [
    { id: 'git-diff-check', argv: ['git', 'diff', '--check'] },
    { id: 'typescript-compile', argv: ['npx', 'tsc', '--noEmit'] },
    'npm run lint',
    ['echo', 'test'],
    ['cat', 'src/test/example.test.js']
  ]) assert.equal(isTestQualityCommand(command), false, JSON.stringify(command));
});

test('repository-native Maven and Node tests are inferred without a model', async () => {
  const maven = await mkdtemp(path.join(os.tmpdir(), 'sflow-maven-quality-'));
  await writeFile(path.join(maven, 'pom.xml'), '<project/>\n');
  assert.deepEqual(await inferRepositoryTestCommands(maven), [
    {
      id: 'maven-tests', kind: 'test', argv: ['mvn', 'test'], workingDirectory: '.',
      affectedRoots: ['.'], modelPolicy: 'never',
      result: { adapter: 'junit-xml', path: 'target/surefire-reports', minimumDiscovered: 1 }
    }
  ]);

  const node = await mkdtemp(path.join(os.tmpdir(), 'sflow-node-quality-'));
  await writeFile(path.join(node, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(await inferRepositoryTestCommands(node), [
    {
      id: 'node-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.',
      affectedRoots: ['.'], modelPolicy: 'never',
      result: { adapter: 'node-tap', path: '.sflow/results/node-tests.tap', minimumDiscovered: 1 }
    }
  ]);
});

test('acceptance tags are required from every predecessor artifact kind', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cross-workflow-acceptance-'));
  const relative = 'singularity/work-items/POC-1/artifacts/poc-intake/intake.md';
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), '# POC intake\n\nAcceptance criterion: AC-017\n');
  const workflow = {
    workItem: { id: 'POC-1' },
    phaseOrder: ['poc-intake', 'poc-test-generation'],
    phases: {
      'poc-intake': { requiredArtifact: { path: 'artifacts/poc-intake/intake.md', kind: 'poc-intake' } },
      'poc-test-generation': { id: 'poc-test-generation' }
    }
  };
  assert.deepEqual(
    await acceptanceIds(root, {
      governance: { requireAcceptanceCriteriaTags: true }, workItemRoot: 'singularity/work-items'
    }, workflow, workflow.phases['poc-test-generation']),
    ['AC-017']
  );
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
