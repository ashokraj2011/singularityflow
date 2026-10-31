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
/** The read that names every damaged or missing entry; the chain is append-only, so nothing here repairs it. */
export const LEDGER_VERIFY_COMMAND = 'singularity-flow ledger verify';

/**
 * `stopAtDamage`: a reader that serves what it can (a list, a lookup) gets the entries before a
 * missing or corrupt one and `damaged` naming it, instead of the refusal; the chain cannot be
 * followed past it, so the listing ends there (sweep B3).
 */
export async function ledgerPage(root, rawConfig, { limit = 100, continuation = null, offline = false, stopAtDamage = false } = {}) {
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
  const damage = (message, entryHash = null) => new SingularityFlowError(`${message} Run ${LEDGER_VERIFY_COMMAND} to see every damaged or missing entry; nothing was changed.`, {
    code: 'LEDGER_CHAIN_INVALID', details: { namespace, snapshot, ...(entryHash ? { entryHash } : {}), nextAction: LEDGER_VERIFY_COMMAND }
  });
  const stopped = (error, page) => Object.freeze({
    namespace, snapshot, entries: Object.freeze(page), complete: false, continuation: null,
    damaged: Object.freeze({ code: error.code, message: error.message, entryHash: error.details.entryHash ?? null, nextAction: LEDGER_VERIFY_COMMAND })
  });
  if (!held.head) {
    if (continuation != null) {
      throw new SingularityFlowError(`Ledger snapshot ${snapshot} is no longer held here. Start the listing again.`, {
        code: 'LEDGER_CONTINUATION_UNAVAILABLE', details: { namespace, snapshot }
      });
    }
    const error = damage(`Ledger snapshot ${snapshot} is missing its head record.`);
    if (stopAtDamage) return stopped(error, []);
    throw error;
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
      const error = damage(`Ledger snapshot ${snapshot} has a ${bytes === undefined ? 'missing' : 'corrupt'} entry ${cursor}.`, cursor);
      if (stopAtDamage) return stopped(error, page);
      throw error;
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

/**
 * Every entry file one snapshot holds, read without following the chain, for a reader that must
 * not miss a subject behind damage the chain cannot cross (an ID allocation). What it reads can only
 * add to what is taken, never vouch for anything. `complete` is false when an entry file does not
 * parse, or the head or an entry names a hash no file holds: then nothing proves the IDs are all here.
 */
export function ledgerEntriesBeyondChain(root, snapshot) {
  const held = ledgerAtSnapshot(root, snapshot);
  const hashes = new Set();
  const entries = [];
  let complete = Boolean(held.head);
  for (const [file, contents] of held.entries) {
    if (!file.endsWith('.json')) continue;
    hashes.add(path.posix.basename(file, '.json'));
    try { entries.push(readRecord('ledger-entry', contents).record); } catch { complete = false; }
  }
  const named = [held.head?.entryHash, ...entries.map((entry) => entry?.parentEntryHash)].filter(Boolean);
  if (named.some((hash) => !hashes.has(hash))) complete = false;
  return Object.freeze({ entries: Object.freeze(entries), complete });
}
