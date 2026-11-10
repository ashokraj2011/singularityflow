import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {namespaceSourceClauseFixture} from './helpers/namespace-source-clause-fixture.mjs';
import {createEngine} from '../src/engine-sdk/index.mjs';
test('late evidence classification leads to a real issue owned by the approved planner without rewriting Code publication',async t=>{
  const f=await namespaceTestWitnessFixture(t);f.control.permissions.push('plan.correction.context','upstream.raise');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const before=await f.capture(),content=(await f.content.put(f.scope,'evidence',Buffer.from('Isolated output fixture.'))).reference;let action;
  await assert.rejects(f.engine.run('plan.correction.context',{ownerPhase:'design',reason:'The exact retained output needs its original planner to review its delivery classification.',
    operations:[{op:'reclassify-evidence',clauseId:'STORY-1:AC-001',path:'singularity/work-items/'+f.inputs.workId+'/evidence/output.png',method:'inspection',content}]}),error=>{
      action=error.details?.actions?.find(row=>row.operation==='upstream.raise');return error.code==='PLAN_EVIDENCE_CORRECTION_LIFECYCLE'&&action?.inputs.phaseId==='design';});
  assert.deepEqual(await f.capture(),before);
  const result=await f.engine.run(action.operation,{...action.inputs,operationId:'late-evidence-classification-owner',
    problem:'The approved plan treats this retained output as product source.',assumption:'The exact output should have its own human inspection contract.',
    impact:'Publication must remain immutable until the original planner and authorized human decide the return.'});
  assert.equal(result.records[0].phase,'design');const after=await f.capture();assert.equal(after.workflow.currentPhase,'build');
  assert.deepEqual(after.workflow.phases.build.publicationBindings,before.workflow.phases.build.publicationBindings);
  assert.deepEqual(after.workflow.phases.design,before.workflow.phases.design);assert.equal(after.workflow.upstreamIssues.length,1);
});
test('malformed correction contexts cannot crash inside a host or supply identity/approval overrides',async()=>{
  const forbidden=()=>{throw Error('Invalid context inputs must fail before host access.');},
    engine=createEngine({ports:{planCorrectionContext:{load:forbidden,read:forbidden}}}),
    valid={operations:[{op:'replace-location',clauseId:'STORY:AC-001',from:'src/old.js',to:'src/new.js'}],reason:'Review this exact approved plan correction.'};
  for(const input of [null,[],{...valid,operations:[null]},{...valid,operations:[[]]},{...valid,workId:42},{...valid,ownerPhase:{}},
    {...valid,reason:true},{...valid,actor:'counterfeit-human'},{...valid,approved:true}])await assert.rejects(engine.run('plan.correction.context',input),{code:'ENGINE_INPUT_INVALID'});
});
test('evidence classification cannot hide row/test changes or duplicate a criterion inside the reviewed packet',async t=>{
  const f=await namespaceSourceClauseFixture(t);f.control.permissions.push('plan.correction.context');const before=await f.capture(),
    content=(await f.content.put(f.scope,'evidence',Buffer.from('Isolated reviewed output.'))).reference,
    operation={op:'reclassify-evidence',clauseId:'STORY-1:AC-001',path:'singularity/work-items/'+f.inputs.workId+'/evidence/output.png',method:'inspection',content};
  for(const operations of [[operation,{op:'add-test',clauseId:operation.clauseId,test:'test/additional.test.js'}],[operation,{...operation,method:'visual'}]]){
    await assert.rejects(f.engine.run('plan.correction.context',{ownerPhase:'design',operations,reason:'Review only the exact output classification while preserving approved test intent.'}),{code:'PLAN_ROW_CORRECTION_INVALID'});
    assert.deepEqual(await f.capture(),before);
  }
});
