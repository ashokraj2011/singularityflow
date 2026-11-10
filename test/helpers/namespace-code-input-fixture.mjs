/** A fourth independent author consumes the actual approved converter and its retained tests. */
import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
export const codeInputPublication={authored:'governed-agent',channel:'copilot-host'};
export const codeInputArtifact='# Verification\n\n## Agent brief\n\nReview the exact approved Code source and its retained execution. The converter example is covered by the producer test; this phase did not run another test.\n';
export function verificationWorkflow(source,{phaseId='verify'}={}){
  source.definition.phases[phaseId]={label:'Review verified behavior',artifact:{path:'artifacts/'+phaseId+'/evidence.md',kind:'test-evidence'},
    defaultTemplate:'intake.md',writeScope:'artifact-only',inputs:[{phase:'build'}],testEvidenceFrom:'build',
    specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
    approval:{authorities:['reviewers'],minimum:1,rejectTo:['build'],allowSelfApproval:false}};
  source.definition.workTypes.simple.phases.push(phaseId);
  source.agents.push({...source.agents[0],id:'verifier',label:'Verifier',phases:[phaseId],defaultFor:[phaseId]});
}
export async function namespaceCodeInputFixture(t,{backend='filesystem',phaseId='verify',configure=()=>{}}={}){
  async function measured(label,read){const start=performance.now();try{return await read();}
    finally{t.diagnostic(label+': '+Math.round(performance.now()-start)+' ms');}}
  const f=await measured('scope, plan, sources and actual Code checks',()=>namespaceTestWitnessFixture(t,{backend,configure:source=>{
    verificationWorkflow(source,{phaseId});configure(source);}}));
  await measured('publish Code',()=>f.engine.run('phase.publish',{phaseId:'build',...codeInputPublication}));
  await measured('independently approve Code',()=>f.approve('build'));
  assert.equal((await f.capture()).workflow.currentPhase,phaseId);f.control.agentId='verifier';
  f.control.permissions.push('phase.enter','phase.context.read');
  const engine=createNamespaceEngine({...f.options,checks:f.checks});
  await measured('prepare verifier',()=>engine.run('phase.prepare',{phaseId}));const draft=await engine.run('phase.draft.read',{phaseId});
  await engine.run('phase.draft.write',{operationId:'author-verified-input-report',workId:f.inputs.workId,phaseId,expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(codeInputArtifact),reason:'Describe the actual inherited producer evidence without inventing another execution.'});
  return {...f,engine,phaseId,measured};
}
