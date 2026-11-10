/** Coordination receipts satisfy a required assignment, without substituting for independent approval. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': real assignment evidence reaches publication and shared-only approval',{timeout:120000},async t=>{
  const f=await namespaceEngineFixture(t,{backend,configure(source){source.definition.collaboration={assignmentMode:'required',notifications:['terminal']};}});
  f.control.permissions.push('phase.assign','phase.prepublish');await f.bootstrap();
  await assert.rejects(f.author(),error=>error.code==='ENGINE_ASSIGNMENT_REQUIRED'&&error.details.actions[0].operation==='phase.assign');
  const incomplete=await f.engine.run('phase.prepublish',{phaseId:'intake'});assert.equal(incomplete.status,'correction-required');
  assert.ok(incomplete.manifest.findings.some(row=>row.code==='ENGINE_ASSIGNMENT_REQUIRED'));
  const before=await f.capture(),draft=await f.engine.run('phase.draft.read',{phaseId:'intake'}),
    request={operationId:'coordinate-exact-phase',workId:f.workId,phaseId:'intake',assignee:'  implementation-team  '};
  f.control.permissions=f.control.permissions.filter(id=>id!=='phase.assign');await assert.rejects(f.engine.run('phase.assign',request),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.deepEqual(await f.capture(),before);f.control.permissions.push('phase.assign');
  const assigned=await f.engine.run('phase.assign',request),after=await f.capture();
  assert.equal(assigned.record.assignee,'implementation-team');assert.equal(assigned.authorityGroup,null);assert.equal(assigned.currentPhase,'intake');
  assert.deepEqual(after.workflow.phases,before.workflow.phases);assert.equal(after.workflow.collaboration.assignments.intake.assignedBy.email,'reviewer@example.test');
  await f.engine.run('phase.draft.rebase',{operationId:'continue-after-coordination',workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    confirm:draft.manifest.draft.bodySha256,reason:'Keep the original authored bytes after recording actual phase coordination.'});
  assert.equal((await f.engine.run('phase.prepublish',{phaseId:'intake'})).status,'ready');
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'intake'});
  const state=await f.capture(),publishedRef=state.workflow.phases.intake.publicationBindings[0].record,
    published=JSON.parse(Buffer.from((await f.content.read(f.scope,publishedRef)).data)),binding=published.policyEvidence.find(row=>row.kind==='phase-assignment/v1');
  assert.ok(binding,'the publication carries actual assignment provenance, not only an assignment flag');
  const decisionRef=state.workflow.namespaceDecisionReceipts.find(row=>row.operationId===request.operationId).record,
    denied=Object.freeze(Object.assign(Error('Actual coordinator record cannot be read.'),{code:'EACCES'})),
    missing=f.make({working:null,content:{...f.content,read(scope,reference,options){if(reference.sha256===decisionRef.sha256)throw denied;return f.content.read(scope,reference,options);}}});
  await assert.rejects(missing.run('phase.review.resources',{phaseId:'intake'}),error=>error===denied);
  const review=await f.review();assert.equal(review.result.approval.selfApproval,false);assert.equal((await f.capture()).workflow.status,'closed');
  f.asAuthor();const replay=f.make({working:null,clock:{now(){throw Error('Replay must preserve its original assignment time.');}}}),current=await f.capture();
  assert.deepEqual(await replay.run('phase.assign',request),assigned);assert.deepEqual(await f.capture(),current);
  await assert.rejects(replay.run('phase.assign',{...request,assignee:'Another team'}),{code:'ENGINE_OPERATION_ID_REUSED'});
});
test('a lost assignment response resumes one original candidate and preserves the transport error',async t=>{
  const f=await namespaceEngineFixture(t,{working:false});await f.bootstrap();f.control.permissions.push('phase.assign');
  const denied=Object.freeze(Object.assign(Error('Actual assignment acknowledgement was lost.'),{code:'ETIMEDOUT',details:{deadlineMs:4521}}));let failed=false;
  const records={...f.records,async transact(scope,transaction,options){const outcome=await f.records.transact(scope,transaction,options);
    if(!failed&&transaction.changes.some(row=>row.namespace==='runtime'&&row.value?.operation==='phase.assign')){failed=true;throw denied;}return outcome;}};
  const input={operationId:'resume-original-assignment',workId:f.workId,phaseId:'intake',assignee:'Example team'};
  await assert.rejects(f.make({records}).run('phase.assign',input),error=>error===denied);
  const result=await f.make({clock:{now(){throw Error('Retain the original prepared timestamp.');}}}).run('phase.assign',input);
  assert.equal(result.record.assignee,'Example team');assert.equal((await f.capture()).workflow.collaboration.notifications.length,1);
});
