import { issueHistoryCursor, readHistoryCursor } from './history-cursor.mjs';
import { historyFinding } from './history-result.mjs';
import { askTimeWindow } from './time-window.mjs';

/** The history providers share one read contract and one pinned continuation. */
export async function readAskHistory({ root, context, audience, intent, cursor, replay, capture }) {
  const scope = { root, context, audience };
  const saved = replay ?? (cursor ? await readHistoryCursor(cursor, scope) : null);
  const selection = saved?.intent ?? intent;
  const window = saved?.window ?? (selection.period ? askTimeWindow(selection.period) : null);
  const checkpoint = saved?.next ?? null;
  let result;
  if (selection.kind === 'work-history') {
    const { retainedHistory } = await import('./retained-history.mjs');
    result = await retainedHistory(root, selection, window, checkpoint, audience);
  } else {
    const { committedHistory, compareRevisions } = await import('./git-history.mjs');
    result = selection.kind === 'commits' ? await committedHistory(root, selection, window, checkpoint, audience)
      : compareRevisions(root, selection, checkpoint, audience);
  }
  const { next, start, ...value } = result;
  if (start) capture?.({ intent: selection, window, start, next });
  if (next) {
    try {
      value.continuation = {
        cursor: await issueHistoryCursor({ ...scope, intent: selection, window, next }),
        behavior: next.retry ? 'retry' : 'next-page'
      };
    } catch {
      value.diagnostics.push(historyFinding('ASK_CONTINUATION_UNAVAILABLE', 'The current results are available. This installation could not issue a continuation.'));
    }
  }
  const status = value.coverage.status === 'complete'
    ? (value.coverage.count.total === 0 ? 'empty' : 'resolved') : value.coverage.status;
  return { ...value, status, capability: 'ask-r2', kind: selection.kind, observedAt: new Date().toISOString() };
}
