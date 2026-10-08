/** Pilot cutover: retire known Story identities without reading/migrating their evidence. */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { loadDefinition } from './config.mjs';
import { GOVERNANCE_ARCHIVE_PATH, GOVERNANCE_ARCHIVE_VERSION, mergeGovernanceArchive, readGovernanceArchive } from './governance-archive.mjs';
import { ensureSecureRepositoryDirectory, secureRepositoryPath, writeAtomic, SingularityFlowError } from './util.mjs';

/** Only a disposable approved-configuration candidate may be passed as root. */
export async function stageStoryHardCutover(root, repository, sourceCommit, refresh) {
  // Lazy loading avoids a static cycle: the existing rebuild composes packaged refresh too.
  const { governanceStoryInventory } = await import('./governance-rebuild.mjs');
  const definition = await loadDefinition(root);
  const stories = new Map();
  const opaque = [];
  for (const checkout of [...new Set(repository.localPaths ?? [repository.localPath])]) {
    if (!checkout) throw new SingularityFlowError('Hard cutover requires every registered local checkout.', {
      code: 'STORY_CUTOVER_CHECKOUT_REQUIRED'
    });
    const inventory = await governanceStoryInventory(checkout, definition, { remote: null });
    for (const entry of inventory.stories) {
      const key = `${entry.id}\0${entry.createdAt ?? ''}`;
      const prior = stories.get(key);
      stories.set(key, prior ? { ...prior, locations: [...prior.locations, ...entry.locations] } : entry);
    }
    // The subject index already bounded this path to the checkout's or historical branch's
    // configured Story root. Retire the directory identity without interpreting corrupt JSON;
    // no arbitrary application JSON or unreadable Initiative can enter this path.
    for (const entry of inventory.unreadable) {
      const relative = String(entry.path ?? '').replaceAll('\\', '/');
      const match = relative.match(/(?:^|\/)([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/workflow\.json$/);
      if (!match) throw new SingularityFlowError('An unreadable Story identity could not be bounded for cutover.', {
        code: 'STORY_CUTOVER_IDENTITY_UNREADABLE'
      });
      opaque.push(match[1]);
      stories.set(`${match[1]}\0`, { id: match[1], createdAt: null, statuses: ['unreadable'], locations: [] });
    }
  }
  const { absolute: target } = await secureRepositoryPath(root, GOVERNANCE_ARCHIVE_PATH, { label: 'Story cutover archive' });
  const info = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)) {
    throw new SingularityFlowError('Story archive must be a bounded regular file.', { code: 'STORY_CUTOVER_ARCHIVE_UNSAFE' });
  }
  const text = info ? await readFile(target, 'utf8') : null;
  if (info) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* fail closed below */ }
    if (parsed?.schema !== GOVERNANCE_ARCHIVE_VERSION || !Array.isArray(parsed.stories)
      || !Array.isArray(parsed.rebuilds) || parsed.stories.some(entry => !entry
        || typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.id)
        || (entry.createdAt != null && typeof entry.createdAt !== 'string')
        || (entry.statuses != null && (!Array.isArray(entry.statuses) || entry.statuses.some(status => typeof status !== 'string')))
        || (entry.locations != null && (!Array.isArray(entry.locations) || entry.locations.some(location => !location
          || typeof location.ref !== 'string' || (location.commit != null && typeof location.commit !== 'string')))))) {
      throw new SingularityFlowError('Existing Story archive is invalid; cutover must not overwrite it.', { code: 'STORY_CUTOVER_ARCHIVE_INVALID' });
    }
  }
  const existing = readGovernanceArchive(text);
  // A normal rebuild archives one incarnation. Hard cutover retires the identity itself,
  // including any earlier archive entries; reusing its ID must not resurrect a pilot Story.
  const retired = new Set(existing.stories.filter(entry => entry.allIncarnations === true).map(entry => entry.id));
  for (const entry of existing.stories) {
    const key = `${entry.id}\0${entry.createdAt ?? ''}`;
    if (!stories.has(key)) stories.set(key, { ...entry, statuses: entry.statuses ?? [], locations: entry.locations ?? [] });
  }
  const added = [...stories.values()].filter(entry => !retired.has(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const plan = `cutover-${createHash('sha256').update(JSON.stringify({ sourceCommit, stories: added })).digest('hex').slice(0, 24)}`;
  if (added.length) {
    await ensureSecureRepositoryDirectory(root, 'singularity/governance', { label: 'Story cutover archive directory' });
    // Activation time is supplied by the configuration commit, not an unstable preview clock.
    const archive = mergeGovernanceArchive(existing, { plan, archivedAt: null, actor: null, stories: added });
    const retiring = new Set(added.map(entry => entry.id));
    for (const entry of archive.stories) if (retiring.has(entry.id)) {
      entry.allIncarnations = true;
      entry.hardCutoverBy = plan;
    }
    Object.assign(archive.rebuilds.at(-1), { mode: 'hard-cutover', stories: retiring.size });
    await writeAtomic(target, `${JSON.stringify(archive, null, 2)}\n`);
  }
  const retiredIds = [...new Set([...retired, ...added.map(entry => entry.id)])].sort();
  return { ...refresh, changed: refresh.changed || added.length > 0,
    files: [...new Set([...refresh.files, ...(added.length ? [GOVERNANCE_ARCHIVE_PATH] : [])])].sort(),
    storyCutover: { requested: true, mode: 'hard', historicalBytes: 'preserved', retiredIds,
      retiring: added.map(entry => ({ id: entry.id, createdAt: entry.createdAt, locations: entry.locations })),
      opaqueIds: [...new Set(opaque)].sort(),
      statement: 'Known pre-cutover Stories become read-only. Start new Stories with new IDs; historical files, approvals, branches and commits are preserved, not migrated.' }
  };
}
