import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishedGenerationCommit } from '../src/generation-publication-store.mjs';
import { phaseArtifactCatalog, viewPhaseArtifact } from '../src/phase-artifact-browser.mjs';
import { exactFileAtObject } from '../src/git.mjs';
import { beginCodeGeneration, verifyOpenGenerationIntent } from '../src/generation-boundary.mjs';
import { lifecycleEvent, recordPublicationProjection } from '../src/lifecycle-event.mjs';
import { recordSha256 } from '../src/records.mjs';
import { generationResultDigest } from '../src/state.mjs';
import { run } from '../src/util.mjs';
import { readPublishedWitnessEvidence, recordPublishedWitness, WITNESS_CHECKLIST } from '../src/verification/witness-records.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';

function git(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function committedGenerationPublicationV1({ tampered = false, phaseId = 'intake', retainedEvidence = false, missingImage = false } = {}) {
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
  const generation = 1;
  const workDirectory = `singularity/work-items/${workId}`;
  const artifactPath = `${workDirectory}/artifacts/${phaseId}/intake.md`;
  const workflowPath = `${workDirectory}/workflow.json`;
  const recordPath = `${workDirectory}/context/generation-publications/${phaseId}-gen1.json`;
  await mkdir(path.join(root, path.dirname(artifactPath)), { recursive: true });
  await mkdir(path.join(root, path.dirname(recordPath)), { recursive: true });
  await writeFile(path.join(root, artifactPath), '# Intake\n\nPublished by a v1 runtime.\n');
  const evidencePath = `${workDirectory}/evidence/screen Ω.png`;
  const image = Buffer.from('fixture image bytes');
  const evidenceSha256 = createHash('sha256').update(image).digest('hex');
  if (retainedEvidence && !missingImage) {
    await mkdir(path.dirname(path.join(root, evidencePath)), { recursive: true });
    await writeFile(path.join(root, evidencePath), image);
  }

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
    requiredArtifact: { path: `artifacts/${phaseId}/intake.md`, kind: 'intake' },
    ...(retainedEvidence ? { generationCommit: null, deliveryEvidence: { fulfillment: [
      { clauseId: `${workId}:AC-001`, fulfillment: 'evidence', paths: [{ path: evidencePath, state: 'present', sha256: evidenceSha256 }] }
    ] } } : {}),
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
    root, workflow, phase, recordPath, recordBytes, evidencePath, evidenceSha256, image,
    commit: git(root, ['rev-parse', 'HEAD'])
  };
}

function witnessInput(f, sha256 = `sha256:${f.evidenceSha256}`) {
  return { clauseId: `${f.workflow.workItem.id}:AC-001`, slot: { slot: 'screen', method: 'visual', witness: { target: 'Value display' } },
    file: f.evidencePath, sha256, plannedClaim: { fulfillment: 'evidence', expectedPaths: [f.evidencePath] },
    answers: Object.fromEntries(WITNESS_CHECKLIST.map(item => [item, 'yes'])), reason: 'The fixture reviewer inspected these exact retained bytes.',
    actor: 'reviewer@example.test', authorityGroup: 'engineering-reviewers', at: '2026-11-04T00:00:00Z' };
}

test('witness publication binding works before submission for current and custom phase names', async t => {
  for (const phaseId of ['implementation', 'verification', 'release', 'team-owned-phase']) await t.test(phaseId, async t => {
    const f = await committedGenerationPublicationV1({ phaseId, retainedEvidence: true });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const input = witnessInput(f);
    const workflowPath = path.join(f.root, `singularity/work-items/${f.workflow.workItem.id}/workflow.json`);
    const bytes = await readFile(workflowPath);
    const rows = await readPublishedWitnessEvidence(f.root, f.workflow, input);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].generationCommit, f.commit);
    assert.equal(rows[0].sha256, `sha256:${f.evidenceSha256}`);
    const record = await recordPublishedWitness(f.root, f.workflow, input);
    assert.equal(record.outcome, 'met');
    assert.equal(f.phase.generationCommit, null, 'publication lookup cannot set the later submission marker');
    assert.equal(f.phase.status, 'in_progress');
    assert.deepEqual(await readFile(workflowPath), bytes);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.commit, 'read binding writes no commit');
  });
});

test('mutable fulfillment cannot substitute different bytes for the authenticated published image', async t => {
  const f = await committedGenerationPublicationV1({ retainedEvidence: true });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const replacement = Buffer.from('a different image');
  const forged = createHash('sha256').update(replacement).digest('hex');
  f.phase.deliveryEvidence.fulfillment[0].paths[0].sha256 = forged;
  await writeFile(path.join(f.root, f.evidencePath), replacement);
  const input = witnessInput(f, `sha256:${forged}`);
  const rows = await readPublishedWitnessEvidence(f.root, f.workflow, input);
  assert.equal(rows[0].sha256, `sha256:${f.evidenceSha256}`);
  await assert.rejects(recordPublishedWitness(f.root, f.workflow, input), error => error.code === 'WITNESS_EVIDENCE_UNPUBLISHED'
    && error.details.retainedEvidence[0].publishedSha256 === `sha256:${f.evidenceSha256}`);
  assert.equal(f.workflow.witnessRecords, undefined);
});

test('missing image blobs and corrupt publication records remain explicit refusals', async t => {
  for (const options of [{ missingImage: true }, { tampered: true }]) {
    const f = await committedGenerationPublicationV1({ ...options, retainedEvidence: true });
    t.after(() => rm(f.root, { recursive: true, force: true }));
    await assert.rejects(recordPublishedWitness(f.root, f.workflow, witnessInput(f)), error => {
      assert.equal(error.code, options.tampered ? 'GENERATION_PUBLICATION_INVALID' : 'WITNESS_PUBLICATION_INVALID');
      if (options.missingImage) {
        assert.match(error.details.routes[0].command, /singularity-flow recover/);
        const recovery = refusalRemediationPlan(error, ['decision', 'witness', '--work-id', f.workflow.workItem.id]);
        assert.ok(recovery.steps.some(step => step.command?.startsWith(`singularity-flow recover ${f.workflow.workItem.id}`)));
      }
      return true;
    });
    assert.equal(f.workflow.witnessRecords, undefined);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.commit);
  }
});

test('a restored Code generation starts above the abandoned watermark while retaining its authenticated baseline', async (t) => {
  const { root, workflow, phase, commit } = await committedGenerationPublicationV1();
  t.after(() => rm(root, { recursive: true, force: true }));
  phase.generationPolicy = { task: 'code' };
  phase.sourceBoundary = 'unrestricted';
  phase.generationHighWatermark = 2;
  workflow.workIntervals = { current: { phaseId: phase.id, status: 'open', sourceBaseCommit: commit } };
  workflow.resolution = { codeDelivery: { generationBoundary: { dirtyStart: 'block' } } };
  const intent = await beginCodeGeneration(root, { workItemRoot: 'singularity/work-items' }, workflow, phase);
  assert.equal(intent.generation, 3);
  assert.equal(intent.baseline.commit, commit);
  assert.equal((await verifyOpenGenerationIntent(root, workflow, phase)).id, intent.id);
  assert.equal(phase.generation, 1, 'begin never relabels the restored immutable generation');
});

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

test('approved artifact previews retain exact published bytes despite edited or missing working drafts', async t => {
  const { root, workflow, phase, commit } = await committedGenerationPublicationV1();
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { workItemRoot: 'singularity/work-items' };
  phase.status = 'approved';
  const entry = phaseArtifactCatalog(config, workflow).phases[0].artifacts[0];
  const file = path.join(root, entry.path);
  await writeFile(file, '# This is an unapproved edit\n');
  const before = git(root, ['status', '--porcelain']);
  const approved = await viewPhaseArtifact(root, config, workflow, entry.id, 'approved');
  assert.equal(approved.commit, commit);
  assert.equal(approved.content, '# Intake\n\nPublished by a v1 runtime.\n');
  assert.equal(git(root, ['status', '--porcelain']), before, 'viewing does not mutate the working tree');
  assert.match((await viewPhaseArtifact(root, config, workflow, entry.id)).content, /unapproved edit/);
  await rm(file);
  assert.equal((await viewPhaseArtifact(root, config, workflow, entry.id, 'approved')).content, approved.content);
  phase.status = 'stale';
  await assert.rejects(viewPhaseArtifact(root, config, workflow, entry.id, 'approved'), { code: 'PHASE_ARTIFACT_NOT_APPROVED' });
});

test('exact regular-file reads reject committed symlinks rather than treating their target as document content', async t => {
  const { root } = await committedGenerationPublicationV1();
  t.after(() => rm(root, { recursive: true, force: true }));
  // index mode models a symlink even on hosts without native symlink creation permission.
  const oid = git(root, ['hash-object', 'README.md']);
  git(root, ['update-index', '--add', '--cacheinfo', `120000,${oid},alias.md`]);
  git(root, ['commit', '-qm', 'symlink fixture']);
  const commit = git(root, ['rev-parse', 'HEAD']);
  assert.equal(exactFileAtObject(root, commit, 'alias.md', { regularOnly: true }), null);
  assert.ok(exactFileAtObject(root, commit, 'README.md', { regularOnly: true }));
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
