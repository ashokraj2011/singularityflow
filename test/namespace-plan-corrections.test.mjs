import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {namespaceSourceClauseFixture} from './helpers/namespace-source-clause-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePlanDecisionOwners} from '../src/engine-storage/namespace-plan-decisions-reader.mjs';
import {PlanRowCorrectionSchema} from '../src/plan-row-corrections.mjs';
import {namespaceDecisionValue} from '../src/engine-storage/namespace-decision-contract.mjs';
const reason='Correct the independently approved converter plan to the actual approved implementation path.',
  request={ownerPhase:'design',operations:['REQ-001','AC-001'].map(id=>({op:'replace-location',clauseId:'STORY-1:'+id,from:'src/old.js',to:'src/converter.js'})),reason};
function asReviewer(f){const prior={principalId:f.control.principalId,agentId:f.control.agentId,creator:f.control.creator};
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  return ()=>Object.assign(f.control,prior);}
for(const backend of ['filesystem','sqlite','application'])test(backend+': an exact human correction keeps approved plans immutable and completes actual Code delivery',{timeout:180000},async t=>{
  let recorded,input,context;
  const f=await namespaceTestWitnessFixture(t,{backend,plan:planText.replaceAll('`src/converter.js`','`src/old.js`'),
    afterPrepare:async(f,engine)=>{
      f.control.permissions.push('plan.correction.context','plan.correction.record','phase.enter','phase.context.read');const restore=asReviewer(f);
      try{
        const before=await f.capture();context=await engine.run('plan.correction.context',request);
        assert.equal(context.manifest.preview.before['STORY-1:REQ-001'].expectedPaths[0],'src/old.js');
        assert.equal(context.manifest.preview.after['STORY-1:REQ-001'].expectedPaths[0],'src/converter.js');
        assert.deepEqual(await f.capture(),before);input={...request,operationId:'human-exact-row-correction',expectedPreview:'sha256:'+context.manifest.preview.previewSha256};
        const actorKind=f.control.actorKind;f.control.actorKind='service';try{
          await assert.rejects(engine.run('plan.correction.record',{...input,operationId:'agent-cannot-sign'}),{code:'ENGINE_HUMAN_AUTHORITY_REQUIRED'});
        }finally{f.control.actorKind=actorKind;}
        await assert.rejects(engine.run('plan.correction.record',{...input,operationId:'wrong-preview',expectedPreview:'sha256:'+'a'.repeat(64)}),{code:'PLAN_CORRECTION_REVIEW_CHANGED'});
        assert.deepEqual(await f.capture(),before);
        recorded=await engine.run('plan.correction.record',input);assert.equal(recorded.record.id,'PRC-001');
        assert.equal(recorded.record.format,'sflow-namespace-plan-row-correction/v1');assert.equal(recorded.record.reviewContext,input.expectedPreview);
        assert.equal(Object.hasOwn(recorded.record,'reviewAssurance'),false);assert.equal(PlanRowCorrectionSchema.safeParse(recorded.record).success,false);
        const after=await f.capture();assert.equal(after.workflow.currentPhase,'build');assert.equal(after.workflow.phases.design.status,'approved');
        assert.deepEqual(after.workflow.phases.design.claimMaps,before.workflow.phases.design.claimMaps);
        assert.deepEqual(after.workflow.phases.design.approvals,before.workflow.phases.design.approvals);
      }finally{restore();}
      const {manifest}=await engine.run('phase.draft.read',{phaseId:'build'});
      await engine.run('phase.draft.rebase',{operationId:'continue-exact-corrected-plan',workId:f.inputs.workId,phaseId:'build',expectedRevision:manifest.draft.revision,
        confirm:manifest.draft.bodySha256,reason:'Continue the same Code generation after its human-approved row correction.'});
      const ref=(await f.capture()).workflow.namespaceDecisionReceipts.find(row=>row.operationId===input.operationId).record,
        entry=await engine.run('phase.enter',{phaseId:'build',compose:true}),resource=entry.manifest.resources.find(row=>row.reference.sha256===ref.sha256);
      assert.ok(resource,'the author receives the actual correction alongside the original plan');
      const body=await engine.run('phase.context.read',{workId:f.inputs.workId,phaseId:'build',contextSha256:entry.manifest.context.sha256,resourceId:resource.id});
      assert.equal(JSON.parse(body.content.text).outcome.record.id,'PRC-001');
    }});
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const before=await f.capture(),publication=await f.json(before.workflow.phases.build.publicationBindings[0].record),
    binding=publication.policyEvidence.find(row=>row.kind.startsWith('code-delivery/')),report=await f.json((await f.json(binding.record)).report);
  assert.ok(report.preflight.plan.amendments.some(row=>row.operation==='plan.correction.record'));
  const lateRestore=asReviewer(f);try{
    const late={ownerPhase:'design',operations:[{op:'replace-location',clauseId:'STORY-1:REQ-001',from:'src/converter.js',to:'src/next.js'}],reason},
      lateContext=await f.engine.run('plan.correction.context',late);
    assert.equal(lateContext.manifest.recording.status,'owner-required');assert.deepEqual(lateContext.manifest.recording.affectedPhases,['build']);
    const state=await f.capture();await assert.rejects(f.engine.run('plan.correction.record',{...late,operationId:'cannot-reinterpret-published-code',
      expectedPreview:'sha256:'+lateContext.manifest.preview.previewSha256}),error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required.includes('namespace-plan-revalidation'));
    assert.deepEqual(await f.capture(),state,'a later correction must not reinterpret an accepted Code proof');
  }finally{lateRestore();}
  assert.equal((await f.approve('build')).approval.selfApproval,false);
  const restore=asReviewer(f);try{
    const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('An accepted correction cannot allocate another timestamp.');}}}),snapshot=await f.capture();
    assert.deepEqual(await replay.run('plan.correction.record',input),recorded);assert.deepEqual(await f.capture(),snapshot);
    await assert.rejects(replay.run('plan.correction.record',{...input,reason:reason+' A changed request.'}),{code:'ENGINE_OPERATION_ID_REUSED'});
    const owned=createNamespacePlanDecisionOwners({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId}),rows=await owned.projection(snapshot);
    assert.equal(rows.rows.length,1);assert.equal(rows.record,null,'row corrections are replacements, never additional source obligations');
    const reference=snapshot.workflow.namespaceDecisionReceipts.find(row=>row.operationId===input.operationId).record,
      denied=Object.freeze(Object.assign(Error('Actual human correction receipt is unavailable.'),{code:'EACCES',path:'retained-human-record'})),
      unavailable=createNamespaceEngine({...f.common,content:{...f.content,read(scope,selected,options){if(selected.sha256===reference.sha256)throw denied;return f.content.read(scope,selected,options);}}});
    await assert.rejects(unavailable.run('plan.correction.record',input),error=>error===denied);
    const future=await f.json(reference);future.outcome.record.schemaVersion=2;future.outcome.record.format='sflow-namespace-plan-row-correction/v2';
    assert.throws(()=>namespaceDecisionValue(future,{projectId:f.scope.projectId,workId:f.inputs.workId}),error=>error.code==='ENGINE_STORAGE_UNSUPPORTED'&&error.cause.code==='SCHEMA_VERSION_FUTURE');
  }finally{restore();}
});
test('an interrupted correction resumes its exact candidate and refuses unimplemented presence claims',async t=>{
  const f=await namespaceSourceClauseFixture(t);f.control.permissions.push('plan.correction.context','plan.correction.record');const restore=asReviewer(f);
  try{
    const query={ownerPhase:'design',operations:[{op:'replace-location',clauseId:'STORY-1:REQ-001',from:'src/converter.js',to:'src/replacement.js'}],reason},
      context=await f.engine.run('plan.correction.context',query),input={...query,operationId:'recover-exact-correction',expectedPreview:'sha256:'+context.manifest.preview.previewSha256},
      lost=Object.freeze(Object.assign(Error('Actual correction preparation response lost.'),{code:'ETIMEDOUT',details:{deadlineMs:7319}}));let interrupted=false;
    const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
      if(!interrupted&&args[1].changes.some(row=>row.namespace==='runtime'&&row.value?.operation==='plan.correction.record')){interrupted=true;throw lost;}return result;}};
    await assert.rejects(f.make({records}).run('plan.correction.record',input),error=>error===lost);assert.equal(interrupted,true);
    const resumed=await f.make({clock:{now(){throw Error('Resume the original correction timestamp.');}}}).run('plan.correction.record',input);
    assert.equal(resumed.record.id,'PRC-001');assert.equal((await f.capture()).workflow.planAmendments.length,1);
    const owned=createNamespacePlanDecisionOwners({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId});
    assert.throws(()=>owned.correctionOwner.plan({status:'in_progress',workItem:{id:f.inputs.workId},resolution:{presence:{status:'required'}}},{},{},{}),
      error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required.includes('person-presence'));
  }finally{restore();}
});
