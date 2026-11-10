import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceSpecificationFixture,specificationText,planText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {namespaceSourceReviewFixture as fixture,namespaceSourceReviewReport as report} from './helpers/namespace-source-review-fixture.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': submission retains a genuine independent source review and shared-only replay',{timeout:120000},async t=>{
  const f=await fixture(t,backend),before=await f.capture();
  await assert.rejects(f.engine.run('phase.submit',{phaseId:'intake'}),error=>error.code==='SOURCE_REVIEW_NOT_READY'&&error.details.actions[0].operation==='source-review.context');
  assert.deepEqual(await f.capture(),before);
  const view=await f.engine.run('source-review.context',{phaseId:'intake'}),candidate=report(view.manifest),input={operationId:'review-published-source',workId:f.workId,phaseId:'intake',
    report:candidate,expectedContext:view.manifest.contextBinding};
  assert.equal(view.manifest.status.status,'missing');
  assert.ok((await f.engine.run('story.next',{})).manifest.actions.some(row=>row.operation?.id==='source-review.context'&&row.timing==='now'));
  await assert.rejects(f.engine.run('source-review.record',input),{code:'SOURCE_REVIEWER_REQUIRED'});
  f.control.agentId='source-reviewer';
  const recorded=await f.engine.run('source-review.record',input);assert.equal(recorded.authorityGroup,null);
  const ready=await f.engine.run('source-review.context',{phaseId:'intake'});assert.equal(ready.manifest.status.status,'ready',JSON.stringify(ready.manifest.status));
  assert.ok((await f.engine.run('story.next',{})).manifest.actions.some(row=>row.operation?.id==='phase.submit'&&row.timing==='now'));
  assert.equal((await f.engine.run('story.guide',{})).manifest.classification,'submission-required');
  await assert.rejects(f.engine.run('phase.submit',{phaseId:'intake'}),error=>error.code==='SOURCE_REVIEW_REVIEWER_CANNOT_SUBMIT');
  const immutable=await f.capture();assert.deepEqual(await f.make({working:null,clock:{now(){throw Error('Review replay cannot obtain a new timestamp.');}}}).run('source-review.record',input),recorded);
  assert.deepEqual(await f.capture(),immutable);
  f.asAuthor();await f.engine.run('phase.submit',{phaseId:'intake'});const submitted=await f.capture(),binding=submitted.workflow.phases.intake.namespaceSubmission,
    packet=JSON.parse(Buffer.from((await f.content.read(f.scope,binding.record)).data));
  assert.equal(packet.schemaVersion,4);assert.equal(packet.checks,null);assert.ok(packet.sourceReview.records.length);
  const denied=Object.freeze(Object.assign(Error('Actual source-review record is unavailable.'),{code:'EACCES'})),
    broken=f.make({working:null,content:{...f.content,read(scope,reference,options){if(reference.sha256===packet.sourceReview.records[0].sha256)throw denied;return f.content.read(scope,reference,options);}}});
  f.asReviewer();await assert.rejects(broken.run('phase.review.resources',{phaseId:'intake'}),error=>error===denied);
  const shared=f.make({working:null}),review=await shared.run('phase.review.resources',{phaseId:'intake'});
  assert.ok(review.manifest.resources.some(row=>row.kind==='source-review'&&row.expected.sha256===packet.sourceReview.reportSha256));
  for(const resource of review.manifest.resources)await shared.run('document.read',{reference:resource.reference});
  const approved=await shared.run('phase.approve',{phaseId:'intake',confirmation:{workId:f.workId,phase:'intake',generation:1,reviewPacketSha256:review.manifest.reviewBinding.packetSha256}});
  assert.equal(approved.approval.selfApproval,false);assert.equal((await f.capture()).workflow.status,'closed');
});
test('a genuine semantic gap remains repairable and an exclusion needs its own exact human disposition',async t=>{
  const f=await fixture(t),view=await f.engine.run('source-review.context',{phaseId:'intake'}),candidate=report(view.manifest);
  candidate.rows.push({id:'secondary-proposal',sourceId:'story-source',line:3,quote:'Retain an observable reviewed document.',outcome:'excluded',reason:'The scope authority must confirm this proposed duplicate.'});
  f.control.agentId='source-reviewer';await f.engine.run('source-review.record',{operationId:'review-with-human-question',phaseId:'intake',report:candidate,expectedContext:view.manifest.contextBinding});
  const pending=await f.engine.run('source-review.context',{phaseId:'intake'});assert.equal(pending.manifest.status.pendingDispositions[0].id,'exclusion:secondary-proposal');
  f.asAuthor();await assert.rejects(f.engine.run('phase.submit',{phaseId:'intake'}),{code:'SOURCE_REVIEW_NOT_READY'});
  f.asReviewer();const decision=await f.engine.run('source-review.decide',{operationId:'human-source-disposition',phaseId:'intake',findingId:'exclusion:secondary-proposal',
    reason:'The second row is a duplicate of the complete first mapping.',expectedContext:pending.manifest.contextBinding});
  assert.equal(decision.authorityGroup,'reviewers');assert.equal((await f.engine.run('source-review.context',{phaseId:'intake'})).manifest.status.status,'ready');
});
test('a semantic repair replaces only its review report, preserves the generation and cannot be waived by a human',async t=>{
  const f=await fixture(t),context=await f.engine.run('source-review.context',{phaseId:'intake'}),candidate=report(context.manifest);
  candidate.findings.push({id:'missing-interaction',severity:'blocking',message:'The independent reviewer found a missing interaction.'});
  f.control.agentId='source-reviewer';const first={operationId:'retain-semantic-gap',phaseId:'intake',report:candidate,expectedContext:context.manifest.contextBinding};
  await f.engine.run('source-review.record',first);const pending=await f.engine.run('source-review.context',{phaseId:'intake'});
  assert.ok(pending.manifest.status.findings.some(row=>row.code==='reviewer-blocker'));
  assert.ok((await f.engine.run('story.next',{})).manifest.actions.some(row=>row.operation?.id==='phase.prepare'&&row.timing==='now'));f.asReviewer();
  await assert.rejects(f.engine.run('source-review.decide',{operationId:'cannot-waive-reviewer-blocker',phaseId:'intake',findingId:'missing-interaction',reason:'Do not waive a genuine missing requirement.',expectedContext:pending.manifest.contextBinding}),{code:'SOURCE_REVIEW_DISPOSITION_NOT_PENDING'});
  f.control.agentId='source-reviewer';const corrected=report(pending.manifest);
  await assert.rejects(f.engine.run('source-review.record',{...first,operationId:'stale-review-candidate',report:corrected}),{code:'SOURCE_REVIEW_BINDING_CHANGED'});
  await f.engine.run('source-review.record',{...first,operationId:'retain-corrected-independent-review',report:corrected,expectedContext:pending.manifest.contextBinding});
  assert.equal((await f.engine.run('source-review.context',{phaseId:'intake'})).manifest.status.status,'ready');
  assert.equal((await f.capture()).workflow.phases.intake.generation,1);
});
test('lost review preparation preserves the actual transport failure and resumes its original timestamp',async t=>{
  const f=await fixture(t),view=await f.engine.run('source-review.context',{phaseId:'intake'}),input={operationId:'interrupted-source-review',phaseId:'intake',report:report(view.manifest),expectedContext:view.manifest.contextBinding};
  f.control.agentId='source-reviewer';let failed=false;
  const failure=Object.freeze(Object.assign(Error('The actual source-review acknowledgement was lost.'),{code:'ETIMEDOUT',details:{deadlineMs:5210}})),
    records={...f.records,async transact(scope,transaction,options){const result=await f.records.transact(scope,transaction,options);
      if(!failed&&transaction.changes.some(row=>row.namespace==='runtime'&&row.value?.operation==='source-review.record')){failed=true;throw failure;}return result;}};
  await assert.rejects(f.make({records}).run('source-review.record',input),error=>error===failure);
  const shared=f.make({working:null,clock:{now(){throw Error('Resume the real original review candidate.');}}}),result=await shared.run('source-review.record',input);
  assert.equal((await f.capture()).workflow.namespaceSourceReviews.length,1);assert.deepEqual(await shared.run('source-review.record',input),result);
});
test('local source documents stay local and another device must supply matching bytes before reviewing or replaying',async t=>{
  const f=await fixture(t,'filesystem',{document:{text:'# Notes\nThe reviewed document must remain available.\n'}}),view=await f.engine.run('source-review.context',{phaseId:'intake'}),candidate=report(view.manifest),
    local=view.manifest.resources.find(row=>row.id==='review-notes');
  assert.equal(local.reference.namespace,'local');candidate.sourcesReviewed.push('review-notes');candidate.rows.push({id:'notes-requirement',sourceId:'review-notes',line:2,quote:'The reviewed document must remain available.',outcome:'covered',scenarioId:'S1',clauseIds:['COMPOSED:REQ-001']});
  f.control.agentId='source-reviewer';const input={operationId:'review-with-local-source',phaseId:'intake',report:candidate,expectedContext:view.manifest.contextBinding};
  await f.engine.run('source-review.record',input);
  const sharedOnly=f.make({working:null,localContent:null});await assert.rejects(sharedOnly.run('source-review.context',{phaseId:'intake'}),error=>error.code==='DOCUMENT_REUPLOAD_REQUIRED'&&error.details.expected.sha256===local.reference.sha256);
  const missing=await f.content.read(f.scope,{...local.reference,namespace:'evidence'});assert.equal(missing.status,'missing','source attachment bytes were not promoted to shared storage');
  const restored=f.make({working:null,localContent:f.local.content});assert.equal((await restored.run('source-review.context',{phaseId:'intake'})).manifest.status.status,'ready');
  f.asAuthor();await restored.run('phase.submit',{phaseId:'intake'});f.asReviewer();
  await assert.rejects(sharedOnly.run('phase.review.resources',{phaseId:'intake'}),{code:'DOCUMENT_REUPLOAD_REQUIRED'});
  assert.equal((await restored.run('phase.review.resources',{phaseId:'intake'})).manifest.generation,1);
});

test('the exact published clarification is readable and must be acknowledged before review is ready',async t=>{
  const f=await fixture(t,'filesystem',{clarification:true}),view=await f.engine.run('source-review.context',{phaseId:'intake'}),candidate=report(view.manifest),
    clarification=view.manifest.resources.find(row=>row.kind==='clarification');
  assert.equal(view.manifest.binding.clarifications.length,1);assert.ok(clarification.read);
  for(const resource of view.manifest.resources)assert.equal((await f.engine.run(resource.read.operation,resource.read.inputs)).document.integrity,'matched');
  f.control.agentId='source-reviewer';await f.engine.run('source-review.record',{operationId:'missed-clarification-review',phaseId:'intake',report:candidate,expectedContext:view.manifest.contextBinding});
  const blocked=await f.engine.run('source-review.context',{phaseId:'intake'});assert.ok(blocked.manifest.status.findings.some(row=>row.code==='clarifications-not-all-reviewed'));
  assert.ok((await f.engine.run('story.next',{})).manifest.actions.some(row=>row.timing==='now'&&row.operation?.id==='source-review.context'));
  assert.equal((await f.engine.run('story.guide',{})).manifest.classification,'source-review-required');
  candidate.clarificationsReviewed=['clarification:current-phase'];await f.engine.run('source-review.record',{operationId:'read-bound-human-answers',phaseId:'intake',report:candidate,expectedContext:blocked.manifest.contextBinding});
  assert.equal((await f.engine.run('source-review.context',{phaseId:'intake'})).manifest.status.status,'ready');
});

test('a custom planning phase reviews its real independently approved scope and exact parsed plan rows',async t=>{
  const storyText='# Request\n\nConvert an integer into hexadecimal and show FF for 255.\n',f=await namespaceSpecificationFixture(t,{storyText,configure(source){
    source.definition.workTypes.simple.sourceReview={mode:'enforce',phases:['intake','design'],reviewerAgent:'source-reviewer'};
    source.agents.push({...structuredClone(source.agents[0]),id:'source-reviewer',label:'Independent source reviewer',mode:'read-only-review',defaultFor:[]});
  }}),engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent}});
  f.control.permissions.push('source-review.context','source-review.record');
  await f.author('intake','# Scenarios\n### S1 — Convert\nGiven 255, when converted, then display FF.\n'+specificationText);
  let view=await engine.run('source-review.context',{phaseId:'intake'});f.control.agentId='source-reviewer';
  await engine.run('source-review.record',{operationId:'custom-scope-source-review',phaseId:'intake',expectedContext:view.manifest.contextBinding,
    report:{schemaVersion:1,resultType:'source-grounded-review',kind:'specification',binding:view.manifest.binding,reviewer:{agentId:'source-reviewer',readOnly:true},sourcesReviewed:['story-source'],findings:[],
      rows:[{id:'converter',sourceId:'story-source',line:3,quote:'Convert an integer into hexadecimal and show FF for 255.',outcome:'covered',scenarioId:'S1',clauseIds:['STORY-1:REQ-001','STORY-1:AC-001']}]}});
  f.control.agentId='analyst';await f.approve('intake');await f.author('design',planText);view=await engine.run('source-review.context',{phaseId:'design'});
  assert.ok(view.manifest.binding.upstreamSpec);assert.equal(view.manifest.binding.phase,'design');
  for(const source of view.manifest.resources)assert.equal((await engine.run(source.read.operation,source.read.inputs)).document.integrity,'matched');
  f.control.agentId='source-reviewer';await engine.run('source-review.record',{operationId:'custom-plan-source-review',phaseId:'design',expectedContext:view.manifest.contextBinding,
    report:{schemaVersion:1,resultType:'source-grounded-review',kind:'planning',binding:view.manifest.binding,reviewer:{agentId:'source-reviewer',readOnly:true},sourcesReviewed:['story-source'],findings:[],
      rows:['STORY-1:REQ-001','STORY-1:AC-001'].map(clauseId=>({clauseId,expectedPaths:['src/converter.js'],plannedTests:['test/converter.test.js'],testDisposition:'applicable',assessment:'supported'}))}});
  assert.equal((await engine.run('source-review.context',{phaseId:'design'})).manifest.status.status,'ready');f.control.agentId='analyst';
  assert.equal((await f.approve('design')).approval.selfApproval,false);assert.equal((await f.capture()).workflow.currentPhase,'build');
});
