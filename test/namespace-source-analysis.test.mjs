/** Retained byte analysis is observable through the registry, never a publication or execution grant. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {namespaceDeliveryInspectionFixture} from './helpers/namespace-delivery-inspection-fixture.mjs';
import {createNamespaceSourceRetentionReader} from '../src/engine-storage/namespace-source-retention-reader.mjs';
import {createNamespaceSourceAnalysisReader} from '../src/engine-storage/namespace-source-analysis.mjs';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {DELIVERY_INSPECTION_PROFILE_V2,DELIVERY_INSPECTION_PROFILE_V3,SOURCE_ANALYSIS_PROFILE} from '../src/kernel/source-changes.mjs';
const app="// @clause:STORY-1:REQ-001 Computes the approved result from the selected value.\nexport const answer=42;\n";
const tests="import test from 'node:test';import assert from 'node:assert/strict';import {answer} from './app.mjs';\n// @ac:STORY-1:AC-001\ntest('retained behavior',()=>assert.equal(answer,42));\n";
async function source(t,backend='filesystem') {
  const f=await namespaceDeliveryInspectionFixture(t,{backend});await writeFile(path.join(f.root,'app.mjs'),app);
  await writeFile(path.join(f.root,'case.test.mjs'),tests);await f.retain();return f;
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': registry inspection reports actual retained source tags and exact test declarations without executing again',async t=>{
  const f=await source(t,backend);await f.run();const before=await f.head(),starts=f.control.starts,clocks=f.accessControl.clockCalls;
  const result=await f.inspect(),m=result.manifest,analysis=m.analysis;
  assert.equal(m.schemaVersion,3);assert.equal(m.contract,DELIVERY_INSPECTION_PROFILE_V3);assert.equal(analysis.profile,SOURCE_ANALYSIS_PROFILE);
  assert.deepEqual(analysis.retentionRecord,m.evidence.changes.record.content);assert.equal(analysis.totals.files,2);
  assert.equal(analysis.totals.tags,2);assert.equal(analysis.totals.declarations,1);assert.equal(analysis.totals.gaps,0);
  const product=analysis.files.find(file=>file.path==='app.mjs'),testFile=analysis.files.find(file=>file.path==='case.test.mjs');
  assert.equal(product.source.sha256,createHash('sha256').update(app).digest('hex'));
  assert.deepEqual(product.tags.map(tag=>tag.clauseId),['STORY-1:REQ-001']);assert.deepEqual(testFile.declarations[0].clauseIds,['STORY-1:AC-001']);
  assert.match(testFile.declarations[0].logicalTestId,/^sha256:[a-f0-9]{64}$/u);assert.equal(testFile.declarations[0].line,3);
  assert.equal(result.effects.testsRun,false);assert.equal(m.applicationAcceptanceEstablished,false);assert.equal(m.publicationReadinessInspected,false);
  assert.equal(f.control.starts,starts);assert.equal(f.accessControl.clockCalls,clocks);assert.deepEqual(await f.head(),before);
});
test('the same actual accepted bytes can be analyzed after the original checkout is gone',async t=>{
  const f=await source(t),retention=createNamespaceSourceRetentionReader(f.options),found=await retention.accepted({operationId:'delivery-changes',workId:f.inputs.workId,phaseId:'intake'});
  const reader=createNamespaceSourceAnalysisReader({observer:retention.observer,retention}),first=await reader.analyze(found);
  await rm(f.root,{recursive:true,force:true});assert.deepEqual(await reader.analyze(found),first);
  await assert.rejects(reader.analyze(structuredClone(found)),{code:'ENGINE_INPUT_INVALID'});
  found.body.repositories[0].id='forged';await assert.rejects(reader.analyze(found),{code:'ENGINE_INPUT_INVALID'});
});
test('syntax gaps, binary source and configuration roles remain separate observations',async t=>{
  const f=await namespaceDeliveryInspectionFixture(t);await writeFile(path.join(f.root,'app.mjs'),Buffer.from([0,255,1]));
  await writeFile(path.join(f.root,'settings.yaml'),'enabled: true\n');
  await writeFile(path.join(f.root,'case.test.mjs'),"import test from 'node:test';\n// @ac:STORY-1:AC-001\ntest(title,()=>{});\n");
  await f.retain();const m=(await f.inspect()).manifest;
  assert.equal(m.analysis.files.find(file=>file.path==='app.mjs').kind,'binary');
  assert.equal(m.analysis.files.find(file=>file.path==='settings.yaml').role,'runtime-configuration');
  assert.ok(m.analysis.totals.gaps>0);assert.ok(m.analysis.files.find(file=>file.path==='case.test.mjs').gaps.some(gap=>gap.code==='DYNAMIC_TITLE'));
  assert.equal(m.tests.status,'missing');assert.equal(m.requiredPolicyOwners.includes('code-delivery'),true);
});
test('all qualified clause kinds retain their exact source associations',async t=>{
  const f=await namespaceDeliveryInspectionFixture(t),ids=['REQ','BEH','IFC','CON'].map(kind=>'STORY-1:'+kind+'-001');
  await writeFile(path.join(f.root,'app.mjs'),ids.map(id=>'// @clause:'+id+' Applies the specified behavior.').join('\n')+'\nexport const answer=42;\n');
  await f.retain();const m=(await f.inspect()).manifest;
  assert.deepEqual(m.analysis.files.find(file=>file.path==='app.mjs').tags.map(tag=>tag.clauseId),ids);
});
test('zero presentation budget does not pretend that the real source analysis was empty',async t=>{
  const f=await source(t),m=(await f.reader.run('phase.delivery.inspect',{phaseId:'intake',maximumEntries:0})).manifest;
  assert.equal(m.analysis.files.length,0);assert.equal(m.analysis.truncated,true);assert.equal(m.analysis.totals.tags,2);assert.equal(m.analysis.totals.declarations,1);
});
test('a suite tag remains an explicit association gap rather than a fabricated test identity',async t=>{
  const f=await namespaceDeliveryInspectionFixture(t);await writeFile(path.join(f.root,'case.test.mjs'),
    "import {describe,it} from 'node:test';\n// @ac:STORY-1:AC-001\ndescribe('group',()=>{it('actual',()=>{});});\n");
  await f.retain();const m=(await f.inspect()).manifest,file=m.analysis.files.find(value=>value.path==='case.test.mjs');
  assert.equal(file.declarations.length,1);assert.deepEqual(file.declarations[0].clauseIds,[]);
  assert.ok(file.gaps.some(value=>value.code==='AC_TAG_ON_SUITE'));assert.equal(m.applicationAcceptanceEstablished,false);
});
test('actual retained-byte permission errors, deadlines and cancellation preserve their identity',async t=>{
  const f=await source(t),retention=createNamespaceSourceRetentionReader(f.options),found=await retention.accepted({operationId:'delivery-changes',workId:f.inputs.workId,phaseId:'intake'});
  for(const failure of [Object.assign(Error('Original read denied.'),{code:'EACCES'}),Object.assign(Error('Original storage deadline.'),{code:'ETIMEDOUT',timeoutMs:300000})]){
    const reader=createNamespaceSourceAnalysisReader({retention,observer:{bytes(){throw failure;}}});
    await assert.rejects(reader.analyze(found),error=>error===failure);
  }
  const controller=new AbortController();controller.abort();const reader=createNamespaceSourceAnalysisReader({retention,observer:retention.observer});
  await assert.rejects(reader.analyze(found,{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
});
test('v1 inspection facts remain readable, and unknown or forged v2 analysis cannot claim success',async t=>{
  const f=await source(t),m=(await f.inspect()).manifest;
  const {schemaVersion,contract,actions,observationsOnly,publicationReadinessInspected,applicationAcceptanceEstablished,...facts}=m;
  const engine=value=>createEngine({ports:{phaseDeliveryInspection:{load:()=>({subject:{kind:'story',id:f.inputs.workId},phase:'intake'}),inspect:()=>value}}});
  const {profile,analysis,clauses,...old}=facts;const legacy=await engine(old).run('phase.delivery.inspect',{phaseId:'intake'});
  assert.equal(legacy.manifest.schemaVersion,1);assert.equal(legacy.manifest.contract,'sflow-delivery-evidence-inspection/v1');
  assert.deepEqual(legacy.manifest.actions,m.actions);
  const v2=await engine({...old,profile:DELIVERY_INSPECTION_PROFILE_V2,analysis}).run('phase.delivery.inspect',{phaseId:'intake'});
  assert.equal(v2.manifest.schemaVersion,2);assert.deepEqual(v2.manifest.analysis,analysis);assert.deepEqual(v2.manifest.actions,m.actions);
  await assert.rejects(engine({...facts,profile:'sflow-delivery-evidence-inspection/v99'}).run('phase.delivery.inspect'),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  for(const change of [value=>{value.analysis.totals.tags=0;},value=>{value.analysis.retentionRecord.sha256='a'.repeat(64);},
    value=>{value.analysis.files[0].kind='removed';},value=>{value.analysis.ready=true;},value=>{value.analysis.files[0].tags[0].clauseId='UNQUALIFIED';}]){
    const invalid=structuredClone(facts);change(invalid);await assert.rejects(engine(invalid).run('phase.delivery.inspect'),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
});
