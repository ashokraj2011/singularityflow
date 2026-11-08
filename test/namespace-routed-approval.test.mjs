/** Real registered document workflows; approvals come from a separate authenticated test human. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceApprovalFixture} from './helpers/namespace-approval-fixture.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {reviewer,access,configure,approval,confirmation,authorSubmit} from './helpers/namespace-routing-fixture.mjs';

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: a real human threshold applies the retained branch and reopens its original receipt`,async t=>{
  const f=await namespaceApprovalFixture(t,{backend,configure:configure()});await authorSubmit(f,'intake',{channel:'Web'});
  const engine=approval(f),confirmed=await confirmation(f,engine,'intake');
  const result=await engine.run('phase.approve',{phaseId:'intake',confirmation:confirmed}),snapshot=await f.capture();
  assert.equal(result.currentPhase,'release');assert.equal(result.approval.selfApproval,false);assert.equal(result.approval.thresholdReached,true);
  assert.equal(snapshot.workflow.phases.review.status,'skipped');assert.equal(snapshot.workflow.phases.release.status,'in_progress');
  assert.equal(snapshot.workflow.namespaceApprovalReceipts.length,1);
  const vote=JSON.parse(Buffer.from((await f.content.read(f.scope,snapshot.workflow.phases.intake.approvals[0].namespaceVote.record)).data));
  assert.equal(vote.schemaVersion,2);assert.equal(vote.routing.outcome.kind,'forward');assert.equal(vote.actor.principalId,'independent-reviewer');
  const head=await f.head(),replayed=await f.makeApproval({access:access(f,[]),clock:{now(){throw Error('An accepted routed vote cannot be restamped.');}}})
    .run('phase.approve',{phaseId:'intake',confirmation:confirmed});
  assert.deepEqual(replayed,result);assert.deepEqual(await f.head(),head);
});

test('reused routing values carry actual earlier vote proof and issue all four exact document references',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:configure('branch',{reuse:true})}),engine=approval(f);
  await authorSubmit(f,'intake',{channel:'Web'});
  await engine.run('phase.approve',{phaseId:'intake',confirmation:await confirmation(f,engine,'intake')});
  await authorSubmit(f,'review');
  const context=await engine.run('phase.review.resources',{phaseId:'review'});assert.equal(context.manifest.resources.length,4);
  for(const resource of context.manifest.resources)assert.equal((await engine.run('document.read',{reference:resource.reference})).document.integrity,'matched');
  const packet=JSON.parse((await engine.run('document.read',{reference:context.manifest.resources[0].reference})).document.content.text);
  assert.deepEqual(packet.routing.reused[0].values,{channel:'Web'});assert.equal(packet.routing.reused[0].phase,'intake');
  assert.equal((await engine.run('phase.approve',{phaseId:'review',confirmation:await confirmation(f,engine,'review')})).currentPhase,'release');
  await authorSubmit(f,'release');await engine.run('phase.approve',{phaseId:'release',confirmation:await confirmation(f,engine,'release')});
  assert.equal((await f.capture()).workflow.status,'closed');
});

test('an approved ask decision retains its unanswered question and repeats no authoring or approval',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:configure('ask')}),engine=approval(f);await authorSubmit(f,'intake');
  const confirmed=await confirmation(f,engine,'intake'),result=await engine.run('phase.approve',{phaseId:'intake',confirmation:confirmed});
  const snapshot=await f.capture(),pending=snapshot.workflow.pendingDecision;
  assert.equal(result.currentPhase,'intake');assert.equal(snapshot.workflow.phases.intake.status,'approved');
  assert.match(pending.key,/^[a-f0-9]{16}$/u);assert.deepEqual(pending.options.map(item=>item.id),['continue','finish']);
  assert.equal(snapshot.workflow.phases.review.status,'not_started');assert.equal(snapshot.workflow.decisionLog.length,1);
  const head=await f.head();assert.deepEqual(await engine.run('phase.approve',{phaseId:'intake',confirmation:confirmed}),result);assert.deepEqual(await f.head(),head);
});

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: actual loop rework republishes successors and retains the earlier vote through final completion`,async t=>{
  const f=await namespaceApprovalFixture(t,{backend,configure:configure('loop')}),engine=approval(f);
  await authorSubmit(f,'intake');await engine.run('phase.approve',{phaseId:'intake',confirmation:await confirmation(f,engine,'intake')});
  await authorSubmit(f,'review',{verdict:'Repair'});const firstConfirmation=await confirmation(f,engine,'review');
  const first=await engine.run('phase.approve',{phaseId:'review',confirmation:firstConfirmation}),reopened=await f.capture();
  assert.equal(first.currentPhase,'intake');assert.equal(reopened.workflow.phases.intake.status,'in_progress');
  assert.equal(reopened.workflow.phases.review.status,'not_started');assert.equal(reopened.workflow.phases.review.approvals[0].invalidatedAt!==undefined,true);
  assert.equal(reopened.workflow.decisionRounds.quality.count,1);assert.equal(reopened.workflow.changeRequests[0].status,'open');
  await assert.rejects(engine.run('phase.review.resources',{phaseId:'intake'}),error=>error.code==='PHASE_GENERATION_REQUIRED'&&error.details.actions[0].operation==='phase.prepare');
  assert.deepEqual(await engine.run('phase.approve',{phaseId:'review',confirmation:firstConfirmation}),first);
  await authorSubmit(f,'intake');await engine.run('phase.approve',{phaseId:'intake',confirmation:await confirmation(f,engine,'intake')});
  assert.equal((await f.capture()).workflow.changeRequests[0].status,'resolved');
  await authorSubmit(f,'review',{verdict:'Pass'});await engine.run('phase.approve',{phaseId:'review',confirmation:await confirmation(f,engine,'review')});
  await authorSubmit(f,'release');await engine.run('phase.approve',{phaseId:'release',confirmation:await confirmation(f,engine,'release')});
  const complete=await f.capture(),head=await f.head();assert.equal(complete.workflow.status,'closed');
  assert.equal(complete.workflow.phases.intake.generation,2);assert.equal(complete.workflow.phases.review.generation,2);
  assert.equal(complete.workflow.namespaceApprovalReceipts.length,2);
  assert.deepEqual(await engine.run('phase.approve',{phaseId:'review',confirmation:firstConfirmation}),first);assert.deepEqual(await f.head(),head);
});

test('a second failed approved round pauses at the actual limit and does not run an automatic extra round',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:configure('loop')}),engine=approval(f);
  for(let round=1;round<=2;round++) {
    await authorSubmit(f,'intake');await engine.run('phase.approve',{phaseId:'intake',confirmation:await confirmation(f,engine,'intake')});
    await authorSubmit(f,'review',{verdict:'Repair'});await engine.run('phase.approve',{phaseId:'review',confirmation:await confirmation(f,engine,'review')});
  }
  const snapshot=await f.capture();assert.equal(snapshot.workflow.currentPhase,'review');assert.equal(snapshot.workflow.phases.review.status,'approved');
  assert.equal(snapshot.workflow.pendingDecision.reason,'limit');assert.equal(snapshot.workflow.decisionRounds.quality.count,1);
  assert.equal(snapshot.workflow.changeRequests.length,1);assert.equal(snapshot.workflow.phases.release.status,'not_started');
});

test('a lost routed commit acknowledgement recovers the original receipt without a second vote or fresh permission',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:configure()});await authorSubmit(f,'intake',{channel:'Web'});
  const confirmed=await confirmation(f,approval(f),'intake'),original=Object.assign(new Error('The routed acknowledgement timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:9876}});let lost=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!lost&&args[1].events.some(item=>item.payload?.operation==='phase.approve')){lost=true;throw original;}return result;}};
  await assert.rejects(f.makeApproval({records,access:access(f)}).run('phase.approve',{phaseId:'intake',confirmation:confirmed}),error=>error===original);
  assert.equal(lost,true);const head=await f.head();
  const recovered=await f.makeApproval({access:access(f,[]),clock:{now(){throw Error('Use the original routed vote timestamp.');}}})
    .run('phase.approve',{phaseId:'intake',confirmation:confirmed});
  assert.equal(recovered.currentPhase,'release');assert.deepEqual(await f.head(),head);assert.equal((await f.capture()).workflow.namespaceApprovalReceipts.length,1);
});

test('a revoked prepared routed vote resumes its original timestamp after fresh permission is restored',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:configure()});await authorSubmit(f,'intake',{channel:'Web'});
  const confirmed=await confirmation(f,approval(f),'intake');let calls=0,permitted=true;
  const controlled={current(request){if(++calls===3)permitted=false;return access(f,permitted?['phase.approve']:[]).current(request);}};
  const head=await f.head();await assert.rejects(f.makeApproval({access:controlled}).run('phase.approve',{phaseId:'intake',confirmation:confirmed}),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.deepEqual(await f.head(),head);permitted=true;
  const result=await f.makeApproval({access:controlled,clock:{now(){throw Error('The prepared routing vote keeps its original time.');}}})
    .run('phase.approve',{phaseId:'intake',confirmation:confirmed});
  assert.equal(result.currentPhase,'release');assert.equal((await f.capture()).workflow.namespaceApprovalReceipts.length,1);
});

test('two routed authorities retain a partial first vote and one original acknowledgement after the threshold completes',async t=>{
  const security={name:'Security reviewer',email:'security@example.test',login:null};
  const f=await namespaceApprovalFixture(t,{configure:source=>{
    configure()(source);source.definition.approvalAuthorities.security={members:[{email:security.email}]};
    source.definition.phases.intake.approval={authorities:['reviewers','security'],requiredAuthorities:['reviewers','security'],minimum:2,
      rejectTo:['intake'],allowSelfApproval:false};
  }});
  await authorSubmit(f,'intake',{channel:'Web'});const firstEngine=approval(f),confirmed=await confirmation(f,firstEngine,'intake');
  const first=await firstEngine.run('phase.approve',{phaseId:'intake',confirmation:confirmed});
  assert.equal(first.approval.thresholdReached,false);assert.equal(first.currentPhase,'intake');
  const secondEngine=f.makeApproval({access:{current:()=>({projectId:f.scope.projectId,principalId:'security-reviewer',actorKind:'human',
    agentId:null,identity:security,permissions:['phase.approve']})}});
  const second=await secondEngine.run('phase.approve',{phaseId:'intake',confirmation:await confirmation(f,secondEngine,'intake')});
  assert.equal(second.approval.thresholdReached,true);assert.equal(second.currentPhase,'release');const head=await f.head();
  assert.deepEqual(await firstEngine.run('phase.approve',{phaseId:'intake',confirmation:confirmed}),first);assert.deepEqual(await f.head(),head);
  assert.equal((await f.capture()).workflow.namespaceApprovalReceipts.length,2);
});

test('a changed receipt pointer cannot replace the original accepted vote with another typed outcome',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:configure()}),engine=approval(f);await authorSubmit(f,'intake',{channel:'Web'});
  const confirmed=await confirmation(f,engine,'intake');await engine.run('phase.approve',{phaseId:'intake',confirmation:confirmed});
  const head=await f.head(),body=JSON.parse(Buffer.from((await f.content.read(f.scope,head.record.value.state)).data));
  const vote=JSON.parse(Buffer.from((await f.content.read(f.scope,body.workflow.namespaceApprovalReceipts[0].record)).data));
  vote.routing.outcome.route='mobile';
  const forged=(await f.content.put(f.scope,'evidence',Buffer.from(canonicalJson(vote)))).reference;
  body.workflow.namespaceApprovalReceipts[0].record=forged;body.workflow.phases.intake.approvals[0].namespaceVote.record=forged;
  const corrupted=(await f.content.put(f.scope,'state',Buffer.from(canonicalJson(body)))).reference;
  await f.records.transact(f.scope,{operationId:'tamper-routed-receipt',preconditions:[{namespace:'state',key:head.record.key,version:head.record.version}],
    changes:[{op:'put',namespace:'state',key:head.record.key,immutable:false,value:{...head.record.value,state:corrupted}}],events:[]});
  const before=await f.head();await assert.rejects(engine.run('phase.approve',{phaseId:'intake',confirmation:confirmed}),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.deepEqual(await f.head(),before);
});
