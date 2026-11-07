/** Narrow native record observation. No submission, ledger, session or model invocation. */
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createEngine } from '../engine-sdk/index.mjs';
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
 * accepted yet, as nextsteps does. Null when nothing is retained; `unreadable` when the retained
 * record cannot be read.
 */
async function observeStoryPublication(root, selected) {
  const workItemRoot = path.dirname(path.dirname(selected.location.path));
  if (!await mayHoldPublicationRecords(root, [...new Set([workItemRoot, 'singularity/work-items'])]
    .map((directory) => path.join(root, directory, selected.id, 'publication-pending.json')))) return { value: null, error: null };
  const { readPendingPublication } = await import('../publication-pending.mjs');
  let pending;
  try {
    pending = await readPendingPublication(root, { kind: 'story', id: selected.id, migrate: false, roots: { workItemRoot } });
  } catch (error) {
    // A record that cannot be read is not "nothing pending": whether the last transition reached the
    // remote is unknown, and the diagnosis reads it without clearing or replacing it (A11).
    return { error, value: { state: 'unreadable', commit: null, code: String(error?.code ?? 'PUBLICATION_MARKER_UNREADABLE'),
      message: 'Its retained publication record cannot be read, so whether its last transition reached the remote is unknown. '
        + 'Diagnose it without clearing or replacing it.',
      nextAction: { command: 'singularity-flow doctor --json' } } };
  }
  return { error: null, value: pending ? { state: 'pending', commit: pending.record?.commit ?? null,
    message: 'Its last transition is committed on this computer only, and is not accepted until it reaches the remote.',
    nextAction: { command: 'singularity-flow sync', skill: '/sf-push' } } : null };
}

/** Compatibility readers keep the original native projection and failure classification. */
export async function retainedStoryPublication(root, selected) {
  return (await observeStoryPublication(root, selected)).value;
}

function failure(error, depth = 0) {
  if (error == null) return null;
  const value = { name: error.name ?? 'Error', message: error.message ?? String(error), code: error.code ?? null,
    details: error.details ?? null, cause: null };
  for (const key of ['errno', 'syscall', 'path', 'dest', 'exitCode', 'timeoutMs', 'signal']) if (error[key] != null) value[key] = error[key];
  if (error.cause != null) value.cause = depth < 8 ? failure(error.cause, depth + 1) : { truncated: true };
  return value;
}

/** Alias resolution and a caller's already-captured selection are trusted native composition only. */
export function createGitStoryStatusPort({ root, reference = null, initialSelection = null, onContext = () => {} }) {
  return {
    async load(inputs) {
      let selected = initialSelection;
      if (!selected) {
        const requested = reference ?? inputs.workId ?? await galStatusBranch(root);
        selected = resolveContext(await buildRepositorySubjectIndex(root), {
          reference: requested, kind: 'story', required: true
        });
      }
      const context = { root, selected, workflow: selected.state, subject: { kind: 'story', id: selected.id },
        source: { kind: selected.source, revision: selected.location.commit ?? null } };
      onContext(context);
      return context;
    },
    async read(context) {
      const publication = await observeStoryPublication(root, context.selected);
      context.publication = publication.value;
      context.publicationError = publication.error;
      return { workId: context.subject.id, source: context.source,
        publication: { state: publication.value?.state ?? 'not-retained', commit: publication.value?.commit ?? null,
          error: failure(publication.error) } };
    }
  };
}

/** Preserve the surrounding command/worker read scope and its registered one-spawn selectors. */
export function createGitStoryStatusEngine({ root, reference = null, initialSelection = null } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new SingularityFlowError(
    'Story status requires an explicit absolute checkout root.', { code: 'ENGINE_INPUT_INVALID' });
  let context = null;
  const port = createGitStoryStatusPort({ root, reference, initialSelection, onContext: value => { context = value; } });
  return Object.freeze({ engine: createEngine({ ports: { storyStatus: port } }), presentation: () => context });
}

/** Ordinary JSON compatibility only; readiness and human command rendering stay on the host. */
export async function readStatus(root, reference = null) {
  const binding = createGitStoryStatusEngine({ root, reference });
  await binding.engine.run('story.status', {});
  const { workflow, publication } = binding.presentation();
  return { ...workflow, authoringRoutes: workflowAuthoringRoutes(workflow),
    ...(publication ? { publicationPending: publication } : {}) };
}
