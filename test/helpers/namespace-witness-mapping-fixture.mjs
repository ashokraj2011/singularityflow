import {namespaceTestWitnessFixture} from './namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
export async function namespaceWitnessMappingFixture(t,options={}){
  const f=await namespaceTestWitnessFixture(t,{...options,configure:source=>{
    source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/report.md',kind:'summary'},defaultTemplate:'intake.md',
      inputs:[{phase:'build'}],clarification:{mode:'off',markers:{mode:'off'}},specificationQuality:{mode:'off'},approval:{authorities:['reviewers'],minimum:1,rejectTo:['build'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('release');source.agents[0].phases.push('release');source.agents[0].defaultFor.push('release');
    options.configure?.(source);
  }});let at=Date.parse(await f.clock.now()),human=true,allowed=true;
  const access={current:()=>({projectId:f.scope.projectId,principalId:human?'independent-reviewer':'author',actorKind:'human',agentId:null,
    identity:human?{name:'Independent reviewer',email:'independent@example.test',login:null}:f.control.creator,
    permissions:allowed?['phase.approve','phase.review','story.evidence','scope.context','decision.scope','decisions.list','test-witness.context','decision.witness-exception']:[]})},
    make=extra=>createNamespaceEngine({...f.options,access,clock:{now:()=>new Date(at).toISOString()},...extra}),reviewer=make();
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  await f.engine.run('phase.submit',{phaseId:'build',...(options.submissionValues?{decisionValues:options.submissionValues}:{})});
  const review=await reviewer.run('phase.review',{phaseId:'build'}),b=review.manifest.reviewBinding,
    confirmation={workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256};
  return {...f,reviewer,make,confirmation,advance:ms=>{at+=ms;},at:()=>at,human:value=>{human=value;},allowed:value=>{allowed=value;}};
}
