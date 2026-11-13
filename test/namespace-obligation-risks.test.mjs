import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceObligationRiskFixture,obligationRiskReason} from './helpers/namespace-obligation-risk-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
test('a real configured end route has its separate terminal vote and replays the original routed receipt',{timeout:120000},async t=>{
  const f=await namespaceObligationRiskFixture(t,{routed:true});await f.engine.run('decision.risk',f.riskInput());
  const reviewed=await f.review('release'),snapshot=await f.capture(),vote=snapshot.workflow.phases.release.approvals.at(-1),
    data=JSON.parse(Buffer.from((await f.content.read(f.scope,vote.namespaceVote.record)).data));
  assert.equal(data.schemaVersion,5);assert.equal(data.routing.outcome.kind,'end');assert.equal(snapshot.workflow.status,'closed');
  const replay=f.make({working:null,clock:{now(){throw Error('An accepted end route needs no new clock.');}}});
  assert.deepEqual(await replay.run('phase.approve',{phaseId:'release',confirmation:reviewed.confirmation}),reviewed.result);
});
for(const backend of ['filesystem','sqlite','application'])test(backend+' exact human obligation risk closes through actual independent approval and shared-only replay',{timeout:120000},async t=>{
  const f=await namespaceObligationRiskFixture(t,{backend}),before=await f.engine.run('story.evidence',{}),raw=before.manifest.report.rows.find(row=>row.id==='COMPOSED-STORY:AC-001');
  assert.equal(raw.obligations.find(row=>row.responsibility==='verify').status,'missing');
  const result=await f.engine.run('decision.risk',f.riskInput());assert.equal(result.record.id,'RISK-001');
  const view=await f.engine.run('story.evidence',{}),criterion=view.manifest.report.rows.find(row=>row.id==='COMPOSED-STORY:AC-001'),verify=criterion.obligations.find(row=>row.responsibility==='verify');
  assert.equal(verify.status,'excepted');assert.equal(verify.facets.execution,'not-applicable');assert.equal(verify.riskDecision.id,'RISK-001');
  assert.equal(verify.facets.exception,'accepted-risk');
  const confirmation=(await f.review('release')).confirmation,snapshot=await f.capture(),vote=snapshot.workflow.phases.release.approvals.at(-1),
    data=JSON.parse(Buffer.from((await f.content.read(f.scope,vote.namespaceVote.record)).data));
  assert.equal(snapshot.workflow.status,'closed');assert.equal(data.schemaVersion,4);assert.ok(data.terminalEvidence);
  const terminal=JSON.parse(Buffer.from((await f.content.read(f.scope,data.terminalEvidence)).data));
  assert.equal(terminal.proposal,'uncommitted-human-vote');assert.equal(terminal.report.decision.gate,'allow-with-risk');
  const shared=createNamespaceEngine({...f.options,working:null,clock:{now(){throw Error('Accepted decisions and approvals cannot need a new timestamp.');}}});
  const acknowledged=await shared.run('decision.risk',f.riskInput());assert.deepEqual(acknowledged.record,result.record);assert.equal(acknowledged.status,'retained');assert.equal(acknowledged.effects.committed,false);
  const replay=await shared.run('phase.approve',{phaseId:'release',confirmation});assert.equal(replay.approval.actorId,'independent-reviewer');
  assert.deepEqual(await f.capture(),snapshot);
  const completed=(await f.engine.run('story.evidence',{})).manifest;
  assert.equal(completed.profile,'sflow-namespace-evidence-context/v2');assert.equal(completed.report.profile,'sflow-evidence-evaluation/v2');
  assert.equal(completed.report.completion.kind,'complete-with-exceptions');assert.notEqual(completed.report.inputSha256,before.manifest.report.inputSha256);
});
test('duplicate decisions are refused while list and batch use the same original owner',{timeout:120000},async t=>{
  const f=await namespaceObligationRiskFixture(t),shown=await f.engine.run('decisions.list',{}),policy=shown.manifest.policy,
    item=policy.offered.find(row=>row.kind==='obligation-risk'&&row.title===f.riskInput().obligationId);assert.ok(item);
  const input={confirmation:policy.packetSha256,answers:{choose:{[item.id]:'accept-deferred-verification'},reason:{[item.id]:obligationRiskReason},expires:{[item.id]:'2026-12-01'}}},
    result=await f.engine.run('decisions.record',input);assert.equal(result.effects.recordedEntries,1);
  const snapshot=await f.capture();assert.deepEqual(await f.engine.run('decisions.record',input),result);assert.deepEqual(await f.capture(),snapshot);
  await assert.rejects(f.engine.run('decision.risk',f.riskInput(undefined,{operationId:'a-different-attempt-to-accept-the-same-risk'})),{code:'RISK_ALREADY_DECIDED'});
  const next=(await f.engine.run('decisions.list',{})).manifest.policy;
  assert.equal(next.offered.filter(row=>row.kind==='obligation-risk').length,1);
  assert.equal(next.offered.find(row=>row.kind==='obligation-risk').options[0].id,'revoke-risk');
});
test('a real replacement verification generation overtakes its old risk even if the missing status is unchanged',{timeout:120000},async t=>{
  const f=await namespaceObligationRiskFixture(t);await f.engine.run('decision.risk',f.riskInput());
  f.control.permissions.push('phase.reject');
  const {manifest}=await f.engine.run('phase.review',{phaseId:'release'});
  await f.engine.run('phase.reject',{phaseId:'release',target:'verify',confirm:manifest.reviewBinding.packetSha256,reason:'Replace the original inspection report with a genuinely new review generation.'});
  await f.write('verify','# Replacement inspection\n\n## Agent brief\n\nThis is a separately authored inspection generation. Its criterion evidence is still missing.\n');
  await f.review('verify');f.asReviewer();
  const report=(await f.engine.run('story.evidence',{})).manifest.report,row=report.rows.find(row=>row.id==='COMPOSED-STORY:AC-001');
  assert.equal(row.obligations.find(value=>value.responsibility==='verify').status,'missing');
  assert.ok(row.findings.some(value=>value.code==='RISK_DECISION_OVERTAKEN'));
  const next=await f.engine.run('decision.risk',f.riskInput(undefined,{operationId:'accept-replacement-inspection-risk'}));
  assert.equal(next.record.id,'RISK-002');
});
test('expiry is rechecked before the closing commit and a fresh human renewal recovers without rewriting the old report',{timeout:120000},async t=>{
  const f=await namespaceObligationRiskFixture(t);await f.engine.run('decision.risk',f.riskInput(undefined,{expires:'2026-11-10'}));
  const {manifest}=await f.engine.run('phase.review',{phaseId:'release'}),confirmation={workId:f.workId,phase:'release',generation:manifest.generation,
    reviewPacketSha256:manifest.reviewBinding.packetSha256},snapshot=await f.capture();let calls=0;
  const moving=f.make({clock:{now(){return ++calls===1?'2026-11-08T00:00:00.000Z':'2026-11-11T00:00:00.000Z';}}});
  await assert.rejects(moving.run('phase.approve',{phaseId:'release',confirmation}),{code:'ENGINE_TERMINAL_EVIDENCE_REQUIRED'});
  assert.deepEqual(await f.capture(),snapshot);f.control.now='2026-11-11T00:00:00.000Z';
  await f.engine.run('decision.risk',f.riskInput(undefined,{operationId:'renew-expired-inspection-risk'}));
  const result=await f.engine.run('phase.approve',{phaseId:'release',confirmation});assert.equal(result.approval.selfApproval,false);
  const current=await f.capture();assert.equal(current.workflow.namespaceObligationRisks.length,2);assert.equal(current.workflow.phases.release.approvals.length,1);
});
test('risk inspection preserves real content permission and timeout errors before any human record',{timeout:120000},async t=>{
  const f=await namespaceObligationRiskFixture(t),view=await f.engine.run('story.evidence',{}),target=view.manifest.references.find(row=>row.namespace==='evidence'),snapshot=await f.capture();
  for(const code of ['EACCES','ETIMEDOUT']){
    const failure=Object.freeze(Object.assign(Error('The original evidence read failed.'),{code,details:{deadlineMs:923}})),
      engine=f.make({content:{...f.content,read(scope,reference,options){if(reference.sha256===target.sha256)throw failure;return f.content.read(scope,reference,options);}}});
    await assert.rejects(engine.run('decision.risk',f.riskInput()),error=>error===failure);
  }assert.deepEqual(await f.capture(),snapshot);
});
test('a lost risk acknowledgement preserves the timeout and reconciles the original receipt once',{timeout:120000},async t=>{
  const f=await namespaceObligationRiskFixture(t),failure=Object.freeze(Object.assign(Error('The accepted decision reply timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:1123}}));let lost=false;
  const records={...f.records,async transact(...args){const accepted=await f.records.transact(...args);
    if(!lost&&args[1].events.some(row=>row.payload?.operation==='decision.risk')){lost=true;throw failure;}return accepted;}};
  await assert.rejects(f.make({records}).run('decision.risk',f.riskInput()),error=>error===failure);assert.equal(lost,true);
  const snapshot=await f.capture(),replay=f.make({working:null,clock:{now(){throw Error('Do not restamp an accepted human decision.');}}}),
    result=await replay.run('decision.risk',f.riskInput());assert.equal(result.status,'retained');assert.equal(result.effects.committed,false);
  assert.equal(snapshot.workflow.namespaceObligationRisks.length,1);assert.deepEqual(await f.capture(),snapshot);
});
test('unknown, pending, scope, review, wrong authority and private observations cannot become risk acceptance',{timeout:120000},async t=>{
  const f=await namespaceObligationRiskFixture(t),snapshot=await f.capture();
  for(const obligationId of ['unknown','OBL:composed-story:scope:unknown','OBL:composed-story:review:COMPOSED-STORY:AC-001'])
    await assert.rejects(f.engine.run('decision.risk',f.riskInput(obligationId)),{code:'RISK_NOT_WAIVABLE'});
  f.control.identity={name:'Unrelated',email:'unrelated@example.test',login:null};
  await assert.rejects(f.engine.run('decision.risk',f.riskInput()),error=>['APPROVAL_AUTHORITY_REQUIRED','APPROVAL_IDENTITY_NOT_AUTHORIZED'].includes(error.code));
  f.asReviewer();await assert.rejects(f.engine.run('decision.risk',{...f.riskInput(),observed:{status:'missing'}}),{code:'ENGINE_INPUT_INVALID'});
  assert.deepEqual(await f.capture(),snapshot);
});
test('renewal and revocation retain original receipts and cannot conceal a second missing criterion',{timeout:120000},async t=>{
  const f=await namespaceObligationRiskFixture(t,{secondCriterion:true});await f.engine.run('decision.risk',f.riskInput());
  const snapshot=await f.capture();await assert.rejects(f.review('release'),error=>error.code==='ENGINE_TERMINAL_EVIDENCE_REQUIRED'
    &&error.details.rows.some(row=>row.id==='COMPOSED-STORY:AC-002'));assert.deepEqual(await f.capture(),snapshot);
  await f.engine.run('decision.risk',{operationId:'withdraw-original-risk',revoke:'RISK-001',reason:obligationRiskReason});
  assert.equal((await f.engine.run('story.evidence',{})).manifest.report.rows.find(row=>row.id==='COMPOSED-STORY:AC-001').obligations.find(row=>row.responsibility==='verify').status,'missing');
  const renewed=await f.engine.run('decision.risk',f.riskInput(undefined,{operationId:'renew-original-risk',reason:obligationRiskReason+' Renewed for the same observation.'}));
  assert.equal(renewed.record.id,'RISK-002');
  const rows=(await f.capture()).workflow.namespaceObligationRisks;assert.equal(rows.length,3);assert.equal(rows[0].id,'RISK-001');assert.equal(rows[1].revokes,'RISK-001');
});
