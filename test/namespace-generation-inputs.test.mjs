/** The same private draft is shared by begin, prepare and input preparation, with no Git-shaped facts. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {phaseInputsManifest} from '../src/kernel/phase-inputs.mjs';
const cannotWrite=()=>{throw Error('An input preview cannot write content or progress.');};
for(const backend of ['filesystem','sqlite','application'])test(backend+': input preview and generation begin share a real private boundary',{timeout:120000},async t=>{
  const f=await namespaceEngineFixture(t,{backend,configure(source){
    source.definition.inputsMode='enforce';source.definition.phases.followup={...structuredClone(source.definition.phases.intake),label:'Followup',
      artifact:{path:'artifacts/followup/report.md'},inputs:[{phase:'intake'}]};
    source.definition.workTypes.simple.phases=['intake','followup'];source.agents[0].phases.push('followup');source.agents[0].defaultFor.push('followup');
  }});f.control.permissions.push('phase.begin','phase.inputs');await f.bootstrap();const before=await f.capture();
  const preview=f.make({content:{...f.content,put:cannotWrite},records:{...f.records,transact:cannotWrite},working:{
    records:{...f.local.records,transact:cannotWrite},content:{...f.local.content,put:cannotWrite}}});
  const observed=await preview.run('phase.inputs',{phaseId:'intake',dryRun:true});
  assert.equal(observed.status,'inspected');assert.equal(observed.manifest.schemaVersion,2);assert.equal(observed.manifest.context,null);
  assert.equal((await f.engine.run('phase.draft.read',{phaseId:'intake'})).manifest.status,'missing');assert.deepEqual(await f.capture(),before);
  f.control.permissions=f.control.permissions.filter(value=>value!=='phase.prepare');
  const begun=await f.engine.run('phase.begin',{phaseId:'intake'});assert.equal(begun.status,'begun');assert.equal(begun.intent.profile,'sflow-namespace-generation-intent/v1');
  assert.equal(begun.intent.baselineRevision,before.revision);assert.equal(Object.hasOwn(begun.intent,'baselineCommit'),false);
  const retained=await f.engine.run('phase.begin',{phaseId:'intake'});assert.equal(retained.status,'retained');assert.deepEqual(retained.intent,begun.intent);
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'}),body=(await f.local.content.put(f.scope,'local',Buffer.from('# Actual result\n\nThe author completed this intake.\n'))).reference;
  await f.engine.run('phase.draft.write',{operationId:'authored-after-begin',workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,content:body,
    reason:'Complete the actual prepared result.'});
  assert.deepEqual((await f.engine.run('phase.begin',{phaseId:'intake'})).intent,begun.intent);f.control.permissions.push('phase.prepare');
  await f.author('intake');await f.review('intake');f.asAuthor();const snapshot=await f.capture(),input=await f.engine.run('phase.inputs',{phaseId:'followup'});
  assert.equal(input.status,'prepared');assert.equal(input.effects.inputAuditRecorded,true);assert.equal(input.manifest.auditRecorded,true);
  const producer=input.manifest.resources.find(row=>row.kind==='approved-input');assert.equal(producer.phase,'intake');assert.equal(producer.generation,1);
  const content=await f.local.content.read(f.scope,input.manifest.context);assert.equal(content.status,'present');
  assert.deepEqual(JSON.parse(Buffer.from(content.data).toString()).resources,input.manifest.resources);assert.deepEqual(await f.capture(),snapshot);
});
test('Code begin retains the real source generation and native read errors remain exact',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t);f.control.permissions.push('phase.begin','phase.inputs');
  const result=await f.engine.run('phase.begin',{phaseId:'build'}),draft=await f.engine.run('phase.draft.read',{phaseId:'build'});
  assert.equal(result.status,'retained');assert.match(result.intent.id,/^generation-/u);assert.equal(result.intent.sha256,result.intent.id.replace('generation-','sha256:'));
  assert.equal(draft.manifest.draft.generation,result.generation);const denied=Object.freeze(Object.assign(Error('Original private audit could not be read.'),{code:'EACCES'}));
  await assert.rejects(f.make({working:{records:f.localRecords,content:{...f.localContent,read(){throw denied;}}}}).run('phase.inputs',{phaseId:'build'}),error=>error===denied);
});
test('portable input facts cannot claim a ready view using malformed content or resource references',()=>{
  const binding={workId:'story',phase:'phase',generation:1,dryRun:true,auditRequired:false},facts={profile:'sflow-namespace-phase-inputs/v1',
    workId:'story',phase:'phase',generation:1,dryRun:true,mode:'off',artifact:null,context:null,resources:[],auditRecorded:false,generationOpened:false};
  assert.equal(phaseInputsManifest(binding,facts).schemaVersion,2);
  for(const resource of [null,{kind:'agent',id:'agent',reference:{namespace:'local',sha256:'wrong',bytes:1}},
    {kind:'approved-input',reference:{namespace:'evidence',sha256:'a'.repeat(64),bytes:1},phase:'source',generation:0},
    {kind:'agent',id:'agent',reference:{namespace:'config',sha256:'a'.repeat(64),bytes:1},body:'A body is not a read manifest.'}]){
    assert.throws(()=>phaseInputsManifest(binding,{...facts,resources:[resource]}),{code:'ENGINE_PORT_RESULT_INVALID'});}
  assert.throws(()=>phaseInputsManifest(binding,{...facts,auditRecorded:true}),{code:'ENGINE_PORT_RESULT_INVALID'});
});
