import path from 'node:path';
import type { InboxRepositoryBinding, WorkspaceStoryCatalogRow } from './views/inbox-model.ts';
import type { WorkspaceStatus } from './views/workspaces-model.ts';

export interface StoryAttachSelection {
  workId: string;
  repositoryId: string;
}

interface ActiveWorkspaceSelection {
  active?: boolean;
  workspaceId?: string;
  workspacePath?: string;
  repositoryId?: string;
  repositoryPath?: string;
  canonicalRepositoryPath?: string;
  selectionStatus?: string;
}

export function sameStoryAttachPath(left: string, right: string): boolean {
  const canonical = (value: string) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase() : path.resolve(value);
  return canonical(left) === canonical(right);
}

/** Only a selected, ready workspace member sharing Git metadata may identify a snapshot. */
export function verifiedInboxRepositoryBinding(
  current: ActiveWorkspaceSelection,
  status: WorkspaceStatus,
  checkoutPath: string,
  commonDirectories?: { checkout: string; mapped: string }
): InboxRepositoryBinding | null {
  if (!checkoutPath || !current.active || !current.workspaceId || !current.workspacePath
    || current.workspaceId !== status.workspace.id
    || !sameStoryAttachPath(current.workspacePath, status.workspace.path)
    || !current.repositoryId || !current.repositoryPath
    || !sameStoryAttachPath(current.repositoryPath, checkoutPath)
    || (current.selectionStatus && current.selectionStatus !== 'ready')) return null;
  const members = status.repositories.filter((entry) => entry.id === current.repositoryId);
  const member = members[0];
  if (members.length !== 1 || !member?.absolutePath || member.state !== 'ready'
    || (current.canonicalRepositoryPath
      && !sameStoryAttachPath(current.canonicalRepositoryPath, member.absolutePath))) return null;
  if (!sameStoryAttachPath(checkoutPath, member.absolutePath)
    && (!commonDirectories?.checkout || !commonDirectories.mapped
      || !sameStoryAttachPath(commonDirectories.checkout, commonDirectories.mapped))) return null;
  return { checkoutPath, repositoryPath: member.absolutePath, repositoryId: member.id };
}

/** Resolve a click against the extension's last verified catalog, never a webview-supplied path. */
export function selectedCatalogStory(
  catalog: readonly WorkspaceStoryCatalogRow[], selection: StoryAttachSelection
): WorkspaceStoryCatalogRow {
  const matches = catalog.filter((row) => row.id === selection.workId
    && row.repositoryId === selection.repositoryId);
  const first = matches[0];
  if (!first) throw new Error(
    `Story '${selection.workId}' is no longer listed for repository '${selection.repositoryId}'. Refresh Stories and select it again.`
  );
  if (matches.some((row) => row.repositoryPath !== first.repositoryPath
    || row.repositoryUrl !== first.repositoryUrl || row.branch !== first.branch)) {
    throw new Error(
      `Story '${selection.workId}' has conflicting repository records. Refresh Stories before attaching it.`
    );
  }
  return first;
}

/** A Story may attach only through the exact repository still recorded in the active workspace. */
export function verifiedWorkspaceStoryRepository(
  story: WorkspaceStoryCatalogRow,
  current: ActiveWorkspaceSelection,
  status: WorkspaceStatus
): { workspacePath: string; repositoryId: string; repositoryPath: string } {
  if (!story.repositoryPath && !story.repositoryUrl) {
    throw new Error('This Story has no mapped repository path or URL. Refresh Stories and try again.');
  }
  if (!current.active || !current.workspaceId || !current.workspacePath
    || current.workspaceId !== status.workspace.id
    || !sameStoryAttachPath(current.workspacePath, status.workspace.path)) {
    throw new Error('The selected workspace changed after Story discovery. Select it again, refresh Stories, and retry.');
  }
  const repository = status.repositories.find((entry) => entry.id === story.repositoryId);
  if (!repository || (story.repositoryUrl && repository.url !== story.repositoryUrl)) {
    throw new Error(
      `Repository '${story.repositoryId}' no longer matches the mapping used to discover this Story. Refresh Stories before attaching.`
    );
  }
  if (!repository.absolutePath) {
    throw new Error(`Repository '${story.repositoryId}' has no workspace checkout path. Repair its workspace inventory before attaching.`);
  }
  if (story.repositoryPath && !sameStoryAttachPath(story.repositoryPath, repository.absolutePath)) {
    throw new Error(`Repository '${story.repositoryId}' moved since Story discovery. Refresh Stories before attaching.`);
  }
  if (story.repositoryPath && repository.state !== 'ready') {
    throw new Error(`Repository '${story.repositoryId}' is no longer ready. Refresh Stories before attaching.`);
  }
  if (!['missing', 'empty', 'ready'].includes(repository.state ?? '')) {
    throw new Error(
      `Repository '${story.repositoryId}' is ${repository.state ?? 'unavailable'}; inspect Workspace details before attaching. No clone was started.`
    );
  }
  return {
    workspacePath: status.workspace.path,
    repositoryId: story.repositoryId,
    repositoryPath: repository.absolutePath
  };
}
