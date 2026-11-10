import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {namespaceTestWitnessFixture} from './namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceInitialCodeHistoryReader} from '../../src/engine-storage/namespace-code-initial-history.mjs';

export async function namespaceInitialCodeReturnCase(t,backend){
  const f=await namespaceTestWitnessFixture(t,{backend,beforeCode:async(f,plan)=>{
    f.control.permissions.push('phase.reject','phase.review');
    const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent}}),
      author={principalId:f.control.principalId,actorKind:f.control.actorKind,agentId:f.control.agentId,creator:structuredClone(f.control.creator)};
    await engine.run('phase.submit',{phaseId:'design'});
    Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
    const {manifest}=await engine.run('phase.review',{phaseId:'design'});
    await engine.run('phase.reject',{phaseId:'design',target:'design',confirm:manifest.reviewBinding.packetSha256,
      reason:'Clarify the operational consequence of the approved planned regression before implementation.'});
    const permissions=f.control.permissions;Object.assign(f.control,author,{permissions});
    try{await engine.run('phase.prepare',{phaseId:'design'});}catch(error){if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
      await engine.run('phase.draft.rebase',{operationId:'reviewed-design-successor',workId:f.inputs.workId,phaseId:'design',expectedRevision:error.details.revision,
        confirm:error.details.confirm,reason:'Keep the actual plan and author its independently requested successor.'});}
    const draft=await engine.run('phase.draft.read',{phaseId:'design'});
    await engine.run('phase.draft.write',{operationId:'clarify-plan',workId:f.inputs.workId,phaseId:'design',expectedRevision:draft.manifest.draft.revision,
      content:await f.upload(plan+'\nThe real regression must exercise the approved conversion through its public function.\n'),reason:'Address the exact reviewer request before implementation.'});
    await engine.run('phase.publish',{phaseId:'design',authored:'governed-agent',channel:'copilot-host'});await f.approve('design');
  }});
  const snapshot=await f.capture();assert.equal(snapshot.workflow.phases.build.generation,0);assert.equal(snapshot.workflow.changeRequests[0].status,'resolved');
  const reader=createNamespaceInitialCodeHistoryReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId});
  for(const mutate of [w=>{w.changeRequests[0].comment='Invented return';},w=>{w.changeRequests[0].resolution.generation=999;}]){
    const changed=structuredClone(snapshot);mutate(changed.workflow);await assert.rejects(reader.inspect(changed,'build'),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const current=await f.capture(),binding=current.workflow.phases.build.publicationBindings[0],publication=await f.json(binding.record),
    policy=publication.policyEvidence.find(row=>row.kind.startsWith('code-delivery/')),manifest=await f.json(policy.record),report=await f.json(manifest.report);
  assert.equal(policy.kind,'code-delivery/v5');assert.equal(report.preflight.history.mode,'initial');
  assert.equal(report.preflight.history.returns.length,1);assert.equal(report.preflight.history.returns[0].resolution.generation,2);
  assert.equal(f.starts(),1);await f.approve('build');assert.equal((await f.capture()).workflow.status,'closed');
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  assert.equal((await createNamespaceEngine({...f.common,clock:{now(){throw Error('Do not restamp accepted Code.');}}}).run('phase.publish',{
    phaseId:'build',authored:'governed-agent',channel:'copilot-host'})).status,'retained');
}
