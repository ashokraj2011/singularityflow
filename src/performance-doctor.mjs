import { performance } from 'node:perf_hooks';

import { worldModelSourceSnapshot } from './grounding.mjs';
import { worldModelSourceScope } from './source-scope.mjs';
import { run } from './util.mjs';
import { withoutConfiguredFilters } from './worktree-fingerprint.mjs';

function nullCount(value) {
  return String(value ?? '').split('\0').filter(Boolean).length;
}

/** Count porcelain-v2 logical records; a rename/copy carries one extra NUL path field. */
export function porcelainV2RecordCount(value) {
  const fields = String(value ?? '').split('\0');
  let count = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    count += 1;
    if (field.startsWith('2 ') && index + 1 < fields.length) index += 1;
  }
  return count;
}

function milliseconds(started) {
  return Math.round((performance.now() - started) * 10) / 10;
}

function config(root, key) {
  return run('git', ['config', '--local', '--get', key], { cwd: root, allowFailure: true }).stdout.trim() || null;
}

function objectDatabase(root) {
  const result = run('git', ['count-objects', '-v'], { cwd: root, allowFailure: true });
  const values = {};
  if (result.status === 0) {
    for (const line of result.stdout.split(/\r?\n/)) {
      const split = line.indexOf(': ');
      if (split > 0) values[line.slice(0, split)] = Number(line.slice(split + 2));
    }
  }
  return values;
}

function timedStatus(root) {
  const started = performance.now();
  const result = run('git', withoutConfiguredFilters(root, [
    'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'
  ]), { cwd: root, allowFailure: true });
  return { milliseconds: milliseconds(started), status: result.status, entries: porcelainV2RecordCount(result.stdout) };
}

/**
 * An explicit, read-only monorepo benchmark. It is never run by Home or ordinary diagnostics.
 * The warm measurements are the useful ones: they approximate the repeated operations a person
 * experiences after the first OS/Git cache fill without pretending to be a laboratory benchmark.
 */
export async function repositoryPerformanceSnapshot(root, definition = {}) {
  const scope = worldModelSourceScope(definition);
  const pathspec = scope.all ? [] : ['--', ...scope.paths];
  const totalTracked = nullCount(run('git', ['ls-files', '-z'], { cwd: root }).stdout);
  const scopedTracked = scope.all
    ? totalTracked
    : nullCount(run('git', ['ls-files', '-z', ...pathspec], { cwd: root }).stdout);

  const coldStatus = timedStatus(root);
  const warmStatus = timedStatus(root);
  const coldFingerprintStarted = performance.now();
  const coldFingerprint = await worldModelSourceSnapshot(root, definition);
  const coldFingerprintMs = milliseconds(coldFingerprintStarted);
  const warmFingerprintStarted = performance.now();
  const warmFingerprint = await worldModelSourceSnapshot(root, definition);
  const warmFingerprintMs = milliseconds(warmFingerprintStarted);

  /**
   * The AST index, measured the same way as everything else here: twice.
   *
   * Its disk cache is per-file and content-addressed, and successful reads now warm immutable Git
   * skeletons automatically. A second identical call should therefore be mostly cache hits and
   * visibly cheaper than the first; a long-lived host can additionally reuse the bounded in-memory
   * fact index. Dirty/untracked inputs remain memory-only and cache write failures are non-blocking.
   *
   * Imported lazily because this whole module is an explicit benchmark rather than part of any read,
   * and `ast-intelligence.mjs` is 2,300 lines nothing else here needs.
   */
  const astTimings = await (async () => {
    try {
      const { astContext } = await import('./ast-intelligence.mjs');
      const options = { all: true, 'max-facts': 50, 'max-output-bytes': 256 * 1024 };
      const coldStarted = performance.now();
      const cold = await astContext(root, { ...options });
      const coldMs = milliseconds(coldStarted);
      const warmStarted = performance.now();
      const warm = await astContext(root, { ...options });
      return { coldMs, warmMs: milliseconds(warmStarted), facts: warm.facts?.length ?? cold.facts?.length ?? 0 };
    } catch (error) {
      // A repository with the extractor disabled, or no indexable source, is not a failed benchmark.
      return { coldMs: null, warmMs: null, facts: 0, unavailable: String(error?.message ?? error).slice(0, 200) };
    }
  })();

  const sparse = config(root, 'core.sparseCheckout') === 'true';
  const partialFilter = config(root, 'remote.origin.partialclonefilter');
  const recommendations = [];
  if (totalTracked >= 50_000 && scope.all) {
    recommendations.push({
      id: 'scope-world-model',
      severity: 'high',
      message: `The world model covers all ${totalTracked.toLocaleString('en-US')} tracked files. Set capability sourceRoots/sharedRoots before building it.`
    });
  }
  if (totalTracked >= 50_000 && !sparse) {
    recommendations.push({
      id: 'sparse-workspace',
      severity: 'medium',
      message: 'Use a blobless-sparse capability clone strategy for new workspaces; existing workspaces are not rewritten automatically.'
    });
  }
  if (totalTracked >= 50_000 && partialFilter !== 'blob:none') {
    recommendations.push({
      id: 'partial-clone',
      severity: 'medium',
      message: 'Use clone mode blobless or blobless-sparse so historical blobs are fetched only when needed.'
    });
  }
  if (warmStatus.milliseconds > 1_500) {
    recommendations.push({
      id: 'git-status',
      severity: 'high',
      message: `Warm git status took ${warmStatus.milliseconds} ms. Consider Git built-in FSMonitor and untracked cache after validating them with your Git/platform team.`
    });
  }
  if (warmFingerprintMs > 2_000) {
    recommendations.push({
      id: 'world-model-fingerprint',
      severity: 'high',
      message: `Warm scoped fingerprinting took ${warmFingerprintMs} ms. Narrow capability sourceRoots/sharedRoots or its sparse cone.`
    });
  }
  /**
   * A cache that costs the same warm as cold needs diagnosis.
   *
   * Four fifths rather than a strict comparison: the second call legitimately shares an OS page
   * cache and a warm Git object store, so some improvement is free and does not prove the content
   * store was written. Anything above that means automatic warming was unavailable, the selected
   * inputs were not immutable Git blobs, or cache read cost dominates extraction.
   */
  if (astTimings.coldMs !== null && astTimings.coldMs > 50 && astTimings.warmMs > astTimings.coldMs * 0.8) {
    recommendations.push({
      id: 'ast-cache-cold',
      severity: 'medium',
      message: `A repeated AST read cost ${astTimings.warmMs} ms against the first call's ${astTimings.coldMs} ms, so the`
        + ' automatic cache warm did not materially reduce latency. Inspect `wm ast doctor`; use `wm ast build` for an explicit fail-closed rebuild.'
    });
  }
  if (coldFingerprint.sha256 !== warmFingerprint.sha256) {
    recommendations.unshift({
      id: 'unstable-fingerprint',
      severity: 'high',
      message: 'Two consecutive read-only world-model fingerprints disagreed. Stop and inspect concurrent repository mutations.'
    });
  }

  return {
    schemaVersion: 1,
    scope: { all: scope.all, sourceRoots: [...scope.sourceRoots], sharedRoots: [...scope.sharedRoots] },
    files: { tracked: totalTracked, scoped: scopedTracked },
    git: {
      sparseCheckout: sparse,
      partialCloneFilter: partialFilter,
      fsmonitor: config(root, 'core.fsmonitor'),
      untrackedCache: config(root, 'core.untrackedCache'),
      objects: objectDatabase(root)
    },
    timings: {
      status: { coldMs: coldStatus.milliseconds, warmMs: warmStatus.milliseconds, entries: warmStatus.entries },
      worldModelFingerprint: { coldMs: coldFingerprintMs, warmMs: warmFingerprintMs },
      astContext: astTimings
    },
    fingerprint: warmFingerprint.sha256,
    recommendations
  };
}
