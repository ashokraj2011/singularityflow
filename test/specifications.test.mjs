import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildSpecIndex,
  evaluateSpecAcceptance,
  evaluateSpecCoverage,
  extractClauses,
  normalizeClaimMap,
  renderClauseContext,
  runSpecAcceptance,
  selectClauseContext
} from '../src/specifications.mjs';

const markdown = `# Governed specification

[APP:REQ-001]
The service accepts a rule request.

[APP:AC-001]
Depends on APP:REQ-001. A valid request returns a result.
`;

test('specification clauses are stable, typed, and dependency checked', () => {
  const clauses = extractClauses(markdown, { sourcePath: 'spec.md', namespace: 'APP' });
  assert.deepEqual(clauses.map((clause) => clause.id), ['APP:REQ-001', 'APP:AC-001']);
  assert.deepEqual(clauses[1].dependsOn, ['APP:REQ-001']);
  assert.equal(clauses[0].source.line, 3);
  assert.throws(() => extractClauses(`${markdown}\n[APP:REQ-001]\nduplicate`), /duplicated/);
  assert.throws(() => extractClauses('[APP:AC-001]\nDepends on APP:REQ-999.'), /missing dependency/);
  assert.equal(extractClauses('[APP:AC-001]\nDepends on APP:REQ-999.', {
    externalClauseIds: ['APP:REQ-999']
  })[0].dependsOn[0], 'APP:REQ-999');
  assert.equal(extractClauses('`[APP:REQ-001]` and not a governed clause').length, 0);
  assert.throws(() => extractClauses('[APP:REQ-001]\nAPP:REQ-002\n\n[APP:REQ-002]\nAPP:REQ-001'), /dependency cycle/);
});

test('a specification index binds clauses to the exact source bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-index-'));
  await mkdir(path.join(root, 'artifacts'));
  await writeFile(path.join(root, 'artifacts', 'requirements.md'), markdown);
  const index = await buildSpecIndex(root, 'artifacts/requirements.md', {
    workId: 'WORK-1', phase: 'requirements', generation: 1,
    outputPath: 'context/spec-indexes/requirements-gen1.json',
    policy: { mode: 'record', namespace: 'APP' }
  });
  assert.equal(index.clauses.length, 2);
  assert.match(index.indexSha256, /^[0-9a-f]{64}$/);
  const stored = JSON.parse(await readFile(path.join(root, 'context/spec-indexes/requirements-gen1.json'), 'utf8'));
  assert.equal(stored.source.sha256, index.source.sha256);
});

test('claim maps, coverage, and clause-scoped context preserve traceability', () => {
  const index = { clauses: extractClauses(markdown, { sourcePath: 'spec.md' }) };
  const planned = normalizeClaimMap({
    'APP:REQ-001': { expectedPaths: ['src/app.mjs'], tests: ['test/app.test.mjs'] },
    'APP:AC-001': { expectedPaths: ['src/app.mjs'], tests: ['test/app.test.mjs'] }
  }, { kind: 'planned', clauseIds: index.clauses.map((clause) => clause.id), policy: { mode: 'record' } });
  const observed = normalizeClaimMap({
    'APP:REQ-001': { observedPaths: ['src/app.mjs'], testResults: ['test/app.test.mjs'], verdict: 'matched' },
    'APP:AC-001': { observedPaths: ['src/app.mjs'], testResults: ['test/app.test.mjs'], verdict: 'matched' }
  }, { kind: 'observed', clauseIds: index.clauses.map((clause) => clause.id), policy: { mode: 'record' } });
  const coverage = evaluateSpecCoverage({ indexes: [index], planned: [planned], observed: [observed] }, ['src/app.mjs'], { coverage: 'enforce' });
  assert.equal(coverage.complete, true);
  const selected = selectClauseContext([index], ['APP:AC-001'], { includeDependencies: true });
  assert.deepEqual(selected.map((clause) => clause.id), ['APP:AC-001', 'APP:REQ-001']);
  assert.match(renderClauseContext(selected), /Selected specification clauses/);
});

test('acceptance policy distinguishes planned evidence from verified execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-acceptance-'));
  const index = { clauses: extractClauses(markdown) };
  const planned = { claims: Object.fromEntries(index.clauses.map((clause) => [clause.id, { tests: ['test/spec.test.mjs'] }])) };
  const observed = { claims: Object.fromEntries(index.clauses.map((clause) => [clause.id, { testResults: ['test/spec.test.mjs'] }])) };
  const policy = {
    mode: 'enforce', acceptance: 'verify',
    testCommands: { passing: [process.execPath, '-e', 'process.exit(0)'] }
  };
  assert.equal(evaluateSpecAcceptance({ indexes: [index], planned: [planned], observed: [observed], acceptance: [] }, policy).missingRun, true);
  const run = await runSpecAcceptance(root, policy, {
    workId: 'WORK-1', phase: 'verification', generation: 1,
    outputPath: 'context/acceptance/verification-gen1.json'
  });
  assert.equal(run.status, 'passed');
  assert.equal(evaluateSpecAcceptance({ indexes: [index], planned: [planned], observed: [observed], acceptance: [run] }, policy).complete, true);
});
