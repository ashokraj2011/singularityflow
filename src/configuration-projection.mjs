/**
 * A configuration projection: the approved configuration's files at one exact commit, for editing,
 * with no clone and no application checkout (SDA M3, SDA-AC-013).
 *
 * Editing used to clone `sflow/config` into a temporary directory for every proposal. Now one fetch
 * brings the branch's tip and the objects it needs into the application repository's own object
 * store, kept by a private ref, and the projection is a temporary repository that borrows those
 * objects (Git alternates) with the exact commit's files written from them. Staging, the reviewed
 * tree check and the commit run there as before; the application checkout and its branches are never
 * touched, and the next edit transfers only what changed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gitCommonDir, runRemoteGitAsync } from './git-execution.mjs';
import { sourceRevision } from './source-inspection.mjs';
import { run, SingularityFlowError } from './util.mjs';

/** One replaceable retention ref: the base the last projection was made from, never authority. */
export const CONFIGURATION_PROJECTION_BASE_REF = 'refs/sflow/configuration-projection/base';

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
export function createConfigurationProjection(root, directory, commit, { branch, env = process.env, config = {} }) {
  run('git', ['init', '--quiet', '--template=', directory], { env });
  const common = path.resolve(root, gitCommonDir(root));
  const info = path.join(directory, '.git', 'objects', 'info');
  mkdirSync(info, { recursive: true });
  writeFileSync(path.join(info, 'alternates'), `${path.join(common, 'objects')}\n`);
  for (const [key, value] of Object.entries(config)) run('git', ['config', key, String(value)], { cwd: directory, env });
  run('git', ['update-ref', `refs/heads/${branch}`, commit], { cwd: directory, env });
  run('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: directory, env });
  run('git', ['read-tree', '-u', '--reset', 'HEAD'], { cwd: directory, env });
  return directory;
}
