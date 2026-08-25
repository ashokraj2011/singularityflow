import test from 'node:test';
import assert from 'node:assert/strict';

import { buildActiveClauseCapsule } from '../src/active-clause-capsule.mjs';

test('active clause capsule carries every predecessor clause verbatim with risks and clarifications', () => {
  const workflow = {
    workItem: { id: 'ORDER-1' },
    phaseOrder: ['requirements', 'design', 'implementation'],
    phases: {
      requirements: { id: 'requirements', generation: 1 }, design: { id: 'design', generation: 1 }, implementation: { id: 'implementation', generation: 1 }
    },
    changeRequests: [{
      id: 'CR-001', status: 'open', targetPhase: 'implementation',
      clauseIds: ['ORDER:AC-004'], comment: 'Retain the retry constraint.'
    }]
  };
  const records = { indexes: [{
    phase: 'requirements', source: { path: 'requirements.md', sha256: 'a'.repeat(64) },
    clauses: [{
      id: 'ORDER:AC-004', body: 'Retries stop after three attempts.', bodySha256: 'b'.repeat(64),
      source: { path: 'requirements.md', line: 12 }, dependsOn: ['ORDER:REQ-001']
    }]
  }] };
  const result = buildActiveClauseCapsule(
    records, workflow, workflow.phases.implementation, { risks: ['Retry storms'] }
  );
  assert.match(result.text, /# Active Clause Capsule/);
  assert.match(result.text, /Retries stop after three attempts\./);
  assert.equal(result.capsule.clauses[0].representation, 'verbatim');
  assert.equal(result.capsule.clauses[0].continuityProof, 'present-verbatim');
  assert.deepEqual(result.capsule.openRisks, ['Retry storms']);
  assert.deepEqual(result.capsule.clarifications[0].clauseIds, ['ORDER:AC-004']);
  assert.match(result.capsule.capsuleSha256, /^sha256:[a-f0-9]{64}$/);
});

test('active clause capsule never imports the current or later phase indexes', () => {
  const workflow = {
    workItem: { id: 'ORDER-2' }, phaseOrder: ['requirements', 'implementation'],
    phases: { requirements: { id: 'requirements', generation: 1 }, implementation: { id: 'implementation', generation: 1 } }
  };
  const records = { indexes: [{
    phase: 'implementation', source: { sha256: 'a'.repeat(64) },
    clauses: [{ id: 'ORDER:REQ-999', body: 'Future text', bodySha256: 'b'.repeat(64), dependsOn: [] }]
  }] };
  const result = buildActiveClauseCapsule(records, workflow, workflow.phases.implementation);
  assert.equal(result.capsule.clauses.length, 0);
  assert.equal(result.text, '');
});

test('legacy workflows without phaseOrder degrade to a safe empty predecessor set', () => {
  const workflow = {
    workItem: { id: 'ORDER-LEGACY' }, currentPhase: 'design',
    phases: { design: { id: 'design', generation: 1 } }
  };
  const records = { indexes: [{
    phase: 'design', source: { sha256: 'a'.repeat(64) },
    clauses: [{ id: 'ORDER:CURRENT', body: 'Current clause', bodySha256: 'b'.repeat(64) }]
  }] };
  const result = buildActiveClauseCapsule(records, workflow, workflow.phases.design);
  assert.equal(result.text, '');
  assert.deepEqual(result.capsule.clauses, []);
});
