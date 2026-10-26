/** A checkout's personal start configuration. It never changes the pinned test selection. */
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withRegistryFileLease } from './file-lease.mjs';
import { repositoryWorktreeDirectory } from './git-worktree-directory.mjs';
import { readPrivateSidecar, writeMutablePrivateSidecar, writeImmutablePrivateSidecar, safePrivateSidecarDirectory } from './private-sidecar.mjs';
import { gitCommonDir } from './git.mjs';
import { SingularityFlowError } from './util.mjs';

export function localApplicationProfilePath(root, capability) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(capability) || capability === '..') throw new SingularityFlowError('Invalid capability profile ID.');
  const own = repositoryWorktreeDirectory(root);
  if (!own) throw new SingularityFlowError('The run configuration checkout is unavailable.');
  return path.join(gitCommonDir(root), 'singularity-flow', 'local-application', createHash('sha256').update(path.resolve(own)).digest('hex').slice(0, 32), `${capability}.json`);
}
export async function readLocalApplicationProfile(root, capability, baseSha256) {
  const bytes = await readPrivateSidecar(root, localApplicationProfilePath(root, capability), { optional: true, maximumBytes: 256 * 1024, enforceWindowsAcl: true });
  if (!bytes) return null;
  let record;
  try { record = JSON.parse(bytes); } catch { throw new SingularityFlowError('The personal run configuration is unreadable. Reset or repair it.', { code: 'APP_LOCAL_PROFILE_INVALID' }); }
  if (record.format !== 'sflow-local-application/v1' || record.capability !== capability || !Array.isArray(record.start)) throw new SingularityFlowError('Unsupported personal run configuration.', { code: 'APP_LOCAL_PROFILE_INVALID' });
  if (record.baseSha256 !== baseSha256) throw new SingularityFlowError('Team configuration changed. Reset or re-save the personal run configuration before starting.', { code: 'APP_LOCAL_PROFILE_STALE' });
  return record;
}
export async function saveLocalApplicationProfile(root, context, block) {
  const { normalizeCapabilityApplication } = await import('./capabilities.mjs');
  const { typedApplication } = await import('./run-configurations.mjs');
  const defaults = context.capability?.application ?? { start: [], tests: [] };
  if (!isDeepStrictEqual(block.tests ?? [], defaults.tests ?? [])) throw new SingularityFlowError('A personal run configuration cannot change the Story test selection.', { code: 'APP_LOCAL_TEST_SCOPE_DENIED' });
  const repositories = context.repositories.length ? context.repositories : context.implicit ? [context.capabilityId] : [];
  const capability = context.implicit ? { ...context.capability, repository: repositories[0] } : context.capability;
  typedApplication(context.capabilityId, block, normalizeCapabilityApplication(context.capabilityId, { ...capability, application: block }), {
    checkoutRoot: root, repositoryId: context.repositoryId, repositories });
  const file = localApplicationProfilePath(root, context.capabilityId);
  const record = { format: 'sflow-local-application/v1', capability: context.capabilityId, baseSha256: context.mapSha256, revision: randomUUID(), start: block.start ?? [] };
  await safePrivateSidecarDirectory(root, path.dirname(file), { create: true, enforceWindowsAcl: true });
  await withRegistryFileLease(file, async () => {
    const previous = await readPrivateSidecar(root, file, { optional: true, maximumBytes: 256 * 1024, enforceWindowsAcl: true });
    if (previous) await writeImmutablePrivateSidecar(root, `${file}.retained-${randomUUID()}`, previous, { maximumBytes: 256 * 1024, enforceWindowsAcl: true });
    await writeMutablePrivateSidecar(root, file, JSON.stringify(record), { maximumBytes: 256 * 1024, enforceWindowsAcl: true });
  });
  return { resultType: 'sflow-app-local-profile', changed: true, path: file, revision: record.revision, scope: 'checkout', testSelectionChanged: false };
}
export async function resetLocalApplicationProfile(root, capability) {
  const file = localApplicationProfilePath(root, capability);
  const options = { optional: true, maximumBytes: 256 * 1024, enforceWindowsAcl: true };
  if (!await readPrivateSidecar(root, file, options)) return { resultType: 'sflow-app-local-profile', changed: false, scope: 'checkout', reset: true };
  return withRegistryFileLease(file, async () => {
    const bytes = await readPrivateSidecar(root, file, options);
    if (bytes) {
      await writeImmutablePrivateSidecar(root, `${file}.retained-${randomUUID()}`, bytes, options);
      const { unlink } = await import('node:fs/promises');
      await unlink(file);
    }
    return { resultType: 'sflow-app-local-profile', changed: Boolean(bytes), scope: 'checkout', reset: true };
  });
}
