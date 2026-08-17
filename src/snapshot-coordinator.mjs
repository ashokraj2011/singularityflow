import { createHash } from 'node:crypto';
import { TimingCollector } from './dx-timings.mjs';
import { SingularityFlowError, run } from './util.mjs';
import { worktreeFingerprint } from './worktree-fingerprint.mjs';

function parseStatus(value) {
  const tokens = value.split('\0').filter(Boolean);
  const changedFiles = [];
  const untrackedFiles = [];
  let branchName = null;
  let commit = null;
  for (const token of tokens) {
    if (token.startsWith('# branch.head ')) branchName = token.slice('# branch.head '.length).trim();
    else if (token.startsWith('# branch.oid ')) commit = token.slice('# branch.oid '.length).trim();
    else if (token.startsWith('? ')) {
      const file = token.slice(2);
      changedFiles.push(file);
      untrackedFiles.push(file);
    } else if (/^[12u] /.test(token)) {
      const fieldsBeforePath = token[0] === '2' ? 9 : 8;
      const file = token.split(' ').slice(fieldsBeforePath).join(' ');
      if (file) changedFiles.push(file);
    }
  }
  return { branchName, commit, changedFiles: [...new Set(changedFiles)].sort(), untrackedFiles: untrackedFiles.sort() };
}

async function worktreeRevision(root) {
  // Porcelain v2 carries the branch, HEAD, and changed-path catalog in one process. The shared Git
  // tree fingerprint supplies the exact bytes and modes; every surface now means the same thing
  // when it calls a value `worktreeHash`.
  const status = run('git', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: root });
  const parsed = parseStatus(status.stdout);
  const fingerprint = worktreeFingerprint(root);
  return {
    branch: parsed.branchName,
    head: parsed.commit,
    worktreeHash: fingerprint.sha256,
    changedFiles: parsed.changedFiles
  };
}

function sameRevision(left, right) {
  return left.branch === right.branch && left.head === right.head && left.worktreeHash === right.worktreeHash;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function subjectRevision(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/**
 * How a caller reacts to the repository moving underneath it.
 *
 * `exact` is the original behaviour and stays the default: if a single byte changed while the
 * snapshot was being assembled, refuse. That is right for a governed write — `action execute`
 * re-verifies branch, HEAD, worktree and lifecycle before it commits, and a commit built on a tree
 * that has since moved is exactly the thing this kernel exists to prevent.
 *
 * `best-effort` is for reads. A read writes nothing, so nothing it does can be corrupted by an edit
 * arriving mid-flight; the only real requirement is that it says which moment it is describing. The
 * previous behaviour applied the write rule to reads too, which turned an ordinary background edit —
 * an autosave, or a phase writing its own artifacts — into no data at all in the sidebar.
 */
export const CONSISTENCY_MODES = Object.freeze(['exact', 'best-effort']);

const DISTURBED = 'Repository state changed while the snapshot was being assembled. Refresh and retry.';

/** Captures one coherent repository moment for every requested read-model slice. */
export class SnapshotCoordinator {
  constructor(root, options = {}) {
    this.root = root;
    this.clock = options.clock;
  }

  async capture(loader, {
    included = null, ifRevision = null, timings = false, consistency = 'exact'
  } = {}) {
    if (!CONSISTENCY_MODES.includes(consistency)) {
      throw new TypeError(`consistency must be one of ${CONSISTENCY_MODES.join(', ')}.`);
    }
    const timer = new TimingCollector({ enabled: timings, clock: this.clock });
    const read = async ({ revision }) => loader({ revision, included: included ? [...included] : null });
    const coordinatorWarnings = [];

    // `revision` is always the moment the surviving load *started* from, which is the only moment the
    // returned value can honestly claim to describe.
    let revision = await timer.measure('revisionBefore', async () => worktreeRevision(this.root));
    let value = await timer.measure('load', async () => read({ revision }));
    let after = await timer.measure('revisionAfter', async () => worktreeRevision(this.root));

    if (!sameRevision(revision, after)) {
      if (consistency === 'exact') throw new SingularityFlowError(DISTURBED);
      // One reload, against the newer revision. A single retry clears the ordinary case — one edit
      // landing mid-read — without turning a repository under continuous write into a spin.
      revision = after;
      value = await timer.measure('reload', async () => read({ revision }));
      after = await timer.measure('revisionAfterReload', async () => worktreeRevision(this.root));
      if (!sameRevision(revision, after)) {
        // Still moving: something is writing continuously, which during a running phase is normal
        // rather than exceptional. Return the read and say what it is, because a slightly stale view
        // of the lifecycle is worth a great deal more than an empty one.
        coordinatorWarnings.push(
          'The repository kept changing while this was being read, so it describes the moment the read '
          + 'started rather than the working tree as it stands now.'
        );
      }
    }

    const before = revision;
    const requested = included?.length ? [...new Set(included)] : null;
    const selected = requested
      ? Object.fromEntries(requested.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
      : value;
    const includedSlices = requested ?? Object.keys(value).filter((key) => !['schemaVersion', 'revision', 'included', 'warnings'].includes(key));
    const sliceRevisions = Object.fromEntries(includedSlices
      .filter((key) => Object.hasOwn(selected, key))
      .map((key) => [key, subjectRevision(selected[key])]));
    const selectedRevision = subjectRevision(Object.fromEntries(includedSlices
      .filter((key) => Object.hasOwn(selected, key))
      .map((key) => [key, selected[key]])));
    const notModified = Boolean(ifRevision && ifRevision === selectedRevision);
    const result = {
      schemaVersion: 2,
      revision: {
        branch: before.branch,
        head: before.head,
        worktreeHash: before.worktreeHash,
        subjectRevision: selectedRevision,
        slices: sliceRevisions
      },
      included: includedSlices,
      warnings: [...coordinatorWarnings, ...(value.warnings ?? [])],
      notModified
    };
    if (!notModified) Object.assign(result, selected);
    const measured = timer.finish();
    if (measured) result.timings = measured;
    return result;
  }
}
