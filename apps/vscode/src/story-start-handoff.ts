/** Advisory scheduling only: a start result is never a synthetic governed snapshot. */
import path from 'node:path';
import type { RepositorySnapshot } from './cli/snapshot.ts';
import { sameStoryAttachPath } from './story-attach.ts';

export const STORY_START_HANDOFF_MAX_AGE_MS = 120_000;
export const STORY_START_DISCOVERY_IDLE_MS = 5_000;
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface StoryStartHandoff {
  schemaVersion: 1;
  repositoryPath: string;
  storyId: string;
  branch: string;
  publicationCommit: string;
  configurationCommit: string;
  createdAt: string;
}

// One bounded machine-local record, not one permanent Memento key per temporary Story folder.
export const STORY_START_HANDOFF_KEY = 'singularityFlow.storyStartHandoff.v1';

export function storyStartHandoffFromResult(result: {
  shape: string; id: string; repositoryPath?: string;
  publication?: { pushed?: boolean; branch?: string; commit?: string };
  configuration?: { commit?: string } | null;
}, now = Date.now()): StoryStartHandoff | null {
  const publication = result.publication;
  if (result.shape !== 'story' || typeof result.repositoryPath !== 'string'
      || !result.repositoryPath || !path.isAbsolute(result.repositoryPath)
      || result.repositoryPath.length > 8192
      || typeof result.id !== 'string' || !result.id
      || result.id.length > 200 || /[\x00-\x1f\x7f]/.test(result.id)
      || publication?.pushed !== true || typeof publication.branch !== 'string' || !publication.branch
      || publication.branch.length > 250 || /[\x00-\x1f\x7f]/.test(publication.branch)
      || typeof publication.commit !== 'string' || typeof result.configuration?.commit !== 'string'
      || !oid.test(publication.commit ?? '') || !oid.test(result.configuration?.commit ?? '')
      || !Number.isFinite(now) || Math.abs(now) > 8.64e15) return null;
  return {
    schemaVersion: 1, repositoryPath: path.resolve(result.repositoryPath), storyId: result.id,
    branch: publication.branch, publicationCommit: publication.commit!,
    configurationCommit: result.configuration!.commit!, createdAt: new Date(now).toISOString()
  };
}

/** Exact locally confirmed identity fences a one-time deferral of optional remote inventory. */
export function storyStartHandoffMatches(
  value: unknown, repository: string, snapshot: RepositorySnapshot, now = Date.now()
): value is StoryStartHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hint = value as Partial<StoryStartHandoff>;
  if (hint.schemaVersion !== 1 || typeof hint.repositoryPath !== 'string'
      || !path.isAbsolute(hint.repositoryPath) || hint.repositoryPath.length > 8192
      || typeof hint.storyId !== 'string' || !hint.storyId || hint.storyId.length > 200
      || typeof hint.branch !== 'string' || !hint.branch || hint.branch.length > 250
      || typeof hint.createdAt !== 'string' || hint.createdAt.length > 32
      || typeof hint.publicationCommit !== 'string' || typeof hint.configurationCommit !== 'string'
      || !oid.test(hint.publicationCommit ?? '') || !oid.test(hint.configurationCommit ?? '')) return false;
  const age = now - Date.parse(hint.createdAt);
  const source = snapshot.workflow?.resolution?.configurationSource;
  const pin = source && typeof source === 'object'
    ? (source as { commit?: unknown }).commit : null;
  return Number.isFinite(age) && age >= 0 && age <= STORY_START_HANDOFF_MAX_AGE_MS
    && sameStoryAttachPath(hint.repositoryPath, repository)
    && Boolean(snapshot.repository?.root && sameStoryAttachPath(snapshot.repository.root, repository))
    && snapshot.revision?.head === hint.publicationCommit
    && snapshot.revision?.branch === hint.branch
    && snapshot.workflow?.workItem.id === hint.storyId
    && snapshot.workflow.workItem.branch === hint.branch
    && snapshot.selectedWorkId === hint.storyId
    && pin === hint.configurationCommit;
}
