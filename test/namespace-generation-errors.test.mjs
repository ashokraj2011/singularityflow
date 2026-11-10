import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespaceDraftStore} from '../src/engine-storage/namespace-draft-store.mjs';
import {createNamespaceSourceRetentionReader} from '../src/engine-storage/namespace-source-retention-reader.mjs';
test('continued generation reads preserve original shared permission and timeout errors without changing its draft',async t=>{
  const f=await namespaceTestWitnessFixture(t,{run:false,afterPrepare:async(f,engine)=>{
    f.control.permissions.push('decision.plan');const previous={principalId:f.control.principalId,agentId:f.control.agentId,creator:f.control.creator};
    Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
    try{await engine.run('decision.plan',{operationId:'continue-before-source-error',changes:[{kind:'add-location',clauseId:'STORY-1:REQ-001',path:'src/test/setup.js'}],
      reason:'Account for the actual supporting browser setup in the approved converter plan.'});}finally{Object.assign(f.control,previous);}
    const {manifest}=await engine.run('phase.draft.read',{phaseId:'build'});
    await engine.run('phase.draft.rebase',{operationId:'source-error-continuation',workId:f.inputs.workId,phaseId:'build',expectedRevision:manifest.draft.revision,
      confirm:manifest.draft.bodySha256,reason:'Continue the opened generation after its exact human plan accounting.'});
  }}),local=createNamespaceDraftStore({records:f.localRecords,content:f.localContent,scope:f.scope,workId:f.inputs.workId,phaseId:'build'}),
    before=await local.capture(),intent=JSON.parse(Buffer.from(await local.bytes(before.payload.generationIntent.record))),blocked=intent.continuation.basis.head.state;
  for(const code of ['EACCES','ETIMEDOUT']){
    const original=Object.freeze(Object.assign(Error('The real accepted predecessor read failed.'),{code,details:{deadlineMs:8888}}));
    const content={...f.content,read(scope,reference,options){if(reference.namespace===blocked.namespace&&reference.sha256===blocked.sha256)throw original;
      return f.content.read(scope,reference,options);}};
    await assert.rejects(f.make({content}).run('phase.draft.read',{phaseId:'build'}),error=>error===original);
    const reader=createNamespaceSourceRetentionReader({...f.common,content});
    await assert.rejects(reader.intent({operationId:'witness-current-source',workId:f.inputs.workId,phaseId:'build'}),error=>error===original);
    assert.deepEqual(await local.capture(),before);
  }
});
