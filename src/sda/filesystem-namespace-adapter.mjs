/** Explicit filesystem binding. Protocol coordination is shared with application/database stores. */
import { namespaceError, namespaceStoreDescriptor } from './namespace/index.mjs';
import { exactObject } from './namespace/values.mjs';
import { createJournalNamespaceStore } from './namespace-journal-adapter.mjs';
import { openFilesystemNamespaceJournal } from './filesystem-namespace-journal.mjs';

/** `now` is a trusted host clock port, never an operation input or an approval authority. */
export async function createFilesystemNamespaceStore(options, { now = Date.now } = {}) {
  exactObject(options, ['root', 'binding'], ['create', 'limits', 'snapshotTtlMs', 'maxConcurrencyRetries'], 'Filesystem binding');
  if (typeof now !== 'function') throw namespaceError('The filesystem clock port must be a function.');
  const { root, binding, create = false, limits, snapshotTtlMs = 1_800_000, maxConcurrencyRetries = 32 } = options;
  if (!Number.isSafeInteger(snapshotTtlMs) || snapshotTtlMs < 1 || snapshotTtlMs > 86_400_000
    || !Number.isSafeInteger(maxConcurrencyRetries) || maxConcurrencyRetries < 1 || maxConcurrencyRetries > 1024) {
    throw namespaceError('Filesystem retention and contention bounds must be explicit positive integers.');
  }
  const descriptor = namespaceStoreDescriptor({ id: 'filesystem-namespace', qualification: 'production', binding, limits });
  const journal = await openFilesystemNamespaceJournal({ root, binding: descriptor.binding, create, limits: descriptor.limits });
  return createJournalNamespaceStore({ descriptor, journal, snapshotTtlMs, maxConcurrencyRetries,
    snapshotPrefix: 'fs', clockLabel: 'filesystem' }, { now });
}
