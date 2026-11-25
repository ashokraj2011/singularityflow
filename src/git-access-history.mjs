/** Bounded historical Git reads, loaded by consumers that inspect commit history or exact trees. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { literalPathspec, repositoryRelative, typedGit, typedOutput } from './source-inspection.mjs';
import { SingularityFlowError } from './util.mjs';

const MAX_SUBJECT_CHARS = 240;

/** The local shallow boundaries, which can change independently of the selected commit. */
export async function typedHistoryView(root) {
  const output = typedOutput(typedGit(root, [
    'rev-parse', '--is-shallow-repository', '--path-format=absolute', '--git-path', 'shallow'
  ]), 'The local Git ancestry boundary');
  const [shallow, file] = output.trimEnd().split(/\r?\n/u);
  if (shallow === 'false') return null;
  if (shallow !== 'true' || !path.isAbsolute(file ?? '')) {
    throw new SingularityFlowError('Git did not identify its ancestry boundary.', { code: 'TYPED_GIT_READ_UNAVAILABLE' });
  }
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** One bounded page of immutable ancestry. Date filters are applied to every visited commit. */
export function typedCommitterPage(root, revision, { offset = 0, limit = 200 } = {}) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision) ||
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new SingularityFlowError('A commit page requires an exact revision and a bounded range.', { code: 'TYPED_GIT_HISTORY_INVALID' });
  }
  const output = typedOutput(typedGit(root, [
    'log', '--topo-order', `--skip=${offset}`, `--max-count=${limit + 1}`, '--no-notes', '--no-show-signature',
    '-z', '--format=tformat:%H%x00%ct%x00%s', '--end-of-options', revision, '--'
  ], { env: { GIT_GRAFT_FILE: '' } }), 'Git committer history');
  const fields = output ? output.slice(0, -1).split('\0') : [];
  if (output && (!output.endsWith('\0') || fields.length % 3 !== 0 || fields.length > (limit + 1) * 3)) {
    throw new SingularityFlowError('Git returned an incomplete commit history page.', { code: 'TYPED_GIT_HISTORY_INVALID' });
  }
  const commits = [];
  for (let index = 0; index < fields.length; index += 3) {
    const [commit, stamp, subject] = fields.slice(index, index + 3);
    const date = new Date(Number(stamp) * 1000);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit) || !/^-?\d+$/u.test(stamp) || !Number.isFinite(date.valueOf())) {
      throw new SingularityFlowError('Git returned a commit without a valid object ID or committer date.', { code: 'TYPED_GIT_HISTORY_INVALID' });
    }
    commits.push({ commit, committedAt: date.toISOString(), subject: subject.slice(0, MAX_SUBJECT_CHARS) });
  }
  return { commits: commits.slice(0, limit), more: commits.length > limit };
}

function endpointDiff(root, left, right, names, renames, scope = []) {
  return typedGit(root, [
    'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '-l1000',
    renames ? '--find-renames=50%' : '--no-renames', names ? '--name-status' : '--numstat', '-z',
    left, right, '--', ...scope
  ], { env: { LC_ALL: 'C' } });
}

function typedEndpointNames(root, left, right, renames) {
  const result = endpointDiff(root, left, right, true, renames);
  const output = typedOutput(result, 'The endpoint changes');
  const fields = output ? output.slice(0, -1).split('\0') : [];
  if (output && !output.endsWith('\0')) {
    throw new SingularityFlowError('Git returned an incomplete endpoint path listing.', { code: 'TYPED_GIT_READ_UNAVAILABLE' });
  }
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const renamed = status.startsWith('R');
    const oldPath = renamed ? fields[index++] : null;
    const file = fields[index++];
    if (!file || (renamed && !oldPath) || !/^(?:[ADMTU]|[RM][0-9]{1,3})$/u.test(status)) {
      throw new SingularityFlowError('Git returned an incomplete endpoint path listing.', { code: 'TYPED_GIT_READ_UNAVAILABLE' });
    }
    entries.push({ status: status[0], path: file, ...(renamed ? { oldPath, similarity: Number(status.slice(1)) } : {}) });
  }
  return { entries, renameLimited: /rename detection was skipped/iu.test(result.stderr ?? '') };
}

function endpointCounts(root, left, right, scope, renames) {
  const counts = new Map();
  const output = typedOutput(endpointDiff(root, left, right, false, renames, scope), 'Line counts at the endpoint trees');
  if (!output) return counts;
  if (!output.endsWith('\0')) throw new Error('Git returned incomplete line counts.');
  const fields = output.slice(0, -1).split('\0');
  for (let index = 0; index < fields.length;) {
    const row = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(fields[index++]);
    if (!row) throw new Error('Git returned malformed line counts.');
    const renamed = !row[3];
    const file = renamed ? fields[index + 1] : row[3];
    if (!file || (renamed && !fields[index])) throw new Error('Git returned an incomplete renamed path.');
    index += renamed ? 2 : 0;
    counts.set(file, { added: row[1], removed: row[2] });
  }
  return counts;
}

/** Direct tree-to-tree path metadata, with separate coverage for rename detection and blob reads. */
export function typedEndpointChanges(root, left, right, { relative = null } = {}) {
  if (![left, right].every(commit => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit))) {
    throw new SingularityFlowError('A tree comparison requires two exact commits.', { code: 'TYPED_GIT_HISTORY_INVALID' });
  }
  const selected = relative ? repositoryRelative(relative) : null;
  const selectedPaths = file => file === selected || file?.startsWith(selected.replace(/\/$/u, '') + '/');
  const diagnostics = [];
  let names;
  let withRenames = true;
  try { names = typedEndpointNames(root, left, right, withRenames); }
  catch {
    withRenames = false;
    names = typedEndpointNames(root, left, right, withRenames);
    diagnostics.push({ code: 'ASK_RENAMES_UNAVAILABLE', message: 'Git could list changed paths, but could not determine all renames.' });
  }
  if (names.renameLimited) {
    diagnostics.push({ code: 'ASK_RENAMES_LIMITED', message: 'Git limited similarity detection. Some additions and deletions may be renames.' });
  }
  const entries = names.entries.filter(entry => !selected || selectedPaths(entry.path) || selectedPaths(entry.oldPath));
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let counts = new Map();
  if (entries.length) {
    const scope = selected ? [...new Set(entries.flatMap(entry => [entry.oldPath, entry.path]).filter(Boolean))] : [];
    // Keep a literal scope for small path selections. A recursive comparison can otherwise
    // exceed the platform's argv limit and is cheaper as a single tree read.
    const pathspec = scope.length <= 32 ? scope.map(literalPathspec) : [];
    try { counts = endpointCounts(root, left, right, pathspec, withRenames); }
    catch {
      // A missing blob must not hide binary/text metadata from other readable paths. Bound this
      // fallback separately, and keep the complete name list when some file reads still fail.
      for (const entry of entries.slice(0, 12)) {
        const scope = [entry.oldPath, entry.path].filter(Boolean).map(literalPathspec);
        try {
          const count = endpointCounts(root, left, right, scope, Boolean(entry.oldPath)).get(entry.path);
          if (count) counts.set(entry.path, count);
        } catch { /* Record the missing content below. */ }
      }
    }
  }
  for (const entry of entries) {
    const count = counts.get(entry.path);
    entry.binary = count ? count.added === '-' && count.removed === '-' : null;
    entry.added = count && !entry.binary ? Number(count.added) : null;
    entry.removed = count && !entry.binary ? Number(count.removed) : null;
  }
  const contentComplete = entries.every(entry => entry.binary !== null);
  if (!contentComplete) {
    diagnostics.push({ code: 'ASK_DIFF_CONTENT_UNAVAILABLE', message: 'Line counts or blob content for some changed paths are unavailable locally.' });
  }
  return { entries, renamesComplete: withRenames && !names.renameLimited, contentComplete, diagnostics };
}
