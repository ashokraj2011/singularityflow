/**
 * Snapshot-bound pages of the capability ledger (SDA §7.2 item 4).
 *
 * Kept apart from ledger.mjs, which every lifecycle command loads: only the shared-state adapter
 * reads the ledger in pages today.
 */
import path from 'node:path';
import {
  canonicalJson, ledgerAtSnapshot, ledgerPayloadDigest, ledgerSnapshotCommit, sha256
} from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

/** The most entries one ledger page holds. */
export const LEDGER_PAGE_MAX = 1000;
const CONTINUATION_PREFIX = 'lp1.';

function continuationFor(namespace, snapshot, cursor, served) {
  return `${CONTINUATION_PREFIX}${Buffer.from(JSON.stringify({ n: namespace, s: snapshot, c: cursor, i: served })).toString('base64url')}`;
}

function readContinuation(token, namespace) {
  let parsed = null;
  if (typeof token === 'string' && token.startsWith(CONTINUATION_PREFIX) && token.length <= 512) {
    try { parsed = JSON.parse(Buffer.from(token.slice(CONTINUATION_PREFIX.length), 'base64url').toString('utf8')); }
    catch { parsed = null; }
  }
  const valid = parsed && /^[0-9a-f]{40,64}$/u.test(parsed.s ?? '') && /^[0-9a-f]{64}$/u.test(parsed.c ?? '')
    && Number.isSafeInteger(parsed.i) && parsed.i > 0;
  if (!valid || parsed.n !== namespace) {
    throw new SingularityFlowError(valid
      ? `This ledger continuation belongs to '${parsed.n}', not '${namespace}'. Start the listing again.`
      : 'The ledger continuation is not one this build issued. Start the listing again.', {
      code: 'LEDGER_CONTINUATION_INVALID', details: { namespace }
    });
  }
  return { snapshot: parsed.s, cursor: parsed.c, served: parsed.i };
}

/**
 * One page of the reachable ledger chain, newest first, cut from one exact snapshot.
 *
 * The first page reads the state ref as it is now; its continuation names the namespace and that
 * snapshot commit, so every later page reads the same commit even after the ledger advanced. No
 * entry repeats or is skipped, and no newer entry joins a listing already under way. A snapshot no
 * longer held here refuses, and the listing starts again. Each entry is checked against its hash and
 * payload digest: corrupt data refuses, which is not the same as an empty ledger.
 */
export async function ledgerPage(root, rawConfig, { limit = 100, continuation = null, offline = false } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_PAGE_MAX) {
    throw new SingularityFlowError(`A ledger page holds 1 to ${LEDGER_PAGE_MAX} entries.`, { code: 'LEDGER_PAGE_LIMIT_INVALID' });
  }
  const namespace = `${config.remote}/${config.branch}`;
  let snapshot;
  let cursor;
  let served = 0;
  if (continuation != null) {
    ({ snapshot, cursor, served } = readContinuation(continuation, namespace));
  } else {
    snapshot = await ledgerSnapshotCommit(root, config, { offline });
    if (!snapshot) return Object.freeze({ namespace, snapshot: null, entries: Object.freeze([]), complete: true, continuation: null });
  }
  const held = ledgerAtSnapshot(root, snapshot);
  if (!held.head) {
    throw new SingularityFlowError(continuation != null
      ? `Ledger snapshot ${snapshot} is no longer held here. Start the listing again.`
      : 'Ledger branch is missing its head record.', {
      code: continuation != null ? 'LEDGER_CONTINUATION_UNAVAILABLE' : 'LEDGER_CHAIN_INVALID', details: { namespace, snapshot }
    });
  }
  cursor ??= held.head.entryHash;
  const entries = new Map();
  for (const [file, contents] of held.entries) {
    if (file.endsWith('.json')) entries.set(path.posix.basename(file, '.json'), contents);
  }
  const page = [];
  while (cursor && page.length < limit) {
    const bytes = entries.get(cursor);
    let entry = null;
    try { entry = bytes === undefined ? null : readRecord('ledger-entry', bytes).record; }
    catch (error) {
      // A record from a newer build is unsupported, not corrupt: that refusal stands as it is.
      if (String(error?.code ?? '').startsWith('SCHEMA_VERSION_')) throw error;
    }
    if (!entry || sha256(canonicalJson(entry)) !== cursor
        || (entry.payloadDigest !== undefined && entry.payloadDigest !== ledgerPayloadDigest(entry))) {
      throw new SingularityFlowError(`Ledger snapshot ${snapshot} has a missing or corrupt entry ${cursor}.`, {
        code: 'LEDGER_CHAIN_INVALID', details: { namespace, snapshot, entryHash: cursor }
      });
    }
    page.push(Object.freeze({ hash: cursor, ...entry }));
    cursor = entry.parentEntryHash ?? null;
  }
  served += page.length;
  return Object.freeze({
    namespace, snapshot, entries: Object.freeze(page), complete: !cursor,
    continuation: cursor ? continuationFor(namespace, snapshot, cursor, served) : null
  });
}
