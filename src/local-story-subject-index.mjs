import path from 'node:path';
import { RepositorySubjectIndex, buildRepositorySubjectIndex, buildRepositorySubjectIndexFromRefs } from './repository-subject-index.mjs';

/**
 * Local drafts are separate from the published state roster. Only the current checkout and
 * Git's registered managed Story worktrees may supply them; unrelated branch refs are never
 * enumerated. Read each registered immutable HEAD with its own pinned metadata roots.
 */
export async function localStorySubjectIndex(root, { definition = {}, reference = null } = {}) {
  const working = await buildRepositorySubjectIndex(root, { definition });
  if (reference && working.matches(reference, { kind: 'story' }).length) return working;
  // The working-tree index can be shared with snapshot slices in this invocation. Never expand
  // that cached object with managed drafts, or they would leak into the published Story catalog.
  const index = new RepositorySubjectIndex();
  for (const subject of working.list()) for (const location of subject.locations) {
    index.add({ ...subject, state: location.state, location });
  }
  index.unreadable.push(...working.unreadable);
  index.conflicts.push(...working.conflicts);
  const { listStoryWorktrees } = await import('./story-worktree.mjs');
  const worktrees = listStoryWorktrees(root).filter(entry => entry.branch && entry.head
    && path.resolve(entry.repositoryPath) !== path.resolve(root));
  if (!worktrees.length) return index;
  const owned = await buildRepositorySubjectIndexFromRefs(root, { definition,
    refs: worktrees.map(entry => ({ branch: entry.branch, ref: entry.head })) });
  for (const subject of owned.list('story')) {
    for (const location of subject.locations) {
      // A branch can contain inherited Story metadata. It is not that other Story's owner.
      if (!subject.branches.includes(location.branch)) continue;
      index.add({ ...subject, state: location.state, location: { ...location,
        source: 'managed-worktree' } });
    }
  }
  index.unreadable.push(...owned.unreadable);
  index.conflicts.push(...owned.conflicts);
  return index;
}
