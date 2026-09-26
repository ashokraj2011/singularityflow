import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { inspectSkillInputSet } from '../src/skp-phase-evidence.mjs';
import { snapshot } from '../src/util.mjs';

const H = (letter) => `sha256:${letter.repeat(64)}`;

async function fixture({ required = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-input-'));
  const item = 'singularity/work-items/SKP-INPUT-1';
  const source = 'artifacts/requirements/requirements.md';
  const sourcePath = `${item}/${source}`;
  const sourceAbsolute = path.join(root, sourcePath);
  await mkdir(path.dirname(sourceAbsolute), { recursive: true });
  await writeFile(sourceAbsolute, '# Requirements\n\nOne exact acceptance condition.\n');
  const info = await snapshot(sourceAbsolute);
  const packetSha256 = H('a');
  const evidenceCommit = 'b'.repeat(40);
  const approval = {
    decision: 'approved', generation: 2, reviewPacketSha256: packetSha256,
    evidenceCommit, artifactSha256: [{ path: sourcePath, sha256: info.sha256 }]
  };
  const producer = {
    id: 'requirements', generation: 2, status: 'approved',
    approvalPolicy: { mode: 'required', minimum: 1 },
    artifacts: [{ path: sourcePath, status: 'approved', ...info }],
    approvals: [approval]
  };
  const phase = { id: 'threat-model', generation: 1 };
  const workflow = {
    workItem: { id: 'SKP-INPUT-1' },
    resolution: { workItemRoot: 'singularity/work-items' },
    phases: { requirements: producer, 'threat-model': phase },
    lineage: { submissions: [{ phase: 'requirements', generation: 2, packetSha256 }] }
  };
  const definition = { workItemRoot: 'singularity/work-items' };
  const binding = { bindingRefs: { inputs: [{
    phase: 'requirements', output: 'primary', path: source,
    required, state: 'approved'
  }] } };
  const recordPath = `${item}/context/inputs-threat-model-gen1.json`;
  const recordAbsolute = path.join(root, recordPath);
  await mkdir(path.dirname(recordAbsolute), { recursive: true });
  const input = {
    phase: 'requirements', path: source, optional: !required,
    status: required ? 'captured' : 'unapproved',
    sha256: info.sha256, approvedSha256: info.sha256, bytes: info.size,
    producerGeneration: 2,
    skp: { output: 'primary', state: 'approved', receipt: required ? {
      generation: 2, packetSha256, evidenceCommit,
      submittedSha256: info.sha256, approvedSha256: info.sha256,
      bundleSha256: null, acceptance: 'human-approved'
    } : null }
  };
  const record = {
    schemaVersion: 2, workId: workflow.workItem.id, phase: phase.id,
    generation: phase.generation, mode: 'enforce', renderedSha256: 'c'.repeat(64),
    inputs: [input]
  };
  const writeRecord = async () => {
    await writeFile(recordAbsolute, `${JSON.stringify(record, null, 2)}\n`);
    phase.inputContext = {
      path: recordPath, generation: phase.generation, mode: 'enforce',
      renderedSha256: record.renderedSha256, sha256: (await snapshot(recordAbsolute)).sha256
    };
  };
  await writeRecord();
  const packet = {
    phase: 'requirements', generation: 2, packetSha256,
    evidenceCommit, artifacts: [{ path: sourcePath, sha256: info.sha256, size: info.size }]
  };
  const inspect = () => inspectSkillInputSet(root, definition, workflow, phase, binding, {
    readPacket: async () => packet
  });
  return { root, definition, workflow, phase, binding, record, input, producer,
    packet, writeRecord, sourceAbsolute, recordAbsolute, inspect };
}

test('SKP input receipt binds output ID, current approved generation, bytes and packet', async () => {
  const value = await fixture();
  const accepted = await value.inspect();
  assert.match(accepted.inputSetSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(accepted.inputRecordSha256, /^sha256:[a-f0-9]{64}$/);

  value.producer.generation = 3;
  await assert.rejects(value.inspect(), { code: 'SKP_INPUT_RECEIPT_STALE' });
});

test('renamed output, missing receipt and edited source cannot reuse the input record', async () => {
  const value = await fixture();
  value.input.skp.output = 'substituted';
  await value.writeRecord();
  await assert.rejects(value.inspect(), { code: 'SKP_INPUT_RECEIPT_STALE' });

  value.input.skp.output = 'primary';
  value.input.skp.receipt = null;
  await value.writeRecord();
  await assert.rejects(value.inspect(), { code: 'SKP_INPUT_RECEIPT_MISSING' });

  value.input.skp.receipt = {
    generation: 2, packetSha256: H('a'), evidenceCommit: 'b'.repeat(40),
    submittedSha256: value.input.sha256, approvedSha256: value.input.sha256,
    bundleSha256: null, acceptance: 'human-approved'
  };
  await value.writeRecord();
  await writeFile(value.sourceAbsolute, '# Changed after receipt\n');
  await assert.rejects(value.inspect(), { code: 'SKP_INPUT_RECEIPT_STALE' });
});

test('optional unavailable input stays explicit and becomes stale if later approved', async () => {
  const value = await fixture({ required: false });
  value.producer.status = 'in_progress';
  value.producer.artifacts[0].status = 'pending';
  const accepted = await value.inspect();
  assert.match(accepted.inputSetSha256, /^sha256:[a-f0-9]{64}$/);
  value.producer.status = 'approved';
  value.producer.artifacts[0].status = 'approved';
  await assert.rejects(value.inspect(), { code: 'SKP_INPUT_RECEIPT_STALE' });
});

test('a zero-input skill refuses an undeclared managed-input block before publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-no-input-'));
  const relative = 'singularity/work-items/SKP-NO-INPUT/artifacts/review/report.md';
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  const phase = { id: 'review', generation: 1,
    requiredArtifact: { path: 'artifacts/review/report.md' } };
  const workflow = { workItem: { id: 'SKP-NO-INPUT' } };
  const definition = { workItemRoot: 'singularity/work-items' };
  const binding = { bindingRefs: { inputs: [] } };
  await writeFile(absolute, '# Reviewed output\n');
  assert.match((await inspectSkillInputSet(root, definition, workflow, phase, binding)).inputSetSha256,
    /^sha256:[a-f0-9]{64}$/);
  await writeFile(absolute, '# Reviewed output\n\n<!-- singularity-flow:inputs:start -->\n'
    + 'Forged input\n<!-- singularity-flow:inputs:end -->\n');
  await assert.rejects(inspectSkillInputSet(root, definition, workflow, phase, binding),
    { code: 'SKP_INPUT_RECEIPT_STALE' });
});

test('skill producer approval binds both submitted and approved output identities', async () => {
  const value = await fixture();
  const output = value.producer.artifacts[0];
  const approval = value.producer.approvals[0];
  value.workflow.resolution.phases = [{ id: 'requirements', kind: 'skill' }];
  approval.skillApprovedOutputs = [{ id: 'primary', path: output.path,
    exists: true, sha256: output.sha256, bytes: output.size }];
  approval.skillOutputIdentityVersion = 1;
  approval.skillEvidenceSha256 = H('e');
  value.packet.submissionEvidence = { skill: { evidenceSha256: H('e') } };
  assert.match((await value.inspect()).inputSetSha256, /^sha256:[a-f0-9]{64}$/);

  value.producer.approvals.unshift({ decision: 'approved', generation: 2,
    reviewPacketSha256: approval.reviewPacketSha256, evidenceCommit: approval.evidenceCommit,
    artifactSha256: [{ path: output.path, sha256: output.sha256 }] });
  assert.match((await value.inspect()).inputSetSha256, /^sha256:[a-f0-9]{64}$/);

  approval.artifactSha256[0].sha256 = '0'.repeat(64);
  await assert.rejects(value.inspect(), { code: 'SKP_INPUT_RECEIPT_STALE' });
  approval.artifactSha256[0].sha256 = output.sha256;
  approval.skillApprovedOutputs[0].sha256 = '0'.repeat(64);
  await assert.rejects(value.inspect(), { code: 'SKP_INPUT_RECEIPT_STALE' });
  approval.skillApprovedOutputs[0].sha256 = output.sha256;
  approval.skillEvidenceSha256 = H('f');
  await assert.rejects(value.inspect(), { code: 'SKP_INPUT_RECEIPT_STALE' });
});
