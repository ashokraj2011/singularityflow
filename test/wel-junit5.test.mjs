import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildTestExecutionReceipt } from '../src/code-delivery-tests.mjs';
import {
  observeJunit5SurefireIdentities, verifyJunit5SurefireIdentityObservation
} from '../src/wel-junit5.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-junit5-'));
  const relative = 'src/test/java/example/OrderTest.java';
  await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
  await writeFile(path.join(root, relative), source);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'WEL Test']);
  git(root, ['config', 'user.email', 'wel@example.test']);
  git(root, ['remote', 'add', 'origin', 'https://example.test/team/repository.git']);
  git(root, ['add', relative]);
  git(root, ['commit', '-qm', 'fixture']);
  return { root, relative };
}

const command = {
  id: 'maven-tests', kind: 'test', argv: ['mvn', 'test'], workingDirectory: '.',
  affectedRoots: ['.'], modelPolicy: 'never',
  result: { adapter: 'junit-xml', path: 'target/surefire-reports', minimumDiscovered: 1 }
};
const policy = {
  mode: 'observe', adapter: 'junit5-surefire-v1', requiredWitnessTypes: ['test'],
  evidenceTier: 'testcase-local-observed'
};

function parsed(occurrences) {
  return {
    adapter: 'junit-xml', tests: {
      discovered: occurrences.length, passed: occurrences.length, failed: 0, skipped: 0
    },
    testcaseObservation: {
      parser: { id: 'sflow-junit-xml-observer', version: 1 }, occurrences
    },
    result: { path: 'target/surefire-reports', sha256: 'a'.repeat(64), bytes: 10 },
    rawReports: [], minimumDiscovered: 1, minimumPassed: 1
  };
}

test('the production JDK parser binds one qualified JUnit tag to an exact Surefire identity', async () => {
  const source = [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    'import org.junit.jupiter.api.Tag;',
    'class OrderTest {',
    '  @Test',
    '  @Tag("sflow-ac:WRK-1:AC-001")',
    '  void calculatesInterest() {',
    '    org.junit.jupiter.api.Assertions.assertEquals(2, 1 + 1);',
    '  }',
    '  @Test void unrelatedCoverage() {}',
    '}',
    ''
  ].join('\n');
  const { root } = await fixture(source);
  const occurrence = {
    suite: 'OrderTest', className: 'example.OrderTest', name: 'calculatesInterest',
    outcome: 'passed', verdict: 'inconclusive', durationMs: 12, logicalTestId: null,
    declarationSha256: null, exact: false, identityStatus: 'observed-name-only'
  };
  const supplemental = {
    suite: 'OrderTest', className: 'example.OrderTest', name: 'unrelatedCoverage',
    outcome: 'passed', verdict: 'inconclusive', durationMs: 2, logicalTestId: null,
    declarationSha256: null, exact: false, identityStatus: 'observed-name-only'
  };
  const observation = await observeJunit5SurefireIdentities(
    root, command, parsed([occurrence, supplemental]), policy
  );
  assert.equal(observation.status, 'observed');
  assert.equal(observation.exact, true);
  assert.equal(observation.mappingProposals.length, 1);
  assert.equal(observation.mappingProposals[0].clauseId, 'WRK-1:AC-001');
  assert.match(observation.mappingProposals[0].mappingSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(observation.occurrences[0].identityStatus, 'exact-static-identity');
  assert.match(observation.occurrences[0].logicalTestId, /^sha256:[a-f0-9]{64}$/);
  const declaration = source.slice(
    observation.catalog.declarations[0].sourceRange.startCharacter,
    observation.catalog.declarations[0].sourceRange.endCharacter
  );
  assert.equal(
    observation.catalog.declarations[0].sourceDeclarationSha256,
    `sha256:${createHash('sha256').update(Buffer.from(declaration)).digest('hex')}`
  );

  const receipt = buildTestExecutionReceipt(command, {
    status: 'passed', exitCode: 0, stderr: '', sourceCommit: 'b'.repeat(40),
    sourceTreeSha256: 'c'.repeat(64), startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString()
  }, parsed([occurrence, supplemental]), { testcasePolicy: policy, exactTestcaseObservation: observation });
  assert.equal(receipt.testcaseObservation.exact, true);
  assert.equal(receipt.testcaseObservation.occurrences.length, 2);
  assert.equal(receipt.testcaseObservation.occurrences[1].exact, false);
  assert.equal(receipt.testcaseObservation.verdict, 'inconclusive');
  assert.equal(receipt.testcaseObservation.disposition, 'unreviewed-witness-observed');
  assert.equal(receipt.testcaseExecutionProven, false);
  assert.ok(receipt.testcaseObservation.bindingGaps.includes('reviewed-witness-mapping-unavailable'));
  const verified = await verifyJunit5SurefireIdentityObservation(root, receipt.testcaseObservation);
  assert.equal(verified.valid, true, verified.errors.join('\n'));

  const tampered = structuredClone(receipt.testcaseObservation);
  tampered.mappingProposals[0].clauseId = 'WRK-1:AC-999';
  const rejected = await verifyJunit5SurefireIdentityObservation(root, tampered);
  assert.equal(rejected.valid, false);
  assert.ok(rejected.errors.some((error) => /proposal/.test(error)));

  const occurrenceRemoved = structuredClone(receipt.testcaseObservation);
  occurrenceRemoved.occurrences = [];
  const missingOccurrence = await verifyJunit5SurefireIdentityObservation(root, occurrenceRemoved);
  assert.equal(missingOccurrence.valid, false);
  assert.ok(missingOccurrence.errors.some((error) => /no exact report occurrence/.test(error)));
});

test('unsupported JUnit shapes and ambiguous Surefire names can never become exact', async () => {
  const parameterized = [
    'package example;',
    'import org.junit.jupiter.params.ParameterizedTest;',
    'import org.junit.jupiter.api.Tag;',
    'class OrderTest {',
    '  @ParameterizedTest @Tag("sflow-ac:WRK-1:AC-001")',
    '  void calculatesInterest(int input) {}',
    '}',
    ''
  ].join('\n');
  const { root } = await fixture(parameterized);
  const occurrence = {
    suite: 'OrderTest', className: 'example.OrderTest', name: 'calculatesInterest',
    outcome: 'passed', verdict: 'inconclusive', durationMs: 1, logicalTestId: null,
    declarationSha256: null, exact: false, identityStatus: 'ambiguous-display-identity'
  };
  const observation = await observeJunit5SurefireIdentities(root, command, parsed([occurrence]), policy);
  assert.equal(observation.exact, false);
  assert.equal(observation.mappingProposals.length, 0);
  assert.ok(observation.gaps.includes('UNSUPPORTED_JUNIT5_SOURCE_SHAPE'));
  const receipt = buildTestExecutionReceipt(command, {
    status: 'passed', exitCode: 0, stderr: '', sourceCommit: 'b'.repeat(40),
    sourceTreeSha256: 'c'.repeat(64), startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString()
  }, parsed([occurrence]), { testcasePolicy: policy, exactTestcaseObservation: observation });
  assert.equal(receipt.testcaseObservation.exact, false);
  assert.equal(receipt.testcaseObservation.catalog, null);
  assert.deepEqual(receipt.testcaseObservation.mappingProposals, []);
});

test('missing JUnit source remains an unavailable non-blocking observation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-junit5-empty-'));
  git(root, ['init', '-q']);
  const observation = await observeJunit5SurefireIdentities(root, command, parsed([]), policy);
  assert.equal(observation.status, 'unavailable');
  assert.equal(observation.exact, false);
  assert.deepEqual(observation.gaps, ['JUNIT_TEST_SOURCES_UNAVAILABLE']);
});

test('the reviewed JUnit identity corpus produces zero false exact matches', async () => {
  const corpus = JSON.parse(await readFile(
    new URL('./fixtures/wel-junit5/corpus.json', import.meta.url), 'utf8'
  ));
  assert.ok(corpus.length >= 12);
  let expectedExact = 0;
  let observedExact = 0;
  for (const entry of corpus) {
    const { root } = await fixture(`${entry.source.join('\n')}\n`);
    const occurrences = entry.occurrences.map((occurrence, index) => ({
      suite: occurrence.className.split('.').at(-1),
      className: occurrence.className,
      name: occurrence.name,
      outcome: 'passed',
      verdict: 'inconclusive',
      durationMs: index + 1,
      logicalTestId: null,
      declarationSha256: null,
      exact: false,
      identityStatus: occurrence.identityStatus
    }));
    const observation = await observeJunit5SurefireIdentities(
      root, command, parsed(occurrences), policy
    );
    assert.equal(observation.exact, entry.exact, entry.id);
    assert.equal(observation.mappingProposals.length, entry.proposalCount, entry.id);
    if (entry.gap) assert.ok(observation.gaps.includes(entry.gap), entry.id);
    if (entry.exact) {
      expectedExact += 1;
      observedExact += observation.exact ? 1 : 0;
      const receipt = buildTestExecutionReceipt(command, {
        status: 'passed', exitCode: 0, stderr: '', sourceCommit: 'b'.repeat(40),
        sourceTreeSha256: 'c'.repeat(64), startedAt: new Date(0).toISOString(),
        completedAt: new Date(1).toISOString()
      }, parsed(occurrences), { testcasePolicy: policy, exactTestcaseObservation: observation });
      const replay = await verifyJunit5SurefireIdentityObservation(root, receipt.testcaseObservation);
      assert.equal(replay.valid, true, `${entry.id}: ${replay.errors.join('; ')}`);
    } else {
      assert.equal(observation.occurrences.length, 0, `${entry.id}: false exact occurrence`);
    }
  }
  assert.equal(observedExact, expectedExact);
  assert.equal(corpus.filter((entry) => !entry.exact && entry.proposalCount !== 0).length, 0);
});
