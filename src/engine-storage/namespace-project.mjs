/** Explicit new-project host. No installed discovery, Git, configuration approval or provider. */
import { createHash } from 'node:crypto';
import { createEngine } from '../engine-sdk/index.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { projectEnrollmentAccess, projectEnrollmentTimestamp } from '../kernel/project-enrollment.mjs';
import { validateNamespaceStore, namespaceLimits } from '../sda/namespace/contract.mjs';
import { exactObject, namespaceIdentifier, namespaceScope, namespaceRevision, namespaceJson, namespaceIdentityJson } from '../sda/namespace/values.mjs';
import { namespaceTransaction, namespaceTransactionIdentity } from '../sda/namespace/transaction.mjs';
import { validateContentStore } from '../sda/content/contract.mjs';
import { LIFECYCLE_AUTHORITY_KEY, lifecycleAuthority, lifecycleRecord } from './namespace-lifecycle-contract.mjs';
import { namespaceEnrollmentRecord, namespaceEnrollmentRecordValue } from './namespace-project-contract.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => hash(namespaceIdentityJson(value));
const same = (a,b) => namespaceIdentityJson(a) === namespaceIdentityJson(b);
const error = (message, code, details = null, cause = undefined) => new SingularityFlowError(message, { code, details, cause });
function cancelled(signal) { if (signal?.aborted) throw error('Enrollment was cancelled before its next effect.', 'ENGINE_OPERATION_CANCELLED'); }

/** The application owns access.current and clock.now. Neither is a request field. */
export function createNamespaceProjectPorts({ records, content, scope, authority, access, clock } = {}) {
  validateNamespaceStore(records); validateContentStore(content); scope = namespaceScope(scope);
  exactObject(authority, ['id','epoch']);
  authority = Object.freeze({ id: namespaceIdentifier(authority.id, 'Authority ID'), epoch: authority.epoch });
  if (authority.epoch !== 1 || records.descriptor.binding.kind !== 'shared' || content.descriptor.binding.kind !== 'shared'
    || typeof access?.current !== 'function' || typeof clock?.now !== 'function') {
    throw error('Enrollment needs explicit shared stores, a new authority, access and clock ports.', 'ENGINE_INPUT_INVALID');
  }
  const limits = namespaceLimits(records.descriptor.limits), read = records.read.bind(records), transact = records.transact.bind(records);
  const inspectOperation = records.inspectOperation.bind(records), currentAccess = access.current.bind(access), now = clock.now.bind(clock);
  const authorityValue = namespaceJson(lifecycleRecord('authority', { projectId: scope.projectId,
    authorityId: authority.id, epoch: 1, status: 'active', recordsId: records.descriptor.id, contentId: content.descriptor.id }));
  const contexts = new WeakMap(), preparations = new WeakMap(), outcomes = new WeakMap();
  const binding = Object.freeze({ projectId: scope.projectId, authority });
  const keys = operationId => { const id = identity({ projectId: scope.projectId, operationId });
    return { prepared: `enrollment/prepared/${id}`, manifest: `enrollment/operations/${id}`,
      prepareOperation: `enroll-prepare-${id}`, operation: `enroll-${id}`, event: `enroll-${id}` }; };
  const parameters = inputs => identity({ operation: 'project.enroll', inputs, projectId: scope.projectId, authority: authorityValue });
  const txDigest = tx => hash(namespaceTransactionIdentity(scope, tx, limits));
  const manifest = plan => namespaceEnrollmentRecord('manifest', Object.fromEntries(Object.entries(plan)
    .filter(([key]) => !['schemaVersion','format','requestDigest'].includes(key))));
  function transaction(plan) {
    const k = keys(plan.operationId);
    return namespaceTransaction({ operationId: k.operation, preconditions: [
      { namespace: 'state', key: LIFECYCLE_AUTHORITY_KEY, version: null },
      { namespace: 'evidence', key: k.manifest, version: null }
    ], changes: [
      { op: 'put', namespace: 'state', key: LIFECYCLE_AUTHORITY_KEY, immutable: false, value: plan.authority },
      { op: 'put', namespace: 'evidence', key: k.manifest, immutable: true, value: manifest(plan) }
    ], events: [{ eventId: k.event, eventType: 'engine.project-enrolled', namespace: 'state',
      payload: { projectId: scope.projectId, authorityId: authority.id, epoch: 1, operationId: plan.operationId } }] }, limits);
  }
  function prepareTransaction(plan) {
    const k = keys(plan.operationId);
    return namespaceTransaction({ operationId: k.prepareOperation, preconditions: [
      { namespace: 'state', key: LIFECYCLE_AUTHORITY_KEY, version: null },
      { namespace: 'runtime', key: k.prepared, version: null },
      { namespace: 'evidence', key: k.manifest, version: null }
    ], changes: [{ op: 'put', namespace: 'runtime', key: k.prepared, immutable: true, value: plan }], events: [] }, limits);
  }
  function stored(validate, ...args) {
    try { return validate(...args); }
    catch (cause) { if (cause.code === 'ENGINE_STORAGE_UNSUPPORTED') throw cause;
      throw error('The persisted enrollment record is invalid.', 'ENGINE_STORAGE_CORRUPT', { projectId: scope.projectId }, cause); }
  }
  async function record(namespace, key, immutable, signal) {
    const result = await read(scope, namespace, key, { signal });
    if (result?.status === 'missing' && result.record === null) return null;
    if (result?.status !== 'present' || result.record?.namespace !== namespace || result.record.key !== key
      || result.record.immutable !== immutable || namespaceRevision(result.record.version) === null) {
      throw error('The namespace port returned another enrollment record.', 'ENGINE_PORT_RESULT_INVALID', { namespace, key });
    }
    return namespaceJson(result.record.value, { maxBytes: limits.maxValueBytes });
  }
  function receipt(result, tx) {
    let r;
    try {
      r = namespaceJson(result?.receipt, { maxBytes: limits.maxValueBytes });
      exactObject(r, ['operationId','scope','revision','requestDigest','records','eventIds']); namespaceScope(r.scope);
      if (namespaceRevision(r.revision) === null || !Array.isArray(r.records) || !Array.isArray(r.eventIds)) throw new Error('Invalid receipt shape.');
      for (const item of r.records) { exactObject(item, ['namespace','key','version']);
        if (namespaceRevision(item.version) === null) throw new Error('Missing record revision.'); }
    } catch (cause) { throw error('Inspect the original enrollment intent: the namespace receipt is invalid.', 'ENGINE_PORT_RESULT_INVALID', null, cause); }
    const addresses = tx.changes.map(change => [change.namespace,change.key]);
    if (result.status !== 'committed' || r.operationId !== tx.operationId || r.scope.projectId !== scope.projectId
      || r.requestDigest !== txDigest(tx) || result.replayed !== undefined && typeof result.replayed !== 'boolean'
      || r.records.length !== addresses.length || new Set(r.records.map(item => JSON.stringify([item.namespace,item.key]))).size !== addresses.length
      || !r.records.every(item => addresses.some(([namespace,key]) => namespace === item.namespace && key === item.key))
      || !same(r.eventIds, tx.events.map(event => event.eventId))) {
      throw error('Inspect the original enrollment intent: the receipt has another binding.', 'ENGINE_PORT_RESULT_INVALID');
    }
    return r;
  }
  function state(context) {
    const value = contexts.get(context);
    if (!value) throw error('Enrollment needs the context issued by this host.', 'ENGINE_INPUT_INVALID');
    return value;
  }
  function admitPlan(plan, selected) {
    stored(namespaceEnrollmentRecordValue, 'intent', plan, scope, selected.inputs.operationId);
    if (plan.parametersSha256 !== selected.parameters || !same(plan.authority, authorityValue)) {
      throw error('This enrollment operation ID belongs to another project intent or store binding.', 'ENGINE_OPERATION_ID_REUSED');
    }
    if (plan.requestDigest !== txDigest(transaction(plan))) throw error('The retained enrollment transaction has changed.', 'ENGINE_STORAGE_CORRUPT');
    return plan;
  }
  async function checkpoint(selected, signal) {
    const k = keys(selected.inputs.operationId); let plan = await record('runtime', k.prepared, true, signal);
    const observed = await inspectOperation(scope, k.prepareOperation, { signal });
    if (plan === null && observed?.status === 'missing' && observed.receipt === null) return null;
    if (plan === null && observed?.status === 'committed') plan = await record('runtime', k.prepared, true, signal);
    if (!plan) throw error('The enrollment receipt has lost its immutable prepared intent.', 'ENGINE_STORAGE_CORRUPT');
    admitPlan(plan, selected); receipt(observed, prepareTransaction(plan));
    return plan;
  }
  function outcome(context, plan, r, replayed) {
    const token = Object.freeze({}); outcomes.set(token, { context, plan, receipt: r, replayed }); return token;
  }
  async function retained(context, _inputs, { signal } = {}) {
    cancelled(signal); const selected = state(context);
    const observed = await inspectOperation(scope, keys(selected.inputs.operationId).operation, { signal });
    if (observed?.status === 'missing' && observed.receipt === null) return null;
    const plan = await checkpoint(selected, signal);
    if (!plan) throw error('A committed enrollment has lost its prepared intent.', 'ENGINE_STORAGE_CORRUPT');
    const r = receipt(observed, transaction(plan));
    const saved = await record('evidence', keys(plan.operationId).manifest, true, signal);
    if (!saved || !same(stored(namespaceEnrollmentRecordValue, 'manifest', saved, scope, plan.operationId), manifest(plan))) {
      throw error('The accepted enrollment manifest is missing or changed.', 'ENGINE_STORAGE_CORRUPT');
    }
    return outcome(context, plan, r, true);
  }
  async function authorize(expectedPrincipal, signal) {
    cancelled(signal);
    const response = await currentAccess({ projectId: scope.projectId, operation: 'project.enroll', signal });
    let observed;
    try { observed = namespaceJson(response); }
    catch (cause) { throw error('The project access port returned non-JSON identity facts.', 'ENGINE_PORT_RESULT_INVALID', null, cause); }
    cancelled(signal); projectEnrollmentAccess(observed, scope.projectId, expectedPrincipal); return observed;
  }
  async function absentAuthority(signal) {
    const existing = await record('state', LIFECYCLE_AUTHORITY_KEY, false, signal);
    if (existing) { stored(lifecycleAuthority, existing, scope);
      throw error('This project already has an authority. Enrollment cannot replace, migrate or reactivate it.', 'ENGINE_PROJECT_ALREADY_ENROLLED'); }
  }
  return { projectEnrollment: {
    async load(inputs, { signal } = {}) {
      cancelled(signal); const context = Object.freeze({ binding });
      contexts.set(context, { inputs, parameters: parameters(inputs) }); return context;
    },
    retained,
    async prepare(context, _inputs, { signal } = {}) {
      cancelled(signal); const selected = state(context); let plan = await checkpoint(selected, signal);
      const accessFacts = await authorize(plan?.principalId ?? null, signal), principalId = accessFacts.principalId;
      if (!plan) {
        await absentAuthority(signal);
        const recordedAt = projectEnrollmentTimestamp(await now()); cancelled(signal);
        const draft = namespaceEnrollmentRecord('intent', { projectId: scope.projectId, operationId: selected.inputs.operationId,
          parametersSha256: selected.parameters, authority: authorityValue, principalId, recordedAt, requestDigest: '0'.repeat(64) });
        draft.requestDigest = txDigest(transaction(draft)); plan = namespaceJson(admitPlan(draft, selected));
        try { receipt(await transact(scope, prepareTransaction(plan), { signal }), prepareTransaction(plan)); }
        catch (cause) {
          if (!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code)) throw cause;
          const accepted = await checkpoint(selected, signal);
          if (!accepted) throw cause;
          projectEnrollmentAccess(accessFacts, scope.projectId, accepted.principalId);
          plan = accepted;
        }
      }
      const token = Object.freeze({}); preparations.set(token, { context, plan }); return token;
    },
    async commit(context, token, { signal } = {}) {
      cancelled(signal); const prepared = preparations.get(token);
      if (!prepared || prepared.context !== context) throw error('Enrollment needs its own prepared intent.', 'ENGINE_INPUT_INVALID');
      const accepted = await retained(context, state(context).inputs, { signal });
      if (accepted !== null) return accepted;
      const plan = await checkpoint(state(context), signal);
      if (!plan || !same(plan, prepared.plan)) throw error('The enrollment intent changed after preparation.', 'ENGINE_CONTEXT_CHANGED');
      await authorize(plan.principalId, signal);
      try {
        await absentAuthority(signal); cancelled(signal);
        const tx = transaction(plan), committed = await transact(scope, tx, { signal });
        return outcome(context, plan, receipt(committed, tx), committed.replayed === true);
      } catch (cause) {
        if (!['ENGINE_PROJECT_ALREADY_ENROLLED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code)) throw cause;
        const accepted = await retained(context, state(context).inputs, { signal });
        if (accepted === null) throw cause;
        return accepted;
      }
    },
    async finish(context, token) {
      const saved = outcomes.get(token);
      if (!saved || saved.context !== context) throw error('Enrollment needs its own accepted receipt.', 'ENGINE_PORT_RESULT_INVALID');
      const { plan, receipt: r, replayed } = saved;
      return { projectId: scope.projectId, operationId: plan.operationId, authorityId: authority.id, epoch: 1,
        principalId: plan.principalId, recordedAt: plan.recordedAt, requestDigest: r.requestDigest, revision: r.revision, replayed };
    }
  } };
}

export function createNamespaceProjectEngine(options={}) {
  return createEngine({ports:createNamespaceProjectPorts(options)});
}
