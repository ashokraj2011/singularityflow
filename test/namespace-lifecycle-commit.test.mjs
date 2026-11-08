import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createEngine } from '../src/engine-sdk/index.mjs';
import { beginGenerationPublication, appendGenerationAuthorship, recordGenerationPublication } from '../src/kernel/lifecycle-transitions.mjs';
import { LIFECYCLE_AUTHORITY_KEY, LIFECYCLE_STATE_MAXIMUM_BYTES } from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import { createNamespaceLifecycleCommitter } from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import { namespaceLifecycleFixture } from './helpers/namespace-lifecycle-fixture.mjs';

const wrap = (records, overrides) => ({ descriptor: records.descriptor,
  ...Object.fromEntries(['read','list','transact','inspectOperation','verify'].map(name => [name, records[name].bind(records)])), ...overrides });
test('project and configuration mutations cannot enter the Story lifecycle writer',async t=>{
  const f=await namespaceLifecycleFixture(t),snapshot=await f.committer.capture();
  for(const operation of ['project.enroll','configuration.approve'])await assert.rejects(
    f.committer.prepare(snapshot,{...f.proposal(snapshot.workflow),operation}),{code:'ENGINE_INPUT_INVALID'});
});
for (const backend of ['filesystem','sqlite','application']) {
  test(`${backend}: full lifecycle bytes and immutable operation evidence commit with one conditional head`, async t => {
    const f = await namespaceLifecycleFixture(t, { backend });
    const original = (await f.records.read(f.scope, 'state', f.headKey)).record;
    const snapshot = await f.committer.capture();
    snapshot.workflow.history.push({ event: 'large-history', detail: 'x'.repeat(100_000) });
    snapshot.workflow.phases['team-document'].generation = 1;
    const bytes = f.proposal(snapshot.workflow);
    const prepared = await f.committer.prepare(snapshot, bytes);
    assert.equal(prepared.status, 'prepared');
    assert.equal((await f.records.read(f.scope, 'state', f.headKey)).record.value.sequence, 0);
    const result = await f.committer.commit('publish-1');
    assert.equal(result.status, 'committed'); assert.equal(result.replayed, false);
    assert.equal(result.receipt.records.length, 2); assert.equal(result.receipt.eventIds.length, 1);
    const head = (await f.records.read(f.scope, 'state', f.headKey)).record;
    assert.equal(head.version, result.receipt.records.find(record => record.namespace === 'state').version);
    assert.notEqual(head.version, result.receipt.revision, 'record and transaction revisions remain distinct opaque values');
    assert.equal(head.value.sequence, 1); assert.equal(head.value.previous.sha256, original.value.state.sha256);
    const retained = await f.content.read(f.scope, head.value.state);
    assert.deepEqual(Buffer.from(retained.data), bytes.state);
    assert.equal((await f.committer.capture()).workflow.history[0].detail.length, 100_000);
  });

  test(`${backend}: retries reopen the exact durable plan and preserve the original receipt across later writes`, async t => {
    const f = await namespaceLifecycleFixture(t, { backend });
    const before = await f.records.read(f.scope, 'state', f.headKey), s = await f.committer.capture();
    s.workflow.phases['team-document'].generation = 1;
    const input = f.proposal(s.workflow);
    await f.committer.prepare(s, input);
    const other = f.make();
    assert.equal((await other.inspect('publish-1')).status, 'prepared');
    const first = await other.commit('publish-1');
    const next = await other.capture(); next.workflow.phases['team-document'].generation = 2;
    await other.prepare(next, f.proposal(next.workflow, 'publish-2'));
    await other.commit('publish-2');
    const replay = await f.make().commit('publish-1');
    assert.deepEqual(replay.receipt, first.receipt); assert.equal(replay.replayed, true);
    const manifest = first.receipt.records.find(record => record.namespace === 'evidence');
    const record = (await f.records.read(f.scope, 'evidence', manifest.key)).record;
    assert.equal(record.immutable, true); assert.equal(record.value.previous.sha256, before.record.value.state.sha256);
    assert.equal(record.value.operation, 'phase.publish');
    assert.equal((await f.records.read(f.scope, 'state', f.headKey)).record.value.sequence, 2);
  });

  test(`${backend}: concurrent prepared writers conflict instead of overwriting a moved Story`, async t => {
    const f = await namespaceLifecycleFixture(t, { backend }), a = f.committer, b = f.make();
    const sa = await a.capture(), sb = await b.capture();
    sa.workflow.phases['team-document'].generation = 1; sb.workflow.phases['team-document'].generation = 9;
    await a.prepare(sa, f.proposal(sa.workflow, 'a')); await b.prepare(sb, f.proposal(sb.workflow, 'b'));
    await a.commit('a');
    await assert.rejects(b.commit('b'), { code: 'SDA_NAMESPACE_REVISION_CONFLICT' });
    assert.equal((await b.inspect('b')).status, 'prepared');
    assert.equal((await a.capture()).workflow.phases['team-document'].generation, 1);
    const page = await f.records.list(f.scope, 'evidence', { limit: 100 });
    assert.equal(page.entries.length, 1);
  });

  test(`${backend}: fencing blocks pending writes while accepted receipt inspection stays possible`, async t => {
    const f = await namespaceLifecycleFixture(t, { backend }), s = await f.committer.capture();
    await f.committer.prepare(s, f.proposal(s.workflow)); await f.committer.commit('publish-1');
    const next = await f.committer.capture(); await f.committer.prepare(next, f.proposal(next.workflow, 'pending'));
    await f.update('state', LIFECYCLE_AUTHORITY_KEY, { ...f.enrolled, status: 'fenced' });
    await assert.rejects(f.make().capture(), { code: 'ENGINE_AUTHORITY_FENCED' });
    await assert.rejects(f.make().commit('pending'), { code: 'ENGINE_AUTHORITY_FENCED' });
    assert.equal((await f.make().commit('publish-1')).replayed, true);
    assert.equal((await f.records.read(f.scope, 'state', f.headKey)).record.value.sequence, 1);
  });

  test(`${backend}: changing the future-Story configuration pointer does not rebind an active Story`, async t => {
    const f = await namespaceLifecycleFixture(t, { backend }), s = await f.committer.capture();
    await f.committer.prepare(s, f.proposal(s.workflow));
    await f.update('config', 'approved', { configuration: 'a-later-version' });
    await f.committer.commit('publish-1');
    assert.deepEqual((await f.committer.capture()).configuration, f.configuration);
  });

  test(`${backend}: the registered SDK operation can commit shared kernel publication updates through the storage port`, async t => {
    const f = await namespaceLifecycleFixture(t, { backend }); let snapshot;
    const phaseId = 'team-document';
    const engine = createEngine({ ports: { publication: {
      async load() { snapshot = await f.committer.capture(); return { subject: { kind: 'story', id: f.workId }, phase: snapshot.workflow.phases[phaseId] }; },
      async retained() { return null; },
      async prepare(context, input, intent) {
        const phase = snapshot.workflow.phases[phaseId], publishedAt = '2026-01-01T00:00:00.000Z';
        beginGenerationPublication(phase, { targetGeneration: 1, actor: { name: 'Fixture author' }, agent: null, producer: intent.authorship.producer });
        appendGenerationAuthorship(phase, intent.authorship, publishedAt);
        recordGenerationPublication(phase, { generation: 1, publishedAt, record: null });
        await f.committer.prepare(snapshot, f.proposal(snapshot.workflow)); return { phase: phaseId };
      },
      async commit() { return f.committer.commit('publish-1'); },
      async finish(context, prepared, committed) { return { workId: f.workId, phase: prepared.phase, generation: 1,
        revision: committed.receipt.revision, artifact: context.phase.requiredArtifact.path, pushed: false }; }
    } } });
    const result = await engine.publishPhase({ workId: f.workId, phaseId, authored: 'external-tool', channel: 'external-tool' });
    assert.equal(result.status, 'published'); assert.deepEqual(result.effects, { committed: true, pushed: false });
    const accepted = await f.make().capture();
    assert.equal(accepted.workflow.phases[phaseId].generationPublications[0].generation, 1);
    assert.equal(accepted.workflow.phases[phaseId].status, 'in_progress', 'storage did not submit or approve the phase');
    assert.equal(accepted.workflow.workItem.branch, 'team/custom-source');
  });

  test(`${backend}: simultaneous identical prepares and commits retain one accepted intent`, async t => {
    const f = await namespaceLifecycleFixture(t, { backend }), other = f.make();
    const a = await f.committer.capture(), b = await other.capture();
    const preparing = await Promise.allSettled([f.committer.prepare(a, f.proposal(a.workflow)), other.prepare(b, f.proposal(b.workflow))]);
    for (const result of preparing) assert.equal(result.status, 'fulfilled', result.reason?.message);
    const committing = await Promise.allSettled([f.committer.commit('publish-1'), other.commit('publish-1')]);
    for (const result of committing) assert.equal(result.status, 'fulfilled', result.reason?.message);
    const results = committing.map(result => result.value);
    assert.deepEqual(results[0].receipt, results[1].receipt);
    assert.equal(results.filter(result => !result.replayed).length, 1);
    assert.equal((await f.records.list(f.scope, 'evidence', { limit: 100 })).entries.length, 1);
  });
}

test('lost acknowledgements before and after lifecycle acceptance reconcile without another logical operation', async t => {
  let fail = null;
  const cause = Object.assign(new Error('Acknowledgement deadline exceeded.'), { code: 'ETIMEDOUT', timedOut: true });
  const f = await namespaceLifecycleFixture(t, { recordsWrap: records => wrap(records, { async transact(scope, tx, options) {
    const accepted = await records.transact(scope, tx, options);
    if (fail && tx.operationId.startsWith(fail)) { fail = null; throw cause; }
    return accepted;
  } }) });
  const s = await f.committer.capture(); fail = 'prepare-';
  await assert.rejects(f.committer.prepare(s, f.proposal(s.workflow)), error => error === cause);
  assert.equal((await f.make().inspect('publish-1')).status, 'prepared');
  fail = 'lifecycle-';
  await assert.rejects(f.make().commit('publish-1'), error => error === cause);
  const recovered = await f.make().commit('publish-1'); assert.equal(recovered.replayed, true);
  assert.equal((await f.records.list(f.scope, 'evidence', { limit: 100 })).entries.length, 1);
});

test('input mutation, ID reuse, foreign capture and configuration rebinding cannot change a prepared intent', async t => {
  const f = await namespaceLifecycleFixture(t), s = await f.committer.capture();
  await assert.rejects(f.committer.prepare({ ...s }, f.proposal(s.workflow)), { code: 'ENGINE_INPUT_INVALID' });
  const input = f.proposal(s.workflow), before = Buffer.from(input.state);
  const pending = f.committer.prepare(s, input); input.state.fill(0); input.operation = 'phase.approve';
  await pending;
  const same = f.proposal(s.workflow, 'publish-1', { state: before });
  assert.equal((await f.committer.prepare(s, same)).status, 'prepared');
  await assert.rejects(f.committer.prepare(s, { ...same, inputsSha256: 'b'.repeat(64) }), { code: 'ENGINE_OPERATION_ID_REUSED' });
  const changed = JSON.parse(before); changed.configuration.sha256 = 'c'.repeat(64);
  await assert.rejects(f.committer.prepare(s, { ...same, state: Buffer.from(JSON.stringify(changed)) }), { code: 'ENGINE_STORAGE_CORRUPT' });
  await f.committer.commit('publish-1');
});

test('missing evidence and machine-local references cannot become shared delivery evidence', async t => {
  const f = await namespaceLifecycleFixture(t), s = await f.committer.capture();
  await assert.rejects(f.committer.prepare(s, f.proposal(s.workflow, 'local', { evidence: [{ namespace: 'local', sha256: 'a'.repeat(64), bytes: 1 }] })), { code: 'ENGINE_STORAGE_CORRUPT' });
  await assert.rejects(f.committer.prepare(s, f.proposal(s.workflow, 'missing', { evidence: [{ namespace: 'evidence', sha256: 'a'.repeat(64), bytes: 1 }] })), { code: 'ENGINE_STORAGE_CONTENT_MISSING' });
  assert.equal((await f.committer.inspect('missing')).status, 'missing');
  const evidence = (await f.content.put(f.scope, 'evidence', Buffer.from('Genuine retained observation.'))).reference;
  await f.committer.prepare(s, f.proposal(s.workflow, 'present', { evidence: [evidence] }));
  await f.committer.commit('present');
});

test('unavailable stores, unsupported schemas and changed capture bindings retain explicit errors', async t => {
  let fail = null;
  const f = await namespaceLifecycleFixture(t, { recordsWrap: records => wrap(records, { async read(...args) {
    if (fail) throw fail; return records.read(...args);
  } }) });
  fail = Object.freeze(Object.assign(new Error('Storage permission denied.'), { code: 'EACCES' }));
  await assert.rejects(f.committer.capture(), error => error === fail); fail = null;
  await f.update('state', LIFECYCLE_AUTHORITY_KEY, { ...f.enrolled, schemaVersion: 2 });
  await assert.rejects(f.committer.capture(), { code: 'ENGINE_STORAGE_UNSUPPORTED' });
});

test('unregistered/read operations, oversized state and cancelled requests do not create a lifecycle checkpoint', async t => {
  const f = await namespaceLifecycleFixture(t), s = await f.committer.capture();
  for (const operation of ['story.next','phase.prepublish','__proto__','made-up']) await assert.rejects(f.committer.prepare(s, f.proposal(s.workflow, 'invalid', { operation })), { code: 'ENGINE_INPUT_INVALID' });
  await assert.rejects(f.committer.prepare(s, f.proposal(s.workflow, 'large', { state: new Uint8Array(LIFECYCLE_STATE_MAXIMUM_BYTES + 1) })), { code: 'ENGINE_STORAGE_LIMIT' });
  await assert.rejects(f.committer.commit('missing'), { code: 'ENGINE_OPERATION_NOT_PREPARED' });
  const signal = AbortSignal.abort();
  await assert.rejects(f.committer.prepare(s, f.proposal(s.workflow), { signal }), { code: 'ENGINE_OPERATION_CANCELLED' });
  assert.equal((await f.committer.inspect('publish-1')).status, 'missing');
});

test('malformed post-commit receipts do not erase the accepted operation or permit a duplicate', async t => {
  let corrupt = false;
  const f = await namespaceLifecycleFixture(t, { recordsWrap: records => wrap(records, { async transact(...args) {
    const result = await records.transact(...args);
    return corrupt ? { ...result, receipt: { ...result.receipt, requestDigest: '0'.repeat(64) } } : result;
  } }) });
  const s = await f.committer.capture(); await f.committer.prepare(s, f.proposal(s.workflow)); corrupt = true;
  await assert.rejects(f.committer.commit('publish-1'), { code: 'ENGINE_PORT_RESULT_INVALID' }); corrupt = false;
  assert.equal((await f.make().commit('publish-1')).replayed, true);
});

test('the committer never enrolls a missing Story, accepts a local store or selects another authority implicitly', async t => {
  const f = await namespaceLifecycleFixture(t);
  const options = { records: f.records, content: f.content, scope: f.scope, workId: f.workId, authority: f.authority };
  const missing = createNamespaceLifecycleCommitter({ ...options, workId: 'not-enrolled' });
  await assert.rejects(missing.capture(), { code: 'ENGINE_LIFECYCLE_RECORD_MISSING' });
  await assert.rejects(createNamespaceLifecycleCommitter({ ...options, authority: { id: f.authority.id, epoch: 2 } }).capture(), { code: 'ENGINE_AUTHORITY_FENCED' });
  assert.throws(() => createNamespaceLifecycleCommitter({ ...options, content: { ...f.content,
    descriptor: { ...f.content.descriptor, binding: { kind: 'machine-local', deviceId: 'another-device' } } } }), { code: 'ENGINE_INPUT_INVALID' });
  const foreign = createNamespaceLifecycleCommitter({ ...options, scope: { projectId: 'another-project' } });
  await assert.rejects(foreign.capture(), { code: 'ENGINE_LIFECYCLE_RECORD_MISSING' });
});

test('cancellation after accepted metadata preserves the actual result and its original receipt', async t => {
  const controller = new AbortController(); let abort = false;
  const f = await namespaceLifecycleFixture(t, { recordsWrap: records => wrap(records, { async transact(...args) {
    const result = await records.transact(...args); if (abort) controller.abort(); return result;
  } }) });
  const s = await f.committer.capture(); await f.committer.prepare(s, f.proposal(s.workflow)); abort = true;
  const accepted = await f.committer.commit('publish-1', { signal: controller.signal });
  assert.equal(controller.signal.aborted, true); assert.equal(accepted.status, 'committed');
  assert.deepEqual((await f.make().commit('publish-1')).receipt, accepted.receipt);
});

test('a fenced-and-reactivated authority cannot refresh an old prepared revision into a fresh write', async t => {
  const f = await namespaceLifecycleFixture(t), s = await f.committer.capture();
  await f.committer.prepare(s, f.proposal(s.workflow));
  await f.update('state', LIFECYCLE_AUTHORITY_KEY, { ...f.enrolled, status: 'fenced' });
  await f.update('state', LIFECYCLE_AUTHORITY_KEY, f.enrolled);
  await assert.rejects(f.committer.commit('publish-1'), { code: 'SDA_NAMESPACE_REVISION_CONFLICT' });
  assert.equal((await f.committer.inspect('publish-1')).status, 'prepared');
  assert.equal((await f.records.read(f.scope, 'state', f.headKey)).record.value.sequence, 0);
});

test('evidence is checked again at commit and an absent blob leaves the prepared operation recoverable', async t => {
  let missing = false, evidence;
  const f = await namespaceLifecycleFixture(t, { contentWrap: content => ({ descriptor: content.descriptor,
    put: content.put.bind(content), async read(scope, reference, options) {
      return missing && reference.sha256 === evidence.sha256 ? { status: 'missing', reference, data: null } : content.read(scope, reference, options);
    } }) });
  evidence = (await f.content.put(f.scope, 'evidence', Buffer.from('Retained test execution.'))).reference;
  const s = await f.committer.capture(); await f.committer.prepare(s, f.proposal(s.workflow, 'publish-1', { evidence: [evidence] }));
  missing = true;
  await assert.rejects(f.committer.commit('publish-1'), { code: 'ENGINE_STORAGE_CONTENT_MISSING' });
  assert.equal((await f.committer.inspect('publish-1')).status, 'prepared');
  missing = false; assert.equal((await f.committer.commit('publish-1')).status, 'committed');
});

test('body encoding, unsupported state versions and non-finite JSON remain refusals before preparation', async t => {
  const f = await namespaceLifecycleFixture(t), s = await f.committer.capture();
  const body = JSON.parse(f.encode(s.workflow));
  for (const state of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from(JSON.stringify({ ...body, schemaVersion: 3 }))]) {
    await assert.rejects(f.committer.prepare(s, f.proposal(s.workflow, 'invalid-state', { state })),
      error => ['ENGINE_STORAGE_CORRUPT','ENGINE_STORAGE_UNSUPPORTED'].includes(error.code));
  }
  const overflow = f.encode({ ...s.workflow, numeric: 'NUMBER_TOKEN' }).toString().replace('"NUMBER_TOKEN"', '1e999');
  await assert.rejects(f.committer.prepare(s, f.proposal(s.workflow, 'overflow', { state: Buffer.from(overflow) })), { code: 'ENGINE_STORAGE_CORRUPT' });
  assert.equal((await f.committer.inspect('overflow')).status, 'missing');
});

test('checkpoint preparation itself is conditional on the captured authority and Story revisions', async t => {
  const f = await namespaceLifecycleFixture(t), s = await f.committer.capture();
  await f.update('state', LIFECYCLE_AUTHORITY_KEY, { ...f.enrolled, status: 'fenced' });
  await assert.rejects(f.committer.prepare(s, f.proposal(s.workflow)), { code: 'SDA_NAMESPACE_REVISION_CONFLICT' });
  assert.equal((await f.committer.inspect('publish-1')).status, 'missing');
});

test('receipt validation does not assume record ordering or derive record revisions from a transaction revision', async t => {
  const f = await namespaceLifecycleFixture(t, { recordsWrap: records => wrap(records, {
    async transact(...args) { const result = await records.transact(...args); return { ...result, receipt: { ...result.receipt, records: [...result.receipt.records].reverse() } }; },
    async inspectOperation(...args) { const result = await records.inspectOperation(...args);
      return result.status === 'committed' ? { ...result, receipt: { ...result.receipt, records: [...result.receipt.records].reverse() } } : result; }
  }) });
  const s = await f.committer.capture(); await f.committer.prepare(s, f.proposal(s.workflow));
  const a = await f.committer.commit('publish-1'), b = await f.committer.commit('publish-1');
  assert.deepEqual(a.receipt, b.receipt); assert.equal(b.replayed, true);
});

test('a second empty-PATH process can recover a real SQLite operation without Git, filesystem discovery or providers', async t => {
  const f = await namespaceLifecycleFixture(t, { backend: 'sqlite' }), s = await f.committer.capture();
  await f.committer.prepare(s, f.proposal(s.workflow));
  const source = `
    import {registerHooks} from 'node:module';
    import {createSqliteNamespaceStore} from ${JSON.stringify(new URL('../src/sda/sqlite-namespace-adapter.mjs', import.meta.url).href)};
    import {openNativeSqliteDatabase} from ${JSON.stringify(new URL('../src/sda/sqlite-native.mjs', import.meta.url).href)};
    import {createSqliteContentStore} from ${JSON.stringify(new URL('../src/sda/sqlite-content-adapter.mjs', import.meta.url).href)};
    const records=await createSqliteNamespaceStore({filename:${JSON.stringify(f.directory + '/records.db')},binding:{kind:'shared'}});
    const db=await openNativeSqliteDatabase(${JSON.stringify(f.directory + '/content.db')});
    const content=createSqliteContentStore({database:db,binding:{kind:'shared'}});
    const hooks=registerHooks({resolve(specifier,context,next){if(['node:child_process','node:fs','node:fs/promises'].includes(specifier)||/git-publication|state-stores|provider|cli\\.mjs/.test(specifier))throw new Error('forbidden '+specifier);return next(specifier,context);}});
    try {
      const {createNamespaceLifecycleCommitter}=await import(${JSON.stringify(new URL('../src/engine-storage/namespace-lifecycle-commit.mjs', import.meta.url).href)});
      const committer=createNamespaceLifecycleCommitter({records,content,scope:${JSON.stringify(f.scope)},workId:${JSON.stringify(f.workId)},authority:${JSON.stringify(f.authority)}});
      const a=await committer.commit('publish-1'),b=await committer.commit('publish-1');
      if(a.replayed||!b.replayed||a.receipt.revision!==b.receipt.revision)throw new Error('replay changed');
      console.log('recovered');
    }finally{hooks.deregister();records.close();db.close();}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module','-e',source], { env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message); assert.match(result.stdout, /recovered/);
  assert.equal((await f.committer.inspect('publish-1')).status, 'committed');
});
