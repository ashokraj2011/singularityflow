/** Explicit SQLite binding for new application projects. Installed Git authority is never selected. */
import { namespaceError, namespaceStoreDescriptor } from './namespace/index.mjs';
import { exactObject } from './namespace/values.mjs';
import { createJournalNamespaceStore } from './namespace-journal-adapter.mjs';
import { openSqliteNamespaceJournal } from './sqlite-namespace-journal.mjs';
import {bindNamespaceReadBatch} from './namespace/read-batch.mjs';

export async function createSqliteNamespaceStore(options, { now = Date.now } = {}) {
  exactObject(options, ['filename', 'binding'], ['create', 'limits', 'snapshotTtlMs', 'maxConcurrencyRetries', 'busyTimeoutMs'], 'Database binding');
  const { filename, binding, create = false, limits, snapshotTtlMs = 1_800_000, maxConcurrencyRetries = 32, busyTimeoutMs } = options;
  if (typeof now !== 'function' || !Number.isSafeInteger(snapshotTtlMs) || snapshotTtlMs < 1 || snapshotTtlMs > 86_400_000
    || !Number.isSafeInteger(maxConcurrencyRetries) || maxConcurrencyRetries < 1 || maxConcurrencyRetries > 1024) {
    throw namespaceError('Database clock, retention and contention policies must be valid and bounded.');
  }
  const descriptor = namespaceStoreDescriptor({ id: 'sqlite-namespace', qualification: 'production', binding, limits });
  const journal = await openSqliteNamespaceJournal({ filename, binding: descriptor.binding, create, limits: descriptor.limits, busyTimeoutMs });
  try {
    const adapter = createJournalNamespaceStore({ descriptor, journal, snapshotTtlMs, maxConcurrencyRetries,
      snapshotPrefix: 'sql', clockLabel: 'database' }, { now });
    return bindNamespaceReadBatch(adapter,Object.freeze({ ...adapter, close: () => journal.close() }));
  } catch (cause) { try { journal.close(); } catch {} throw cause; }
}
