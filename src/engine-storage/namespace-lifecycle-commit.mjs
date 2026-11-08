/** Internal persistence port for already-admitted engine transitions. No policy bypass or discovery. */
import { createHash } from 'node:crypto';
import { createNamespaceLifecycleObserver,namespaceLifecycleStoryKey,validWorkId } from './namespace-lifecycle-reader.mjs';
export { namespaceLifecycleStoryKey } from './namespace-lifecycle-reader.mjs';
import { ENGINE_OPERATIONS } from '../engine-sdk/index.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { validateNamespaceStore, namespaceLimits } from '../sda/namespace/contract.mjs';
import { namespaceJson, namespaceIdentityJson, namespaceIdentifier, namespaceScope, namespaceRevision, exactObject } from '../sda/namespace/values.mjs';
import { namespaceTransaction, namespaceTransactionIdentity } from '../sda/namespace/transaction.mjs';
import { contentReference, validateContentStore } from '../sda/content/contract.mjs';
import { LIFECYCLE_AUTHORITY_KEY, LIFECYCLE_STATE_MAXIMUM_BYTES, lifecycleAuthority, lifecycleConfiguration,
  lifecycleHead, lifecyclePrepared, lifecycleRecord, lifecycleState } from './namespace-lifecycle-contract.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => hash(namespaceIdentityJson(value));
const error = (message, code, details = null, cause = undefined) => new SingularityFlowError(message, { code, details, cause });
const same = (a,b) => namespaceIdentityJson(a) === namespaceIdentityJson(b);
const sameRef = (a,b) => a.namespace === b.namespace && a.sha256 === b.sha256 && a.bytes === b.bytes;
const writes = new Set(ENGINE_OPERATIONS.filter(op => (!op.subject || op.subject === 'story') && op.effect !== 'read'
  && op.effect !== 'story-creation'
  && (op.stages.includes('commit') || op.stages.includes('apply'))).map(op => op.id));
function cancelled(signal) { if (signal?.aborted) throw error('The lifecycle operation was cancelled before its next effect.', 'ENGINE_OPERATION_CANCELLED'); }

/** Trusted construction only; installed Git compositions never call this factory. */
export function createNamespaceLifecycleCommitter({ records, content, scope, workId, authority } = {}) {
  validateNamespaceStore(records); validateContentStore(content); scope = namespaceScope(scope); workId = validWorkId(workId);
  exactObject(authority, ['id','epoch']);
  authority = Object.freeze({ id: namespaceIdentifier(authority.id, 'Authority ID'), epoch: authority.epoch });
  if (!Number.isSafeInteger(authority.epoch) || authority.epoch < 1 || records.descriptor.binding.kind !== 'shared'
    || content.descriptor.binding.kind !== 'shared') throw error('Lifecycle persistence needs explicit shared ports and an authority epoch.', 'ENGINE_INPUT_INVALID');
  const recordId = records.descriptor.id, contentId = content.descriptor.id, limits = namespaceLimits(records.descriptor.limits);
  const read = records.read.bind(records), transact = records.transact.bind(records), inspectOperation = records.inspectOperation.bind(records);
  const putContent = content.put.bind(content), readContent = content.read.bind(content);
  const captures = new WeakMap(), headKey = namespaceLifecycleStoryKey(workId);
  const token = operationId => identity({ projectId: scope.projectId, workId, authorityId: authority.id, epoch: authority.epoch, operationId });
  const keys = operationId => { const id = token(namespaceIdentifier(operationId, 'Operation ID'));
    return { operation: `lifecycle-${id}`, prepared: `lifecycle/prepared/${id}`, manifest: `lifecycle/operations/${id}`, event: `lifecycle-${id}` }; };
  const observer=createNamespaceLifecycleObserver({records,content,scope,workId,authority});
  const {stored,record,assertAuthority,bytes,state}=observer;
  async function capture(options={}) {
    const {snapshot,basis}=await observer.capture(options);captures.set(snapshot,basis);return snapshot;
  }
  function transaction(plan) {
    const k = keys(plan.operationId), previous = plan.basis.head;
    const head = lifecycleRecord('head', { projectId: scope.projectId, workId, authorityId: authority.id, epoch: authority.epoch,
      sequence: previous.sequence + 1, configuration: previous.configuration, state: plan.state, previous: previous.state, operationId: plan.operationId });
    const manifest = lifecycleRecord('manifest', { projectId: scope.projectId, workId, authorityId: authority.id, epoch: authority.epoch,
      sequence: head.sequence, operationId: plan.operationId, operation: plan.operation, inputsSha256: plan.inputsSha256,
      configuration: previous.configuration, previous: previous.state, state: plan.state, evidence: plan.evidence });
    return namespaceTransaction({ operationId: k.operation, preconditions: [
      { namespace: 'state', key: LIFECYCLE_AUTHORITY_KEY, version: plan.basis.authorityVersion },
      { namespace: 'state', key: headKey, version: plan.basis.headVersion },
      { namespace: 'config', key: previous.configuration.key, version: plan.basis.configurationVersion },
      { namespace: 'evidence', key: k.manifest, version: null }
    ], changes: [
      { op: 'put', namespace: 'state', key: headKey, immutable: false, value: head },
      { op: 'put', namespace: 'evidence', key: k.manifest, immutable: true, value: manifest }
    ], events: [{ eventId: k.event, eventType: 'engine.operation-committed', namespace: 'state',
      payload: { workId, operation: plan.operation, sequence: head.sequence, state: plan.state } }] }, limits);
  }
  const requestDigest = tx => hash(namespaceTransactionIdentity(scope, tx, limits));
  function admitPlan(value, operationId) {
    stored(lifecyclePrepared, value, workId, operationId);
    if (value.authorityId !== authority.id || value.epoch !== authority.epoch || !writes.has(value.operation)
      || value.requestDigest !== requestDigest(transaction(value))) throw error('The prepared operation has a different authority, registry operation or intent.', 'ENGINE_STORAGE_CORRUPT');
    return value;
  }
  async function checkpoint(operationId, signal) {
    const value = await record('runtime', keys(operationId).prepared, true, signal, true);
    return value ? admitPlan(value.value, operationId) : null;
  }
  const preparedResult = plan => Object.freeze({ status: 'prepared', operationId: plan.operationId, operation: plan.operation, requestDigest: plan.requestDigest });
  async function prepare(snapshot, proposal, { signal } = {}) {
    cancelled(signal); const basis = captures.get(snapshot);
    if (!basis) throw error('Prepare requires a snapshot captured by this lifecycle host.', 'ENGINE_INPUT_INVALID');
    exactObject(proposal, ['operationId','operation','inputsSha256','state','evidence']);
    namespaceIdentifier(proposal.operationId, 'Operation ID');
    if (!writes.has(proposal.operation) || typeof proposal.inputsSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(proposal.inputsSha256)
      || !(proposal.state instanceof Uint8Array)) throw error('Prepare requires a registered mutation, input digest and complete state bytes.', 'ENGINE_INPUT_INVALID');
    if (proposal.state.byteLength > LIFECYCLE_STATE_MAXIMUM_BYTES) throw error('Lifecycle state exceeds its content bound.', 'ENGINE_STORAGE_LIMIT');
    const data = Buffer.from(proposal.state); state(data, basis.head);
    const evidence = namespaceJson(proposal.evidence, { maxBytes: limits.maxValueBytes });
    const plan = lifecycleRecord('prepared', { projectId: scope.projectId, workId, authorityId: authority.id, epoch: authority.epoch,
      operationId: proposal.operationId, operation: proposal.operation, inputsSha256: proposal.inputsSha256, basis,
      state: { namespace: 'state', sha256: hash(data), bytes: data.byteLength }, evidence, requestDigest: '0'.repeat(64) });
    plan.requestDigest = requestDigest(transaction(plan)); admitPlan(plan, plan.operationId);
    const value = namespaceJson(plan, { maxBytes: limits.maxValueBytes });
    const existing = await checkpoint(value.operationId, signal);
    if (existing) {
      if (!same(existing, value)) throw error('This operation ID already has another prepared intent. Reconcile it before creating a new operation.', 'ENGINE_OPERATION_ID_REUSED', { workId, operationId: value.operationId });
      return preparedResult(existing);
    }
    cancelled(signal);
    const storedBody = await putContent(scope, 'state', data, { signal });
    if (!sameRef(contentReference(storedBody?.reference), value.state)) throw error('The content port stored another lifecycle body.', 'ENGINE_PORT_RESULT_INVALID');
    for (const reference of evidence) { cancelled(signal); await bytes(reference, 0, signal); }
    cancelled(signal); const k = keys(value.operationId);
    const preparedTransaction = namespaceTransaction({ operationId: `prepare-${token(value.operationId)}`,
      preconditions: [{ namespace: 'runtime', key: k.prepared, version: null },
        { namespace: 'state', key: LIFECYCLE_AUTHORITY_KEY, version: basis.authorityVersion },
        { namespace: 'state', key: headKey, version: basis.headVersion },
        { namespace: 'config', key: basis.head.configuration.key, version: basis.configurationVersion }],
      changes: [{ op: 'put', namespace: 'runtime', key: k.prepared, immutable: true, value }], events: [] }, limits);
    const accepted = await transact(scope, preparedTransaction, { signal });
    receipt(accepted, value, preparedTransaction);
    return preparedResult(value);
  }
  function receipt(result, plan, tx = transaction(plan)) {
    const expected = tx.changes.map(change => [change.namespace,change.key]);
    let r;
    try {
      r = namespaceJson(result?.receipt, { maxBytes: limits.maxValueBytes });
      exactObject(r, ['operationId','scope','revision','requestDigest','records','eventIds']);
      namespaceScope(r.scope); namespaceRevision(r.revision);
      if (!Array.isArray(r.records)) throw error('Receipt records must be an array.', 'ENGINE_PORT_RESULT_INVALID');
      for (const record of r.records) {
        exactObject(record, ['namespace','key','version']);
        if (namespaceRevision(record.version) === null) throw error('A put receipt needs an opaque record revision.', 'ENGINE_PORT_RESULT_INVALID');
      }
    } catch (cause) { throw error('The namespace port returned an invalid receipt. Inspect the retained operation intent.', 'ENGINE_PORT_RESULT_INVALID', { workId, operationId: plan.operationId }, cause); }
    if (result?.status !== 'committed' || !r || r.operationId !== tx.operationId || r.scope?.projectId !== scope.projectId
      || r.requestDigest !== requestDigest(tx) || r.revision === null || result.replayed !== undefined && typeof result.replayed !== 'boolean'
      || !Array.isArray(r.records) || !Array.isArray(r.eventIds) || r.records.length !== expected.length || !same(r.eventIds, tx.events.map(event => event.eventId))
      || new Set(r.records.map(record => JSON.stringify([record.namespace,record.key]))).size !== expected.length
      || !r.records.every(record => expected.some(([namespace,key]) => record.namespace === namespace && record.key === key))) {
      throw error('The namespace port returned a different operation receipt; inspect the same retained intent.', 'ENGINE_PORT_RESULT_INVALID',
        { workId, operationId: plan.operationId, requestDigest: plan.requestDigest });
    }
    return namespaceJson(r, { maxBytes: limits.maxValueBytes });
  }
  async function inspect(operationId, { signal } = {}) {
    cancelled(signal); const k = keys(operationId), plan = await checkpoint(operationId, signal);
    const observed = await inspectOperation(scope, k.operation, { signal });
    if (observed?.status === 'missing' && observed.receipt === null) return plan ? preparedResult(plan) : Object.freeze({ status: 'missing', operationId });
    if (observed?.status !== 'committed') throw error('The namespace port returned an invalid operation inspection.', 'ENGINE_PORT_RESULT_INVALID', { workId, operationId });
    if (!plan) throw error('A committed lifecycle operation has lost its prepared intent.', 'ENGINE_STORAGE_CORRUPT', { workId, operationId });
    return Object.freeze({ status: 'committed', operationId, operation: plan.operation, requestDigest: plan.requestDigest, receipt: receipt(observed, plan) });
  }
  async function commit(operationId, { signal } = {}) {
    cancelled(signal); const observed = await inspect(operationId, { signal });
    if (observed.status === 'committed') return Object.freeze({ ...observed, replayed: true });
    if (observed.status === 'missing') throw error('This lifecycle operation has no durable prepared intent.', 'ENGINE_OPERATION_NOT_PREPARED', { workId, operationId });
    const plan = await checkpoint(operationId, signal);
    const active = await record('state', LIFECYCLE_AUTHORITY_KEY, false, signal); assertAuthority(active.value);
    const config = await record('config', plan.basis.head.configuration.key, true, signal); stored(lifecycleConfiguration, config.value);
    if (!sameRef(config.value.content, plan.basis.head.configuration.content)) throw error('The pinned configuration bytes differ.', 'ENGINE_STORAGE_CORRUPT');
    state(await bytes(plan.state, plan.state.bytes, signal), plan.basis.head);
    await bytes(config.value.content, 0, signal);
    for (const ref of plan.evidence) { cancelled(signal); await bytes(ref, 0, signal); }
    cancelled(signal);
    const result = await transact(scope, transaction(plan), { signal });
    return Object.freeze({ status: 'committed', replayed: result.replayed === true, operationId,
      operation: plan.operation, requestDigest: plan.requestDigest, receipt: receipt(result, plan) });
  }
  return Object.freeze({ capture, prepare, inspect, commit });
}
