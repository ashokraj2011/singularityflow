import { typedPatch, typedRevision } from '../git-access.mjs';
import { typedCommitterPage, typedEndpointChanges, typedHistoryView } from '../git-access-history.mjs';
import { coverage, historyFinding, pageRowCount, pageViewDigest } from './history-result.mjs';

const GIT_SCAN_PAGE = 250;
const GIT_SCAN_LIMIT = 16_000;
const COMPARISON_PAGE = 60;
const BASIS = {
  committed: 'available',
  authored: 'unsupported', integrated: 'unsupported', 'merged-pr': 'unsupported', deployed: 'unsupported'
};

export async function committedHistory(root, intent, window, cursor, audience = 'person') {
  const revision = cursor?.revision ?? typedRevision(root, intent.revision);
  const diagnostics = [];
  const rows = [];
  const offset = cursor?.offset ?? 0;
  let inspected = 0;
  let shallow = cursor?.shallow ?? null;
  const answer = (next = null, available = true) => ({
    history: {
      provider: 'git', mode: 'committer-date', basis: 'committed', availableBases: BASIS, window, rows,
      scope: { reference: intent.revision, revision, reachability: 'ancestors-and-self', shallow: shallow !== null },
      ordering: 'git-topological'
    },
    coverage: {
      ...coverage('commits', (cursor?.retrieved ?? 0) + rows.length, diagnostics, next, available),
      inspected: offset + inspected, limit: GIT_SCAN_LIMIT
    },
    diagnostics, next
  });
  if (!revision) {
    diagnostics.push(historyFinding('ASK_GIT_REVISION_UNAVAILABLE', 'The selected Git revision could not be resolved locally. Choose a branch, tag or commit held in this checkout.'));
    return answer(null, false);
  }
  let more;
  try {
    shallow = await typedHistoryView(root);
    if (cursor && cursor.shallow !== shallow) {
      diagnostics.push(historyFinding('ASK_GIT_ANCESTRY_CHANGED', 'The local shallow boundaries changed. Start a new query to use the new ancestry.'));
      return answer(null, false);
    }
    const page = typedCommitterPage(root, revision, { offset, limit: Math.min(GIT_SCAN_PAGE, GIT_SCAN_LIMIT - offset) });
    const start = Date.parse(window.startInclusive);
    const end = Date.parse(window.endExclusive);
    const matches = [];
    for (const [index, row] of page.commits.entries()) {
      const committedAt = Date.parse(row.committedAt);
      if (committedAt >= start && committedAt < end) matches.push({ row, position: index + 1 });
    }
    const length = pageRowCount(matches.map(match => match.row), audience);
    rows.push(...matches.slice(0, length).map(match => match.row));
    inspected = length < matches.length ? matches[length - 1].position : page.commits.length;
    more = page.more || inspected < page.commits.length;
  } catch (error) {
    diagnostics.push(historyFinding(error.code ?? 'ASK_GIT_HISTORY_UNAVAILABLE', error.message));
    return answer(cursor ? { ...cursor, retry: true } : null, Boolean(cursor));
  }
  if (shallow !== null) diagnostics.push(historyFinding('ASK_GIT_HISTORY_SHALLOW', 'This checkout is shallow. Older reachable commits may be missing.'));
  const retrieved = (cursor?.retrieved ?? 0) + rows.length;
  const position = offset + inspected;
  if (more && position >= GIT_SCAN_LIMIT) {
    diagnostics.push(historyFinding('ASK_GIT_HISTORY_CAPPED', 'The commit scan reached its 16,000-commit limit. Results cover only the inspected history.'));
  }
  return answer(more && position < GIT_SCAN_LIMIT ? { revision, offset: position, shallow, retrieved } : null);
}

export function compareRevisions(root, intent, cursor, audience) {
  const diagnostics = [];
  const left = cursor?.left ?? typedRevision(root, intent.left);
  const right = cursor?.right ?? typedRevision(root, intent.right);
  const offset = cursor?.offset ?? 0;
  const comparison = {
    provider: 'git', mode: 'endpoint-trees', left: { reference: intent.left, revision: left },
    right: { reference: intent.right, revision: right }, path: intent.path, pathPolicy: 'includes-generated-and-vendored',
    rows: [], paths: 'unavailable', renames: 'unavailable', lineCounts: 'unavailable'
  };
  const answer = (next = null, available = true) => ({
    comparison, coverage: coverage('paths', offset + comparison.rows.length, diagnostics, next, available), diagnostics, next
  });
  if (!left || !right) {
    diagnostics.push(historyFinding('ASK_COMPARISON_ENDPOINT_UNAVAILABLE', 'Resolve both endpoints to locally available branches, tags or commits.'));
    return answer(null, false);
  }
  let diff;
  try { diff = typedEndpointChanges(root, left, right, { relative: intent.path }); }
  catch (error) {
    diagnostics.push(historyFinding(error.code ?? 'ASK_ENDPOINT_TREES_UNAVAILABLE', error.message));
    return answer(cursor ? { ...cursor, retry: true } : null, false);
  }
  const view = pageViewDigest(diff.entries, diff.diagnostics);
  if (cursor?.view && cursor.view !== view) {
    diagnostics.push(historyFinding('ASK_COMPARISON_VIEW_CHANGED', 'Local availability of the comparison objects changed. Start the comparison again.'));
    return answer(null, false);
  }
  comparison.paths = 'complete';
  comparison.renames = diff.renamesComplete ? 'complete' : 'partial';
  comparison.lineCounts = diff.contentComplete ? 'complete' : 'partial';
  const available = diff.entries.slice(offset, offset + COMPARISON_PAGE);
  comparison.rows = available.slice(0, pageRowCount(available, audience, COMPARISON_PAGE));
  diagnostics.push(...diff.diagnostics.map(({ code, message }) => historyFinding(code, message)));
  if (intent.patch) {
    const path = intent.path.replace(/\\/gu, '/');
    const entry = diff.entries.find(row => row.path === path || row.oldPath === path);
    if (audience !== 'person') {
      comparison.patch = { status: 'person-view-required' };
      diagnostics.push(historyFinding('ASK_PATCH_PERSON_VIEW_REQUIRED', 'Open this comparison in the browser or VS Code to read patch text.'));
    } else if (!entry) {
      comparison.patch = { status: 'no-exact-path-change' };
      if (diff.entries.length) diagnostics.push(historyFinding('ASK_PATCH_FILE_REQUIRED', 'Name one changed file to view its text patch.'));
    } else if (entry.binary) {
      comparison.patch = { status: 'binary' };
    } else {
      try {
        const patch = typedPatch(root, left, right, entry.path, { previousPath: entry.oldPath, maxBytes: 8192 });
        comparison.patch = {
          status: patch.binary ? 'binary' : patch.truncated ? 'truncated' : 'complete',
          text: patch.text, bytes: patch.bytes
        };
        if (patch.truncated) diagnostics.push(historyFinding('ASK_PATCH_TRUNCATED', 'The patch preview reached the 8 KiB display limit.'));
      } catch (error) {
        comparison.patch = { status: 'unavailable' };
        diagnostics.push(historyFinding(error.code ?? 'ASK_PATCH_UNAVAILABLE', 'The patch for this path is unavailable. The retained path metadata is shown.'));
      }
    }
  }
  const nextOffset = offset + comparison.rows.length;
  return answer(nextOffset < diff.entries.length ? { left, right, offset: nextOffset, view } : null);
}
