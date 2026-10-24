/**
 * `compare`: two exactly-resolved sides, never a guess about either. `[INT:REQ-082]` `[INT:CON-081]`
 *
 * A comparison is only as good as its two endpoints, so both are resolved to an exact commit before
 * anything is read, and a side that does not resolve is a refusal naming that side — not a diff
 * against whatever `HEAD` happened to be. `branch`, `release`, `commit` and `worktree` are typed
 * Git reads over the registered repository. The other subject kinds a comparison may name (builds,
 * artifacts, generations, plans, provider observations) need evidence sources this planner does not
 * read, and they say so by name rather than returning an empty diff that looks like "no change".
 *
 * Read-only throughout `[INT:CON-083]`: no checkout, no index write, no fetch. A branch that exists
 * only on a remote this clone has never fetched does not resolve, and the refusal says so.
 */
import {
  typedAheadBehind, typedChangedPaths, typedMergeBase, typedRevision, typedVersionCommit
} from '../../git-access.mjs';
import { isGitRefName, SingularityFlowError } from '../../util.mjs';
import { subjectWith } from '../handles.mjs';
import { noEffects, plannerNavigation, preservedAll, repositoryReference, sflowResult } from '../result.mjs';

/** The comparison kinds this planner answers from Git. The rest of `COMPARISON_SUBJECTS` refuse. */
export const GIT_COMPARISONS = Object.freeze(['commit', 'branch', 'release', 'worktree']);

const MAX_PATHS = 200;

function refusal(code, slots, restState = 'blocked', source = 'deterministic') {
  return sflowResult({
    kind: 'refusal',
    operation: { id: 'compare', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots },
    effects: noEffects(),
    why: [{ code, source, slots }],
    preserved: preservedAll('compare.nothing-was-carried-out'),
    restState
  });
}

/** One side, resolved exactly for its declared kind, or null. */
export function resolveComparisonSide(root, subjectKind, value) {
  const name = String(value ?? '');
  if (subjectKind === 'commit') {
    return /^[0-9a-f]{7,64}$/iu.test(name) ? typedRevision(root, name) : null;
  }
  if (subjectKind === 'branch') {
    if (!isGitRefName(name)) return null;
    return typedRevision(root, `refs/heads/${name}`) ?? typedRevision(root, `refs/remotes/${name}`);
  }
  if (subjectKind === 'release') return typedVersionCommit(root, name)?.commit ?? null;
  return typedRevision(root, name);
}

export function compareResult({ subjectKind, left, right, mergeBase, counts, changed, repositoryId, subject = null }) {
  const range = `${left.commit}..${right.commit ?? 'worktree'}`;
  return sflowResult({
    kind: 'read',
    operation: { id: 'compare', classification: 'read' },
    subject: subjectWith(subject, { kind: 'repository', id: repositoryId }),
    outcome: {
      status: 'succeeded', messageId: 'gateway.read',
      slots: { subjectKind, paths: String(changed.total), leftOnly: String(counts.leftOnly), rightOnly: String(counts.rightOnly) }
    },
    effects: noEffects(),
    why: [{
      code: 'compare.exact-revisions', source: 'deterministic', reference: range,
      slots: { left: left.value, right: right.value, paths: String(changed.total) }
    }],
    warnings: [
      ...(changed.truncated ? [{
        code: 'compare.paths-truncated', source: 'deterministic', slots: { shown: String(changed.entries.length), total: String(changed.total) }
      }] : []),
      // A working-tree comparison reads tracked files; an untracked file is not in either side.
      ...(right.worktree ? [{ code: 'compare.untracked-not-compared', source: 'deterministic', slots: {} }] : [])
    ],
    preserved: preservedAll('compare.nothing-was-carried-out', { reference: range }),
    next: right.commit ? [plannerNavigation({
      handle: `compare:impact:${range}`,
      id: 'compare:impact',
      label: 'Run a quick impact analysis on this range',
      rank: 0,
      kind: 'read',
      reasonCode: 'compare.impact-of-this-range',
      confirmation: 'none',
      interaction: 'navigation',
      executable: false,
      fallback: { label: 'Impact in the terminal', command: 'sflow explain impact' }
    }, 'impact.quick', { baseRef: left.commit, targetRef: right.commit })] : [],
    restState: right.commit ? null : 'informational',
    data: {
      subjectKind,
      left,
      right,
      mergeBase,
      counts,
      changed,
      // `[INT:REQ-082]`: which of the trees a reader might mean this was actually computed from.
      sides: { left: 'commit', right: right.worktree ? 'working-tree-tracked-files' : 'commit' },
      bounds: { maximumPaths: MAX_PATHS, patchesIncluded: false }
    }
  });
}

export async function comparePlanner({ arguments: args = {}, subject = null, root = null, context = {} } = {}) {
  if (!root) throw new SingularityFlowError('compare requires the repository root it should read.', { code: 'COMPARE_NO_ROOT' });
  const subjectKind = args.subjectKind;
  if (!GIT_COMPARISONS.includes(subjectKind)) {
    // Declared and typed, but this build has no evidence source for it. Absent, not forbidden.
    return refusal('compare.subject-unavailable', { subjectKind }, 'unavailable', 'unavailable');
  }
  if (subjectKind === 'worktree' && args.right !== 'worktree') {
    return refusal('compare.side-unresolved', { side: 'right', value: String(args.right) });
  }
  const leftCommit = resolveComparisonSide(root, subjectKind === 'worktree' ? 'commit-ish' : subjectKind, args.left);
  if (!leftCommit) return refusal('compare.side-unresolved', { side: 'left', value: String(args.left) });
  const rightCommit = subjectKind === 'worktree' ? null : resolveComparisonSide(root, subjectKind, args.right);
  if (subjectKind !== 'worktree' && !rightCommit) {
    return refusal('compare.side-unresolved', { side: 'right', value: String(args.right) });
  }
  const left = { value: String(args.left), commit: leftCommit };
  const right = { value: String(args.right), commit: rightCommit, worktree: subjectKind === 'worktree' };
  return compareResult({
    subjectKind,
    left,
    right,
    mergeBase: rightCommit ? typedMergeBase(root, leftCommit, rightCommit) : null,
    counts: rightCommit ? typedAheadBehind(root, leftCommit, rightCommit) : { leftOnly: 0, rightOnly: 0 },
    changed: typedChangedPaths(root, leftCommit, rightCommit, { max: MAX_PATHS }),
    repositoryId: context.repositoryId ?? context.repository?.id ?? repositoryReference(root),
    subject
  });
}
