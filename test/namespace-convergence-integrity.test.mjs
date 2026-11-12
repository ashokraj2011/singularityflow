import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceConvergenceFixture} from './helpers/namespace-convergence-fixture.mjs';
import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
test('intent findings name their actual specification owner and keep human review distinct from author correction',{timeout:120000},async t=>{
  const f=await namespaceConvergenceFixture(t),original=(await f.engine.run('convergence.context',{phaseId:'release'})).manifest,
    item=original.projection.projection.settledByPlan[0],request={operationId:'review-intent-owner',phaseId:'release',itemId:item.id,
      disposition:'update-intent',clauseIds:['STORY-1:REQ-001'],reason:'The exact approved converter intent needs a separate decision by its original specification owner.',expectedContext:original.contextBinding};
  await f.reviewer.run('convergence.adjudicate',request);const head=await f.head(),context=(await f.engine.run('convergence.context',{phaseId:'release'})).manifest;
  assert.ok(context.actions.some(row=>row.operation==='upstream.raise'&&row.inputs.phaseId==='intake'));
  await f.engine.run('phase.prepare',{phaseId:'release'});const inspection=await f.engine.run('phase.prepublish',{phaseId:'release'});
  assert.equal(inspection.status,'correction-required');assert.equal(inspection.manifest.correction.class,'human-convergence-review');assert.equal(inspection.manifest.correction.sameTurn,false);
  await assert.rejects(f.reviewer.run('convergence.adjudicate',{...request,operationId:'stale-intent-context'}),{code:'ENGINE_CONVERGENCE_CONFIRMATION_STALE'});
  await assert.rejects(f.reviewer.run('convergence.adjudicate',{...request,operationId:'unbound-fetch',fetch:true}),{code:'ENGINE_INPUT_UNBOUND'});
  const nonhuman={current:async()=>({...await f.reviewerAccess.current(),actorKind:'service'})},agent=createNamespaceEngine({...f.options,access:nonhuman});
  await assert.rejects(agent.run('convergence.adjudicate',{...request,operationId:'no-model-decision',expectedContext:context.contextBinding}),{code:'ENGINE_HUMAN_AUTHORITY_REQUIRED'});
  assert.deepEqual(await f.head(),head);
});
test('a changed checkout invalidates the preview and a lost submission acknowledgement is recovered once',{timeout:120000},async t=>{
  const f=await namespaceConvergenceFixture(t,{supporting:false});await f.engine.run('phase.prepare',{phaseId:'release'});await f.engine.run('phase.publish',{phaseId:'release'});
  const preview=await f.engine.run('convergence.advance',{}),head=await f.head(),request={confirmation:preview.confirmationDigest};
  await writeFile(path.join(f.root,'src/converter.js'),converterSource+'// Source changed after the explicit preview.\n');
  await assert.rejects(f.engine.run('convergence.advance',request),{code:'PRIOR_CODE_TEST_EVIDENCE_REQUIRED'});assert.deepEqual(await f.head(),head);
  await writeFile(path.join(f.root,'src/converter.js'),converterSource);
  const lost=Object.freeze(Object.assign(Error('The original convergence submission acknowledgement timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:300000}}));let interrupted=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!interrupted&&args[1].events.some(row=>row.payload?.operation==='phase.submit')){interrupted=true;throw lost;}return result;}};
  await assert.rejects(createNamespaceEngine({...f.options,checks:f.checks,records}).run('convergence.advance',request),actual=>actual===lost);
  assert.equal(interrupted,true);const acceptedHead=await f.head(),recovered=await f.engine.run('convergence.advance',request);
  assert.equal(recovered.status,'retained');assert.equal(recovered.effects.committed,false);assert.deepEqual(await f.head(),acceptedHead);
  assert.equal((await f.capture()).workflow.lineage.submissions.filter(row=>row.phase==='release').length,1);
  await f.approve('release');assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),1);
});
test('original content permissions and deadlines survive convergence replay without a fallback write',{timeout:120000},async t=>{
  const f=await namespaceConvergenceFixture(t),initial=(await f.engine.run('convergence.context',{phaseId:'release'})).manifest,item=initial.projection.projection.settledByPlan[0];
  await f.reviewer.run('convergence.adjudicate',{operationId:'retained-real-convergence',phaseId:'release',itemId:item.id,disposition:'dismissed',
    expectedContext:initial.contextBinding,reason:'The independent reviewer accepts this exact supporting documentation.'});
  const snapshot=await f.capture(),wire=await f.json(snapshot.workflow.namespaceConvergenceDecisionReceipts[0].record),head=await f.head();
  for(const failure of [Object.freeze(Object.assign(Error('The original reviewed projection cannot be read.'),{code:'EACCES',details:{namespace:'evidence'}})),
    Object.freeze(Object.assign(Error('The original reviewed projection exceeded its deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:300000}}))]){
    const content={...f.content,read(scope,reference,options){if(reference.sha256===wire.source.projection.sha256)throw failure;return f.content.read(scope,reference,options);}},
      engine=createNamespaceEngine({...f.options,content});await assert.rejects(engine.run('convergence.context',{phaseId:'release'}),actual=>actual===failure);
    assert.deepEqual(await f.head(),head);
  }
});
