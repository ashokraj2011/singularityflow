/** Operation wiring is observable without confusing it with readiness or human authority. */
import test from 'node:test';import assert from 'node:assert/strict';
import {createEngine,createStoryNextEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
const forbidden=()=>{throw Error('Inspecting host wiring must not read, authorize, execute or mutate.');};
test('a host reports exactly its captured ports without invoking them',()=>{
  const engine=createEngine({ports:{storyNext:{load:forbidden}}}),facts=engine.capabilities;
  assert.equal(facts,engine.capabilities);assert.deepEqual(facts.boundOperations,[{id:'story.next',port:'storyNext'}]);
  assert.equal(facts.boundOperations.length+facts.unboundOperations.length,ENGINE_OPERATIONS.length);
  assert.equal(facts.authorityGranted,false);assert.equal(facts.readinessEstablished,false);assert.ok(Object.isFrozen(facts));assert.ok(Object.isFrozen(facts.boundOperations));
  assert.throws(()=>facts.boundOperations.push({id:'phase.approve',port:'approval'}),TypeError);
});
test('explicit operation selection cannot expand after construction or fall through another domain owner',async()=>{
  const operations=['decision.scope'],failure=Object.freeze(Object.assign(Error('An actual scoped read was refused.'),{code:'EACCES'}));let calls=0;
  const engine=createEngine({ports:{decisionRecord:{operations,load(){calls++;throw failure;},prepare:forbidden,commit:forbidden,finish:forbidden}}});
  operations.push('decision.risk');assert.deepEqual(engine.capabilities.boundOperations.map(row=>row.id),['decision.scope']);
  await assert.rejects(engine.run('decision.risk',{obligationId:'OBL:example',category:'known-failure'}),error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required[0]==='decision.risk');assert.equal(calls,0);
  await assert.rejects(engine.run('decision.scope',{item:'SRI-example',disposition:'included'}),error=>error===failure);assert.equal(calls,1);
});
test('operation selections cannot contain unknown IDs, duplicates or operations from another port',()=>{
  for(const operations of [[],['invented'],['phase.approve'],['decision.scope','decision.scope'],'decision.scope'])assert.throws(
    ()=>createEngine({ports:{decisionRecord:{operations,load:forbidden,prepare:forbidden,commit:forbidden,finish:forbidden}}}),{code:'ENGINE_INPUT_INVALID'});
  const narrow=createStoryNextEngine({ports:{storyNext:{load:forbidden},publication:{load:forbidden,retained:forbidden,prepare:forbidden,commit:forbidden,finish:forbidden}}});
  assert.deepEqual(narrow.capabilities.boundOperations.map(row=>row.id),['story.next'],'a narrow runtime cannot advertise coordinators it does not contain');
});
test('namespace composition exposes its real operation owners without opening the stores',async t=>{
  const f=await namespaceEngineFixture(t,{working:false}),engine=f.make({records:{...f.records,read:forbidden,transact:forbidden},content:{...f.content,read:forbidden,put:forbidden}}),
    bound=new Set(engine.capabilities.boundOperations.map(row=>row.id));
  for(const id of ['test-cohort.context','test-cohort.confirm','test-risk.confirm-recovery','test-risk.context','decision.test-risk','evidence-reuse.context','decision.evidence-reuse','test-recovery.context','test-recovery.confirm','constitution.exception.context','decision.constitution-exception','source-review.context','source-review.record','phase.assign','decision.scope','decision.plan','plan.correction.record','decision.witness','upstream.raise','test-command.context','test-command.request','test-command.decide','forward-amendment.propose','forward-amendment.decide','forward-amendment.revalidate'])assert.ok(bound.has(id),id);
  assert.ok(bound.has('decisions.record'));
  assert.ok(bound.has('decision.risk'));
  for(const id of ['decision.witness-exception','test-witness.context'])assert.ok(bound.has(id),id);
  assert.equal(bound.has('phase.checks'),false);
  assert.equal(engine.capabilities.boundOperations.length+engine.capabilities.unboundOperations.length,ENGINE_OPERATIONS.length);
});

test('declared mandatory standalone inputs are rejected before any host read or effect',async()=>{
  const engine=createEngine({ports:{decisionRecord:{load:forbidden,prepare:forbidden,commit:forbidden,finish:forbidden}}});
  for(const operation of ['decision.constitution-exception','phase.assign','source-review.record','source-review.decide','plan.correction.record']){
    await assert.rejects(engine.run(operation,{}),{code:'ENGINE_INPUT_INVALID'});
    if(operation==='source-review.record')await assert.rejects(engine.run(operation,{operationId:'missing-report',phaseId:'intake',expectedContext:'sha256:value',report:null}),{code:'ENGINE_INPUT_INVALID'});
  }
});
test('native Git binding exposes its actual decision implementations without discovering a checkout',async()=>{
  const {createGitEngine}=await import('../src/engine-compatibility/git-publication.mjs'),{resolve}=await import('node:path'),
    {tmpdir}=await import('node:os'),engine=createGitEngine({root:resolve(tmpdir(),'native-binding-inspection-not-a-checkout')}).engine,
    ids=new Set(engine.capabilities.boundOperations.map(row=>row.id));
  for(const id of ['decision.scope','decision.risk','decision.witness','forward-amendment.decide','phase.publish'])assert.ok(ids.has(id),id);
  for(const id of ['phase.assign','source-review.record','source-review.decide','plan.correction.record','story.create'])assert.equal(ids.has(id),false,id);
});
