import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceForwardFixture} from './helpers/namespace-forward-fixture.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceSubmissionReader} from '../src/engine-storage/namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {generateConstitution} from '../src/constitution.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+' forward amendment retains the original vote and actual replacement approval',async t=>{
  const f=await namespaceForwardFixture(t,{backend}),before=await f.capture(),old=structuredClone(before.workflow.phases.intake),
    proposal=await f.propose();
  assert.equal(proposal.result.records[0].id,'FAM-001');assert.deepEqual((await f.capture()).workflow.phases.intake,old);
  const approved=await f.decide();assert.equal(approved.result.currentPhase,'delivery');assert.deepEqual(approved.result.revalidate,['design']);
  const after=await f.capture();assert.equal(after.workflow.phases.intake.generation,2);assert.equal(after.workflow.phases.intake.status,'approved');
  assert.equal(after.workflow.phases.intake.approvals[0].generation,1);assert.ok(after.workflow.phases.intake.approvals[0].invalidatedAt);
  const observer=createNamespaceStoryObserver(f.options),reader=createNamespaceSubmissionReader({observer,scope:f.scope,workId:f.workId,
    checks:createNamespacePhaseCheckReader({...observer.evidenceReads,observer})});
  const [packet]=await reader.inspectApprovedMany(after,['intake']);assert.equal(packet.published.artifact.content.sha256,proposal.result.records[0].proposedSha256);
  assert.equal(packet.value.generation,2);assert.equal(packet.value.origin.amendmentId,'FAM-001');
  f.asAuthor();await assert.rejects(f.engine.run('phase.prepare',{phaseId:'delivery'}),{code:'AMENDMENT_REVALIDATION_REQUIRED'});f.asReviewer();
  const input={operationId:'revalidate-reader',workId:f.workId,phaseId:'design',amendmentId:'FAM-001',outcome:'unchanged',
    reason:'The approved design remains correct for the amended producer document.'};
  const revalidated=await f.engine.run('forward-amendment.revalidate',input);assert.equal(revalidated.records[0].binding.producerGeneration,2);
  assert.deepEqual(await f.make({working:null}).run('forward-amendment.revalidate',input),revalidated);
  f.asAuthor();await f.author('delivery');await f.review('delivery');assert.equal((await f.capture()).workflow.status,'closed');
});

test('amendment return reopens its real reader and resolves through a fresh independent generation',async t=>{
  const f=await namespaceForwardFixture(t,{backend:'sqlite'});await f.propose();await f.decide();
  const result=await f.engine.run('forward-amendment.revalidate',{operationId:'return-reader',workId:f.workId,phaseId:'design',amendmentId:'FAM-001',outcome:'return',
    reason:'The amended producer needs a corrected design before delivery can continue.'});
  assert.equal(result.currentPhase,'design');assert.equal(result.records[0].changeRequest.profile,'sflow-namespace-forward-return/v1');
  f.asAuthor();await f.author('design');await f.review('design');await f.author('delivery');await f.review('delivery');
  assert.equal((await f.capture()).workflow.changeRequests[0].status,'resolved');
});

test('amendment proposal, human choice, authority and exact error identity cannot be bypassed',async t=>{
  const f=await namespaceForwardFixture(t,{backend:'sqlite'}),initial=await f.capture();
  await assert.rejects(f.propose({text:'# TODO\n\nTODO: author this replacement.'}),{code:'ARTIFACT_AUTHORING_INCOMPLETE'});
  assert.deepEqual(await f.capture(),initial);
  const proposal=await f.propose();
  await assert.rejects(f.propose({operationId:'duplicate-amendment'}),{code:'FORWARD_AMENDMENT_PENDING'});
  const choice={operationId:'review-exact-amendment',workId:f.workId,amendmentId:'FAM-001',decision:'approve',confirmation:'FAM-002',
    reason:'The human reviewed the exact replacement, original source and input dependencies.'};
  await assert.rejects(f.engine.run('forward-amendment.decide',choice),{code:'FORWARD_AMENDMENT_CONFIRMATION_REQUIRED'});
  await assert.rejects(f.engine.run('forward-amendment.decide',{...choice,confirmation:'FAM-001'}),error=>/self|own/iu.test(error.message));
  const next=await f.engine.run('story.next',{});assert.equal(next.manifest.actions[0].kind,'pending-decisions');
  const list=await f.engine.run('decisions.list',{});assert.equal(list.manifest.actions.filter(row=>row.operation==='forward-amendment.decide').length,1);
  const {input,result}=await f.decide({decision:'reject'}),after=await f.capture();assert.equal(result.records[0].applied,false);
  assert.deepEqual(after.workflow.phases.intake,initial.workflow.phases.intake);
  assert.deepEqual(await f.make({working:null}).run('forward-amendment.decide',input),result);
  const link=after.workflow.namespaceDecisionReceipts.find(row=>row.operationId===proposal.input.operationId),denied=Object.freeze(Object.assign(Error('The original amendment cannot be read.'),{code:'EACCES',path:'original-amendment'})),
    guarded=f.make({working:null,content:{...f.content,read(scope,reference,options){if(reference.sha256===link.record.sha256)throw denied;return f.content.read(scope,reference,options);}}});
  await assert.rejects(guarded.run('forward-amendment.decide',input),error=>error===denied);
});

test('upstream amend resolves only the actual approved proposal, retaining one original owner',async t=>{
  const f=await namespaceForwardFixture(t,{backend:'sqlite'}),raise=phaseId=>f.engine.run('upstream.raise',{workId:f.workId,operationId:'issue-'+phaseId,phaseId,
    about:'approved document',problem:'This upstream document needs an observable correction before delivery completes.',proposed:'amend'});
  await raise('intake');await f.propose({upstreamIssue:'UPI-001'});f.asReviewer();
  const input={workId:f.workId,operationId:'resolve-original-issue',issueId:'UPI-001',outcome:'amend',link:'FAM-001',
    reason:'The independent approved amendment resolves this exact original document discrepancy.'};
  await assert.rejects(f.engine.run('upstream.decide',input),{code:'FORWARD_AMENDMENT_NOT_APPROVED'});await f.decide();
  const decision=await f.engine.run('upstream.decide',input);assert.equal(decision.records[0].link,'FAM-001');
  const after=await f.capture();assert.equal(after.workflow.upstreamIssueDecisions.length,1);assert.equal(after.workflow.currentPhase,'delivery');
  assert.deepEqual(await f.make({working:null}).run('upstream.decide',input),decision);
  await raise('design');await assert.rejects(f.engine.run('upstream.decide',{...input,operationId:'wrong-owner-amend',issueId:'UPI-002'}),{code:'UPSTREAM_ISSUE_INVALID'});
});

for(const backend of ['filesystem','sqlite','application'])test(backend+' amendment reconciles a lost reply without duplicating a generation or human vote',async t=>{
  const f=await namespaceForwardFixture(t,{backend});await f.propose();f.asReviewer();
  const input={workId:f.workId,operationId:'interrupted-replacement',amendmentId:'FAM-001',decision:'approve',confirmation:'FAM-001',
    reason:'Retain the exact reviewed replacement and reconcile its original conditional acknowledgement.'},
    failure=Object.freeze(Object.assign(Error('The actual amendment reply timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:317}}));let lost=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!lost&&args[1].events.some(row=>row.payload?.operation==='forward-amendment.decide')){lost=true;throw failure;}return result;}};
  await assert.rejects(f.make({records}).run('forward-amendment.decide',input),error=>error===failure);assert.equal(lost,true);
  const before=await f.capture(),result=await f.make({working:null}).run('forward-amendment.decide',input);
  assert.equal(result.records[0].approval.generation,2);assert.deepEqual(await f.capture(),before);
  assert.equal(before.workflow.phases.intake.publicationBindings.length,2);assert.equal(before.workflow.forwardAmendmentDecisions.length,1);
});

test('replacement constitution evidence is evaluated from actual pinned rules and retained for downstream readers',async t=>{
  const f=await namespaceForwardFixture(t,{backend:'sqlite',setup:async f=>{
    f.source.definition.workTypes.simple.constitution={mode:'enforce',path:'singularity/constitution.md'};
    const markdown=generateConstitution('---\narticles:\n  - id: ART-001\n    type: enforced\n    policy: phases.intake.approval.minimum\n---\n# Team rules\n\n## [ART-001] Independent review\nKeep the pinned approval threshold.\n',
      {phases:[{id:'intake',approval:{minimum:1}}]}).markdown;
    f.source.files.push({path:'singularity/constitution.md',body:await f.putText(markdown)});
  }});
  await f.propose();await f.decide();const state=await f.capture(),binding=state.workflow.phases.intake.publicationBindings.at(-1),
    json=async ref=>JSON.parse(Buffer.from((await f.content.read(f.scope,ref)).data)),value=await json(binding.record);
  assert.equal(value.policyEvidence[0].kind,'constitution-policy/v1');const manifest=await json(value.policyEvidence[0].record),report=await json(manifest.report);
  assert.deepEqual(report.errors,[]);assert.equal(report.pin.source.content.sha256,f.source.files[0].body.sha256);
  await f.engine.run('forward-amendment.revalidate',{operationId:'constitution-reader',workId:f.workId,phaseId:'design',amendmentId:'FAM-001',outcome:'unchanged',
    reason:'The original design still holds under the exact constitution-checked replacement.'});
  f.asAuthor();await f.author('delivery');await f.review('delivery');assert.equal((await f.capture()).workflow.status,'closed');
});

test('amendment returns consume their actual pinned budget and cannot reopen beyond it',async t=>{
  const f=await namespaceForwardFixture(t,{backend:'sqlite',configure(source){
    source.definition.phases.design.repairBudget={maxAttempts:1,resetOnPhase:null};source.definition.workTypes.simple.reworkLoops=[{from:'delivery',to:'design',maxAttempts:1}];
  }});
  await f.propose();await f.decide();const input={operationId:'bounded-amendment-return',workId:f.workId,phaseId:'design',amendmentId:'FAM-001',outcome:'return',
    reason:'This design must be corrected under the exact original pinned repair budget.'},result=await f.engine.run('forward-amendment.revalidate',input);
  assert.equal(result.records[0].repairBudget.attempts.length,1);assert.equal((await f.capture()).workflow.namespaceRepairBudgetHistory[0].kind,'amendment');
  f.asAuthor();await f.author('design');await f.review('design');f.asAuthor();await f.propose({operationId:'second-proposal'});await f.decide({operationId:'second-approval',amendmentId:'FAM-002'});
  const before=await f.capture();await assert.rejects(f.engine.run('forward-amendment.revalidate',{...input,operationId:'cannot-exceed-budget',amendmentId:'FAM-002'}),
    error=>error.code==='REPAIR_BUDGET_EXHAUSTED'&&error.details.actions.some(row=>row.operation==='upstream.raise')&&error.details.consumed===1);
  assert.deepEqual(await f.capture(),before);assert.deepEqual(await f.make({working:null}).run('forward-amendment.revalidate',input),result);
});
test('confirmed recovery survives actual amendment, upstream and reviewer returns without flags or duplicate agreements',{timeout:120000},async t=>{
  const f=await namespaceForwardFixture(t,{backend:'sqlite',configure(source){source.definition.testRecovery={enabled:true};},setup:async f=>{
    const bootstrap=f.bootstrap;f.bootstrap=async()=>{const result=await bootstrap();f.control.permissions.push('test-recovery.context','test-recovery.confirm','phase.reject');
      const {manifest}=await f.engine.run('test-recovery.context',{});await f.engine.run('test-recovery.confirm',{operationId:'agree-before-returns',phaseId:'intake',
        expectedContext:manifest.expectedContext,reason:'The human reviewed the complete configured commands and bounded recovery policy.'});return result;};
  }});
  await f.propose();await f.decide();await f.engine.run('forward-amendment.revalidate',{operationId:'agreed-reader-return',workId:f.workId,
    phaseId:'design',amendmentId:'FAM-001',outcome:'return',reason:'The current agreement remains valid while the exact affected reader is revalidated.'});
  f.asAuthor();await f.author('design');await f.review('design');f.asAuthor();
  await f.engine.run('upstream.raise',{operationId:'agreed-upstream-issue',workId:f.workId,phaseId:'intake',about:'original approved document',
    problem:'The original document needs a separately reviewed correction under the existing agreement.',proposed:'return'});
  f.asReviewer();await f.engine.run('upstream.decide',{operationId:'agreed-upstream-return',workId:f.workId,issueId:'UPI-001',outcome:'return',
    reason:'The original producer must correct its exact publication without weakening the pinned recovery policy.'});
  f.asAuthor();await f.author('intake');await f.review('intake');await f.author('design');await f.review('design');await f.author('delivery');f.asReviewer();
  const {manifest}=await f.engine.run('phase.review',{phaseId:'delivery'});
  await f.engine.run('phase.reject',{workId:f.workId,phaseId:'delivery',target:'delivery',confirm:manifest.reviewBinding.packetSha256,
    reason:'The independent reviewer requests a substantive correction while retaining the exact agreement.'});
  f.asAuthor();await f.author('delivery');await f.review('delivery');const closed=await f.capture();
  assert.equal(closed.workflow.status,'closed');assert.equal(closed.workflow.namespaceTestRecoveryAgreements.length,1);
});
