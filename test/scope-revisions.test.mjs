import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { matrixMarkdown } from '../src/evidence/matrix.mjs';
import { acceptedClauses, recordScopeRevision, removedClauseIds, scopeStaleness, staleClausesOf } from '../src/scope/revisions.mjs';
import { clauseReferences } from '../src/specifications.mjs';

const W = 'REV-1';
const REQ = `${W}:REQ-001`;
const AC1 = `${W}:AC-001`;
const AC2 = `${W}:AC-002`;
const hash = (letter) => letter.repeat(64);
const approval = { decision: 'approved', actor: { login: 'bob' }, authorityGroup: 'reviewers', at: '2026-10-03T00:00:00Z' };
const policy = { mode: 'required', minimum: 1, authorities: ['reviewers'], requiredAuthorities: [] };

function story({ intakeGeneration = 1, implementationGeneration = 1 } = {}) {
  return {
    workItem: { id: W, title: 'Revision fixture' },
    status: 'in_progress', currentPhase: 'testing',
    phaseOrder: ['intake', 'implementation', 'testing'],
    resolution: { plannedClaims: { mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' } } },
    phases: {
      intake: { id: 'intake', status: 'approved', generation: intakeGeneration, approvalPolicy: policy, approvals: [approval], requiredArtifact: { kind: 'requirements' } },
      implementation: {
        id: 'implementation', status: 'approved', generation: implementationGeneration, approvalPolicy: policy, approvals: [approval],
        generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' }
      },
      testing: { id: 'testing', status: 'in_progress', generation: 1, approvalPolicy: policy, approvals: [], requiredArtifact: { kind: 'test-evidence' } }
    }
  };
}

const index = (generation, bodies) => ({
  workId: W, phase: 'intake', generation,
  clauses: [
    { id: REQ, type: 'REQ', source: { path: 'intake.md', line: 3 }, bodySha256: bodies.req, dependsOn: [] },
    { id: AC1, type: 'AC', source: { path: 'intake.md', line: 5 }, bodySha256: bodies.ac1, dependsOn: [REQ] },
    { id: AC2, type: 'AC', source: { path: 'intake.md', line: 6 }, bodySha256: bodies.ac2, dependsOn: [] }
  ]
});

function records({ intakeGeneration, implementationGeneration, bodies }) {
  const claim = { expectedPaths: ['src/value.mjs'], tests: [], testDisposition: 'unspecified', testReason: null };
  return {
    indexes: [index(intakeGeneration, bodies)],
    planned: [{ workId: W, phase: 'intake', generation: intakeGeneration, kind: 'planned', claims: {
      [REQ]: claim,
      [AC1]: { ...claim, tests: ['test/one.test.mjs'], testDisposition: 'applicable' },
      [AC2]: { ...claim, tests: ['test/two.test.mjs'], testDisposition: 'applicable' }
    } }],
    observed: [{ workId: W, phase: 'implementation', generation: implementationGeneration, kind: 'observed', claims: {
      [REQ]: { observedPaths: ['src/value.mjs'], testResults: [], commits: [], verdict: 'matched' },
      [AC1]: { observedPaths: ['src/value.mjs'], testResults: ['test/one.test.mjs'], commits: [], verdict: 'matched' },
      [AC2]: { observedPaths: ['src/value.mjs'], testResults: ['test/two.test.mjs'], commits: [], verdict: 'matched' }
    } }],
    acceptance: []
  };
}

const delivery = (generation) => ({
  phaseId: 'implementation', generation, status: 'ready', testRecovery: null,
  acceptanceCriteria: { bindings: [{ clauseId: AC1, testSource: 'test/one.test.mjs' }, { clauseId: AC2, testSource: 'test/two.test.mjs' }] },
  receipt: { status: 'ready', traceability: { bindings: [
    { clauseId: AC1, testSource: 'test/one.test.mjs', commandId: 'unit' },
    { clauseId: AC2, testSource: 'test/two.test.mjs', commandId: 'unit' }
  ] } },
  executions: [{ commandId: 'unit', kind: 'test-execution', status: 'passed', record: { status: 'passed', tests: { discovered: 2, passed: 2, failed: 0, skipped: 0 } } }]
});

const BEFORE = { req: hash('a'), ac1: hash('b'), ac2: hash('c') };

/** A Story whose intake was approved, built on, and then revised: `revised` names the new bodies. */
function revisedStory(revised, { implementationGeneration = 1 } = {}) {
  const workflow = story();
  recordScopeRevision(workflow, { clauses: acceptedClauses([index(1, BEFORE)]), origin: { kind: 'approval', phase: 'intake', generation: 1 }, at: '2026-10-03T00:00:00.000Z' });
  workflow.phases.intake.generation = 2;
  const after = { ...BEFORE, ...revised };
  recordScopeRevision(workflow, { clauses: acceptedClauses([index(2, after)]), origin: { kind: 'intent-amendment', id: 'AMD-001', phase: 'intake', generation: 2 }, at: '2026-10-03T01:00:00.000Z' });
  workflow.phases.implementation.generation = implementationGeneration;
  return evaluateEvidence(evidenceGraph({
    workflow,
    records: records({ intakeGeneration: 2, implementationGeneration, bodies: after }),
    deliveries: [delivery(implementationGeneration)]
  }));
}

test('a revision is recorded only when the accepted clause set changes, and each one chains to the last', () => {
  const workflow = story();
  const first = recordScopeRevision(workflow, { clauses: acceptedClauses([index(1, BEFORE)]), origin: { kind: 'approval', phase: 'intake', generation: 1 }, at: '2026-10-03T00:00:00.000Z' });
  assert.equal(first.revision, 1);
  assert.equal(first.changes, null, 'the first accepted scope changes nothing that came before it');
  assert.deepEqual(first.dependentGenerations, { implementation: 1, testing: 1 }, 'only steps after the origin can depend on it');
  assert.equal(recordScopeRevision(workflow, { clauses: acceptedClauses([index(1, BEFORE)]), origin: { kind: 'approval', phase: 'intake', generation: 1 }, at: '2026-10-03T00:30:00.000Z' }), null);

  const second = recordScopeRevision(workflow, {
    clauses: acceptedClauses([{ ...index(2, { ...BEFORE, ac2: hash('d') }), clauses: [...index(2, { ...BEFORE, ac2: hash('d') }).clauses.slice(0, 2), { id: `${W}:AC-003`, type: 'AC', bodySha256: hash('e'), dependsOn: [] }] }]),
    origin: { kind: 'intent-amendment', id: 'AMD-001', phase: 'intake', generation: 2 }, at: '2026-10-03T01:00:00.000Z'
  });
  assert.deepEqual(second.changes, { added: [`${W}:AC-003`], revised: [], removed: [AC2] });
  assert.equal(second.previousRevisionSha256, first.revisionSha256);
  assert.match(second.revisionSha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(removedClauseIds(workflow), [AC2], 'a removed clause stays named, never silently dropped');
});

test('staleness follows dependencies and lifts once the step that produced the evidence runs again', () => {
  const clauses = index(2, BEFORE).clauses;
  assert.deepEqual([...staleClausesOf({ changes: { added: [], revised: [REQ], removed: [] } }, clauses)].sort(), [AC1, REQ],
    'a criterion that depends on a revised requirement is stale with it');
  const workflow = story();
  recordScopeRevision(workflow, { clauses: acceptedClauses([index(1, BEFORE)]), origin: { kind: 'approval', phase: 'intake', generation: 1 }, at: '2026-10-03T00:00:00.000Z' });
  recordScopeRevision(workflow, { clauses: acceptedClauses([index(2, { ...BEFORE, ac2: hash('d') })]), origin: { kind: 'intent-amendment', id: 'AMD-001', phase: 'intake', generation: 2 }, at: '2026-10-03T01:00:00.000Z' });
  const staleness = scopeStaleness(workflow, clauses);
  assert.equal(staleness.staleBy(AC2, 'implementation', 1)?.revision, 2);
  assert.equal(staleness.staleBy(AC2, 'implementation', 2), null, 'a later generation is current again');
  assert.equal(staleness.staleBy(AC1, 'implementation', 1), null, 'an unchanged clause keeps its evidence');
  assert.equal(staleness.staleBy(AC2, 'intake', 2), null, 'the step that made the revision is not its own dependent');
  assert.equal(staleness.staleBy(AC2, 'testing', 0), null, 'a step that has published nothing has no stale evidence');
});

test('the matrix shows only the changed clause stale, and every other clause keeps its evidence', () => {
  const evaluation = revisedStory({ ac2: hash('d') });
  const row = (id) => evaluation.rows.find((entry) => entry.id === id);
  const stale = row(AC2).obligations.filter((entry) => entry.facets.freshness === 'stale').map((entry) => entry.responsibility);
  assert.deepEqual(stale, ['implement', 'verify', 'review'], 'the plan came with the revision itself, so it is current');
  assert.ok(row(AC2).obligations.filter((entry) => stale.includes(entry.responsibility)).every((entry) => entry.status === 'pending' && entry.staleSince.revision === 2));
  assert.equal(row(AC2).result, 'pending');
  assert.ok(row(AC2).findings.some((entry) => entry.code === 'EVIDENCE_STALE_AFTER_SCOPE_REVISION'));
  for (const id of [REQ, AC1]) {
    assert.ok(row(id).obligations.every((entry) => entry.facets.freshness === 'current'), `${id} keeps its evidence`);
    assert.equal(row(id).obligations.find((entry) => entry.responsibility === 'implement').status, 'met');
  }
  assert.equal(evaluation.decision.gate, 'block');
  assert.deepEqual([evaluation.summary.scopeRevision.revision, evaluation.summary.scopeRevision.staleRows, evaluation.summary.scopeRevision.standingRows], [2, 1, 2]);
  assert.match(matrixMarkdown(evaluation), /- Scope revision: scope revision 2: 0 added, 1 revised, 0 removed; 1 row\(s\) stale, 2 unaffected/);

  const dependent = revisedStory({ req: hash('f') });
  assert.ok(dependent.rows.find((entry) => entry.id === AC1).obligations.some((entry) => entry.facets.freshness === 'stale'),
    'a criterion depending on a revised requirement is stale too');
  assert.ok(dependent.rows.find((entry) => entry.id === AC2).obligations.every((entry) => entry.facets.freshness === 'current'));

  const rerun = revisedStory({ ac2: hash('d') }, { implementationGeneration: 2 });
  assert.ok(rerun.rows.every((entry) => entry.obligations.every((obligation) => obligation.facets.freshness === 'current')),
    'evidence from the code step run again after the revision is current');
  assert.equal(rerun.summary.scopeRevision.staleRows, 0);
});

test('clause references are exact IDs, never substrings', () => {
  assert.deepEqual(clauseReferences('Covers W-1:AC-001, not XW-1:AC-002 or W-1:AC-0010; see `W-1:REQ-001`.'), ['W-1:AC-001', 'W-1:REQ-001', 'XW-1:AC-002']);
  assert.ok(!clauseReferences('XW-1:AC-002').includes('W-1:AC-002'));
});
