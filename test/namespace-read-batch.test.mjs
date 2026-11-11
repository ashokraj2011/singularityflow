import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {namespaceProjectFixture} from './helpers/namespace-project-fixture.mjs';
import {putTransaction} from './helpers/namespace-conformance.mjs';
import {readNamespaceBatch,attachNamespaceReadBatch,namespaceReadBatchRequest} from '../src/sda/namespace/read-batch.mjs';
import {captureNamespaceReadBindings,createNamespaceReadSession} from '../src/engine-storage/namespace-read-session.mjs';
import {createJournalNamespaceStore} from '../src/sda/namespace-journal-adapter.mjs';
import {openFilesystemNamespaceJournal} from '../src/sda/filesystem-namespace-journal.mjs';
const queries=[{kind:'record',namespace:'state',key:'batch/value'},{kind:'record',namespace:'evidence',key:'batch/absent'},{kind:'operation',operationId:'batch-create'}];
for(const backend of ['filesystem','sqlite','application'])test(backend+': one genuine snapshot preserves exact V1 records, receipts, fresh revisions and isolated read capabilities',async t=>{
  const f=await namespaceProjectFixture(t,{backend});await f.records.transact(f.scope,putTransaction('batch-create','batch/value',{value:1}));
  const first=await readNamespaceBatch(f.records,f.scope,queries);assert.ok(first);assert.equal(first.facts.length,3);
  assert.deepEqual(first.facts[0].result,await f.records.read(f.scope,'state','batch/value'));
  assert.deepEqual(first.facts[1].result,await f.records.read(f.scope,'evidence','batch/absent'));
  assert.deepEqual(first.facts[2].result,await f.records.inspectOperation(f.scope,'batch-create'));
  const version=first.facts[0].result.record.version;await f.records.transact(f.scope,putTransaction('batch-change','batch/value',{value:2},{version}));
  const next=await readNamespaceBatch(f.records,f.scope,queries);assert.ok(next.snapshot.sequence>first.snapshot.sequence);assert.equal(next.facts[0].result.record.value.value,2);
  assert.equal(first.facts[0].result.record.value.value,1);assert.ok(Object.isFrozen(first.facts));
  const session=createNamespaceReadSession({records:f.records,content:f.content}),captured=captureNamespaceReadBindings(session.records,session.content);
  assert.ok(await readNamespaceBatch(captured.records,f.scope,queries));assert.equal(await readNamespaceBatch({...captured.records},f.scope,queries),null);
  const error=Object.assign(Error('A custom namespace permission check denied the read.'),{code:'EACCES',details:{key:'batch/value'}}),
    decorated={...f.records,read(){throw error;}};
  assert.equal(await readNamespaceBatch(decorated,f.scope,queries),null);await assert.rejects(async()=>decorated.read(f.scope,'state','batch/value'),cause=>cause===error);
  const failing=attachNamespaceReadBatch({...f.records},async()=>{throw error;});await assert.rejects(readNamespaceBatch(failing,f.scope,queries),cause=>cause===error);
  const invalid=attachNamespaceReadBatch({...f.records},async()=>({...first,scope:{projectId:'another-project'}}));
  await assert.rejects(readNamespaceBatch(invalid,f.scope,queries),{code:'SDA_NAMESPACE_UNSUPPORTED'});
  const abort=new AbortController();abort.abort();await assert.rejects(readNamespaceBatch(f.records,f.scope,queries,{signal:abort.signal}),{code:'SDA_NAMESPACE_CANCELLED'});
});
test('the filesystem journal verifies one prefix for related reads and confirms actual receipt durability once',async t=>{
  const f=await namespaceProjectFixture(t),journal=await openFilesystemNamespaceJournal({root:path.join(f.directory,'records'),binding:f.records.descriptor.binding,limits:f.records.descriptor.limits});
  let reads=0,confirms=0;const measured={...journal,read(...args){reads++;return journal.read(...args);},confirm(...args){confirms++;return journal.confirm(...args);}},
    store=createJournalNamespaceStore({descriptor:f.records.descriptor,journal:measured});
  await store.transact(f.scope,putTransaction('batch-create','batch/value',{value:1}));reads=0;confirms=0;
  const expected=[await store.read(f.scope,'state','batch/value'),await store.read(f.scope,'evidence','batch/absent'),await store.inspectOperation(f.scope,'batch-create')];
  assert.equal(reads,3);reads=0;confirms=0;
  const result=await readNamespaceBatch(store,f.scope,queries);assert.deepEqual(result.facts.map(row=>row.result),expected);assert.equal(reads,1);assert.equal(confirms,1);
});
test('a read batch cannot contain writes, paths, unbounded requests or unknown keys',()=>{
  for(const requests of [[],Array.from({length:9},()=>queries[0]),[{kind:'put',namespace:'state',key:'x'}],[{kind:'record',namespace:'state',key:'../x'}],
    [{...queries[0],readiness:true}],[{kind:'operation',operationId:'../x'}]])assert.throws(()=>namespaceReadBatchRequest(requests),{code:'SDA_NAMESPACE_INPUT_INVALID'});
});
