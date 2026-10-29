/**
 * The capability ledger as a shared-state adapter (SDA §7, SDA-AC-017).
 *
 * A wrapper, not a new store: every operation is the ledger's own. An append is
 * `appendLedgerIntent` (leased push, bounded retry on a moved state tip, idempotency by key and
 * payload digest); a page is `ledgerPage` (one snapshot commit per listing); verification is
 * `verifyLedger`. Cancellation is honoured before an operation starts. Once a push may have
 * reached the remote, the outcome is the push's, never a false `cancelled`.
 */
import { appendLedgerIntent, createLedgerIntent, verifyLedger } from '../ledger.mjs';
import { LEDGER_PAGE_MAX, ledgerPage } from '../ledger-pages.mjs';
import { normalizeLedgerConfig } from '../ledger-config.mjs';
import { adapterDescriptor, ADAPTER_CAPABILITIES, assertNotCancelled } from './shared-state-contract.mjs';

function contractEntry(entry) {
  return Object.freeze({
    id: entry.eventId, hash: entry.hash, eventType: entry.eventType, subject: entry.subject,
    payload: entry.payload, sourceRevision: entry.transport?.publishedCommit ?? null,
    payloadDigest: entry.payloadDigest ?? null
  });
}

export function createGitLedgerAdapter(root, rawConfig, { env = process.env, transportRemote = undefined } = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  return Object.freeze({
    descriptor: adapterDescriptor({
      id: 'git-ledger', qualification: 'production', capabilities: ADAPTER_CAPABILITIES,
      limits: { maxPage: LEDGER_PAGE_MAX }
    }),

    async append(event, { signal = null } = {}) {
      assertNotCancelled(signal, 'append');
      const intent = createLedgerIntent({
        eventType: event.eventType,
        capabilityId: event.capabilityId ?? `story-${event.subject.workId}`,
        subject: event.subject,
        actor: event.actor,
        payload: event.payload ?? {}
      });
      const result = await appendLedgerIntent(root, config, intent, event.sourceRevision, { env, transportRemote });
      return result.duplicate
        ? Object.freeze({ status: 'duplicate', id: result.eventId, sequence: result.sequence, comparison: result.idempotency })
        : Object.freeze({ status: 'accepted', id: result.eventId, sequence: result.sequence });
    },

    async page({ limit = 100, continuation = null } = {}, { signal = null } = {}) {
      assertNotCancelled(signal, 'page');
      const page = await ledgerPage(root, config, { limit, continuation });
      return Object.freeze({
        snapshot: page.snapshot, entries: Object.freeze(page.entries.map(contractEntry)),
        complete: page.complete, continuation: page.continuation
      });
    },

    async verify({ signal = null } = {}) {
      assertNotCancelled(signal, 'verification');
      // Against the remote authority: another clone's pins are not in this one's cache.
      const verified = await verifyLedger(root, config);
      return Object.freeze({ valid: verified.valid, errors: Object.freeze([...verified.errors]) });
    }
  });
}
