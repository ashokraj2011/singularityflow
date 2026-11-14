import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {namespaceDataFixture} from './helpers/namespace-data-fixture.mjs';
for(const backend of ['filesystem','sqlite','application'])test(`${backend}: Git-free analytics binds real query quality and independent approval through completion`,async t=>{
  const f=await namespaceDataFixture(t,{backend});await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');
  const result=await f.execute();assert.equal(result.record.status,'passed');assert.equal(result.record.checks[0].observed,50);
  assert.equal((await f.engine.run('work-product.context',{phaseId:'analyze'})).actions[0].operation,'phase.enter','completed data does not ask to execute again');
  await f.authorAndSubmit('analyze');await f.approve('analyze');await f.authorAndSubmit('accept');await f.approve('accept');
  const end=await f.capture();assert.equal(end.workflow.status,'closed');assert.equal(end.workflow.namespaceDataExecutions.length,1);
  const review=await f.engine.run('phase.review',{phaseId:'accept'});assert.equal(review.manifest.integrity,'matched');
  const replay=await f.execute();assert.equal(replay.status,'retained');assert.deepEqual(replay.record,result.record);
});
test('real query process success does not satisfy a failed business criterion',async t=>{
  const f=await namespaceDataFixture(t,{expected:51});await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');
  const result=await f.execute();assert.equal(result.record.status,'failed');assert.equal(result.record.checks[0].observed,50);
  await assert.rejects(f.authorAndSubmit('analyze'),{code:'ENGINE_DATA_QUALITY_FAILED'});
  assert.equal((await f.capture()).workflow.phases.analyze.generation,0);
});
for(const backend of ['filesystem','sqlite','application'])test(`${backend}: batch acknowledgement replay retains a single committed sink write`,async t=>{
  const f=await namespaceDataFixture(t,{kind:'batch',backend});await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');
  const first=await f.execute(),next=await f.execute();assert.deepEqual(next.record,first.record);assert.equal(next.status,'retained');
  const sink=new DatabaseSync(f.sink.filename);try{assert.equal(sink.prepare('SELECT count(*) AS n FROM sflow_data_rows').get().n,1);}finally{sink.close();}
  await f.authorAndSubmit('analyze');await f.approve('analyze');await f.authorAndSubmit('accept');await f.approve('accept');assert.equal((await f.capture()).workflow.status,'closed');
});
for(const backend of ['filesystem','sqlite','application'])test(`${backend}: a human-approved current-phase query repair preserves the approved producer and the original failure`,async t=>{
  const f=await namespaceDataFixture(t,{backend,query:'SELECT sum(amount)-1 AS total FROM orders;'});await f.retainInputs();await f.authorAndSubmit('intake');await f.approve('intake');
  const original=(await f.capture()).workflow.phases.intake,failed=await f.execute();assert.equal(failed.record.status,'failed');
  const context=await f.engine.run('work-product.context',{phaseId:'analyze'}),content=await f.put('SELECT sum(amount) AS total FROM orders;'),input={
    operationId:'repair-query',workId:f.inputs.workId,phaseId:'analyze',assetId:'query',content,expected:context.expected,reason:'Correct the one-unit subtraction; retain the approved input dataset and expected revenue.'};
  await assert.rejects(f.engine.run('work-product.amend',input),{code:'ENGINE_AUTHORITY_REQUIRED'});
  const access={current:()=>({projectId:f.scope.projectId,principalId:'data-reviewer',actorKind:'human',identity:{name:'Data reviewer',email:'independent@example.test',login:null},agentId:'analyst',permissions:['work-product.amend']})};
  const amended=await f.make({access}).run('work-product.amend',input);assert.equal(amended.record.status,'amended');
  assert.equal((await f.engine.run('work-product.context',{phaseId:'analyze'})).actions[0].operation,'data.execute','an approved repair proceeds to its real rerun');
  assert.deepEqual((await f.capture()).workflow.phases.intake,original);const current=await f.execute('execute-repaired');assert.equal(current.record.status,'passed');
  await f.authorAndSubmit('analyze');await f.approve('analyze');await f.authorAndSubmit('accept');await f.approve('accept');
  const end=await f.capture();assert.deepEqual(end.workflow.namespaceDataExecutions.map(row=>row.status),['failed','passed']);assert.equal(end.workflow.status,'closed');
});
