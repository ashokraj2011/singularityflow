/**
 * A configuration projection: the approved configuration's files at one exact commit, for editing,
 * with no clone and no application checkout (SDA M3, SDA-AC-013).
 *
 * Editing used to clone `sflow/config` into a temporary directory for every proposal. Now one fetch
 * brings the branch's tip and the objects it needs into the application repository's own object
 * store, kept by a private ref, and the projection is a temporary repository that borrows those
 * objects (Git alternates) with the exact commit's files written from them. Staging, the reviewed
 * tree check and the commit run there as before; the application checkout and its branches are never
 * touched, and the next edit transfers only what changed. Partial clones hydrate missing file
 * objects explicitly from that same approved authority before the borrower writes any files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gitCommonDir, gitTimeouts, runRemoteGitAsync } from './git-execution.mjs';
import { failureEvidence, gitFailureDiagnostic } from './git-remote-diagnostics.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';
import { inheritEnterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { sourceRevision } from './source-inspection.mjs';
import { run, SingularityFlowError } from './util.mjs';

/** One replaceable retention ref: the base the last projection was made from, never authority. */
export const CONFIGURATION_PROJECTION_BASE_REF = 'refs/sflow/configuration-projection/base';
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const BLOB_BATCH = 128; // Bounds the command line on Windows, including SHA-256 repositories.
const INVENTORY_BYTES = 32 * 1024 * 1024;

function unavailable(message, result = null, details = {}) {
  throw new SingularityFlowError(message, { code: 'CONFIGURATION_PROJECTION_OBJECTS_UNAVAILABLE',
    details: { ...details, ...(result ? { evidence: failureEvidence(result), diagnostic: gitFailureDiagnostic(result) } : {}) } });
}

/** No promisor remote is configured in this disposable borrower, even on older Git releases. */
function projectionObjects(directory, commit, env) {
  const options = { cwd: directory, env, allowFailure: true, timeoutMs: 15000, maxBuffer: INVENTORY_BYTES };
  const listed = run('git', ['ls-tree', '-r', '-z', '--format=%(objecttype)%x09%(objectname)', commit], options);
  if (listed.status !== 0) unavailable('Cannot inventory the exact approved configuration tree. Existing work was preserved.', listed);
  const objects = new Set();
  for (const row of listed.stdout.split('\0').filter(Boolean)) {
    const [type, oid, extra] = row.split('\t');
    if (!OBJECT_ID.test(oid ?? '') || extra != null || !['blob', 'commit'].includes(type)) unavailable('Git returned an invalid configuration object inventory.');
    if (type === 'blob') objects.add(oid);
  }
  return [...objects];
}

function missingProjectionObjects(directory, objects, env) {
  if (!objects.length) return [];
  const checked = run('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: directory, env, input: `${objects.join('\n')}\n`, allowFailure: true, timeoutMs: 15000, maxBuffer: INVENTORY_BYTES
  });
  if (checked.status !== 0) unavailable('Cannot read the approved configuration object store. Existing work was preserved.', checked);
  const rows = checked.stdout.trimEnd().split(/\r?\n/u);
  if (rows.length !== objects.length) unavailable('Git did not check every approved configuration file object.');
  return rows.flatMap((row, index) => {
    if (row === `${objects[index]} missing`) return [objects[index]];
    if (row !== `${objects[index]} blob`) unavailable('An approved configuration file has an unexpected Git object type.');
    return [];
  });
}

async function hydrateProjection(root, directory, commit, env, transport, runRemoteCommand) {
  const objects = projectionObjects(directory, commit, env);
  const missing = missingProjectionObjects(directory, objects, env);
  if (!missing.length) return;
  if (!transport?.remote) unavailable(`${missing.length} approved configuration file objects are not downloaded. Retry through the original configuration operation to fetch them.`, null, { commit, missingObjects: missing.length });
  const deadline = performance.now() + gitTimeouts(transport.env ?? env).configuration;
  for (let offset = 0; offset < missing.length; offset += BLOB_BATCH) {
    const timeoutMs = Math.ceil(deadline - performance.now());
    if (timeoutMs <= 0) throw new SingularityFlowError('Downloading the approved configuration files exceeded its configured deadline. Retry the same operation; existing work was preserved.',
      { code: 'REMOTE_TIMEOUT', details: { timedOut: true, stage: 'configuration-object-hydration', missingObjects: missing.length } });
    // A blob has no descendants. Exact blob wants need no filter (which would register another
    // promisor remote in the caller's repository); refetch also avoids unavailable delta bases.
    const downloaded = await runRemoteCommand(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refetch',
      '--recurse-submodules=no', '--', transport.remote, ...missing.slice(offset, offset + BLOB_BATCH)],
    { cwd: root, env: transport.env ?? env, operation: 'remote-configuration', timeoutMs });
    if (downloaded.status !== 0) throw new SingularityFlowError(
      `Cannot download ${missing.length} missing approved configuration files. ${downloaded.failure?.advice ?? 'The approved remote did not supply the requested objects.'}`, {
        code: downloaded.failure?.code ?? 'CONFIGURATION_PROJECTION_OBJECTS_UNAVAILABLE',
        details: { stage: 'configuration-object-hydration', commit, missingObjects: missing.length,
          classification: downloaded.failure?.classification ?? 'unknown', evidence: failureEvidence(downloaded) }
      });
  }
  const remaining = missingProjectionObjects(directory, objects, env);
  if (remaining.length) unavailable('The configuration download completed but required file objects are still unavailable. Retry the same operation; existing work was preserved.', null,
    { commit, missingObjects: remaining.length });
  incrementCommandCounter('configuration.projection.blobs-fetched', missing.length);
}

/**
 * Fetch `branch` from the authority into the application repository: its tip and objects, in one
 * transfer. Returns the exact tip, or the transfer's failure for the caller's own refusal.
 */
export async function fetchConfigurationBase(root, transport, { branch }) {
  const fetched = await runRemoteGitAsync([
    'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--',
    transport.remote, `+refs/heads/${branch}:${CONFIGURATION_PROJECTION_BASE_REF}`
  ], { cwd: root, operation: 'remote-configuration', env: transport.env });
  if (fetched.status !== 0) return { commit: null, failure: fetched };
  const tip = sourceRevision(root, CONFIGURATION_PROJECTION_BASE_REF, { env: transport.env, offline: true });
  if (tip.status !== 'present') {
    throw new SingularityFlowError('The fetched configuration base cannot be read from the application repository.', {
      code: 'CONFIGURATION_PROJECTION_BASE_UNAVAILABLE'
    });
  }
  return { commit: tip.value, failure: null };
}

/**
 * Write `commit`'s files into `directory`, a new repository on `branch` whose objects are the
 * application repository's. `config` holds per-projection settings (for example core.autocrlf).
 */
export async function createConfigurationProjection(root, directory, commit, {
  branch, env = process.env, config = {}, transport = null, runRemoteCommand = runRemoteGitAsync
}) {
  if (!OBJECT_ID.test(commit)) unavailable('Configuration projection requires an exact approved commit.');
  run('git', ['init', '--quiet', '--template=', `--object-format=${commit.length === 64 ? 'sha256' : 'sha1'}`, directory], { env });
  const common = path.resolve(root, gitCommonDir(root));
  const info = path.join(directory, '.git', 'objects', 'info');
  mkdirSync(info, { recursive: true });
  writeFileSync(path.join(info, 'alternates'), `${path.join(common, 'objects').replaceAll('\\', '/')}\n`);
  for (const [key, value] of Object.entries(config)) run('git', ['config', key, String(value)], { cwd: directory, env });
  run('git', ['update-ref', `refs/heads/${branch}`, commit], { cwd: directory, env });
  run('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: directory, env });
  const localEnv = inheritEnterpriseGitEnvironment(env, { ...env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' });
  await measureCommandSpan('configuration.projection-hydrate', () => hydrateProjection(root, directory, commit, localEnv, transport, runRemoteCommand));
  const populated = run('git', ['read-tree', '-u', '--reset', 'HEAD'], { cwd: directory, env: localEnv, allowFailure: true });
  if (populated.status !== 0) unavailable('The approved configuration files could not be written after their Git objects were checked. Inspect local storage and retry the same operation; existing work was preserved.', populated, { commit });
  return directory;
}
