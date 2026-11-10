import assert from 'node:assert/strict';import {readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture} from './namespace-test-witness-fixture.mjs';
import {releaseReport,releasePublish} from './namespace-release-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {WITNESS_CHECKLIST} from '../../src/kernel/human-witnesses.mjs';
export async function namespaceOutputGenerationCase(t,backend){
  let human,file;const f=await namespaceTestWitnessFixture(t,{backend,configure(source){source.definition.phases.release={label:'Release conformance',
    artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',writeScope:'artifact-only',
    inputs:[{phase:'build'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
    approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('release');source.definition.workTypes.simple.decisions=[{id:'fresh-output-quality',label:'Review the actual delivery',kind:'loop',after:'release',
      inputs:[{name:'verdict',values:['Pass','Repair']}],goal:{verdict:'Pass'},back:'build',maxRounds:1}];
    source.agents.push({...source.agents[0],id:'release-author',label:'Release author',phases:['release'],defaultFor:['release']});},
    async afterPrepare(f,engine){file='singularity/work-items/'+f.inputs.workId+'/evidence/actual-output.png';
      const content=(await f.content.put(f.scope,'evidence',Buffer.from([137,80,78,71,13,10,26,10]))).reference;
      human=createNamespaceEngine({...f.common,access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
        identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['plan.correction.context','plan.correction.record','witness.context','decision.witness','phase.approve']})}});
      const request={ownerPhase:'design',reason:'Classify this exact visual deliverable without changing its required tests or the separate human inspection.',
        operations:[{op:'reclassify-evidence',clauseId:'STORY-1:AC-001',path:file,method:'visual',content}]},view=await human.run('plan.correction.context',request);
      await human.run('plan.correction.record',{...request,operationId:'fresh-output-classification',expectedPreview:'sha256:'+view.manifest.preview.previewSha256});
      const draft=await engine.run('phase.draft.read',{phaseId:'build'});await engine.run('phase.draft.rebase',{operationId:'fresh-output-plan-rebase',workId:f.inputs.workId,
        phaseId:'build',expectedRevision:draft.manifest.draft.revision,confirm:draft.manifest.draft.bodySha256,reason:'Continue the same generation under the retained human classification.'});
    }});
  f.control.permissions.push('phase.output.retain');let edits=0;
  async function approve(phaseId,decisionValues){
    const submitted=await f.engine.run('phase.submit',{phaseId,...(decisionValues?{decisionValues}:{})}),view=await human.run('phase.review',{phaseId}),binding=view.manifest.reviewBinding;
    assert.ok(binding,JSON.stringify({submitted,review:view.manifest}));
    return human.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  }
  const retain=async generation=>{const content=(await f.localContent.put(f.scope,'local',Buffer.from([137,80,78,71,13,10,26,10,generation]))).reference,
    input={operationId:'fresh-visual-output-'+generation,workId:f.inputs.workId,phaseId:'build',path:file,content},head=await f.head(),result=await f.engine.run('phase.output.retain',input);
    assert.deepEqual(await f.head(),head,'retaining output after checks must not invalidate them');return {input,result};};
  const witness=async(generation,expected)=>{const query={clauseId:'STORY-1:AC-001',slotName:'retained-evidence',file},view=await human.run('witness.context',query);
    assert.deepEqual(view.manifest.file.content,expected);assert.equal(view.manifest.result.status,'missing');
    await human.run('decision.witness',{...query,operationId:'fresh-output-human-'+generation,expectedContext:view.manifest.contextBinding,
      expectedFile:'sha256:'+expected.sha256,answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),reason:'The independent fixture reviewer inspected this generation and its exact retained output.'});};
  async function write(phaseId,text){try{await f.engine.run('phase.prepare',{phaseId});}catch(error){if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
      await f.engine.run('phase.draft.rebase',{operationId:'fresh-output-successor-'+(++edits),workId:f.inputs.workId,phaseId,expectedRevision:error.details.revision,
        confirm:error.details.confirm,reason:'Continue the preserved authoring draft under the actual successor authority.'});}
    const draft=await f.engine.run('phase.draft.read',{phaseId});await f.engine.run('phase.draft.write',{operationId:'fresh-output-author-'+(++edits),workId:f.inputs.workId,phaseId,
      expectedRevision:draft.manifest.draft.revision,content:await f.upload(text),reason:'Complete this exact generation from the approved contract and its real evidence.'});}
  const first=await retain(1);assert.equal(f.starts(),1);await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});
  let snapshot=await f.capture(),firstBinding=snapshot.workflow.phases.build.publicationBindings[0],publication=await f.json(firstBinding.record),
    policy=publication.policyEvidence.find(row=>row.kind==='code-delivery/v13'),report=await f.json((await f.json(policy.record)).report);
  assert.equal(report.preflight.outputs.files[0].content.sha256,first.result.content.sha256);assert.equal(f.starts(),1);
  assert.ok(snapshot.workflow.phases.build.artifacts.some(row=>row.path===file&&row.sha256===first.result.content.sha256));
  await assert.rejects(approve('build'),{code:'ENGINE_WITNESS_DECISION_REQUIRED'});await witness(1,first.result.content);assert.equal((await approve('build')).approval.selfApproval,false);
  f.control.agentId='release-author';await write('release',releaseReport('partial'));await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await approve('release',{verdict:'Repair'});
  f.control.agentId='analyst';await write('build','# Repaired Code\n\n## Agent brief\n\nPreserve the approved conversion and add another executed boundary case and a fresh output for this generation.\n');
  const source=path.join(f.root,'test/converter.test.js');await writeFile(source,(await readFile(source,'utf8'))+"\ntest('converts the next boundary',()=>assert.equal(convert(256),'100'));\n");
  await f.engine.run('phase.source.retain',{operationId:'fresh-output-successor-source',workId:f.inputs.workId,phaseId:'build'});
  const execution=await f.engine.run('phase.checks.run',{operationId:'fresh-output-successor-tests',workId:f.inputs.workId,phaseId:'build'});assert.equal(execution.checks[0].tests.passed,2);
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',...releasePublish}),{code:'CODE_DELIVERY_INCOMPLETE'});
  const second=await retain(2);assert.notEqual(second.result.content.sha256,first.result.content.sha256);await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});
  snapshot=await f.capture();publication=await f.json(snapshot.workflow.phases.build.publicationBindings[1].record);policy=publication.policyEvidence.find(row=>row.kind==='code-delivery/v13');
  report=await f.json((await f.json(policy.record)).report);assert.equal(report.preflight.outputs.files[0].content.sha256,second.result.content.sha256);
  await assert.rejects(approve('build'),{code:'ENGINE_WITNESS_DECISION_REQUIRED'});await witness(2,second.result.content);await approve('build');
  f.control.agentId='release-author';await write('release',releaseReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await approve('release',{verdict:'Pass'});
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),2,'output capture and Release never invent or repeat test execution');
  for(const root of f.roots)await rm(root,{recursive:true,force:true});const shared=createNamespaceEngine({...f.common,clock:{now(){throw Error('Takeover must preserve original evidence times.');}}});
  assert.equal((await shared.run('phase.publish',{phaseId:'build',...releasePublish})).status,'retained');assert.equal((await shared.run('phase.publish',{phaseId:'release',...releasePublish})).status,'retained');
  const original=await shared.run('phase.output.retain',first.input);assert.equal(original.replayed,true);assert.deepEqual(original.record,first.result.record);
}
