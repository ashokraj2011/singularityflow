/** Two actual phases and an independently approved producer's real Node execution. */
import {namespacePhaseCheckFixture} from './namespace-phase-check-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../../src/engine-storage/namespace-story-reader.mjs';
export const reuseReason='The exact same passing command and unchanged source stand for this later document phase; its original producer remains explicit.';
export async function namespaceEvidenceReuseFixture(t,{backend='filesystem',failing=false,configure=()=>{},run=true}={}){
  const f=await namespacePhaseCheckFixture(t,{backend,failing,configure(source){
    source.definition.approvalAuthorities.reviewers.members.push({email:'independent@example.test'},{email:'author@example.test'});
    const intake=source.definition.phases.intake;intake.approval={...intake.approval,allowSelfApproval:false};
    source.definition.phases.assess={...structuredClone(intake),label:'Assessment',artifact:{path:'artifacts/assess/report.md'}};
    source.definition.workTypes.simple.phases.push('assess');
    source.agents[0].phases.push('assess');source.agents[0].defaultFor.push('assess');configure(source);
  }}),{records,content,scope,workId,authority,access,clock,sources}=f.options,
    common={records,content,scope,workId,authority,access,clock,sources,working:{records:f.localRecords,content:f.localContent}},
    make=extra=>createNamespaceEngine({...common,checks:f.checks,...extra}),engine=make(),observer=createNamespaceStoryObserver(common);
  f.accessControl.permissions.push('evidence-reuse.context','decision.evidence-reuse','phase.publish','phase.submit','phase.approve','phase.review','phase.prepublish');
  const author=()=>Object.assign(f.accessControl,{principalId:'reuse-author',creator:{name:'Phase author',email:'author@example.test',login:null},agentId:'analyst'}),
    human=()=>Object.assign(f.accessControl,{principalId:'reuse-reviewer',creator:{name:'Independent reviewer',email:'independent@example.test',login:null},agentId:null});
  author();
  const approveProducer=async()=>{author();await engine.run('phase.checks.run',f.input);
    if(!failing){await engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
      await engine.run('phase.submit',{phaseId:'intake'});human();
      const review=await engine.run('phase.review',{phaseId:'intake'}),binding=review.manifest.reviewBinding;
      await engine.run('phase.approve',{phaseId:'intake',confirmation:{workId,phase:'intake',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});author();}};
  if(run)await approveProducer();
  const prepareReceiver=async()=>{author();await engine.run('phase.prepare',{phaseId:'assess'});
    const draft=await engine.run('phase.draft.read',{phaseId:'assess'});
    await engine.run('phase.draft.write',{operationId:'author-assessment',workId,phaseId:'assess',expectedRevision:draft.manifest.draft.revision,
      content:await f.upload('# Assessment\n\nThis document cites the separately approved original execution and preserves its attribution.\n'),reason:'Complete the receiving document against its retained inputs.'});};
  return {...f,common,make,engine,observer,author,human,prepareReceiver,approveProducer};
}
