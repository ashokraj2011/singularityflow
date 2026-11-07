/** Namespace protocol over an explicit local journal. Does not select or migrate installed authority. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  addressIdentity, assertNamespaceBinding, assertNamespaceNotCancelled,
  namespaceAddress, namespaceError, namespaceIdentifier, namespaceListQuery,
  namespaceScope, namespaceStoreDescriptor, namespaceTransaction
} from './namespace/index.mjs';
import { exactObject } from './namespace/values.mjs';
import { openFilesystemNamespaceJournal } from './filesystem-namespace-journal.mjs';

const detached = value => {
  const freeze = item => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(structuredClone(value));
};

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
  const secret = Buffer.from(journal.manifest.cursorKey, 'base64url');
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + snapshotTtlMs)) {
      throw namespaceError('The filesystem clock did not return a valid timestamp.', 'SDA_NAMESPACE_UNAVAILABLE');
    }
    return value;
  };
  const signature = value => createHmac('sha256', secret).update(value).digest('base64url');
  const issueCursor = value => {
    const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    return `${payload}.${signature(payload)}`;
  };
  const cursorError = () => namespaceError('Continuation belongs to another query or was not issued by this store.', 'SDA_NAMESPACE_CURSOR_INVALID');
  function readCursor(token, context) {
    const parts = token.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/u.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/u.test(parts[1])) throw cursorError();
    const expected = Buffer.from(signature(parts[0]), 'ascii'), observed = Buffer.from(parts[1], 'ascii');
    if (!timingSafeEqual(expected, observed)) throw cursorError();
    let value;
    try {
      value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      exactObject(value, ['schemaVersion', 'context', 'sequence', 'sha256', 'offset', 'expiresAt']);
      if (value.schemaVersion !== 1 || value.context !== context // schema-transient: signed pagination token, not a durable record
        || !Number.isSafeInteger(value.sequence) || value.sequence < 1
        || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
        || !Number.isSafeInteger(value.offset) || value.offset < 1
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) throw cursorError();
    } catch { throw cursorError(); }
    if (clock() > value.expiresAt) {
      throw namespaceError('The retained namespace snapshot has expired.', 'SDA_NAMESPACE_CURSOR_EXPIRED');
    }
    return value;
  }
  function preflight(scope, signal) {
    assertNamespaceNotCancelled(signal);
    return namespaceScope(scope);
  }

  return Object.freeze({
    descriptor,
    async read(scope, namespace, key, { signal } = {}) {
      const normalizedScope = preflight(scope, signal);
      const address = namespaceAddress({ namespace, key });
      assertNamespaceBinding(descriptor, namespace);
      const { state } = await journal.read(normalizedScope);
      const record = state.records.get(addressIdentity(address));
      return detached(record ? { status: 'present', record } : { status: 'missing', record: null });
    },
    async list(scope, namespace, input, { signal } = {}) {
      const normalizedScope = preflight(scope, signal);
      assertNamespaceBinding(descriptor, namespace);
      const query = namespaceListQuery(input, descriptor.limits);
      const context = JSON.stringify([journal.manifest.storeId, descriptor.binding, normalizedScope, namespace, query.prefix, query.limit]);
      const cursor = query.continuation === null ? null : readCursor(query.continuation, context);
      const current = await journal.read(normalizedScope);
      const view = cursor ? await journal.read(normalizedScope, { through: cursor.sequence }) : current;
      if (cursor && cursor.sha256 !== view.sha256) {
        throw namespaceError('The retained namespace snapshot no longer has its issued binding.', 'SDA_NAMESPACE_CORRUPT');
      }
      const records = [...view.state.records.values()]
        .filter(record => record.namespace === namespace && record.key.startsWith(query.prefix))
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const offset = cursor?.offset ?? 0, entries = records.slice(offset, offset + query.limit);
      const next = offset + entries.length, complete = next >= records.length;
      const continuation = complete ? null : issueCursor({ schemaVersion: 1, context,
        sequence: view.sequence, sha256: view.sha256, offset: next, expiresAt: cursor?.expiresAt ?? clock() + snapshotTtlMs });
      return detached({ snapshot: `fs:${journal.manifest.storeId}:${view.sequence}:${view.sha256 ?? 'empty'}`,
        entries, complete, continuation });
    },
    async transact(scope, input, { signal } = {}) {
      const normalizedScope = preflight(scope, signal);
      // Detach the caller's values synchronously, before the first filesystem await.
      const transaction = namespaceTransaction(input, descriptor.limits);
      for (const value of [...transaction.preconditions, ...transaction.changes, ...transaction.events]) {
        assertNamespaceBinding(descriptor, value.namespace);
      }
      for (let attempt = 0; attempt < maxConcurrencyRetries; attempt += 1) {
        const observed = await journal.read(normalizedScope);
        assertNamespaceNotCancelled(signal);
        const accepted = await journal.append(normalizedScope, observed, transaction, { signal });
        if (!accepted.accepted) continue;
        if (accepted.replayed) await journal.confirm(normalizedScope);
        return detached({ status: 'committed', replayed: accepted.replayed, receipt: accepted.receipt });
      }
      throw namespaceError('The namespace journal remained busy; retry using the same operation ID.',
        'SDA_NAMESPACE_UNAVAILABLE', { stage: 'contention', operationId: transaction.operationId, attempts: maxConcurrencyRetries });
    },
    async inspectOperation(scope, operationId, { signal } = {}) {
      const normalizedScope = preflight(scope, signal);
      namespaceIdentifier(operationId, 'Operation ID');
      const { state } = await journal.read(normalizedScope);
      const operation = state.operations.get(operationId);
      if (!operation) return detached({ status: 'missing', receipt: null });
      await journal.confirm(normalizedScope);
      return detached({ status: 'committed', receipt: operation.receipt });
    },
    async verify(scope, { signal } = {}) {
      const normalizedScope = preflight(scope, signal);
      try { await journal.read(normalizedScope); return detached({ valid: true, errors: [] }); }
      catch (error) {
        if (error.code === 'SDA_NAMESPACE_CORRUPT') return detached({ valid: false, errors: [error.message] });
        throw error;
      }
    }
  });
}
