/** Exact targeted successors keep prior Code proofs and require a new visual decision. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceMultipleCodeCase} from './helpers/namespace-multiple-code-case.mjs';
import {releasePublish} from './helpers/namespace-release-fixture.mjs';
import {WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
const report=verdict=>'# Release conformance\n\n## Agent brief\n\nPreserve all three actual Code executions and the exact last visual review.\n\n'
  +'| Clause ID | Verdict |\n| --- | --- |\n'+[1,2,3].flatMap(i=>['REQ','AC'].map(kind=>'| STORY-1:'+kind+'-00'+i+' | '+(i===3?verdict:'matched')+' |\n')).join('');
test('sqlite: targeted last Code preserves two predecessors and cannot copy an earlier visual approval',{timeout:600000},async t=>{
  const {f,starts,approve}=await namespaceMultipleCodeCase(t,'sqlite',{mixed:true,release:true});
  const identity={projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.review','phase.reject','phase.approve','witness.context','decision.witness']},
    reviewer=createNamespaceEngine({...f.options,checks:f.checks,access:{current:()=>identity}});
  f.control.agentId='release-reviewer';await f.engine.run('phase.prepare',{phaseId:'release'});
  async function write(phaseId,text,id){const draft=await f.engine.run('phase.draft.read',{phaseId});
    await f.engine.run('phase.draft.write',{operationId:id,workId:f.inputs.workId,phaseId,expectedRevision:draft.manifest.draft.revision,
      content:await f.upload(text),reason:'Complete the actual exact-generation artifact with retained evidence.'});}
  await write('release',report('partial'),'first-three-Code-release');await f.engine.run('phase.publish',{phaseId:'release',...releasePublish})
    .catch(error=>{t.diagnostic(JSON.stringify(error.details));throw error;});await f.engine.run('phase.submit',{phaseId:'release'});
  const {manifest}=await reviewer.run('phase.review',{phaseId:'release'}),request={phaseId:'release',target:'finish',clauseIds:['STORY-1:AC-003'],
    reason:'Repair the octal acceptance boundary without changing the two independently approved earlier converters.',confirm:manifest.reviewBinding.packetSha256};
  await reviewer.run('phase.reject',request);f.control.agentId='analyst';
  try{await f.engine.run('phase.prepare',{phaseId:'finish'});}catch(error){if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
    await f.engine.run('phase.draft.rebase',{operationId:'rebase-targeted-last-Code',workId:f.inputs.workId,phaseId:'finish',expectedRevision:error.details.revision,
      confirm:error.details.confirm,reason:'Preserve the actual selected last Code draft under the reviewed return.'});}
  await write('finish','# Repaired octal implementation\n\n## Agent brief\n\nRe-execute the approved octal behavior and retain the exact output for a new human visual decision.\n','write-targeted-last-Code');
  const root=f.roots[0],testFile=path.join(root,'test/octal.test.js');await writeFile(testFile,(await readFile(testFile,'utf8'))+"\ntest('converts the next octal boundary',()=>assert.equal(octal(256),'400'));\n");
  const draft=await f.engine.run('phase.draft.read',{phaseId:'finish'});
  await f.engine.run('phase.artifact.attach',{operationId:'targeted-last-output',workId:f.inputs.workId,phaseId:'finish',memberPath:'proof.png',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])),reason:'Retain this isolated binary fixture for its new exact-generation visual decision.'});
  await f.engine.run('phase.source.retain',{operationId:'targeted-last-source',workId:f.inputs.workId,phaseId:'finish'});
  await f.engine.run('phase.checks.run',{operationId:'targeted-last-execution',workId:f.inputs.workId,phaseId:'finish'});
  await f.engine.run('phase.publish',{phaseId:'finish',...releasePublish});const snapshot=await f.capture(),publication=snapshot.workflow.phases.finish.publicationBindings.at(-1),
    value=await f.json(publication.record),binding=value.policyEvidence.find(row=>row.kind.startsWith('code-delivery/')),policy=await f.json(binding.record),checked=await f.json(policy.report);
  assert.equal(policy.schemaVersion,15);assert.equal(checked.preflight.history.profile,'sflow-namespace-code-history/v8');
  assert.deepEqual(checked.preflight.priorCode.phases.map(row=>row.phase),['build','extend']);
  await f.engine.run('phase.submit',{phaseId:'finish'});const review=(await reviewer.run('phase.review',{phaseId:'finish'})).manifest.reviewBinding,
    approval={phaseId:'finish',confirmation:{workId:f.inputs.workId,phase:'finish',generation:review.generation,reviewPacketSha256:review.packetSha256}};
  await assert.rejects(reviewer.run('phase.approve',approval),{code:'ENGINE_WITNESS_DECISION_REQUIRED'});
  const query={clauseId:'STORY-1:AC-003',slotName:'octal-screen',file:'singularity/work-items/'+f.inputs.workId+'/artifacts/finish/proof.png'},
    context=await reviewer.run('witness.context',query);assert.equal(context.manifest.result.status,'missing');
  await reviewer.run('decision.witness',{operationId:'targeted-last-visual-decision',workId:f.inputs.workId,...query,expectedContext:context.manifest.contextBinding,
    expectedFile:'sha256:'+context.manifest.file.content.sha256,answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),
    reason:'The isolated fixture reviewer inspected the exact repaired octal candidate and approved criterion.'});await reviewer.run('phase.approve',approval);
  f.control.agentId='release-reviewer';
  try{await f.engine.run('phase.prepare',{phaseId:'release'});}catch(error){if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
    await f.engine.run('phase.draft.rebase',{operationId:'rebase-targeted-final-release',workId:f.inputs.workId,phaseId:'release',expectedRevision:error.details.revision,
      confirm:error.details.confirm,reason:'Retain the reviewed Release draft under the actual replacement Code approval.'});}
  await write('release',report('matched'),'complete-three-Code-release');await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(starts(),5);
  for(const sourceRoot of f.roots)await rm(sourceRoot,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('An immutable targeted Code replay cannot restamp or rerun.');}}});
  assert.equal((await replay.run('phase.publish',{phaseId:'finish',...releasePublish})).status,'retained');
  assert.equal((await reviewer.run('phase.reject',request)).changeRequest.targetPhase,'finish');
});
