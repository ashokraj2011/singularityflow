import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { namespaceReadFixture, readWorkflow } from './helpers/namespace-read-fixture.mjs';
import { createNamespaceReadEngine } from '../src/engine-storage/namespace-reader.mjs';
import { namespaceReadRecord } from '../src/engine-storage/namespace-read-contract.mjs';
import { openNativeSqliteDatabase } from '../src/sda/sqlite-native.mjs';
import { createSqliteContentStore } from '../src/sda/sqlite-content-adapter.mjs';
import { contentError } from '../src/sda/content/contract.mjs';
import path from 'node:path';

for (const backend of ['filesystem','sqlite']) test(`${backend} read host inspects retained bytes and reads exact generation references without recording approval`, async t => {
  const f = await namespaceReadFixture(t, { backend }), doc = await f.document({ bytes: Buffer.from('A β🙂 published summary.\n') });
  await f.seed(readWorkflow(f.workId, doc), [doc]);
  const review = await f.engine.run('phase.review', { phaseId: 'build', workId: f.workId });
  assert.equal(review.manifest.integrity, 'matched'); assert.equal(review.manifest.reviewBinding, null);
  assert.equal(review.manifest.approvalRecorded, false); assert.equal(review.manifest.items.length, 1);
  const result = await f.engine.run('document.read', { reference: review.manifest.items[0].reference, maximumBytes: 5 });
  assert.equal(result.document.integrity, 'matched'); assert.equal(result.document.content.text, 'A β');
  assert.equal(result.document.content.bytes, 4); assert.equal(result.document.content.truncated, true);
  for (const operation of ['phase.publish','phase.submit','phase.approve']) await assert.rejects(f.engine.run(operation, {}), { code: 'ENGINE_PORT_UNAVAILABLE' });
});

test('missing retained bindings remain visible, and changed bytes cannot acquire a submitted approval binding', async t => {
  const f = await namespaceReadFixture(t), doc = await f.document(), workflow = readWorkflow(f.workId, doc);
  await f.seed(workflow, []);
  const missing = await f.engine.run('phase.review');
  assert.equal(missing.manifest.items.length, 1); assert.equal(missing.manifest.items[0].integrity, 'unavailable');
  assert.equal(missing.manifest.items[0].error.code, 'ENGINE_STORAGE_CONTENT_MISSING');
  const changed = await f.document({ bytes: Buffer.from('Different draft bytes.\n') }); await f.seed(workflow, [changed]);
  const review = await f.engine.run('phase.review'); assert.equal(review.manifest.integrity, 'changed'); assert.equal(review.manifest.reviewBinding, null);
  const read = await f.engine.run('document.read', { reference: review.manifest.items[0].reference }); assert.equal(read.document.integrity, 'changed');
});

test('long submission histories exceed metadata record limits without sending the history to the SDK result', async t => {
  const f = await namespaceReadFixture(t), doc = await f.document();
  const submissions = Array.from({ length: 2500 }, () => ({ phase: 'build', generation: 1, projection: { agentBriefs: [] } }));
  await f.seed(readWorkflow(f.workId, doc, { submissions }), [doc]);
  assert.ok(f.state.head.state.bytes > f.records.descriptor.limits.maxValueBytes);
  const result = await f.engine.run('phase.review'); assert.equal(result.manifest.integrity, 'matched');
  assert.ok(JSON.stringify(result).length < 4096); assert.equal(JSON.stringify(result).includes('submissions'), false);
});

test('an updated read head invalidates the captured operation instead of mixing two generations', async t => {
  let mutate = null;
  const f = await namespaceReadFixture(t, { contentWrap: content => ({ ...content, async read(...args) {
    const result = await content.read(...args); if (mutate && args[1].namespace === 'evidence') { const action = mutate; mutate = null; await action(); } return result;
  } }) });
  const doc = await f.document(); await f.seed(readWorkflow(f.workId, doc), [doc]);
  mutate = () => f.head(f.state.head);
  await assert.rejects(f.engine.run('phase.review'), { code: 'ENGINE_CONTEXT_CHANGED' });
  assert.equal((await f.engine.run('phase.review')).manifest.integrity, 'matched');
});

test('local attachments ask for matching reupload on another device and never enter shared content', async t => {
  const f = await namespaceReadFixture(t), primary = await f.document(), data = Buffer.from('local requirement image');
  const localReference = { namespace: 'local', sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
  const attachment = await f.document({ id: 'DOC-001', phase: null, generation: null, sourceKey: 'attachments/image.png', role: 'file',
    kind: 'supporting-image', name: 'Input screenshot', encoding: 'binary', mimeType: 'image/png', locality: 'machine-local', reference: localReference });
  await f.seed(readWorkflow(f.workId, primary), [primary,attachment]);
  await assert.rejects(f.engine.run('document.read', { reference: 'DOC-001' }), { code: 'DOCUMENT_REUPLOAD_REQUIRED' });
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM sflow_content_objects WHERE namespace='local'").get().n, 0);
  const database = await openNativeSqliteDatabase(path.join(f.directory, 'device-b.db')); f.opened.push(database);
  const local = createSqliteContentStore({ database, binding: { kind: 'machine-local', deviceId: 'device-b' }, create: true });
  const reader = createNamespaceReadEngine({ records: f.records, content: f.content, localContent: local, scope: f.scope, workId: f.workId });
  await assert.rejects(reader.run('document.read', { reference: 'DOC-001' }), { code: 'DOCUMENT_REUPLOAD_REQUIRED' });
  await local.put(f.scope, 'local', data);
  const read = await reader.run('document.read', { reference: 'Input screenshot' });
  assert.equal(read.document.integrity, 'matched'); assert.equal(read.document.locality, 'machine-local'); assert.equal(read.document.content, null);
});

test('detached catalog documents, aliases and ambiguous names keep the shared lookup rules', async t => {
  const f = await namespaceReadFixture(t), primary = await f.document(), doc = await f.document({ id: 'DOC-001', role: 'file', phase: null,
    generation: null, sourceKey: 'references/api.md', name: 'API contract', aliases: ['legacy-contract'], status: 'detached' });
  await f.seed(readWorkflow(f.workId, primary), [primary,doc]);
  await assert.rejects(f.engine.run('document.read', { reference: 'DOC-001' }), { code: 'DOCUMENT_NOT_FOUND' });
  assert.equal((await f.engine.run('document.read', { reference: 'legacy-contract', includeDetached: true })).document.integrity, 'matched');
  const second = await f.document({ id: 'DOC-002', role: 'file', phase: null, generation: null, sourceKey: 'references/api-v2.md', name: 'API contract', aliases: ['legacy-contract'] });
  await f.seed(readWorkflow(f.workId, primary), [primary,doc,second]);
  await assert.rejects(f.engine.run('document.read', { reference: 'legacy-contract', includeDetached: true }), { code: 'DOCUMENT_REFERENCE_AMBIGUOUS' });
  assert.equal((await f.engine.run('document.read', { reference: 'API contract', includeDetached: true })).document.id, 'DOC-002');
});

test('cross-Story heads and unsupported read profiles cannot become accepted context', async t => {
  const f = await namespaceReadFixture(t), doc = await f.document(); await f.seed(readWorkflow(f.workId, doc), [doc]);
  await f.head({ ...f.state.head, workId: 'another-story' });
  await assert.rejects(f.engine.run('phase.review'), { code: 'ENGINE_STORAGE_CORRUPT' });
  await f.head({ ...f.state.head, schemaVersion: 2 });
  await assert.rejects(f.engine.run('phase.review'), error => error.code === 'ENGINE_STORAGE_UNSUPPORTED' && error.cause.code === 'SCHEMA_VERSION_FUTURE');
});

test('missing or invalid projection bytes preserve real storage failures rather than an empty Story', async t => {
  const f = await namespaceReadFixture(t), doc = await f.document(); await f.seed(readWorkflow(f.workId, doc), [doc]);
  await f.head(namespaceReadRecord('head', { ...Object.fromEntries(Object.entries(f.state.head).filter(([key]) => !['schemaVersion','format'].includes(key))),
    state: { namespace: 'state', bytes: 7, sha256: 'a'.repeat(64) } }));
  await assert.rejects(f.engine.run('phase.review'), { code: 'ENGINE_STORAGE_CONTENT_MISSING' });
});

test('unavailable evidence retains its actual storage cause and timeout details through the manifest', async t => {
  const cause = Object.assign(new Error('application storage deadline exceeded'), { code: 'ETIMEDOUT', errcode: 5, timedOut: true });
  const failure = contentError('The evidence read did not complete.', 'SDA_CONTENT_UNAVAILABLE', { stage: 'read', timedOut: true }, cause);
  const f = await namespaceReadFixture(t, { contentWrap: content => ({ ...content, async read(...args) {
    if (args[1].namespace === 'evidence') throw failure;
    return content.read(...args);
  } }) });
  const doc = await f.document(); await f.seed(readWorkflow(f.workId, doc), [doc]);
  const review = await f.engine.run('phase.review'), error = review.manifest.items[0].error;
  assert.equal(review.manifest.integrity, 'unavailable'); assert.equal(review.manifest.reviewBinding, null);
  assert.equal(error.code, 'SDA_CONTENT_UNAVAILABLE'); assert.equal(error.details.timedOut, true);
  assert.equal(error.cause.code, 'ETIMEDOUT'); assert.equal(error.cause.errcode, 5); assert.equal(error.cause.timedOut, true);
  await assert.rejects(f.engine.run('document.read', { reference: review.manifest.items[0].reference }), error => error === failure);
});

test('a small text preview never hides invalid UTF-8 or corruption beyond its returned prefix', async t => {
  const f = await namespaceReadFixture(t), doc = await f.document({ bytes: Buffer.from([65, 66, 255]) });
  await f.seed(readWorkflow(f.workId, doc), [doc]);
  const review = await f.engine.run('phase.review');
  assert.equal(review.manifest.integrity, 'matched');
  await assert.rejects(f.engine.run('document.read', { reference: review.manifest.items[0].reference, maximumBytes: 1 }), { code: 'DOCUMENT_ENCODING_INVALID' });
  f.database.prepare('UPDATE sflow_content_chunks SET content=? WHERE sha256=?').run(Buffer.from([65, 66, 67]), doc.content.sha256);
  await assert.rejects(f.engine.run('document.read', { reference: review.manifest.items[0].reference, maximumBytes: 1 }), { code: 'SDA_CONTENT_CORRUPT' });
});
