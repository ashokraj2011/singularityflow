/** A document amendment returns its actual Code reader, with fresh execution and original approvals retained. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './helpers/namespace-release-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
const reason='The amended assessment needs its original Code reader revalidated against the approved replacement.';
for(const backend of ['filesystem','sqlite','application'])test(backend+' historical review document carries actual intent proof through a Code return and final Release',{timeout:120000},async t=>{
  const f=await namespaceReleaseFixture(t,{backend,configure(source){
    source.definition.inputsMode='enforce';source.definition.phases.assessment={label:'Assessment',artifact:{path:'artifacts/assessment/result.md',kind:'phase-document'},
      defaultTemplate:'intake.md',writeScope:'artifact-only',inputs:[{phase:'design'}],specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
      authoring:{allowedProducers:['human','governed-agent']},approval:{authorities:['reviewers'],minimum:1,rejectTo:['assessment'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.splice(2,0,'assessment');source.definition.phases.build.inputs.push({phase:'assessment'});
    source.agents[0].phases.push('assessment');source.agents[0].defaultFor.push('assessment');
  },beforeCode:async(f)=>{await f.approve('design');await f.author('assessment','# Assessment\n\nThe reviewed public converter contract uses the original plan and its exact approved input boundaries.\n');await f.approve('assessment');}});
  const before=await f.capture(),original=before.workflow.phases.build.publicationBindings[0],base=await f.json(original.record),
    assessment=before.workflow.phases.assessment.publicationBindings[0],assessed=await f.json(assessment.record);
  assert.equal(assessed.policyEvidence[0].kind,'document-review/v1');
  const contextManifest=await f.json(assessed.policyEvidence[0].record),context=await f.json(contextManifest.report);
  assert.deepEqual(context.definitionsAndPlans.map(row=>row.phase),['intake','design']);
  f.control.permissions.push('forward-amendment.propose','forward-amendment.decide','forward-amendment.revalidate');
  const content=await f.upload('# Assessment\n\nThe converter must retain its public boundary behavior when this explanatory assessment is corrected.\n'),
    proposed=await f.engine.run('forward-amendment.propose',{operationId:'amend-code-input',workId:f.inputs.workId,phaseId:'assessment',content,reason}),
    author={principalId:f.control.principalId,creator:structuredClone(f.control.creator),agentId:'analyst'};
  assert.equal(proposed.records[0].id,'FAM-001');Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  await assert.rejects(f.engine.run('forward-amendment.propose',{operationId:'cannot-amend-owned-plan',workId:f.inputs.workId,phaseId:'design',content,reason}),{code:'FORWARD_AMENDMENT_UNSUPPORTED'});
  const amended=await f.engine.run('forward-amendment.decide',{operationId:'approve-code-input',workId:f.inputs.workId,amendmentId:'FAM-001',decision:'approve',confirmation:'FAM-001',reason});
  assert.deepEqual(amended.revalidate,['build']);
  await f.engine.run('forward-amendment.revalidate',{operationId:'return-code-reader',workId:f.inputs.workId,phaseId:'build',amendmentId:'FAM-001',outcome:'return',reason});
  Object.assign(f.control,author);await f.write('build','# Revalidated implementation\n\n## Agent brief\n\nKeep the approved converter behavior and run its exact regression after the independently approved assessment correction.\n');
  await f.engine.run('phase.source.retain',{operationId:'retain-amended-code-reader',workId:f.inputs.workId,phaseId:'build'});
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',...releasePublish}),{code:'ENGINE_CHECK_EVIDENCE_REQUIRED'});
  await f.engine.run('phase.checks.run',{operationId:'check-amended-code-reader',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});const evidence=await f.published('build');
  assert.equal(evidence.report.preflight.history.profile,'sflow-namespace-code-history/v11');assert.ok(evidence.report.preflight.history.return.amendment);
  assert.equal(evidence.policy.kind,'code-delivery/v28');assert.equal(f.starts(),2);assert.deepEqual(await f.json(original.record),base);
  await f.approve('build');f.control.agentId='release-reviewer';await f.write('release',releaseReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');
  const historical=createNamespaceEngine({...f.common,clock:{now(){throw Error('Historical amendments must retain their actual clock.');}}});
  assert.equal((await historical.run('phase.publish',{phaseId:'build',...releasePublish})).status,'retained');
});
test('first Code opens from the actual reapproved reader after an amendment return',{timeout:120000},async t=>{
  const configure=source=>{
    source.definition.inputsMode='enforce';source.definition.phases.assessment={label:'Assessment',artifact:{path:'artifacts/assessment/result.md',kind:'phase-document'},
      defaultTemplate:'intake.md',writeScope:'artifact-only',inputs:[{phase:'intake'}],specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
      authoring:{allowedProducers:['human','governed-agent']},approval:{authorities:['reviewers'],minimum:1,rejectTo:['assessment'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.splice(1,0,'assessment');source.definition.phases.design.inputs.push({phase:'assessment'});
    source.agents[0].phases.push('assessment');source.agents[0].defaultFor.push('assessment');
  };
  const f=await namespaceReleaseFixture(t,{backend:'sqlite',configure,approveScope:async f=>{
    await f.approve('intake');await f.author('assessment','# Assessment\n\nReview the original approved integer conversion boundaries before planning this implementation.\n');await f.approve('assessment');
  },beforeCode:async(f,plan)=>{
    await f.approve('design');f.control.permissions.push('forward-amendment.propose','forward-amendment.decide','forward-amendment.revalidate');
    const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent}}),
      content=await f.upload('# Assessment\n\nClarify the explanatory assessment while retaining the exact approved integer conversion boundaries.\n');
    await engine.run('forward-amendment.propose',{operationId:'initial-code-input-amendment',workId:f.inputs.workId,phaseId:'assessment',content,reason});
    const original={principalId:f.control.principalId,creator:structuredClone(f.control.creator),agentId:f.control.agentId};
    Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
    await engine.run('forward-amendment.decide',{operationId:'initial-code-amendment-approval',workId:f.inputs.workId,amendmentId:'FAM-001',decision:'approve',confirmation:'FAM-001',reason});
    await engine.run('forward-amendment.revalidate',{operationId:'initial-code-reader-return',workId:f.inputs.workId,phaseId:'design',amendmentId:'FAM-001',outcome:'return',reason});
    Object.assign(f.control,original);
    try{await engine.run('phase.prepare',{phaseId:'design'});}catch(cause){if(cause.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw cause;
      await engine.run('phase.draft.rebase',{operationId:'rebind-original-reader',workId:f.inputs.workId,phaseId:'design',expectedRevision:cause.details.revision,
        confirm:cause.details.confirm,reason:'Retain and revalidate the original approved plan against the exact reader return.'});}
    await f.author('design',plan+'\n## Reader revalidation\n\nThe exact original source and test allocation still satisfies the amended assessment.\n');await f.approve('design');
  }});
  const evidence=await f.published('build');assert.equal(evidence.report.preflight.history.profile,'sflow-namespace-code-history/v12');
  assert.equal(evidence.policy.kind,'code-delivery/v28');assert.equal(evidence.snapshot.workflow.phases.design.generation,2);assert.equal(f.starts(),1);
  await f.write('release',releaseReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');
});
