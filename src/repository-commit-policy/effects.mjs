import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { exactGitDirectories } from '../git-exact-reads.mjs';
import { withoutGitProcessOverrides } from '../git-enterprise-environment.mjs';
import { rcpDigest, rcpFailure } from './policy.mjs';

/** Byte observations, including ignored/untracked files. No symlink is followed outside the root. */
export async function captureCommitEffects(root, limits) {
  const actual = await realpath(root), entries = new Map(); let bytesRead = 0;
  async function walk(base, logical, { rootTree = false } = {}) {
    const info = await lstat(base);
    if (info.isSymbolicLink()) {
      const target = await readlink(base), resolved = path.resolve(path.dirname(base), target);
      if (path.relative(actual, resolved).startsWith('..') || path.isAbsolute(path.relative(actual, resolved))) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'Native hook effects cannot be proved for a link outside the admitted repository.', { path: logical });
      entries.set(logical, `link:${rcpDigest(target)}`); return;
    }
    if (info.isDirectory()) {
      for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (rootTree && !logical && entry.name === '.git') continue;
        await walk(path.join(base, entry.name), logical ? `${logical}/${entry.name}` : entry.name, { rootTree });
      }
      return;
    }
    if (!info.isFile()) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'Native effects observation encountered an unsupported file kind.', { path: logical });
    bytesRead += info.size;
    if (entries.size >= limits.maximumObservedFiles || bytesRead > limits.maximumObservedBytes) rcpFailure('RCP_VALIDATION_INCOMPLETE', 'The native hook observation exceeds its admitted file/byte budget. Select an approved bounded equivalent profile or a compatible execution binding.');
    const bytes = await readFile(base), digest = createHash('sha256').update(bytes).digest('hex');
    const after = await lstat(base);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) rcpFailure('RCP_VALIDATION_INCOMPLETE', 'Repository files changed during hook effects observation.', { path: logical });
    entries.set(logical, `${info.mode & 0o777}:${digest}`);
  }
  await walk(actual, '', { rootTree: true });
  const directories = exactGitDirectories(actual, { env: withoutGitProcessOverrides(), timeoutMs: 15000, required: true }).value;
  for (const [index, directory] of directories.entries()) {
    const base = path.resolve(actual, directory);
    for (const name of ['HEAD', 'index', 'config', 'config.worktree', 'packed-refs', 'commondir', 'refs']) {
      const file = path.join(base, name);
      try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await walk(file, `@git-${index}/${name}`);
    }
  }
  const record = Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
  return { schemaVersion: 1, scope: 'repository-files-and-git-control', entries: record, sha256: rcpDigest(record), externalEffects: 'not-observed', containment: 'not-claimed' };
}
export function compareCommitEffects(before, after, allowedPaths) {
  if (!before?.entries || !after?.entries) return { status: 'unproven', changedPaths: [], outOfScope: [] };
  const changedPaths = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].filter(file => before.entries[file] !== after.entries[file]);
  const outOfScope = changedPaths.filter(file => file.startsWith('@git-') || !allowedPaths.some(prefix => file === prefix || file.startsWith(`${prefix}/`)));
  return { status: changedPaths.length ? 'changed' : 'unchanged', changedPaths, outOfScope,
    observationScope: before.scope, externalEffects: 'not-observed', containment: 'not-claimed' };
}
