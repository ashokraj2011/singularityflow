/** Ordinary status reads have no submission, ledger or human-renderer imports. */
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { workflowAuthoringRoutes } from '../code-delivery-policy.mjs';
import { executeGitQuery } from '../git-query.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { SingularityFlowError } from '../util.mjs';
export async function galStatusBranchCandidate(root, options = {}) {
  return executeGitQuery(root, 'repository.branch', {}, options);
}

export async function galStatusBranch(root, options = {}) {
  const current = await galStatusBranchCandidate(root, options);
  if (!current) throw new SingularityFlowError('Detached HEAD is not supported.');
  return current;
}

/** Resolve the status repository through the same selector-safe registered boundary. */
export function galStatusRepositoryRoot(cwd = process.cwd(), options = {}) {
  const root = executeGitQuery(cwd, 'repository.root', {}, options);
  if (!root) {
    throw new SingularityFlowError('Run Singularity Flow from inside a Git repository.');
  }
  return root;
}

/** Complete repository/branch selection used by the status command. */
export async function galStatusSelection(cwd = process.cwd(), options = {}) {
  const root = galStatusRepositoryRoot(cwd, options);
  return Object.freeze({ root, branch: await galStatusBranch(root, options) });
}

// Where the publication reader looks for a retained transition (src/publication-pending.mjs,
// src/publication-storage.mjs): the common Git directory and every worktree's private one.
const RECORD_DIRECTORIES = Object.freeze(['pending-publication', 'publication-journal']);
const absent = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

/**
 * Whether any publication record could be in this checkout's Git directories or the Story's legacy
 * file. The reader is a large module graph, so an ordinary status asks this first; read without Git,
 * and any doubt is a yes.
 */
async function mayHoldPublicationRecords(root, legacyFiles) {
  try {
    const dotGit = path.join(root, '.git');
    const gitDir = (await lstat(dotGit)).isDirectory() ? dotGit
      : path.resolve(root, /^gitdir:[ \t]*(.+?)[ \t]*$/mu.exec(await readFile(dotGit, 'utf8'))[1]);
    const common = path.resolve(gitDir, (await readFile(path.join(gitDir, 'commondir'), 'utf8')
      .catch((error) => (absent(error) ? '.' : Promise.reject(error)))).trim());
    const worktrees = await readdir(path.join(common, 'worktrees')).catch((error) => (absent(error) ? [] : Promise.reject(error)));
    const stores = [common, gitDir, ...worktrees.map((name) => path.join(common, 'worktrees', name))];
    const found = await Promise.all([
      ...stores.flatMap((store) => RECORD_DIRECTORIES.map((name) => readdir(path.join(store, 'singularity-flow', name))
        .then((names) => names.length > 0, (error) => !absent(error)))),
      ...legacyFiles.map((file) => lstat(file).then(() => true, (error) => !absent(error)))
    ]);
    return found.some(Boolean);
  } catch { return true; }
}

/**
 * A lifecycle commit kept on this computer because its push did not land (SDA-AC-007): status
 * prints the local record as it is, so it says beside it that the record's last transition is not
 * accepted yet, as nextsteps does. Null when nothing is retained.
 */
export async function retainedStoryPublication(root, selected) {
  const workItemRoot = path.dirname(path.dirname(selected.location.path));
  if (!await mayHoldPublicationRecords(root, [...new Set([workItemRoot, 'singularity/work-items'])]
    .map((directory) => path.join(root, directory, selected.id, 'publication-pending.json')))) return null;
  const { readPendingPublication } = await import('../publication-pending.mjs');
  const pending = await readPendingPublication(root, { kind: 'story', id: selected.id, migrate: false,
    roots: { workItemRoot } }).catch(() => null);
  return pending ? { commit: pending.record?.commit ?? null,
    message: 'Its last transition is committed on this computer only, and is not accepted until it reaches the remote.',
    nextAction: { command: 'singularity-flow sync', skill: '/sf-push' } } : null;
}

/** Ordinary JSON status only; submission readiness and author/reviewer packets stay on the CLI. */
export async function readStatus(root, workId = null) {
  const reference = workId ?? await galStatusBranch(root);
  const selected = resolveContext(await buildRepositorySubjectIndex(root), {
    reference, kind: 'story', required: true
  });
  const retained = await retainedStoryPublication(root, selected);
  return { ...selected.state, authoringRoutes: workflowAuthoringRoutes(selected.state),
    ...(retained ? { publicationPending: retained } : {}) };
}
