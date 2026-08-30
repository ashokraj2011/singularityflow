import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  freezeSgosCandidate,
  planSgosCandidatePublication,
  publishSgosCandidate,
  readSgosRetainedCandidate,
  verifySgosCandidate
} from '../src/sgos/candidate-lifecycle.mjs';
import { publishSgosCandidateVerifierPolicy } from './helpers/sgos-candidate-authority.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t, {
  commands = [[process.execPath, '-e', 'process.exit(0)']]
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Candidate Test']);
  git(root, ['config', 'user.email', 'candidate@example.com']);
  await writeFile(path.join(root, 'tracked.txt'), 'before\n');
  await writeFile(path.join(root, 'removed.txt'), 'remove me\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  await publishSgosCandidateVerifierPolicy(root, { commands });
  return root;
}

const actor = Object.freeze({ kind: 'human', id: 'candidate@example.com' });

test('candidate freeze rejects a symlinked private sidecar before retaining a Git ref', async (t) => {
  const root = await repository(t);
  const redirected = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-redirect-'));
  t.after(() => rm(redirected, { recursive: true, force: true }));
  try {
    await symlink(redirected, path.join(root, '.git', 'singularity-flow'),
      process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.diagnostic('Windows host does not permit unprivileged links; sidecar ancestor checks remain active.');
      return;
    }
    throw error;
  }
  await writeFile(path.join(root, 'tracked.txt'), 'candidate bytes\n');
  await assert.rejects(
    freezeSgosCandidate(root, {
      subjectId: 'candidate-fixture', createdBy: actor,
      createdAt: '2026-08-30T00:00:00.000Z'
    }),
    (error) => error.code === 'SGOS_SIDECAR_PATH_UNSAFE'
  );
  assert.equal(git(root, ['for-each-ref', '--format=%(refname)',
    'refs/singularity-flow/candidates']), '');
  assert.deepEqual(await readdir(redirected), []);
});

test('candidate freeze retains exact added, changed, and deleted bytes behind a hidden Git ref', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'tracked.txt'), 'after\n');
  await writeFile(path.join(root, 'added.txt'), 'new\n');
  await rm(path.join(root, 'removed.txt'));

  const retained = await freezeSgosCandidate(root, {
    subjectId: 'candidate-fixture', createdBy: actor, createdAt: '2026-08-30T00:00:00.000Z'
  });
  const loaded = await readSgosRetainedCandidate(root, retained.candidate.candidateId);
  assert.equal(loaded.retainedCandidateSha256, retained.retainedCandidateSha256);
  assert.equal(Object.isFrozen(loaded.repository), true);
  assert.equal(Object.isFrozen(loaded.candidate.resources), true);
  assert.deepEqual(loaded.candidate.resources.map((entry) => [entry.path, entry.operation]), [
    ['added.txt', 'added'], ['removed.txt', 'deleted'], ['tracked.txt', 'modified']
  ]);
  assert.equal(git(root, ['rev-parse', loaded.repository.retainedRef]), loaded.repository.candidateCommit);
  assert.equal(git(root, ['rev-parse', `${loaded.repository.candidateCommit}^{tree}`]), loaded.repository.candidateTree);
  assert.notEqual(git(root, ['rev-parse', 'HEAD']), loaded.repository.candidateCommit,
    'freeze must not advance the application branch');
});

test('candidate freeze never replaces an existing immutable retention ref', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'tracked.txt'), 'candidate bytes\n');
  const options = {
    subjectId: 'candidate-fixture', createdBy: actor, createdAt: '2026-08-30T00:00:00.000Z'
  };
  const retained = await freezeSgosCandidate(root, options);
  git(root, ['update-ref', retained.repository.retainedRef, retained.repository.baselineCommit,
    retained.repository.candidateCommit]);
  await assert.rejects(
    freezeSgosCandidate(root, options),
    (error) => error.code === 'SGOS_CANDIDATE_RECORD_CONFLICT'
  );
  assert.equal(git(root, ['rev-parse', retained.repository.retainedRef]),
    retained.repository.baselineCommit,
    'a conflicting freeze must not overwrite the already-present ref');
});

test('candidate verification is isolated and publication advances only the exact confirmed tree', async (t) => {
  const root = await repository(t, { commands: [[process.execPath, '-e', [
    "const fs=require('fs')",
    "const cp=require('child_process')",
    "if(fs.readFileSync('tracked.txt','utf8')!=='published\\n')process.exit(2)",
    "cp.execFileSync('git',['update-ref','refs/heads/main','HEAD'])"
  ].join(';')]] });
  await writeFile(path.join(root, 'tracked.txt'), 'published\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'candidate-fixture', createdBy: actor, createdAt: '2026-08-30T00:00:00.000Z'
  });
  const receipt = await verifySgosCandidate(root, retained.candidate.candidateId, {
    verifiedAt: '2026-08-30T00:01:00.000Z'
  });
  assert.equal(receipt.status, 'passed');
  assert.equal(git(root, ['rev-parse', 'HEAD']), retained.repository.baselineCommit);
  assert.equal(git(root, ['rev-parse', 'refs/heads/main']), retained.repository.baselineCommit,
    'verification commands must have an independent Git ref namespace');

  const plan = await planSgosCandidatePublication(root, retained.candidate.candidateId);
  assert.equal(plan.preconditions.worktreeMatches, true);
  const published = await publishSgosCandidate(root, retained.candidate.candidateId, {
    confirmationSha256: plan.packetSha256,
    publishedAt: '2026-08-30T00:02:00.000Z'
  });
  assert.equal(published.status, 'published');
  assert.equal(git(root, ['rev-parse', 'HEAD']), retained.repository.candidateCommit);
  assert.equal(git(root, ['rev-parse', 'HEAD^{tree}']), retained.repository.candidateTree);
  assert.equal(git(root, ['status', '--porcelain']), '');
  assert.equal(await readFile(path.join(root, 'tracked.txt'), 'utf8'), 'published\n');
});

test('candidate publication refuses worktree drift instead of publishing reviewed stale bytes', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'tracked.txt'), 'candidate\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'candidate-fixture', createdBy: actor, createdAt: '2026-08-30T00:00:00.000Z'
  });
  await verifySgosCandidate(root, retained.candidate.candidateId, {
    verifiedAt: '2026-08-30T00:01:00.000Z'
  });
  const plan = await planSgosCandidatePublication(root, retained.candidate.candidateId);
  await writeFile(path.join(root, 'tracked.txt'), 'drifted\n');
  await assert.rejects(
    publishSgosCandidate(root, retained.candidate.candidateId, {
      confirmationSha256: plan.packetSha256,
      publishedAt: '2026-08-30T00:02:00.000Z'
    }),
    (error) => error.code === 'SGOS_CANDIDATE_PUBLICATION_STALE'
  );
  assert.equal(git(root, ['rev-parse', 'HEAD']), retained.repository.baselineCommit);
});

test('candidate publication recovers an exact local ref advance that happened before its receipt', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'tracked.txt'), 'candidate-after-cas\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'candidate-fixture', createdBy: actor, createdAt: '2026-08-30T00:00:00.000Z'
  });
  await verifySgosCandidate(root, retained.candidate.candidateId, {
    verifiedAt: '2026-08-30T00:01:00.000Z'
  });
  const plan = await planSgosCandidatePublication(root, retained.candidate.candidateId);
  // Reproduce a crash after exact branch CAS but before read-tree aligns the real index.
  git(root, ['update-ref', 'refs/heads/main', retained.repository.candidateCommit,
    retained.repository.baselineCommit]);
  assert.equal(git(root, ['write-tree']),
    git(root, ['rev-parse', `${retained.repository.baselineCommit}^{tree}`]));
  assert.notEqual(git(root, ['status', '--porcelain']), '',
    'the interrupted branch CAS must expose the unaligned index before recovery');
  const recovered = await publishSgosCandidate(root, retained.candidate.candidateId, {
    confirmationSha256: plan.packetSha256,
    publishedAt: '2026-08-30T00:02:00.000Z'
  });
  assert.equal(recovered.status, 'published');
  assert.equal(recovered.publishedCommit, retained.repository.candidateCommit);
  assert.equal(recovered.publishedIndexTree, retained.repository.candidateTree);
  assert.equal(recovered.publishedWorktreeTree, retained.repository.candidateTree);
  assert.equal(recovered.publishedWorktreeClean, true);
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('candidate retry records remote-pending after local CAS even when the remote became unavailable', async (t) => {
  const root = await repository(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-candidate-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(root, ['init', '--bare', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', 'origin', 'main']);
  git(root, ['push', 'origin', 'refs/heads/sflow/config:refs/heads/sflow/config']);
  await writeFile(path.join(root, 'tracked.txt'), 'candidate pending remote\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'candidate-fixture', createdBy: actor, createdAt: '2026-08-30T00:00:00.000Z'
  });
  await verifySgosCandidate(root, retained.candidate.candidateId, {
    verifiedAt: '2026-08-30T00:01:00.000Z'
  });
  const plan = await planSgosCandidatePublication(root, retained.candidate.candidateId, {
    remote: 'origin'
  });
  git(root, ['update-ref', 'refs/heads/main', retained.repository.candidateCommit,
    retained.repository.baselineCommit]);
  git(root, ['read-tree', retained.repository.candidateCommit]);
  git(root, ['remote', 'remove', 'origin']);
  const recovered = await publishSgosCandidate(root, retained.candidate.candidateId, {
    confirmationSha256: plan.packetSha256,
    remote: 'origin',
    publishedAt: '2026-08-30T00:02:00.000Z'
  });
  assert.equal(recovered.status, 'local-published-remote-pending');
  assert.equal(recovered.remote.failure.code, 'remote-not-configured');
  assert.equal(recovered.publishedCommit, retained.repository.candidateCommit);
});

test('candidate verification cannot pass after its command mutates the reviewed workspace', async (t) => {
  const root = await repository(t, { commands: [[process.execPath, '-e',
    "require('fs').writeFileSync('tracked.txt','changed-during-verification\\n')"]] });
  await writeFile(path.join(root, 'tracked.txt'), 'reviewed\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'candidate-fixture', createdBy: actor, createdAt: '2026-08-30T00:00:00.000Z'
  });
  const receipt = await verifySgosCandidate(root, retained.candidate.candidateId, {
    verifiedAt: '2026-08-30T00:01:00.000Z'
  });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.workspaceIntegrity.clean, false);
  await assert.rejects(
    planSgosCandidatePublication(root, retained.candidate.candidateId),
    (error) => error.code === 'SGOS_CANDIDATE_VERIFICATION_REQUIRED'
  );
});

test('candidate verification refuses caller-selected verifier authority', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'tracked.txt'), 'candidate\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'candidate-fixture', createdBy: actor,
    createdAt: '2026-08-30T00:00:00.000Z'
  });
  const escapedMarker = path.join(os.tmpdir(), `sflow-unauthorized-verifier-${process.pid}.txt`);
  await rm(escapedMarker, { force: true });
  t.after(() => rm(escapedMarker, { force: true }));
  await assert.rejects(
    verifySgosCandidate(root, retained.candidate.candidateId, {
      commands: [[process.execPath, '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(escapedMarker)},'ran')`]]
    }),
    (error) => error.code === 'SGOS_CANDIDATE_VERIFIER_CALLER_REFUSED'
  );
  await assert.rejects(readFile(escapedMarker), (error) => error.code === 'ENOENT');
  const authorized = await verifySgosCandidate(root, retained.candidate.candidateId, {
    verifiedAt: '2026-08-30T00:01:00.000Z'
  });
  assert.equal(authorized.status, 'passed');
  assert.match(authorized.verificationPolicy.policySha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(authorized.verificationPolicy.source.ref, 'refs/heads/sflow/config');
});

test('candidate verification fails closed without approved verifier policy authority', async (t) => {
  const root = await repository(t);
  git(root, ['update-ref', '-d', 'refs/heads/sflow/config']);
  await writeFile(path.join(root, 'tracked.txt'), 'candidate\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'candidate-fixture', createdBy: actor,
    createdAt: '2026-08-30T00:00:00.000Z'
  });
  await assert.rejects(
    verifySgosCandidate(root, retained.candidate.candidateId),
    (error) => error.code === 'SGOS_CANDIDATE_VERIFICATION_POLICY_UNAVAILABLE'
  );
  await assert.rejects(
    planSgosCandidatePublication(root, retained.candidate.candidateId),
    (error) => error.code === 'SGOS_CANDIDATE_VERIFICATION_POLICY_UNAVAILABLE'
  );
});

test('candidate publication refuses a verifier policy changed after confirmation', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'tracked.txt'), 'candidate\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'candidate-fixture', createdBy: actor,
    createdAt: '2026-08-30T00:00:00.000Z'
  });
  await verifySgosCandidate(root, retained.candidate.candidateId, {
    verifiedAt: '2026-08-30T00:01:00.000Z'
  });
  const plan = await planSgosCandidatePublication(root, retained.candidate.candidateId);
  await publishSgosCandidateVerifierPolicy(root, {
    commands: [[process.execPath, '-e', 'process.exitCode=0']],
    approvedAt: '2026-08-30T00:01:30.000Z'
  });
  await assert.rejects(
    publishSgosCandidate(root, retained.candidate.candidateId, {
      confirmationSha256: plan.packetSha256,
      publishedAt: '2026-08-30T00:02:00.000Z'
    }),
    (error) => error.code === 'SGOS_CANDIDATE_VERIFICATION_POLICY_STALE'
  );
  assert.equal(git(root, ['rev-parse', 'HEAD']), retained.repository.baselineCommit);
});
