import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createSqliteNamespaceStore} from '../src/sda/sqlite-namespace-adapter.mjs';
import {openSqliteNamespaceJournal} from '../src/sda/sqlite-namespace-journal.mjs';
import {putTransaction} from './helpers/namespace-conformance.mjs';
const scope={projectId:'reused-project'},binding={kind:'shared'};
async function fixture(t){const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-validated-sqlite-')),filename=path.join(directory,'records.db'),
  store=await createSqliteNamespaceStore({filename,binding,create:true}),handles=[store];
  t.after(async()=>{for(const handle of handles.reverse())handle.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  return {filename,store,handles};}
test('warm reads reuse one validated prefix while every request reads the live SQLite identity, head and change token',async t=>{
  const f=await fixture(t);await f.store.transact(scope,putTransaction('first','stories/one',{value:1}));
  const prepare=DatabaseSync.prototype.prepare;let histories=0,heads=0,tokens=0;
  t.mock.method(DatabaseSync.prototype,'prepare',function(sql){if(sql.startsWith('SELECT seq, body, sha256 FROM sflow_ns_entries'))histories++;
    if(sql.startsWith('SELECT seq, sha256 FROM sflow_ns_heads'))heads++;if(sql==='PRAGMA data_version')tokens++;return prepare.call(this,sql);});
  for(let i=0;i<12;i++)assert.equal((await f.store.read(scope,'state','stories/one')).record.value.value,1);
  assert.equal(histories,1);assert.equal(heads,12);assert.equal(tokens,24);
  const other=await createSqliteNamespaceStore({filename:f.filename,binding});f.handles.push(other);
  await other.transact(scope,putTransaction('second','stories/two',{value:2}));const before=histories;
  assert.equal((await f.store.read(scope,'state','stories/two')).record.value.value,2);assert.equal(histories,before+1);
  await f.store.transact(scope,putTransaction('third','stories/three',{value:3}));const own=histories;
  assert.equal((await f.store.read(scope,'state','stories/three')).record.value.value,3);assert.equal(histories,own+1);
});
test('a warm snapshot cannot hide an externally corrupted historical row even when its head is unchanged',async t=>{
  const f=await fixture(t);await f.store.transact(scope,putTransaction('first','stories/one',1));await f.store.read(scope,'state','stories/one');
  const db=new DatabaseSync(f.filename);try{db.prepare("UPDATE sflow_ns_entries SET body = body || 'tampered'").run();}finally{db.close();}
  for(let i=0;i<2;i++)await assert.rejects(f.store.read(scope,'state','stories/one'),{code:'SDA_NAMESPACE_CORRUPT'});
  assert.equal((await f.store.verify(scope)).valid,false);
});
test('journal views remain detached, and an external commit invalidates an observed append without losing the original record',async t=>{
  const f=await fixture(t);await f.store.transact(scope,putTransaction('first','stories/one',1));
  const journal=await openSqliteNamespaceJournal({filename:f.filename,binding});f.handles.push(journal);
  const first=await journal.read(scope);first.state.records.clear();const observed=await journal.read(scope);assert.equal(observed.state.records.size,1);
  const other=await createSqliteNamespaceStore({filename:f.filename,binding});f.handles.push(other);
  await other.transact({projectId:'another'},putTransaction('external','stories/other',1));
  const input=putTransaction('second','stories/two',2);assert.deepEqual(await journal.append(scope,observed,input),{accepted:false});
  assert.equal((await journal.append(scope,await journal.read(scope),input)).accepted,true);
  assert.equal((await f.store.read(scope,'state','stories/one')).record.value,1);assert.equal((await f.store.read(scope,'state','stories/two')).record.value,2);
});
