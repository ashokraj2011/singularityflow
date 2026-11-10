/** A human correction closes only its actual upstream issue, with no duplicate decision or phase reset. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceSourceClauseFixture} from './helpers/namespace-source-clause-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
const reason='Correct the exact approved converter location and retain its original human ownership.';
for(const backend of ['filesystem','sqlite','application'])test(backend+': upstream correction outcome requires an accepted exact-owner human correction',{timeout:120000},async t=>{
  const f=await namespaceSourceClauseFixture(t,{backend});f.control.permissions.push('upstream.raise','upstream.decide','upstream.list','plan.correction.context','plan.correction.record');
  const raised=await f.engine.run('upstream.raise',{operationId:'raise-plan-location-gap',workId:f.inputs.workId,phaseId:'design',
    about:'STORY-1:REQ-001',problem:'The approved plan names the wrong implementation location for this converter behavior.',proposed:'plan-correction'});
  assert.equal(raised.records[0].id,'UPI-001');
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const decision={operationId:'close-exact-plan-gap',workId:f.inputs.workId,issueId:'UPI-001',outcome:'plan-correction',link:'PRC-001',reason};
  const baseline=await f.capture();await assert.rejects(f.engine.run('upstream.decide',decision),error=>error.code==='UPSTREAM_ISSUE_INVALID'&&/Name the plan correction/u.test(error.message));
  assert.deepEqual(await f.capture(),baseline);
  const query={ownerPhase:'design',operations:[{op:'replace-location',clauseId:'STORY-1:REQ-001',from:'src/converter.js',to:'src/actual-converter.js'}],reason,upstreamIssue:'UPI-001'},
    context=await f.engine.run('plan.correction.context',query),correction=await f.engine.run('plan.correction.record',{
      ...query,operationId:'correct-plan-for-original-upstream',expectedPreview:'sha256:'+context.manifest.preview.previewSha256});
  assert.equal(correction.record.upstreamIssue,'UPI-001');
  const wrong=await f.engine.run('upstream.raise',{operationId:'different-upstream-owner',workId:f.inputs.workId,phaseId:'intake',about:'different source',
    problem:'A separate upstream definition needs a different owner and must not use this planning correction.',proposed:'unknown'});
  await assert.rejects(f.engine.run('upstream.decide',{...decision,operationId:'cannot-close-different-owner',issueId:wrong.records[0].id}),
    error=>error.code==='UPSTREAM_ISSUE_INVALID'&&/about intake/u.test(error.message));
  const sameOwner=await f.engine.run('upstream.raise',{operationId:'different-gap-same-owner',workId:f.inputs.workId,phaseId:'design',about:'another planned behavior',
    problem:'A separate planning gap must not inherit the correction signed for the first upstream issue.',proposed:'plan-correction'});
  await assert.rejects(f.engine.run('upstream.decide',{...decision,operationId:'cannot-close-unrelated-gap',issueId:sameOwner.records[0].id}),
    error=>error.code==='UPSTREAM_ISSUE_INVALID'&&/not UPI-003/u.test(error.message));
  const before=await f.capture(),closed=await f.engine.run('upstream.decide',decision),after=await f.capture();
  assert.equal(closed.records[0].link,'PRC-001');assert.equal(closed.records[0].outcome,'plan-correction');
  assert.equal(after.workflow.currentPhase,before.workflow.currentPhase);assert.deepEqual(after.workflow.phases,before.workflow.phases);
  assert.equal(after.workflow.planAmendments.length,1);assert.equal(after.workflow.upstreamIssueDecisions.length,1);
  assert.deepEqual((await f.engine.run('upstream.list',{open:true})).issues.map(row=>row.id),['UPI-002','UPI-003']);
  const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('An accepted upstream decision must retain its timestamp.');}}});
  assert.deepEqual(await replay.run('upstream.decide',decision),closed);assert.deepEqual(await f.capture(),after);
  await assert.rejects(f.engine.run('upstream.decide',{...decision,operationId:'cannot-decide-another-time'}),{code:'UPSTREAM_ISSUE_DECIDED'});
  const link=after.workflow.namespaceDecisionReceipts.find(row=>row.operationId==='close-exact-plan-gap'),body=await f.json(link.record);
  assert.equal(body.source.profile,'sflow-namespace-upstream-plan-correction-source/v1');
  assert.ok(body.source.corrections.receipts.some(row=>row.operationId==='correct-plan-for-original-upstream'));
  const correctionReference=body.source.corrections.receipts.find(row=>row.operationId==='correct-plan-for-original-upstream').record,
    denied=Object.freeze(Object.assign(Error('The actual linked human correction cannot be read.'),{code:'EACCES',path:'original-correction'})),
    unavailable=createNamespaceEngine({...f.common,content:{...f.content,read(scope,reference,options){
      if(reference.sha256===correctionReference.sha256)throw denied;return f.content.read(scope,reference,options);}}});
  await assert.rejects(unavailable.run('upstream.decide',decision),error=>error===denied);
});
