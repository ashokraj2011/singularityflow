/** An upstream owner's real return is one conditional operation, including before the current phase publishes. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': authenticated upstream return preserves drafts and resolves one genuine repair request',{timeout:120000},async t=>{
  const f=await namespaceEngineFixture(t,{backend,configure(source){
    source.definition.phases.followup={...structuredClone(source.definition.phases.intake),label:'Followup',artifact:{path:'artifacts/followup/report.md'}};
    source.definition.workTypes.simple.phases=['intake','followup'];source.agents[0].phases.push('followup');source.agents[0].defaultFor.push('followup');
  }});f.control.permissions.push('upstream.raise','upstream.decide','upstream.list');
  await f.bootstrap();await f.author();await f.review();f.asAuthor();
  await f.engine.run('phase.prepare',{phaseId:'followup'});const privateBefore=await f.engine.run('phase.draft.read',{phaseId:'followup'});
  const raised=await f.engine.run('upstream.raise',{operationId:'raise-upstream-return',workId:f.workId,phaseId:'intake',about:'operational consequence',
    problem:'The approved document omits the required operational consequence.',proposed:'return',authored:'human'});
  assert.equal(raised.records[0].id,'UPI-001');f.asReviewer();
  const input={operationId:'return-exact-upstream-owner',workId:f.workId,issueId:'UPI-001',outcome:'return',reason:'Correct the original document before relying on it in the followup.'},before=await f.capture();
  const denied=Object.assign(Error('The original producer cannot be read.'),{code:'EACCES',path:'producer-publication'}),
    publication=before.workflow.phases.intake.publicationBindings[0].record,
    unavailable=createNamespaceEngine({...f.options,content:{...f.content,read(scope,reference,options){
      if(reference.sha256===publication.sha256)throw denied;return f.content.read(scope,reference,options);}}});
  await assert.rejects(unavailable.run('upstream.decide',input),error=>error===denied);
  assert.deepEqual(await f.capture(),before);
  const returned=await f.engine.run('upstream.decide',input),after=await f.capture();
  assert.equal(returned.currentPhase,'intake');assert.equal(returned.records[0].changeRequest.targetPhase,'intake');
  assert.equal(after.workflow.changeRequests.length,1);assert.equal(after.workflow.upstreamIssueDecisions.length,1);
  assert.equal(after.workflow.changeRequests[0].sourceGeneration,0);assert.equal(after.workflow.changeRequests[0].reviewPacketSha256,null);
  assert.equal(after.workflow.changeRequests[0].profile,'sflow-namespace-upstream-return/v1');
  assert.deepEqual(after.workflow.phases.intake.publicationBindings,before.workflow.phases.intake.publicationBindings);
  assert.equal((await f.engine.run('upstream.list',{open:true})).issues.length,0);
  assert.deepEqual(await f.make({working:null,clock:{now(){throw Error('Preserve the actual original return time.');}}}).run('upstream.decide',input),returned);
  await assert.rejects(f.engine.run('upstream.decide',{...input,operationId:'cannot-return-twice'}),{code:'UPSTREAM_ISSUE_DECIDED'});
  f.asAuthor();await f.author();await f.review();f.asAuthor();
  assert.equal((await f.capture()).workflow.changeRequests[0].status,'resolved');
  const preserved=await f.engine.run('phase.draft.read',{phaseId:'followup'});assert.equal(preserved.manifest.draft.bodySha256,privateBefore.manifest.draft.bodySha256);
  await f.author('followup');await f.review('followup');assert.equal((await f.capture()).workflow.status,'closed');
});
