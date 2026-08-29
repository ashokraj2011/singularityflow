import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createSgosProgramAuthorityRecord, sgosProgramAuthorityPath
} from '../../src/sgos/program-trust.mjs';

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

/** Publish an exact test-only approval on the local approved-configuration ref without checkout. */
export async function publishSgosProgramAuthority(root, program, {
  approvedBy = { kind: 'human', id: 'sgos-test-authority' },
  approvedAt = '2026-08-29T09:59:00.000Z',
  workflowBytes = null
} = {}) {
  const authority = createSgosProgramAuthorityRecord(program, { approvedBy, approvedAt });
  const relative = sgosProgramAuthorityPath(program);
  const authorityBytes = `${JSON.stringify(authority, null, 2)}\n`;
  const authorityOid = objectId(root, authorityBytes);
  const ref = 'refs/heads/sflow/config';
  const observed = git(root, ['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
  const priorRef = observed.status === 0 ? observed.stdout.trim() : null;
  const parent = priorRef ?? git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout.trim();
  const index = path.join(os.tmpdir(), `sflow-sgos-authority-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(root, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env });
    const hasWorkflow = parent && git(root, [
      'cat-file', '-e', `${parent}:singularity/workflow.yml`
    ], { allowFailure: true }).status === 0;
    if (workflowBytes != null || !hasWorkflow) {
      const workflowOid = objectId(root, workflowBytes ?? 'version: 1\n');
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${workflowOid},singularity/workflow.yml`], { env });
    }
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${authorityOid},${relative}`], { env });
    const tree = git(root, ['write-tree'], { env }).stdout.trim();
    const commitArgs = ['commit-tree', tree];
    if (parent) commitArgs.push('-p', parent);
    const commit = git(root, commitArgs, {
      input: `Approve SGOS Program ${program.programSha256}\n`
    }).stdout.trim();
    git(root, ['update-ref', ref, commit, ...(priorRef ? [priorRef] : [])]);
    return { authority, relative, ref, commit };
  } finally {
    await unlink(index).catch(() => {});
  }
}
