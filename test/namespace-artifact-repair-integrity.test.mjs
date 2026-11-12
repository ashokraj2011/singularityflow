import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {namespaceArtifactRepairFixture} from './helpers/namespace-artifact-repair-fixture.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceArtifactRepairReader} from '../src/engine-storage/namespace-artifact-repair-reader.mjs';
import {createNamespacePhaseEntryPorts} from '../src/engine-storage/namespace-phase-entry.mjs';
import {phaseEntryProtocol} from '../src/kernel/phase-entry.mjs';
import {createFilesystemNamespaceStore} from '../src/sda/filesystem-namespace-adapter.mjs';
import {openNativeSqliteDatabase} from '../src/sda/sqlite-native.mjs';
import {createSqliteContentStore} from '../src/sda/sqlite-content-adapter.mjs';
import {createNamespacePublicationReader} from '../src/engine-storage/namespace-publication-reader.mjs';
const reason='Review the exact retained member without changing the other delivered outputs.';
test('member scope has a closed entry protocol and authenticates original returns while preserving read failures',{timeout:120000},async t=>{
  const f=await namespaceArtifactRepairFixture(t);await f.start();f.asReviewer();const view=await f.engine.run('phase.review',{phaseId:'intake'}),
    request={phaseId:'intake',target:'intake',members:['notes.txt'],reason,confirm:view.manifest.reviewBinding.packetSha256};
  await f.engine.run('phase.reject',request);f.asAuthor();const state=await f.capture(),before=structuredClone(state),
    observer=createNamespaceStoryObserver(f.options),reader=createNamespaceArtifactRepairReader({observer,scope:f.scope,workId:f.workId}),
    altered=structuredClone(state);altered.workflow.changeRequests[0].comment='A copied return is not its original human decision.';
  await assert.rejects(reader.active(altered,'intake'),{code:'ENGINE_STORAGE_CORRUPT'});
  const port=createNamespacePhaseEntryPorts(f.options).phaseEntry,input={phaseId:'intake'},context=await port.load(input),protocol=phaseEntryProtocol(context),
    binding=protocol.selection(context,input),facts=await port.inspect(context,binding);
  assert.equal(protocol.inspection(binding,facts).facts.artifactRepairScope.generation,2);
  for(const mutate of [scope=>{scope.generation++;},scope=>{scope.predecessor.generation++;},scope=>{scope.members=['../outside.txt'];},
    scope=>{scope.members.push(scope.members[0]);},scope=>{scope.bundle.report={...scope.bundle.report,namespace:'local'};},
    scope=>{scope.references=scope.references.filter(ref=>ref.sha256!==scope.sourceRecord.sha256);}]){
    const invalid=structuredClone(facts);mutate(invalid.artifactRepairScope);assert.throws(()=>protocol.inspection(binding,invalid),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const legacyContext={...context,manifestProfile:'sflow-phase-entry-manifest/v2'},legacy=phaseEntryProtocol(legacyContext);
  assert.throws(()=>legacy.inspection(legacy.selection(legacyContext,input),facts),{code:'ENGINE_PORT_RESULT_INVALID'});
  const entry=await f.engine.run('phase.enter',input),resource=entry.manifest.resources.find(row=>row.reference.sha256===facts.artifactRepairScope.sourceRecord.sha256),
    read={workId:f.workId,phaseId:'intake',contextSha256:entry.manifest.context.sha256,resourceId:resource.id};
  assert.equal((await f.engine.run('phase.context.read',read)).reference.sha256,resource.reference.sha256);
  for(const failure of [Object.freeze(Object.assign(Error('The retained member-return store denied access.'),{code:'EACCES',path:'evidence.db'})),
    Object.freeze(Object.assign(Error('The original member-return read deadline expired.'),{code:'ETIMEDOUT',details:{deadlineMs:300000}}))]){
    const content={...f.content,read(scope,reference,options){if(reference.sha256===resource.reference.sha256)throw failure;return f.content.read(scope,reference,options);}};
    await assert.rejects(f.make({content}).run('phase.context.read',read),actual=>actual===failure);
  }
  assert.deepEqual(await f.capture(),before);await f.engine.run('phase.prepare',{phaseId:'intake'});
  await assert.rejects(f.engine.run('phase.context.read',read),{code:'ENGINE_CONTEXT_CHANGED'});
});
test('a later custom phase targets the earlier bundle and a new device reconstructs its successor from shared bytes',{timeout:180000},async t=>{
  const f=await namespaceArtifactRepairFixture(t,'sqlite',{configure(source){
    source.definition.inputsMode='enforce';source.definition.artifactSets.review={primary:'review.md',members:[{path:'review.md',role:'review',required:true}]};
    source.definition.phases.followup={...structuredClone(source.definition.phases.intake),label:'Custom review',artifactSet:'review',
      artifact:{path:'artifacts/followup/review.md'},inputs:[{phase:'intake'}]};
    source.definition.phases.followup.approval.rejectTo=['intake','followup'];source.definition.workTypes.simple.phases.push('followup');
    source.agents[0].phases.push('followup');source.agents[0].defaultFor.push('followup');}});
  await f.start();await f.review('intake');await f.author('followup');f.asReviewer();const view=await f.engine.run('phase.review',{phaseId:'followup'}),
    input={phaseId:'followup',target:'intake',members:['review.md'],reason,confirm:view.manifest.reviewBinding.packetSha256},before=await f.capture();
  await assert.rejects(f.engine.run('phase.reject',input),{code:'REJECT_MEMBER_UNKNOWN'});assert.deepEqual(await f.capture(),before);
  const alias='singularity/work-items/'+f.workId+'/artifacts/intake/extra/',returned=await f.engine.run('phase.reject',{...input,members:[alias]});
  assert.deepEqual(returned.changeRequest.members,[alias]);f.asAuthor();
  const directory=await mkdtemp(path.join(os.tmpdir(),'sflow-member-takeover-')),localBinding={kind:'machine-local',deviceId:'replacement-device'},
    records=await createFilesystemNamespaceStore({root:path.join(directory,'records'),binding:localBinding,create:true}),
    database=await openNativeSqliteDatabase(path.join(directory,'content.db')),content=createSqliteContentStore({database,binding:localBinding,create:true});
  t.after(async()=>{database.close();await rm(directory,{recursive:true,force:true,maxRetries:5});});
  const other=f.make({working:{records,content}});await other.run('phase.prepare',{phaseId:'intake'});
  const draft=await other.run('phase.draft.read',{phaseId:'intake'});assert.equal(draft.manifest.draft.generation,2);
  assert.equal((await other.run('phase.artifact.inspect',{phaseId:'intake'})).manifest.members.length,4);
  await other.run('phase.publish',{phaseId:'intake'});const snapshot=await f.capture(),reader=createNamespacePublicationReader({observer:createNamespaceStoryObserver(f.options),scope:f.scope,workId:f.workId}),
    publication=await reader.accepted(snapshot.workflow.phases.intake.publicationBindings.find(row=>row.generation===2),'intake'),bundle=reader.policies.artifactSetEvidence(publication);
  assert.deepEqual(bundle.report.repair.comparison.changed,[]);assert.deepEqual(bundle.report.repair.comparison.unchangedRequested,['extra/']);
  assert.equal(snapshot.workflow.phases.intake.surgicalReopen,undefined,'a consumed return cannot affect another generation');
  await other.run('phase.submit',{phaseId:'intake'});await f.review('intake');await f.author('followup');await f.review('followup');
  assert.equal((await f.capture()).workflow.status,'closed');
});
