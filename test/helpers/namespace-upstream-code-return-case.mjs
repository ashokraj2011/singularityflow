import assert from 'node:assert/strict';import {readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture} from './namespace-test-witness-fixture.mjs';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './namespace-release-fixture.mjs';
import {specificationText} from './namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
async function returned(f,engine,phaseId,operationId){
  f.control.permissions.push('upstream.raise','upstream.decide');
  await engine.run('upstream.raise',{operationId:'raise-'+operationId,phaseId,about:'the concrete regression contract',authored:'human',
    problem:'The earlier producer omitted a concrete consequence required by this change.',proposed:'return'});
  const before={principalId:f.control.principalId,agentId:f.control.agentId,actorKind:f.control.actorKind,creator:structuredClone(f.control.creator)};
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,actorKind:'human',creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const input={operationId,issueId:'UPI-001',outcome:'return',reason:'Repair the original producer and revalidate its downstream Code against the corrected input.'};
  try{const result=await engine.run('upstream.decide',input);assert.equal(result.currentPhase,phaseId);
    assert.deepEqual(await engine.run('upstream.decide',input),result);return result;
  }finally{Object.assign(f.control,before);}
}
async function write(f,engine,phaseId,text,id){
  try{await engine.run('phase.prepare',{phaseId});}catch(error){if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
    await engine.run('phase.draft.rebase',{operationId:'rebase-'+id,workId:f.inputs.workId,phaseId,expectedRevision:error.details.revision,
      confirm:error.details.confirm,reason:'Preserve the authored document under the authenticated upstream return.'});}
  const draft=await engine.run('phase.draft.read',{phaseId});
  await engine.run('phase.draft.write',{operationId:id,workId:f.inputs.workId,phaseId,expectedRevision:draft.manifest.draft.revision,content:await f.upload(text),
    reason:'Correct the actual returned generation before fresh checks and independent approval.'});
}
export async function namespaceUpstreamInitialCodeCase(t,backend){
  const f=await namespaceTestWitnessFixture(t,{backend,beforeCode:async(f,plan)=>{
    const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent}});
    await returned(f,engine,'intake','return-before-first-code');
    await write(f,engine,'intake',specificationText+'\nThe example must be observable through the public converter.\n','repair-upstream-scope');
    await engine.run('phase.publish',{phaseId:'intake',...releasePublish});await f.approve('intake');
    await write(f,engine,'design',plan+'\nThe regression exercises the exact approved public converter.\n','revalidate-upstream-plan');
    await engine.run('phase.publish',{phaseId:'design',...releasePublish});await f.approve('design');
  }});
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});
  const state=await f.capture(),publication=await f.json(state.workflow.phases.build.publicationBindings[0].record),policy=publication.policyEvidence.find(row=>row.kind.startsWith('code-delivery/')),
    manifest=await f.json(policy.record),report=await f.json(manifest.report);
  assert.equal(policy.kind,'code-delivery/v8');assert.equal(report.preflight.history.profile,'sflow-namespace-code-history/v6');
  assert.equal(report.preflight.history.returns[0].kind,'upstream');assert.equal(report.preflight.history.returns[0].resolution.generation,2);
  assert.equal(f.starts(),1);await f.approve('build');assert.equal((await f.capture()).workflow.status,'closed');
}
export async function namespaceUpstreamSuccessorCodeCase(t,backend,{direct=false}={}){
  const f=direct?await namespaceReleaseFixture(t,{backend}):await namespaceTestWitnessFixture(t,{backend});
  if(!direct)await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});
  const first=await f.capture(),original=first.workflow.phases.build.publicationBindings[0],old=await f.json(original.record),target=direct?'build':'design';
  await returned(f,f.engine,target,'return-authenticated-code');f.control.agentId='analyst';
  if(!direct){const {planText}=await import('./namespace-specification-fixture.mjs');
    await write(f,f.engine,'design',planText+'\nKeep the approved converter and rerun the boundary regression.\n','repair-predecessor-plan');
    await f.engine.run('phase.publish',{phaseId:'design',...releasePublish});await f.approve('design');}
  await write(f,f.engine,'build','# Corrected implementation\n\n## Agent brief\n\nPreserve the original behavior and validate its exact boundary against the independently reapproved input.\n','author-code-after-upstream-return');
  const file=path.join(f.root,'test/converter.test.js');await writeFile(file,(await readFile(file,'utf8'))+"\ntest('checks another boundary',()=>assert.equal(convert(256),'100'));\n");
  await f.engine.run('phase.source.retain',{operationId:'retain-upstream-code-successor',workId:f.inputs.workId,phaseId:'build'});
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',...releasePublish}),{code:'ENGINE_CHECK_EVIDENCE_REQUIRED'});
  await f.engine.run('phase.checks.run',{operationId:'test-upstream-code-successor',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});const state=await f.capture(),publication=await f.json(state.workflow.phases.build.publicationBindings[1].record),
    policy=publication.policyEvidence.find(row=>row.kind.startsWith('code-delivery/')),manifest=await f.json(policy.record),report=await f.json(manifest.report);
  assert.equal(policy.kind,'code-delivery/v8');assert.equal(report.preflight.history.profile,direct?'sflow-namespace-code-history/v5':'sflow-namespace-code-history/v7');
  assert.deepEqual(report.preflight.history.predecessor.publication,original);assert.equal(f.starts(),2);assert.equal(report.repositories[0].witnesses[0].result.status,'met');
  await f.approve('build');
  if(direct){f.control.agentId='release-reviewer';await f.write('release',releaseReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');}
  assert.equal((await f.capture()).workflow.status,'closed');assert.deepEqual(await f.json(original.record),old);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  assert.equal((await createNamespaceEngine({...f.common,clock:{now(){throw Error('Do not restamp an accepted Code successor.');}}}).run('phase.publish',{phaseId:'build',...releasePublish})).status,'retained');
}
