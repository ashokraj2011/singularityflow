/** Read-only, bounded remote Story discovery across materialized workspace repositories. */
import path from 'node:path';
import type { WorkspaceStoryCatalogRow } from './views/inbox-model.ts';

export interface StoryRepository {
  id: string;
  absolutePath: string;
  state: string;
  url?: string | null;
  configurationUrl?: string | null;
}

export interface StoryDiscoveryIssue {
  repositoryId: string;
  message: string;
}

export interface StoryDiscoveryResult {
  stories: WorkspaceStoryCatalogRow[];
  issues: StoryDiscoveryIssue[];
}

/** Coalesce duplicate reads, but schedule a new read after a changed workspace membership. */
export class StoryRefreshGate {
  private active: { epoch: number; promise: Promise<void> } | null = null;

  run(epoch: number, read: () => Promise<void>, afterCurrent = false): Promise<void> {
    if (this.active?.epoch === epoch) {
      const previous = this.active.promise;
      return afterCurrent
        ? previous.then(() => {}, () => {}).then(() => this.run(epoch, read))
        : previous;
    }
    const promise = Promise.resolve().then(read);
    this.active = { epoch, promise };
    void promise.finally(() => {
      if (this.active?.promise === promise) this.active = null;
    }).catch(() => {});
    return promise;
  }
}

interface CandidateResponse {
  items?: Array<{
    id?: string;
    title?: string;
    status?: string;
    phase?: string | null;
    branch?: string | null;
  }>;
  unavailableCount?: number;
}

/**
 * The caller owns the Git fetch for each repository. Never interpret an inaccessible or
 * unmaterialized repository as an empty Story list. One failed repository does not hide the
 * valid Stories returned by the others, and the issue list makes partial coverage explicit.
 */
export async function discoverWorkspaceStoryRows(
  repositories: readonly StoryRepository[],
  readCandidates: (repository: StoryRepository) => Promise<CandidateResponse>,
  maximumConcurrent = 3
): Promise<StoryDiscoveryResult> {
  const unique = new Map<string, StoryRepository>();
  const issues: StoryDiscoveryIssue[] = [];
  for (const repository of repositories) {
    if (!repository.id || (!repository.absolutePath && !repository.url)) {
      issues.push({
        repositoryId: repository.id || 'unknown',
        message: 'Workspace repository has no stable ID, local path, or remote URL; repair its workspace inventory before refreshing Stories.'
      });
      continue;
    }
    const localPath = repository.absolutePath ? path.resolve(repository.absolutePath) : '';
    const key = localPath || `remote:${repository.url}`;
    if (!unique.has(key)) unique.set(key, { ...repository, absolutePath: localPath });
  }
  const selected = [...unique.values()];
  const stories: WorkspaceStoryCatalogRow[] = [];
  const workers = Math.max(1, Math.min(3, Math.floor(maximumConcurrent) || 1));
  for (let offset = 0; offset < selected.length; offset += workers) {
    await Promise.all(selected.slice(offset, offset + workers).map(async (repository) => {
      if (repository.state !== 'ready' && !repository.url) {
        issues.push({
          repositoryId: repository.id,
          message: `Repository '${repository.id}' is ${repository.state} and has no registered remote URL; materialize or repair it to discover its Stories.`
        });
        return;
      }
      try {
        const response = await readCandidates(repository);
        if (!Array.isArray(response?.items)) throw new Error('Story discovery returned no candidate list.');
        for (const candidate of response.items) {
          if (!candidate || typeof candidate.id !== 'string' || !candidate.id.trim()) continue;
          stories.push({
            repositoryId: repository.id,
            repositoryPath: repository.state === 'ready' ? repository.absolutePath : '',
            repositoryUrl: repository.url ?? null,
            id: candidate.id,
            title: candidate.title || candidate.id,
            status: candidate.status || 'unknown',
            currentPhase: candidate.phase ?? null,
            branch: candidate.branch ?? null
          });
        }
        if ((response.unavailableCount ?? 0) > 0) issues.push({
          repositoryId: repository.id,
          message: `${response.unavailableCount} Story branch${response.unavailableCount === 1 ? ' is' : 'es are'} unreadable in '${repository.id}'. Inspect its Story discovery diagnostics.`
        });
      } catch (error) {
        issues.push({ repositoryId: repository.id, message: (error as Error).message });
      }
    }));
  }
  stories.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)
    || left.id.localeCompare(right.id));
  issues.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  return { stories, issues };
}
