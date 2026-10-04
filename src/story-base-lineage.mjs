/**
 * A Story cut from another Story's branch: which Story that is, what the new one inherits, and
 * where its pull request goes while that Story is still open.
 *
 * The link is found once, when the new Story starts, from the exact commit it was cut from. A
 * branch's own Story is the one whose workflow at that commit claims the branch: as its canonical
 * branch, its work branch or a registered child branch. Merged Stories also leave their workflows
 * in a branch's tree, so claiming the branch, not being present, is what counts. Candidates are the
 * branch name and the Story IDs in the subjects of the branch's recent first-parent commits, so a
 * Story on any branch name is found without reading every Story merged into its history.
 *
 * Finding the link is advisory: a commit or workflow that cannot be read means no link, never a
 * refused start.
 */
import { committedFilesAtRevisions, exactFileAtObject, isAncestor, recentFirstParentSubjects, refCommit } from './git.mjs';
import { readRecord } from './schema-migrations.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** Singularity Flow commit subjects begin `[<Work ID>][<step>]`. */
const SUBJECT_ID = /^\[([A-Za-z0-9][A-Za-z0-9._-]{0,127})\]\[/u;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const MAXIMUM_CANDIDATES = 8;
const MAXIMUM_ANCESTORS = 16;
const SUBJECTS_READ = 100;
const WORKFLOW_BYTES = 8 * 1024 * 1024;
/** How many branches the intake list checks for their own Story, at most. */
const MAXIMUM_LABELLED_BRANCHES = 64;

function workItemRootOf(config) {
  return String(config?.workItemRoot ?? 'singularity/work-items').replace(/\/+$/u, '') || 'singularity/work-items';
}

/** The Story IDs worth reading for a base branch, most likely first. */
export function baseStoryCandidates(baseBranch, subjects = [], { exclude = null } = {}) {
  const ids = [];
  const add = (id) => {
    if (ids.length < MAXIMUM_CANDIDATES && SAFE_ID.test(id ?? '') && id !== exclude && !ids.includes(id)) ids.push(id);
  };
  add(baseBranch);
  for (const subject of subjects) add(SUBJECT_ID.exec(String(subject ?? ''))?.[1]);
  return ids;
}

/** Whether a Story's workflow claims `branch` as its own. */
export function storyClaimsBranch(workflow, branch) {
  if (typeof branch !== 'string' || !branch) return false;
  return [
    workflow?.lineage?.canonicalBranch,
    workflow?.workItem?.branch,
    ...(workflow?.lineage?.childBranches ?? []).map((entry) => entry?.name)
  ].includes(branch);
}

/** What a new Story records about the Story it was cut from. */
export function baseStoryRecord(parent, { branch, commit }) {
  const grandparent = parent?.lineage?.baseStory ?? null;
  const ancestors = [...new Set([grandparent?.workId, ...(grandparent?.ancestors ?? [])]
    .filter((id) => SAFE_ID.test(id ?? '')))].slice(0, MAXIMUM_ANCESTORS);
  return {
    workId: parent.workItem.id,
    title: parent.workItem.title ?? parent.workItem.id,
    branch,
    commit,
    // Where that Story itself lands: this Story's pull request goes there once it has.
    baseBranch: parent.workItem.baseBranch ?? null,
    epicId: parent.lineage?.epicId ?? null,
    ancestors
  };
}

/** Record the base Story on a new Story's lineage, and take its Epic when the new one has none. */
export function inheritFromBaseStory(lineage, baseStory) {
  if (!lineage || !baseStory?.workId) return lineage;
  lineage.baseStory = structuredClone(baseStory);
  if (!lineage.epicId && baseStory.epicId) {
    lineage.epicId = baseStory.epicId;
    lineage.epicInheritedFrom = baseStory.workId;
  }
  return lineage;
}

function parsedWorkflow(bytes) {
  try { return readRecord('story-workflow', bytes).record; } catch { return null; }
}

/**
 * The Story whose branch `baseBranch` is, read at `baseCommit`, as the record a new Story keeps;
 * null when the branch is no Story's or nothing can be read.
 */
export function detectBaseStory(root, config, { baseBranch, baseCommit, workId = null } = {}) {
  try {
    if (typeof baseBranch !== 'string' || !baseBranch || !COMMIT.test(String(baseCommit ?? ''))) return null;
    const workItemRoot = workItemRootOf(config);
    const subjects = recentFirstParentSubjects(root, baseCommit, { limit: SUBJECTS_READ });
    for (const id of baseStoryCandidates(baseBranch, subjects, { exclude: workId })) {
      const bytes = exactFileAtObject(root, baseCommit, `${workItemRoot}/${id}/workflow.json`, { maximumBytes: WORKFLOW_BYTES });
      const parent = bytes ? parsedWorkflow(bytes) : null;
      if (parent?.workItem?.id === id && storyClaimsBranch(parent, baseBranch)) {
        return baseStoryRecord(parent, { branch: baseBranch, commit: baseCommit });
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The intake list's label for each branch that is a Story's own branch, named after its Work ID,
 * read from this clone's remote-tracking refs: `{ branch: { workId, title, epicId } }`. A Story on
 * a custom branch name is not labelled here; start still finds it.
 */
export function storyBranchLabels(root, config, branches, { remote = 'origin' } = {}) {
  try {
    const workItemRoot = workItemRootOf(config);
    const candidates = [...new Set(branches)].filter((branch) => SAFE_ID.test(branch ?? '')).slice(0, MAXIMUM_LABELLED_BRANCHES);
    const files = committedFilesAtRevisions(root, candidates.map((branch) => ({
      key: branch, ref: `refs/remotes/${remote}/${branch}`, path: `${workItemRoot}/${branch}/workflow.json`
    })), { maximumObjectBytes: WORKFLOW_BYTES });
    const labels = {};
    for (const [branch, bytes] of files) {
      const story = parsedWorkflow(bytes);
      if (story?.workItem?.id !== branch || !storyClaimsBranch(story, branch)) continue;
      labels[branch] = {
        workId: story.workItem.id,
        title: story.workItem.title ?? story.workItem.id,
        epicId: story.lineage?.epicId ?? null
      };
    }
    return labels;
  } catch {
    return {};
  }
}

/**
 * Where a Story built on another Story sends its pull request: that Story's branch while it is
 * open; that Story's own base once it has landed there or its branch is gone from the remote.
 * Read from this clone's remote-tracking refs. Null when the Story was not built on a Story.
 */
export function baseStoryPullRequestTarget(root, workflow, { remote = 'origin' } = {}) {
  const parent = workflow?.lineage?.baseStory;
  if (!parent?.branch) return null;
  const landing = parent.baseBranch;
  const base = { workId: parent.workId, branch: parent.branch, landing: landing ?? null };
  if (!landing || landing === parent.branch) return { ...base, base: parent.branch, state: 'open' };
  try {
    const parentTip = refCommit(root, `refs/remotes/${remote}/${parent.branch}`);
    if (!parentTip) return { ...base, base: landing, state: 'gone' };
    const landingRef = `refs/remotes/${remote}/${landing}`;
    if (refCommit(root, landingRef) && isAncestor(root, parentTip, landingRef)) return { ...base, base: landing, state: 'landed' };
    return { ...base, base: parent.branch, state: 'open' };
  } catch {
    // Unreadable refs change nothing: the branch it was cut from stays the target.
    return { ...base, base: parent.branch, state: 'unknown' };
  }
}

/** One line for a person about the Story this one is built on, or null. */
export function baseStoryLine(workflow) {
  const parent = workflow?.lineage?.baseStory;
  if (!parent?.workId) return null;
  const at = parent.commit ? ` at ${String(parent.commit).slice(0, 8)}` : '';
  return `${parent.workId} — ${parent.title ?? parent.workId} (branch ${parent.branch}${at})`;
}

/** The status lines for a Story's base Story and Epic, in the order a summary prints them. */
export function storyLineageLines(workflow) {
  const lines = [];
  const builtOn = baseStoryLine(workflow);
  if (builtOn) lines.push(`Built on: ${builtOn}`);
  const epicId = workflow?.lineage?.epicId;
  if (epicId) {
    const inherited = workflow.lineage.epicInheritedFrom;
    lines.push(`Epic: ${epicId}${inherited ? ` (inherited from ${inherited})` : ''}`);
  }
  return lines;
}
