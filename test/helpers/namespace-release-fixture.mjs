/** Real source-backed Code delivery followed by a separately authored conformance phase. */
import {namespaceTestWitnessFixture} from './namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
export const releasePublish={authored:'governed-agent',channel:'copilot-host'};
export const releaseReport=(verdict='matched')=>'# Release conformance\n\n## Agent brief\n\nAccount for the approved clauses using the original Code execution; this phase did not run another test.\n\n'
  +'| Clause ID | Verdict |\n| --- | --- |\n| STORY-1:REQ-001 | '+verdict+' |\n| STORY-1:AC-001 | '+verdict+' |\n';
export async function namespaceReleaseFixture(t,{backend='filesystem',loop=false}={}){
  const f=await namespaceTestWitnessFixture(t,{backend,configure:source=>{
    source.definition.phases.release={label:'Release review',artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',
      writeScope:'artifact-only',inputs:[{phase:'build'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
      approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('release');
    source.agents.push({...source.agents[0],id:'release-reviewer',label:'Release author',phases:['release'],defaultFor:['release']});
    if(loop)source.definition.workTypes.simple.decisions=[{id:'release-quality',label:'Release review',kind:'loop',after:'release',
      inputs:[{name:'verdict',values:['Pass','Repair']}],goal:{verdict:'Pass'},back:'build',maxRounds:1}];
  }});
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.approve('build');f.control.agentId='release-reviewer';
  f.control.permissions.push('phase.enter','phase.context.read');const engine=createNamespaceEngine({...f.options,checks:f.checks});let edits=0;
  async function write(phaseId,text){
    try{await engine.run('phase.prepare',{phaseId});}catch(error){if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
      await engine.run('phase.draft.rebase',{operationId:'review-successor-'+phaseId+'-'+(++edits),workId:f.inputs.workId,phaseId,
        expectedRevision:error.details.revision,confirm:error.details.confirm,reason:'Review the preserved draft under the actual human-authorized successor basis.'});}
    const draft=await engine.run('phase.draft.read',{phaseId});
    await engine.run('phase.draft.write',{operationId:'write-release-journey-'+(++edits),workId:f.inputs.workId,phaseId,expectedRevision:draft.manifest.draft.revision,
      content:await f.upload(text),reason:'Complete the exact generation without overstating inherited evidence.'});
  }
  async function published(phaseId){const snapshot=await f.capture(),binding=snapshot.workflow.phases[phaseId].publicationBindings.find(row=>row.generation===snapshot.workflow.phases[phaseId].generation),
    value=await f.json(binding.record),policy=value.policyEvidence.find(row=>phaseId==='build'?row.kind.startsWith('code-delivery/'):row.kind==='conformance/v1'),
    manifest=await f.json(policy.record);return {snapshot,binding,value,policy,manifest,report:await f.json(manifest.report)};}
  return {...f,engine,write,published};
}
