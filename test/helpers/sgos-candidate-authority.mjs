import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createSgosCandidateVerifierPolicy, SGOS_CANDIDATE_VERIFIER_POLICY_PATH
} from '../../src/sgos/candidate-lifecycle.mjs';

function git(root, args, { allowFailure = false, env = {}, input = null } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function objectId(root, bytes) {
  return git(root, ['hash-object', '-w', '--stdin'], { input: bytes }).stdout.trim();
}

/** Publish one exact test-only verifier policy without changing the application checkout. */
export async function publishSgosCandidateVerifierPolicy(root, {
  commands = [[process.execPath, '-e', 'process.exit(0)']],
  timeoutMs = 30_000,
  approvedBy = { kind: 'human', id: 'candidate-policy-reviewer' },
  approvedAt = '2026-08-30T00:00:00.000Z'
} = {}) {
  const policy = createSgosCandidateVerifierPolicy({
    policyId: 'default', commands, timeoutMs, approvedBy, approvedAt
  });
  const ref = 'refs/heads/sflow/config';
  const observed = git(root, ['rev-parse', '--verify', `${ref}^{commit}`], {
    allowFailure: true
  });
  const priorRef = observed.status === 0 ? observed.stdout.trim() : null;
  const parent = priorRef ?? git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim();
  const index = path.join(os.tmpdir(), `sflow-candidate-authority-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(root, ['read-tree', parent], { env });
    const workflowPresent = git(root, [
      'cat-file', '-e', `${parent}:singularity/workflow.yml`
    ], { allowFailure: true }).status === 0;
    if (!workflowPresent) {
      const workflowOid = objectId(root, 'version: 1\n');
      git(root, [
        'update-index', '--add', '--cacheinfo',
        `100644,${workflowOid},singularity/workflow.yml`
      ], { env });
    }
    const policyOid = objectId(root, `${JSON.stringify(policy, null, 2)}\n`);
    git(root, [
      'update-index', '--add', '--cacheinfo',
      `100644,${policyOid},${SGOS_CANDIDATE_VERIFIER_POLICY_PATH}`
    ], { env });
    const tree = git(root, ['write-tree'], { env }).stdout.trim();
    const commit = git(root, ['commit-tree', tree, '-p', parent], {
      input: `Approve SGOS Candidate verifier policy ${policy.policySha256}\n`
    }).stdout.trim();
    git(root, ['update-ref', ref, commit, ...(priorRef ? [priorRef] : [])]);
    return { policy, ref, commit };
  } finally {
    await unlink(index).catch(() => {});
  }
}
