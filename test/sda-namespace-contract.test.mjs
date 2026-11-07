import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NAMESPACES, NAMESPACE_LIMITS, NAMESPACE_STORE_CAPABILITIES, NAMESPACE_STORE_CONTRACT, NAMESPACE_STORE_METHODS,
  assertNamespaceBinding, namespaceAddress, namespaceBinding, namespaceError, namespaceIdentityJson,
  namespaceJson, namespaceKey, namespaceLimits, namespaceListQuery, namespaceRevision, namespaceScope,
  namespaceStoreDescriptor, namespaceStoreOutcome, namespaceTransaction, namespaceTransactionIdentity, validateNamespaceStore
} from '../src/sda/namespace/index.mjs';
import { SingularityFlowError } from '../src/foundation/failures.mjs';
import { putTransaction } from './helpers/namespace-conformance.mjs';

const scope = { projectId: 'project-a' };
const invalid = error => error instanceof SingularityFlowError && namespaceStoreOutcome(error) === 'invalid';
const limited = error => error instanceof SingularityFlowError && namespaceStoreOutcome(error) === 'limit-invalid';
const descriptor = extra => namespaceStoreDescriptor({ id: 'fixture-adapter', qualification: 'test-only', binding: { kind: 'shared' }, ...extra });

test('the draft names its closed vocabulary without changing existing SDA v1 contracts', () => {
  assert.equal(NAMESPACE_STORE_CONTRACT, 'sda-namespace-store/draft-1');
  assert.deepEqual(NAMESPACES, ['config', 'state', 'evidence', 'runtime', 'local']);
  assert.deepEqual(NAMESPACE_STORE_METHODS, ['read', 'list', 'transact', 'inspectOperation', 'verify']);
  for (const value of [NAMESPACES, NAMESPACE_LIMITS, NAMESPACE_STORE_CAPABILITIES, NAMESPACE_STORE_METHODS]) assert.equal(Object.isFrozen(value), true);
});

test('scope and addresses are stable logical data, with case preserved', () => {
  assert.deepEqual(namespaceScope(scope), scope);
  assert.deepEqual(namespaceAddress({ namespace: 'state', key: 'stories/ABC-1' }), { namespace: 'state', key: 'stories/ABC-1' });
  assert.notEqual(namespaceKey('stories/A'), namespaceKey('stories/a'));
  assert.equal(namespaceKey('stories/CON'), 'stories/CON', 'logical keys are encoded by an adapter, not treated as native filenames');
  for (const value of [null, {}, { projectId: '' }, { projectId: '../parent' }, { projectId: 'has space' },
    { projectId: 'project', repositoryPath: '/a/path' }, { projectId: 'project', tenantId: 'undeclared' }]) {
    assert.throws(() => namespaceScope(value), invalid);
  }
  assert.throws(() => namespaceAddress({ namespace: 'unknown', key: 'stories/one' }), invalid);
});

test('keys cannot smuggle absolute paths, traversal, separators or encoded escapes', () => {
  for (const key of ['', '/absolute', '../parent', 'a/../b', 'a//b', 'a/', 'C:\\files\\x', 'a\\b',
    'file://host/x', '%2e%2e/secrets', 'a/%2f/b', 'a?b', 'a#b', 'a\u0000b', 'a'.repeat(513)]) {
    assert.throws(() => namespaceKey(key), invalid, JSON.stringify(key));
  }
  assert.equal(namespaceKey('', { prefix: true }), '');
  assert.equal(namespaceKey('stories/', { prefix: true }), 'stories/');
  assert.throws(() => namespaceKey('a'.repeat(512) + '/', { prefix: true }), invalid);
  assert.throws(() => namespaceKey('', { prefix: 'yes' }), invalid);
});

test('revisions are opaque and absence is explicit, never inferred from undefined', () => {
  assert.equal(namespaceRevision('backend:opaque/revision+token=='), 'backend:opaque/revision+token==');
  assert.equal(namespaceRevision(null), null);
  for (const version of [undefined, 1, {}, '', 'has space', 'line\nbreak', 'x'.repeat(513)]) {
    assert.throws(() => namespaceRevision(version), invalid);
  }
});

test('JSON is detached, deeply frozen, deterministic and safe for special property names', () => {
  const source = JSON.parse('{"b":{"z":2,"a":1},"a":[1,null],"__proto__":{"polluted":true}}');
  const copy = namespaceJson(source);
  source.b.a = 9;
  assert.equal(copy.b.a, 1);
  assert.equal(Object.isFrozen(copy.b), true);
  assert.equal(Object.isFrozen(copy.a), true);
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.equal(Object.hasOwn(copy, '__proto__'), true);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(namespaceIdentityJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(namespaceJson(-0), 0);
});

test('non-JSON and lossy inputs are refused without invoking getters or toJSON', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const accessor = Object.defineProperty({}, 'answer', { enumerable: true, get() { throw new Error('must not run'); } });
  const toJSON = { toJSON() { throw new Error('must not run'); } };
  const extended = Object.assign(new Array(1), { extra: 'cannot fill a hole' });
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('value'), () => {}, new Date(),
    new Map(), cyclic, accessor, toJSON, new Array(1), extended, hidden, { value: undefined }, { [Symbol('key')]: 1 }]) {
    assert.throws(() => namespaceJson(value), invalid);
  }
});

test('JSON bounds count UTF-8 bytes, depth and nodes at exact boundaries', () => {
  assert.equal(namespaceJson('é', { maxBytes: 4 }), 'é');
  assert.throws(() => namespaceJson('é', { maxBytes: 3 }), limited);
  assert.deepEqual(namespaceJson({ a: 1 }, { maxBytes: 7 }), { a: 1 });
  assert.throws(() => namespaceJson({ a: 1 }, { maxBytes: 6 }), limited);
  assert.deepEqual(namespaceJson([1, 2], { maxNodes: 3, maxBytes: 5 }), [1, 2]);
  assert.throws(() => namespaceJson([1, 2], { maxNodes: 2 }), limited);
  assert.throws(() => namespaceJson([[[1]]], { maxDepth: 2 }), limited);
  assert.throws(() => namespaceJson('x'.repeat(NAMESPACE_LIMITS.maxValueBytes), { maxBytes: NAMESPACE_LIMITS.maxValueBytes }), limited);
  for (const maxBytes of [0, NaN, Infinity, -1, NAMESPACE_LIMITS.maxTransactionBytes + 1]) {
    assert.throws(() => namespaceJson({}, { maxBytes }), limited);
  }
});

test('descriptors validate exact capabilities, limits and machine binding', () => {
  const value = descriptor();
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.limits), true);
  assert.deepEqual(value.binding, { kind: 'shared' });
  assert.deepEqual(namespaceBinding({ kind: 'machine-local', deviceId: 'device-a' }), { kind: 'machine-local', deviceId: 'device-a' });
  for (const binding of [{ kind: 'shared', deviceId: 'device-a' }, { kind: 'machine-local' }, { kind: 'unknown' }]) {
    assert.throws(() => namespaceBinding(binding), invalid);
  }
  for (const capabilities of [null, ['invented'], ['snapshot-pages', 'snapshot-pages']]) {
    assert.throws(() => descriptor({ capabilities }), invalid);
  }
  for (const limits of [{ maxPage: 0 }, { maxPage: 1.5 }, { maxPage: 1001 }, { maxChanges: Infinity }]) {
    assert.throws(() => namespaceLimits(limits), limited);
  }
  assert.throws(() => descriptor({ secrets: 'undeclared' }), invalid);
  assert.throws(() => assertNamespaceBinding(value, 'local'), error => namespaceStoreOutcome(error) === 'unsupported');
});

test('protocol validation checks a shape, not production authority or backend selection', () => {
  const adapter = { descriptor: descriptor(), ...Object.fromEntries(NAMESPACE_STORE_METHODS.map(name => [name, async () => null])) };
  assert.equal(validateNamespaceStore(adapter), adapter);
  assert.throws(() => validateNamespaceStore({ ...adapter, read: null }), error => namespaceStoreOutcome(error) === 'unsupported');
  assert.throws(() => validateNamespaceStore({ ...adapter, descriptor: { ...adapter.descriptor, contract: 'sda-namespace-store/future' } }),
    error => namespaceStoreOutcome(error) === 'unsupported');
  assert.throws(() => validateNamespaceStore({ ...adapter, descriptor: descriptor({ capabilities: [] }) }),
    error => namespaceStoreOutcome(error) === 'unsupported');
});

test('queries have bounded pages, typed continuations and logical prefixes', () => {
  assert.deepEqual(namespaceListQuery({ limit: 2 }), { prefix: '', limit: 2, continuation: null });
  assert.deepEqual(namespaceListQuery({ prefix: 'stories/', limit: 1, continuation: 'opaque/token' }),
    { prefix: 'stories/', limit: 1, continuation: 'opaque/token' });
  for (const query of [{ limit: 0 }, { limit: 1.5 }, { limit: NAMESPACE_LIMITS.maxPage + 1 }]) {
    assert.throws(() => namespaceListQuery(query), limited);
  }
  assert.throws(() => namespaceListQuery({ limit: 1, prefix: null }), invalid);
  assert.throws(() => namespaceListQuery({ limit: NAMESPACE_LIMITS.maxPage + 1 }, {}), limited);
  assert.throws(() => namespaceListQuery({ limit: 1, continuation: 3 }), error => namespaceStoreOutcome(error) === 'continuation-invalid');
});

test('transaction normalization requires a complete explicit read set and copies values', () => {
  const input = putTransaction('create', 'stories/one', { count: 1 });
  const normalized = namespaceTransaction(input);
  input.changes[0].value.count = 9;
  assert.equal(normalized.changes[0].value.count, 1);
  assert.equal(Object.isFrozen(normalized.changes[0].value), true);
  for (const change of [
    { ...input, preconditions: [] },
    { ...input, preconditions: [{ namespace: 'state', key: 'stories/one' }] },
    { ...input, preconditions: [...input.preconditions, ...input.preconditions] },
    { ...input, changes: [...input.changes, ...input.changes] },
    { ...input, changes: [{ op: 'put', namespace: 'state', key: 'stories/one', value: 1 }] },
    { ...input, events: [...input.events, ...input.events] },
    { ...input, operationId: 'bad id' },
    { ...input, expectedHead: 'Git-specific-field' },
    { operationId: 'empty', preconditions: [], changes: [], events: [] }
  ]) assert.throws(() => namespaceTransaction(change), invalid);
});

test('delete, sparse arrays and accessor changes cannot bypass transaction validation', () => {
  const input = putTransaction('create', 'stories/one', 1);
  assert.throws(() => namespaceTransaction({ ...input, changes: [{ op: 'delete', namespace: 'state', key: 'stories/one' }] }), invalid);
  assert.throws(() => namespaceTransaction({ ...input, preconditions: new Array(1) }), invalid);
  const accessor = Object.defineProperty({ namespace: 'state', key: 'stories/one' }, 'op', {
    enumerable: true, get() { throw new Error('must not execute'); }
  });
  assert.throws(() => namespaceTransaction({ ...input, changes: [accessor] }), invalid);
  assert.throws(() => namespaceTransaction({ ...input, changes: [{ ...input.changes[0], immutable: 'yes' }] }), invalid);
});

test('transaction identity normalizes independent record ordering and keeps semantic differences', () => {
  const first = putTransaction('batch', 'stories/two', { b: 2, a: 1 });
  const extra = putTransaction('other', 'stories/one', 'one');
  first.preconditions.push(...extra.preconditions);
  first.changes.push(...extra.changes);
  const reordered = structuredClone(first);
  reordered.preconditions.reverse(); reordered.changes.reverse();
  assert.equal(namespaceTransactionIdentity(scope, first), namespaceTransactionIdentity(scope, reordered));
  assert.notEqual(namespaceTransactionIdentity(scope, first), namespaceTransactionIdentity({ projectId: 'project-b' }, first));
  const changed = structuredClone(first);
  changed.changes[0].immutable = true;
  assert.notEqual(namespaceTransactionIdentity(scope, first), namespaceTransactionIdentity(scope, changed));
  const events = structuredClone(first);
  events.events.push({ eventId: 'second-event', eventType: 'audit.recorded', namespace: 'state', payload: null });
  const reversed = structuredClone(events); reversed.events.reverse();
  assert.notEqual(namespaceTransactionIdentity(scope, events), namespaceTransactionIdentity(scope, reversed));
});

test('per-adapter record, transaction, depth and batch limits are enforced', () => {
  const input = putTransaction('bounded', 'stories/one', 'value');
  assert.throws(() => namespaceTransaction(input, { maxValueBytes: 3 }), limited);
  assert.throws(() => namespaceTransaction(input, { maxTransactionBytes: 20 }), limited);
  assert.throws(() => namespaceTransaction(input, { maxDepth: 1 }), limited);
  const batch = structuredClone(input);
  batch.changes.push({ ...batch.changes[0], key: 'stories/two' });
  batch.preconditions.push({ namespace: 'state', key: 'stories/two', version: null });
  assert.throws(() => namespaceTransaction(batch, { maxChanges: 1 }), limited);
});

test('namespace failures retain distinct outcomes and the original native cause', () => {
  const codes = {
    SDA_NAMESPACE_REVISION_CONFLICT: 'REVISION_CONFLICT', SDA_NAMESPACE_OPERATION_ID_REUSED: 'OPERATION_ID_REUSE',
    SDA_NAMESPACE_EVENT_ID_REUSED: 'OPERATION_ID_REUSE', SDA_NAMESPACE_OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
    SDA_NAMESPACE_UNAVAILABLE: 'unavailable', SDA_NAMESPACE_CORRUPT: 'corrupt', SDA_NAMESPACE_IMMUTABLE: 'immutable',
    SDA_NAMESPACE_CANCELLED: 'cancelled', SDA_NAMESPACE_UNSUPPORTED: 'unsupported'
  };
  for (const [code, outcome] of Object.entries(codes)) assert.equal(namespaceStoreOutcome(namespaceError('retained', code)), outcome);
  for (const code of ['UNKNOWN', 'constructor', '__proto__', 'toString']) {
    assert.equal(namespaceStoreOutcome(namespaceError('retained', code)), 'failed');
  }
  assert.equal(namespaceStoreOutcome({ outcomeClass: 'approved' }), 'failed');
  const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const details = { stage: 'read', timedOut: false };
  const error = namespaceError('Storage unavailable.', 'SDA_NAMESPACE_UNAVAILABLE', details, cause);
  assert.equal(error.cause, cause);
  assert.equal(error.details, details);
});
