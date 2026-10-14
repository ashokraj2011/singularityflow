/** Story locations come from the reachable state ledger, never an application branch inventory. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { compactCanonicalJson } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

export const STORY_STATE_INDEX_LIMIT = 100_000;

export function storyPointersFromLedger(head, files) {
  const fail = (message) => { throw new SingularityFlowError(message, { code: 'SESSION_STATE_INDEX_INVALID' }); };
  if (!Number.isSafeInteger(head?.sequence) || head.sequence < 0 || head.sequence > STORY_STATE_INDEX_LIMIT) {
    fail('The state Story index has an invalid or oversized ledger sequence.');
  }
  if (head.sequence === 0 ? head.entryHash != null : !/^[a-f0-9]{64}$/u.test(head.entryHash ?? '')) {
    fail('The state Story index has an invalid ledger head binding.');
  }
  const entries = new Map();
  for (const [file, contents] of files) {
    if (!file.endsWith('.json')) continue;
    const hash = path.posix.basename(file, '.json');
    let raw;
    try { raw = JSON.parse(String(contents)); } catch { fail('The state Story index contains unreadable ledger metadata.'); }
    const digest = createHash('sha256').update(compactCanonicalJson(raw)).digest('hex');
    if (hash !== digest || entries.has(hash)) fail('The state Story index contains an invalid ledger entry digest.');
    entries.set(hash, readRecord('ledger-entry', raw).record);
  }
  const latest = new Map();
  const visited = new Set();
  let cursor = head.entryHash;
  while (cursor) {
    if (visited.has(cursor) || visited.size >= STORY_STATE_INDEX_LIMIT) fail('The state Story index contains a cycle or exceeds its bound.');
    visited.add(cursor);
    const entry = entries.get(cursor);
    if (!entry) fail('The reachable state Story index is incomplete. Refresh the state branch before retrying.');
    const id = entry.subject?.workId;
    const branch = entry.subject?.branch;
    const commit = entry.transport?.publishedCommit;
    const kind = entry.subject?.kind ?? entry.payload?.lifecycleEvent?.subject?.kind;
    if (kind === 'story' && (typeof id !== 'string' || !id || typeof branch !== 'string' || !branch
        || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit ?? ''))) {
      fail('A Story location in the state index is incomplete or invalid.');
    }
    // Historical ledger entries do not carry kind. Their exact committed workflow is validated
    // by discovery before they can become Story rows; unrelated subjects remain diagnostics.
    if ((!kind || kind === 'story') && typeof id === 'string' && typeof branch === 'string'
        && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit ?? '') && !latest.has(id)) {
      latest.set(id, { id, branch, commitOid: commit, entryHash: cursor });
    }
    cursor = entry.parentEntryHash;
  }
  if (visited.size !== head.sequence) fail('The state Story index does not match its reachable ledger sequence.');
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
}
