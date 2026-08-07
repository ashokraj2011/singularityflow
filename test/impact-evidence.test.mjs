import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectImpactEvidence, impactSha256, validateImpactEvidence } from '../src/impact.mjs';
import { writeJson } from '../src/util.mjs';

function evidence(overrides = {}) {
  const core = {
    schemaVersion: 1,
    evidenceId: 'ci-duration-1',
    kind: 'ci-observation',
    provider: { id: 'build-system', version: '1.0.0', assurance: 'provider-verified' },
    subject: { workId: 'STORY-7', commitSha: 'a'.repeat(40) },
    observation: { metric: 'elapsed-ms', value: 1200, unit: 'milliseconds', status: 'exact' },
    source: { type: 'ci-run', id: 'run-42' },
    capturedAt: '2026-08-07T00:00:00.000Z',
    ...overrides
  };
  return { ...core, integrity: { sha256: impactSha256(core) } };
}

test('provider evidence is accepted only as a hash-bound observation for the exact Story', () => {
  const normalized = validateImpactEvidence(evidence(), { expectedWorkId: 'STORY-7' });
  assert.equal(normalized.observation.value, 1200);
  assert.equal(normalized.integrity.sha256, impactSha256(Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== 'integrity'))));
  assert.throws(() => validateImpactEvidence(evidence(), { expectedWorkId: 'STORY-8' }), /STORY-8/);
});

test('evidence import cannot smuggle policy, estimates, or altered content', () => {
  assert.throws(() => validateImpactEvidence({ ...evidence(), approvalPolicy: { minimum: 0 } }), /forbidden field/);
  assert.throws(() => validateImpactEvidence(evidence({ provider: { id: 'build-system', version: '1', approvalPolicy: { minimum: 0 } } })), /provider contains forbidden field/);
  assert.throws(() => validateImpactEvidence(evidence({ evidenceId: '../../outside' })), /safe identifier/);
  const unavailable = evidence({ observation: { metric: 'elapsed-ms', value: 99, unit: 'milliseconds', status: 'unavailable' } });
  assert.throws(() => validateImpactEvidence(unavailable), /must not contain an estimated value/);
  const changed = evidence(); changed.observation.value = 10;
  assert.throws(() => validateImpactEvidence(changed), /integrity mismatch/);
});

test('evidence without a provider ID receives a stable verifiable ID', () => {
  const record = validateImpactEvidence({
    schemaVersion: 1,
    kind: 'external-quality',
    provider: { id: 'quality-system', version: '1' },
    subject: { workId: 'STORY-7' },
    observation: { metric: 'escaped-defects', value: 0, unit: 'count', status: 'exact' },
    source: { type: 'api-response', sha256: 'b'.repeat(64) },
    capturedAt: '2026-08-07T00:00:00.000Z'
  }, { expectedWorkId: 'STORY-7' });

  assert.match(record.evidenceId, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateImpactEvidence(record, { expectedWorkId: 'STORY-7' }), record);
});

test('provider collection wraps a raw observation in a strict hash-bound envelope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-impact-provider-'));
  const input = path.join(root, 'observation.json');
  await writeJson(input, { metric: 'required-check-pass-rate', value: 1, unit: 'ratio', status: 'exact' });
  const workflow = {
    workItem: { id: 'STORY-7' }, currentPhase: 'verification',
    measurement: { schemaVersion: 1, exposures: [], evidence: [], invalidations: [] }
  };
  const collected = await collectImpactEvidence(root, { workItemRoot: 'singularity/work-items' }, workflow, {
    providerId: 'build-system', providerVersion: '2', runId: 'run-99', file: input,
    commitSha: 'c'.repeat(40), capturedAt: '2026-08-07T00:00:00.000Z'
  });
  assert.equal(collected.record.provider.assurance, 'provider-verified');
  assert.equal(collected.record.subject.phaseId, 'verification');
  assert.equal(collected.record.source.id, 'run-99');
  assert.equal(workflow.measurement.evidence[0].evidenceId, collected.record.evidenceId);
  await assert.rejects(
    collectImpactEvidence(root, { workItemRoot: 'singularity/work-items' }, workflow, {
      providerId: 'build-system', runId: 'run-100', file: input, commitSha: 'short'
    }),
    /full Git SHA/
  );
});
