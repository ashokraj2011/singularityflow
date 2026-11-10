/** Three genuinely authored/tested Code phases over one approved specification and plan. */
import assert from 'node:assert/strict';import {readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture} from './namespace-test-witness-fixture.mjs';
import {specificationText} from './namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNodeCheckExecutionUnit} from '../../src/sgos/node-check-execution-unit.mjs';
import {WITNESS_CHECKLIST} from '../../src/kernel/human-witnesses.mjs';
const phases=['build','extend','finish'],items=[{file:'converter',name:'convert',base:16,answer:'FF'},{file:'binary',name:'binary',base:2,answer:'11111111'},
  {file:'octal',name:'octal',base:8,answer:'377'}],publish={authored:'governed-agent',channel:'copilot-host'},
  specification=specificationText+'\n[STORY-1:REQ-002] Convert an integer into binary.\n\n[STORY-1:AC-002] Given 255, conversion returns 11111111.\n'
    +'\n[STORY-1:REQ-003] Convert an integer into octal.\n\n[STORY-1:AC-003] Given 255, conversion returns 377.\n';
const plan='# Delivery plan\n\n## Agent brief\n\nImplement each independently allocated converter and its own executed regression without claiming another phase\'s work.\n\n'
  +'| Clause | Expected paths | Planned tests | Steps |\n| --- | --- | --- | --- |\n'
  +items.flatMap((item,index)=>['REQ','AC'].map(kind=>'| STORY-1:'+kind+'-00'+(index+1)+' | `src/'+item.file+'.js` | `test/'+item.file+'.test.js` | '+phases[index]+' |')).join('\n')+'\n';
export async function namespaceMultipleCodeCase(t,backend,{mixed=false,repositories=1,removal=false}={}){
  let qualified=repositories===2?plan.replaceAll(/`(src|test)\/([^`]+)`/gu,(_match,folder,file)=>'`frontend/'+folder+'/'+file+'`, `backend/'+folder+'/'+file+'`')
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n':plan;
  if(removal)qualified=qualified.replace('| Planned tests | Steps |','| Planned tests | Steps | Fulfillment |')
    .replace('| --- | --- | --- | --- |','| --- | --- | --- | --- | --- |').replace(/\| build \|/gu,'| build | removed |').replace(/\| (extend|finish) \|/gu,'| $1 | new |');
  const f=await namespaceTestWitnessFixture(t,{backend,repositories,specification:removal?specification.replace('Convert an integer into hexadecimal.','Remove the obsolete hexadecimal converter file.')
    .replace('Given 255, conversion returns FF.','Given the obsolete converter, its source file is absent.'):specification,
    ...(removal?{source:null,testSource:"import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';\n// @ac:STORY-1:AC-001\ntest('the obsolete source is absent',()=>assert.equal(existsSync(new URL('../src/converter.js',import.meta.url)),false));\n"}:{}),
    plan:qualified+(mixed?'\n## Verification contracts\n\n| Criterion | Slot | Method | Witness | Role | Combination |\n| --- | --- | --- | --- | --- | --- |\n'
    +'| STORY-1:AC-003 | tests | test | `test/octal.test.js` | primary | all |\n| STORY-1:AC-003 | octal-screen | visual | `octal` | primary | all |\n':''),configure(source){
      for(const [index,phaseId]of phases.entries())if(index){const phase=structuredClone(source.definition.phases.build);
        phase.label=phaseId;phase.artifact.path='artifacts/'+phaseId+'/summary.md';phase.qualityCommands[0].argv=['node','--test','test/'+items[index].file+'.test.js'];
        source.definition.phases[phaseId]=phase;source.agents[0].phases.push(phaseId);source.agents[0].defaultFor.push(phaseId);}
      source.definition.workTypes.simple.phases.push('extend','finish');source.definition.workTypes.simple.plannedClaims.owners={build:'design',extend:'design',finish:'design'};
      if(mixed){source.definition.artifactSets={last:{primary:'summary.md',members:[{path:'summary.md',role:'implementation-summary',required:true},
        {path:'proof.png',role:'supporting-evidence',required:true}]}};source.definition.phases.finish.artifactSet='last';}
    }});
  await f.engine.run('phase.publish',{phaseId:'build',...publish});
  let starts=f.starts();const units=[...f.checks.bindings];
  for(const [index,item]of items.entries())if(index)for(const [repositoryIndex,root]of f.roots.entries()){
    const environment=f.checks.bindings[repositoryIndex].environment,executableSha256=f.checks.bindings[repositoryIndex].executableSha256,repositoryId=f.sources[repositoryIndex].descriptor.repositoryId,
    raw=await createNodeCheckExecutionUnit({id:'multiple-code-'+index+'-'+repositoryIndex,root,projectId:f.scope.projectId,repositoryId,content:f.content,
      command:{executable:process.execPath,executableSha256,arguments:['--test','test/'+item.file+'.test.js'],environment},report:{adapter:'node-tap',files:[]},authorizeCommand:value=>value.manifestSha256});
    units.push({phaseId:phases[index],commandId:'node-tests',repositoryId,executable:'node',executableSha256,environment,unit:{...raw,start(task){starts++;return raw.start(task);}}});}
  const engine=createNamespaceEngine({...f.options,checks:{owner:f.checks.owner,bindings:units}}),publications=[],
    reviewer=createNamespaceEngine({...f.options,access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
      identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.approve']})}});
  async function approve(phaseId){await engine.run('phase.submit',{phaseId});const {manifest}=await reviewer.run('phase.review.resources',{phaseId});
    for(const resource of manifest.resources)await reviewer.run('document.read',{reference:resource.reference});const binding=manifest.reviewBinding;
    return reviewer.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}});}
  await approve('build');
  for(let index=1;index<items.length;index++){
    const item=items[index],phaseId=phases[index],suffix='00'+(index+1);f.control.agentId='analyst';
    await engine.run('phase.prepare',{phaseId});let draft=await engine.run('phase.draft.read',{phaseId});
    await engine.run('phase.draft.write',{operationId:'complete-'+phaseId,workId:f.inputs.workId,phaseId,expectedRevision:draft.manifest.draft.revision,
      content:await f.upload('# '+phaseId+' implementation\n\n## Agent brief\n\nImplement this allocated converter and execute its exact boundary test while preserving earlier approved application inputs.\n'),
      reason:'Complete this independently allocated delivery with actual source and execution.'});
    if(mixed&&index===2){f.control.permissions.push('phase.artifact.attach');draft=await engine.run('phase.draft.read',{phaseId});
      await engine.run('phase.artifact.attach',{operationId:'last-binary-fixture',workId:f.inputs.workId,phaseId,memberPath:'proof.png',expectedRevision:draft.manifest.draft.revision,
        content:await f.upload(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])),reason:'Retain the isolated binary fixture for an independent exact-candidate visual decision.'});}
    for(const root of f.roots){await writeFile(path.join(root,'src/'+item.file+'.js'),'// @clause:STORY-1:REQ-'+suffix+' Convert the integer into '+item.base+'.\n'
      +'// @clause:STORY-1:AC-'+suffix+' Return the approved example.\nexport const '+item.name+'=value=>value.toString('+item.base+');\n');
    await writeFile(path.join(root,'test/'+item.file+'.test.js'),"import test from 'node:test';import assert from 'node:assert/strict';import {"+item.name+"} from '../src/"+item.file+".js';\n"
      +'// @ac:STORY-1:AC-'+suffix+"\ntest('the approved example',()=>assert.equal("+item.name+"(255),'"+item.answer+"'));\n");}
    const converter=path.join(f.roots.at(-1),'src/converter.js'),original=removal?null:await readFile(converter);
    if(index===2)await writeFile(converter,removal?'export const obsolete=true;\n':original.toString('utf8').replace('toUpperCase()','toLowerCase()'));
    async function capture(id){await engine.run('phase.source.retain',{operationId:id+'-source',workId:f.inputs.workId,phaseId});
      return engine.run('phase.checks.run',{operationId:id+'-checks',workId:f.inputs.workId,phaseId});}
    await capture('observed-'+phaseId);
    if(index===2){await assert.rejects(engine.run('phase.publish',{phaseId,...publish}),error=>error.code==='ENGINE_PRIOR_CODE_REVALIDATION_REQUIRED'
      &&error.details.paths.includes('src/converter.js')&&error.details.actions[0].operation==='upstream.raise');
      if(removal)await rm(converter);else await writeFile(converter,original);await capture('restored-'+phaseId);}
    await engine.run('phase.publish',{phaseId,...publish});const snapshot=await f.capture(),binding=snapshot.workflow.phases[phaseId].publicationBindings[0],published=await f.json(binding.record),
      policy=published.policyEvidence.find(row=>row.kind.startsWith('code-delivery/')),report=await f.json((await f.json(policy.record)).report);
    assert.equal(policy.kind,mixed&&index===2?'code-delivery/v11':'code-delivery/v10');assert.deepEqual(report.preflight.priorCode.phases.map(row=>row.phase),phases.slice(0,index));
    assert.deepEqual(report.preflight.repositories[0].delivery.sourcePaths,['src/'+item.file+'.js']);
    assert.equal(report.preflight.repositories[0].coverage.status,'ready');if(index===2)assert.equal(report.preflight.repositories[0].coverage.coverage.complete,true);
    publications.push({phaseId,binding,report});
    if(mixed&&index===2){const access={current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
        identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['witness.context','decision.witness']})},
        reviewer=f.make({access}),query={clauseId:'STORY-1:AC-003',slotName:'octal-screen',file:'singularity/work-items/'+f.inputs.workId+'/artifacts/finish/proof.png'},
        context=await reviewer.run('witness.context',query);
      await reviewer.run('decision.witness',{operationId:'last-exact-visual-review',workId:f.inputs.workId,...query,expectedContext:context.manifest.contextBinding,
        expectedFile:'sha256:'+context.manifest.file.content.sha256,answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),
        reason:'The isolated fixture reviewer inspected the exact octal output against the approved visual criterion.'});}
    await approve(phaseId);
  }
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(starts,4*repositories,'The changed earlier input needed another actual last-phase execution after restoration.');
  for(const root of f.roots)await rm(root,{recursive:true,force:true});const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('A shared-only Code replay cannot restamp or rerun.');}}});
  for(const row of publications)assert.equal((await replay.run('phase.publish',{phaseId:row.phaseId,...publish})).status,'retained');
  return {f,publications};
}
