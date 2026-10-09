/**
 * The Stories a governance rebuild archived [E2G §11].
 *
 * A rebuild never rewrites a Story branch. It records every Story it archives in one committed
 * registry, beside the configuration it rebuilt, and the engine refuses to change any Story the
 * registry names. A Story is identified by its ID and the moment it was created, so a later Story
 * that reuses an archived ID is a different Story. An explicit pilot hard cutover instead retires
 * all incarnations of the listed IDs: new work must use a new ID.
 *
 * A Story branch cut before the rebuild does not contain the registry, so the check reads it from
 * the branch the Story was cut from, its remote-tracking copy and the configuration authority, as
 * well as from the checkout: local refs only, never the network.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { configurationReadRootForPath } from './configuration-read-scope.mjs';

import { committedFileText, committedFilesAtRevisions } from './git.mjs';
import { SingularityFlowError, SUBPROCESS_MAX_BUFFER_BYTES } from './util.mjs';

export const GOVERNANCE_ARCHIVE_PATH = 'singularity/governance/archive.json';
export const GOVERNANCE_ARCHIVE_VERSION = 'governance-archive/v1';

function parse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const value = JSON.parse(text);
    return value?.schema === GOVERNANCE_ARCHIVE_VERSION && Array.isArray(value.stories) ? value : null;
  } catch {
    return null;
  }
}

/** The registry as committed or written in one place, or an empty registry. */
export function readGovernanceArchive(text) {
  return parse(text) ?? { schema: GOVERNANCE_ARCHIVE_VERSION, rebuilds: [], stories: [] };
}

/** The registry with one more rebuild's Stories, each listed once. */
export function mergeGovernanceArchive(existing, { plan, archivedAt, actor, stories }) {
  const registry = readGovernanceArchive(existing == null ? null : JSON.stringify(existing));
  const key = (story) => `${story.id}\u0000${story.createdAt ?? ''}`;
  const known = new Set(registry.stories.map(key));
  const added = stories.filter((story) => !known.has(key(story))).map((story) => ({
    id: story.id,
    createdAt: story.createdAt ?? null,
    statuses: [...story.statuses],
    locations: story.locations.map(({ ref, commit }) => ({ ref, commit })),
    archivedBy: plan,
    archivedAt
  }));
  return {
    schema: GOVERNANCE_ARCHIVE_VERSION,
    rebuilds: [...registry.rebuilds, { plan, archivedAt, actor, stories: added.length }],
    stories: [...registry.stories, ...added].sort((left, right) => left.id.localeCompare(right.id))
  };
}

function sources(root, workflow) {
  const item = workflow?.workItem ?? {};
  const remote = item.baseRemote ?? 'origin';
  const refs = new Set();
  if (item.baseBranch) {
    refs.add(`refs/heads/${item.baseBranch}`);
    refs.add(`refs/remotes/${remote}/${item.baseBranch}`);
  }
  refs.add(`refs/remotes/${remote}/sflow/config`);
  refs.add('refs/heads/sflow/config');
  const stateBranch = workflow?.resolution?.ledger?.branch ?? 'state';
  const stateRemote = workflow?.resolution?.ledger?.remote ?? remote;
  refs.add(`refs/remotes/${stateRemote}/${stateBranch}`);
  const texts = [];
  for (const directory of new Set([root, configurationReadRootForPath(root, GOVERNANCE_ARCHIVE_PATH)])) {
    const local = path.join(directory, GOVERNANCE_ARCHIVE_PATH);
    if (existsSync(local)) texts.push(readFileSync(local, 'utf8'));
  }
  // Resolve all live refs afresh at every write boundary. Batching the reads avoids five Git
  // processes per guard without memoizing mutable refs across Story creation and publication.
  // No small-view byte ceiling may silently hide a large registry that names an archived Story.
  try {
    const committed = committedFilesAtRevisions(root, [...refs].map(ref => ({
      key: ref, ref, path: GOVERNANCE_ARCHIVE_PATH
    })), { maximumObjectBytes: SUBPROCESS_MAX_BUFFER_BYTES, maximumBytes: SUBPROCESS_MAX_BUFFER_BYTES,
      requireCompleteRead: true });
    for (const bytes of committed.values()) texts.push(bytes.toString('utf8'));
  } catch {
    // Preserve independent-copy recovery if one object cannot be read by the batch. An unreadable
    // copy proves nothing either way; another ref or the checkout can still name the Story.
    for (const ref of refs) {
      try { texts.push(committedFileText(root, ref, GOVERNANCE_ARCHIVE_PATH)); } catch { /* next copy */ }
    }
  }
  return texts.map(parse).filter(Boolean);
}

/** The archive entry naming this Story, or null when no rebuild archived it. */
export function governanceArchiveEntry(root, workflow) {
  const id = workflow?.workItem?.id;
  if (!id) return null;
  const createdAt = workflow.workItem.createdAt ?? null;
  for (const registry of sources(root, workflow)) {
    const entry = registry.stories.find((story) => story.id === id
      && (story.allIncarnations === true || (story.createdAt ?? null) === createdAt));
    if (entry) return entry;
  }
  return null;
}

/** Refuse changing a Story a governance rebuild archived; reading it stays possible. */
export function assertStoryNotArchived(root, workflow) {
  const entry = governanceArchiveEntry(root, workflow);
  if (!entry) return;
  const hard = entry.allIncarnations === true;
  const plan = entry.hardCutoverBy ?? entry.archivedBy;
  const archivedAt = hard ? null : entry.archivedAt;
  throw new SingularityFlowError(
    `Story '${entry.id}' was ${hard ? 'discontinued by pilot hard cutover' : 'archived by governance rebuild'} ${plan}${archivedAt ? ` on ${archivedAt}` : ''}; it is read-only. `
    + 'Start a new Story with a new ID under the current governance.',
    { code: 'STORY_ARCHIVED_BY_REBUILD', exitCode: 2, details: { workId: entry.id, plan, archivedAt,
      mode: hard ? 'hard-cutover' : 'governance-rebuild' } }
  );
}
