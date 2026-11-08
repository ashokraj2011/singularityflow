import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEngine, ENGINE_OPERATIONS } from '../src/engine-sdk/index.mjs';
import { createNamespaceProjectEngine } from '../src/engine-storage/namespace-project.mjs';
import { LIFECYCLE_AUTHORITY_KEY } from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import { SingularityFlowError } from '../src/foundation/failures.mjs';
import { namespaceProjectFixture } from './helpers/namespace-project-fixture.mjs';

const input = Object.freeze({ operationId: 'enroll-1' });

test('enrollment has one registered project operation and cannot accept identity or migration as request input', async t => {
  const descriptor = ENGINE_OPERATIONS.find(entry => entry.id === 'project.enroll');
  assert.equal(descriptor.subject, 'project'); assert.equal(descriptor.version, 1);
  assert.deepEqual(descriptor.inputFields, ['operationId']);
  const f = await namespaceProjectFixture(t), original = {};
  Object.defineProperty(original, 'operationId', { enumerable: true, get() { throw new Error('getter ran'); } });
  for (const invalid of [{}, null, [], original, { operationId: '' }, { operationId: '../project' },
    { operationId: 'a'.repeat(129) }, { ...input, principalId: 'administrator' }, { ...input, permissions: ['project.enroll'] },
    { ...input, projectId: 'another-project' }, { ...input, migrate: true }, { ...input, approved: true }, { ...input, authority: { id: 'other', epoch: 2 } }]) {
    await assert.rejects(f.engine.run('project.enroll', invalid), { code: 'ENGINE_INPUT_INVALID' });
  }
  assert.equal(f.control.calls, 0); assert.equal(f.control.clockCalls, 0);
  assert.equal((await f.readAuthority()).status, 'missing'); assert.equal((await f.list('runtime')).entries.length, 0);
  const unavailable = createEngine({ ports: { storyGuide: { load() { throw new Error('wrong port'); } } } });
  await assert.rejects(unavailable.run('project.enroll', input), { code: 'ENGINE_PORT_UNAVAILABLE' });
});

test('construction never enrolls, approves configuration or selects a Story', async t => {
  const f = await namespaceProjectFixture(t);
  assert.equal(f.control.calls, 0);
  for (const namespace of ['state','config','runtime','evidence']) assert.equal((await f.list(namespace)).entries.length, 0);
  assert.throws(() => createNamespaceProjectEngine({ ...f, authority: { id: 'application-authority', epoch: 2 } }), { code: 'ENGINE_INPUT_INVALID' });
  assert.throws(() => createNamespaceProjectEngine({ ...f, access: null }), { code: 'ENGINE_INPUT_INVALID' });
  await assert.rejects(f.engine.run('phase.publish', {}), { code: 'ENGINE_PORT_UNAVAILABLE' });
});

for (const backend of ['filesystem','sqlite','application']) {
  test(`${backend}: actual SDK enrollment retains one authority, manifest, event and original receipt`, async t => {
    const f = await namespaceProjectFixture(t, { backend });
    const accepted = await f.engine.run('project.enroll', input);
    assert.equal(accepted.status, 'enrolled'); assert.deepEqual(accepted.subject, { kind: 'project', id: f.scope.projectId });
    assert.deepEqual(accepted.authority, f.authority); assert.equal(accepted.principalId, 'application-owner');
    assert.equal(accepted.recordedAt, f.control.now); assert.equal(accepted.replayed, false);
    assert.deepEqual(accepted.effects, { committed: true, pushed: false, storyCreated: false, configurationApproved: false,
      humanReviewRecorded: false, approvalRecorded: false });
    assert.equal((await f.readAuthority()).record.value.status, 'active');
    assert.equal((await f.list('state')).entries.length, 1); assert.equal((await f.list('evidence')).entries.length, 1);
    assert.equal((await f.list('runtime')).entries.length, 1); assert.equal((await f.list('config')).entries.length, 0);
    const calls = f.control.calls; f.control.permissions = []; f.control.now = '2026-11-09T00:00:00.000Z';
    const replay = await f.make().run('project.enroll', input);
    assert.deepEqual(replay, { ...accepted, replayed: true }); assert.equal(f.control.calls, calls);
    assert.equal(f.control.clockCalls, 1); assert.equal((await f.list('evidence')).entries.length, 1);
  });

  test(`${backend}: revoked permission preserves the intent and resumes at the original time`, async t => {
    const f = await namespaceProjectFixture(t, { backend });
    f.control.hook = call => { if (call === 2) f.control.permissions = []; };
    await assert.rejects(f.engine.run('project.enroll', input), { code: 'ENGINE_AUTHORITY_REQUIRED' });
    assert.equal((await f.readAuthority()).status, 'missing'); assert.equal((await f.list('runtime')).entries.length, 1);
    assert.equal((await f.list('evidence')).entries.length, 0);
    f.control.hook = () => {}; f.control.permissions = ['project.enroll']; f.control.now = '2026-11-10T00:00:00.000Z';
    const accepted = await f.make().run('project.enroll', input);
    assert.equal(accepted.recordedAt, '2026-11-08T00:00:00.000Z'); assert.equal(f.control.clockCalls, 1);
  });

  test(`${backend}: another principal cannot take over a pending enrollment`, async t => {
    const f = await namespaceProjectFixture(t, { backend });
    f.control.hook = call => { if (call === 2) f.control.principalId = 'different-owner'; };
    await assert.rejects(f.engine.run('project.enroll', input), { code: 'ENGINE_ACTOR_CHANGED' });
    await assert.rejects(f.make().run('project.enroll', input), { code: 'ENGINE_ACTOR_CHANGED' });
    assert.equal((await f.readAuthority()).status, 'missing');
    f.control.principalId = 'application-owner'; f.control.hook = () => {};
    assert.equal((await f.make().run('project.enroll', input)).principalId, 'application-owner');
  });

  test(`${backend}: concurrent retries keep one intent even with different clock observations`, async t => {
    const f = await namespaceProjectFixture(t, { backend });
    const a = f.make(), b = f.make({ clock: { now: () => '2026-11-09T00:00:00.000Z' } });
    const [first, second] = await Promise.all([a.run('project.enroll', input), b.run('project.enroll', input)]);
    assert.equal(first.revision, second.revision); assert.equal(first.requestDigest, second.requestDigest);
    assert.equal(first.recordedAt, second.recordedAt); assert.equal((await f.list('runtime')).entries.length, 1);
    assert.equal((await f.list('evidence')).entries.length, 1);
  });

  test(`${backend}: competing new authorities cannot both enroll the same project`, async t => {
    const f = await namespaceProjectFixture(t, { backend });
    const requests = [{ engine: f.make(), operationId: 'first-candidate' },
      { engine: f.make({ authority: { id: 'other-authority', epoch: 1 } }), operationId: 'second-candidate' }];
    const attempts = await Promise.allSettled(requests.map(request => request.engine.run('project.enroll', { operationId: request.operationId })));
    const accepted = attempts.filter(attempt => attempt.status === 'fulfilled');
    assert.equal(accepted.length, 1);
    const failure = attempts.find(attempt => attempt.status === 'rejected');
    assert.ok(['ENGINE_PROJECT_ALREADY_ENROLLED','SDA_NAMESPACE_REVISION_CONFLICT'].includes(failure.reason.code), failure.reason.code);
    assert.equal((await f.readAuthority()).record.value.authorityId, accepted[0].value.authority.id);
    assert.equal((await f.list('evidence')).entries.length, 1);
    const winner = requests[attempts.findIndex(attempt => attempt.status === 'fulfilled')];
    assert.deepEqual(await winner.engine.run('project.enroll', { operationId: winner.operationId }), { ...accepted[0].value, replayed: true });
  });

  test(`${backend}: an existing or fenced authority cannot be replaced by new enrollment`, async t => {
    const f = await namespaceProjectFixture(t, { backend }), accepted = await f.engine.run('project.enroll', input);
    const before = (await f.readAuthority()).record;
    await assert.rejects(f.make().run('project.enroll', { operationId: 'other-enrollment' }), { code: 'ENGINE_PROJECT_ALREADY_ENROLLED' });
    assert.deepEqual((await f.readAuthority()).record, before);
    await f.records.transact(f.scope, { operationId: 'fixture-fence',
      preconditions: [{ namespace: 'state', key: LIFECYCLE_AUTHORITY_KEY, version: before.version }],
      changes: [{ op: 'put', namespace: 'state', key: LIFECYCLE_AUTHORITY_KEY, immutable: false, value: { ...before.value, status: 'fenced' } }], events: [] });
    await assert.rejects(f.make().run('project.enroll', { operationId: 'reactivate' }), { code: 'ENGINE_PROJECT_ALREADY_ENROLLED' });
    assert.equal((await f.readAuthority()).record.value.status, 'fenced');
    assert.deepEqual(await f.make().run('project.enroll', input), { ...accepted, replayed: true });
  });

  test(`${backend}: unknown commit outcomes preserve the native error and reconcile the original operation`, async t => {
    const f = await namespaceProjectFixture(t, { backend });
    const cause = new Error('lost acknowledgement'), unknown = new SingularityFlowError('transport outcome unknown', { code: 'SDA_NAMESPACE_OUTCOME_UNKNOWN', cause });
    let committed = 0;
    const records = { ...f.records, async transact(scope, tx, options) {
      const result = await f.records.transact(scope, tx, options);
      if (tx.operationId.startsWith('enroll-') && !tx.operationId.startsWith('enroll-prepare-')) { committed++; throw unknown; }
      return result;
    } };
    await assert.rejects(f.make({ records }).run('project.enroll', input), actual => actual === unknown && actual.cause === cause);
    const accepted = await f.make().run('project.enroll', input);
    assert.equal(accepted.replayed, true); assert.equal(committed, 1); assert.equal((await f.list('evidence')).entries.length, 1);
  });

  test(`${backend}: an unknown prepare acknowledgement resumes the original immutable intent`, async t => {
    const f = await namespaceProjectFixture(t, { backend });
    const unknown = new SingularityFlowError('prepared but acknowledgement lost', { code: 'SDA_NAMESPACE_OUTCOME_UNKNOWN' });
    const records = { ...f.records, async transact(scope, tx, options) {
      const result = await f.records.transact(scope, tx, options);
      if (tx.operationId.startsWith('enroll-prepare-')) throw unknown;
      return result;
    } };
    await assert.rejects(f.make({ records }).run('project.enroll', input), actual => actual === unknown);
    assert.equal((await f.readAuthority()).status, 'missing');
    f.control.now = '2026-11-11T00:00:00.000Z';
    const accepted = await f.make().run('project.enroll', input);
    assert.equal(accepted.recordedAt, '2026-11-08T00:00:00.000Z'); assert.equal(f.control.clockCalls, 1);
  });

  test(`${backend}: another empty-PATH process resumes the prepared enrollment through the SDK`, async t => {
    const f = await namespaceProjectFixture(t, { backend });
    f.control.hook = call => { if (call === 2) f.control.permissions = []; };
    await assert.rejects(f.engine.run('project.enroll', input), { code: 'ENGINE_AUTHORITY_REQUIRED' });
    const request = { backend, directory: f.directory, recordsId: f.records.descriptor.id,
      scope: f.scope, authority: f.authority, operationId: input.operationId };
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/namespace-project-reopen.mjs', import.meta.url)), JSON.stringify(request)],
      { encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 30_000, maxBuffer: 1_048_576 });
    assert.equal(child.status, 0, child.error?.message || child.stderr);
    const accepted = JSON.parse(child.stdout);
    assert.equal(accepted.recordedAt, '2026-11-08T00:00:00.000Z');
    assert.deepEqual(await f.make().run('project.enroll', input), { ...accepted, replayed: true });
  });
}

test('denied identity and malformed clock cannot create even a prepared enrollment', async t => {
  const f = await namespaceProjectFixture(t); f.control.permissions = [];
  await assert.rejects(f.engine.run('project.enroll', input), { code: 'ENGINE_AUTHORITY_REQUIRED' });
  f.control.permissions = ['project.enroll']; f.control.now = '2026-02-30T00:00:00.000Z';
  await assert.rejects(f.engine.run('project.enroll', input), { code: 'ENGINE_PORT_RESULT_INVALID' });
  assert.equal((await f.list('runtime')).entries.length, 0); assert.equal((await f.readAuthority()).status, 'missing');
});

test('access failures retain their cause while malformed access data cannot invoke a getter or write state', async t => {
  const f = await namespaceProjectFixture(t), cause = new Error('credential service unavailable');
  const original = new SingularityFlowError('fresh project access failed', { code: 'REMOTE_AUTHENTICATION_REQUIRED', cause });
  await assert.rejects(f.make({ access: { current() { throw original; } } }).run('project.enroll', input), actual => actual === original && actual.cause === cause);
  const malformed = { projectId: f.scope.projectId, principalId: 'application-owner' };
  Object.defineProperty(malformed, 'permissions', { enumerable: true, get() { throw new Error('access getter ran'); } });
  await assert.rejects(f.make({ access: { current: () => malformed } }).run('project.enroll', input), actual => actual.code === 'ENGINE_PORT_RESULT_INVALID'
    && actual.cause.code === 'SDA_NAMESPACE_INPUT_INVALID');
  assert.equal((await f.list('runtime')).entries.length, 0); assert.equal((await f.readAuthority()).status, 'missing');
});

test('reusing an operation with another authority or store binding never returns an unrelated receipt', async t => {
  const f = await namespaceProjectFixture(t); await f.engine.run('project.enroll', input);
  const other = f.make({ authority: { id: 'another-authority', epoch: 1 } });
  await assert.rejects(other.run('project.enroll', input), { code: 'ENGINE_OPERATION_ID_REUSED' });
  const content = { ...f.content, descriptor: { ...f.content.descriptor, id: 'other-content-store' } };
  await assert.rejects(f.make({ content }).run('project.enroll', input), { code: 'ENGINE_OPERATION_ID_REUSED' });
});

test('project scopes stay independent and an access result for another project cannot enroll them', async t => {
  const f = await namespaceProjectFixture(t), first = await f.engine.run('project.enroll', input);
  const scope = { projectId: 'another-project' };
  await assert.rejects(f.make({ scope }).run('project.enroll', input), { code: 'ENGINE_PORT_RESULT_INVALID' });
  const access = { current: () => ({ projectId: scope.projectId, principalId: 'another-owner', permissions: ['project.enroll'] }) };
  const second = await f.make({ scope, access }).run('project.enroll', input);
  assert.equal(second.subject.id, scope.projectId); assert.equal(second.principalId, 'another-owner');
  assert.notEqual(first.requestDigest, second.requestDigest);
  assert.deepEqual(await f.make().run('project.enroll', input), { ...first, replayed: true });
});

test('future enrollment records are refused without reinitializing or replacing their intent', async t => {
  const f = await namespaceProjectFixture(t);
  f.control.hook = call => { if (call === 2) f.control.permissions = []; };
  await assert.rejects(f.engine.run('project.enroll', input), { code: 'ENGINE_AUTHORITY_REQUIRED' });
  const original = await f.list('runtime'); f.control.hook = () => {}; f.control.permissions = ['project.enroll'];
  const records = { ...f.records, async read(scope, namespace, key, options) {
    const result = await f.records.read(scope, namespace, key, options);
    return namespace === 'runtime' && result.record ? { ...result, record: { ...result.record,
      value: { ...result.record.value, schemaVersion: 2, format: 'sflow-namespace-enrollment-intent/v2' } } } : result;
  } };
  await assert.rejects(f.make({ records }).run('project.enroll', input), cause => cause.code === 'ENGINE_STORAGE_UNSUPPORTED'
    && cause.cause.code === 'SCHEMA_VERSION_FUTURE');
  assert.deepEqual(await f.list('runtime'), original); assert.equal((await f.readAuthority()).status, 'missing');
});

test('a bad receipt after a durable commit requires reconciliation and cannot trigger another enrollment', async t => {
  const f = await namespaceProjectFixture(t); let commits = 0;
  const records = { ...f.records, async transact(scope, tx, options) {
    const result = await f.records.transact(scope, tx, options);
    if (tx.operationId.startsWith('enroll-') && !tx.operationId.startsWith('enroll-prepare-')) {
      commits++; return { ...result, receipt: { ...result.receipt, requestDigest: '0'.repeat(64) } };
    }
    return result;
  } };
  await assert.rejects(f.make({ records }).run('project.enroll', input), { code: 'ENGINE_PORT_RESULT_INVALID' });
  const accepted = await f.make().run('project.enroll', input);
  assert.equal(accepted.replayed, true); assert.equal(commits, 1); assert.equal((await f.list('evidence')).entries.length, 1);
});

test('cancellation preserves pending intent and acknowledges a known commit without repeating effects', async t => {
  for (const when of ['before-start','prepare','commit']) {
    const f = await namespaceProjectFixture(t), controller = new AbortController();
    const records = { ...f.records, async transact(scope, tx, options) {
      const result = await f.records.transact(scope, tx, options);
      if (when === 'prepare' && tx.operationId.startsWith('enroll-prepare-')
        || when === 'commit' && tx.operationId.startsWith('enroll-') && !tx.operationId.startsWith('enroll-prepare-')) controller.abort();
      return result;
    } };
    if (when === 'before-start') controller.abort();
    const running = f.make({ records }).run('project.enroll', input, { signal: controller.signal });
    if (when === 'commit') assert.equal((await running).status, 'enrolled');
    else await assert.rejects(running, { code: 'ENGINE_OPERATION_CANCELLED' });
    assert.equal((await f.readAuthority()).status, when === 'commit' ? 'present' : 'missing');
    if (when === 'prepare') assert.equal((await f.make().run('project.enroll', input)).recordedAt, '2026-11-08T00:00:00.000Z');
  }
});
