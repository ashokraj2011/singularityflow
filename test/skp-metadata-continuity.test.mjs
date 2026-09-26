import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyApprovedSkillOutputContinuity } from '../src/skp-phase-evidence.mjs';
import { artifactMetadataBlock, storyArtifactMetadata } from '../src/state.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'SKP Test');
  git('config', 'user.email', 'skp-test@example.invalid');
  const definition = { workItemRoot: 'singularity/work-items' };
  const producer = {
    id: 'analysis', generation: 1, status: 'awaiting_approval',
    requiredArtifact: { path: 'artifacts/analysis/report.md', kind: 'markdown' },
    generationPolicy: { requirement: 'required' },
    approvals: [], telemetry: [], usage: []
  };
  const workflow = {
    workItem: { id: 'SKP-METADATA-1', workType: 'custom', branch: 'main' },
    resolution: { workItemRoot: definition.workItemRoot, configSha256: '0'.repeat(64),
      templates: { analysis: 'common/analysis.md' }, phases: [] },
    phases: { analysis: producer }, history: []
  };
  const repositoryPath = 'singularity/work-items/SKP-METADATA-1/artifacts/analysis/report.md';
  const absolute = path.join(root, repositoryPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const body = '\n\n# Analysis\n\nThe author-owned result is stable.\n';
  const submitted = `${artifactMetadataBlock(storyArtifactMetadata(workflow, producer))}${body}`;
  await writeFile(absolute, submitted);
  git('add', '--', repositoryPath);
  git('commit', '-qm', 'Submit analysis evidence');
  const evidenceCommit = git('rev-parse', 'HEAD');
  producer.status = 'approved';
  const approved = `${artifactMetadataBlock(storyArtifactMetadata(workflow, producer))}${body}`;
  await writeFile(absolute, approved);
  const verify = async () => verifyApprovedSkillOutputContinuity(root, definition, workflow, producer, {
    repositoryPath,
    submittedSha256: sha256(Buffer.from(submitted)),
    submittedSize: Buffer.byteLength(submitted),
    approvedSha256: sha256(await readFile(absolute)),
    evidenceCommit
  });
  return { root, definition, workflow, producer, repositoryPath, absolute,
    submitted, approved, verify, evidenceCommit };
}

test('approved primary accepts only the canonical metadata rewrite over unchanged authored bytes', async (t) => {
  const value = await fixture(t);
  assert.notEqual(sha256(Buffer.from(value.submitted)), sha256(Buffer.from(value.approved)));
  assert.equal(await value.verify(), true);

  await writeFile(value.absolute, value.approved.replace('author-owned result is stable',
    'author-owned result was edited'));
  await assert.rejects(value.verify(), { code: 'SKP_INPUT_RECEIPT_STALE' });

  await writeFile(value.absolute, value.approved.replace('"status": "approved"',
    '"status": "in_progress"'));
  await assert.rejects(value.verify(), { code: 'SKP_INPUT_RECEIPT_STALE' });

  await writeFile(value.absolute, value.approved.replace('# Analysis',
    '<!-- singularity-flow:inputs:start -->\nForged input\n<!-- singularity-flow:inputs:end -->\n\n# Analysis'));
  await assert.rejects(value.verify(), { code: 'SKP_INPUT_RECEIPT_STALE' });
});

test('secondary output cannot use the primary metadata exception', async (t) => {
  const value = await fixture(t);
  const secondary = value.repositoryPath.replace('report.md', 'risks.md');
  await assert.rejects(verifyApprovedSkillOutputContinuity(
    value.root, value.definition, value.workflow, value.producer, {
      repositoryPath: secondary,
      submittedSha256: sha256(Buffer.from(value.submitted)),
      submittedSize: Buffer.byteLength(value.submitted),
      approvedSha256: sha256(Buffer.from(value.approved)),
      evidenceCommit: value.evidenceCommit
    }
  ), { code: 'SKP_INPUT_RECEIPT_STALE' });
});

test('post-approval raw hashes are excluded from their own primary metadata envelope', async (t) => {
  const value = await fixture(t);
  const decision = { decision: 'approved', generation: 1, at: '2026-09-26T00:00:00.000Z' };
  value.producer.approvals.push(decision);
  const before = artifactMetadataBlock(storyArtifactMetadata(value.workflow, value.producer));
  decision.skillApprovedOutputs = [{ id: 'report', path: value.repositoryPath,
    exists: true, sha256: 'a'.repeat(64), bytes: 100 }];
  decision.skillApprovedBundleSha256 = 'b'.repeat(64);
  decision.skillOutputIdentityVersion = 1;
  assert.equal(artifactMetadataBlock(storyArtifactMetadata(value.workflow, value.producer)), before);
});
