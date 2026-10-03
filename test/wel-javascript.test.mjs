import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { replayLocalJavascriptJsonObservation } from '../src/code-delivery-tests.mjs';
import { scanJavaScriptDeclarations } from '../src/verification/javascript-declarations.mjs';
import {
  classifyJavascriptTestCommandScope, observeJavascriptTestIdentities
} from '../src/wel-javascript.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-javascript-'));
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"jest"}}\n');
  await writeFile(path.join(root, 'test', 'payment.test.js'), source);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'WEL JavaScript Test']);
  git(root, ['config', 'user.email', 'wel-js@example.test']);
  git(root, ['remote', 'add', 'origin', 'https://example.test/team/javascript.git']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

const command = {
  id: 'node-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.',
  affectedRoots: ['.'], modelPolicy: 'never',
  result: { adapter: 'jest-json', path: '.sflow/results/node-tests.json', minimumDiscovered: 1 }
};

const policy = {
  mode: 'observe', adapter: 'jest-static-v1', requiredWitnessTypes: ['test'],
  evidenceTier: 'testcase-local-observed'
};

function report(overrides = {}) {
  return {
    numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
    testResults: [{ assertionResults: [{
      ancestorTitles: [], fullName: 'returns balance', title: 'returns balance',
      status: 'passed', duration: 7, ...overrides
    }] }]
  };
}

function parsedReport(value = report(), adapter = 'jest-json') {
  const bytes = Buffer.from(JSON.stringify(value));
  const replay = replayLocalJavascriptJsonObservation([{ contents: bytes }], adapter);
  return {
    adapter, tests: replay.tests, testcaseObservation: replay.testcaseObservation,
    result: {
      path: command.result.path, sha256: replay.result.sha256, bytes: replay.result.bytes,
      files: [{ sourcePath: command.result.path, ...replay.result.files[0] }]
    },
    rawReports: [{ sourcePath: command.result.path, sha256: replay.result.sha256,
      bytes: replay.result.bytes, contents: bytes }],
    minimumDiscovered: 1, minimumPassed: 1
  };
}

test('a literal Jest test binds the @ac clauses above it without claiming execution authority', async () => {
  const source = [
    '// @ac:PAY:AC-001',
    '// @ac:PAY:AC-002',
    'test("returns balance", () => {',
    '  expect(2).toBe(2);',
    '});',
    ''
  ].join('\n');
  const root = await fixture(source);
  const parsed = parsedReport();
  const observation = await observeJavascriptTestIdentities(root, command, parsed, policy);
  assert.equal(observation.status, 'observed');
  assert.equal(observation.exact, true);
  assert.deepEqual(observation.mappingProposals.map((entry) => entry.clauseId).sort(), [
    'PAY:AC-001', 'PAY:AC-002'
  ]);
  assert.equal(observation.occurrences[0].identityStatus, 'exact-static-identity');
  assert.equal(observation.catalog.framework, 'jest');

  // The digest covers the whole test: weakening its assertion under the same name is a change.
  const [declaration] = observation.catalog.declarations;
  assert.equal(source.slice(declaration.span.start, declaration.span.end), source.slice(source.indexOf('test('), source.lastIndexOf('});') + 3));
  const [weakened] = scanJavaScriptDeclarations(source.replace('expect(2).toBe(2);', 'expect(true).toBe(true);'), {
    sourcePath: declaration.sourcePath, framework: 'jest'
  }).declarations;
  assert.notEqual(weakened.declarationSha256, declaration.declarationSha256, 'a weakened assertion kept the reviewed digest');
});

test('dynamic, conditional, unattached and parameterized JavaScript declarations fail safely', async () => {
  for (const source of [
    '// @ac:PAY:AC-001\ndescribe("suite", () => { test("returns balance", () => {}); });\n',
    '// @ac:PAY:AC-001\ntest(`returns ${value}`, () => {\n});\n',
    'if (true)\n// @ac:PAY:AC-001\ntest("returns balance", () => {\n});\n',
    '// @ac:PAY:AC-001\n\ntest("returns balance", () => {\n});\n',
    '// @ac:PAY:AC-001\ntest.each(cases)("returns %s", () => {\n});\n',
    'describe.each([1])("n=%i", () => {\n  // @ac:PAY:AC-001\n  test("returns balance", () => {});\n});\n',
    '// @ac:PAY:AC-001\ntest("returns balance", () => {\n'
  ]) {
    const root = await fixture(source);
    const observation = await observeJavascriptTestIdentities(root, command, parsedReport(), policy);
    assert.equal(observation.exact, false);
    assert.deepEqual(observation.mappingProposals, []);
    assert.ok(observation.gaps.includes('UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE'));
  }
  assert.deepEqual(
    classifyJavascriptTestCommandScope({ argv: ['npm', 'test', '--', '-t', 'balance'] }).gaps,
    ['FOCUSED_OR_RETRIED_TEST_EXECUTION_UNSUPPORTED']
  );

  const collisionRoot = await fixture([
    '// @ac:PAY:AC-001', 'test("returns balance", () => { });',
    '// @ac:PAY:AC-002', 'test("returns balance", () => { });', ''
  ].join('\n'));
  const collision = await observeJavascriptTestIdentities(
    collisionRoot, command, parsedReport(), policy
  );
  assert.equal(collision.exact, false);
  assert.deepEqual(collision.mappingProposals, []);
  assert.ok(collision.gaps.includes('TEST_DECLARATION_COLLISION'));
});

test('Jest/Vitest report replay rejects aggregate drift and ambiguous occurrence identities', () => {
  const bytes = Buffer.from(JSON.stringify(report()));
  const replay = replayLocalJavascriptJsonObservation([{ contents: bytes }], 'jest-json');
  assert.deepEqual(replay.tests, { discovered: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(replay.testcaseObservation.occurrences[0].identityStatus, 'observed-name-only');
  assert.equal(replay.result.sha256, createHash('sha256').update(bytes).digest('hex'));

  assert.throws(() => replayLocalJavascriptJsonObservation([{ contents: Buffer.from(JSON.stringify({
    ...report(), numPassedTests: 0, numFailedTests: 1
  })) }], 'jest-json'), /differ from the reporter aggregate/);

  const duplicate = report();
  duplicate.numTotalTests = 2;
  duplicate.numPassedTests = 2;
  duplicate.testResults[0].assertionResults.push({ ...duplicate.testResults[0].assertionResults[0] });
  const ambiguous = replayLocalJavascriptJsonObservation([{
    contents: Buffer.from(JSON.stringify(duplicate))
  }], 'jest-json');
  assert.ok(ambiguous.testcaseObservation.occurrences.every((entry) =>
    entry.identityStatus === 'ambiguous-display-identity'));

  const vitest = replayLocalJavascriptJsonObservation([{ contents: bytes }], 'vitest-json');
  assert.equal(vitest.testcaseObservation.parser.framework, 'vitest');
});

test('the bounded JavaScript identity corpus produces zero false exact matches', async () => {
  const corpus = JSON.parse(await readFile(
    new URL('./fixtures/wel-javascript/corpus.json', import.meta.url), 'utf8'
  ));
  assert.ok(corpus.length >= 12);
  for (const entry of corpus) {
    const root = await fixture(`${entry.source.join('\n')}\n`);
    const adapter = entry.framework === 'jest' ? 'jest-json' : 'vitest-json';
    const profile = entry.framework === 'jest' ? 'jest-static-v1' : 'vitest-static-v1';
    const value = {
      numTotalTests: entry.tests.length,
      numPassedTests: entry.tests.filter((candidate) => candidate.status === 'passed').length,
      numFailedTests: entry.tests.filter((candidate) => candidate.status === 'failed').length,
      numPendingTests: entry.tests.filter((candidate) =>
        ['pending', 'skipped', 'todo', 'disabled'].includes(candidate.status)).length,
      testResults: [{ assertionResults: entry.tests.map((candidate) => ({
        ancestorTitles: candidate.ancestorTitles,
        fullName: candidate.fullName,
        title: candidate.name,
        status: candidate.status,
        duration: 1
      })) }]
    };
    const parsed = parsedReport(value, adapter);
    const observation = await observeJavascriptTestIdentities(root, {
      ...command, result: { ...command.result, adapter }
    }, parsed, { ...policy, adapter: profile });
    assert.equal(observation.exact, entry.exact, entry.id);
    assert.equal(observation.mappingProposals.length, entry.proposalCount, entry.id);
    if (entry.gap) assert.ok(observation.gaps.includes(entry.gap), entry.id);
    if (entry.exact) {
      assert.ok(observation.occurrences.length > 0, entry.id);
      assert.ok(observation.occurrences.every((occurrence) => occurrence.identityStatus === 'exact-static-identity'), entry.id);
    } else {
      assert.equal(observation.occurrences.length, 0, `${entry.id}: false exact occurrence`);
    }
  }
});
