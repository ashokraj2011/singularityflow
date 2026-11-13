/**
 * Which Story a session opens, when the checkout already says [owner, 2026-11-13].
 *
 * `/sf-session` asked "Which exact Story ID should I open?" from a checkout whose branch only one Story records:
 * the answer was in Git. So `session open` without a Work ID opens that Story itself when exactly one Story
 * records the branch checked out where the session runs (its own Story worktree, or the active workspace's
 * repository), and records it as settled with that evidence; the decisions card lists it with an undo. Explicit
 * selectors, a checkout on no Story branch, two different Stories, or a person's earlier undo of the same
 * selection: the roster is shown and the person chooses, as before. Loaded only by `session open`.
 */
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const DEPTH = 40;

/** The folder holding `.git` at or above `start`, or null. */
async function checkoutRoot(start) {
  let folder = path.resolve(start);
  for (let depth = 0; depth < DEPTH; depth += 1) {
    if (await lstat(path.join(folder, '.git')).then(() => true, () => false)) return folder;
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}

const subjectOf = (found) => `${found.workId} on ${found.branch}`;

/**
 * The one Story the session's checkouts belong to, with its evidence, or null when the person must choose.
 * `places` are the folders the session runs in; each is read from its files alone (story-index.mjs storyInCheckout).
 */
export async function settledStorySelection(places) {
  const { storyInCheckout } = await import('./story-index.mjs');
  const found = [];
  for (const place of [...new Set(places.filter(Boolean).map((entry) => path.resolve(entry)))]) {
    const root = await checkoutRoot(place);
    const story = root ? await storyInCheckout(root).catch(() => null) : null;
    if (story) found.push({ ...story, checkout: root });
  }
  const stories = [...new Set(found.map((entry) => entry.workId))];
  if (stories.length !== 1) return null;
  const [story] = found;
  // A person who undid this selection chooses it themselves from now on (settled-decisions.mjs).
  const { settlementState } = await import('./settled-decisions.mjs');
  const state = await readFile(path.join(story.checkout, ...story.workflowPath.split('/')), 'utf8').then(JSON.parse, () => null);
  if (settlementState(state, 'story-selection', subjectOf(story)) === 'undone') return null;
  return {
    workId: story.workId, branch: story.branch, storyStatus: story.storyStatus, subject: subjectOf(story),
    answer: `Opened ${story.workId}: the only Story whose branch, ${story.branch}, is checked out where this session runs.`,
    evidence: [
      { what: `${story.branch} is ${story.workId}'s own branch, recorded in its Story record`, where: `${story.workflowPath} on ${story.branch}` },
      { what: 'no other Story records a branch checked out where this session runs', where: 'the session\'s checkout' }
    ]
  };
}

/**
 * Record the selection in the Story `session open` opened, once; a closed Story, or a commit that cannot be made
 * now, records nothing and the Story stays open (`recorded: false`).
 */
export async function recordStorySelection(checkout, selection) {
  try {
    const [{ loadAcceptedStoryExecution }, { commitSettledDecision }, { actionActor }] = await Promise.all([
      import('./accepted-story-execution.mjs'), import('./settled-decisions.mjs'), import('./git.mjs')]);
    const accepted = await loadAcceptedStoryExecution(checkout, selection.workId);
    if (accepted.workflow.status !== 'in_progress') return { recorded: false, reason: `the Story is ${accepted.workflow.status}` };
    const { record, reused } = await commitSettledDecision(checkout, accepted.definition, accepted.workflow, {
      kind: 'story-selection', by: 'sflow', subject: selection.subject, answer: selection.answer, evidence: selection.evidence,
      effect: { workId: selection.workId, branch: selection.branch }
    }, { actor: actionActor(checkout) });
    return { recorded: true, id: record.id, reused };
  } catch (error) {
    return { recorded: false, reason: error?.code ?? 'not-recorded' };
  }
}
