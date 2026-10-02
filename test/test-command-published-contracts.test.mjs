import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalJson } from '../src/records.mjs';
import { familyForStoredPath, readRecord } from '../src/schema-migrations.mjs';
import { assertTestCommandCandidateGlobalScope, publishedTestCommandRevalidation, testCommandAmendmentDialect,
  testCommandAmendmentDigest, testCommandRevalidationRequirement,
  TEST_COMMAND_EPOCH_VALIDATION_SCHEMA, validateTestCommandAmendmentRecord,
  validateTestCommandEpochValidation } from '../src/test-command-amendment-contracts.mjs';
import { assertTestCommandWorkflowScope } from '../src/workflow-snapshots.mjs';

const H = `sha256:${'a'.repeat(64)}`; const OID = 'a'.repeat(40);
const command = { id: 'node-test', kind: 'test', argv: ['node', '--test', 'test/existing.test.mjs'] };

test('capture global scope refuses unrelated approved-source drift, including removed safety policy', () => {
  const retained = { workType: 'story', workTypeLabel: 'Story', phases: [],
    testRecovery: { enabled: true }, decisions: { required: true },
    codeDelivery: { enabled: true }, documents: { maxFileBytes: 1024 },
    capability: { policy: { maxDocumentBytes: 1024 } } };
  const candidate = { id: 'story', label: 'Story', phases: [], testRecovery: { enabled: true },
    decisions: { required: true }, codeDelivery: { enabled: true }, documents: { maxFileBytes: 2048 } };
  assertTestCommandCandidateGlobalScope(retained, candidate);
  for (const change of [value => { delete value.testRecovery; }, value => { value.codeDelivery.enabled = false; },
    value => { value.decisions.required = false; }, value => { value.id = 'feature'; },
    value => { value.reworkLoops = { enabled: true }; }]) {
    const mutated = structuredClone(candidate); change(mutated);
    assert.throws(() => assertTestCommandCandidateGlobalScope(retained, mutated));
  }
});
function fixture({ status = 'awaiting_approval' } = {}) {
  const prior = { status: 'in_progress', workItem: { id: 'STORY-1' }, currentPhase: 'implementation',
    lineage: { submissions: [{ id: 'submission-1', reviewPacketSha256: H }] },
    history: [{ event: 'phase_submitted', phase: 'implementation' }],
    phaseOrder: ['specification', 'implementation'], resolution: {
      phases: [{ id: 'specification' }, { id: 'implementation', qualityCommands: [command] }] },
    phases: { specification: { id: 'specification', generation: 1, status: 'approved',
      approvals: [{ actor: 'original-reviewer', at: '2026-01-01T00:00:00.000Z' }], generationPublications: [{ generation: 1, resultDigest: H }] },
    implementation: { id: 'implementation', generation: 2, status,
      qualityCommands: [command], checks: [{ id: 'tests', status: 'passed' }], validationVerdict: { status: 'passed' },
      approvals: [{ decision: 'rejected', reason: 'Older review is immutable history.' }], submittedAt: '2026-10-01T00:00:00.000Z',
      deliveryEvidence: { receiptPath: 'context/code-delivery/implementation-gen2.json', receiptSha256: H },
      generationIntent: { status: 'consumed', path: 'context/generation-start/implementation-gen2.json', receiptSha256: H },
      generationPublications: [1, 2].map(generation => ({ generation, resultDigest: H,
        record: { path: `context/generation-publications/implementation-gen${generation}.json`, sha256: H } })),
      artifacts: [{ path: 'artifacts/implementation/summary.md', sha256: H }] } } };
  const decision = { schemaVersion: 2, kind: 'test-command-adoption-decision', id: 'TCA-001', workId: 'STORY-1',
    phaseId: 'implementation', status: 'approved', approvedAt: '2026-10-02T00:00:00.000Z', reason: 'Correct the approved test invocation without changing any published content.',
    from: { revision: 1, snapshotHash: H, policySha256: H, configurationCommit: OID, commandInventorySha256: H, validationEpoch: 1 },
    to: { revision: 2, policySha256: H, configurationCommit: 'b'.repeat(40), commandInventorySha256: H, validationEpoch: 2 },
    configurationAncestry: { schemaVersion: 1, kind: 'skill-configuration-ancestry', repository: 'https://example.invalid/config.git',
      ancestorCommit: OID, descendantCommit: 'b'.repeat(40), objectFormat: 'sha1', commits: [{ oid: 'b'.repeat(40), bytesBase64: 'AA==' }] },
    review: { path: 'context/test-recovery/command-amendments/TCA-001-review-001.json', sha256: H },
    revalidation: publishedTestCommandRevalidation(prior.phases.implementation) };
  const next = structuredClone(prior); const phase = next.phases.implementation;
  phase.status = 'in_progress'; phase.checks = []; phase.validationVerdict = null;
  phase.qualityCommands[0].argv.push('--test-name-pattern=required');
  next.resolution.phases[1].qualityCommands = structuredClone(phase.qualityCommands);
  next.resolution.testRecoveryValidationEpoch = 2;
  phase.testCommandRevalidation = testCommandRevalidationRequirement(decision);
  return { prior, next, decision };
}

test('published command adoption preserves exact history without creating a new generation', () => {
  const { prior, next, decision } = fixture(); const before = canonicalJson(prior);
  assertTestCommandWorkflowScope(prior, next, 'implementation', { decision });
  assertTestCommandWorkflowScope(prior, next, 'implementation', { decision, replay: true });
  assert.equal(next.phases.implementation.generation, 2);
  assert.deepEqual(next.phases.implementation.approvals, prior.phases.implementation.approvals);
  assert.deepEqual(next.phases.implementation.generationPublications, prior.phases.implementation.generationPublications);
  assert.deepEqual(next.phases.specification, prior.phases.specification);
  assert.equal(canonicalJson(prior), before);
  assert.equal(testCommandAmendmentDialect(decision), 'test-command-adoption/v2');
});

test('published current in-progress phase can establish a fresh pending validation epoch', () => {
  const { prior, next, decision } = fixture({ status: 'in_progress' });
  assertTestCommandWorkflowScope(prior, next, 'implementation', { decision });
});

for (const [label, mutate] of [
  ['fake successor generation', value => { value.next.phases.implementation.generation++; }],
  ['removed old approval', value => { value.next.phases.implementation.approvals = []; }],
  ['rewritten publication', value => { value.next.phases.implementation.generationPublications[0].resultDigest = `sha256:${'c'.repeat(64)}`; }],
  ['rewritten old evidence', value => { value.next.phases.implementation.deliveryEvidence.receiptSha256 = `sha256:${'c'.repeat(64)}`; }],
  ['lost submission history', value => { value.next.phases.implementation.submittedAt = null; }],
  ['rewritten submission lineage', value => { value.next.lineage.submissions = []; }],
  ['rewritten lifecycle history', value => { value.next.history[0].event = 'phase_approved'; }],
  ['reopened original intent', value => { value.next.phases.implementation.generationIntent.status = 'open'; }],
  ['old epoch marker', value => { value.next.phases.implementation.testCommandRevalidation.validationEpoch = 1; }],
  ['stale passing pointer', value => { value.next.phases.implementation.testCommandValidation = { path: 'old.json', sha256: H }; }],
  ['modified draft registration', value => { value.next.phases.implementation.artifacts[0].sha256 = `sha256:${'c'.repeat(64)}`; }],
  ['unrelated completed phase', value => { value.next.phases.specification.status = 'in_progress'; }],
  ['terminal Story', value => { value.prior.status = 'closed'; }],
  ['completed affected phase', value => { value.prior.phases.implementation.status = 'approved'; }],
  ['phase topology', value => { value.next.phaseOrder.reverse(); }],
  ['current phase return', value => { value.next.currentPhase = 'specification'; }]
]) test(`published amendment refuses ${label}`, () => {
  const value = fixture(); mutate(value);
  assert.throws(() => assertTestCommandWorkflowScope(value.prior, value.next, 'implementation', { decision: value.decision, replay: true }));
});

test('v1 records do not acquire published-generation authority through read migration', () => {
  const { prior, next, decision } = fixture();
  delete decision.revalidation; decision.schemaVersion = 1;
  const raw = canonicalJson(decision); const opened = readRecord(decision.kind, decision);
  assert.equal(opened.storedVersion, 1); assert.equal(opened.record.schemaVersion, 2);
  assert.equal(Object.hasOwn(opened.record, 'revalidation'), false);
  assert.equal(testCommandRevalidationRequirement(decision), null);
  assert.equal(testCommandAmendmentDialect(decision), 'test-command-adoption/v1');
  assert.throws(() => validateTestCommandAmendmentRecord(opened.record));
  assert.throws(() => assertTestCommandWorkflowScope(prior, next, 'implementation', { decision }));
  assert.equal(canonicalJson(decision), raw);
});

test('v2 published binding is mandatory and rejects unknown authority-bearing fields', () => {
  const { decision } = fixture(); validateTestCommandAmendmentRecord(decision);
  for (const change of [value => { delete value.revalidation; }, value => { value.revalidation.passing = true; },
    value => { value.revalidation.generation = 0; }, value => { value.revalidation.publicationSha256 = 'unverified'; }]) {
    const record = structuredClone(decision); change(record); assert.throws(() => validateTestCommandAmendmentRecord(record));
  }
});

test('epoch evidence is a closed independently registered observation, never an approval', async () => {
  const record = { schemaVersion: 1, kind: 'test-command-epoch-validation', id: 'TCEV-12345678-1234-4234-8234-123456789012',
    workId: 'STORY-1', phaseId: 'implementation', amendmentId: 'TCA-001', generation: 2, validationEpoch: 2,
    policySha256: H, commandInventorySha256: H, publicationSha256: H, generationCommit: OID, sourceTreeSha256: H,
    deliveryReceipt: { path: 'context/code-delivery/implementation-gen2-epoch2-12345678-1234-4234-8234-123456789012.json', sha256: H },
    checksSha256: H, status: 'passed', validatedAt: '2026-10-02T00:00:00.000Z' };
  validateTestCommandEpochValidation(record);
  const relative = `singularity/work-items/STORY-1/context/test-recovery/epochs/${record.id}.json`;
  assert.equal(familyForStoredPath(relative).id, record.kind);
  assert.equal(familyForStoredPath(`singularity/work-items/STORY-1/${record.deliveryReceipt.path}`).id, 'code-delivery');
  for (const mutated of [{ ...record, approved: true }, { ...record, status: 'accepted-risk' },
    { ...record, deliveryReceipt: { ...record.deliveryReceipt, trusted: true } }]) assert.throws(() => validateTestCommandEpochValidation(mutated));
  const changed = { ...record, validationEpoch: 3 };
  assert.notEqual(testCommandAmendmentDigest(record), testCommandAmendmentDigest(changed));
  const schema = JSON.parse(await readFile(new URL('../schemas/test-command-epoch-validation.schema.json', import.meta.url), 'utf8'));
  delete schema.$schema; delete schema.$id; delete schema.title;
  assert.deepEqual(schema, TEST_COMMAND_EPOCH_VALIDATION_SCHEMA);
});
