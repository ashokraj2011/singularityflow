/**
 * A passing test tagged for a criterion establishes that criterion's test evidence, at the code step,
 * Verification and Release alike [fix E]. Story anu-bin (2026-11-11): both tagged Vitest tests of
 * AC-001 passed in the retained run, yet every account said only "suite counts do not establish a
 * clause verdict", Release marked AC-001 and REQ-001 partial, and a person had to accept a risk the
 * tests already disproved. A tagged test that failed or was skipped, or a run the code moved past,
 * still leaves the criterion open.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { createWorkflow, loadConfig, sourceTreeHash, testInputTreeHash } from '../src/state.mjs';
import { createStoryReviewPacket } from '../src/story-lineage.mjs';
import { buildTestExecutionReceipt, replayTestReports } from '../src/code-delivery-tests.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { discoverDeclarations } from '../src/verification/adapters.mjs';
import { testAdapterProfile } from '../src/verification/profiles.mjs';
import { criterionTestEvidence, phaseCriterionTests, withTestedCriteria } from '../src/criterion-test-failures.mjs';
import { phaseExecutionEvidence, renderExecutionEvidence } from '../src/phase-execution-evidence.mjs';
import { readEvidenceConsistency } from '../src/evidence-consistency-read.mjs';
import { renderEvidenceConsistency } from '../src/evidence-consistency.mjs';
import { evaluateSpecCoverage } from '../src/specifications.mjs';

const AC = 'ANU-BIN:AC-001';
const REQ = 'ANU-BIN:REQ-001';
const UNIT = 'src/utils/evaluator.test.js';
const SCREEN = 'src/App.test.jsx';

// The Story's shape: the tag on the line above each test, inside a describe block.
const SOURCES = (framework) => ({
  [UNIT]: `import { describe, it, expect } from '${framework}';\nimport { convertToBinary } from './evaluator.js';\n\n`
    + `describe('convertToBinary', () => {\n  // @ac:${AC}\n  it('converts an evaluated decimal value to binary', () => {\n    expect(convertToBinary(10)).toBe('1010');\n  });\n\n`
    + `  it('reports an error for non-finite values', () => {\n    expect(convertToBinary(Infinity)).toBe('Error');\n  });\n});\n`,
  [SCREEN]: `import { describe, it, expect } from '${framework}';\nimport { render } from './render.js';\n\n`
    + `describe('Standard-mode binary conversion', () => {\n  // @ac:${AC}\n  it('shows the evaluated decimal value in binary', () => {\n    expect(render(10)).toBe('1010');\n  });\n});\n`
});

/** A Jest or Vitest JSON report naming every test of both files, as the runner writes it. */
function jsonReport(root, outcomes = {}) {
  const tests = [
    [UNIT, ['convertToBinary'], 'converts an evaluated decimal value to binary'],
    [UNIT, ['convertToBinary'], 'reports an error for non-finite values'],
    [SCREEN, ['Standard-mode binary conversion'], 'shows the evaluated decimal value in binary']
  ].map(([file, ancestorTitles, title]) => ({ file, ancestorTitles, title, status: outcomes[title] ?? 'passed' }));
  const count = (status) => tests.filter((entry) => entry.status === status).length;
  return JSON.stringify({
    numTotalTests: tests.length, numPassedTests: count('passed'), numFailedTests: count('failed'),
    numPendingTests: count('skipped'), numTodoTests: 0, success: !count('failed'),
    testResults: [UNIT, SCREEN].map((file) => ({ name: path.join(root, file), status: 'passed',
      assertionResults: tests.filter((entry) => entry.file === file).map((entry) => ({
        ancestorTitles: entry.ancestorTitles, fullName: [...entry.ancestorTitles, entry.title].join(' '),
        status: entry.status, title: entry.title, duration: 1, failureMessages: [] })) }))
  });
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}

/** The witnesses publication records: one per tag, on its exact declaration. */
async function witnessesOf(root, profile, commandId) {
  const { declarations } = await discoverDeclarations(root, profile, [UNIT, SCREEN]);
  return declarations.flatMap((declaration) => declaration.clauseIds.map((clauseId) => ({
    clauseId, testSource: declaration.sourcePath, profile, commandId,
    resultAdapter: testAdapterProfile(profile).resultAdapter,
    identity: { framework: declaration.framework, suitePath: declaration.suitePath, name: declaration.name },
    logicalTestId: declaration.logicalTestId, declarationSha256: declaration.declarationSha256, supportSha256: null,
    line: declaration.line, parameters: null, skipped: false, exact: declaration.gaps.length === 0,
    gaps: declaration.gaps.map((entry) => entry.code)
  })));
}

/** One repository, one approved implementation step with its retained run, and Release in progress. */
async function story(t, { adapter = 'vitest-json', outcomes = {} } = {}) {
  const framework = adapter === 'jest-json' ? '@jest/globals' : 'vitest';
  const profile = adapter === 'jest-json' ? 'jest-static-v2' : 'vitest-static-v2';
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-criterion-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-qb', 'main');
  git(root, 'config', 'user.name', 'Criterion Tests');
  git(root, 'config', 'user.email', 'criterion@example.invalid');
  await initializeDefinition(root);
  await mkdir(path.join(root, 'src/utils'), { recursive: true });
  await writeFile(path.join(root, 'src/utils/evaluator.js'), `// @clause:${REQ}\nexport const convertToBinary = (n) => n.toString(2);\n`);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'repository fixture');
  git(root, 'switch', '-qc', 'anu-bin');
  const config = await loadConfig(root);
  const workflow = await createWorkflow(root, config, { id: 'anu-bin', title: 'Binary conversion',
    baseBranch: 'main', workType: 'spec-driven-standard', agent: 'product-owner',
    resolved: resolveWorkType(config, 'spec-driven-standard'), source: { type: 'manual', key: 'anu-bin',
      title: 'Binary conversion', description: 'Show the evaluated value in binary.',
      acceptanceCriteria: ['Unit tests verify decimal-to-binary conversion.'] } });
  for (const [file, text] of Object.entries(SOURCES(framework))) await writeFile(path.join(root, file), text);
  const producer = workflow.phases.implementation;
  Object.assign(producer, { status: 'approved', generation: 1 });
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'tagged tests');
  producer.generationCommit = git(root, 'rev-parse', 'HEAD');
  const check = { id: 'node-tests', kind: 'test', status: 'passed', exitCode: 0, workingDirectory: '.',
    sourceCommit: producer.generationCommit, sourceTreeSha256: await sourceTreeHash(root, config, workflow),
    testInputSha256: await testInputTreeHash(root, config, workflow),
    startedAt: '2026-11-11T06:58:01.979Z', completedAt: '2026-11-11T06:58:04.480Z', stdout: '', stderr: '' };
  producer.checks = [check];
  const parsed = { ...replayTestReports(adapter, [{ contents: Buffer.from(jsonReport(root, outcomes)) }]), minimumDiscovered: 1, minimumPassed: 1 };
  const command = { id: check.id, argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter, path: '.sflow/results/node-tests.json' } };
  const receipt = buildTestExecutionReceipt(command, check, parsed, { attemptId: 'TA-c7b76e50714f1641b5a0',
    nonce: 'fixture-nonce', workId: 'anu-bin', phase: producer.id, generation: 1 });
  const items = 'singularity/work-items/anu-bin/context/code-delivery';
  const receiptPath = `${items}/tests/attempts/implementation/${receipt.attemptId}.json`;
  await mkdir(path.join(root, path.dirname(receiptPath)), { recursive: true });
  await writeFile(path.join(root, receiptPath), canonicalJson(receipt));
  const witnesses = await witnessesOf(root, profile, check.id);
  assert.equal(witnesses.length, 2, 'both tags sit on exact declarations');
  const delivery = { schemaVersion: 2, kind: 'code-delivery', workId: 'anu-bin', phase: producer.id, generation: 1,
    traceability: { required: [AC], bound: [AC], missing: [], ambiguous: [], bindings: [], witnesses } };
  const deliveryPath = `${items}/implementation-gen1.json`;
  await writeFile(path.join(root, deliveryPath), canonicalJson(delivery));
  // Not marked ready: the packet's own witness-review snapshot then needs no specification index here.
  producer.deliveryEvidence = { receiptPath: deliveryPath, receiptSha256: recordSha256(delivery),
    testExecutions: [{ commandId: check.id, receiptPath, receiptSha256: recordSha256(receipt), status: receipt.status }] };
  const submission = await createStoryReviewPacket(root, config, workflow, producer);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'retain the implementation submission');
  const phase = workflow.phases.release;
  workflow.currentPhase = phase.id; phase.status = 'in_progress';
  return { root, config, workflow, phase, producer, receipt, witnesses, submission };
}

test('the Story anu-bin shape: both tagged Vitest tests passed, so AC-001 is established at Verification and Release', async (t) => {
  const item = await story(t);
  const evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.deepEqual(evidence.diagnostics, []);
  const entry = evidence.entries.find((candidate) => candidate.phase === 'implementation');
  assert.equal(entry.checks[0].binding, 'matched');
  assert.deepEqual(entry.criterionTests.map(({ clauseId, testEvidence }) => ({ clauseId, testEvidence })),
    [{ clauseId: AC, testEvidence: 'established' }]);
  assert.deepEqual(entry.criterionTests[0].tests.map((entry) => entry.result), ['passed', 'passed']);
  assert.ok(entry.criterionTests[0].tests.every((entry) => entry.attemptId === item.receipt.attemptId));
  assert.match(renderExecutionEvidence(evidence), /`established` there means each passed through its own result/u);
  // The code step's own coverage reads the same join from its own records.
  assert.deepEqual((await phaseCriterionTests(item.root, item.producer)).map((entry) => entry.testEvidence), ['established']);
  const consistency = await readEvidenceConsistency(item.root, item.config, item.workflow, item.phase,
    { executionEvidence: evidence, visualReviews: null, documents: [] });
  const rendered = renderEvidenceConsistency(consistency);
  const line = rendered.split('\n').find((candidate) => candidate.startsWith(`- ${AC}: `));
  assert.match(line, /test evidence established: each of its own tagged tests passed in a run bound to this source tree: /u);
  for (const label of [`'convertToBinary › converts an evaluated decimal value to binary' in ${UNIT} (TA-c7b76e50714f1641b5a0)`,
    `'Standard-mode binary conversion › shows the evaluated decimal value in binary' in ${SCREEN} (TA-c7b76e50714f1641b5a0)`]) {
    assert.ok(line.includes(label), label);
  }
  assert.match(rendered, /a criterion whose test evidence it lists as established, and a clause verified through it, is not partial or missing/u);
  assert.match(rendered, /Suite counts alone do not establish a clause verdict; each criterion's own tagged tests do/u);
});

test('the same for a Jest run: its tagged tests join by describe path and title', async (t) => {
  const item = await story(t, { adapter: 'jest-json' });
  const evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.equal(evidence.entries[0].criterionTests[0].testEvidence, 'established');
});

test('the same for node:test: its tagged test joins by file and line, never by a name another file shares', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-criterion-node-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = 'test/evaluator.test.mjs';
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, file), `import test from 'node:test';\nimport assert from 'node:assert/strict';\n\n`
    + `// @ac:${AC}\ntest('converts an evaluated decimal value to binary', () => {\n  assert.equal((10).toString(2), '1010');\n});\n`);
  const { declarations } = await discoverDeclarations(root, 'node-test-v1', [file]);
  assert.equal(declarations.length, 1);
  const [declaration] = declarations;
  const witness = { clauseId: AC, testSource: file, profile: 'node-test-v1', commandId: 'node-tests', resultAdapter: 'node-tap',
    identity: { framework: declaration.framework, suitePath: declaration.suitePath, name: declaration.name },
    logicalTestId: declaration.logicalTestId, declarationSha256: declaration.declarationSha256, line: declaration.line,
    parameters: null, skipped: false, exact: true, gaps: [] };
  const attempt = (occurrences) => ({ attemptId: 'TA-0123456789abcdef0123', commandId: 'node-tests', adapter: 'node-tap', status: 'passed',
    exitCode: 0, terminal: true, timedOut: false, tests: { discovered: occurrences.length, passed: occurrences.length, failed: 0, skipped: 0 }, occurrences });
  const own = { file, line: declaration.line, suitePath: [], name: declaration.name, outcome: 'passed' };
  assert.equal(criterionTestEvidence([witness], () => attempt([own]))[0].testEvidence, 'established');
  assert.equal(criterionTestEvidence([witness], () => attempt([{ ...own, file: 'test/other.test.mjs' }]))[0].testEvidence, 'missing',
    'a same-named test in another file never stands in for it');
});

test('a tagged test that failed or was skipped, or one with no result, keeps its criterion open, owned by the code step', async (t) => {
  // A test that passed inside a run that failed does not pass either; a skipped test fails no run.
  for (const [status, results] of [['failed', ['failed', 'failed']], ['skipped', ['passed', 'skipped']]]) {
    const item = await story(t, { outcomes: { 'converts an evaluated decimal value to binary': status } });
    const evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
    const criterion = evidence.entries[0].criterionTests[0];
    assert.equal(criterion.testEvidence, status, status);
    assert.deepEqual(criterion.tests.map((entry) => entry.result).sort(), results);
    const consistency = await readEvidenceConsistency(item.root, item.config, item.workflow, item.phase,
      { executionEvidence: evidence, visualReviews: null, documents: [] });
    assert.match(consistency.summary.join('\n'), new RegExp(`${AC}: test evidence not established: .*implementation, which delivered these tests, owns the repair\\.`, 'u'));
  }
  // A test the run does not name verifies nothing; another passing test in the same file never stands in for it.
  const item = await story(t);
  const renamed = item.witnesses.map((witness) => ({ ...witness, identity: { ...witness.identity, name: `${witness.identity.name} (renamed)` } }));
  assert.equal(criterionTestEvidence(renamed, () => item.receipt)[0].testEvidence, 'missing');
  assert.equal(criterionTestEvidence(item.witnesses, () => null)[0].testEvidence, 'missing');
});

test('a run the code moved past no longer establishes the criterion on the current tree', async (t) => {
  const item = await story(t);
  await writeFile(path.join(item.root, 'src/utils/evaluator.js'), 'export const convertToBinary = () => "0";\n');
  git(item.root, 'add', '.'); git(item.root, 'commit', '-qm', 'change the tested code');
  const evidence = await phaseExecutionEvidence(item.root, item.config, item.workflow, item.phase);
  assert.equal(evidence.entries[0].checks[0].binding, 'stale');
  assert.equal(evidence.entries[0].criterionTests[0].testEvidence, 'stale');
  const consistency = await readEvidenceConsistency(item.root, item.config, item.workflow, item.phase,
    { executionEvidence: evidence, visualReviews: null, documents: [] });
  assert.match(consistency.summary.join('\n'), /not established on this source tree: its run is not bound to the current code/u);
});

test('ratchet: the code step\'s coverage never calls a criterion test-presence-only when its tagged test passed', async (t) => {
  const index = { phase: 'specification', clauses: [{ id: AC, type: 'AC' }] };
  const planned = { claims: { [AC]: { fulfillment: 'test-only', tests: [UNIT], steps: ['implementation'] } } };
  const observed = { phase: 'implementation', claims: { [AC]: { observedPaths: [], testResults: [UNIT], verdict: 'matched' } } };
  const records = { indexes: [index], planned: [planned], observed: [observed] };
  assert.deepEqual(evaluateSpecCoverage(records, [UNIT], {}).testPresenceOnly, [AC], 'nothing joined: presence only, said so');
  const item = await story(t);
  const passed = await withTestedCriteria(item.root, item.producer, evaluateSpecCoverage(records, [UNIT], {}));
  assert.deepEqual(passed.testPresenceOnly, []);
  assert.equal(passed.complete, true);
  for (const status of ['failed', 'skipped']) {
    const open = await story(t, { outcomes: { 'converts an evaluated decimal value to binary': status } });
    assert.deepEqual((await withTestedCriteria(open.root, open.producer, evaluateSpecCoverage(records, [UNIT], {}))).testPresenceOnly, [AC], status);
  }
  // The code step calls it wherever its coverage lists a criterion as presence only.
  const source = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');
  assert.match(source, /evaluateSpecCoverage\(records, changedPaths, policy, \{ root, workflow \}\);\n.*\n  if \(coverageResult\.testPresenceOnly\.length\) await \(await import\('\.\/criterion-test-failures\.mjs'\)\)\.withTestedCriteria\(root, phase, coverageResult\);/u);
});
