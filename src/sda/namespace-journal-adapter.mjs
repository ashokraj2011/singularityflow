/** Namespace protocol coordinator. All persistence is supplied by the trusted journal port. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  addressIdentity, assertNamespaceBinding, assertNamespaceNotCancelled,
  namespaceAddress, namespaceError, namespaceIdentifier, namespaceListQuery,
  namespaceScope, namespaceStoreDescriptor, namespaceTransaction, namespaceTransactionIdentity
} from './namespace/index.mjs';
import { exactObject } from './namespace/values.mjs';
import {attachNamespaceReadBatch,NAMESPACE_READ_BATCH_PROFILE} from './namespace/read-batch.mjs';
import { namespaceJournalManifest, namespaceJournalObservation, namespaceJournalReceipt,
  namespaceJournalAcceptance, namespaceJournalRecord } from './namespace/journal-contract.mjs';

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

/** The journal and clock are trusted application dependencies, never engine operation inputs. */
export function createJournalNamespaceStore({ descriptor: supplied, journal, snapshotTtlMs = 1_800_000,
  maxConcurrencyRetries = 32, snapshotPrefix = 'journal', clockLabel = 'namespace' }, { now = Date.now } = {}) {
  exactObject(supplied, ['id', 'contract', 'qualification', 'binding', 'capabilities', 'limits']);
  const { contract, ...profile } = supplied;
  const descriptor = namespaceStoreDescriptor(profile);
  if (contract !== descriptor.contract) throw namespaceError('Unsupported namespace protocol.', 'SDA_NAMESPACE_UNSUPPORTED');
  if (typeof now !== 'function') throw namespaceError('The namespace clock port must be a function.');
  if (!Number.isSafeInteger(snapshotTtlMs) || snapshotTtlMs < 1 || snapshotTtlMs > 86_400_000
    || !Number.isSafeInteger(maxConcurrencyRetries) || maxConcurrencyRetries < 1 || maxConcurrencyRetries > 1024) {
    throw namespaceError('Namespace retention and contention bounds must be explicit positive integers.');
  }
  namespaceIdentifier(snapshotPrefix, 'Snapshot prefix');
  namespaceIdentifier(clockLabel, 'Clock label');
  const manifest = namespaceJournalManifest(journal, descriptor.binding);
  const readView = async (scope, options) => namespaceJournalObservation(await journal.read(scope, options), scope, options?.through ?? null);
  const secret = Buffer.from(manifest.cursorKey, 'base64url');
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + snapshotTtlMs)) {
      throw namespaceError(`The ${clockLabel} clock did not return a valid timestamp.`, 'SDA_NAMESPACE_UNAVAILABLE');
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

  const store=Object.freeze({
    descriptor,
    async read(scope, namespace, key, { signal } = {}) {
      const normalizedScope = preflight(scope, signal);
      const address = namespaceAddress({ namespace, key });
      assertNamespaceBinding(descriptor, namespace);
      const { state } = await readView(normalizedScope);
      const record = state.records.get(addressIdentity(address));
      return detached(record ? { status: 'present', record: namespaceJournalRecord(record, address, descriptor.limits) }
        : { status: 'missing', record: null });
    },
    async list(scope, namespace, input, { signal } = {}) {
      const normalizedScope = preflight(scope, signal);
      assertNamespaceBinding(descriptor, namespace);
      const query = namespaceListQuery(input, descriptor.limits);
      const context = JSON.stringify([manifest.storeId, descriptor.binding, normalizedScope, namespace, query.prefix, query.limit]);
      const cursor = query.continuation === null ? null : readCursor(query.continuation, context);
      const current = await readView(normalizedScope);
      const view = cursor ? await readView(normalizedScope, { through: cursor.sequence }) : current;
      if (cursor && cursor.sha256 !== view.sha256) {
        throw namespaceError('The retained namespace snapshot no longer has its issued binding.', 'SDA_NAMESPACE_CORRUPT');
      }
      const records = [...view.state.records.values()]
        .filter(record => record.namespace === namespace && record.key.startsWith(query.prefix))
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const offset = cursor?.offset ?? 0, entries = records.slice(offset, offset + query.limit)
        .map(record => namespaceJournalRecord(record, { namespace }, descriptor.limits));
      const next = offset + entries.length, complete = next >= records.length;
      const continuation = complete ? null : issueCursor({ schemaVersion: 1, context,
        sequence: view.sequence, sha256: view.sha256, offset: next, expiresAt: cursor?.expiresAt ?? clock() + snapshotTtlMs });
      return detached({ snapshot: `${snapshotPrefix}:${manifest.storeId}:${view.sequence}:${view.sha256 ?? 'empty'}`,
        entries, complete, continuation });
    },
    async transact(scope, input, { signal } = {}) {
      const normalizedScope = preflight(scope, signal);
      // Detach the caller's values synchronously, before the first storage await.
      const transaction = namespaceTransaction(input, descriptor.limits);
      const requestDigest = createHash('sha256').update(namespaceTransactionIdentity(normalizedScope, transaction, descriptor.limits)).digest('hex');
      for (const value of [...transaction.preconditions, ...transaction.changes, ...transaction.events]) {
        assertNamespaceBinding(descriptor, value.namespace);
      }
      for (let attempt = 0; attempt < maxConcurrencyRetries; attempt += 1) {
        const observed = await readView(normalizedScope);
        assertNamespaceNotCancelled(signal);
        const accepted = namespaceJournalAcceptance(await journal.append(normalizedScope, observed, transaction, { signal }),
          normalizedScope, transaction, requestDigest);
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
      const { state } = await readView(normalizedScope);
      const operation = state.operations.get(operationId);
      if (!operation) return detached({ status: 'missing', receipt: null });
      let receipt;
      try { receipt = namespaceJournalReceipt(operation.receipt, normalizedScope, operationId); }
      catch (cause) {
        throw namespaceError('The application journal returned an invalid operation receipt.', 'SDA_NAMESPACE_UNSUPPORTED',
          { stage: 'journal-receipt-read', operationId }, cause);
      }
      await journal.confirm(normalizedScope);
      return detached({ status: 'committed', receipt });
    },
    async verify(scope, { signal } = {}) {
      const normalizedScope = preflight(scope, signal);
      try { await readView(normalizedScope); return detached({ valid: true, errors: [] }); }
      catch (error) {
        if (error.code === 'SDA_NAMESPACE_CORRUPT') return detached({ valid: false, errors: [error.message] });
        throw error;
      }
    }
  });
  return attachNamespaceReadBatch(store,async(scope,requests,{signal}={})=>{
    const normalizedScope=preflight(scope,signal);
    for(const row of requests)if(row.kind==='record')assertNamespaceBinding(descriptor,row.namespace);
    const view=await readView(normalizedScope,{signal});assertNamespaceNotCancelled(signal);let confirm=false;
    const facts=requests.map(request=>{let result;
      if(request.kind==='record'){const address=namespaceAddress({namespace:request.namespace,key:request.key}),record=view.state.records.get(addressIdentity(address));
        result=record?{status:'present',record:namespaceJournalRecord(record,address,descriptor.limits)}:{status:'missing',record:null};
      }else{const operation=view.state.operations.get(request.operationId);result={status:'missing',receipt:null};
        if(operation){let receipt;try{receipt=namespaceJournalReceipt(operation.receipt,normalizedScope,request.operationId);}
          catch(cause){throw namespaceError('The application journal returned an invalid operation receipt.','SDA_NAMESPACE_UNSUPPORTED',{
            stage:'journal-receipt-read',operationId:request.operationId},cause);}
          result={status:'committed',receipt};confirm=true;}}
      return {request,result};});
    if(confirm)await journal.confirm(normalizedScope);assertNamespaceNotCancelled(signal);
    return detached({profile:NAMESPACE_READ_BATCH_PROFILE,scope:normalizedScope,snapshot:{sequence:view.sequence,sha256:view.sha256},facts});
  });
}
