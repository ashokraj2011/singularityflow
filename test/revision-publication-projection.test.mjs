import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';
import { sgosRevisionCandidateReference } from '../src/revision/candidate-adapter.mjs';
import { verifyRevisionCandidateApplicationTree } from '../src/revision/publication-projection.mjs';

test('Story publication accepts only the exact selected Candidate application blobs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-publish-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await writeFile(path.join(root, 'app.txt'), 'before\n');
  git('add', 'app.txt');
  git('commit', '-m', 'baseline');

  await writeFile(path.join(root, 'app.txt'), 'selected candidate\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'PAY-142:implementation',
    createdBy: { kind: 'human', id: 'revision@example.com' }
  });
  const candidateReference = await sgosRevisionCandidateReference(root, retained.candidate.candidateId);
  await mkdir(path.join(root, 'singularity', 'work-items', 'PAY-142'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'work-items', 'PAY-142', 'workflow.json'), '{}\n');
  git('add', 'app.txt', 'singularity/work-items/PAY-142/workflow.json');
  const prospectiveTree = git('write-tree');
  const input = {
    candidateReference, prospectiveTree, config: {},
    workflow: { workItem: { id: 'PAY-142' }, currentPhase: 'implementation' }
  };
  const result = await verifyRevisionCandidateApplicationTree(root, input);
  assert.equal(result.candidateTree, candidateReference.repository.candidateTree);
  assert.match(result.projectionSha256, /^sha256:[a-f0-9]{64}$/);

  await writeFile(path.join(root, 'app.txt'), 'different application bytes\n');
  git('add', 'app.txt');
  await assert.rejects(verifyRevisionCandidateApplicationTree(root, {
    ...input, prospectiveTree: git('write-tree')
  }), { code: 'REV_PUBLICATION_CANDIDATE_MISMATCH' });
  await assert.rejects(verifyRevisionCandidateApplicationTree(root, {
    ...input, candidateReference: { ...candidateReference, candidateSha256: `sha256:${'0'.repeat(64)}` }
  }), { code: 'REV_PUBLICATION_CANDIDATE_STALE' });
  git('commit', '-m', 'advance branch');
  await assert.rejects(verifyRevisionCandidateApplicationTree(root, input), {
    code: 'REV_PUBLICATION_BASELINE_CHANGED'
  });
});
