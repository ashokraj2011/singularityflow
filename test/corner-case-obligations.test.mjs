import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { scanJavaScriptDeclarations } from '../src/verification/javascript-declarations.mjs';
import { witnessResult } from '../src/verification/witness-results.mjs';
import { contractResult } from '../src/verification/contract-results.mjs';
import {
  analyzeTestFileSignals,
  cornerCaseMatrixDigest,
  evaluateCornerCaseObligationMatrix,
  extractCornerCaseObligations
} from '../src/verification/corner-case-obligations.mjs';
import {
  evaluateCodeDeliveryPreflight,
  verifyCodeDeliveryReceipt
} from '../src/delivery-evidence.mjs';
import { phaseDraftCheck } from '../src/phase-draft-check.mjs';
import { beginCodeGeneration } from '../src/generation-boundary.mjs';
import { ensureWorkIntervalBaseline } from '../src/work-intervals.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function put(root, relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

test('extractCornerCaseObligations extracts AST corner-case obligations and scopes to changed diff lines', () => {
  const source = [
    'export function unchangedGuard(x) {',
    '  if (x == null) throw new Error("unchanged");',
    '  return x;',
    '}',
    '',
    'export function transferFunds(account, amount, limit = 1000) {',
    '  const balance = account?.balance ?? 0;',
    '  if (account === null || account === undefined) {',
    '    throw new TypeError("Account is required");',
    '  }',
    '  if (amount <= 0 || amount >= limit) {',
    '    return Promise.reject(new RangeError("Amount out of bounds"));',
    '  }',
    '  if (balance > amount) {',
    '    return balance - amount;',
    '  } else {',
    '    return 0;',
    '  }',
    '}'
  ].join('\n');

  const full = extractCornerCaseObligations(source, { sourcePath: 'src/transfer.mjs' });
  const categories = new Set(full.obligations.map((entry) => entry.category));
  assert.equal(categories.has('error-path'), true);
  assert.equal(categories.has('nullability-guard'), true);
  assert.equal(categories.has('boundary-condition'), true);
  assert.equal(categories.has('branch-divergence'), true);
  assert.equal(full.obligations.some((entry) => entry.symbol === 'unchangedGuard'), true);

  // Diff-scoped extraction on lines 6..19 should exclude unchangedGuard (lines 1..4)
  const changedLines = new Set([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const scoped = extractCornerCaseObligations(source, {
    sourcePath: 'src/transfer.mjs',
    changedLines
  });
  assert.equal(scoped.obligations.length > 0, true);
  assert.equal(scoped.obligations.every((entry) => entry.symbol === 'transferFunds'), true);
});

test('scanJavaScriptDeclarations and analyzeTestFileSignals detect missing, tautological, and adequate corner-case assertions', () => {
  const testSource = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    '',
    '// @clause:SPEC-101/AC-1',
    'test("empty witness", () => {',
    '  const value = 42;',
    '});',
    '',
    '// @clause:SPEC-101/AC-2',
    'test("tautological witness", () => {',
    '  assert.equal(1, 1);',
    '  assert.ok(true);',
    '  expect(true).toBe(true);',
    '});',
    '',
    '// @clause:SPEC-101/AC-3',
    'test("handles null, boundary 0, and throws on invalid input", () => {',
    '  assert.equal( clamp(null, 0, 10), 0 );',
    '  assert.equal( clamp(-1, 0, 10), 0 );',
    '  assert.throws(() => clamp("bad", 0, 10), /invalid/i);',
    '});'
  ].join('\n');

  const scanned = scanJavaScriptDeclarations(testSource, { sourcePath: 'test/sample.test.mjs' });
  assert.equal(scanned.declarations.length, 3);

  const [emptyDecl, tautologicalDecl, adequateDecl] = scanned.declarations;
  assert.equal(emptyDecl.assertions.adequacy, 'missing');
  assert.equal(emptyDecl.assertions.count, 0);

  assert.equal(tautologicalDecl.assertions.adequacy, 'tautological');
  assert.equal(tautologicalDecl.assertions.count, 3);
  assert.equal(tautologicalDecl.assertions.tautological, 3);

  assert.equal(adequateDecl.assertions.adequacy, 'adequate');
  assert.equal(adequateDecl.assertions.count, 3);
  assert.equal(adequateDecl.assertions.tautological, 0);
  assert.equal(adequateDecl.assertions.negative, true);
  assert.equal(adequateDecl.assertions.boundary, true);
  assert.equal(adequateDecl.assertions.nullability, true);

  const signals = analyzeTestFileSignals(testSource, { sourcePath: 'test/sample.test.mjs' });
  assert.equal(signals.declarations.length, 3);
});

test('witnessResult and contractResult enforce assertion adequacy when enabled without breaking default witnesses', () => {
  const missingWitness = {
    clauseId: 'SPEC-101/AC-1',
    testSource: 'test/sample.test.mjs',
    profile: 'node-test-v1',
    line: 5,
    identity: { framework: 'node:test', suitePath: [], name: 'empty witness' },
    assertions: { count: 0, tautological: 0, negative: false, boundary: false, nullability: false, adequacy: 'missing' }
  };
  const tautologicalWitness = {
    clauseId: 'SPEC-101/AC-1',
    testSource: 'test/sample.test.mjs',
    profile: 'node-test-v1',
    line: 10,
    identity: { framework: 'node:test', suitePath: [], name: 'tautological witness' },
    assertions: { count: 2, tautological: 2, negative: false, boundary: false, nullability: false, adequacy: 'tautological' }
  };
  const attempt = {
    attemptId: 'att-1',
    status: 'passed',
    exitCode: 0,
    tests: { discovered: 2, passed: 2, failed: 0, skipped: 0 },
    occurrences: [
      { file: 'test/sample.test.mjs', line: 5, suitePath: [], name: 'empty witness', outcome: 'passed' },
      { file: 'test/sample.test.mjs', line: 10, suitePath: [], name: 'tautological witness', outcome: 'passed' }
    ]
  };

  // Default: backward-compatible met status
  const permissive = witnessResult(missingWitness, attempt);
  assert.equal(permissive.status, 'met');

  // Enforced: zero-assertion and tautological witnesses become inconclusive with explicit reasons
  const enforcedMissing = witnessResult(missingWitness, attempt, { enforceAssertionAdequacy: true });
  assert.equal(enforcedMissing.status, 'inconclusive');
  assert.deepEqual(enforcedMissing.reasons, ['TEST_ASSERTION_MISSING']);

  const enforcedTautological = witnessResult(tautologicalWitness, attempt, { enforceAssertionAdequacy: true });
  assert.equal(enforcedTautological.status, 'inconclusive');
  assert.deepEqual(enforcedTautological.reasons, ['TEST_ASSERTION_TAUTOLOGICAL']);

  const contract = contractResult(
    'SPEC-101/AC-1',
    {
      clauseId: 'SPEC-101/AC-1',
      stated: false,
      combination: 'all',
      slots: [{ slot: 'tests', method: 'test', role: 'primary', witness: { kind: 'test-suite' } }]
    },
    [
      { witness: missingWitness, attempt, ready: true },
      { witness: tautologicalWitness, attempt, ready: true }
    ],
    {
      submitted: true,
      rowSubmitted: true,
      requiredAssurance: 'exact-local-observed',
      enforceAssertionAdequacy: true
    }
  );
  assert.equal(contract.status, 'inconclusive');
  assert.deepEqual(
    contract.findings.map((finding) => finding.code),
    ['EVIDENCE_TEST_ASSERTION_MISSING', 'EVIDENCE_TEST_ASSERTION_TAUTOLOGICAL']
  );
});

test('evaluateCornerCaseObligationMatrix matches obligations to test signals and computes tamper-evident digest', () => {
  const source = [
    'export function parsePort(raw) {',
    '  const text = raw ?? "";',
    '  if (text.length === 0) throw new Error("Port required");',
    '  return Number(text);',
    '}'
  ].join('\n');
  const { obligations } = extractCornerCaseObligations(source, { sourcePath: 'src/port.mjs' });
  assert.equal(obligations.length >= 3, true);

  const weakTest = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("happy path only", () => {',
    '  assert.equal(1, 1);',
    '});'
  ].join('\n');
  const weakDecls = analyzeTestFileSignals(weakTest, { sourcePath: 'test/port.test.mjs' }).declarations;
  const incomplete = evaluateCornerCaseObligationMatrix({ obligations, declarations: weakDecls });
  assert.equal(incomplete.matrix.status, 'incomplete');
  assert.equal(incomplete.matrix.uncoveredObligations.length > 0, true);
  assert.equal(incomplete.matrix.inadequateDeclarations.length, 1);
  assert.equal(incomplete.findings.some((finding) => finding.code === 'EVIDENCE_TEST_ASSERTION_TAUTOLOGICAL'), true);
  assert.equal(incomplete.findings.some((finding) => finding.code === 'EVIDENCE_CORNER_CASE_UNCOVERED'), true);

  const strongTest = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { parsePort } from "../src/port.mjs";',
    'test("parsePort handles valid, nullish, empty boundary, and throws on empty input", () => {',
    '  assert.equal(parsePort("8080"), 8080);',
    '  assert.throws(() => parsePort(null), /Port required/);',
    '  assert.throws(() => parsePort(""), /Port required/);',
    '});'
  ].join('\n');
  const strongDecls = analyzeTestFileSignals(strongTest, { sourcePath: 'test/port.test.mjs' }).declarations;
  const satisfied = evaluateCornerCaseObligationMatrix({ obligations, declarations: strongDecls });
  assert.equal(satisfied.matrix.status, 'satisfied');
  assert.equal(satisfied.matrix.uncoveredObligations.length, 0);
  assert.equal(satisfied.matrix.inadequateDeclarations.length, 0);
  assert.equal(satisfied.findings.length, 0);
  assert.equal(satisfied.matrix.matrixSha256, cornerCaseMatrixDigest(satisfied.matrix));
});

test('code delivery preflight, phaseDraftCheck, and receipt verification enforce corner-case and assertion adequacy gates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-corner-case-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test User');
  await put(root, 'src/index.mjs', 'export const value = () => 1;\n');
  await put(root, 'test/index.test.mjs', [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { value } from "../src/index.mjs";',
    'test("baseline", () => { assert.equal(value(), 1); });',
    ''
  ].join('\n'));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  const base = git(root, 'rev-parse', 'HEAD');

  const phase = {
    id: 'implementation',
    status: 'in_progress',
    generation: 0,
    writeScope: 'source-and-artifact',
    sourceBoundary: 'unrestricted',
    generationPolicy: { task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: {
      path: 'artifacts/implementation/implementation-summary.md',
      kind: 'implementation-summary',
      minimumBytes: 20,
      validation: { requiredHeadings: ['Implementation'], forbiddenPlaceholders: [] }
    }
  };
  const workflow = {
    workItem: { id: 'WORK-CC-1' },
    currentPhase: 'implementation',
    phaseOrder: ['implementation'],
    phases: { implementation: phase },
    workIntervals: { current: null, history: [] },
    history: [],
    resolution: {}
  };
  const config = {
    workItemRoot: 'singularity/work-items',
    governance: {
      requireCornerCaseCoverage: true,
      requireAssertionAdequacy: true
    }
  };
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: phase.id,
    itemDirectory: path.join(root, 'singularity/work-items/WORK-CC-1'),
    itemRelative: 'singularity/work-items/WORK-CC-1',
    sourceBaseCommit: base
  });
  await beginCodeGeneration(root, config, workflow, phase, { agent: 'developer' });
  await put(
    root,
    'singularity/work-items/WORK-CC-1/artifacts/implementation/implementation-summary.md',
    '# Implementation\n\nImplemented withdraw with nullability and boundary checks.\n'
  );

  // Introduce new source function with error-path, nullability-guard, and boundary-condition,
  // paired initially with a tautological test.
  await put(root, 'src/index.mjs', [
    '/** Withdraws amount from account balance. */',
    'export function withdraw(account, amount) {',
    '  const balance = account?.balance ?? 0;',
    '  if (amount <= 0) {',
    '    throw new RangeError("Amount must be positive");',
    '  }',
    '  return balance >= amount ? balance - amount : 0;',
    '}',
    ''
  ].join('\n'));
  await put(root, 'test/index.test.mjs', [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { withdraw } from "../src/index.mjs";',
    'test("withdraw tautology", () => {',
    '  assert.equal(1, 1);',
    '});',
    ''
  ].join('\n'));

  // 1. phaseDraftCheck surfaces blocking corner-case and tautological assertion findings
  const blockedDraft = await phaseDraftCheck(root, config, workflow, phase, {
    session: { workId: 'WORK-CC-1', phaseId: 'implementation', agent: 'developer' }
  });
  assert.equal(blockedDraft.status, 'correction-required');
  assert.equal(blockedDraft.cornerCaseObligations.status, 'incomplete');
  assert.equal(blockedDraft.cornerCaseObligations.blocking, true);
  assert.equal(
    blockedDraft.findings.some((finding) => finding.code === 'EVIDENCE_TEST_ASSERTION_TAUTOLOGICAL'),
    true
  );
  assert.equal(
    blockedDraft.findings.some((finding) => finding.code === 'EVIDENCE_CORNER_CASE_UNCOVERED'),
    true
  );

  // 2. evaluateCodeDeliveryPreflight rejects with CODE_DELIVERY_EVIDENCE_REQUIRED and cornerCaseFindings
  await assert.rejects(
    () => evaluateCodeDeliveryPreflight(root, config, workflow, phase),
    (error) => error.code === 'CODE_DELIVERY_EVIDENCE_REQUIRED'
      && error.details?.cornerCaseFindings?.some((finding) => finding.code === 'EVIDENCE_TEST_ASSERTION_TAUTOLOGICAL')
      && error.details?.cornerCaseFindings?.some((finding) => finding.code === 'EVIDENCE_CORNER_CASE_UNCOVERED')
  );

  // 3. Upgrade test with real assertions covering nullability, boundary (0), branch divergence, and negative error path
  await put(root, 'test/index.test.mjs', [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { withdraw } from "../src/index.mjs";',
    'test("withdraw handles positive, insufficient balance, null account, and zero boundary throw", () => {',
    '  assert.equal(withdraw({ balance: 100 }, 40), 60);',
    '  assert.equal(withdraw(null, 10), 0);',
    '  assert.throws(() => withdraw({ balance: 100 }, 0), /Amount must be positive/);',
    '});',
    ''
  ].join('\n'));

  const readyDraft = await phaseDraftCheck(root, config, workflow, phase, {
    session: { workId: 'WORK-CC-1', phaseId: 'implementation', agent: 'developer' }
  });
  assert.equal(readyDraft.status, 'ready', JSON.stringify(readyDraft.findings));
  assert.equal(readyDraft.cornerCaseObligations.status, 'satisfied');
  assert.equal(
    readyDraft.findings.filter((finding) => finding.category === 'verification-contracts').length,
    0
  );

  const preflight = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.equal(preflight.cornerCaseMatrix.status, 'satisfied');
  assert.equal(preflight.cornerCaseMatrix.summary.uncovered, 0);
  assert.equal(preflight.cornerCaseMatrix.summary.inadequateDeclarations, 0);
  // Persisted cornerCaseMatrix is compact and never includes obligations array or generated harness code
  assert.equal(preflight.cornerCaseMatrix.obligations, undefined);
  assert.equal(preflight.cornerCaseMatrix.harness, undefined);

  // phaseDraftCheck is read-only (mutates: false) and must not write .git/sflow-cache/verification-graph-v1.json
  const cacheFile = path.join(root, '.git', 'sflow-cache', 'verification-graph-v1.json');
  await rm(cacheFile, { force: true });
  await phaseDraftCheck(root, config, workflow, phase, {
    session: { workId: 'WORK-CC-1', phaseId: 'implementation', agent: 'developer' }
  });
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(cacheFile), false);

  // Repositories that did not opt in do not get cornerCaseMatrix attached to delivery preflight
  const defaultPreflight = await evaluateCodeDeliveryPreflight(
    root,
    { workItemRoot: 'singularity/work-items' },
    workflow,
    phase
  );
  assert.equal(defaultPreflight.cornerCaseMatrix, undefined);

  // 4. verifyCodeDeliveryReceipt validates cornerCaseMatrix digest and policy
  const tamperedReceipt = {
    kind: 'code-delivery',
    schemaVersion: 2,
    status: 'ready',
    cornerCaseMatrix: {
      ...preflight.cornerCaseMatrix,
      matrixSha256: '0'.repeat(64)
    }
  };
  const tamperedCheck = await verifyCodeDeliveryReceipt(root, tamperedReceipt, { cornerCasePolicy: 'enforce' });
  assert.equal(tamperedCheck.valid, false);
  assert.equal(
    tamperedCheck.errors.includes('corner-case obligation matrix does not match its digest'),
    true
  );
});

test('deeply nested generated TypeScript/JavaScript source does not crash obligation extraction or preflight with RangeError', () => {
  const depth = 2500;
  const nestedExpr = `${'('.repeat(depth)}x == null ? 0 : 1${')'.repeat(depth)}`;
  const deepSource = `export function generatedDeep(x) {\n  return ${nestedExpr};\n}\n`;
  const result = extractCornerCaseObligations(deepSource, { sourcePath: 'src/generated.ts' });
  assert.equal(Array.isArray(result.obligations), true);
  assert.equal(result.obligations.length >= 1, true);
});

