import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {mkdtemp,realpath,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {DatabaseSync} from 'node:sqlite';
import {createSqliteContentStore} from '../src/sda/sqlite-content-adapter.mjs';
import {createSqliteDataExecutionUnit,sqliteDataRequest,SQLITE_DATA_DRIVER_SHA256} from '../src/sgos/sqlite-data-execution.mjs';
import {createExecutionUnitManifest,createAgentTaskContract,sha256} from '../src/sgos/node-execution-values.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {evaluateDataCriteria} from '../src/kernel/work-products.mjs';
import {sqliteDataObservation,sqliteDataObservationPreview} from '../src/sgos/sql-data-values.mjs';
const executable=await realpath(process.execPath),executableSha256=createHash('sha256').update(await readFile(executable)).digest('hex');
const data={schemaVersion:1,profile:'sflow-tabular-snapshot/v1',columns:[{name:'id',type:'integer',nullable:false},{name:'amount',type:'number',nullable:false}],rows:[{id:1,amount:20},{id:2,amount:30}]};
test('bounded diagnostic previews retain complete UTF-8 characters and the original error metadata',()=>{
  const message='x'+'界'.repeat(2000),details={deadlineMs:300000,stage:'dispatch'},
    observation=sqliteDataObservation({output:{profile:'sflow-sql-data-result/v1',modelInvocations:0,process:{closed:true,timedOut:true},
      diagnostic:{name:'TimeoutError',code:'ETIMEDOUT',message,details},effect:'unknown',result:null},
      usage:{modelInvocations:0,tokens:null,cost:null},recordedAt:'2026-11-14T00:00:00.000Z'}),preview=sqliteDataObservationPreview(observation);
  assert.equal(preview.diagnosticTruncated,true);assert.ok(Buffer.byteLength(preview.diagnostic.message)<=4096);
  assert.ok(message.startsWith(preview.diagnostic.message));assert.ok(!preview.diagnostic.message.includes('\uFFFD'));
  assert.equal(preview.diagnostic.code,'ETIMEDOUT');assert.deepEqual(preview.diagnostic.details,details);assert.equal(preview.process.timedOut,true);
  assert.equal(observation.diagnostic.message,message,'the retained full observation is never truncated');
});
async function fixture(t){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'sflow-data-execution-'))),scope={projectId:'finance'},database=new DatabaseSync(path.join(root,'content.db'));
  const content=createSqliteContentStore({database,binding:{kind:'shared'},create:true});t.after(async()=>{database.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const makeManifest=batch=>createExecutionUnitManifest({id:'sql-data',version:'1.0.0',publisher:'test-host',provider:'deterministic-sqlite',models:[],capabilities:{query:true,batch},
    sandbox:{kind:'fixed-sql-driver'},network:{mode:'deny'},toolPolicy:{profile:'sflow-sql-data-execution/v1',runtimeSha256:'sha256:'+executableSha256,driverSha256:SQLITE_DATA_DRIVER_SHA256,...(batch?{sinkId:'results',projectId:scope.projectId}:{})},risk:{class:'bounded'},tests:{conformanceReceiptSha256:sha256('test-only-conformance')}});
  const manifest=makeManifest(false),batchManifest=makeManifest(true);
  const make=extra=>createSqliteDataExecutionUnit({manifest:extra?.sink?batchManifest:manifest,executable,executableSha256,content,scope,authorize:()=>true,...extra});
  async function contract({query='SELECT sum(amount) AS total FROM orders;',kind='query',batchId=null}={}){
    const task=sqliteDataRequest({query,kind,batchId,datasets:[{table:'orders',data}]}),bytes=Buffer.from(canonicalJson(task)),saved=await content.put(scope,'evidence',bytes);
    return createAgentTaskContract({taskId:kind==='batch'?batchId:'analytics',processId:'data-job',instructionId:'approved-query',objective:'Execute the exact retained query and datasets.',
      acceptanceClauses:['AC-001'],policySnapshotSha256:sha256('policy'),programSha256:sha256('data-workflow'),inputs:['evidence:'+saved.reference.sha256+':'+saved.reference.bytes],
      readScope:[],writeScope:kind==='batch'?['sink:results']:[],forbiddenScope:[],allowedDevices:[],environmentManifestSha256:sha256('node-sqlite'),
      candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:['result'],budgets:{activeMinutes:1,modelInvocations:0,touchedResources:1},
      stopConditions:[],executionUnitManifestSha256:(kind==='batch'?batchManifest:manifest).manifestSha256});
  }
  async function run(unit,input){const h=await unit.start(input),events=[];for await(const e of unit.observe(h))events.push(e);await unit.quiesce(h);return {h,result:await unit.collect(h),events};}
  return {root,content,scope,manifest,make,contract,run,unit:make(),sink:{filename:path.join(root,'sink.db'),projectId:'finance',id:'results'}};
}
test('a real SQL query retains exact output and zero model calls without Git',async t=>{
  const f=await fixture(t),{result,events}=await f.run(f.unit,await f.contract());
  assert.equal(result.output.process.status,0,JSON.stringify(result.output));assert.deepEqual(result.output.result.data.rows,[{total:50}]);assert.equal(result.output.modelInvocations,0);assert.equal(result.output.diagnostic,null);
  assert.equal(result.output.effect,'none');assert.deepEqual(events.map(e=>e.type),['started','completed']);
  assert.equal(events[1].priorEventSha256,events[0].eventSha256);
  assert.equal(evaluateDataCriteria([{id:'AC-001',description:'Revenue reconciles.',metric:{kind:'sum',column:'total'},operator:'eq',expected:51}],result.output.result.data)[0].status,'failed');
});
test('query authorization denies writes, attachment, unapproved functions and trailing statements',async t=>{
  const f=await fixture(t);
  for(const query of ['DELETE FROM orders RETURNING id;',"ATTACH DATABASE ':memory:' AS external;",'SELECT random() AS total;','SELECT 1 AS total; SELECT 2 AS total;','SELECT 1e999 AS total;','SELECT 1 AS constructor;','SELECT 1 AS prototype;']){
    const {result}=await f.run(f.unit,await f.contract({query}));assert.equal(result.output.result,null,query);assert.notEqual(result.output.process.status,0);assert.ok(result.output.diagnostic.message);
  }
});
test('a repeated committed batch returns its original data without rerunning its query',async t=>{
  const f=await fixture(t),unit=f.make({sink:f.sink}),input=await f.contract({kind:'batch',batchId:'batch-1'}),first=await f.run(unit,input);
  assert.equal(first.result.output.effect,'confirmed',JSON.stringify(first.result.output));assert.equal(first.result.output.result.queryExecuted,true);
  const next=await f.run(f.make({sink:f.sink}),input);assert.equal(next.result.output.result.queryExecuted,false);assert.equal(next.result.output.result.sink.replayed,true);assert.equal(next.result.output.result.sink.originalContractSha256,input.contractSha256);
  assert.deepEqual(next.result.output.result.data,first.result.output.result.data);
  const sink=new DatabaseSync(f.sink.filename);try{assert.equal(sink.prepare('SELECT count(*) AS n FROM sflow_data_rows').get().n,1);}finally{sink.close();}
  const changed=await f.run(f.make({sink:f.sink}),await f.contract({kind:'batch',batchId:'batch-1',query:'SELECT 99 AS total;'}));
  assert.equal(changed.result.output.result,null);assert.equal(changed.result.output.diagnostic.code,'DATA_BATCH_ID_REUSED');
});
test('a sink with unrelated application tables is preserved',async t=>{
  const f=await fixture(t),db=new DatabaseSync(f.sink.filename);db.exec('CREATE TABLE precious(value TEXT); INSERT INTO precious VALUES(\'retained\');');db.close();
  const {result}=await f.run(f.make({sink:f.sink}),await f.contract({kind:'batch',batchId:'batch-1'}));assert.equal(result.output.result,null);
  const check=new DatabaseSync(f.sink.filename);try{assert.equal(check.prepare('SELECT value FROM precious').get().value,'retained');assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sflow_%'").get().n,0);}finally{check.close();}
});
test('real query output permits the declared row limit and refuses the next row without a partial dataset',async t=>{
  const f=await fixture(t),query=limit=>'WITH RECURSIVE sequence(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM sequence WHERE x<'+limit+') SELECT x AS value FROM sequence;';
  const bounded=await f.run(f.unit,await f.contract({query:query(10000)}));assert.equal(bounded.result.output.process.status,0);
  assert.equal(bounded.result.output.result.data.rows.length,10000);assert.deepEqual(bounded.result.output.result.data.rows.at(-1),{value:10000});
  const overflow=await f.run(f.unit,await f.contract({query:query(10001)}));assert.equal(overflow.result.output.result,null);
  assert.equal(overflow.result.output.diagnostic.code,'DATA_OUTPUT_LIMIT');
});
test('a native SQL deadline terminates the process and retains a timeout rather than an invented result',async t=>{
  const f=await fixture(t),unit=f.make({timeoutMs:100}),{result}=await f.run(unit,await f.contract({query:'WITH RECURSIVE sequence(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM sequence) SELECT sum(x) AS total FROM sequence;'}));
  assert.equal(result.output.process.timedOut,true);assert.equal(result.output.process.closed,true);assert.equal(result.output.result,null);assert.equal(result.output.modelInvocations,0);
});
test('changed permission, runtime digest and task binding refuse before launch',async t=>{
  const f=await fixture(t),input=await f.contract();let calls=0;
  await assert.rejects(f.make({authorize:()=>++calls===1}).start(input),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.throws(()=>f.make({executableSha256:'0'.repeat(64)}),{code:'SGOS_DATA_BINDING_INVALID'});
  assert.throws(()=>f.make({manifest:createExecutionUnitManifest({...Object.fromEntries(Object.entries(f.manifest).filter(([k])=>!['schemaVersion','kind','manifestSha256'].includes(k))),toolPolicy:{...f.manifest.toolPolicy,driverSha256:'sha256:'+'0'.repeat(64)}})}),{code:'SGOS_DATA_BINDING_INVALID'});
  await assert.rejects(f.unit.start({...input,taskId:'changed'}),{code:'SGOS_AGENT_TASK_CONTRACT_INVALID'});
  assert.throws(()=>f.make({manifest:createExecutionUnitManifest({...Object.fromEntries(Object.entries(f.manifest).filter(([k])=>!['schemaVersion','kind','manifestSha256'].includes(k))),provider:'direct-model',models:['model']})}),{code:'SGOS_DATA_BINDING_INVALID'});
});
test('sink inspection distinguishes real absence and an original committed batch without rerunning SQL',async t=>{
  const f=await fixture(t),unit=f.make({sink:f.sink}),contract=await f.contract({kind:'batch',batchId:'inspect-batch'});
  assert.equal((await unit.inspectBatch({contract})).status,'absent');await f.run(unit,contract);
  const observation=await unit.inspectBatch({contract});assert.equal(observation.status,'committed');assert.equal(observation.originalContractSha256,contract.contractSha256);
  const db=new DatabaseSync(f.sink.filename);try{assert.equal(db.prepare('SELECT count(*) AS n FROM sflow_data_rows').get().n,1);}finally{db.close();}
});
test('sink reconciliation enforces original input bounds, write scope, permission and cancellation before observation',async t=>{
  const f=await fixture(t),contract=await f.contract({kind:'batch',batchId:'inspect-refusals'}),unit=f.make({sink:f.sink});
  const changed=patch=>createAgentTaskContract({...Object.fromEntries(Object.entries(contract).filter(([key])=>!['schemaVersion','kind','contractSha256'].includes(key))),...patch});
  await assert.rejects(unit.inspectBatch({contract:changed({writeScope:['sink:another']})}),{code:'SGOS_DATA_TASK_INVALID'});
  await assert.rejects(unit.inspectBatch({contract:changed({inputs:[contract.inputs[0].replace(/:[0-9]+$/u,':999999999')]})}),error=>Boolean(error.code));
  await assert.rejects(f.make({sink:f.sink,authorize:()=>false}).inspectBatch({contract}),{code:'ENGINE_AUTHORITY_REQUIRED'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(unit.inspectBatch({contract,signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  assert.equal((await unit.inspectBatch({contract})).status,'absent','invalid inspection cannot create or commit a batch');
});
