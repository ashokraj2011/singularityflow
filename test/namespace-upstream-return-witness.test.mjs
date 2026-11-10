/** A human decision belongs to one candidate; an upstream return cannot copy its visual sign-off. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {releaseReport,releasePublish} from './helpers/namespace-release-fixture.mjs';
import {WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
const image=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]); // Isolated binary fixture; never product evidence.
test('an upstream Code return requires a new exact visual decision while preserving the original witness',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{plan:planText+'\n## Verification contracts\n\n| Criterion | Slot | Method | Witness | Role | Combination |\n| --- | --- | --- | --- | --- | --- |\n'
    +'| STORY-1:AC-001 | tests | test | `test/converter.test.js` | primary | all |\n'
    +'| STORY-1:AC-001 | converter-screen | visual | `converter` | primary | all |\n',configure(source){
      source.definition.artifactSets={delivery:{primary:'summary.md',members:[{path:'summary.md',role:'implementation-summary',required:true},
        {path:'proof.png',role:'supporting-evidence',required:true}]}};source.definition.phases.build.artifactSet='delivery';
      source.definition.phases.release={label:'Release review',artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',
        writeScope:'artifact-only',inputs:[{phase:'build'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
        approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
      source.definition.workTypes.simple.phases.push('release');source.agents.push({...source.agents[0],id:'release-reviewer',label:'Release author',phases:['release'],defaultFor:['release']});
    },async afterPrepare(f,engine){f.control.permissions.push('phase.artifact.attach');const draft=await engine.run('phase.draft.read',{phaseId:'build'});
      await engine.run('phase.artifact.attach',{operationId:'first-binary-fixture',workId:f.inputs.workId,phaseId:'build',memberPath:'proof.png',
        expectedRevision:draft.manifest.draft.revision,content:await f.upload(image),reason:'Retain the isolated binary fixture for its exact human review.'});}}),
    access={current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
      identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['witness.context','decision.witness','phase.approve','upstream.decide']})},
    reviewer=f.make({checks:f.checks,access}),query={clauseId:'STORY-1:AC-001',slotName:'converter-screen',file:'singularity/work-items/'+f.inputs.workId+'/artifacts/build/proof.png'};
  async function witness(id){const context=await reviewer.run('witness.context',query);assert.equal(context.manifest.result.status,'missing');
    const input={operationId:id,workId:f.inputs.workId,...query,expectedContext:context.manifest.contextBinding,expectedFile:'sha256:'+context.manifest.file.content.sha256,
      answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),reason:'The isolated fixture reviewer inspected this exact candidate and its approved visual criterion.'};
    return {input,result:await reviewer.run('decision.witness',input)};}
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});const original=await witness('original-visual-review');await f.approve('build');
  f.control.permissions.push('upstream.raise');f.control.agentId='release-reviewer';
  await f.engine.run('upstream.raise',{operationId:'raise-visual-Code-return',phaseId:'build',about:'the reviewed output candidate',
    problem:'The independently reviewed candidate needs a new generation with separately retained execution and visual review.',authored:'human',proposed:'return'});
  await reviewer.run('upstream.decide',{operationId:'return-visual-Code',issueId:'UPI-001',outcome:'return',
    reason:'Revalidate the original behavior and review the newly retained output under this exact generation.'});f.control.agentId='analyst';
  try{await f.engine.run('phase.prepare',{phaseId:'build'});}catch(error){if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
    await f.engine.run('phase.draft.rebase',{operationId:'rebase-visual-successor',workId:f.inputs.workId,phaseId:'build',expectedRevision:error.details.revision,
      confirm:error.details.confirm,reason:'Preserve the original authored bytes under the actual returned generation.'});}
  let draft=await f.engine.run('phase.draft.read',{phaseId:'build'});
  await f.engine.run('phase.draft.write',{operationId:'visual-successor-summary',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload('# Revalidated implementation\n\n## Agent brief\n\nRun the same boundary regression again and obtain a new human decision for the exact retained output.\n'),
    reason:'Complete the actual returned candidate without copying its earlier visual approval.'});
  draft=await f.engine.run('phase.draft.read',{phaseId:'build'});
  await f.engine.run('phase.artifact.attach',{operationId:'successor-binary-fixture',workId:f.inputs.workId,phaseId:'build',memberPath:'proof.png',
    expectedRevision:draft.manifest.draft.revision,content:await f.upload(image),reason:'Retain this exact successor output even though its isolated binary bytes are unchanged.'});
  await f.engine.run('phase.source.retain',{operationId:'visual-successor-source',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.checks.run',{operationId:'visual-successor-tests',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});const snapshot=await f.capture(),publication=await f.json(snapshot.workflow.phases.build.publicationBindings[1].record),
    binding=publication.policyEvidence.find(row=>row.kind==='code-delivery/v9');assert.ok(binding);
  const report=await f.json((await f.json(binding.record)).report);assert.equal(report.preflight.history.mode,'revalidated');assert.equal(f.starts(),2);
  await f.engine.run('phase.submit',{phaseId:'build'});const {manifest}=await reviewer.run('phase.review.resources',{phaseId:'build'}),bound=manifest.reviewBinding,
    approval={phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:bound.generation,reviewPacketSha256:bound.packetSha256}};
  await assert.rejects(reviewer.run('phase.approve',approval),{code:'ENGINE_WITNESS_DECISION_REQUIRED'});
  const replacement=await witness('replacement-visual-review');assert.notEqual(replacement.result.record.contextBinding,original.result.record.contextBinding);
  assert.deepEqual((await reviewer.run('decision.witness',original.input)).record,original.result.record);await reviewer.run('phase.approve',approval);
  const state=await f.capture();assert.equal(state.workflow.currentPhase,'release');assert.equal(state.workflow.changeRequests[0].status,'resolved');
  assert.equal(state.workflow.namespaceDecisionReceipts.filter(row=>row.operation==='decision.witness').length,2);
  f.control.agentId='release-reviewer';await f.engine.run('phase.prepare',{phaseId:'release'});draft=await f.engine.run('phase.draft.read',{phaseId:'release'});
  await f.engine.run('phase.draft.write',{operationId:'release-reviewed-successor',workId:f.inputs.workId,phaseId:'release',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(releaseReport()),reason:'Account for the approved successor tests and separately retained visual decision.'});
  await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');assert.equal((await f.capture()).workflow.status,'closed');
});
