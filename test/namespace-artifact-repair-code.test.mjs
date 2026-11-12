import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture,actualWitnessTest} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {planText,specificationText} from './helpers/namespace-specification-fixture.mjs';
import {WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
for(const {targeted=false,repositories=1,mixed=false}of [{},{targeted:true},{mixed:true},{repositories:2},{repositories:2,mixed:true}])
test((targeted?'combined clause/member':'document-only')+' Code return with '+repositories+' repositories'+(mixed?' and human visual acceptance':'')+' retains exact scope and fresh execution',{timeout:240000},async t=>{
  const qualified=repositories===2?planText.replaceAll(/`(src|test)\/([^`]+)`/gu,(_match,folder,file)=>'`frontend/'+folder+'/'+file+'`')
    +'| STORY-1:REQ-002 | `backend/src/converter.js` | `backend/test/converter.test.js` |\n| STORY-1:AC-002 | `backend/src/converter.js` | `backend/test/converter.test.js` |\n'
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n':planText,
    plan=qualified+(mixed?'\n## Verification contracts\n\n| Criterion | Slot | Method | Witness | Role | Combination |\n| --- | --- | --- | --- | --- | --- |\n'
      +'| STORY-1:AC-001 | tests | test | `'+(repositories===2?'frontend/':'')+'test/converter.test.js` | primary | all |\n| STORY-1:AC-001 | converter-screen | visual | `converter` | primary | all |\n':'');
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite',run:false,repositories,plan,...(repositories===2?{
    specification:specificationText+'\n[STORY-1:REQ-002] Preserve backend integer identity.\n\n[STORY-1:AC-002] Given backend 7, return 7.\n',
    source:index=>index?'// @clause:STORY-1:REQ-002 Preserve the backend integer.\n// @clause:STORY-1:AC-002 Return the original value.\nexport const convert=value=>value;\n'
      :'// @clause:STORY-1:REQ-001 Convert the integer to hexadecimal.\n// @clause:STORY-1:AC-001 Return the approved hexadecimal value.\nexport const convert=value=>value.toString(16).toUpperCase();\n',
    testSource:index=>index?"import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';\n// @ac:STORY-1:AC-002\ntest('preserves backend 7',()=>assert.equal(convert(7),7));\n":actualWitnessTest}:{}),configure(source){
    const primary=source.definition.phases.build.artifact.path.split('/').at(-1);
    source.definition.artifactSets={codePacket:{primary,members:[{path:primary,role:'implementation-summary',required:true},{path:'review-notes.txt',role:'supporting-evidence',required:true},
      ...(mixed?[{path:'screen.png',role:'supporting-evidence',required:true}]:[])]}};
    source.definition.phases.build.artifactSet='codePacket';
  },afterPrepare:async(f,engine)=>{f.control.permissions.push('phase.artifact.attach','phase.enter','phase.context.read');
    const draft=await engine.run('phase.draft.read',{phaseId:'build'});
    await engine.run('phase.artifact.attach',{operationId:'attach-code-original-notes',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
      memberPath:'review-notes.txt',content:await f.upload('Original retained Code review notes.\n'),reason:'Keep this actual output in the original Code publication.'});
    if(mixed){const draft=await engine.run('phase.draft.read',{phaseId:'build'});
      await engine.run('phase.artifact.attach',{operationId:'attach-code-visual-fixture',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
        memberPath:'screen.png',content:await f.upload(Buffer.from([137,80,78,71,13,10,26,10])),reason:'Retain the isolated binary fixture for a separate exact-candidate human decision.'});}}});
  await f.runChecks();await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'build'});
  const access={current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.review','phase.reject','phase.approve','witness.context','decision.witness']})},reviewer=f.make({access}),
    view=await reviewer.run('phase.review',{phaseId:'build'}),request={phaseId:'build',target:'build',members:['review-notes.txt'],
      ...(targeted?{clauseIds:['STORY-1:REQ-001']}:{}),reason:'Repair this exact delivered review member under the explicitly selected application scope.',confirm:view.manifest.reviewBinding.packetSha256};
  async function witness(generation){const query={clauseId:'STORY-1:AC-001',slotName:'converter-screen',file:'singularity/work-items/'+f.inputs.workId+'/artifacts/build/screen.png'},
      context=await reviewer.run('witness.context',query);assert.equal(context.manifest.result.status,'missing');
    await reviewer.run('decision.witness',{...query,operationId:'member-repair-witness-'+generation,expectedContext:context.manifest.contextBinding,
      expectedFile:'sha256:'+context.manifest.file.content.sha256,answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),
      reason:'The independent fixture reviewer inspected the exact retained output against the approved visual criterion.'});}
  if(mixed)await witness(1);
  await reviewer.run('phase.reject',request);const entry=await f.engine.run('phase.enter',{phaseId:'build'});
  assert.equal(entry.manifest.schemaVersion,5);assert.deepEqual(entry.manifest.artifactRepairScope.members,['review-notes.txt']);
  if(targeted)assert.deepEqual(entry.manifest.repairScope.current.clauseIds,['STORY-1:REQ-001']);else assert.equal(entry.manifest.repairScope,undefined);
  await f.engine.run('phase.prepare',{phaseId:'build'});const draft=await f.engine.run('phase.draft.read',{phaseId:'build'});
  assert.equal(draft.manifest.draft.generation,2);
  if(!targeted){const authoring=await f.engine.run('phase.enter',{phaseId:'build'});assert.equal(authoring.codeAuthoringReady,false);}
  await f.engine.run('phase.artifact.attach',{operationId:'attach-code-successor-notes',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
    memberPath:'review-notes.txt',content:await f.upload('Corrected actual Code review notes.\n'),reason:'Correct the member named in the original human return.'});
  const source=path.join(f.root,'src/converter.js'),original=await readFile(source,'utf8');await writeFile(source,original+'// Additional application-source edit.\n');
  await f.engine.run('phase.source.retain',{operationId:'member-return-source-edited',workId:f.inputs.workId,phaseId:'build'});
  if(!targeted){await assert.rejects(f.engine.run('phase.checks.run',{operationId:'member-return-denied-source-tests',workId:f.inputs.workId,phaseId:'build'}),{code:'ENGINE_ARTIFACT_REPAIR_SOURCE_CHANGED'});
    assert.equal(f.starts(),repositories,'a document-only return cannot start a process against changed application code');
    await writeFile(source,original);await f.engine.run('phase.source.retain',{operationId:'member-return-source-restored',workId:f.inputs.workId,phaseId:'build'});}
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'}),{code:'ENGINE_CHECK_EVIDENCE_REQUIRED'});
  const executed=await f.engine.run('phase.checks.run',{operationId:'member-return-fresh-tests',workId:f.inputs.workId,phaseId:'build'});assert.equal(executed.checks[0].tests.passed,1);
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});const state=await f.capture(),binding=state.workflow.phases.build.publicationBindings.find(row=>row.generation===2),
    publication=await f.json(binding.record),policy=publication.policyEvidence.find(row=>row.kind.startsWith('code-delivery/')),report=await f.json((await f.json(policy.record)).report);
  assert.equal(policy.kind,'code-delivery/v'+(targeted?14:repositories===2?(mixed?23:22):(mixed?21:20)));
  assert.equal(report.preflight.history.profile,'sflow-namespace-code-history/v'+(targeted?8:9));
  if(!targeted){assert.equal(report.preflight.history.mode,'revalidated');assert.ok(report.preflight.history.repositories.every(row=>row.changes.length===0));}
  let executions=2;
  if(!targeted&&!mixed&&repositories===1){
    await f.engine.run('phase.submit',{phaseId:'build'});const next=await reviewer.run('phase.review',{phaseId:'build'});
    await reviewer.run('phase.reject',{...request,confirm:next.manifest.reviewBinding.packetSha256,
      reason:'The first member correction needs one more reviewed clarification before approval.'});
    await f.engine.run('phase.prepare',{phaseId:'build'});const third=await f.engine.run('phase.draft.read',{phaseId:'build'});assert.equal(third.manifest.draft.generation,3);
    await f.engine.run('phase.artifact.attach',{operationId:'attach-code-final-notes',workId:f.inputs.workId,phaseId:'build',expectedRevision:third.manifest.draft.revision,
      memberPath:'review-notes.txt',content:await f.upload('Final corrected actual Code review notes.\n'),reason:'Complete the second authentic reviewer return without replacing its original evidence.'});
    await f.engine.run('phase.source.retain',{operationId:'member-return-third-source',workId:f.inputs.workId,phaseId:'build'});
    await f.engine.run('phase.checks.run',{operationId:'member-return-third-tests',workId:f.inputs.workId,phaseId:'build'});
    await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});executions=3;
  }
  if(mixed){await assert.rejects(f.approve('build'),{code:'ENGINE_WITNESS_DECISION_REQUIRED'});await witness(2);}
  await f.approve('build');assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),executions*repositories);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('A shared Code receipt cannot be restamped.');}}});
  assert.equal((await replay.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'})).status,'retained');
});
