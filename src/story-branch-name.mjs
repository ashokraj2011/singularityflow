import { storyBranchNamePLACEHOLDER as PLACEHOLDER, assertStoryBranchNaming } from './kernel/configuration-declarations.mjs';
export { assertStoryBranchNaming } from './kernel/configuration-declarations.mjs';
/**
 * A Story's branch name.
 *
 * The work ID stays the Story's identity: its directory, ledger records and commit subjects. The
 * branch is chosen once, when the Story starts, and recorded in its state (`workItem.branch`);
 * nothing derives it from the ID afterwards. Teams name branches their own way
 * (`feature/ABC-123-short-title`, `bugfix/profile/fix-1`, ...), so:
 *
 * - a person may give any valid branch name (`--ref`);
 * - otherwise `git.branchNaming.pattern` in workflow.yml generates one from `{id}` and `{title}`;
 * - with no pattern the branch is the work ID, as it always was.
 *
 * A Story that already exists keeps its branch: only a new one is named from the pattern.
 */
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const STORY_BRANCH_DEFAULT_PATTERN = '{id}';
const TITLE_CHARACTERS = 40;
const CONFIGURATION_FILE = path.join('singularity', 'workflow.yml');

/** Lower-case words of the title joined by hyphens, cut at a word boundary. */
function titleSlug(title) {
  const words = String(title ?? '').normalize('NFKD').replace(/[̀-ͯ]/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (words.length <= TITLE_CHARACTERS) return words;
  const cut = words.slice(0, TITLE_CHARACTERS);
  const boundary = cut.lastIndexOf('-');
  return (boundary > TITLE_CHARACTERS / 2 ? cut.slice(0, boundary) : cut).replace(/-+$/u, '');
}

/**
 * The branch a pattern names for a Story. A title that is unknown when the Story starts (a Jira or
 * GitHub source fetched later) leaves `{title}` out together with one separator next to it.
 */
export function renderStoryBranchName(pattern, { id, title = null }) {
  let text = String(pattern || STORY_BRANCH_DEFAULT_PATTERN);
  const slug = titleSlug(title);
  if (!slug) text = text.replace(/([-_.])?\{title\}([-_.])?/gu, (_, before, after) => (before && after ? before : ''));
  return text.replace(PLACEHOLDER, (_, name) => (name === 'id' ? id : slug))
    .replace(/\/{2,}/gu, '/').replace(/^\/+|\/+$/gu, '');
}

/** The top of the checkout holding `cwd`, found without running Git. */
function checkoutTop(cwd) {
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    try { lstatSync(path.join(current, '.git')); return current; } catch { /* keep looking */ }
    if (path.dirname(current) === current) return null;
  }
}

/**
 * The launch checkout's configuration text: its working-tree workflow.yml, else the local copy of
 * the approved configuration branch. No configuration load and no network: this only names a
 * suggestion, which the person may replace with any branch.
 */
async function configurationText(root) {
  try {
    const file = path.join(root, CONFIGURATION_FILE);
    if (lstatSync(file).isFile()) return readFileSync(file, 'utf8');
  } catch { /* not in the working tree */ }
  const { fileAtRef } = await import('./git.mjs');
  return fileAtRef(root, 'refs/remotes/origin/sflow/config', CONFIGURATION_FILE.split(path.sep).join('/'));
}

/** The Story branch pattern and the settings needed to look up an existing Story, or null. */
async function namingConfiguration(root) {
  const text = await configurationText(root);
  // Most repositories declare no pattern: answer without parsing the configuration.
  if (!text || !/^\s+branchNaming\s*:/mu.test(text)) return null;
  const { default: YAML } = await import('yaml');
  let definition;
  try { definition = YAML.parse(text) ?? {}; } catch { return null; }
  const naming = definition.git?.branchNaming;
  try { assertStoryBranchNaming(naming); } catch { return null; } // configuration validation reports it
  if (!naming || naming.pattern === STORY_BRANCH_DEFAULT_PATTERN) return null;
  return { pattern: naming.pattern, definition };
}

/**
 * The branch that holds Story `workId`, without assuming it is named after the ID, or null:
 * 1. the current checkout, or a managed Story worktree, that holds the Story;
 * 2. a local branch named after the ID (Stories started before branch naming);
 * 3. the Flow Ledger state index, which records every published Story's branch (read offline).
 * Never a scan of application branches.
 */
export async function storyBranchForWorkId(root, definition, workId) {
  if (!root || !workId) return null;
  const { localStorySubjectIndex } = await import('./local-story-subject-index.mjs');
  const { resolveContext } = await import('./repository-subject-index.mjs');
  const local = resolveContext(await localStorySubjectIndex(root, { definition: definition ?? {}, reference: workId }),
    { reference: workId, kind: 'story', required: false });
  if (local?.canonicalBranch) return local.canonicalBranch;
  const { refExists } = await import('./git.mjs');
  if (refExists(root, `refs/heads/${workId}`)) return workId;
  try {
    const { ledgerStoryPointers } = await import('./ledger.mjs');
    const roster = await ledgerStoryPointers(root, definition?.ledger ?? {}, { offline: true });
    const pointer = roster.items.find((item) => item.id === workId);
    if (pointer?.branch) return pointer.branch;
  } catch { /* no readable state index here */ }
  return null;
}

/**
 * For a command that names a new Story's branch (start, story start, the intake preflight, story
 * prepare-worktree) and was given no `--ref`: the branch the configured pattern names, or the
 * branch the Story already has. Sets `options.ref` when it differs from the work ID. With no
 * pattern configured nothing is read and nothing changes.
 */
export async function applyStoryBranchNaming(workId, options, cwd = process.cwd()) {
  if (!workId || typeof options?.ref === 'string' && options.ref) return null;
  const root = checkoutTop(cwd);
  const naming = root ? await namingConfiguration(root) : null;
  if (!naming) return null;
  const existing = await storyBranchForWorkId(root, naming.definition, workId);
  const branch = existing ?? renderStoryBranchName(naming.pattern, {
    id: workId, title: typeof options.title === 'string' ? options.title : null
  });
  if (branch !== workId) options.ref = branch;
  return { branch, existing: Boolean(existing), pattern: naming.pattern };
}

/**
 * Check out the branch holding Story `workId` for a command that takes a work ID. On that branch
 * already (and no --fetch), nothing is read. Returns the branch.
 */
export async function checkoutStoryBranch(root, config, workId, { fetch = false } = {}) {
  const { branch, checkout } = await import('./git.mjs');
  if (workId === branch(root) && !fetch) return workId;
  const storyBranch = await storyBranchForWorkId(root, config, workId) ?? workId;
  if (storyBranch !== branch(root) || fetch) {
    await checkout(root, storyBranch, {
      base: config.defaultBaseBranch, fetch, existingOnly: true, remote: config.git?.remote ?? 'origin'
    });
  }
  return storyBranch;
}

/**
 * The Story whose own branch (or one of its child branches) `branchName` is, from this checkout and
 * its managed Story worktrees, or null. For commands run on a Story branch without a work ID.
 */
export async function workIdForBranch(root, definition, branchName) {
  if (!root || !branchName) return null;
  const { localStorySubjectIndex } = await import('./local-story-subject-index.mjs');
  const { resolveContext } = await import('./repository-subject-index.mjs');
  try {
    const found = resolveContext(await localStorySubjectIndex(root, { definition: definition ?? {}, reference: branchName }),
      { reference: branchName, kind: 'story', required: false });
    return found && (found.canonicalBranch === branchName || found.branches?.includes(branchName)) ? found.id : null;
  } catch { return null; }
}
