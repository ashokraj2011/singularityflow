import test from 'node:test';import assert from 'node:assert/strict';
import {writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {namespaceSourceClauseFixture} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePlanDecisionOwners} from '../src/engine-storage/namespace-plan-decisions-reader.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceDraftStore} from '../src/engine-storage/namespace-draft-store.mjs';
import {namespaceGenerationValue,verifyNamespaceGenerationContinuation} from '../src/engine-storage/namespace-generation-reader.mjs';
const reason='Account for the exact runtime configuration needed by the approved converter regressions.',
  request={operationId:'reviewed-plan-accounting',changes:[{kind:'add-supporting',path:'package.json',class:'build-configuration',reason}],reason};
function asReviewer(f){const previous={principalId:f.control.principalId,agentId:f.control.agentId,creator:f.control.creator};
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  return ()=>Object.assign(f.control,previous);}
for(const backend of ['filesystem','sqlite','application'])test(backend+': reviewed plan amendments retain actual source hashes through Code approval and shared-only replay',async t=>{
  let first;
  const f=await namespaceTestWitnessFixture(t,{backend,afterPrepare:async(f,engine,roots)=>{
    f.control.permissions.push('decision.plan');await writeFile(path.join(roots[0],'package.json'),'{"type":"module"}\n');
    const restore=asReviewer(f);try{first=await engine.run('decision.plan',request);}finally{restore();}
    const {manifest}=await engine.run('phase.draft.read',{phaseId:'build'});
    await engine.run('phase.draft.rebase',{operationId:'continue-after-plan-review',workId:f.inputs.workId,phaseId:'build',
      expectedRevision:manifest.draft.revision,confirm:manifest.draft.bodySha256,reason:'Retain the opened Code generation and its current edits after the human plan decision.'});
  }});
  assert.equal(first.actorId,'independent-reviewer');assert.equal(first.record.id,'PAM-001');assert.match(first.record.contentHashes['package.json'],/^[a-f0-9]{64}$/u);
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const snapshot=await f.capture(),published=await f.json(snapshot.workflow.phases.build.publicationBindings[0].record),
    policy=published.policyEvidence.find(row=>row.kind==='code-delivery/v6'),manifest=await f.json(policy.record),report=await f.json(manifest.report);
  assert.equal(report.schemaVersion,6);assert.equal(report.preflight.plan.amendments.length,1);
  assert.ok(report.preflight.repositories[0].delivery.paths.some(row=>row.path==='package.json'&&row.kind==='configuration'));
  assert.equal((await f.approve('build')).approval.selfApproval,false);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const restore=asReviewer(f);try{
    const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('Do not restamp the original amendment.');}}}),before=await f.capture();
    assert.deepEqual(await replay.run('decision.plan',request),first);assert.deepEqual(await f.capture(),before);
    await assert.rejects(replay.run('decision.plan',{...request,reason:reason+' Another request.'}),{code:'ENGINE_OPERATION_ID_REUSED'});
    const observer=createNamespaceStoryObserver(f.common),owners=createNamespacePlanDecisionOwners({observer,scope:f.scope,workId:f.inputs.workId});
    assert.equal((await owners.projection(before)).record.supportingFiles[0],'package.json');
  }finally{restore();}
});
test('an interrupted plan amendment preserves real errors and refuses changed source before human acceptance',async t=>{
  const f=await namespaceSourceClauseFixture(t);f.control.permissions.push('decision.plan');
  await writeFile(path.join(f.root,'package.json'),'{"type":"module"}\n');
  const restore=asReviewer(f),lost=Object.assign(Error('Actual plan preparation response lost.'),{code:'ETIMEDOUT',details:{deadlineMs:7777}});let interrupted=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!interrupted&&args[1].changes.some(row=>row.namespace==='runtime'&&row.value?.operation==='decision.plan')){interrupted=true;throw lost;}return result;}};
  try{
    await assert.rejects(f.make({records}).run('decision.plan',request),error=>error===lost);assert.equal(interrupted,true);
    const before=await f.capture();await writeFile(path.join(f.root,'package.json'),'{"type":"commonjs"}\n');
    await assert.rejects(f.engine.run('decision.plan',request),{code:'ENGINE_SOURCE_CHANGED'});assert.deepEqual(await f.capture(),before);
    const denied=Object.assign(Error('Actual source permission denied.'),{code:'EACCES'}),
      sources=f.sources.map(unit=>({...unit,capture(){throw denied;}}));
    await assert.rejects(f.make({sources}).run('decision.plan',{...request,operationId:'another-human-intent'}),error=>error===denied);
    assert.deepEqual(await f.capture(),before);
  }finally{restore();}
});
test('repository-qualified accounting stays in the reviewed repository and preserves separate Code test evidence',async t=>{
  const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
    .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n',
    f=await namespaceTestWitnessFixture(t,{repositories:2,plan,afterPrepare:async(f,engine,roots)=>{
      f.control.permissions.push('decision.plan');await writeFile(path.join(roots[0],'package.json'),'{"type":"module"}\n');
      const restore=asReviewer(f);try{await engine.run('decision.plan',{...request,changes:[{...request.changes[0],path:'frontend/package.json'}]});}finally{restore();}
      const {manifest}=await engine.run('phase.draft.read',{phaseId:'build'});
      await engine.run('phase.draft.rebase',{operationId:'continue-qualified-accounting',workId:f.inputs.workId,phaseId:'build',expectedRevision:manifest.draft.revision,
        confirm:manifest.draft.bodySha256,reason:'Continue the same two-repository generation after its exact plan review.'});
    }});
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const publication=await f.json((await f.capture()).workflow.phases.build.publicationBindings[0].record),
    manifest=await f.json(publication.policyEvidence.find(row=>row.kind==='code-delivery/v6').record),report=await f.json(manifest.report);
  assert.deepEqual(report.repositories.map(row=>row.id),['app','service-1']);
  assert.ok(report.preflight.repositories.find(row=>row.id==='app').delivery.paths.some(row=>row.path==='package.json'));
  assert.equal(report.preflight.repositories.find(row=>row.id==='service-1').delivery.paths.some(row=>row.path==='package.json'),false);
  assert.equal((await f.approve('build')).approval.selfApproval,false);
});
test('changed accounted bytes need a fresh human choice and Code continuation fences source races without losing edits',async t=>{
  const f=await namespaceTestWitnessFixture(t,{afterPrepare:async(f,engine,roots)=>{
    f.control.permissions.push('decision.plan');await writeFile(path.join(roots[0],'package.json'),'{"type":"module"}\n');
    const restore=asReviewer(f);try{await engine.run('decision.plan',request);}finally{restore();}
    const {manifest}=await engine.run('phase.draft.read',{phaseId:'build'});
    await engine.run('phase.draft.rebase',{operationId:'first-accounted-continuation',workId:f.inputs.workId,phaseId:'build',expectedRevision:manifest.draft.revision,
      confirm:manifest.draft.bodySha256,reason:'Continue the actual open generation after the first human plan accounting.'});
  }}),file=path.join(f.root,'package.json'),next='{ "type":"module", "private":true }\n';
  await writeFile(file,next);await f.engine.run('phase.source.retain',{operationId:'changed-accounted-source',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('current-but-unreviewed-accounting-execution');
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'}),error=>{
    assert.equal(error.code,'PLAN_AMENDMENT_CONTENT_CHANGED');assert.deepEqual(error.details.actions[0].inputs.changes,request.changes);return true;});
  const restore=asReviewer(f);try{await f.engine.run('decision.plan',{...request,operationId:'review-current-accounted-bytes'});}finally{restore();}
  const local=createNamespaceDraftStore({records:f.localRecords,content:f.localContent,scope:f.scope,workId:f.inputs.workId,phaseId:'build'}),before=await local.capture(),
    input={operationId:'second-accounted-continuation',workId:f.inputs.workId,phaseId:'build',expectedRevision:before.revision,confirm:before.body.sha256,
      reason:'Keep the same authored implementation after the exact replacement plan decision.'};let captures=0;
  const sources=f.sources.map(unit=>({...unit,async capture(options){if(++captures===2)await writeFile(file,next+'\n');return unit.capture(options);}}));
  await assert.rejects(f.make({sources,checks:f.checks}).run('phase.draft.rebase',input),{code:'ENGINE_SOURCE_CHANGED'});
  assert.deepEqual(await local.capture(),before);await writeFile(file,next);
  await f.engine.run('phase.draft.rebase',input);const continued=await local.capture(),intent=JSON.parse(Buffer.from(await local.bytes(continued.payload.generationIntent.record)));
  assert.equal(intent.schemaVersion,2);assert.equal(intent.continuation.intent.value.schemaVersion,2);
  assert.equal(namespaceGenerationValue(intent,{workId:f.inputs.workId,phaseId:'build'}),intent);
  const changed=structuredClone(intent);changed.continuation.draft.value.payload.generation++;
  assert.throws(()=>namespaceGenerationValue(changed,{workId:f.inputs.workId,phaseId:'build'}),{code:'ENGINE_STORAGE_CORRUPT'});
  const falseBasis=structuredClone(intent);falseBasis.continuation.basis.revision='another-revision';
  await assert.rejects(verifyNamespaceGenerationContinuation(falseBasis,{observer:createNamespaceStoryObserver(f.common),workId:f.inputs.workId,phaseId:'build'}),{code:'ENGINE_STORAGE_CORRUPT'});
  await f.engine.run('phase.source.retain',{operationId:'accepted-replacement-source',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('replacement-plan-execution');await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  assert.equal((await f.approve('build')).approval.selfApproval,false);
});
test('amending an approved plan does not read a future unapproved planning owner',async t=>{
  let amendment;
  const f=await namespaceTestWitnessFixture(t,{run:false,configure:source=>{
    const definition=source.definition;
    definition.phases['later-plan']=structuredClone(definition.phases.design);
    definition.phases['later-plan'].inputs=[{phase:'build'}];definition.phases['later-plan'].approval.rejectTo=['later-plan'];
    definition.phases['later-build']=structuredClone(definition.phases.build);definition.phases['later-build'].inputs=[{phase:'later-plan'}];
    definition.phases['later-build'].approval.rejectTo=['later-plan'];
    definition.workTypes.simple.phases.push('later-plan','later-build');definition.workTypes.simple.plannedClaims.owners['later-build']='later-plan';
    source.agents[0].phases.push('later-plan','later-build');source.agents[0].defaultFor.push('later-plan','later-build');
  },afterPrepare:async(f,engine)=>{
    f.control.permissions.push('decision.plan');const restore=asReviewer(f);try{
      amendment=await engine.run('decision.plan',{...request,changes:[{kind:'add-location',clauseId:'STORY-1:REQ-001',path:'src/test/setup.js'}]});
    }finally{restore();}
    const {manifest}=await engine.run('phase.draft.read',{phaseId:'build'});
    await engine.run('phase.draft.rebase',{operationId:'continue-before-later-plan',workId:f.inputs.workId,phaseId:'build',expectedRevision:manifest.draft.revision,
      confirm:manifest.draft.bodySha256,reason:'Continue the current reviewed plan while a later owner has not started yet.'});
  }});
  assert.equal(amendment.record.id,'PAM-001');assert.equal((await f.capture()).workflow.phases['later-plan'].generation,0);
});
