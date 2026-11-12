import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceArtifactRepairFixture} from './helpers/namespace-artifact-repair-fixture.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePublicationReader} from '../src/engine-storage/namespace-publication-reader.mjs';
const reason='Correct the reviewed notes while preserving the other delivered output members.';
for(const backend of ['filesystem','sqlite','application'])test(backend+': exact member returns resume once, preserve the original bundle and disclose actual incidental changes',{timeout:180000},async t=>{
  const f=await namespaceArtifactRepairFixture(t,backend);await f.start();f.asReviewer();
  const view=await f.engine.run('phase.review',{phaseId:'intake'}),input={phaseId:'intake',target:'intake',members:['notes.txt'],reason,confirm:view.manifest.reviewBinding.packetSha256},before=await f.capture();
  for(const members of [['../outside.txt'],['other.txt'],['extra/absent.txt'],[]]){
    if(!members.length)continue;
    await assert.rejects(f.engine.run('phase.reject',{...input,members}));assert.deepEqual(await f.capture(),before);
  }
  const original=Object.freeze(Object.assign(Error('The application accepted the member return but its acknowledgement timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:300000}}));let lost=false;
  const records={...f.records,async transact(...args){const value=await f.records.transact(...args);
    if(!lost&&args[1].events.some(row=>row.payload?.operation==='phase.reject')){lost=true;throw original;}return value;}};
  await assert.rejects(f.make({records}).run('phase.reject',input),error=>error===original);assert.equal(lost,true);
  const returned=await f.make({clock:{now(){throw Error('An accepted return cannot be restamped.');}}}).run('phase.reject',input),state=await f.capture();
  assert.deepEqual(returned.changeRequest.members,['notes.txt']);assert.equal(state.workflow.namespaceHumanDecisionReceipts.length,1);
  const receipt=state.workflow.namespaceHumanDecisionReceipts[0],decision=JSON.parse(Buffer.from((await f.content.read(f.scope,receipt.record)).data));
  assert.equal(decision.schemaVersion,4);assert.equal(decision.source.artifactRepair.generation,1);
  f.asAuthor();const entry=await f.engine.run('phase.enter',{phaseId:'intake',compose:true});
  assert.equal(entry.manifest.contract,'sflow-phase-entry-manifest/v5');assert.deepEqual(entry.manifest.artifactRepairScope.members,['notes.txt']);
  assert.equal(entry.status,'preparation-required');assert.equal(entry.manifest.actions[0].operation,'phase.prepare');
  await f.engine.run('phase.prepare',{phaseId:'intake'});const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  assert.equal(draft.manifest.draft.generation,2);assert.match(draft.manifest.artifact.content.text,/This bundle records the observed request/);
  const seeded=await f.engine.run('phase.artifact.inspect',{phaseId:'intake'});assert.equal(seeded.manifest.members.length,4);
  const primary=await f.engine.run('phase.draft.read',{phaseId:'intake'});await f.engine.run('phase.prepare',{phaseId:'intake'});
  assert.equal((await f.engine.run('phase.draft.read',{phaseId:'intake'})).manifest.draft.revision,primary.manifest.draft.revision);
  await f.attach('notes.txt','Corrected actual notes.\n','attach-repaired-notes');await f.attach('stable.txt','An incidental but explicitly retained planning correction.\n','attach-incidental-stable');
  const prepublish=await f.engine.run('phase.prepublish',{phaseId:'intake'});assert.equal(prepublish.manifest.qualityDisposition,'ready');
  const published=await f.engine.run('phase.publish',{phaseId:'intake'});assert.equal(published.generation,2);
  const observer=createNamespaceStoryObserver(f.options),reader=createNamespacePublicationReader({observer,scope:f.scope,workId:f.workId}),
    snapshot=await f.capture(),binding=snapshot.workflow.phases.intake.publicationBindings.find(row=>row.generation===2),
    publication=await reader.accepted(binding,'intake'),bundle=reader.policies.artifactSetEvidence(publication);
  assert.equal(bundle.report.schemaVersion,2);assert.equal(bundle.report.repair.changeRequestId,returned.changeRequest.id);
  assert.deepEqual(bundle.report.repair.comparison.changed.map(row=>row.path),['notes.txt','stable.txt']);
  assert.deepEqual(bundle.report.repair.comparison.incidental.map(row=>row.path),['stable.txt']);
  assert.ok(bundle.report.repair.comparison.preserved.some(row=>row.path==='extra/'));
  assert.ok(reader.policies.evidence(publication).some(row=>row.sha256===receipt.record.sha256));
  await f.engine.run('phase.submit',{phaseId:'intake'});await f.review('intake');
  const closed=await f.capture();assert.equal(closed.workflow.status,'closed');assert.equal(closed.workflow.phases.intake.generation,2);
  const replay=await f.make({working:null,clock:{now(){throw Error('Shared bundle replay cannot restamp its delivery.');}}}).run('phase.publish',{phaseId:'intake'});
  assert.equal(replay.status,'retained');assert.equal(replay.generation,2);assert.deepEqual(await f.capture(),closed);
});
