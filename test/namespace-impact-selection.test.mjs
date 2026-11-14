import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './helpers/namespace-selective-test-recovery-fixture.mjs';
import {fixtureImpactUnit} from './helpers/source-impact-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'},baselineFiles={
  'test/first.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';test('first stable regression',()=>assert.equal(convert(0),'0'));\n"};
async function impactFixture(t,options={}){
  const f=await namespaceSelectiveTestRecoveryFixture(t,{...options,baselineFiles:{...baselineFiles,...options.baselineFiles}}),
    checks={...f.checks,impact:fixtureImpactUnit(f,options)},engine=createNamespaceEngine({...f.options,checks}),input={phaseId:'build',baselineOperationId:'pre-feature-full-execution',mode:'changed-and-affected'},
    confirm=async()=>{f.human();const view=await engine.run('test-recovery.select-context',input),request={...input,operationId:'confirm-source-impact',expectedContext:view.manifest.expectedContext,
      reason:selectionReason,expires:'2026-11-20',followUpOwner:'suite-owner',remediationRef:'IMPACT-1'};
      const result=await engine.run('test-recovery.select-confirm',request);return {view,request,result};};
  return {...f,checks,engine,input,confirm};
}
for(const backend of ['filesystem','sqlite','application'])test('actual AST impact drives selected execution, independent approval and shared-only replay: '+backend,{timeout:180000},async t=>{
  const f=await impactFixture(t,{backend}),{view,request,result}=await f.confirm();
  assert.equal(view.manifest.schemaVersion,2);assert.equal(result.record.schemaVersion,2);
  assert.equal(view.manifest.impact.selection.dependencyCoverage,'closed-static-graph');assert.equal(view.manifest.impactComplete,false);
  assert.deepEqual(view.manifest.rows[0].selectedIds,['legacy:first']);assert.deepEqual(view.manifest.rows[0].excludedIds,['legacy:second']);
  await f.rebase();const run=await f.engine.run('phase.checks.run',{operationId:'impact-receiving-execution',workId:f.inputs.workId,phaseId:'build'});
  assert.equal(run.verdict,'passed');assert.equal(run.execution.mode,'changed-and-affected');assert.equal(run.execution.completeSuiteClaimed,false);
  assert.deepEqual(run.execution.unexecuted[0].testIds,['legacy:second']);
  await f.engine.run('phase.publish',publish);const snapshot=await f.capture(),published=await f.json(snapshot.workflow.phases.build.publicationBindings[0].record);
  assert.ok(published.policyEvidence.some(row=>row.kind==='code-delivery/v40'));assert.ok(published.policyEvidence.some(row=>row.kind==='test-recovery/v4'));
  await f.engine.run('phase.submit',{phaseId:'build'});f.human();const binding=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
  await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  await rm(f.root,{recursive:true,force:true});const offline=f.make({working:null,sources:[],checks:{mode:'retained-only'}});
  assert.equal((await offline.run('test-recovery.select-confirm',request)).status,'retained');f.author();
  assert.equal((await offline.run('phase.checks.run',{operationId:'impact-receiving-execution',workId:f.inputs.workId,phaseId:'build'})).replayed,true);
});
test('unresolved impact expands the complete configured files without inventing semantic completeness',{timeout:120000},async t=>{
  const f=await impactFixture(t,{unknown:true}),{view}=await f.confirm();assert.deepEqual(view.manifest.rows[0].excludedIds,[]);
  assert.equal(view.manifest.impact.selection.dependencyCoverage,'expanded-configured-commands');
  await f.rebase();const run=await f.engine.run('phase.checks.run',{operationId:'expanded-impact-run',workId:f.inputs.workId,phaseId:'build'});
  assert.equal(run.verdict,'passed');assert.equal(run.checks.find(row=>row.id==='legacy-tests').tests.discovered,2);
});
test('real analyzer read/permission/timeouts are preserved and changed bytes require a fresh review',{timeout:120000},async t=>{
  const f=await impactFixture(t),view=await f.engine.run('test-recovery.select-context',f.input);
  for(const code of ['ENOENT','EACCES','ETIMEDOUT']){const failure=Object.assign(Error('Actual AST read failed.'),{code,path:'actual-source',timeoutMs:300000}),
    broken=f.make({checks:{...f.checks,impact:{descriptor:f.checks.impact.descriptor,observe(){throw failure;}}}});
    await assert.rejects(broken.run('test-recovery.select-context',f.input),error=>error===failure);}
  await writeFile(path.join(f.root,'src/converter.js'),(await readFile(path.join(f.root,'src/converter.js'),'utf8'))+'\n// new impact revision\n');f.human();
  await assert.rejects(f.engine.run('test-recovery.select-confirm',{...f.input,operationId:'stale-impact',expectedContext:view.manifest.expectedContext,
    reason:selectionReason,expires:'2026-11-20',followUpOwner:'suite-owner',remediationRef:'IMPACT-2'}),{code:'SELECTIVE_TEST_RECOVERY_CONTEXT_CHANGED'});
});
test('oversized impact knowledge offers full configured execution without recording a scope exception',{timeout:120000},async t=>{
  const f=await impactFixture(t,{analyze:({files})=>({nodes:files.map(({repositoryId,path,sha256})=>({repositoryId,path,sha256,dependencies:[]})),
    unknown:Array.from({length:30000},()=>({repositoryId:files[0].repositoryId,path:files[0].path,reason:'unresolved-framework-contract'}))})});
  await assert.rejects(f.engine.run('test-recovery.select-context',f.input),error=>error.code==='ENGINE_STORAGE_LIMIT'
    &&error.details.actions.some(row=>row.operation==='phase.checks.run'&&row.inputs.phaseId==='build'));
  assert.equal((await f.capture()).workflow.namespaceSelectiveTestRecoveries?.length??0,0);await f.rebase('continue-full-configured-checks');
  assert.equal((await f.engine.run('phase.checks.run',{operationId:'full-after-impact-budget',workId:f.inputs.workId,phaseId:'build'})).verdict,'passed');
});
test('a successor reviews its actual candidate generation without rewriting original impact evidence',{timeout:180000},async t=>{
  const f=await impactFixture(t);f.control.permissions.push('phase.begin','decisions.list');await f.confirm();await f.rebase();
  await f.engine.run('phase.checks.run',{operationId:'first-impact-generation',workId:f.inputs.workId,phaseId:'build'});await f.engine.run('phase.publish',publish);
  const original=(await f.capture()).workflow.phases.build.publicationBindings[0];f.author();await f.engine.run('phase.begin',{phaseId:'build'});
  const draft=await f.engine.run('phase.draft.read',{phaseId:'build'});await f.engine.run('phase.draft.write',{operationId:'author-impact-successor',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload('# Implementation\n\n## Agent brief\n\nThe successor retains the reviewed converter and executes the affected independent regressions for this generation.\n'),reason:selectionReason});
  f.human();await f.engine.run('test-recovery.select-confirm',{operationId:'revoke-first-generation-scope',revoke:'STR-001',reason:selectionReason});
  const input={...f.input,candidateGeneration:2},view=await f.engine.run('test-recovery.select-context',input);assert.equal(view.manifest.generation,2);
  await assert.rejects(f.engine.run('test-recovery.select-context',{...input,candidateGeneration:3}),{code:'SELECTIVE_TEST_RECOVERY_CONTEXT_CHANGED'});
  await f.engine.run('test-recovery.select-confirm',{...input,operationId:'review-impact-successor',expectedContext:view.manifest.expectedContext,reason:selectionReason,expires:'2026-11-20',followUpOwner:'suite-owners',remediationRef:'IMPACT-3'});
  const decisions=(await f.engine.run('decisions.list')).manifest,route=decisions.actions.find(row=>row.operation==='test-recovery.select-context'&&row.inputs.candidateGeneration===2);
  assert.ok(route);assert.deepEqual(route.inputs,{workId:f.inputs.workId,...input});assert.equal((await f.engine.run(route.operation,route.inputs)).manifest.expectedContext,view.manifest.expectedContext);
  await f.rebase('continue-impact-successor');const tested=await f.engine.run('phase.checks.run',{operationId:'second-impact-generation',workId:f.inputs.workId,phaseId:'build'});
  assert.equal(tested.generation,2);assert.equal(tested.verdict,'passed');await f.engine.run('phase.publish',publish);
  const phase=(await f.capture()).workflow.phases.build;assert.equal(phase.generation,2);assert.deepEqual(phase.publicationBindings[0],original);
});
