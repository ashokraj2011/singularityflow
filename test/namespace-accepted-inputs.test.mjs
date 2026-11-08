import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {createNamespaceLifecycleCodec} from '../src/engine-storage/namespace-lifecycle-codec.mjs';
import {createNamespaceDraftStore} from '../src/engine-storage/namespace-draft-store.mjs';
import {NAMESPACE_STORE_METHODS} from '../src/sda/namespace/contract.mjs';
function configure(source){
  source.definition.inputsMode='enforce';
  source.definition.phases.delivery={...structuredClone(source.definition.phases.intake),label:'Delivery',
    artifact:{path:'artifacts/delivery/report.md'},defaultTemplate:'intake.md',inputs:[{phase:'intake'}]};
  source.definition.phases.delivery.approval.rejectTo=['delivery'];
  source.definition.workTypes.simple.phases.push('delivery');source.agents[0].phases.push('delivery');source.agents[0].defaultFor.push('delivery');
}
const wrapped=(f,overrides)=>({descriptor:f.records.descriptor,...Object.fromEntries(NAMESPACE_STORE_METHODS.map(name=>[name,f.records[name].bind(f.records)])),...overrides});
async function json(f,reference){return JSON.parse(Buffer.from((await f.content.read(f.scope,reference)).data));}
test('upstream prompt inputs require actual accepted publication, submission and human approval without changing their context format',async t=>{
  const f=await namespaceEngineFixture(t,{backend:'sqlite',configure});await f.bootstrap();await f.author();await f.review();f.asAuthor();
  const snapshot=await f.capture(),phase=snapshot.workflow.phases.intake;
  const published=await json(f,phase.publicationBindings[0].record),packet=await json(f,phase.namespaceSubmission.record),vote=await json(f,phase.approvals[0].namespaceVote.record);
  const codec=createNamespaceLifecycleCodec({...f.options,textDigests:NODE_TEXT_DIGESTS}),before=await f.records.read(f.scope,'state',codec.headKey);
  for(const value of [published,packet,vote])await t.test(value.phase+': refuse uncommitted '+value.operationId,async()=>{
    const id=codec.keys(value.operationId).operation,records=wrapped(f,{async inspectOperation(scope,operationId,options){
      return operationId===id?{status:'missing',receipt:null}:f.records.inspectOperation(scope,operationId,options);}});
    await assert.rejects(f.make({records}).run('phase.prepare',{phaseId:'delivery'}),error=>error.code==='ENGINE_OPERATION_NOT_COMMITTED'
      &&error.details.operationId===value.operationId&&error.details.status==='prepared');
    assert.equal((await f.engine.run('phase.draft.read',{phaseId:'delivery'})).manifest.status,'missing');
    assert.deepEqual(await f.records.read(f.scope,'state',codec.headKey),before);
  });
  const original=Object.assign(Error('The remote receipt index exceeded its exact deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:300000,operationId:vote.operationId}});
  const records=wrapped(f,{async inspectOperation(scope,operationId,options){if(operationId===codec.keys(vote.operationId).operation)throw original;
    return f.records.inspectOperation(scope,operationId,options);}});
  await assert.rejects(f.make({records}).run('phase.prepare',{phaseId:'delivery'}),error=>error===original);
  await f.engine.run('phase.prepare',{phaseId:'delivery'});
  const local=createNamespaceDraftStore({records:f.local.records,content:f.local.content,scope:f.scope,workId:f.workId,phaseId:'delivery'}),draft=await local.capture();
  const context=JSON.parse(Buffer.from((await f.local.content.read(f.scope,draft.payload.inputContext)).data));
  assert.equal(context.schemaVersion,1);assert.equal(context.format,'sflow-namespace-preparation-context/v1');
  assert.deepEqual(context.resources.filter(item=>item.kind==='approved-input'),[{kind:'approved-input',phase:'intake',generation:1,
    reference:published.artifact.content,contract:[{phase:'intake',optional:false,maxBytes:null,path:'artifacts/intake/plan.md'}]}]);
  assert.equal((await f.engine.run('phase.draft.read',{phaseId:'delivery'})).manifest.status,'open');
});
