import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceCodePredecessorReader} from '../src/engine-storage/namespace-code-predecessors.mjs';
test('earlier Code uses actual approvals and preserves a real policy read failure',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{configure(source){source.definition.phases.extend=structuredClone(source.definition.phases.build);
    source.definition.phases.extend.artifact.path='artifacts/extend/summary.md';source.definition.workTypes.simple.phases.push('extend');
    source.definition.workTypes.simple.plannedClaims.owners.extend='design';source.agents[0].phases.push('extend');source.agents[0].defaultFor.push('extend');}});
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  await f.engine.run('phase.submit',{phaseId:'build'});
  const reviewer=createNamespaceEngine({...f.common,access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.approve']})}}),
    {manifest}=await reviewer.run('phase.review',{phaseId:'build'}),binding=manifest.reviewBinding;
  await reviewer.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  const snapshot=await f.capture(),options={scope:f.scope,workId:f.inputs.workId},reader=createNamespaceCodePredecessorReader({...options,observer:createNamespaceStoryObserver(f.common)}),
    proof=await reader.opening(snapshot,'extend');assert.deepEqual(proof.proof.phases.map(row=>row.phase),['build']);
  for(const mutate of [workflow=>{workflow.phases.build.approvals[0].namespaceVote.record.sha256='f'.repeat(64);},
    workflow=>{workflow.phases.build.approvals=[];},workflow=>{workflow.phases.build.publicationBindings[0].record.sha256='f'.repeat(64);}]){
    const forged=structuredClone(snapshot);mutate(forged.workflow);await assert.rejects(reader.opening(forged,'extend'),error=>
      ['ENGINE_STORAGE_CORRUPT','ENGINE_STORAGE_CONTENT_MISSING'].includes(error.code));}
  const policy=proof.proof.phases[0].policy.record,denied=Object.assign(Error('The actual original Code policy is unreadable.'),{code:'EACCES'}),
    unavailable=createNamespaceCodePredecessorReader({...options,observer:createNamespaceStoryObserver({...f.common,content:{...f.content,read(scope,ref,options){
      if(ref.sha256===policy.sha256)throw denied;return f.content.read(scope,ref,options);}}})});
  await assert.rejects(unavailable.opening(snapshot,'extend'),error=>error===denied);assert.deepEqual(await f.capture(),snapshot);
});
