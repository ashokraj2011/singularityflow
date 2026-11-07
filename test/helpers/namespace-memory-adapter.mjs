/** Test-only reference implementation. Never packaged or registered as a production authority. */
import { createHash } from 'node:crypto';
import { compactCanonicalJson } from '../../src/records.mjs';
import {
  addressIdentity, assertNamespaceBinding, assertNamespaceNotCancelled, namespaceAddress,
  namespaceError, namespaceIdentifier, namespaceIdentityJson, namespaceListQuery,
  namespaceScope, namespaceStoreDescriptor, namespaceTransaction, namespaceTransactionIdentity
} from '../../src/sda/namespace/index.mjs';

let instances = 0;
const hash = value => createHash('sha256').update(compactCanonicalJson(value)).digest('hex');
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
const empty = () => ({ revision: 0, records: new Map(), events: new Map(), operations: new Map() });

export function createNamespaceMemoryFixture(options = {}) {
  return memoryFixture(options, new Map());
}

function memoryFixture({ binding = { kind: 'shared' }, limits = { maxPage: 2 } } = {}, backend) {
  const instance = ++instances;
  const descriptor = namespaceStoreDescriptor({ id: 'namespace-memory-fixture', qualification: 'test-only', binding, limits });
  const faults = new Map();
  const snapshots = new Map();
  const cursors = new Map();
  let sequence = 0;
  let loseResponse = false;
  let afterCommit = null;
  const projectKey = scope => JSON.stringify([descriptor.binding, namespaceScope(scope)]);
  const project = scope => backend.get(projectKey(scope)) ?? empty();
  const snapshot = value => ({ body: value, digest: hash(value) });
  const errors = state => [
    ...[...state.records].filter(([, value]) => value.digest !== hash(value.body)).map(([key]) => `record:${key}`),
    ...[...state.events].filter(([, value]) => value.digest !== hash(value.body)).map(([key]) => `event:${key}`),
    ...[...state.operations].filter(([, value]) => value.digest !== hash(value.body)).map(([key]) => `operation:${key}`)
  ];
  const verified = scope => {
    const state = project(scope);
    if (errors(state).length) throw namespaceError('Stored namespace data failed integrity verification.', 'SDA_NAMESPACE_CORRUPT');
    return state;
  };
  const preflight = (method, scope, signal) => {
    assertNamespaceNotCancelled(signal);
    const normalized = namespaceScope(scope);
    if (faults.has(method)) {
      const error = faults.get(method);
      faults.delete(method);
      throw error;
    }
    return normalized;
  };

  const adapter = Object.freeze({
    descriptor,

    async read(scope, namespace, key, { signal } = {}) {
      preflight('read', scope, signal);
      const address = namespaceAddress({ namespace, key });
      assertNamespaceBinding(descriptor, namespace);
      const found = verified(scope).records.get(addressIdentity(address));
      return detached(found ? { status: 'present', record: found.body } : { status: 'missing', record: null });
    },

    async list(scope, namespace, input, { signal } = {}) {
      const normalizedScope = preflight('list', scope, signal);
      assertNamespaceBinding(descriptor, namespace);
      const query = namespaceListQuery(input, descriptor.limits);
      verified(scope);
      const context = namespaceIdentityJson({ scope: normalizedScope, namespace, prefix: query.prefix, limit: query.limit });
      let view;
      let offset = 0;
      if (query.continuation !== null) {
        const cursor = cursors.get(query.continuation);
        if (!cursor || cursor.context !== context) throw namespaceError('Continuation belongs to another query.', 'SDA_NAMESPACE_CURSOR_INVALID');
        view = snapshots.get(cursor.snapshot);
        if (!view) throw namespaceError('The retained snapshot has expired.', 'SDA_NAMESPACE_CURSOR_EXPIRED');
        offset = cursor.offset;
      } else {
        const records = [...project(scope).records.values()].map(value => value.body)
          .filter(value => value.namespace === namespace && value.key.startsWith(query.prefix))
          .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        const id = `snapshot-${instance}-${++sequence}`;
        view = { id, records: detached(records) };
        snapshots.set(id, view);
      }
      const entries = view.records.slice(offset, offset + query.limit);
      const next = offset + entries.length;
      const complete = next >= view.records.length;
      const continuation = complete ? null : `cursor-${instance}-${++sequence}`;
      if (continuation) cursors.set(continuation, { context, snapshot: view.id, offset: next });
      return detached({ snapshot: view.id, entries, complete, continuation });
    },

    async transact(scope, input, { signal } = {}) {
      const normalizedScope = preflight('transact', scope, signal);
      const transaction = namespaceTransaction(input, descriptor.limits);
      for (const address of [...transaction.preconditions, ...transaction.changes, ...transaction.events]) {
        assertNamespaceBinding(descriptor, address.namespace);
      }
      const identity = namespaceTransactionIdentity(scope, transaction, descriptor.limits);
      // A concurrent caller or cancellation can arrive before the conditional commit.
      await Promise.resolve();
      preflight('beforeCommit', scope, signal);
      const state = verified(scope);
      const previous = state.operations.get(transaction.operationId);
      if (previous) {
        if (previous.body.identity !== identity) throw namespaceError('Operation ID already records another intent.', 'SDA_NAMESPACE_OPERATION_ID_REUSED');
        return detached({ status: 'committed', replayed: true, receipt: previous.body.receipt });
      }
      for (const condition of transaction.preconditions) {
        const current = state.records.get(addressIdentity(condition))?.body.version ?? null;
        if (current !== condition.version) throw namespaceError('The record revision changed.', 'SDA_NAMESPACE_REVISION_CONFLICT', {
          namespace: condition.namespace, key: condition.key, expectedVersion: condition.version, currentVersion: current
        });
      }
      const records = new Map(state.records);
      const events = new Map(state.events);
      const revision = `memory/${instance}/${normalizedScope.projectId}/revision-${state.revision + 1}`;
      const written = [];
      for (const change of transaction.changes) {
        const key = addressIdentity(change);
        if (records.get(key)?.body.immutable) throw namespaceError('An immutable version cannot be replaced or deleted.', 'SDA_NAMESPACE_IMMUTABLE');
        const version = change.op === 'delete' ? null : `${revision}/record-${written.length + 1}`;
        if (change.op === 'delete') records.delete(key);
        else records.set(key, snapshot(detached({ namespace: change.namespace, key: change.key, version,
          immutable: change.immutable, value: change.value })));
        written.push({ namespace: change.namespace, key: change.key, version });
      }
      for (const event of transaction.events) {
        if (events.has(event.eventId)) throw namespaceError('Event ID already belongs to another transaction.', 'SDA_NAMESPACE_EVENT_ID_REUSED');
        events.set(event.eventId, snapshot(detached({ ...event, operationId: transaction.operationId, revision })));
      }
      const receipt = detached({ operationId: transaction.operationId, scope: normalizedScope, revision,
        requestDigest: createHash('sha256').update(identity).digest('hex'),
        records: written, eventIds: transaction.events.map(value => value.eventId) });
      const operations = new Map(state.operations);
      operations.set(transaction.operationId, snapshot({ identity, receipt }));
      // One publication point: records, events, the operation's identity and receipt all advance.
      backend.set(projectKey(scope), { revision: state.revision + 1, records, events, operations });
      const callback = afterCommit;
      afterCommit = null;
      callback?.();
      if (loseResponse) {
        loseResponse = false;
        const cause = Object.assign(new Error('The commit response timed out.'), { code: 'ETIMEDOUT' });
        throw namespaceError('The commit may have completed; inspect this operation.', 'SDA_NAMESPACE_OUTCOME_UNKNOWN',
          { operationId: transaction.operationId, stage: 'acknowledgement', timedOut: true }, cause);
      }
      return detached({ status: 'committed', replayed: false, receipt });
    },

    async inspectOperation(scope, operationId, { signal } = {}) {
      preflight('inspectOperation', scope, signal);
      namespaceIdentifier(operationId, 'Operation ID');
      const found = verified(scope).operations.get(operationId);
      return detached(found ? { status: 'committed', receipt: found.body.receipt } : { status: 'missing', receipt: null });
    },

    async verify(scope, { signal } = {}) {
      preflight('verify', scope, signal);
      const found = errors(project(scope));
      return detached({ valid: found.length === 0, errors: found });
    }
  });

  return {
    adapter,
    controls: {
      failNext(method, error) { faults.set(method, error); },
      loseNextCommitResponse() { loseResponse = true; },
      afterNextCommit(callback) { afterCommit = callback; },
      expireSnapshots() { snapshots.clear(); },
      corruptRecord(scope, namespace, key) {
        const state = project(scope), identity = addressIdentity({ namespace, key });
        const previous = state.records.get(identity);
        state.records.set(identity, { ...previous, body: { ...previous.body, value: 'tampered' } });
      },
      events(scope) { return detached([...verified(scope).events.values()].map(value => value.body)); },
      receipts(scope) { return detached([...verified(scope).operations.values()].map(value => value.body.receipt)); },
      fork(binding = descriptor.binding) { return memoryFixture({ binding, limits: descriptor.limits }, backend); }
    },
    cleanup() { backend.clear(); snapshots.clear(); cursors.clear(); faults.clear(); }
  };
}
