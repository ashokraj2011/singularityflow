import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readReviewArtifactBytes } from '../src/artifact-review-read.mjs';
import { normalizeCodeDeliveryPolicy } from '../src/code-delivery-policy.mjs';
import { runBoundedTaskPool, runQualityCommandPool, verifyCompletedQualityLaunch } from '../src/quality-command-runner.mjs';
import { runDeterministicPropertyChecks } from '../src/verification/corner-case-harness.mjs';
import { analyzeTestFileSignals, evaluateCornerCaseObligationMatrix, extractCornerCaseObligations,
  inspectCornerCaseObligations } from '../src/verification/corner-case-obligations.mjs';
import { clearVerificationGraphCache, getCachedVerificationFact, loadPersistentVerificationCache,
  savePersistentVerificationCache, verificationFactCacheKey } from '../src/verification/incremental-verification-graph.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: childTimeout(30000) });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('a failed cancellation callback still waits for every started worker to settle', async () => {
  const controller = new AbortController();
  let finished = false;
  const failure = new Error('retained cancellation callback');
  await assert.rejects(() => runBoundedTaskPool([0, 1, 2, 3], async item => {
    if (item === 0) { controller.abort(); return 0; }
    await new Promise(resolve => setTimeout(resolve, 30));
    finished = true;
    return item;
  }, { maxConcurrency: 2, signal: controller.signal, onAbortedItem: () => { throw failure; } }),
  error => error === failure);
  // Cancellation may occur before the second worker starts; neither case leaves a running worker.
  const settled = finished;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(finished, settled);
});

test('zero or unbounded property iterations cannot produce a successful verification-shaped result', async () => {
  for (const iterations of [0, -1, 1.5, Infinity, 10001]) {
    await assert.rejects(() => runDeterministicPropertyChecks(() => 1, { iterations }), TypeError);
  }
});

test('bounded quality pools preserve main native execution provenance, never copied receipts', async () => {
  const cwd = process.cwd(), command = process.execPath, args = ['-e', 'process.stdout.write("observed")'];
  const { results } = await runQualityCommandPool([{ id: 'native', command, args, options: { cwd, timeoutMs: 5000 } }]);
  const binding = { command, args, cwd, stdoutFile: null, reportCapture: null,
    environmentSha256: createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex') };
  assert.ok(verifyCompletedQualityLaunch(results[0], binding));
  assert.equal(verifyCompletedQualityLaunch({ ...results[0] }, binding), null);
});

test('unrelated source symbols cannot supply corner-case signals, even with strong passing-shaped assertions', () => {
  const { obligations } = extractCornerCaseObligations('export function parsePort(raw) { if (raw == null) throw new Error("required"); return raw; }',
    { sourcePath: 'src/port.mjs' });
  const source = 'import test from "node:test"; import assert from "node:assert/strict"; import { other } from "../src/other.mjs";'
    + 'test("handles null and throws", () => { assert.throws(() => other(null)); assert.equal(other(0), 0); });';
  const declarations = analyzeTestFileSignals(source, { sourcePath: 'test/other.test.mjs' }).declarations;
  const { matrix } = evaluateCornerCaseObligationMatrix({ obligations, declarations });
  assert.equal(matrix.status, 'incomplete');
  assert.equal(matrix.summary.covered, 0);
  assert.ok(matrix.uncoveredObligations.every(entry => entry.assurance === 'static-signal-only'));
});

test('source read budgets are checked before allocation and inspection failures remain blocking only when opted in', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-port-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(17));
  await assert.rejects(() => readReviewArtifactBytes(root, 'large.txt', 'Bounded fixture', { maximumBytes: 16 }),
    { code: 'REVIEW_ARTIFACT_TOO_LARGE' });
  const phase = { id: 'code', requiredArtifact: { kind: 'implementation-summary' },
    generationIntent: { status: 'open', baseline: { commit: 'missing' } } };
  const workflow = { workItem: { id: 'PORT' }, resolution: {} };
  const advisory = await inspectCornerCaseObligations(root, {}, workflow, phase);
  assert.equal(advisory.cornerCases.status, 'unavailable');
  assert.equal(advisory.cornerCases.blocking, false);
  const enforced = await inspectCornerCaseObligations(root, { governance: { requireAssertionAdequacy: true } }, workflow, phase);
  assert.equal(enforced.cornerCases.blocking, true);
  assert.equal(enforced.findings[0].code, 'EVIDENCE_CORNER_CASE_INSPECTION_UNAVAILABLE');
});

test('optional policy is validated without changing the default pinned policy', () => {
  assert.equal(normalizeCodeDeliveryPolicy().cornerCaseObligations, undefined);
  assert.equal(normalizeCodeDeliveryPolicy({ assertionAdequacy: 'enforce' }).assertionAdequacy, 'enforce');
  assert.throws(() => normalizeCodeDeliveryPolicy({ cornerCaseObligations: 'maybe' }));
  assert.throws(() => normalizeCodeDeliveryPolicy({ assertionAdequacy: true }));
});

test('fact cache distinguishes UTF-16 source identities and refuses oversized or poisoned persistent data', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-port-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  assert.notEqual(verificationFactCacheKey('identity', '\ud800'), verificationFactCacheKey('identity', '\ud801'));
  clearVerificationGraphCache();
  const expected = { facts: ['actual'] };
  const item = getCachedVerificationFact('portable', 'source', {}, () => expected);
  item.facts.push('mutated');
  assert.deepEqual(getCachedVerificationFact('portable', 'source', {}, () => assert.fail('cache miss')), { facts: ['actual'] });
  assert.equal(savePersistentVerificationCache(root), true);
  const cache = path.join(root, '.git/sflow-cache/verification-graph-v1.json');
  const raw = JSON.parse(await readFile(cache, 'utf8'));
  for (const key of Object.keys(raw.entries)) raw.entries[key] = { facts: ['forged'] };
  await writeFile(cache, JSON.stringify(raw));
  clearVerificationGraphCache();
  assert.equal(loadPersistentVerificationCache(root), true);
  assert.deepEqual(getCachedVerificationFact('portable', 'source', {}, () => expected), expected);
  await writeFile(cache, 'x'.repeat(8 * 1024 * 1024 + 1));
  clearVerificationGraphCache();
  assert.equal(loadPersistentVerificationCache(root), false);
});

test('linked Story worktrees persist only reusable syntax facts in common Git storage, never the source tree', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-port-worktree-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repository'), checkout = path.join(root, 'story');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'source.txt'), 'source');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  git(repo, 'worktree', 'add', '-qb', 'story', checkout);
  clearVerificationGraphCache();
  getCachedVerificationFact('portable', 'source', {}, () => ({ count: 1 }));
  assert.equal(savePersistentVerificationCache(checkout), true);
  assert.equal(git(checkout, 'status', '--porcelain'), '');
  clearVerificationGraphCache();
  assert.equal(loadPersistentVerificationCache(checkout), true);
  assert.equal(JSON.parse(await readFile(path.join(repo, '.git/sflow-cache/verification-graph-v1.json'), 'utf8')).cacheVersion, 1);
});
