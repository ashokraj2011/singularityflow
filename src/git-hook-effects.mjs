import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { run } from './util.mjs';
import { gitFailureDiagnostic, redactDiagnosticText } from './git-remote-diagnostics.mjs';

const MAX_STATUS_BYTES = 512 * 1024;
const MAX_PATHS = 2000;

/** Observational only: Git-visible paths and metadata, never proof of byte-exact source integrity. */
export function capturePushWorktree(root) {
  try {
    const started = Date.now();
    const result = run('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: root, allowFailure: true, timeoutMs: 3000, maxBuffer: MAX_STATUS_BYTES, encoding: 'buffer',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    });
    if (result.status !== 0 || result.error || result.timedOut || !Buffer.isBuffer(result.stdout)) return null;
    const records = result.stdout.toString('utf8').split('\0').filter(Boolean);
    if (records.length > MAX_PATHS || records.some((record) => record.includes('\ufffd'))) return null;
    const entries = new Map();
    for (let index = 0; index < records.length; index += 1) {
      if (Date.now() - started > 4000) return null;
      const record = records[index];
      if (record.length < 4 || record[2] !== ' ') return null;
      const name = record.slice(3);
      if (path.isAbsolute(name) || name.split(/[\\/]/u).some((component) => component === '..')) return null;
      let metadata = 'missing';
      try {
        const stat = lstatSync(path.join(root, name));
        metadata = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(':');
      } catch { /* Deleted paths are also changes. */ }
      entries.set(name, `${record.slice(0, 2)}:${metadata}`);
      if (/[RC]/u.test(record.slice(0, 2))) {
        const from = records[++index];
        if (!from) return null;
        entries.set(from, `renamed-to:${name}`);
      }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([...entries].sort())).digest('hex');
    return { fingerprint, entries };
  } catch { return null; }
}

export async function observePublicationHookEffects(root, publish, { capture = capturePushWorktree } = {}) {
  const before = capture(root);
  const result = await publish();
  const after = capture(root);
  const names = before && after ? [...new Set([...before.entries.keys(), ...after.entries.keys()])]
    .filter((name) => before.entries.get(name) !== after.entries.get(name)) : [];
  const hookWorktree = {
    status: !before || !after ? 'unavailable' : before.fingerprint === after.fingerprint ? 'no-visible-change' : 'changed',
    scope: 'git-visible-paths-and-metadata',
    attribution: 'during-push-not-proven-hook-owned',
    changedPaths: names.slice(0, 50).map((name) => redactDiagnosticText(name).slice(0, 256)),
    truncated: names.length > 50,
    ignoredPathsObserved: false,
    filesDiscarded: false
  };
  const failure = result.failure ? { ...result.failure, diagnostics: gitFailureDiagnostic(result), hookWorktree } : null;
  const observed = { ...result, ...(failure ? { failure } : {}), hookWorktree };
  // Older publication callers relay only stderr. Preserve the classified repair and both streams
  // there too, while the raw process evidence remains bound to the transport's original result.
  return failure?.hook ? { ...observed, stderr: publicationFailureMessage(observed) } : observed;
}

export function publicationFailureMessage(result) {
  const observation = result.hookWorktree;
  const preservation = observation?.status === 'changed'
    ? `Git-visible working-tree changes were detected during the push: ${observation.changedPaths.join(', ') || 'see repository status'}. All files were retained; review them before retrying.`
    : 'The push may have run local hooks. Preserve authored work and inspect generated files before retrying; no automatic file cleanup was performed.';
  // A legacy caller may be formatting the already-annotated stderr. Use the original redacted
  // streams attached to the failure instead of nesting the same diagnostic/advice a second time.
  return `${result.failure?.advice ?? 'Git refused the publication.'}\n${result.failure?.diagnostics ?? gitFailureDiagnostic(result)}\n${preservation}`;
}
