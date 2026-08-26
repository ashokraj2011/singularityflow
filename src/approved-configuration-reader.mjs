/** Read the locally fetched, approved `sflow/config` commit without changing the checkout. */
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import {
  isConfigurationReadPath, withConfigurationReadRoot
} from './configuration-read-scope.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';
import { runRemoteGit } from './git-execution.mjs';

const WORKFLOW_PATH = 'singularity/workflow.yml';
const CONFIGURATION_BRANCH = 'sflow/config';
const STATE_BRANCH = 'state';
const STATE_MANIFEST = 'configuration/manifest.json';
const STATE_FORMAT = 'singularity-flow-configuration-mirror/v2';
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
  const stateRefs = run('git', [
    'for-each-ref', '--format=%(refname)',
    `refs/remotes/*/${STATE_BRANCH}`, `refs/heads/${STATE_BRANCH}`
  ], { cwd: root, allowFailure: true }).stdout.trim().split('\n')
    .map((entry) => entry.trim()).filter(Boolean)
    .sort((left, right) => (left === `refs/remotes/origin/${STATE_BRANCH}` ? -1 : 0)
      - (right === `refs/remotes/origin/${STATE_BRANCH}` ? -1 : 0) || left.localeCompare(right));
  for (const ref of stateRefs) {
    const commit = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: root, allowFailure: true
    }).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) continue;
    const shown = run('git', ['show', `${commit}:${STATE_MANIFEST}`], { cwd: root, allowFailure: true });
    if (shown.status !== 0) continue;
    let manifest;
    try { manifest = JSON.parse(shown.stdout); } catch { continue; }
    const files = manifest?.files;
    if (manifest?.format !== STATE_FORMAT || manifest?.layout !== 'canonical-paths'
      || manifest?.source?.branch !== CONFIGURATION_BRANCH
      || !/^[0-9a-f]{40,64}$/.test(manifest?.source?.commit ?? '')
      || !files || typeof files !== 'object' || Array.isArray(files)
      || !Object.hasOwn(files, WORKFLOW_PATH)
      || Object.entries(files).some(([relative, sha]) =>
        !isConfigurationReadPath(relative) || !/^[0-9a-f]{64}$/.test(sha))) continue;
    return { kind: 'verified-state-mirror', ref, commit, manifest };
  }
  return null;
}

/**
 * Repair a narrow/single-branch clone by fetching only a published configuration authority.
 *
 * The ref is written to the ordinary remote-tracking namespace, exactly as a full clone would have
 * done. The selected branch, HEAD, index and application files are never changed. Prefer the
 * reviewed configuration authority; `state` is recovery-only and is accepted later only after its
 * complete manifest and every declared byte have been verified.
 */
function refreshApprovedConfigurationAuthority(root) {
  const listed = run('git', ['remote'], { cwd: root, allowFailure: true });
  if (listed.status !== 0) return null;
  const remotes = listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
    .sort((left, right) => (left === 'origin' ? -1 : 0) - (right === 'origin' ? -1 : 0)
      || left.localeCompare(right));
  for (const remote of remotes) {
    const advertised = runRemoteGit([
      'ls-remote', '--heads', '--', remote,
      `refs/heads/${CONFIGURATION_BRANCH}`, `refs/heads/${STATE_BRANCH}`
    ], { cwd: root, operation: 'remote-probe' });
    if (advertised.status !== 0) continue;
    const branches = new Set(advertised.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean));
    for (const branch of [CONFIGURATION_BRANCH, STATE_BRANCH]) {
      if (!branches.has(`refs/heads/${branch}`)) continue;
      const destination = `refs/remotes/${remote}/${branch}`;
      const validRef = run('git', ['check-ref-format', destination], { cwd: root, allowFailure: true });
      if (validRef.status !== 0) continue;
      const fetched = runRemoteGit([
        'fetch', '--quiet', '--no-tags', '--force', '--', remote,
        `+refs/heads/${branch}:${destination}`
      ], { cwd: root, operation: 'remote-configuration' });
      if (fetched.status !== 0) continue;
      const authority = approvedConfigurationAuthority(root);
      if (authority) return authority;
    }
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
  if (authority.kind === 'verified-state-mirror') {
    const declared = Object.keys(authority.manifest.files).sort();
    const copied = entries.map((entry) => entry.file).sort();
    if (JSON.stringify(declared) !== JSON.stringify(copied)) {
      throw new SingularityFlowError('State configuration mirror files do not exactly match its manifest.', {
        code: 'STATE_CONFIGURATION_MIRROR_INVALID'
      });
    }
    for (const relative of copied) {
      const actual = createHash('sha256').update(await readFile(path.join(destination, relative))).digest('hex');
      if (actual !== authority.manifest.files[relative]) {
        throw new SingularityFlowError(`State configuration mirror hash does not match for '${relative}'.`, {
          code: 'STATE_CONFIGURATION_MIRROR_INVALID'
        });
      }
    }
  }
}

/**
 * Use the working-tree configuration when present; otherwise mount the fetched approved commit in
 * a disposable directory. A narrow clone may refresh one ordinary remote-tracking authority ref;
 * the selected ref, HEAD, index and application files are never changed.
 */
export async function withApprovedConfigurationRead(root, fn) {
  const workflow = await lstat(path.join(root, WORKFLOW_PATH)).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  if (workflow) return fn({ kind: 'working-tree', ref: null, commit: null });
  const authority = approvedConfigurationAuthority(root) ?? refreshApprovedConfigurationAuthority(root);
  if (!authority) return fn(null);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-approved-config-read-'));
  try {
    await extractConfiguration(root, authority, temporaryRoot);
    return await withConfigurationReadRoot(root, temporaryRoot, authority, () => fn(authority));
  } finally {
    await removeTemporaryTree(temporaryRoot);
  }
}
