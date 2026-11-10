import test from 'node:test';import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {namespaceSpecificationFixture,specificationText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {namespaceCandidateContent} from '../src/engine-storage/namespace-candidate-content.mjs';
const permissions=['phase.prepublish','phase.draft-check','story.status','story.guide','story.next'];
const cannotWrite=()=>{throw Error('A diagnostic read must not stage bytes, receipts or private progress.');};
function readOnly(f){return f.make({records:{...f.records,transact:cannotWrite},content:{...f.content,put:cannotWrite},
  working:{records:{...f.local.records,transact:cannotWrite},content:{...f.local.content,put:cannotWrite}}});}
test('a missing standalone decision owner cannot fall through to routing or read another context',async t=>{
  const f=await namespaceEngineFixture(t,{working:false}),engine=f.make({records:{...f.records,read:cannotWrite,transact:cannotWrite},content:{...f.content,read:cannotWrite,put:cannotWrite}}),
    implemented=new Set(['decision.scope','decision.completeness','decision.applicability','decision.plan','plan.correction.record','decision.choose','decision.witness']);
  for(const operation of ENGINE_OPERATIONS.filter(row=>row.port==='decisionRecord'&&!implemented.has(row.id)))await assert.rejects(
    engine.run(operation.id,{workId:f.workId}),error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.operation===operation.id);
});
for(const backend of ['filesystem','sqlite','application'])test(backend+': next steps and draft/prepublish inspection reach a real result without writing',async t=>{
  const f=await namespaceEngineFixture(t,{backend});f.control.permissions.push(...permissions);await f.bootstrap();
  let engine=readOnly(f),before=await f.capture(),next=await engine.run('story.next',{});
  assert.equal(next.manifest.actions.find(row=>row.operation?.id==='phase.prepare').phaseId,'intake');
  assert.equal((await engine.run('story.status',{})).manifest.currentPhase,'intake');
  assert.equal((await engine.run('story.guide',{})).effects.committed,false);
  const absent=await engine.run('phase.prepublish',{});assert.equal(absent.status,'correction-required');
  assert.ok(absent.manifest.findings.some(row=>row.code==='artifact.required.missing'));
  assert.deepEqual(await f.capture(),before);
  await f.engine.run('phase.prepare',{phaseId:'intake'});const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  const incomplete=await engine.run('phase.draft-check',{phaseId:'intake'});
  assert.equal(incomplete.status,'correction-required');assert.ok(incomplete.manifest.findings.length>0);
  const body=(await f.local.content.put(f.scope,'local',Buffer.from('# Reviewed result\n\nThe original request has an observable, complete result.\n'))).reference;
  await f.engine.run('phase.draft.write',{operationId:'complete-readable-draft',workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:body,reason:'Complete the actual phase draft.'});
  before=await f.capture();f.asReviewer();next=await engine.run('story.next',{});
  assert.ok(next.manifest.actions.some(row=>row.operation?.id==='phase.prepublish'));
  for(const operation of ['phase.draft-check','phase.prepublish']){
    const result=await engine.run(operation,{phaseId:'intake'});assert.equal(result.status,'ready');
    assert.equal(result.effects.committed,false);assert.equal(result.effects.testsRun,false);assert.equal(result.manifest.mutationAuthorityGranted,false);
    assert.equal(result.manifest.finalBindingChecked,false);
  }
  assert.deepEqual(await f.capture(),before);f.asAuthor();
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  const shared=f.make({working:null}),published=await shared.run('phase.prepublish',{phaseId:'intake'});
  assert.equal(published.manifest.inspectionStage,'published');assert.equal(published.manifest.readiness.publicationTransaction,'already-published');
  assert.ok((await shared.run('story.next',{})).manifest.actions.some(row=>row.operation?.id==='phase.submit'));
});
test('draft inspection preserves original local errors and detects moved permission and draft bindings',async t=>{
  const f=await namespaceEngineFixture(t);f.control.permissions.push(...permissions);await f.bootstrap();await f.engine.run('phase.prepare',{phaseId:'intake'});
  const missing=Object.freeze(Object.assign(Error('Actual private content access failed.'),{code:'EACCES',path:'/private/fixture-content'}));
  const denied=f.make({working:{records:f.local.records,content:{...f.local.content,read(){throw missing;}}}});
  await assert.rejects(denied.run('phase.prepublish',{phaseId:'intake'}),error=>error===missing);
  let calls=0;f.control.engineHook=(_count,request)=>{if(request.operation==='phase.prepublish'&&++calls===2)f.control.permissions=f.control.permissions.filter(value=>value!=='phase.prepublish');};
  await assert.rejects(f.engine.run('phase.prepublish',{phaseId:'intake'}),{code:'ENGINE_AUTHORITY_REQUIRED'});
  f.control.permissions.push('phase.prepublish');f.control.engineHook=()=>{};
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});calls=0;
  f.control.engineHook=async(_count,request)=>{if(request.operation==='phase.prepublish'&&++calls===3){
    f.control.engineHook=()=>{};const body=(await f.local.content.put(f.scope,'local',Buffer.from('# Concurrent reviewed result\n\nA different current body.\n'))).reference;
    await f.engine.run('phase.draft.write',{operationId:'another-author-write',workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
      content:body,reason:'A real concurrent author completed the draft during inspection.'});
  }};
  await assert.rejects(f.engine.run('phase.prepublish',{phaseId:'intake'}),{code:'ENGINE_CONTEXT_CHANGED'});
});
test('Code inspection uses actual retained source and tests, then refuses a changed checkout without publishing',async t=>{
  const f=await namespaceTestWitnessFixture(t);f.control.permissions.push(...permissions);
  const before=await f.capture(),result=await f.engine.run('phase.prepublish',{phaseId:'build'});
  assert.equal(result.status,'ready');assert.deepEqual(await f.capture(),before);assert.equal(result.effects.testsRun,false);
  await writeFile(path.join(f.root,'src/converter.js'),'export const changed = true;\n');
  await assert.rejects(f.engine.run('phase.prepublish',{phaseId:'build'}),{code:'ENGINE_SOURCE_CHANGED'});assert.deepEqual(await f.capture(),before);
});
test('candidate artifact bytes are exact and never redirect accepted evidence reads',async()=>{
  const data=Buffer.from('actual'),reference={namespace:'evidence',sha256:'0'.repeat(64),bytes:data.byteLength};
  let reads=0;const failure=Object.freeze(Object.assign(Error('Original shared content unavailable.'),{code:'ETIMEDOUT'})),observer={bytes(){reads++;throw failure;}};
  await assert.rejects(namespaceCandidateContent(observer,reference,{artifactBytes:data}),{code:'ENGINE_INPUT_INVALID'});assert.equal(reads,0);
  await assert.rejects(namespaceCandidateContent(observer,reference),error=>error===failure);assert.equal(reads,1);
});
test('specification inspection recomputes real clarification and quality rules from private bytes without exporting them',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:source=>{
    source.definition.phases.intake.specificationQuality.mode='enforce';source.definition.phases.intake.clarification.mode='required';
  }});f.control.permissions.push('phase.prepublish','phase.draft-check','clarification.record');
  const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent}});
  await engine.run('phase.prepare',{phaseId:'intake'});let draft=await engine.run('phase.draft.read',{phaseId:'intake'});
  await engine.run('phase.draft.write',{operationId:'inspect-incomplete-spec',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(specificationText),reason:'Inspect the actual incomplete authored specification.'});
  const missing=await engine.run('phase.prepublish',{phaseId:'intake'});assert.equal(missing.status,'correction-required');
  assert.ok(missing.manifest.findings.some(row=>row.code==='CLARIFICATION_REQUIRED'));
  const checkpoint=await engine.run('clarification.status',{phaseId:'intake'});
  await engine.run('clarification.record',{operationId:'real-inspected-answer',workId:f.inputs.workId,phaseId:'intake',contextSha256:checkpoint.context.sha256,
    responses:[{question:'What should it display?',answer:'Display uppercase hexadecimal for non-negative integer inputs.'}]});
  const incomplete=await engine.run('phase.prepublish',{phaseId:'intake'});assert.equal(incomplete.status,'correction-required');
  assert.ok(incomplete.manifest.findings.some(row=>row.message.includes('Actors')||row.message.includes('scenarios')));
  draft=await engine.run('phase.draft.read',{phaseId:'intake'});
  const text=specificationText.replace('## Requirements','## Actors\n\nCalculator user.\n\n## User scenarios\n\n### S1 — Convert a value\n\nGiven input 255, When conversion is requested, Then the result is FF.\n\n## Requirements');
  const reference=await f.upload(text);await engine.run('phase.draft.write',{operationId:'inspect-complete-spec',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:draft.manifest.draft.revision,content:reference,reason:'Complete the real scenario and actor requirements.'});
  const readOnly=createNamespaceEngine({...f.common,records:{...f.records,transact:cannotWrite},content:{...f.content,put:cannotWrite},
    working:{records:{...f.localRecords,transact:cannotWrite},content:{...f.localContent,put:cannotWrite}}});
  assert.equal((await readOnly.run('phase.prepublish',{phaseId:'intake'})).status,'ready');
  const shared={...reference,namespace:'evidence'};assert.equal((await f.content.read(f.scope,shared)).status,'missing');
});
