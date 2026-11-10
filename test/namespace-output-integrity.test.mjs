import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespacePublicationReader} from '../src/engine-storage/namespace-publication-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceLifecycleCommitter} from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
test('supporting output never changes clause scope; publication fences its exact index and exposes the retained file for review',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t);f.control.permissions.push('phase.output.retain');const name='singularity/work-items/'+f.inputs.workId+'/evidence/supporting.bin',
    input=async(operationId,bytes)=>({operationId,workId:f.inputs.workId,phaseId:'build',path:name,content:(await f.localContent.put(f.scope,'local',Buffer.from(bytes))).reference}),
    first=await input('supporting-first',[0,1,2]),replacement=await input('supporting-replacement',[0,3,4]),head=await f.head();
  await f.engine.run('phase.output.retain',first);assert.deepEqual(await f.head(),head);let intervened=false,originalOperation;
  const racing=createNamespaceEngine({...f.options,checks:f.checks,records:{...f.records,async transact(scope,tx,options){
    if(!intervened&&tx.events?.some(row=>row.payload?.operation==='phase.publish')){intervened=true;
      originalOperation=tx.changes.find(row=>row.namespace==='evidence'&&row.value?.operation==='phase.publish').value.operationId;
      await f.engine.run('phase.output.retain',replacement);}
    return f.records.transact(scope,tx,options);}}});
  await assert.rejects(racing.run('phase.publish',publish),{code:'SDA_NAMESPACE_REVISION_CONFLICT'});assert.equal(intervened,true);assert.deepEqual(await f.head(),head);
  const committer=createNamespaceLifecycleCommitter(f.common),original=await committer.intent(originalOperation);
  assert.ok(original.evidence.some(row=>row.sha256===first.content.sha256),'the original failed intent keeps its own reviewed bytes');
  const result=await f.engine.run('phase.publish',publish);assert.equal(result.status,'published');
  assert.deepEqual(await committer.intent(originalOperation),original);
  const snapshot=await f.capture(),published=await f.json(snapshot.workflow.phases.build.publicationBindings[0].record);
  assert.notEqual(published.operationId,originalOperation);assert.ok(snapshot.workflow.phases.build.artifacts.some(row=>row.path===name&&row.sha256===replacement.content.sha256));
  assert.equal(f.starts(),1,'supporting output never starts or invents a test run');
});
test('a published supporting file has exact review resources and cannot supply an invented visual slot',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t);f.control.permissions.push('phase.output.retain','witness.context');
  const content=(await f.localContent.put(f.scope,'local',Buffer.from([0,255,0,1]))).reference,file='singularity/work-items/'+f.inputs.workId+'/evidence/supporting.bin';
  await f.engine.run('phase.output.retain',{operationId:'review-supporting-file',workId:f.inputs.workId,phaseId:'build',path:file,content});
  await f.engine.run('phase.publish',publish);await f.engine.run('phase.submit',{phaseId:'build'});
  const {manifest}=await f.engine.run('phase.review',{phaseId:'build'});assert.equal(manifest.integrity,'matched');
  assert.ok(manifest.items.some(row=>row.kind==='retained-output'&&row.expected.sha256===content.sha256&&row.integrity==='matched'));
  const snapshot=await f.capture(),binding=snapshot.workflow.phases.build.publicationBindings[0],publication=await f.json(binding.record),
    observer=createNamespaceStoryObserver(f.common),checks=createNamespacePhaseCheckReader({...f.common,observer}),reader=createNamespacePublicationReader({observer,scope:f.scope,workId:f.inputs.workId,checks}),verified=await reader.read(binding,'build'),
    proof=publication.policyEvidence.find(row=>row.kind==='code-delivery/v12');assert.ok(proof);
  const plan=(await observer.accepted(publication.operationId)).plan,fences=reader.policies.readBindings(verified),index=fences.find(row=>row.key.startsWith('output-retention/generations/'));
  assert.ok(index);assert.throws(()=>reader.verifyPlan(verified,{...plan,readBindings:plan.readBindings.filter(row=>canonicalJson(row)!==canonicalJson(index))}),{code:'ENGINE_STORAGE_CORRUPT'});
  await assert.rejects(f.engine.run('witness.context',{clauseId:'STORY-1:AC-001',slotName:'invented-visual',file}),{code:'WITNESS_RECORD_INVALID'});
});
test('retention operations cannot be repurposed as canonical lifecycle writes',async t=>{
  const f=await namespaceTestWitnessFixture(t),committer=createNamespaceLifecycleCommitter(f.common),snapshot=await committer.capture(),head=await f.head();
  for(const operation of ['phase.output.retain','phase.source.retain','source.baseline.retain','phase.source-control.retain'])await assert.rejects(committer.prepare(snapshot,{
    operationId:'invalid-lifecycle-'+operation.replaceAll('.','-'),operation,inputsSha256:'a'.repeat(64),state:Buffer.from('{}'),evidence:[]}),{code:'ENGINE_INPUT_INVALID'});
  assert.deepEqual(await f.head(),head);
});
