import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  buildIncrementalVerificationGraph,
  clearVerificationGraphCache,
  extractModuleSpecifiers,
  loadPersistentVerificationCache,
  resolveAffectedVerificationCohort,
  savePersistentVerificationCache,
  verificationGraphCacheStats
} from '../src/verification/incremental-verification-graph.mjs';
import { scanJavaScriptDeclarations } from '../src/verification/javascript-declarations.mjs';
import {
  analyzeTestFileSignals,
  extractCornerCaseObligations
} from '../src/verification/corner-case-obligations.mjs';
import { discoverDeclarations } from '../src/verification/adapters.mjs';
import {
  defaultSubprocessConcurrency,
  runBoundedTaskPool,
  runQualityCommandPool
} from '../src/quality-command-runner.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('Step 3A: content-addressed verification cache memoizes AST/declaration scans and persists inside .git/sflow-cache without dirtying git status', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ivg-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test User');

  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  const sourceCode = [
    'export function computeDiscount(price, rate) {',
    '  if (price == null) throw new TypeError("price required");',
    '  if (rate <= 0) return price;',
    '  return price * (1 - rate);',
    '}'
  ].join('\n');
  const testCode = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    '// @ac:IVG-1:AC-001',
    'test("computeDiscount handles null and zero boundary", () => {',
    '  assert.throws(() => computeDiscount(null, 0.1));',
    '  assert.equal(computeDiscount(100, 0), 100);',
    '});'
  ].join('\n');
  await writeFile(path.join(root, 'src/discount.mjs'), sourceCode, 'utf8');
  await writeFile(path.join(root, 'test/discount.test.mjs'), testCode, 'utf8');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');

  clearVerificationGraphCache(root);
  assert.deepEqual(verificationGraphCacheStats(), { version: 1, hits: 0, misses: 0, entries: 0 });

  // First pass: cache misses, computes and stores in memory
  const firstDecl = scanJavaScriptDeclarations(testCode, {
    sourcePath: 'test/discount.test.mjs',
    framework: 'node:test',
    root
  });
  const firstObligations = extractCornerCaseObligations(sourceCode, {
    sourcePath: 'src/discount.mjs',
    root
  });
  const afterFirst = verificationGraphCacheStats();
  assert.equal(afterFirst.misses, 2);
  assert.equal(afterFirst.hits, 0);
  assert.equal(afterFirst.entries, 2);

  // Second pass with identical content: 100% cache hits
  const secondDecl = scanJavaScriptDeclarations(testCode, {
    sourcePath: 'test/discount.test.mjs',
    framework: 'node:test',
    root
  });
  const secondObligations = extractCornerCaseObligations(sourceCode, {
    sourcePath: 'src/discount.mjs',
    root
  });
  const afterSecond = verificationGraphCacheStats();
  assert.equal(afterSecond.hits, 2);
  assert.equal(afterSecond.misses, 2);
  assert.deepEqual(secondDecl, firstDecl);
  assert.deepEqual(secondObligations, firstObligations);

  // Persist to .git/sflow-cache/verification-graph-v1.json and verify git working tree stays clean
  assert.equal(savePersistentVerificationCache(root), true);
  assert.equal(existsSync(path.join(root, '.git', 'sflow-cache', 'verification-graph-v1.json')), true);
  assert.equal(git(root, 'status', '--porcelain'), '');

  // Simulate a new CLI invocation by clearing in-memory cache (without deleting disk file) and re-hydrating
  clearVerificationGraphCache();
  assert.equal(verificationGraphCacheStats().entries, 0);
  assert.equal(loadPersistentVerificationCache(root), true);
  assert.equal(verificationGraphCacheStats().entries, 2);

  const hydratedDecl = scanJavaScriptDeclarations(testCode, {
    sourcePath: 'test/discount.test.mjs',
    framework: 'node:test',
    root
  });
  assert.equal(verificationGraphCacheStats().hits, 1);
  assert.deepEqual(hydratedDecl, firstDecl);

  // Discovering declarations across multiple files populates and reuses the cache
  const discovered = await discoverDeclarations(root, 'node-test-v1', ['test/discount.test.mjs']);
  assert.equal(discovered.declarations.length, 1);
  assert.equal(discovered.declarations[0].clauseIds[0], 'IVG-1:AC-001');
});

test('Step 3A: incremental verification dependency graph computes transitive affected source and test cohorts', () => {
  const sourceByPath = new Map([
    [
      'src/core/math.mjs',
      'export function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }\n'
    ],
    [
      'src/pricing/calculator.mjs',
      [
        '// import { ignored } from "./commented-out.mjs";',
        'import { clamp } from "../core/math.mjs";',
        'export function price(amount) { return clamp(amount, 0, 1000); }'
      ].join('\n')
    ],
    [
      'src/billing/invoice.mjs',
      'import { price } from "../pricing/calculator.mjs";\nexport const invoiceTotal = (x) => price(x);\n'
    ],
    [
      'src/unrelated/logger.mjs',
      'export function log(msg) { return String(msg); }\n'
    ],
    [
      'test/invoice.test.mjs',
      'import { invoiceTotal } from "../src/billing/invoice.mjs";\n'
    ],
    [
      'test/pricing.test.mjs',
      'import { price } from "../src/pricing/calculator.mjs";\n'
    ],
    [
      'test/logger.test.mjs',
      'import { log } from "../src/unrelated/logger.mjs";\n'
    ]
  ]);

  assert.deepEqual(
    extractModuleSpecifiers(sourceByPath.get('src/pricing/calculator.mjs'), { sourcePath: 'src/pricing/calculator.mjs' }),
    ['../core/math.mjs']
  );

  const allSourcePaths = [
    'src/core/math.mjs',
    'src/pricing/calculator.mjs',
    'src/billing/invoice.mjs',
    'src/unrelated/logger.mjs'
  ];
  const allTestPaths = [
    'test/invoice.test.mjs',
    'test/pricing.test.mjs',
    'test/logger.test.mjs'
  ];

  const graph = buildIncrementalVerificationGraph({
    files: [...allSourcePaths, ...allTestPaths],
    sourceByPath
  });
  assert.match(graph.graphSha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(graph.dependentsByFile['src/core/math.mjs'], ['src/pricing/calculator.mjs']);
  assert.deepEqual(graph.dependentsByFile['src/pricing/calculator.mjs'], ['src/billing/invoice.mjs', 'test/pricing.test.mjs']);

  // Changing leaf module `src/core/math.mjs` transitively affects `calculator.mjs`, `invoice.mjs`,
  // `pricing.test.mjs`, and `invoice.test.mjs`, while leaving `logger.mjs` and `logger.test.mjs` untouched.
  const cohort = resolveAffectedVerificationCohort({
    changedPaths: ['src/core/math.mjs'],
    allSourcePaths,
    allTestPaths,
    sourceByPath
  });
  assert.deepEqual(cohort.affectedSourcePaths, [
    'src/billing/invoice.mjs',
    'src/core/math.mjs',
    'src/pricing/calculator.mjs'
  ]);
  assert.deepEqual(cohort.affectedTestPaths, [
    'test/invoice.test.mjs',
    'test/pricing.test.mjs'
  ]);
  assert.deepEqual(cohort.unchangedTestPaths, [
    'test/logger.test.mjs'
  ]);
});

test('Step 3B: runBoundedTaskPool and runQualityCommandPool enforce maxConcurrency, preserve deterministic ordering, and fail-fast abort', async () => {
  assert.equal(defaultSubprocessConcurrency(2), 2);
  assert.equal(defaultSubprocessConcurrency(100), 16);
  assert.equal(defaultSubprocessConcurrency() >= 1 && defaultSubprocessConcurrency() <= 4, true);

  // 1. Concurrency cap & deterministic output order even when later tasks finish faster
  const delays = [60, 40, 10, 30, 5, 20];
  const poolResult = await runBoundedTaskPool(
    delays,
    async (delayMs, { index }) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return `task-${index}-${delayMs}`;
    },
    { maxConcurrency: 2 }
  );
  assert.equal(poolResult.maxConcurrency, 2);
  assert.equal(poolResult.peakConcurrency <= 2, true);
  assert.equal(poolResult.completedCount, 6);
  assert.deepEqual(poolResult.results, [
    'task-0-60',
    'task-1-40',
    'task-2-10',
    'task-3-30',
    'task-4-5',
    'task-5-20'
  ]);

  // 2. Subprocess pool with failFast: true aborts in-flight and queued subprocesses when a required command fails
  const commands = [
    {
      id: 'fast-fail',
      argv: [process.execPath, '-e', 'process.exit(2)'],
      requirement: 'required'
    },
    {
      id: 'slow-inflight',
      argv: [process.execPath, '-e', 'setTimeout(() => console.log("done"), 5000)'],
      requirement: 'required'
    },
    {
      id: 'queued-after-fail',
      argv: [process.execPath, '-e', 'console.log("should-not-complete")'],
      requirement: 'required'
    }
  ];
  const started = Date.now();
  const cmdPool = await runQualityCommandPool(commands, {
    maxConcurrency: 2,
    failFast: true
  });
  const elapsedMs = Date.now() - started;
  assert.equal(cmdPool.aborted, true);
  assert.equal(cmdPool.results[0].id, 'fast-fail');
  assert.equal(cmdPool.results[0].status, 2);
  assert.equal(cmdPool.results[1].aborted, true);
  assert.equal(cmdPool.results[2].aborted, true);
  assert.equal(elapsedMs < 3000, true, `Expected fail-fast abort under 3000ms, took ${elapsedMs}ms`);

  // 3. Advisory failure does not abort required commands under failFast: true
  const advisoryThenRequired = await runQualityCommandPool([
    {
      id: 'advisory-fail',
      argv: [process.execPath, '-e', 'process.exit(1)'],
      requirement: 'advisory'
    },
    {
      id: 'required-pass',
      argv: [process.execPath, '-e', 'process.exit(0)'],
      requirement: 'required'
    }
  ], {
    maxConcurrency: 1,
    failFast: true
  });
  assert.equal(advisoryThenRequired.aborted, false);
  assert.equal(advisoryThenRequired.results[0].status, 1);
  assert.equal(advisoryThenRequired.results[1].status, 0);
  assert.equal(advisoryThenRequired.results[1].aborted, false);

  // 4. Unhandled worker throw aborts in-flight siblings and waits for them to settle before rejecting
  let siblingSettledAfterAbort = false;
  await assert.rejects(
    () => runBoundedTaskPool(
      ['thrower', 'inflight', 'queued'],
      async (item, { signal }) => {
        if (item === 'thrower') {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('worker-boom');
        }
        if (item === 'inflight') {
          await new Promise((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, { once: true });
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          siblingSettledAfterAbort = true;
          return 'aborted-inflight';
        }
        throw new Error('queued task should never launch after sibling error');
      },
      { maxConcurrency: 2, failFast: false }
    ),
    /worker-boom/
  );
  assert.equal(siblingSettledAfterAbort, true);
});

test('forged .git/sflow-cache/verification-graph-v1.json cannot inject fake clauseIds or bypass obligations, and scannerVersion changes cache keys', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ivg-forge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');

  const testCode = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    '// @ac:REAL-1:AC-001',
    'test("real witness", () => {',
    '  assert.equal(1 + 1, 2);',
    '});'
  ].join('\n');
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'test/real.test.mjs'), testCode, 'utf8');

  const {
    VERIFICATION_GRAPH_CACHE_VERSION,
    VERIFICATION_SCANNER_FINGERPRINT,
    verificationFactCacheKey
  } = await import('../src/verification/incremental-verification-graph.mjs');

  assert.notEqual(
    verificationFactCacheKey('javascript-declarations', testCode, { scannerVersion: 'v1' }),
    verificationFactCacheKey('javascript-declarations', testCode, { scannerVersion: 'v2' })
  );

  // Forge a cache entry on disk that injects FAKE-999:AC-999 and empties corner-case obligations
  const declKey = verificationFactCacheKey('javascript-declarations', testCode, {
    sourcePath: 'test/real.test.mjs',
    framework: 'node:test'
  });
  const sourceCode = 'export function risky(x) { if (x == null) throw new Error("bad"); return x; }\n';
  const obKey = verificationFactCacheKey('corner-case-obligations', sourceCode, {
    sourcePath: 'src/risky.mjs',
    changedLines: null
  });
  const cacheDir = path.join(root, '.git', 'sflow-cache');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    path.join(cacheDir, 'verification-graph-v1.json'),
    JSON.stringify({
      cacheVersion: VERIFICATION_GRAPH_CACHE_VERSION,
      scannerFingerprint: VERIFICATION_SCANNER_FINGERPRINT,
      entries: {
        [declKey]: {
          schema: 'javascript-declarations-v1',
          sourcePath: 'test/real.test.mjs',
          framework: 'node:test',
          declarations: [{
            name: 'real witness',
            suitePath: [],
            line: 4,
            skipped: false,
            focused: false,
            clauseIds: ['FAKE-999:AC-999'],
            logicalTestId: 'forged'
          }],
          unattachedTags: [],
          fileGaps: []
        },
        [obKey]: {
          sourcePath: 'src/risky.mjs',
          language: 'javascript',
          assurance: 'ast-syntax',
          obligations: [],
          summary: { errorPath: 0, nullabilityGuard: 0, boundaryCondition: 0, branchDivergence: 0, total: 0 }
        }
      }
    }),
    'utf8'
  );

  clearVerificationGraphCache();
  loadPersistentVerificationCache(root);

  const discovered = await discoverDeclarations(root, 'node-test-v1', ['test/real.test.mjs']);
  assert.deepEqual(discovered.declarations[0].clauseIds, ['REAL-1:AC-001']);

  const extracted = extractCornerCaseObligations(sourceCode, { sourcePath: 'src/risky.mjs', root });
  assert.equal(extracted.obligations.length >= 2, true);
});

