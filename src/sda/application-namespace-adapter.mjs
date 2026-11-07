/** Application-owned journal binding; no discovery, connection construction or implicit authority. */
import { namespaceStoreDescriptor } from './namespace/contract.mjs';
import { exactObject } from './namespace/values.mjs';
import { createJournalNamespaceStore } from './namespace-journal-adapter.mjs';

export function createApplicationNamespaceStore(options, { journal, now = Date.now } = {}) {
  exactObject(options, ['id', 'qualification', 'binding'], ['limits', 'snapshotTtlMs', 'maxConcurrencyRetries'], 'Application binding');
  const { id, qualification, binding, limits, snapshotTtlMs, maxConcurrencyRetries } = options;
  const descriptor = namespaceStoreDescriptor({ id, qualification, binding, limits });
  return createJournalNamespaceStore({ descriptor, journal, snapshotTtlMs, maxConcurrencyRetries,
    snapshotPrefix: 'application', clockLabel: 'application' }, { now });
}
