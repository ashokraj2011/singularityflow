import test from 'node:test';import assert from 'node:assert/strict';
import {rm,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespacePublicationReader} from '../src/engine-storage/namespace-publication-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespaceLifecycleCommitter} from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import {canonicalJson,NAMESPACE_PHASE_POLICY_SCHEMAS} from '../src/foundation/record-schema.mjs';
const input={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
async function publication(f){const snapshot=await f.capture(),binding=snapshot.workflow.phases.build.publicationBindings[0],
  value=await f.json(binding.record),policy=value.policyEvidence.find(row=>row.kind==='code-delivery/v1'),manifest=await f.json(policy.record);
  return {snapshot,binding,value,policy,manifest,report:await f.json(manifest.report)};}
for(const backend of ['filesystem','sqlite','application'])test(backend+': actual Code source and exact test receipts publish, submit and receive independent approval',async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend}),starts=f.starts(),result=await f.engine.run('phase.publish',input),p=await publication(f);
  assert.equal(result.status,'published');assert.equal(p.value.schemaVersion,4);assert.equal(p.value.profile,'sflow-policy-publication/v1');
  assert.equal(p.manifest.format,'sflow-namespace-code-policy/v1');assert.equal(p.report.format,'sflow-namespace-code-policy-report/v1');
  assert.equal(p.report.repositories.length,1);assert.equal(p.report.repositories[0].id,'app');
  assert.equal(p.report.acceptance[0].clauseId,'STORY-1:AC-001');assert.equal(p.report.acceptance[0].result.status,'met');
  assert.equal(p.report.acceptance[0].result.assurance,'exact-local-observed');
  assert.equal(p.report.repositories[0].observed.repositoryId,'app');assert.equal(p.report.control.version,null);
  assert.equal(p.report.preflight.repositories[0].delivery.baselineCommit,null);assert.equal(f.starts(),starts,'publication reads actual checks without rerunning them');
  const repeated=createNamespaceEngine({...f.options,checks:f.checks,clock:{now(){throw Error('Do not restamp accepted Code.');}}});
  assert.equal((await repeated.run('phase.publish',input)).status,'retained');assert.equal(f.starts(),starts);
  const approval=await f.approve('build');assert.equal(approval.approval.selfApproval,false);
  assert.equal((await f.capture()).workflow.phases.build.status,'approved');
  if(backend==='filesystem'){
    const {manifest}=await f.engine.run('phase.review.resources',{phaseId:'build'}),resource=manifest.resources.find(row=>row.kind==='code-delivery');
    assert.ok(resource);assert.equal(resource.expected.sha256,p.manifest.report.sha256);
    assert.deepEqual(JSON.parse((await f.engine.run('document.read',{reference:resource.reference})).document.content.text),p.report);
  }
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const observer=createNamespaceStoryObserver(f.common),checks=createNamespacePhaseCheckReader({...f.common,observer}),
    reader=createNamespacePublicationReader({observer,scope:f.scope,workId:f.inputs.workId,checks});
  assert.deepEqual(await reader.accepted(p.binding,'build'),p.value,'original accepted evidence replays with no private draft or source-unit reader');
  const shared=createNamespaceEngine({...f.common,clock:{now(){throw Error('Original publication must not allocate time.');}}});
  assert.equal((await shared.run('phase.publish',input)).status,'retained');assert.equal(f.starts(),starts);
});
test('a passing unstructured count report cannot discharge a planned acceptance witness',async t=>{
  const f=await namespaceTestWitnessFixture(t,{reporter:false}),before=await f.head();
  await assert.rejects(f.engine.run('phase.publish',input),error=>error.code==='CODE_TEST_WITNESS_INCOMPLETE'&&error.details.reasons.includes('NO_OCCURRENCE'));
  assert.deepEqual(await f.head(),before);assert.equal((await f.capture()).workflow.phases.build.generation,0);
});
test('tests run on a different retained source cannot publish this Code candidate',async t=>{
  const f=await namespaceTestWitnessFixture(t),before=await f.head(),original=await readFile(path.join(f.root,'src/converter.js'));
  await writeFile(path.join(f.root,'src/converter.js'),'// @clause:STORY-1:REQ-001 Convert the accepted value.\n// @clause:STORY-1:AC-001 The approved example remains FF.\nexport const convert=value=>value.toString(16).toUpperCase();\n');
  await f.engine.run('phase.source.retain',{operationId:'later-code-source',workId:f.inputs.workId,phaseId:'build'});
  await assert.rejects(f.engine.run('phase.publish',input),{code:'ENGINE_SOURCE_CHANGED'});assert.deepEqual(await f.head(),before);
  await writeFile(path.join(f.root,'src/converter.js'),original);
  await assert.rejects(f.engine.run('phase.publish',input),{code:'ENGINE_CODE_CHECK_SOURCE_MISMATCH'});assert.deepEqual(await f.head(),before);
});
test('Code policy reports replay rather than trusting revised verdicts, schemas, copied proofs or missing read fences',async t=>{
  const f=await namespaceTestWitnessFixture(t);await f.engine.run('phase.publish',input);const p=await publication(f),before=await f.head(),
    observer=createNamespaceStoryObserver(f.common),checks=createNamespacePhaseCheckReader({...f.common,observer}),
    reader=createNamespacePublicationReader({observer,checks,scope:f.scope,workId:f.inputs.workId}),
    save=async value=>(await f.content.put(f.scope,'evidence',Buffer.from(canonicalJson(value)))).reference,
    changed=structuredClone(p.report);
  changed.repositories[0].observed.claims['STORY-1:REQ-001'].paths=['src/other.js'];
  for(const [report,code]of [[changed,'ENGINE_STORAGE_CORRUPT'],[{...p.report,preflight:{}},'ENGINE_STORAGE_CORRUPT'],
    [{...p.report,schemaVersion:NAMESPACE_PHASE_POLICY_SCHEMAS.codeReport.maximumReadableVersion+1},'ENGINE_STORAGE_UNSUPPORTED'],
    [{...p.report,schemaVersion:8},'ENGINE_STORAGE_CORRUPT'],[{...p.report,schemaVersion:7},'ENGINE_STORAGE_CORRUPT'],
    [{...p.report,schemaVersion:3},'ENGINE_STORAGE_CORRUPT'],[{...p.report,ready:true},'ENGINE_STORAGE_CORRUPT']]){
    const manifest={...p.manifest,report:await save(report)},policy={...p.policy,record:await save(manifest)},
      value={...p.value,policyEvidence:[policy]},binding={...p.binding,record:await save(value)};
    await assert.rejects(reader.read(binding,'build'),{code});
  }
  const verified=await reader.accepted(p.binding,'build'),plan=await createNamespaceLifecycleCommitter(f.common).intent(p.value.operationId),
    fences=reader.policies.readBindings(verified);
  assert.equal(fences.length,5);assert.ok(fences.some(row=>row.namespace==='evidence'&&row.key===p.report.control.key&&row.version===null));
  for(const fence of fences)assert.throws(()=>reader.verifyPlan(verified,{...plan,readBindings:plan.readBindings.filter(row=>canonicalJson(row)!==canonicalJson(fence))}),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.deepEqual(reader.policies.owners({...verified}),[],'a copied body has no private verification authority');assert.deepEqual(await f.head(),before);
  const denied=Object.assign(Error('Original retained source chunk access denied.'),{code:'EACCES'}),
    source=await f.json(p.report.preflight.source.result.content),repository=await f.json(source.repositories[0].manifest),chunk=repository.entries.find(row=>row.newPath==='src/converter.js').chunks[0],
    guarded=createNamespaceStoryObserver({...f.common,content:{...f.content,read(scope,reference,options){if(reference.sha256===chunk.sha256)throw denied;return f.content.read(scope,reference,options);}}}),
    guardedChecks=createNamespacePhaseCheckReader({...f.common,observer:guarded}),
    refused=createNamespacePublicationReader({observer:guarded,checks:guardedChecks,scope:f.scope,workId:f.inputs.workId});
  await assert.rejects(refused.accepted(p.binding,'build'),error=>error===denied);assert.deepEqual(await f.head(),before);
});
test('repository-qualified Code claims and exact tests retain separate application proofs',async t=>{
  const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
    .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n',
    f=await namespaceTestWitnessFixture(t,{repositories:2,plan});await f.engine.run('phase.publish',input);const p=await publication(f);
  assert.deepEqual(p.report.repositories.map(row=>row.id),['app','service-1']);assert.deepEqual(p.report.acceptance.map(row=>row.repositoryId).sort(),['app','service-1']);
  for(const row of p.report.repositories){assert.equal(row.observed.repositoryId,row.id);assert.equal(row.witnesses[0].result.status,'met');
    assert.ok(row.checkRevision);assert.ok(row.observed.claims['STORY-1:REQ-001']);}
  assert.ok(p.report.preflight.plan.repositoryPlan);assert.equal((await f.approve('build')).approval.selfApproval,false);
});
