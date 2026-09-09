import { createHash } from 'node:crypto';
import { TimingCollector } from './dx-timings.mjs';
import { parsePorcelainV2Revision } from './git-status-projection.mjs';
import { SingularityFlowError, run } from './util.mjs';
import { worktreeFingerprint } from './worktree-fingerprint.mjs';

async function worktreeRevision(root, { gitReadMode = 'reference', onGitShadowComparison = null } = {}) {
  // Porcelain v2 carries the branch, HEAD, and changed-path catalog in one process. The shared Git
  // tree fingerprint supplies the exact bytes and modes; every surface now means the same thing
  // when it calls a value `worktreeHash`.
  const reference = () => {
    const status = run('git', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: root });
    return parsePorcelainV2Revision(status.stdout);
  };
  let parsed;
  if (gitReadMode === 'shadow') {
    const [{ runFosGitShadowRead }, { executeGitQuery }] = await Promise.all([
      import('./fos-git-shadow.mjs'), import('./git-query.mjs')
    ]);
    ({ value: parsed } = await runFosGitShadowRead({
      operation: 'snapshot.repository-revision',
      mode: 'shadow',
      reference,
      candidate: () => executeGitQuery(root, 'repository.revision'),
      record: onGitShadowComparison
    }));
  } else {
    parsed = reference();
  }
  const fingerprint = worktreeFingerprint(root, {
    fresh: true,
    // The coordinator already paid for a complete porcelain status. Reusing it avoids a second
    // status walk while preserving the content-aware fingerprint's index and byte checks.
    dirty: parsed.changedFiles.length > 0,
    visiblePaths: parsed.changedFiles
  });
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
    this.gitReadMode = options.gitReadMode ?? 'reference';
    this.onGitShadowComparison = options.onGitShadowComparison ?? null;
    if (!['reference', 'shadow'].includes(this.gitReadMode)) {
      throw new SingularityFlowError(`Unsupported snapshot Git read mode '${this.gitReadMode}'.`, {
        code: 'FOS_GIT_SHADOW_MODE_INVALID'
      });
    }
  }

  async #revision() {
    return worktreeRevision(this.root, {
      gitReadMode: this.gitReadMode,
      onGitShadowComparison: this.onGitShadowComparison
    });
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
    let revision = await timer.measure('revisionBefore', async () => this.#revision());
    let value = await timer.measure('load', async () => read({ revision }));
    let after = await timer.measure('revisionAfter', async () => this.#revision());

    if (!sameRevision(revision, after)) {
      if (consistency === 'exact') throw new SingularityFlowError(DISTURBED);
      // One reload, against the newer revision. A single retry clears the ordinary case — one edit
      // landing mid-read — without turning a repository under continuous write into a spin.
      revision = after;
      value = await timer.measure('reload', async () => read({ revision }));
      after = await timer.measure('revisionAfterReload', async () => this.#revision());
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
