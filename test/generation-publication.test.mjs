import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishedGenerationCommit } from '../src/generation-publication-store.mjs';
import { lifecycleEvent, recordPublicationProjection } from '../src/lifecycle-event.mjs';
import { recordSha256 } from '../src/records.mjs';
import { generationResultDigest } from '../src/state.mjs';
import { run } from '../src/util.mjs';

function git(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function committedGenerationPublicationV1({ tampered = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-generation-publication-v1-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Generation Publication']);
  git(root, ['config', 'user.email', 'generation@example.invalid']);
  await writeFile(path.join(root, 'README.md'), '# Generation publication v1\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  const parent = git(root, ['rev-parse', 'HEAD']);
  const parentTree = git(root, ['rev-parse', 'HEAD^{tree}']);

  const workId = tampered ? 'V1-TAMPERED' : 'V1-VALID';
  const phaseId = 'intake';
  const generation = 1;
  const workDirectory = `singularity/work-items/${workId}`;
  const artifactPath = `${workDirectory}/artifacts/intake/intake.md`;
  const workflowPath = `${workDirectory}/workflow.json`;
  const recordPath = `${workDirectory}/context/generation-publications/intake-gen1.json`;
  await mkdir(path.join(root, path.dirname(artifactPath)), { recursive: true });
  await mkdir(path.join(root, path.dirname(recordPath)), { recursive: true });
  await writeFile(path.join(root, artifactPath), '# Intake\n\nPublished by a v1 runtime.\n');

  const transactionId = `generation-publication-${workId.toLowerCase()}`;
  const publishedAt = '2026-01-02T03:04:05.000Z';
  const resultDigest = `sha256:${'a'.repeat(64)}`;
  const event = lifecycleEvent({
    type: 'artifact-generated',
    subject: { kind: 'story', id: workId, branch: workId },
    phaseId,
    generation,
    actor: { name: 'Generation Publication', email: 'generation@example.invalid', login: null }
  });
  const eventSha256 = `sha256:${recordSha256(event)}`;
  const core = {
    schemaVersion: 1,
    kind: 'generation-publication',
    workId,
    phase: phaseId,
    generation,
    generationIntentId: null,
    generationStart: null,
    changeSet: { path: null, digest: null },
    resultDigest,
    baseline: { commit: parent, tree: parentTree },
    transactionId,
    eventId: event.eventId,
    eventSha256,
    commitBinding: {
      method: 'containing-governed-transaction', commit: '$self', tree: '$self', parent
    },
    publishedAt
  };
  const authenticRecordSha256 = `sha256:${recordSha256(core)}`;
  // The tampered fixture changes a field that has no independent semantic comparison below. Its
  // only possible rejection is therefore the historical v1 self-hash check.
  const record = {
    ...core,
    ...(tampered ? { publishedAt: '2026-01-02T03:04:06.000Z' } : {}),
    recordSha256: authenticRecordSha256
  };
  const phase = {
    id: phaseId,
    generation,
    status: 'in_progress',
    artifacts: [{ path: artifactPath }],
    requiredArtifact: { path: 'artifacts/intake/intake.md', kind: 'intake' },
    generationPublications: [{
      generation,
      resultDigestVersion: 2,
      resultDigest,
      changeSetDigest: null,
      publishedAt,
      record: { path: recordPath, sha256: authenticRecordSha256 }
    }]
  };
  const workflow = {
    schemaVersion: 5,
    workflowSnapshot: null,
    workItem: { id: workId, title: workId, branch: workId, workType: 'feature' },
    status: 'active',
    currentPhase: phaseId,
    phaseOrder: [phaseId],
    phases: { [phaseId]: phase },
    lineage: { canonicalBranch: workId, childBranches: [], requiredChecks: [] },
    history: [],
    publicationProjections: []
  };
  recordPublicationProjection(workflow, event);
  const recordBytes = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(path.join(root, recordPath), recordBytes);
  await writeFile(path.join(root, workflowPath), `${JSON.stringify(workflow, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, [
    'commit', '-m', `[${workId}][phase:${phaseId}][generated:${generation}] publish artifacts`,
    '-m', `Singularity-Flow-Transaction: ${transactionId}\nSingularity-Flow-Event-SHA256: ${eventSha256}`
  ]);
  return {
    root, workflow, phase, recordPath, recordBytes,
    commit: git(root, ['rev-parse', 'HEAD'])
  };
}

test('legacy subject text only enumerates candidates and exposes one verified candidate for explicit migration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-generation-publication-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Generation Publication']);
  git(root, ['config', 'user.email', 'generation@example.invalid']);
  await writeFile(path.join(root, 'README.md'), '# Generation publication\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);

  const workId = 'LEGACY-1';
  const workDirectory = `singularity/work-items/${workId}`;
  const artifactPath = `${workDirectory}/artifacts/intake/intake.md`;
  const workflowPath = `${workDirectory}/workflow.json`;
  await mkdir(path.join(root, path.dirname(artifactPath)), { recursive: true });
  await writeFile(path.join(root, artifactPath), '# Intake\n\nAuthenticated legacy evidence.\n');
  const phase = {
    id: 'intake', generation: 1, status: 'in_progress',
    artifacts: [{ path: artifactPath }],
    requiredArtifact: { path: 'artifacts/intake/intake.md', kind: 'intake' }
  };
  const workflow = {
    schemaVersion: 2,
    workItem: { id: workId, title: workId, branch: workId, workType: 'feature' },
    status: 'active', currentPhase: 'intake', phaseOrder: ['intake'], phases: { intake: phase },
    lineage: { canonicalBranch: workId, childBranches: [], requiredChecks: [] },
    history: [], publicationProjections: []
  };
  const event = lifecycleEvent({
    type: 'artifact-generated', subject: { kind: 'story', id: workId, branch: workId },
    phaseId: 'intake', generation: 1,
    actor: { name: 'Generation Publication', email: 'generation@example.invalid', login: null }
  });
  recordPublicationProjection(workflow, event);
  await writeFile(path.join(root, workflowPath), `${JSON.stringify(workflow, null, 2)}\n`);
  const transactionId = 'legacy-transaction-evidence';
  const eventSha256 = `sha256:${recordSha256(event)}`;
  git(root, ['add', '.']);
  git(root, [
    'commit', '-m', `[${workId}][phase:intake][generated:1] publish artifacts`,
    '-m', `Singularity-Flow-Transaction: ${transactionId}\nSingularity-Flow-Event-SHA256: ${eventSha256}`
  ]);
  const governed = git(root, ['rev-parse', 'HEAD']);

  await writeFile(path.join(root, 'decoy.txt'), 'presentation text is not authority\n');
  git(root, ['add', 'decoy.txt']);
  git(root, ['commit', '-m', `[${workId}][phase:intake][generated:1] decoy`]);

  assert.throws(() => publishedGenerationCommit(root, workflow, phase), (error) => {
    assert.equal(error.code, 'GENERATION_PUBLICATION_MIGRATION_REQUIRED');
    assert.equal(error.details.verifiedCandidate.commit, governed);
    assert.equal(error.details.verifiedCandidate.transactionId, transactionId);
    assert.equal(error.details.candidates.length, 2);
    return true;
  });
});

test('a genuine committed generation-publication v1 verifies before its v2 projection', async () => {
  const fixture = await committedGenerationPublicationV1();
  const before = git(fixture.root, ['show', `${fixture.commit}:${fixture.recordPath}`]);
  assert.equal(`${before}\n`, fixture.recordBytes);

  assert.equal(
    publishedGenerationCommit(fixture.root, fixture.workflow, fixture.phase),
    fixture.commit
  );

  const after = git(fixture.root, ['show', `${fixture.commit}:${fixture.recordPath}`]);
  assert.equal(after, before, 'the compatibility projection must not rewrite accepted v1 bytes');
});

test('a tampered committed generation-publication v1 remains invalid', async () => {
  const fixture = await committedGenerationPublicationV1({ tampered: true });
  assert.throws(
    () => publishedGenerationCommit(fixture.root, fixture.workflow, fixture.phase),
    (error) => {
      assert.equal(error.code, 'GENERATION_PUBLICATION_INVALID');
      assert.match(error.details.candidates[0].reason, /publication record hash differs/);
      return true;
    }
  );
});

test('result digest v3 binds architecture evidence without changing historical v2 semantics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-generation-result-v3-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Generation Publication']);
  git(root, ['config', 'user.email', 'generation@example.invalid']);
  await writeFile(path.join(root, 'README.md'), '# Result digest compatibility\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);

  const workId = 'DIGEST-3';
  const artifactPath = `singularity/work-items/${workId}/artifacts/intake/intake.md`;
  await mkdir(path.join(root, path.dirname(artifactPath)), { recursive: true });
  await writeFile(path.join(root, artifactPath), '# Intake\n\nExact authored bytes.\n');
  const phase = {
    id: 'intake', generation: 1,
    artifacts: [{ path: artifactPath }],
    requiredArtifact: { path: 'artifacts/intake/intake.md', kind: 'intake' },
    generationIntent: {
      id: 'intent-1', receiptSha256: 'sha256:start', baseline: null,
      publication: { resultDigestVersion: 2 }
    },
    generationPublications: [{
      generation: 1, resultDigestVersion: 2,
      architectureIntent: { intentSha256: 'sha256:historical' },
      architectureDecision: { intentSha256: 'sha256:historical' }
    }]
  };
  const workflow = { workItem: { id: workId }, phases: { intake: phase } };
  const config = { workItemRoot: 'singularity/work-items' };
  const left = {
    intentSha256: `sha256:${'a'.repeat(64)}`,
    path: `singularity/work-items/${workId}/context/architecture/architecture-intent.json`
  };
  const right = { ...left, intentSha256: `sha256:${'b'.repeat(64)}` };

  const historical = await generationResultDigest(root, config, workflow, phase);
  const historicalWithDifferentNewFields = await generationResultDigest(root, config, workflow, phase, {
    resultDigestVersion: 2,
    architectureIntent: right,
    architectureDecision: right
  });
  assert.equal(historicalWithDifferentNewFields, historical,
    'v2 receipts must not be reinterpreted using fields introduced by v3');

  const v3Left = await generationResultDigest(root, config, workflow, phase, {
    resultDigestVersion: 3,
    architectureIntent: left,
    architectureDecision: left
  });
  const v3Right = await generationResultDigest(root, config, workflow, phase, {
    resultDigestVersion: 3,
    architectureIntent: right,
    architectureDecision: right
  });
  assert.notEqual(v3Left, v3Right, 'v3 must bind the exact intent and decision identities');
});
