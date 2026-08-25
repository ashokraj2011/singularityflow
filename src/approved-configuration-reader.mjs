/** Read the locally fetched, approved `sflow/config` commit without changing the checkout. */
import os from 'node:os';
import path from 'node:path';
import { chmod, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import {
  isConfigurationReadPath, withConfigurationReadRoot
} from './configuration-read-scope.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';

const WORKFLOW_PATH = 'singularity/workflow.yml';
const CONFIGURATION_BRANCH = 'sflow/config';
const MAX_FILES = 10_000;
const MAX_BYTES = 128 * 1024 * 1024;

function approvedConfigurationAuthority(root) {
  const listed = run('git', [
    'for-each-ref', '--format=%(refname)',
    `refs/remotes/*/${CONFIGURATION_BRANCH}`, `refs/heads/${CONFIGURATION_BRANCH}`
  ], { cwd: root, allowFailure: true });
  if (listed.status !== 0) return null;
  const refs = listed.stdout.trim().split('\n').map((entry) => entry.trim()).filter(Boolean)
    .sort((left, right) => {
      const leftOrigin = left === `refs/remotes/origin/${CONFIGURATION_BRANCH}` ? 0 : 1;
      const rightOrigin = right === `refs/remotes/origin/${CONFIGURATION_BRANCH}` ? 0 : 1;
      return leftOrigin - rightOrigin || left.localeCompare(right);
    });
  for (const ref of refs) {
    const commit = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: root, allowFailure: true
    }).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) continue;
    const workflow = run('git', ['cat-file', '-e', `${commit}:${WORKFLOW_PATH}`], {
      cwd: root, allowFailure: true
    });
    if (workflow.status === 0) return { kind: 'approved-configuration-ref', ref, commit };
  }
  return null;
}

async function extractConfiguration(root, authority, destination) {
  const listed = run('git', [
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', authority.commit, '--',
    'singularity', '.github/agents'
  ], { cwd: root });
  const entries = listed.stdout.split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' ');
    const second = line.indexOf(' ', first + 1);
    return { mode: line.slice(0, first), oid: line.slice(first + 1, second), file: line.slice(second + 1) };
  }).filter((entry) => /^100(?:644|755)$/.test(entry.mode) && isConfigurationReadPath(entry.file));
  if (!entries.some((entry) => entry.file === WORKFLOW_PATH)) {
    throw new SingularityFlowError(
      `Approved configuration ${authority.ref} does not contain ${WORKFLOW_PATH}.`,
      { code: 'APPROVED_CONFIGURATION_INCOMPLETE' }
    );
  }
  if (entries.length > MAX_FILES) {
    throw new SingularityFlowError(`Approved configuration contains more than ${MAX_FILES} files.`, {
      code: 'APPROVED_CONFIGURATION_TOO_LARGE'
    });
  }
  const batch = run('git', ['cat-file', '--batch'], {
    cwd: root, encoding: 'buffer', input: `${entries.map((entry) => entry.oid).join('\n')}\n`
  });
  let cursor = 0;
  let total = 0;
  for (const entry of entries) {
    const newline = batch.stdout.indexOf(0x0a, cursor);
    if (newline < 0) throw new SingularityFlowError(`Could not read approved configuration file '${entry.file}'.`);
    const [oid, type, rawSize] = batch.stdout.toString('utf8', cursor, newline).trim().split(' ');
    const size = Number(rawSize);
    if (oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new SingularityFlowError(`Could not read approved configuration file '${entry.file}'.`);
    }
    total += size;
    if (total > MAX_BYTES) {
      throw new SingularityFlowError(`Approved configuration exceeds ${MAX_BYTES} bytes.`, {
        code: 'APPROVED_CONFIGURATION_TOO_LARGE'
      });
    }
    const start = newline + 1;
    const end = start + size;
    if (end > batch.stdout.length) {
      throw new SingularityFlowError(`Approved configuration file '${entry.file}' is truncated.`);
    }
    const target = path.join(destination, entry.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, batch.stdout.subarray(start, end));
    await chmod(target, entry.mode === '100755' ? 0o755 : 0o644);
    cursor = end + 1;
  }
}

/**
 * Use the working-tree configuration when present; otherwise mount the fetched approved commit in
 * a disposable directory. No ref, index, application file, or Git object is changed.
 */
export async function withApprovedConfigurationRead(root, fn) {
  const workflow = await lstat(path.join(root, WORKFLOW_PATH)).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (workflow) return fn({ kind: 'working-tree', ref: null, commit: null });
  const authority = approvedConfigurationAuthority(root);
  if (!authority) return fn(null);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-approved-config-read-'));
  try {
    await extractConfiguration(root, authority, temporaryRoot);
    return await withConfigurationReadRoot(root, temporaryRoot, authority, () => fn(authority));
  } finally {
    await removeTemporaryTree(temporaryRoot);
  }
}
