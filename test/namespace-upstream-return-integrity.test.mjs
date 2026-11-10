import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceReleaseFixture} from './helpers/namespace-release-fixture.mjs';
import {createNamespaceCodeHistoryReader} from '../src/engine-storage/namespace-code-history.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
test('Code continuation refuses copied upstream receipts and preserves a real return read failure',{timeout:120000},async t=>{
  const f=await namespaceReleaseFixture(t);f.control.permissions.push('upstream.raise');
  await f.engine.run('upstream.raise',{operationId:'raise-real-return-provenance',phaseId:'build',about:'the actual boundary regression',
    problem:'The approved converter requires another regression bound to a freshly reviewed successor.',authored:'human',proposed:'return'});
  const reviewer=f.make({access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['upstream.decide']})}});
  await reviewer.run('upstream.decide',{operationId:'authentic-return-receipt',issueId:'UPI-001',outcome:'return',
    reason:'Repair the original converter through a separately retained and independently reviewed successor.'});
  const snapshot=await f.capture(),options={observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId},reader=createNamespaceCodeHistoryReader(options);
  assert.equal((await reader.opening(snapshot,'build')).length,1);
  for(const mutate of [workflow=>{workflow.changeRequests[0].requestedBy='copied-reviewer';},
    workflow=>{workflow.changeRequests[0].upstreamIssue.producer.record.sha256='f'.repeat(64);},
    workflow=>{workflow.namespaceDecisionReceipts=workflow.namespaceDecisionReceipts.filter(row=>row.operation!=='upstream.decide');}]){
    const forged=structuredClone(snapshot);mutate(forged.workflow);await assert.rejects(reader.opening(forged,'build'),{code:'ENGINE_STORAGE_CORRUPT'});}
  const reference=snapshot.workflow.namespaceDecisionReceipts.find(row=>row.operation==='upstream.decide').record,
    denied=Object.assign(Error('The original upstream return receipt cannot be read.'),{code:'EACCES'}),
    unavailable=createNamespaceCodeHistoryReader({...options,observer:createNamespaceStoryObserver({...f.common,content:{...f.content,read(scope,ref,options){
      if(ref.sha256===reference.sha256)throw denied;return f.content.read(scope,ref,options);}}})});
  await assert.rejects(unavailable.opening(snapshot,'build'),error=>error===denied);assert.deepEqual(await f.capture(),snapshot);
});
