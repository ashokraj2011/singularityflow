import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceDataFixture} from './helpers/namespace-data-fixture.mjs';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceWorkProductOwners} from '../src/engine-storage/namespace-work-products-reader.mjs';
test('input-repair authority cannot substitute an ordinary human identity for configured presence evidence',()=>{
  const owner=createNamespaceWorkProductOwners({observer:{},scope:{projectId:'data'},workId:'story'}).owners.get('work-product.amend');
  assert.throws(()=>owner.authority({resolution:{presence:{status:'required'}}},{phaseId:'analyze'},{identity:{email:'reviewer@example.test'}}),
    error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required[0]==='person-presence');
});
test('work-product contexts reject foreign bindings and metadata injection before producing a route',async()=>{
  const value={workId:'story',phase:'analyze',generation:1,expected:'a'.repeat(64),inputs:[],outputs:[],missing:[],assets:[],criteria:[],latestExecution:null,actions:[]},
    make=read=>createEngine({ports:{workProductContext:{load:()=>({subject:{kind:'story',id:'story'},phase:{id:'analyze'}}),read:()=>read}}});
  for(const bad of [{...value,operation:'phase.approve'},{...value,effects:{approvalRecorded:true}},{...value,workId:'other'},{...value,phase:'other'},null])
    await assert.rejects(make(bad).run('work-product.context',{workId:'story',phaseId:'analyze'}),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.equal((await make(value).run('work-product.context',{workId:'story'})).operation,'work-product.context');
});
test('a query cannot run from retained but unapproved producer inputs',async t=>{
  const f=await namespaceDataFixture(t);await f.retainInputs();const view=await f.engine.run('work-product.context',{phaseId:'analyze'}),head=await f.head();
  await assert.rejects(f.engine.run('data.execute',{operationId:'too-early',workId:f.inputs.workId,phaseId:'analyze',expected:view.expected}),{code:'ENGINE_PHASE_UNAVAILABLE'});
  assert.deepEqual(await f.head(),head);
});
test('revoked dispatch permission preserves the intent, and restoration resumes its original exact request',async t=>{
  const f=await namespaceDataFixture(t);await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');const head=await f.head();let calls=0;
  f.control.draftHook=(_count,request)=>{if(request.operation==='data.execute'&&++calls===4)f.control.permissions=f.control.permissions.filter(p=>p!=='data.execute');};
  await assert.rejects(f.execute(),{code:'ENGINE_AUTHORITY_REQUIRED'});assert.deepEqual(await f.head(),head);
  f.control.draftHook=()=>{};f.control.permissions.push('data.execute');const restored=await f.execute();assert.equal(restored.record.status,'passed');
  const input=f.requests.get('execute-1');await assert.rejects(f.engine.run('data.execute',{...input,expected:'0'.repeat(64)}),{code:'ENGINE_OPERATION_ID_REUSED'});
});
test('a lost lifecycle acknowledgement returns the original query outcome without another launch',async t=>{
  const f=await namespaceDataFixture(t);await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');let lost=false,starts=0;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);if(!lost&&tx.changes.some(row=>row.namespace==='state')&&tx.changes.some(row=>row.value?.operation==='data.execute')){
    lost=true;throw Object.assign(new Error('Actual data acceptance reply timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:300000}});}return result;}},
    engine=f.make({records,data:{owner:f.data.owner,bindings:[{adapterId:'sql-data',unit:{...f.unit,start(...args){starts++;return f.unit.start(...args);}}}]}}),
    context=await engine.run('work-product.context',{phaseId:'analyze'}),input={operationId:'lost-query-reply',workId:f.inputs.workId,phaseId:'analyze',expected:context.expected};
  let first;
  try{first=await engine.run('data.execute',input);}catch(cause){assert.equal(cause.code,'ETIMEDOUT');assert.equal(cause.details.deadlineMs,300000);}
  const replay=await engine.run('data.execute',input);assert.equal(lost,true);assert.equal(replay.status,'retained');assert.equal(starts,1);assert.equal(replay.record.status,'passed');if(first)assert.deepEqual(first.record,replay.record);
});
test('concurrent workers cannot both claim a new data attempt from the same phase snapshot',async t=>{
  const f=await namespaceDataFixture(t);await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');
  let arrivals=0,release,starts=0;const ready=new Promise(resolve=>{release=resolve;}),
    records={...f.records,async transact(scope,tx,options){if(tx.operationId.startsWith('data-intent-')){if(++arrivals===2)release();await ready;}return f.records.transact(scope,tx,options);}},
    data={owner:f.data.owner,bindings:[{adapterId:'sql-data',unit:{...f.unit,start(...args){starts++;return f.unit.start(...args);}}}]},
    engines=[f.make({records,data}),f.make({records,data})],context=await f.engine.run('work-product.context',{phaseId:'analyze'}),
    results=await Promise.allSettled(engines.map((engine,i)=>engine.run('data.execute',{
      operationId:'concurrent-data-'+i,workId:f.inputs.workId,phaseId:'analyze',expected:context.expected})));
  assert.equal(arrivals,2);assert.equal(starts,1);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(results.find(row=>row.status==='rejected').reason.code,'SDA_NAMESPACE_REVISION_CONFLICT');
  assert.equal((await f.capture()).workflow.namespaceDataExecutions.length,1);
});
test('completed SGOS evidence can receive fresh lifecycle acceptance without the original interpreter or private files',async t=>{
  const f=await namespaceDataFixture(t);await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');let starts=0;
  const engine=f.make({data:{owner:f.data.owner,bindings:[{adapterId:'sql-data',unit:{...f.unit,start(...args){starts++;return f.unit.start(...args);},async collect(handle){
    const candidate=await f.unit.collect(handle);f.control.permissions=f.control.permissions.filter(p=>p!=='data.execute');return candidate;
  }}}]}}),context=await engine.run('work-product.context',{phaseId:'analyze'}),input={operationId:'pending-observation',workId:f.inputs.workId,phaseId:'analyze',expected:context.expected},head=await f.head();
  await assert.rejects(engine.run('data.execute',input),{code:'ENGINE_AUTHORITY_REQUIRED'});assert.deepEqual(await f.head(),head);assert.equal(starts,1);
  const retained=f.make({working:null,data:{mode:'retained-only'}});
  await assert.rejects(retained.run('data.execute',input),{code:'ENGINE_AUTHORITY_REQUIRED'});
  f.control.permissions.push('data.execute');const accepted=await retained.run('data.execute',input);assert.equal(accepted.status,'recorded');assert.equal(accepted.record.status,'passed');assert.equal(starts,1);
  assert.equal(accepted.effects.approvalRecorded,false);assert.equal(accepted.effects.storyAdvanced,false);
  const replay=await f.make({working:null,data:{mode:'retained-only'},clock:{now(){throw Error('Accepted replay cannot restamp an execution');}}}).run('data.execute',input);
  assert.equal(replay.status,'retained');assert.deepEqual(replay.record,accepted.record);
});
test('cancellation retains actual terminal truth and resumes the original operation without another launch',async t=>{
  const f=await namespaceDataFixture(t,{query:'WITH RECURSIVE sequence(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM sequence) SELECT sum(x) AS total FROM sequence;'});
  await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');const head=await f.head(),controller=new AbortController();let starts=0;
  const engine=f.make({data:{owner:f.data.owner,bindings:[{adapterId:'sql-data',unit:{...f.unit,async start(...args){
    starts++;const handle=await f.unit.start(...args);setTimeout(()=>controller.abort(),50);return handle;
  }}}]}}),context=await engine.run('work-product.context',{phaseId:'analyze'}),
    input={operationId:'cancelled-query',workId:f.inputs.workId,phaseId:'analyze',expected:context.expected};
  await assert.rejects(engine.run('data.execute',input,{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  assert.deepEqual(await f.head(),head,'cancellation must not grant lifecycle acceptance');
  const retained=await engine.run('data.execute',input);assert.equal(retained.record.status,'unavailable');assert.equal(starts,1);
  const read=async ref=>JSON.parse(Buffer.from((await f.content.read(f.scope,ref)).data)),report=await read(retained.record.execution);
  assert.equal(report.operationId,input.operationId);assert.equal(retained.effects.approvalRecorded,false);assert.equal(retained.effects.storyAdvanced,false);
});
test('batch replay under a distinct operation preserves original execution attribution and never inserts again',async t=>{
  const f=await namespaceDataFixture(t,{kind:'batch'});await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');
  const first=await f.execute('first-batch'),again=await f.execute('reconcile-batch');assert.notEqual(first.record.execution.sha256,again.record.execution.sha256);
  const read=async ref=>JSON.parse(Buffer.from((await f.content.read(f.scope,ref)).data)),a=await read(first.record.execution),b=await read(again.record.execution);
  assert.notEqual(a.contract.contractSha256,b.contract.contractSha256);assert.deepEqual(first.record.asset.content,again.record.asset.content);
  const replay=await f.make({working:null,data:{mode:'retained-only'},clock:{now(){throw Error('Retained takeover has no clock');}}}).run('data.execute',f.requests.get('reconcile-batch'));
  assert.equal(replay.status,'retained');assert.deepEqual(replay.record,again.record);
});
test('a work-product phase enters with its exact approved policy and readable input resources',async t=>{
  const f=await namespaceDataFixture(t),future=await f.engine.run('work-product.context',{phaseId:'analyze'}),next=future.actions[0];
  assert.equal(next.operation,'phase.enter');assert.equal(next.inputs.phaseId,'intake','a future phase does not request a nonexistent publication review');
  const initial=await f.engine.run(next.operation,{...next.inputs,compose:true});
  assert.equal(initial.manifest.contract,'sflow-phase-entry-manifest/v6');assert.equal(initial.manifest.workProducts.policy.requirements[0].id,'REQ-REVENUE');
  await f.retainInputs();const retained=await f.engine.run('phase.enter',{phaseId:'intake',compose:true});
  for(const asset of retained.manifest.workProducts.outputs)assert.equal(retained.manifest.resources.filter(row=>row.reference.sha256===asset.content.sha256).length,1,'one exact resource per retained asset');
  const draft=(await f.capture()).workflow.namespaceDocuments.find(row=>row.kind==='work-product:query'),
    draftRead=await f.engine.run('document.read',{reference:draft.id});
  assert.equal(draftRead.document.integrity,'matched');assert.equal(draftRead.document.observed.sha256,draft.content.sha256);
  assert.equal(draftRead.document.phase,null,'Story input availability does not claim a published generation');
  await f.authorAndSubmit('intake');await f.approve('intake');
  const entry=await f.engine.run('phase.enter',{phaseId:'analyze',compose:true}),products=entry.manifest.resources.filter(row=>row.kind==='work-product');assert.equal(products.length,2);
  assert.equal(entry.manifest.workProducts.policy.phases[1].criteria[0].id,'AC-RECONCILE');
  for(const resource of products){const result=await f.engine.run('phase.context.read',{workId:f.inputs.workId,phaseId:'analyze',contextSha256:entry.manifest.context.sha256,resourceId:resource.id});assert.equal(result.content.kind,'text');assert.equal(result.content.truncated,false);assert.deepEqual(result.reference,resource.reference);}
  assert.equal(entry.effects.modelInvocations,0);
  await f.execute();const executed=await f.engine.run('phase.enter',{phaseId:'analyze',compose:true});
  for(const asset of executed.manifest.workProducts.outputs)assert.equal(executed.manifest.resources.filter(row=>row.reference.sha256===asset.content.sha256).length,1,'execution output cannot be repeated as a supporting document');
});
test('published data remains generation-bound and cannot be replaced while awaiting approval',async t=>{
  const f=await namespaceDataFixture(t);await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');const execution=await f.execute();await f.authorAndSubmit('analyze');
  const context=await f.engine.run('work-product.context',{phaseId:'analyze'}),head=await f.head();assert.equal(context.generation,1);assert.equal(context.latestExecution.operationId,execution.record.operationId);
  assert.deepEqual(context.actions.map(row=>row.operation),['phase.review']);
  await assert.rejects(f.engine.run('data.execute',{operationId:'after-publication',workId:f.inputs.workId,phaseId:'analyze',expected:context.expected}),{code:'PHASE_ALREADY_PUBLISHED'});
  assert.deepEqual(await f.head(),head);await f.approve('analyze');
});
test('a timed-out batch is reconciled as absent before its human-approved query repair runs',async t=>{
  const f=await namespaceDataFixture(t,{kind:'batch',timeoutMs:500,query:'WITH RECURSIVE sequence(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM sequence) SELECT sum(x) AS total FROM sequence;'});
  await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');const failed=await f.execute();assert.equal(failed.record.status,'unavailable');assert.equal(failed.record.observation.process.timedOut,true);
  const context=await f.engine.run('work-product.context',{phaseId:'analyze'});f.control.permissions.push('work-product.amend');
  await f.engine.run('work-product.amend',{operationId:'bounded-query-repair',workId:f.inputs.workId,phaseId:'analyze',assetId:'query',expected:context.expected,
    content:await f.put('SELECT sum(amount) AS total FROM orders;'),reason:'Replace the unbounded recursive query with the approved finite revenue aggregation.'});
  // The first adapter deliberately imposes a fault-injection deadline. A repaired
  // operation uses the normal execution window, still inside the pinned task budget.
  const repaired=f.make({data:{owner:f.data.owner,bindings:[{adapterId:'sql-data',unit:f.makeUnit(30000)}]}}),
    current=await repaired.run('work-product.context',{phaseId:'analyze'}),
    actual=await repaired.run('data.execute',{operationId:'reconciled-data',workId:f.inputs.workId,phaseId:'analyze',expected:current.expected,batchId:'batch-1'});
  assert.equal(actual.record.status,'passed',JSON.stringify(actual.record.observation));
  const {dataExecutionKey}=await import('../src/engine-storage/namespace-data-reader.mjs'),intent=(await f.records.read(f.scope,'runtime',dataExecutionKey(f.scope,f.inputs.workId,'reconciled-data')+'/intent')).record.value,
    observation=JSON.parse(Buffer.from((await f.content.read(f.scope,intent.reconciliation.observation)).data));
  assert.equal(observation.status,'absent');assert.deepEqual(intent.reconciliation.previous,failed.record.execution);
  assert.deepEqual((await f.capture()).workflow.namespaceDataExecutions.map(row=>row.status),['unavailable','passed']);
});
test('actual SQL diagnostics are readable through issued references and failed contexts lead to repair rather than another blind run',async t=>{
  const table='missing_'.repeat(800),f=await namespaceDataFixture(t,{query:'SELECT value FROM "'+table+'";'});
  await f.retainInputs();assert.equal((await f.engine.run('work-product.context',{phaseId:'intake'})).actions[0].operation,'phase.enter');
  await f.authorAndSubmit('intake');await f.approve('intake');const failed=await f.execute();assert.equal(failed.record.status,'unavailable');
  const observation=failed.record.observation;assert.equal(observation.process.status,1);assert.match(observation.diagnostic.message,/no such table/u);
  assert.equal(observation.diagnosticTruncated,true);assert.ok(Buffer.byteLength(observation.diagnostic.message)<=4096);
  const context=await f.engine.run('work-product.context',{phaseId:'analyze'});assert.equal(context.actions[0].operation,'work-product.amend');assert.deepEqual(context.latestExecution.observation,observation);
  await assert.rejects(f.authorAndSubmit('analyze'),error=>error.code==='ENGINE_WORK_PRODUCT_OUTPUT_REQUIRED'
    &&error.details.actions[0].operation==='work-product.amend'
    &&error.details.actions.at(-1).prerequisites.includes('correction-or-resolved-execution-environment'));
  const full=await f.engine.run('document.read',{reference:observation.documentId}),raw=JSON.parse(full.document.content.text);
  assert.ok(raw.diagnostic.message.includes(table));assert.equal(raw.process.closed,true);assert.equal(full.document.integrity,'matched');
  assert.equal(full.document.observed.sha256,observation.reference.sha256);assert.equal(full.document.observed.bytes,observation.reference.bytes);
  const entry=await f.engine.run('phase.enter',{phaseId:'analyze',compose:true}),resource=entry.manifest.resources.find(row=>row.kind==='execution-observation');assert.deepEqual(resource.reference,observation.reference);
  const read=await f.engine.run('phase.context.read',{workId:f.inputs.workId,phaseId:'analyze',contextSha256:entry.manifest.context.sha256,resourceId:resource.id});assert.equal(read.content.kind,'text');
});
test('a missing active index cannot erase the original data attempt and authorize another query',async t=>{
  const f=await namespaceDataFixture(t);await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');await f.execute();
  let starts=0;const records={...f.records,async read(scope,namespace,key,options){if(namespace==='runtime'&&key.startsWith('work-products/data-active/')&&!key.endsWith('/genesis'))return {status:'missing',record:null};return f.records.read(scope,namespace,key,options);}},
    engine=f.make({records,data:{owner:f.data.owner,bindings:[{adapterId:'sql-data',unit:{...f.unit,start(...args){starts++;return f.unit.start(...args);}}}]}}),
    context=await engine.run('work-product.context',{phaseId:'analyze'});
  await assert.rejects(engine.run('data.execute',{operationId:'lost-index-query',workId:f.inputs.workId,phaseId:'analyze',expected:context.expected}),{code:'ENGINE_DATA_EXECUTION_PENDING'});assert.equal(starts,0);
});
test('an active data index cannot borrow an older accepted intent or silently downgrade a future version',async t=>{
  const f=await namespaceDataFixture(t);await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');await f.execute('original-run');await f.execute('latest-run');
  for(const mode of ['older-intent','future-version']){let starts=0;
    const records={...f.records,async read(scope,namespace,key,options){const result=await f.records.read(scope,namespace,key,options);
      if(namespace==='runtime'&&key.startsWith('work-products/data-active/')&&!key.endsWith('/genesis')&&result.record){
        const value={...result.record.value,...(mode==='older-intent'?{operationId:'original-run'}:{schemaVersion:2})};return {...result,record:{...result.record,value}};}return result;}},
      engine=f.make({records,data:{owner:f.data.owner,bindings:[{adapterId:'sql-data',unit:{...f.unit,start(...args){starts++;return f.unit.start(...args);}}}]}}),context=await engine.run('work-product.context',{phaseId:'analyze'});
    await assert.rejects(engine.run('data.execute',{operationId:'refuse-'+mode,workId:f.inputs.workId,phaseId:'analyze',expected:context.expected}),
      {code:mode==='older-intent'?'ENGINE_STORAGE_CORRUPT':'SCHEMA_VERSION_FUTURE'});assert.equal(starts,0);
  }
});
test('actual operation-inspection timeouts keep their original details and launch no replacement data task',async t=>{
  const f=await namespaceDataFixture(t);await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');await f.execute();let starts=0;
  const records={...f.records,async inspectOperation(scope,id,options){if(id.startsWith('data-intent-'))throw Object.assign(Error('The actual receipt read exceeded its deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:300000,stage:'inspect-operation'}});return f.records.inspectOperation(scope,id,options);}},
    engine=f.make({records,data:{owner:f.data.owner,bindings:[{adapterId:'sql-data',unit:{...f.unit,start(...args){starts++;return f.unit.start(...args);}}}]}}),context=await engine.run('work-product.context',{phaseId:'analyze'});
  await assert.rejects(engine.run('data.execute',{operationId:'inspection-timeout',workId:f.inputs.workId,phaseId:'analyze',expected:context.expected}),
    error=>error.code==='ETIMEDOUT'&&error.details.deadlineMs===300000&&error.details.stage==='inspect-operation');assert.equal(starts,0);
});
