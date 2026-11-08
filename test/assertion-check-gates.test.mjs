/**
 * The assertion and edge-case check runs at the gates in warn mode by default [CQF:REQ-032]: it shows the
 * tests that assert nothing and the changed edge cases no test matches, and refuses nothing that passes
 * today. `off` and `enforce` keep their meaning.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluateCodeDeliveryPreflight } from '../src/delivery-evidence.mjs';
import { beginCodeGeneration } from '../src/generation-boundary.mjs';
import { cornerCaseCheckMode, warnedCornerCaseCheck } from '../src/verification/corner-case-obligations.mjs';
import { ensureWorkIntervalBaseline } from '../src/work-intervals.mjs';

const GIT_ENV = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Check Tester',
  GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'check.tester@example.invalid' };
const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const put = async (root, relative, text) => {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), text);
};

/** A code generation that changes a guarded function and a test that calls it and asserts nothing. */
async function openGeneration(t, codeDelivery = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-assertion-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  await put(root, 'src/index.mjs', 'export const value = () => 1;\n');
  await put(root, 'test/index.test.mjs', 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { value } from "../src/index.mjs";\ntest("baseline", () => { assert.equal(value(), 1); });\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  const base = git(root, 'rev-parse', 'HEAD');
  const phase = { id: 'implementation', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact', sourceBoundary: 'unrestricted',
    generationPolicy: { task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: 'artifacts/implementation/implementation-summary.md', kind: 'implementation-summary', minimumBytes: 20,
      validation: { requiredHeadings: ['Implementation'], forbiddenPlaceholders: [] } } };
  const workflow = { workItem: { id: 'WORK-AC-1' }, currentPhase: 'implementation', phaseOrder: ['implementation'], phases: { implementation: phase },
    workIntervals: { current: null, history: [] }, history: [], resolution: { codeDelivery } };
  const config = { workItemRoot: 'singularity/work-items' };
  await ensureWorkIntervalBaseline(root, config, workflow, { phaseId: phase.id, itemDirectory: path.join(root, 'singularity/work-items/WORK-AC-1'),
    itemRelative: 'singularity/work-items/WORK-AC-1', sourceBaseCommit: base });
  await beginCodeGeneration(root, config, workflow, phase, { agent: 'developer' });
  await put(root, 'singularity/work-items/WORK-AC-1/artifacts/implementation/implementation-summary.md', '# Implementation\n\nWithdraw refuses a non-positive amount.\n');
  await put(root, 'src/index.mjs', ['export function withdraw(balance, amount) {', '  if (amount <= 0) {', '    throw new RangeError("Amount must be positive");', '  }',
    '  return balance - amount;', '}', ''].join('\n'));
  await put(root, 'test/index.test.mjs', ['import test from "node:test";', 'import { withdraw } from "../src/index.mjs";', '',
    'test("withdraws", () => { withdraw(10, 4); });', ''].join('\n'));
  return { root, config, workflow, phase };
}

test('unset, advisory and warn warn at the gates; off and enforce keep their meaning', () => {
  assert.deepEqual([undefined, 'advisory', 'warn', 'off', 'enforce'].map(cornerCaseCheckMode), ['warn', 'warn', 'warn', 'off', 'enforce']);
});

test('at publication a test that asserts nothing warns, and the gate refuses nothing that passes today', async (t) => {
  const { root, config, workflow, phase } = await openGeneration(t);
  const preflight = await evaluateCodeDeliveryPreflight(root, config, workflow, phase, { assertionCheck: true });
  const check = preflight.assertionCheck;
  assert.equal(check.mode, 'warn');
  assert.equal(check.status, 'incomplete');
  assert.equal(check.assurance, 'static-signal-only');
  assert.deepEqual(check.inadequate.map((entry) => [entry.path, entry.line, entry.name, entry.adequacy, entry.clauseIds]),
    [['test/index.test.mjs', 4, 'withdraws', 'missing', []]]);
  assert.ok(check.uncovered.some((entry) => entry.category === 'error-path' && entry.path === 'src/index.mjs'), JSON.stringify(check.uncovered));
  assert.match(check.words, /^Assertion check: 1 test asserts nothing it tests \('withdraws' at test\/index\.test\.mjs:4\); \d changed edge cases? ha(?:s|ve) no matching test \(.*\)\. It warns and refuses nothing\.$/u);
  // Nothing new in the receipt: the matrix stays for a Story that enforces it.
  assert.equal(preflight.cornerCaseMatrix, undefined);
  // Only the gate runs it; other reads of the delivery do not pay for it.
  assert.equal((await evaluateCodeDeliveryPreflight(root, config, workflow, phase)).assertionCheck, undefined);

  // Off for both: nothing runs. Off for one: the other still warns.
  workflow.resolution.codeDelivery = { cornerCaseObligations: 'off', assertionAdequacy: 'off' };
  assert.equal((await evaluateCodeDeliveryPreflight(root, config, workflow, phase, { assertionCheck: true })).assertionCheck, undefined);
  workflow.resolution.codeDelivery = { cornerCaseObligations: 'off' };
  const assertionsOnly = (await evaluateCodeDeliveryPreflight(root, config, workflow, phase, { assertionCheck: true })).assertionCheck;
  assert.deepEqual([assertionsOnly.inadequate.length, assertionsOnly.uncovered.length], [1, 0]);
  // Enforce refuses, as it did.
  workflow.resolution.codeDelivery = { assertionAdequacy: 'enforce' };
  await assert.rejects(() => evaluateCodeDeliveryPreflight(root, config, workflow, phase, { assertionCheck: true }),
    (error) => error.code === 'CODE_DELIVERY_EVIDENCE_REQUIRED' && /no executable assertions/u.test(error.message));
});

test('a check that cannot run at the gate says so and refuses nothing', async (t) => {
  const { root } = await openGeneration(t);
  const tooMany = Array.from({ length: 201 }, (_, index) => `src/file-${index}.mjs`);
  const check = await warnedCornerCaseCheck(root, { changeSet: null, sourcePaths: tooMany, testPaths: [] });
  assert.equal(check.status, 'unavailable');
  assert.match(check.words, /^Assertion check not run: Corner-case inspection exceeds the bounded file cohort.* It refuses nothing\.$/u);
});
