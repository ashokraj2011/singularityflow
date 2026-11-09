/** Actual approved-plan/source binding through the SDK registry, not supplied ready booleans. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {namespaceSourceClauseFixture,converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceSourceRetentionReader} from '../src/engine-storage/namespace-source-retention-reader.mjs';
import {createNamespaceSourceBaselineReader} from '../src/engine-storage/namespace-source-baseline-reader.mjs';
import {createNamespaceSourceClauseReader} from '../src/engine-storage/namespace-source-clauses.mjs';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {DELIVERY_INSPECTION_PROFILE_V3,PLANNED_SOURCE_CLAUSES_PROFILE} from '../src/kernel/source-changes.mjs';
const ids=['STORY-1:AC-001','STORY-1:REQ-001'];
async function reader(f) {
  const retention=createNamespaceSourceRetentionReader(f.options),baseline=createNamespaceSourceBaselineReader(f.options),observer=retention.observer,
    found=await retention.accepted({operationId:'clause-current-bytes',workId:f.inputs.workId,phaseId:'build'}),
    original=await baseline.inspectBinding('clause-source-selection'),snapshot=await f.capture();
  return {retention,baseline,observer,found,original,snapshot,clauses:createNamespaceSourceClauseReader({observer,scope:f.scope,workId:f.inputs.workId,retention,baseline})};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': approved definitions and plan bind exact retained source comments through one registered operation',async t=>{
  const f=await namespaceSourceClauseFixture(t,{backend}),before=await f.head(),clock=f.control.clockCalls,result=await f.inspect(),m=result.manifest,c=m.clauses;
  assert.equal(m.schemaVersion,3);assert.equal(m.contract,DELIVERY_INSPECTION_PROFILE_V3);assert.equal(c.profile,PLANNED_SOURCE_CLAUSES_PROFILE);
  assert.equal(c.status,'observed');assert.equal(c.plan.phase,'design');assert.equal(c.plan.generation,1);assert.equal(c.plan.indices[0].phase,'intake');
  assert.deepEqual(c.retentionRecord,m.evidence.changes.record.content);assert.deepEqual(c.repositories[0].totals,{required:2,bindings:2,missing:0});
  assert.deepEqual(c.repositories[0].obligations.map(row=>row.clauseId),ids);
  assert.deepEqual(c.repositories[0].obligations[0].bindings,[{path:'src/converter.js',line:2,tag:'clause'}]);
  const state=await f.capture(),planPublication=await f.json(state.workflow.phases.design.publicationBindings[0].record),evidence=await f.json(planPublication.specifications.record);
  assert.deepEqual(c.plan.planned,evidence.planned);assert.deepEqual(c.plan.reviewPacket,state.workflow.phases.design.namespaceSubmission.record);
  assert.equal(state.workflow.phases.design.approvals[0].selfApproval,false);
  assert.equal(m.applicationAcceptanceEstablished,false);assert.equal(m.publicationReadinessInspected,false);assert.equal(result.effects.testsRun,false);
  assert.ok(m.requiredPolicyOwners.includes('code-delivery'));assert.equal(f.control.clockCalls,clock);assert.deepEqual(await f.head(),before);
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'}),
    error=>error.code==='ENGINE_CHECK_EVIDENCE_REQUIRED'&&error.details.operation==='phase.checks.run');
});
test('missing comments stay missing; an unchanged tag is described without claiming delivered source',async t=>{
  const absent=await namespaceSourceClauseFixture(t,{source:'export const convert=value=>value.toString(16);\n'}),a=(await absent.inspect()).manifest.clauses;
  assert.equal(a.status,'observed');assert.deepEqual(a.repositories[0].totals,{required:2,bindings:0,missing:2});
  const unchanged=await namespaceSourceClauseFixture(t,{source:converterSource,baselineSource:converterSource}),u=(await unchanged.inspect()).manifest.clauses;
  assert.deepEqual(u.repositories[0].totals,{required:2,bindings:0,missing:2});
  assert.deepEqual(u.repositories[0].obligations.find(row=>row.clauseId===ids[0]).unchangedTags,[{path:'src/converter.js',line:2}]);
});
test('deleting planned product source binds only that actual retained deletion',async t=>{
  const f=await namespaceSourceClauseFixture(t,{source:null}),c=(await f.inspect()).manifest.clauses;
  assert.deepEqual(c.repositories[0].totals,{required:2,bindings:2,missing:0});
  for(const row of c.repositories[0].obligations)assert.deepEqual(row.bindings,[{path:'src/converter.js',line:null,tag:'deletion'}]);
});
test('unapproved source clauses preserve the original finding instead of becoming accepted metadata',async t=>{
  const f=await namespaceSourceClauseFixture(t,{source:converterSource+'// @clause:STORY-1:REQ-999 This requirement was never approved.\n'}),before=await f.head();
  await assert.rejects(f.inspect(),error=>error.code==='EVIDENCE_CLAUSE_UNAPPROVED'&&error.details.findings[0].clauseId==='STORY-1:REQ-999');
  assert.deepEqual(await f.head(),before);
});
test('shared clause namespaces and unqualified multi-repository plans keep their origin/ownership gap explicit',async t=>{
  const shared=await namespaceSourceClauseFixture(t,{namespace:'SHARED'}),s=(await shared.inspect()).manifest.clauses;
  assert.equal(s.status,'pending-owner');assert.deepEqual(s.requiredPolicyOwners,['source-tag-origin']);assert.equal(s.repositories[0].totals,null);
  assert.deepEqual(s.repositories[0].obligations,[]);
  const multiple=await namespaceSourceClauseFixture(t,{repositories:2}),m=(await multiple.inspect()).manifest;
  assert.equal(m.repositories.length,2);assert.equal(m.clauses.status,'pending-owner');
  assert.deepEqual(m.clauses.requiredPolicyOwners,['repository-qualified-claims']);assert.deepEqual(m.clauses.repositories,[]);
});
test('missing source archives and original bytes have explicit gaps without fabricating empty coverage',async t=>{
  const absent=await namespaceSourceClauseFixture(t,{retainChanges:false}),a=(await absent.inspect()).manifest;
  assert.equal(a.clauses.status,'missing-source-evidence');assert.equal(a.clauses.retentionRecord,null);assert.equal(a.clauses.plan.phase,'design');
  assert.ok(a.actions.some(row=>row.operation==='phase.source.retain'));
  const original=await namespaceSourceClauseFixture(t,{source:converterSource,baselineSource:converterSource,retainBaseline:false}),o=(await original.inspect()).manifest;
  assert.equal(o.clauses.status,'pending-owner');assert.deepEqual(o.clauses.requiredPolicyOwners,['source-baseline-bytes']);
  assert.equal(o.clauses.repositories[0].totals,null);assert.ok(o.actions.some(row=>row.operation==='source.baseline.retain'));
});
test('actual approved records and source bytes replay after the old laptop checkout is removed',async t=>{
  const f=await namespaceSourceClauseFixture(t),r=await reader(f),first=await r.clauses.inspect(r.snapshot,'build',r.found,r.original);
  await rm(f.root,{recursive:true,force:true});assert.deepEqual(await r.clauses.inspect(r.snapshot,'build',r.found,r.original),first);
  await assert.rejects(r.clauses.inspect(r.snapshot,'build',structuredClone(r.found),r.original),{code:'ENGINE_INPUT_INVALID'});
});
test('an approved label cannot replace the original human threshold and accepted review binding',async t=>{
  const f=await namespaceSourceClauseFixture(t),r=await reader(f);
  for(const mutate of [value=>{value.workflow.phases.design.approvals=[];},value=>{value.workflow.phases.intake.status='awaiting_approval';},
    value=>{value.workflow.phases.design.namespaceSubmission.record.sha256='a'.repeat(64);}]) {
    const snapshot=structuredClone(r.snapshot);mutate(snapshot);
    await assert.rejects(r.clauses.inspect(snapshot,'build',r.found,r.original),error=>
      ['ENGINE_STORAGE_CORRUPT','ENGINE_STORAGE_CONTENT_MISSING'].includes(error.code));
  }
});
test('bounded presentation retains full obligation counts and the final fresh source check remains mandatory',async t=>{
  const f=await namespaceSourceClauseFixture(t),zero=(await f.inspect({maximumEntries:0})).manifest;
  assert.equal(zero.clauses.repositories[0].obligations.length,0);assert.equal(zero.clauses.repositories[0].totals.required,2);assert.equal(zero.clauses.repositories[0].truncated,true);
  let calls=0;const unit=f.sources[0],moving={descriptor:unit.descriptor,async capture(options){const value=await unit.capture(options);
    if(++calls===1)await writeFile(path.join(f.root,'src/converter.js'),converterSource+'// moved\n');return value;}};
  await assert.rejects(f.make({sources:[moving]}).run('phase.delivery.inspect',{phaseId:'build'}),{code:'ENGINE_SOURCE_CHANGED'});
});
test('retained plan read errors and original byte deadlines remain the same errors; no human authority is invented',async t=>{
  const f=await namespaceSourceClauseFixture(t),r=await reader(f),first=await r.clauses.inspect(r.snapshot,'build',r.found,r.original);
  for(const reference of [first.plan.planned,r.found.body.repositories[0].manifest])for(const code of ['EACCES','ETIMEDOUT']) {
    const failure=Object.assign(Error('The actual retained dependency could not be read.'),{code,...(code==='ETIMEDOUT'?{timeoutMs:300000}:{})}),
      content={...f.content,read(scope,ref,options){if(ref.sha256===reference.sha256)throw failure;return f.content.read(scope,ref,options);}};
    await assert.rejects(f.make({content}).run('phase.delivery.inspect',{phaseId:'build'}),error=>error===failure);
  }
  f.control.permissions=f.control.permissions.filter(value=>value!=='phase.source.inspect');
  await assert.rejects(f.inspect(),{code:'ENGINE_AUTHORITY_REQUIRED'});
});
test('forged portable source-clause counts, paths, hashes and readiness fields cannot pass the manifest boundary',async t=>{
  const f=await namespaceSourceClauseFixture(t),m=(await f.inspect()).manifest,
    {schemaVersion,contract,actions,observationsOnly,publicationReadinessInspected,applicationAcceptanceEstablished,...facts}=m;
  const engine=value=>createEngine({ports:{phaseDeliveryInspection:{load:()=>({subject:{kind:'story',id:f.inputs.workId},phase:'build'}),inspect:()=>value}}});
  for(const mutate of [value=>{value.clauses.repositories[0].totals.bindings=0;},value=>{value.clauses.retentionRecord.sha256='a'.repeat(64);},
    value=>{value.clauses.repositories[0].obligations[0].bindings[0].path='../outside.js';},value=>{value.clauses.ready=true;},
    value=>{value.clauses.plan.approved=true;},value=>{value.clauses.repositories[0].obligations[0].clauseId='UNQUALIFIED';}]) {
    const value=structuredClone(facts);mutate(value);await assert.rejects(engine(value).run('phase.delivery.inspect'),error=>
      ['ENGINE_PORT_RESULT_INVALID','SGOS_SOURCE_CONTRACT_INVALID'].includes(error.code));
  }
});
