import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {createSgosOperationalCodec,assertSgosOperationalStoreAdapter,assertSgosOperationalStoreSelection} from '../src/sgos/operational-contract.mjs';
import {createMemorySgosOperationalStore} from '../src/sgos/operational-store.mjs';
const fixture=JSON.parse(await readFile(new URL('./fixtures/sgos-operational-store-packets/native-v1.json',import.meta.url),'utf8'));
const digest=value=>'sha256:'+createHash('sha256').update(canonicalJson(value)).digest('hex');

test('the extracted pure codec retains actual native v1 states, events, backups and rollback identities',async()=>{
  const codec=createSgosOperationalCodec({digest}),store=createMemorySgosOperationalStore({storeId:'compatibility-store'});
  assert.deepEqual(await store.read(),fixture.initial);
  assert.deepEqual(codec.state('compatibility-store',0,null,{}),fixture.initial);
  for(const event of fixture.backup.events)await store.transact({expectedRevision:event.revision-1,expectedStateSha256:event.beforeStateSha256,changes:event.changes});
  assert.deepEqual(await store.read(),fixture.second);assert.deepEqual(await store.exportBackup(),fixture.backup);
  assert.deepEqual(codec.replay('compatibility-store',fixture.backup.events).head,fixture.second);
  assert.deepEqual(codec.validateBackup(fixture.backup,'compatibility-store','memory-replay-v1').backup,fixture.backup);
  assert.deepEqual(await store.planRollback(1),fixture.rollback);
  assert.deepEqual(await store.rollback({revision:1,confirmationSha256:fixture.rollback.confirmationSha256}),fixture.rolledBack);
  assert.deepEqual(await store.read(),fixture.afterRollback);assert.deepEqual(await store.exportBackup(),fixture.afterBackup);
});

test('the extracted operational boundary retains native error fields and selection restrictions',async()=>{
  const store=createMemorySgosOperationalStore({storeId:'compatibility-store'});
  for(const event of fixture.backup.events)await store.transact({expectedRevision:event.revision-1,expectedStateSha256:event.beforeStateSha256,changes:event.changes});
  const captured=[];
  for(const run of [()=>assertSgosOperationalStoreAdapter({}),()=>assertSgosOperationalStoreSelection(store,{purpose:'runtime',
    programStorageProfileSha256:'sha256:'+'a'.repeat(64),selectedStorageProfileSha256:'sha256:'+'a'.repeat(64)}),
    ()=>store.transact({expectedRevision:0,expectedStateSha256:fixture.initial.stateSha256,changes:[{op:'put',key:'task/x',value:true}]}),
    ()=>store.transact({expectedRevision:fixture.second.revision,expectedStateSha256:fixture.second.stateSha256,changes:[{op:'delete',key:'missing'}]}),
    ()=>store.transact({expectedRevision:fixture.second.revision,expectedStateSha256:fixture.second.stateSha256,changes:[{op:'put',key:'task/one',value:true},{op:'delete',key:'task/one'}]})]) {
    try {await run();assert.fail('Expected the original refusal.');}
    catch(error){captured.push({name:error.name,code:error.code,message:error.message,...(error.details===undefined?{}:{details:error.details})});}
  }
  assert.deepEqual(captured,fixture.errors);
});

test('pure operational byte bounds preserve native UTF-8 lengths including escaped and non-BMP text',()=>{
  const codec=createSgosOperationalCodec({digest});
  for(const value of ['λ','😀','\ud800',{key:'line\n😀'}]) {
    const bytes=Buffer.byteLength(canonicalJson(value),'utf8');assert.equal(codec.bounded(value,bytes,'fixture'),bytes);
    assert.throws(()=>codec.bounded(value,bytes-1,'fixture'),{code:'SGOS_OPERATIONAL_STORE_LIMIT'});
  }
});
