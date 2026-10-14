import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  extractFunctionSignatures,
  generateCornerCaseTestVectors,
  synthesizeCornerCaseTestHarness,
  createDeterministicFuzzGenerator,
  runDeterministicPropertyChecks
} from '../src/verification/corner-case-harness.mjs';
import {
  extractCornerCaseObligations,
  analyzeTestFileSignals,
  evaluateCornerCaseObligationMatrix
} from '../src/verification/corner-case-obligations.mjs';
import { buildGovernanceRemediationPlan } from '../src/verification/governance-remediation.mjs';
import { phaseDraftCheck } from '../src/phase-draft-check.mjs';
import { evaluateCodeDeliveryPreflight } from '../src/delivery-evidence.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function put(root, relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test('Stage 4: extractFunctionSignatures infers AST parameter domains across JS/TS and polyglot files', () => {
  const tsSource = `
export async function processPayment(amount: number, currency = 'USD', options: Record<string, unknown> = {}, items: string[] = [], isRetry = false) {
  if (amount <= 0) throw new Error('Invalid amount');
  return { amount, currency, isRetry, count: items.length, options };
}

export class AccountLedger {
  transfer(fromAccountId, limitCount = 10) {
    return { fromAccountId, limitCount };
  }
}
`;
  const extracted = extractFunctionSignatures(tsSource, {
    sourcePath: 'src/payment.ts',
    persist: false
  });
  assert.equal(extracted.language, 'typescript');
  assert.equal(extracted.signatures.length, 2);

  const [fnSig, methodSig] = extracted.signatures;
  assert.equal(fnSig.name, 'processPayment');
  assert.equal(fnSig.exported, true);
  assert.equal(fnSig.async, true);
  assert.deepEqual(
    fnSig.parameters.map((param) => ({ name: param.name, domain: param.inferredDomain })),
    [
      { name: 'amount', domain: 'number' },
      { name: 'currency', domain: 'string' },
      { name: 'options', domain: 'object' },
      { name: 'items', domain: 'array' },
      { name: 'isRetry', domain: 'boolean' }
    ]
  );

  assert.equal(methodSig.name, 'AccountLedger.transfer');
  assert.deepEqual(
    methodSig.parameters.map((param) => ({ name: param.name, domain: param.inferredDomain })),
    [
      { name: 'fromAccountId', domain: 'string' },
      { name: 'limitCount', domain: 'number' }
    ]
  );

  const pyExtracted = extractFunctionSignatures(
    'def compute_quota(user_id: str, max_limit: int = 5):\n    return max_limit\n',
    { sourcePath: 'src/quota.py', persist: false }
  );
  assert.equal(pyExtracted.language, 'python');
  assert.equal(pyExtracted.signatures[0].name, 'compute_quota');
  assert.deepEqual(
    pyExtracted.signatures[0].parameters.map((p) => p.inferredDomain),
    ['string', 'number']
  );
});

test('Stage 4: synthesizeCornerCaseTestHarness generates scaffolds that satisfy all corner-case obligations', () => {
  const sourceCode = `
export function calculateDiscount(price, couponCode, options = {}) {
  if (price == null || couponCode === undefined) {
    throw new TypeError('price and couponCode are required');
  }
  if (price <= 0 || price >= 100000) {
    throw new RangeError('price out of bounds');
  }
  if (options?.vip) {
    return price * 0.8;
  } else {
    return price * 0.95;
  }
}
`;
  const { obligations } = extractCornerCaseObligations(sourceCode, {
    sourcePath: 'src/discount.mjs',
    persist: false
  });
  assert.ok(obligations.length >= 4, 'extracts error, nullability, boundary, and branch obligations');

  const { signatures } = extractFunctionSignatures(sourceCode, {
    sourcePath: 'src/discount.mjs',
    persist: false
  });

  // Initially evaluate with an empty/tautological test declaration
  const initialEval = evaluateCornerCaseObligationMatrix({
    obligations,
    declarations: [{
      sourcePath: 'test/discount.test.mjs',
      name: 'placeholder test',
      line: 3,
      skipped: false,
      clauseIds: [],
      assertions: {
        count: 1,
        tautological: 1,
        negative: false,
        boundary: false,
        nullability: false,
        adequacy: 'tautological'
      }
    }],
    signaturesByPath: { 'src/discount.mjs': signatures },
    testPaths: ['test/discount.test.mjs']
  });

  assert.equal(initialEval.matrix.status, 'incomplete');
  assert.equal(initialEval.harness.status, 'ready');
  assert.equal(initialEval.harness.summary.totalScaffolds, 1);
  assert.equal(initialEval.harness.summary.inadequateTests, 1);
  assert.ok(initialEval.harness.scaffolds[0].vectors.length >= 4);
  assert.equal(initialEval.harness.scaffolds[0].targetTestPath, 'test/discount.test.mjs');
  assert.match(initialEval.harness.propertyHarnessCode, /import test from 'node:test'/);

  // Now feed the synthesized scaffold code back into analyzeTestFileSignals and re-evaluate!
  const analyzedSynthesizedTest = analyzeTestFileSignals(initialEval.harness.propertyHarnessCode, {
    sourcePath: 'test/discount.test.mjs',
    persist: false
  });
  const afterScaffoldEval = evaluateCornerCaseObligationMatrix({
    obligations,
    declarations: analyzedSynthesizedTest.declarations,
    signaturesByPath: { 'src/discount.mjs': signatures },
    testPaths: ['test/discount.test.mjs']
  });

  assert.equal(afterScaffoldEval.matrix.status, 'satisfied');
  assert.equal(afterScaffoldEval.matrix.summary.uncovered, 0);
  assert.equal(afterScaffoldEval.matrix.summary.coverageRatio, 1);
  assert.equal(afterScaffoldEval.matrix.summary.inadequateDeclarations, 0);
  assert.equal(afterScaffoldEval.harness.status, 'not-needed');
});

test('Stage 4: createDeterministicFuzzGenerator and runDeterministicPropertyChecks detect invariant, NaN, and non-Error throw bugs deterministically', async () => {
  const genA = createDeterministicFuzzGenerator(1337);
  const genB = createDeterministicFuzzGenerator(1337);
  const seqA = Array.from({ length: 12 }, (_, idx) => genA.nextValue('number', idx));
  const seqB = Array.from({ length: 12 }, (_, idx) => genB.nextValue('number', idx));
  assert.deepEqual(seqA, seqB, 'seeded fuzz generator must be 100% deterministic');

  // 1. Healthy function passes property checks
  const healthyResult = await runDeterministicPropertyChecks(
    (x) => {
      if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError('finite number required');
      return Math.abs(x);
    },
    {
      seed: 42,
      iterations: 20,
      domains: ['number'],
      forbidNaN: true,
      invariant: (_args, out) => out >= 0
    }
  );
  assert.equal(healthyResult.passed, true);
  assert.equal(healthyResult.executed, 20);
  assert.equal(healthyResult.counterexample, null);

  // 2. Function throwing raw string (non-Error) is caught
  const nonErrorResult = await runDeterministicPropertyChecks(
    (val) => {
      if (val === 0) throw 'raw-string-failure';
      return val;
    },
    { seed: 42, iterations: 10, domains: ['number'] }
  );
  assert.equal(nonErrorResult.passed, false);
  assert.equal(nonErrorResult.counterexample.reason, 'NON_ERROR_THROW');

  // 3. Function leaking NaN or breaking invariant is caught
  const nanResult = await runDeterministicPropertyChecks(
    (n) => (n < 0 ? Number.NaN : n),
    { seed: 42, iterations: 10, domains: ['number'], forbidNaN: true }
  );
  assert.equal(nanResult.passed, false);
  assert.equal(nanResult.counterexample.reason, 'NAN_RESULT');
});

test('Stage 4: buildGovernanceRemediationPlan and phaseDraftCheck consolidate P0, P1, and P2 steps with synthesized scaffolds', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-stage4-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Stage 4 Tester');
  git(root, 'config', 'user.email', 'stage4@example.com');

  await put(root, 'src/TransferService.mjs', 'export function transferFunds(amount) { return amount; }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  const baseCommit = git(root, 'rev-parse', 'HEAD');

  // Modify source with undocumented function + uncovered corner-case obligations
  await put(root, 'src/TransferService.mjs', `export function transferFunds(amount, accountId) {
  if (accountId == null) throw new Error('accountId required');
  if (amount <= 0) throw new RangeError('amount must be positive');
  return { amount, accountId };
}
`);
  await put(root, 'test/TransferService.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import { transferFunds } from '../src/TransferService.mjs';

test('happy path only', () => {
  assert.equal(1, 1);
});
`);
  await put(root, 'singularity/work-items/STG4-1/artifacts/implementation/summary.md',
    '# Implementation\n\nImplemented fund transfer logic.\n');

  const phase = {
    id: 'implementation',
    status: 'in_progress',
    generation: 0,
    generationPolicy: {
      task: 'code',
      defaultProducer: 'governed-agent',
      allowedProducers: ['governed-agent']
    },
    generationIntent: {
      status: 'open',
      id: 'intent-stg4',
      baseline: { commit: baseCommit }
    },
    requiredArtifact: {
      path: 'artifacts/implementation/summary.md',
      kind: 'implementation-summary',
      minimumBytes: 15,
      validation: { requiredHeadings: ['Implementation'], forbiddenPlaceholders: [] }
    }
  };
  const workflow = {
    workItem: { id: 'STG4-1' },
    currentPhase: 'implementation',
    phaseOrder: ['implementation'],
    phases: { implementation: phase },
    workIntervals: { current: { sourceBaseCommit: baseCommit } },
    resolution: {}
  };

  // 1. Advisory mode (default): status stays 'ready', remediationPlan has P1 (corner-case/assertion) + P2 (docs)
  const advisoryDraft = await phaseDraftCheck(
    root,
    { workItemRoot: 'singularity/work-items' },
    workflow,
    phase,
    { session: { workId: 'STG4-1', phaseId: 'implementation', agent: 'developer' } }
  );
  assert.equal(advisoryDraft.status, 'ready');
  assert.equal(advisoryDraft.remediationPlan.status, 'advisory-only');
  assert.equal(advisoryDraft.remediationPlan.counts.p0, 0);
  assert.ok(advisoryDraft.remediationPlan.counts.p1 >= 2, 'includes P1 corner-case and tautological test advisories');
  assert.equal(advisoryDraft.remediationPlan.counts.p2, 1, 'includes P2 missing documentation advisory');
  assert.equal(advisoryDraft.cornerCaseObligations.harness.status, 'ready');
  assert.ok(advisoryDraft.cornerCaseObligations.harness.scaffolds.length >= 1);
  assert.match(advisoryDraft.remediationPlan.markdownSummary, /Synthesized Corner-Case Test Scaffolds/);

  // 2. Enforced mode: corner-case obligations become P0 blocking steps with attached testScaffold
  const enforcedDraft = await phaseDraftCheck(
    root,
    {
      workItemRoot: 'singularity/work-items',
      governance: { requireCornerCaseCoverage: true, requireAssertionAdequacy: true }
    },
    workflow,
    phase,
    { session: { workId: 'STG4-1', phaseId: 'implementation', agent: 'developer' } }
  );
  assert.equal(enforcedDraft.status, 'correction-required');
  assert.equal(enforcedDraft.remediationPlan.status, 'action-required');
  assert.ok(enforcedDraft.remediationPlan.counts.p0 >= 2);
  assert.equal(enforcedDraft.remediationPlan.steps[0].priority, 'P0');
  assert.ok(
    enforcedDraft.remediationPlan.steps.some((step) => step.priority === 'P0' && step.testScaffold),
    'P0 corner-case step carries synthesized testScaffold'
  );
});
