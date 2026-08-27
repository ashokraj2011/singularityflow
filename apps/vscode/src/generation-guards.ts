import path from 'node:path';
import type { RepositorySnapshot, StoryWorkflow } from './cli/snapshot.ts';

export interface DirtyDocumentLike {
  isDirty?: boolean;
  uri?: { scheme?: string; fsPath?: string };
}

function inside(root: string, candidate: string): boolean {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** File-backed dirty buffers are newer than the bytes Git and the SFlow kernel can read. */
export function unsavedRepositoryPaths(
  documents: readonly DirtyDocumentLike[], repository: string
): string[] {
  return [...new Set(documents
    .filter((document) => document?.isDirty && document.uri?.scheme === 'file'
      && document.uri.fsPath && inside(repository, document.uri.fsPath))
    .map((document) => path.relative(repository, document.uri!.fsPath!).split(path.sep).join('/')))]
    .sort();
}

export interface StoryCheckoutIssue {
  code: 'repository-mismatch' | 'branch-mismatch';
  message: string;
  workId: string;
  currentRepository: string;
  currentBranch: string | null;
  allowedBranches: string[];
}

/**
 * Check the editor's live repository/branch against the Story bytes the current view rendered.
 * The engine remains authoritative and repeats its branch guard during publication; this host-side
 * check prevents a person from waiting through validation before learning the window is elsewhere.
 */
export function storyCheckoutIssue(
  repository: string,
  snapshot: RepositorySnapshot | null | undefined,
  workflow: StoryWorkflow | null | undefined = snapshot?.workflow
): StoryCheckoutIssue | null {
  if (!workflow?.workItem?.id) return null;
  const currentRepository = path.resolve(snapshot?.repository?.root ?? repository);
  const requestedRepository = path.resolve(repository);
  const currentBranch = snapshot?.repository?.branch ?? snapshot?.revision?.branch ?? null;
  const lineage = workflow.lineage as {
    canonicalBranch?: string;
    childBranches?: Array<{ name?: string }>;
  } | undefined;
  const allowedBranches = [...new Set([
    workflow.workItem.branch,
    lineage?.canonicalBranch,
    ...(lineage?.childBranches ?? []).map((entry) => entry.name)
  ].filter((value): value is string => Boolean(value)))].sort();
  const common = {
    workId: workflow.workItem.id,
    currentRepository,
    currentBranch,
    allowedBranches
  };
  if (currentRepository !== requestedRepository) {
    return {
      ...common,
      code: 'repository-mismatch',
      message: `This window is acting on ${requestedRepository}, but the Story view was read from ${currentRepository}.`
    };
  }
  if (!currentBranch || !allowedBranches.includes(currentBranch)) {
    return {
      ...common,
      code: 'branch-mismatch',
      message: `Branch '${currentBranch ?? 'detached HEAD'}' is not registered for Story '${workflow.workItem.id}'.`
    };
  }
  return null;
}
