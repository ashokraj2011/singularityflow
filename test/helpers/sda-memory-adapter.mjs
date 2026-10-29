/**
 * A deterministic in-memory event-log adapter for the shared-state conformance suite (SDA-AC-017).
 *
 * Test-only by qualification, and by place: it lives under test/, which no installed build carries,
 * and selectSharedStateAuthority refuses it. It follows the Git ledger's rules so the same suite
 * holds both to one behaviour: a write lands only on the head it observed, a moved head is retried a
 * bounded number of times, a key's repeat compares the payload digest, and a listing reads one
 * snapshot to its end.
 */
import { createHash } from 'node:crypto';
import { SingularityFlowError } from '../../src/util.mjs';
import { adapterDescriptor, ADAPTER_CAPABILITIES, assertNotCancelled } from '../../src/sda/shared-state-contract.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const operationKey = (event) => [event.subject.workId, event.eventType, event.subject.phase ?? '-',
  event.subject.generation ?? '-', event.sourceRevision].join(' · ');
const payloadDigest = (event) => sha256(canonical({
  eventType: event.eventType, capabilityId: event.capabilityId ?? `story-${event.subject.workId}`,
  subject: event.subject, actor: event.actor ?? null, payload: event.payload ?? {}
}));

export function createMemoryAdapter({ namespace = 'memory/state', maxPage = 1000, retries = 3 } = {}) {
  const chain = [];
  const byKey = new Map();
  const snapshots = new Map();
  let pending = null;
  let counter = 0;

  const write = (event, observedLength) => {
    if (chain.length !== observedLength) return null;
    const entry = {
      id: `evt-${String(++counter).padStart(4, '0')}`, eventType: event.eventType,
      capabilityId: event.capabilityId ?? `story-${event.subject.workId}`, subject: event.subject,
      actor: event.actor ?? null, payload: event.payload ?? {}, sourceRevision: event.sourceRevision,
      payloadDigest: payloadDigest(event), parent: chain.at(-1)?.hash ?? null
    };
    entry.hash = sha256(canonical(entry));
    chain.push(Object.freeze(entry));
    byKey.set(operationKey(event), entry);
    return entry;
  };
  const refuse = (message, code, outcomeClass = null) => { throw new SingularityFlowError(message, { code, outcomeClass }); };

  return Object.freeze({
    descriptor: adapterDescriptor({
      id: 'deterministic-memory', qualification: 'test-only', capabilities: ADAPTER_CAPABILITIES, limits: { maxPage }
    }),

    /** Fixture hook: another writer's event lands between this adapter's next observation and write. */
    concurrentAppend(event) { pending = event; },

    /** Fixture hook: overwrite one stored entry's payload digest. */
    forgeDigest(id) {
      const index = chain.findIndex((entry) => entry.id === id);
      chain[index] = Object.freeze({ ...chain[index], payloadDigest: 'f'.repeat(64) });
    },

    otherNamespace() { return createMemoryAdapter({ namespace: `${namespace}-other`, maxPage, retries }); },

    async append(event, { signal = null } = {}) {
      assertNotCancelled(signal, 'append');
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const recorded = byKey.get(operationKey(event));
        if (recorded) {
          if (recorded.payloadDigest !== payloadDigest(event)) {
            refuse('The log already holds this operation with different content.', 'LEDGER_EVENT_PAYLOAD_CONFLICT');
          }
          return Object.freeze({ status: 'duplicate', id: recorded.id, sequence: chain.indexOf(recorded) + 1, comparison: 'key-and-payload' });
        }
        const observed = chain.length;
        if (pending) {
          const other = pending;
          pending = null;
          write(other, chain.length);
        }
        const entry = write(event, observed);
        if (entry) return Object.freeze({ status: 'accepted', id: entry.id, sequence: chain.length });
      }
      return refuse('The log kept moving; nothing was appended.', 'MEMORY_APPEND_HEAD_MOVED', 'REVISION_CONFLICT');
    },

    async page({ limit = 100, continuation = null } = {}, { signal = null } = {}) {
      assertNotCancelled(signal, 'page');
      if (!Number.isInteger(limit) || limit < 1 || limit > maxPage) refuse(`A page holds 1 to ${maxPage} entries.`, 'LEDGER_PAGE_LIMIT_INVALID');
      let snapshot;
      let offset = 0;
      if (continuation != null) {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.from(String(continuation).replace(/^mp1\./u, ''), 'base64url').toString('utf8')); } catch { parsed = null; }
        if (!String(continuation).startsWith('mp1.') || parsed?.n !== namespace || !Number.isSafeInteger(parsed?.o)) {
          refuse('The continuation is not one this log issued.', 'LEDGER_CONTINUATION_INVALID');
        }
        if (!snapshots.has(parsed.s)) refuse('The snapshot is no longer held.', 'LEDGER_CONTINUATION_UNAVAILABLE');
        ({ s: snapshot, o: offset } = parsed);
      } else {
        snapshot = `snapshot-${chain.length}-${chain.at(-1)?.hash ?? 'empty'}`;
        snapshots.set(snapshot, Object.freeze([...chain].reverse()));
      }
      const view = snapshots.get(snapshot);
      const entries = view.slice(offset, offset + limit);
      for (const entry of entries) {
        if (entry.payloadDigest !== payloadDigest(entry)) refuse(`Entry ${entry.id} is corrupt.`, 'LEDGER_CHAIN_INVALID');
      }
      const next = offset + entries.length;
      return Object.freeze({
        snapshot, complete: next >= view.length,
        entries: Object.freeze(entries.map((entry) => Object.freeze({
          id: entry.id, hash: entry.hash, eventType: entry.eventType, subject: entry.subject, payload: entry.payload,
          sourceRevision: entry.sourceRevision, payloadDigest: entry.payloadDigest
        }))),
        continuation: next >= view.length ? null
          : `mp1.${Buffer.from(JSON.stringify({ n: namespace, s: snapshot, o: next })).toString('base64url')}`
      });
    },

    async verify({ signal = null } = {}) {
      assertNotCancelled(signal, 'verification');
      const errors = chain.filter((entry) => entry.payloadDigest !== payloadDigest(entry))
        .map((entry) => `Entry ${entry.id} has an invalid payload digest.`);
      return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
    }
  });
}
