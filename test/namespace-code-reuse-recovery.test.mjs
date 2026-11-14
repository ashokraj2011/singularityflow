import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceCodeReuseFixture,reuseReason} from './helpers/namespace-code-reuse-fixture.mjs';
import {verificationWorkflow} from './helpers/namespace-code-input-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
async function submitted(f){await f.engine.run('phase.submit',{phaseId:'build'});f.human();return (await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;}
async function approve(f,binding){await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});}
for(const backend of ['filesystem','sqlite','application'])test('an empty device renews the original approved producer and repository set: '+backend,{timeout:180000},async t=>{
 const f=await namespaceCodeReuseFixture(t,{backend,recovery:true,configure:verificationWorkflow}),[original]=await f.decideAll({expires:'2026-11-09'});await f.rebase();
 await f.engine.run('phase.publish',publish);await approve(f,await submitted(f));f.control.now='2026-11-10T00:00:00.000Z';
 const empty=f.make({sources:[],sourceReaders:[],working:null,checks:{mode:'retained-only'}}),view=(await empty.run('evidence-reuse.context',{phaseId:'build'})).manifest;
 assert.equal(view.profile,'sflow-namespace-evidence-reuse-context/v3');assert.equal(view.purpose,'renew-original-permission');assert.equal(view.sourceObservation,'retained-original');
 const action=view.actions.find(row=>row.operation==='decision.evidence-reuse');assert.equal(action.inputs.producerOperationId,f.producer.producerOperationId);
 const renewed=await empty.run(action.operation,{...action.inputs,reason:reuseReason,expires:'2026-12-01'});
 assert.deepEqual(renewed.record.producer,original.record.producer);assert.equal(f.starts(),1);
});
test('pending approval can renew exact permission without rewriting publication or inventing a newer test',{timeout:120000},async t=>{
 const f=await namespaceCodeReuseFixture(t,{recovery:true,configure:source=>{source.definition.testRecovery.maxEvidenceAgeSeconds=7*86400;}}),[original]=await f.decideAll({expires:'2026-11-09'});
 await f.rebase();await f.engine.run('phase.publish',publish);await submitted(f);const before=(await f.capture()).workflow.phases.build.publicationBindings[0];
 f.control.now='2026-11-10T00:00:00.000Z';const empty=f.make({sources:[],sourceReaders:[],working:null,checks:{mode:'retained-only'}}),view=(await empty.run('evidence-reuse.context',{phaseId:'build'})).manifest;
 const action=view.actions.find(row=>row.operation==='decision.evidence-reuse'),renewed=await empty.run(action.operation,{...action.inputs,reason:reuseReason,expires:'2026-12-01'});
 assert.deepEqual(renewed.record.producer,original.record.producer);assert.deepEqual((await f.capture()).workflow.phases.build.publicationBindings[0],before);
 const binding=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;await approve(f,binding);assert.equal(f.starts(),1);
});
test('renewing an upstream producer preserves a later phase repository selection',{timeout:180000},async t=>{
 const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
  .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
  +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n';
 const f=await namespaceCodeReuseFixture(t,{repositories:2,plan,recovery:true,configure:verificationWorkflow}),original=await f.decideAll({expires:'2026-11-09'});
 await f.rebase();await f.engine.run('phase.publish',publish);await approve(f,await submitted(f));f.author();f.control.agentId='verifier';
 await f.engine.run('source.bind',{operationId:'later-phase-source-selection',workId:f.inputs.workId,expectedRevision:(await f.head()).record.version,
  repositories:['app'],reason:'Select the later phase repository without replacing original approved Code evidence.'});
 const selection=(await f.capture()).workflow.sourceBindings;assert.equal(selection.current.repositories.length,1);f.human();f.control.now='2026-11-10T00:00:00.000Z';
 const empty=f.make({sources:[],sourceReaders:[],working:null,checks:{mode:'retained-only'}}),view=(await empty.run('evidence-reuse.context',{phaseId:'build'})).manifest;
 assert.equal(view.candidates.length,2);const renewed=[];
 for(const action of view.actions.filter(row=>row.operation==='decision.evidence-reuse'))renewed.push(await empty.run(action.operation,{...action.inputs,reason:reuseReason,expires:'2026-12-01'}));
 assert.deepEqual(renewed.map(row=>row.record.producer),original.map(row=>row.record.producer));assert.deepEqual((await f.capture()).workflow.sourceBindings,selection);assert.equal(f.starts(),2);
 f.control.now='2026-12-02T00:00:00.000Z';const again=(await empty.run('evidence-reuse.context',{phaseId:'build'})).manifest;
 for(const action of again.actions.filter(row=>row.operation==='decision.evidence-reuse')){
  const repeated=await empty.run(action.operation,{...action.inputs,reason:reuseReason,expires:'2026-12-20'});
  assert.ok(original.some(row=>row.record.producer.taskId===repeated.record.producer.taskId));
 }
 assert.deepEqual((await f.capture()).workflow.sourceBindings,selection);assert.equal(f.starts(),2);
});
test('a lost acknowledgement and parallel replays retain one Code reuse decision and no additional execution',{timeout:120000},async t=>{
 const f=await namespaceCodeReuseFixture(t,{recovery:true}),view=await f.view(),request={phaseId:'build',...f.producer,attemptId:view.manifest.candidates[0].taskId,reason:reuseReason};f.human();let lost=false;
 const failure=Object.freeze(Object.assign(Error('The accepted Code reuse acknowledgement timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:317}})),
  records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
   if(!lost&&tx.operationId.startsWith('lifecycle-')&&tx.changes.some(row=>row.namespace==='state'&&row.key.startsWith('stories/'))){lost=true;throw failure;}return result;}},engine=f.make({records});
 await assert.rejects(engine.run('decision.evidence-reuse',request),error=>error===failure);assert.equal(lost,true);
 const results=await Promise.all([engine.run('decision.evidence-reuse',request),engine.run('decision.evidence-reuse',request)]);
 assert.deepEqual(results[0].record,results[1].record);assert.equal((await f.capture()).workflow.namespaceEvidenceReuses.length,1);assert.equal(f.starts(),1);
});
test('fresh concurrent requests cannot record two permissions for one Code execution',{timeout:120000},async t=>{
 const f=await namespaceCodeReuseFixture(t,{recovery:true}),view=await f.view(),request={phaseId:'build',...f.producer,attemptId:view.manifest.candidates[0].taskId,reason:reuseReason};f.human();let clock=0;
 const engine=f.make({clock:{now:()=>new Date(Date.parse(f.control.now)+(++clock)).toISOString()}}),results=await Promise.allSettled([
  engine.run('decision.evidence-reuse',request),engine.run('decision.evidence-reuse',request)]),accepted=results.filter(row=>row.status==='fulfilled');
 assert.ok(accepted.length>=1);for(const row of results.filter(row=>row.status==='rejected'))assert.ok([
  'ENGINE_CONTEXT_CHANGED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED','EVIDENCE_REUSE_ALREADY_RECORDED'].includes(row.reason.code),row.reason.code);
 assert.deepEqual((await engine.run('decision.evidence-reuse',request)).record,accepted[0].value.record);
 assert.equal((await f.capture()).workflow.namespaceEvidenceReuses.length,1);assert.equal(f.starts(),1);
});
test('generic renewal selects the consumed execution among obsolete permissions',{timeout:120000},async t=>{
 const f=await namespaceCodeReuseFixture(t,{recovery:true,configure:verificationWorkflow}),[old]=await f.decideAll({expires:'2026-11-09'});
 await f.engine.run('decision.evidence-reuse',{revoke:old.record.id,reason:reuseReason});await f.rebase('new-full-execution-basis');
 const producer={producerPhaseId:'build',producerOperationId:'second-actual-execution'};await f.engine.run('phase.checks.run',{operationId:producer.producerOperationId,workId:f.inputs.workId,phaseId:'build'});
 f.human();const view=(await f.engine.run('evidence-reuse.context',{phaseId:'build',...producer})).manifest;
 const current=await f.engine.run('decision.evidence-reuse',{phaseId:'build',...producer,attemptId:view.candidates[0].taskId,reason:reuseReason,expires:'2026-11-09'});
 await f.rebase('consume-second-actual-execution');await f.engine.run('phase.publish',publish);await approve(f,await submitted(f));f.control.now='2026-11-10T00:00:00.000Z';
 const empty=f.make({sources:[],sourceReaders:[],working:null,checks:{mode:'retained-only'}}),renewal=(await empty.run('evidence-reuse.context',{phaseId:'build'})).manifest;
 assert.equal(renewal.candidates.length,1);assert.equal(renewal.candidates[0].taskId,current.record.producer.taskId);
 const action=renewal.actions.find(row=>row.operation==='decision.evidence-reuse');assert.equal(action.inputs.producerOperationId,producer.producerOperationId);
 const result=await empty.run(action.operation,{...action.inputs,reason:reuseReason,expires:'2026-12-01'});assert.deepEqual(result.record.producer,current.record.producer);assert.equal(f.starts(),2);
});
