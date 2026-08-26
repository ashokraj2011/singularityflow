import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishedGenerationCommit } from '../src/generation-publication-store.mjs';
import { lifecycleEvent, recordPublicationProjection } from '../src/lifecycle-event.mjs';
import { recordSha256 } from '../src/records.mjs';
import { run } from '../src/util.mjs';

function git(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
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
