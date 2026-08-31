import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/records.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { readStoryReviewPacket, reviewArtifactSetSha256 } from '../src/story-lineage.mjs';
import { run } from '../src/util.mjs';

function git(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('review replays v1 packet and test identities from the immutable submission commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-evidence-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Review Test']);
  git(root, ['config', 'user.email', 'review@example.invalid']);
  const evidenceRoot = 'singularity/work-items/REV-1/context/code-delivery';
  const codePath = `${evidenceRoot}/implementation-gen1.json`;
  const testPath = `${evidenceRoot}/tests/implementation-gen1-unit.json`;
  const artifactPath = 'singularity/work-items/REV-1/artifacts/implementation/implementation-summary.md';
  const artifactBytes = Buffer.from('# Immutable implementation evidence\n');
  const codeReceipt = { schemaVersion: currentSchemaVersion('code-delivery'), kind: 'code-delivery', status: 'ready' };
  const testReceipt = {
    schemaVersion: 1, kind: 'test-execution', status: 'passed',
    assurance: 'module-executed', testcaseExecutionProven: false
  };
  const digest = (record) => createHash('sha256').update(canonicalJson(record)).digest('hex');
  const base = {
    schemaVersion: 1,
    workId: 'REV-1', phase: 'implementation', generation: 1,
    artifacts: [{
      path: artifactPath,
      kind: 'implementation-summary',
      sha256: createHash('sha256').update(artifactBytes).digest('hex'),
      size: artifactBytes.length
    }],
    checks: [{ id: 'unit', status: 'passed' }],
    submissionEvidence: {
      codeDelivery: { path: codePath, sha256: digest(codeReceipt), status: 'ready' },
      testExecutions: [{ commandId: 'unit', path: testPath, sha256: digest(testReceipt), status: 'passed' }],
      checksSha256: createHash('sha256').update(JSON.stringify([{ id: 'unit', status: 'passed' }])).digest('hex'),
      artifactSetSha256: null
    }
  };
  base.submissionEvidence.artifactSetSha256 = reviewArtifactSetSha256(base.artifacts);
  const packetSha256 = createHash('sha256').update(JSON.stringify(base)).digest('hex');
  const packetPath = `singularity/work-items/REV-1/submissions/implementation/${packetSha256}.json`;
  for (const [relative, record] of [[codePath, codeReceipt], [testPath, testReceipt], [packetPath, { ...base, packetSha256 }]]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `${JSON.stringify(record, null, 2)}\n`);
  }
  await mkdir(path.dirname(path.join(root, artifactPath)), { recursive: true });
  await writeFile(path.join(root, artifactPath), artifactBytes);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'submission evidence']);
  const evidenceCommit = git(root, ['rev-parse', 'HEAD']);
  await writeFile(path.join(root, codePath), `${JSON.stringify({ ...codeReceipt, status: 'failed' }, null, 2)}\n`);
  await writeFile(path.join(root, testPath), `${JSON.stringify({ ...testReceipt, status: 'failed' }, null, 2)}\n`);
  await writeFile(path.join(root, packetPath), `${JSON.stringify({
    ...base,
    submissionEvidence: {
      ...base.submissionEvidence,
      codeDelivery: { ...base.submissionEvidence.codeDelivery, sha256: digest({ ...codeReceipt, status: 'failed' }) }
    },
    packetSha256
  }, null, 2)}\n`);
  const workflow = { workItem: { id: 'REV-1' }, lineage: { submissions: [{ packetSha256, path: packetPath }] } };
  const packet = await readStoryReviewPacket(root, {}, workflow, packetSha256);
  assert.equal(packet.evidenceCommit, evidenceCommit);
  assert.equal(packet.schemaVersion, currentSchemaVersion('story-submission-packet'));
  assert.equal(packet.witnessReview.enrollmentClassification, 'legacy');
  assert.equal(packet.submissionEvidence.testExecutions[0].status, 'passed');
});

test('review replays an exact canonical claim map from the immutable submission commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-claims-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Review Test']);
  git(root, ['config', 'user.email', 'review@example.invalid']);
  const claimPath = 'singularity/work-items/REV-2/context/claims/implementation-gen1-observed.json';
  const claimMap = {
    schemaVersion: currentSchemaVersion('specification-claim-map'),
    kind: 'observed', workId: 'REV-2', phase: 'implementation', generation: 1,
    recordedAt: '2026-08-31T00:00:00.000Z', claims: {}
  };
  const claimSha256 = createHash('sha256').update(canonicalJson(claimMap)).digest('hex');
  const base = {
    schemaVersion: currentSchemaVersion('story-submission-packet'),
    workId: 'REV-2', phase: 'implementation', generation: 1,
    artifacts: [], checks: [],
    submissionEvidence: {
      testExecutions: [],
      claimMaps: [{ kind: 'observed', generation: 1, path: claimPath, sha256: claimSha256 }],
      checksSha256: createHash('sha256').update(JSON.stringify([])).digest('hex'),
      artifactSetSha256: reviewArtifactSetSha256([])
    }
  };
  const packetSha256 = createHash('sha256').update(JSON.stringify(base)).digest('hex');
  const packetPath = `singularity/work-items/REV-2/submissions/implementation/${packetSha256}.json`;
  for (const [relative, record] of [[claimPath, claimMap], [packetPath, { ...base, packetSha256 }]]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `${JSON.stringify(record, null, 2)}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'claim-bound review evidence']);
  const evidenceCommit = git(root, ['rev-parse', 'HEAD']);

  // A later working-tree projection cannot replace the bytes the reviewer was asked to judge.
  await writeFile(path.join(root, claimPath), `${JSON.stringify({ ...claimMap, claims: { 'REV-2:AC-001': {} } }, null, 2)}\n`);
  const workflow = { workItem: { id: 'REV-2' }, lineage: { submissions: [{ packetSha256, path: packetPath }] } };
  const packet = await readStoryReviewPacket(root, {}, workflow, packetSha256);
  assert.equal(packet.evidenceCommit, evidenceCommit);
  assert.deepEqual(packet.submissionEvidence.claimMaps, [
    { kind: 'observed', generation: 1, path: claimPath, sha256: claimSha256 }
  ]);
});

test('review refuses a claim-map binding whose canonical digest is not in the submission commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-claim-mismatch-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Review Test']);
  git(root, ['config', 'user.email', 'review@example.invalid']);
  const claimPath = 'singularity/work-items/REV-3/context/claims/planning-gen1-planned.json';
  const claimMap = {
    schemaVersion: currentSchemaVersion('specification-claim-map'),
    kind: 'planned', workId: 'REV-3', phase: 'planning', generation: 1,
    recordedAt: '2026-08-31T00:00:00.000Z', claims: {}
  };
  const base = {
    schemaVersion: currentSchemaVersion('story-submission-packet'),
    workId: 'REV-3', phase: 'planning', generation: 1,
    artifacts: [], checks: [],
    submissionEvidence: {
      testExecutions: [],
      claimMaps: [{ kind: 'planned', generation: 1, path: claimPath, sha256: '0'.repeat(64) }],
      checksSha256: createHash('sha256').update(JSON.stringify([])).digest('hex'),
      artifactSetSha256: reviewArtifactSetSha256([])
    }
  };
  const packetSha256 = createHash('sha256').update(JSON.stringify(base)).digest('hex');
  const packetPath = `singularity/work-items/REV-3/submissions/planning/${packetSha256}.json`;
  for (const [relative, record] of [[claimPath, claimMap], [packetPath, { ...base, packetSha256 }]]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `${JSON.stringify(record, null, 2)}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'mismatched claim binding']);
  const workflow = { workItem: { id: 'REV-3' }, lineage: { submissions: [{ packetSha256, path: packetPath }] } };
  await assert.rejects(
    () => readStoryReviewPacket(root, {}, workflow, packetSha256),
    (error) => error.code === 'STORY_REVIEW_EVIDENCE_INVALID' && /different .*planning-gen1-planned\.json/.test(error.message)
  );
});

test('review refuses exact claim bytes owned by another Story, phase, or claim directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-claim-owner-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Review Test']);
  git(root, ['config', 'user.email', 'review@example.invalid']);
  const digest = (record) => createHash('sha256').update(canonicalJson(record)).digest('hex');
  const packetFor = (claimPath, claimMap) => {
    const base = {
      schemaVersion: currentSchemaVersion('story-submission-packet'),
      workId: 'REV-4', phase: 'implementation', generation: 1,
      artifacts: [], checks: [],
      submissionEvidence: {
        testExecutions: [],
        claimMaps: [{ kind: claimMap.kind, generation: 1, path: claimPath, sha256: digest(claimMap) }],
        checksSha256: createHash('sha256').update(JSON.stringify([])).digest('hex'),
        artifactSetSha256: reviewArtifactSetSha256([])
      }
    };
    const packetSha256 = createHash('sha256').update(JSON.stringify(base)).digest('hex');
    return {
      base, packetSha256,
      packetPath: `singularity/work-items/REV-4/submissions/implementation/${packetSha256}.json`
    };
  };

  // The path looks owned by REV-4, and the digest is exact, but the record itself belongs to a
  // different Story and phase. Digest possession is not authority to transplant an observation.
  const transplantedPath = 'singularity/work-items/REV-4/context/claims/implementation-gen1-observed.json';
  const transplantedMap = {
    schemaVersion: currentSchemaVersion('specification-claim-map'),
    kind: 'observed', workId: 'OTHER', phase: 'verification', generation: 1,
    recordedAt: '2026-08-31T00:00:00.000Z', claims: {}
  };
  const transplanted = packetFor(transplantedPath, transplantedMap);

  // This record's internal identity matches the packet, but its storage path is another Story's
  // claim namespace. Review must not treat an arbitrary repository JSON blob as REV-4 evidence.
  const foreignPath = 'singularity/work-items/OTHER/context/claims/implementation-gen1-observed.json';
  const foreignMap = {
    schemaVersion: currentSchemaVersion('specification-claim-map'),
    kind: 'observed', workId: 'REV-4', phase: 'implementation', generation: 1,
    recordedAt: '2026-08-31T00:00:00.000Z', claims: {}
  };
  const foreign = packetFor(foreignPath, foreignMap);

  for (const [relative, record] of [
    [transplantedPath, transplantedMap],
    [transplanted.packetPath, { ...transplanted.base, packetSha256: transplanted.packetSha256 }],
    [foreignPath, foreignMap],
    [foreign.packetPath, { ...foreign.base, packetSha256: foreign.packetSha256 }]
  ]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `${JSON.stringify(record, null, 2)}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'adversarial exact claim packets']);

  for (const candidate of [transplanted, foreign]) {
    const workflow = {
      workItem: { id: 'REV-4' },
      lineage: { submissions: [{ packetSha256: candidate.packetSha256, path: candidate.packetPath }] }
    };
    await assert.rejects(
      () => readStoryReviewPacket(root, {}, workflow, candidate.packetSha256),
      (error) => error.code === 'STORY_REVIEW_EVIDENCE_INVALID'
    );
  }
});
