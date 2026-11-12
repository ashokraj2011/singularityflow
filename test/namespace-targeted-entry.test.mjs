/** Real targeted provenance is checked before any authoring resource is returned. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTargetedRepairFixture} from './helpers/namespace-targeted-repair-fixture.mjs';
import {createNamespacePhaseEntryPorts} from '../src/engine-storage/namespace-phase-entry.mjs';
import {phaseEntryProtocol} from '../src/kernel/phase-entry.mjs';

test('targeted entry rejects malformed scope/provenance and rechecks exact resources, permissions and deadlines',{timeout:600000},async t=>{
  const f=await namespaceTargetedRepairFixture(t,{backend:'sqlite'});await f.reviewer.run('phase.reject',f.request);
  const before=await f.head(),port=createNamespacePhaseEntryPorts(f.common).phaseEntry,input={phaseId:'build'},
    context=await port.load(input),protocol=phaseEntryProtocol(context),binding=protocol.selection(context,input),facts=await port.inspect(context,binding);
  assert.equal(protocol.inspection(binding,facts).facts.repairScope.predecessor.generation,1);
  const invalid=[
    repair=>{repair.generation++;},repair=>{repair.predecessor.generation++;},
    repair=>{repair.current.repositories.push(structuredClone(repair.current.repositories[0]));},
    repair=>{repair.current.repositories=[];},repair=>{repair.current.repositories[0].paths=[];},
    repair=>{repair.current.clauseIds.push(repair.current.clauseIds[0]);},
    repair=>{repair.current.repositories[0].paths.push('../outside.js');},
    repair=>{repair.current.repositories[0].paths.push('src/*.js');},
    repair=>{repair.current.repositories[0].shared=[{path:'src/converter.js',clauseIds:repair.current.clauseIds}];},
    repair=>{repair.current.repositories[0].shared=[{path:'src/converter.js',clauseIds:['STORY-1:REQ-002']},{path:'src/converter.js',clauseIds:['STORY-1:REQ-002']}];},
    repair=>{repair.references=repair.references.filter(ref=>ref.sha256!==repair.predecessor.record.sha256);},
    repair=>{repair.plan.publication={...repair.plan.publication,namespace:'local'};},
    repair=>{repair.plan.reviewPacket={...repair.plan.reviewPacket,sha256:'f'.repeat(64)};}
  ];
  for(const mutate of invalid){const changed=structuredClone(facts);mutate(changed.repairScope);
    assert.throws(()=>protocol.inspection(binding,changed),{code:'ENGINE_PORT_RESULT_INVALID'});}
  const hidden=structuredClone(facts);hidden.resources=hidden.resources.filter(row=>row.reference.sha256!==facts.repairScope.sourceRecord.sha256);
  assert.throws(()=>protocol.inspection(binding,hidden),{code:'ENGINE_PORT_RESULT_INVALID'});
  // Existing v2 facts cannot silently accept a v4 scope or its additional resource role.
  const legacyContext={...context,manifestProfile:'sflow-phase-entry-manifest/v2'},legacy=phaseEntryProtocol(legacyContext),legacyBinding=legacy.selection(legacyContext,input);
  assert.throws(()=>legacy.inspection(legacyBinding,facts),{code:'ENGINE_PORT_RESULT_INVALID'});
  const oldFacts=structuredClone(facts);delete oldFacts.repairScope;oldFacts.resources=oldFacts.resources.filter(row=>row.kind!=='repair-scope');
  assert.equal(legacy.inspection(legacyBinding,oldFacts).facts.workId,f.inputs.workId);

  const entry=await f.engine.run('phase.enter',input),resource=entry.manifest.resources.find(row=>row.kind==='repair-scope'),
    read={workId:f.inputs.workId,phaseId:'build',contextSha256:entry.manifest.context.sha256,resourceId:resource.id};
  assert.equal((await f.engine.run('phase.context.read',read)).reference.sha256,resource.reference.sha256);
  for(const cancel of [false,true]){const controller=new AbortController();let calls=0;
    const access={async current(request){const result=await f.access.current(request);if(request.operation==='phase.context.read'&&++calls===2){
      if(cancel)controller.abort();else result.permissions=result.permissions.filter(permission=>permission!=='phase.draft.write');}return result;}};
    await assert.rejects(f.make({access}).run('phase.context.read',read,{signal:controller.signal}),{code:cancel?'ENGINE_OPERATION_CANCELLED':'ENGINE_CONTEXT_CHANGED'});
    assert.equal(calls,2);
  }
  for(const failure of [Object.assign(Error('The original repair evidence volume denied access.'),{code:'EACCES',path:'repair-evidence.db'}),
    Object.assign(Error('The original repair evidence deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:300000}})]){
    const content={...f.content,read(scope,ref,options){if(ref.sha256===resource.reference.sha256)throw failure;return f.content.read(scope,ref,options);}};
    await assert.rejects(f.make({content}).run('phase.context.read',read),actual=>actual===failure);
  }
  assert.deepEqual(await f.head(),before);
  await f.begin();await assert.rejects(f.engine.run('phase.context.read',read),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.equal((await f.engine.run('phase.enter',input)).manifest.repairScope.changeRequestId,entry.manifest.repairScope.changeRequestId);
});
