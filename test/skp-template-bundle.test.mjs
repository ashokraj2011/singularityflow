import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { catalogArtifactSet, normalizeArtifactSet } from '../src/artifact-sets.mjs';
import {
  inspectSkillInputSet, verifyTemplateProducerSetContinuity
} from '../src/skp-phase-evidence.mjs';
import { artifactMetadataBlock, storyArtifactMetadata } from '../src/state.mjs';
import { snapshot } from '../src/util.mjs';

const packetId = `sha256:${'a'.repeat(64)}`;

async function fixture(t, { consume = 'primary' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-template-set-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'SKP Test');
  git('config', 'user.email', 'skp-test@example.invalid');

  const workId = 'SKP-TEMPLATE-1';
  const item = `singularity/work-items/${workId}`;
  const primary = 'artifacts/requirements/requirements.md';
  const secondary = 'artifacts/requirements/checklist.md';
  const primaryPath = `${item}/${primary}`;
  const secondaryPath = `${item}/${secondary}`;
  const primaryAbsolute = path.join(root, primaryPath);
  const secondaryAbsolute = path.join(root, secondaryPath);
  const set = normalizeArtifactSet({
    primary: 'requirements.md',
    members: [
      { path: 'requirements.md', role: 'requirements', required: true, authority: 'governed' },
      { path: 'checklist.md', role: 'checklist', required: true, authority: 'governed' }
    ]
  }, 'requirements-set');
  const definition = { workItemRoot: 'singularity/work-items' };
  const producer = {
    id: 'requirements', generation: 1, status: 'awaiting_approval',
    requiredArtifact: { path: primary, kind: 'markdown' },
    approvalPolicy: { mode: 'required', minimum: 1 },
    approvals: [], telemetry: [], usage: [], artifacts: []
  };
  const consumer = { id: 'review', generation: 1 };
  const workflow = {
    workItem: { id: workId, workType: 'custom', branch: 'main' },
    resolution: {
      workItemRoot: definition.workItemRoot, configSha256: '0'.repeat(64),
      templates: { requirements: 'common/requirements.md' },
      phases: [{ id: producer.id, artifactSet: set.id }],
      artifactSets: { [set.id]: set }
    },
    phases: { requirements: producer, review: consumer },
    lineage: { submissions: [] }, history: []
  };
  await mkdir(path.dirname(primaryAbsolute), { recursive: true });
  const body = '\n\n# Requirements\n\nThe approved acceptance criteria remain unchanged.\n';
  const submittedText = `${artifactMetadataBlock(storyArtifactMetadata(workflow, producer))}${body}`;
  await writeFile(primaryAbsolute, submittedText);
  await writeFile(secondaryAbsolute, '# Checklist\n\nOne independent result.\n');
  const submittedPrimary = await snapshot(primaryAbsolute);
  const submittedSecondary = await snapshot(secondaryAbsolute);
  producer.artifacts = [
    { path: primaryPath, kind: 'markdown', status: 'pending', ...submittedPrimary },
    { path: secondaryPath, kind: 'markdown', status: 'pending', ...submittedSecondary }
  ];
  producer.artifactSet = {
    ...await catalogArtifactSet(root, item, producer, set), generation: 1
  };
  git('add', '-A');
  git('commit', '-qm', 'Submit complete template bundle');
  const evidenceCommit = git('rev-parse', 'HEAD');
  const packet = {
    phase: producer.id, generation: 1, packetSha256: packetId, evidenceCommit,
    artifacts: [
      { path: primaryPath, sha256: submittedPrimary.sha256, size: submittedPrimary.size },
      { path: secondaryPath, sha256: submittedSecondary.sha256, size: submittedSecondary.size }
    ]
  };
  workflow.lineage.submissions.push({ phase: producer.id, generation: 1, packetSha256: packetId });
  producer.status = 'approved';
  producer.approvals.push({
    decision: 'approved', generation: 1, reviewPacketSha256: packetId, evidenceCommit,
    bundleSha256: producer.artifactSet.bundleSha256,
    artifactSha256: packet.artifacts.map(({ path: artifactPath, sha256 }) => ({
      path: artifactPath, sha256
    }))
  });
  const approvedText = `${artifactMetadataBlock(storyArtifactMetadata(workflow, producer))}${body}`;
  await writeFile(primaryAbsolute, approvedText);
  const approvedPrimary = await snapshot(primaryAbsolute);
  assert.notEqual(submittedPrimary.sha256, approvedPrimary.sha256);
  Object.assign(producer.artifacts[0], { ...approvedPrimary, status: 'approved' });
  producer.artifacts[1].status = 'approved';

  const selected = consume === 'primary'
    ? { id: 'primary', path: primary, repositoryPath: primaryPath,
        submitted: submittedPrimary, approved: approvedPrimary }
    : { id: 'checklist', path: secondary, repositoryPath: secondaryPath,
        submitted: submittedSecondary, approved: submittedSecondary };
  const input = {
    phase: producer.id, path: selected.path, optional: false, status: 'captured',
    sha256: selected.approved.sha256, approvedSha256: selected.approved.sha256,
    bytes: selected.approved.size, producerGeneration: 1,
    skp: { output: selected.id, state: 'approved', receipt: {
      generation: 1, packetSha256: packetId, evidenceCommit,
      submittedSha256: selected.submitted.sha256,
      approvedSha256: selected.approved.sha256,
      submittedBundleSha256: null, bundleSha256: producer.artifactSet.bundleSha256,
      acceptance: 'human-approved'
    } }
  };
  const recordPath = `${item}/context/inputs-review-gen1.json`;
  const recordAbsolute = path.join(root, recordPath);
  await mkdir(path.dirname(recordAbsolute), { recursive: true });
  const record = {
    schemaVersion: 2, workId, phase: consumer.id, generation: 1,
    mode: 'enforce', renderedSha256: 'c'.repeat(64), inputs: [input]
  };
  await writeFile(recordAbsolute, `${JSON.stringify(record, null, 2)}\n`);
  consumer.inputContext = {
    path: recordPath, generation: 1, mode: 'enforce',
    renderedSha256: record.renderedSha256, sha256: (await snapshot(recordAbsolute)).sha256
  };
  const binding = { bindingRefs: { inputs: [{ phase: producer.id, output: selected.id,
    path: selected.path, required: true, state: 'approved' }] } };
  const inspect = () => inspectSkillInputSet(root, definition, workflow, consumer, binding, {
    readPacket: async () => packet
  });
  const verifySet = () => verifyTemplateProducerSetContinuity(root, definition, workflow,
    producer, { approvedPath: selected.repositoryPath,
      approvedSha256: selected.approved.sha256, approvedBytes: selected.approved.size, packet });
  return { root, workflow, producer, consumer, packet, selected, primaryAbsolute,
    secondaryAbsolute, approvedText, set, item, inspect, verifySet };
}

test('skill input accepts template bundle whose primary changed only by approval metadata', async (t) => {
  const value = await fixture(t);
  const observed = await catalogArtifactSet(value.root, value.item, value.producer, value.set);
  assert.notEqual(observed.bundleSha256, value.producer.artifactSet.bundleSha256);
  assert.match((await value.inspect()).inputSetSha256, /^sha256:[a-f0-9]{64}$/);
});

test('skill may consume another template bundle member while primary metadata advances', async (t) => {
  const value = await fixture(t, { consume: 'checklist' });
  assert.match((await value.inspect()).inputSetSha256, /^sha256:[a-f0-9]{64}$/);
});

test('template bundle continuity refuses a changed non-primary member', async (t) => {
  const value = await fixture(t);
  await writeFile(value.secondaryAbsolute, '# Checklist\n\nChanged after approval.\n');
  await assert.rejects(value.inspect(), { code: 'SKP_INPUT_RECEIPT_STALE' });
});

test('template bundle continuity refuses a same-byte symlinked member', async (t) => {
  const value = await fixture(t);
  const alternative = path.join(value.root, 'same-byte-checklist.md');
  await writeFile(alternative, await readFile(value.secondaryAbsolute));
  await unlink(value.secondaryAbsolute);
  try {
    await symlink(alternative, value.secondaryAbsolute);
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`Windows host cannot create the symlink fixture (${error.code}).`);
      return;
    }
    throw error;
  }
  await assert.rejects(value.inspect(), { code: 'REPOSITORY_PATH_UNSAFE' });
});

test('template bundle continuity refuses non-canonical primary metadata', async (t) => {
  const value = await fixture(t);
  const tampered = value.approvedText.replace('"status": "approved"', '"status": "in_progress"');
  await writeFile(value.primaryAbsolute, tampered);
  const current = await snapshot(value.primaryAbsolute);
  value.producer.artifacts[0].sha256 = current.sha256;
  value.producer.artifacts[0].size = current.size;
  await assert.rejects(verifyTemplateProducerSetContinuity(
    value.root, { workItemRoot: 'singularity/work-items' }, value.workflow,
    value.producer, {
      approvedPath: value.selected.repositoryPath,
      approvedSha256: current.sha256, approvedBytes: current.size,
      packet: value.packet
    }
  ), { code: 'SKP_INPUT_RECEIPT_STALE' });
  assert.notEqual((await readFile(value.primaryAbsolute, 'utf8')), value.approvedText);
});
