/** Real submitted/approved questions and human choices over the registered namespace runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceApprovalFixture} from './helpers/namespace-approval-fixture.mjs';
import {configure,approval,confirmation,authorSubmit,access} from './helpers/namespace-routing-fixture.mjs';
import {createNamespaceRoutingChoiceEngine} from '../src/engine-storage/namespace-routing-choice.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
const make=(f,extra={})=>createNamespaceRoutingChoiceEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,
  authority:f.authority,access:access(f,['decision.choose']),clock:f.clock,...extra});
async function pending(t,options={}) {
  const f=await namespaceApprovalFixture(t,{...options,configure:options.configure??configure('ask')}),authorApproval=approval(f);
  await authorSubmit(f,'intake');await authorApproval.run('phase.approve',{phaseId:'intake',confirmation:await confirmation(f,authorApproval,'intake')});
  const engine=make(f),context=await engine.run('decision.context');
  return {...f,authorApproval,choiceEngine:engine,question:context.manifest.question};
}
const choose=(f,extra={})=>({workId:f.inputs.workId,option:'continue',expected:f.question.key,reason:'Human reviewed and chose this route.',...extra});
async function corruptState(f,change,id) {
  const head=await f.head(),body=JSON.parse(Buffer.from((await f.content.read(f.scope,head.record.value.state)).data));
  await change(body.workflow);const state=(await f.content.put(f.scope,'state',Buffer.from(canonicalJson(body)))).reference;
  await f.records.transact(f.scope,{operationId:id,preconditions:[{namespace:'state',key:head.record.key,version:head.record.version}],
    changes:[{op:'put',namespace:'state',key:head.record.key,immutable:false,value:{...head.record.value,state}}],events:[]});
}

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: a human choice resumes the real Story and preserves its original receipt through completion`,async t=>{
  const f=await pending(t,{backend}),before=await f.head();
  const shown=await f.choiceEngine.run('decision.context');assert.deepEqual(await f.head(),before);
  assert.equal(shown.manifest.proof.generation,1);assert.match(shown.manifest.proof.approvalSha256,/^[a-f0-9]{64}$/u);
  const input=choose(f),first=await f.choiceEngine.run('decision.choose',input),snapshot=await f.capture();
  assert.equal(first.currentPhase,'review');assert.equal(first.recordKind,'routing');assert.equal(first.actorId,'independent-reviewer');
  assert.equal(first.record.profile,'sflow-human-routing-choice/v1');assert.equal(snapshot.workflow.pendingDecision,undefined);
  assert.equal(snapshot.workflow.namespaceRoutingChoiceReceipts.length,1);assert.equal(snapshot.workflow.phases.review.status,'in_progress');
  for(const phaseId of ['review','release']) {
    await authorSubmit(f,phaseId);await f.authorApproval.run('phase.approve',{phaseId,confirmation:await confirmation(f,f.authorApproval,phaseId)});
  }
  const head=await f.head();assert.equal((await f.capture()).workflow.status,'closed');
  assert.equal((await f.choiceEngine.run('decision.context')).manifest.question,null);
  const replay=await make(f,{access:access(f,[]),clock:{now(){throw Error('An accepted choice keeps its original timestamp.');}}}).run('decision.choose',input);
  assert.deepEqual(replay,first);assert.deepEqual(await f.head(),head);
});

test('an explicit human end choice leaves skipped phases without approvals or invented tests',async t=>{
  const f=await pending(t),result=await f.choiceEngine.run('decision.choose',choose(f,{option:'finish'})),snapshot=await f.capture();
  assert.equal(result.currentPhase,null);assert.equal(snapshot.workflow.status,'closed');
  for(const id of ['review','release']) {assert.equal(snapshot.workflow.phases[id].status,'skipped');assert.deepEqual(snapshot.workflow.phases[id].approvals,[]);}
  assert.equal(snapshot.workflow.phases.intake.approvals.length,1);assert.equal(snapshot.workflow.history.filter(item=>item.event==='decision_made').length,1);
});

test('generation-bound question keys separate repeated asks under an equal application clock',async t=>{
  const f=await pending(t,{configure:source=>{configure('ask')(source);
    source.definition.workTypes.simple.decisions[0].routes[0]={id:'again',label:'Another actual round',to:'intake'};}});
  const input=choose(f,{option:'again'}),first=await f.choiceEngine.run('decision.choose',input);
  assert.equal(first.currentPhase,'intake');await authorSubmit(f,'intake');
  await f.authorApproval.run('phase.approve',{phaseId:'intake',confirmation:await confirmation(f,f.authorApproval,'intake')});
  const next=await f.choiceEngine.run('decision.context'),head=await f.head();
  assert.equal(next.manifest.question.generation,2);assert.equal(next.manifest.question.askedAt,f.question.askedAt);
  assert.notEqual(next.manifest.question.key,f.question.key);
  assert.deepEqual(await f.choiceEngine.run('decision.choose',input),first);assert.deepEqual(await f.head(),head);
  const finish=await f.choiceEngine.run('decision.choose',choose(f,{option:'finish',expected:next.manifest.question.key}));
  assert.equal(finish.currentPhase,null);assert.equal((await f.capture()).workflow.namespaceRoutingChoiceReceipts.length,2);
});

test('an exhausted loop permits explicit human rework without inventing a passing verdict',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:source=>{configure('loop')(source);source.definition.workTypes.simple.decisions[0].enforceConditions=true;}}),engine=approval(f);
  for(let round=1;round<=2;round++) {
    await authorSubmit(f,'intake');await engine.run('phase.approve',{phaseId:'intake',confirmation:await confirmation(f,engine,'intake')});
    await authorSubmit(f,'review',{verdict:'Repair'});await engine.run('phase.approve',{phaseId:'review',confirmation:await confirmation(f,engine,'review')});
  }
  const chooser=make(f),context=await chooser.run('decision.context'),question=context.manifest.question;
  assert.equal(question.reason,'limit');assert.deepEqual(question.reopenableSteps,['intake']);
  const head=await f.head();
  await assert.rejects(chooser.run('decision.choose',{expected:question.key,option:'goal-met',reason:'Pretend it passed.'}));
  await assert.rejects(chooser.run('decision.choose',{expected:question.key,to:'release',reason:'Skip the failing condition.'}),{code:'DECISION_STEP_NOT_ALLOWED'});
  assert.deepEqual(await f.head(),head);
  const result=await chooser.run('decision.choose',{expected:question.key,to:'intake',reason:'The owner requests another actual repair round.'});
  const reopened=await f.capture();assert.equal(result.currentPhase,'intake');assert.equal(reopened.workflow.decisionRounds.quality.count,2);
  assert.equal(reopened.workflow.changeRequests.length,2);assert.equal(reopened.workflow.changeRequests[1].decision.by,'person');
  assert.equal(reopened.workflow.phases.review.decisionInputs,undefined);assert.equal(reopened.workflow.phases.review.generation,2);
  assert.equal(reopened.workflow.phases.release.status,'not_started');
});

test('confirmation, reason and option errors return before any accepted choice',async t=>{
  const f=await pending(t),head=await f.head(),clocks=f.control.clockCalls;
  for(const [change,code]of [[{expected:null},'ENGINE_DECISION_CONFIRMATION_REQUIRED'],[{expected:'b'.repeat(16)},'DECISION_STALE'],
    [{reason:'  '},'DECISION_REASON_REQUIRED'],[{option:'missing'},'DECISION_OPTION_UNKNOWN'],[{to:'release'},'DECISION_CHOICE_REQUIRED'],
    [{fetch:true},'ENGINE_PORT_UNAVAILABLE']])await assert.rejects(f.choiceEngine.run('decision.choose',choose(f,change)),{code});
  await assert.rejects(f.choiceEngine.run('decision.scope',{item:'SRI-1',disposition:'informative',reason:'Unrelated effect.'}),{code:'ENGINE_PORT_UNAVAILABLE'});
  assert.deepEqual(await f.head(),head);assert.equal(f.control.clockCalls,clocks);
});

test('permission and pinned group membership are distinct from an agent name',async t=>{
  const f=await pending(t),head=await f.head();
  await assert.rejects(make(f,{access:access(f,[])}).run('decision.choose',choose(f)),{code:'ENGINE_AUTHORITY_REQUIRED'});
  const unrelated={current:()=>({...access(f,['decision.choose']).current(),principalId:'unrelated',identity:{name:'Other person',email:'other@example.test'},agentId:'analyst'})};
  await assert.rejects(make(f,{access:unrelated}).run('decision.choose',choose(f)),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});
  const machine={current:()=>({...access(f,['decision.choose']).current(),actorKind:'service'})};
  await assert.rejects(make(f,{access:machine}).run('decision.choose',choose(f)),{code:'ENGINE_HUMAN_AUTHORITY_REQUIRED'});
  assert.deepEqual(await f.head(),head);
});

test('an application workflow is refused before a document-only route can bypass its production owner',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:source=>{
    configure('ask')(source);const code=source.definition.phases.release;
    code.generation={producer:'governed-agent',task:'code'};code.writeScope='source-and-artifact';code.artifact.kind='implementation-summary';
    source.definition.workTypes.simple.omits=source.definition.workTypes.simple.omits.filter(item=>item.responsibility!=='implement');
  }});
  await assert.rejects(authorSubmit(f,'intake'),error=>error.code==='ENGINE_PORT_UNAVAILABLE'
    &&error.details.operation==='phase.publish'&&error.details.required.includes('planned-claims'));
  const snapshot=await f.capture();assert.equal(snapshot.workflow.pendingDecision,undefined);assert.equal(snapshot.workflow.phases.intake.generation,0);
  assert.equal((await make(f).run('decision.context')).manifest.question,null);
});

test('a revoked prepared choice resumes its exact original timestamp after permission is restored',async t=>{
  const f=await pending(t),head=await f.head();let calls=0,permitted=true;
  const controlled={current:()=>{if(++calls===3)permitted=false;return access(f,permitted?['decision.choose']:[]).current();}};
  await assert.rejects(make(f,{access:controlled}).run('decision.choose',choose(f)),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.deepEqual(await f.head(),head);permitted=true;
  const result=await make(f,{access:controlled,clock:{now(){throw Error('Retain the prepared human timestamp.');}}}).run('decision.choose',choose(f));
  assert.equal(result.currentPhase,'review');assert.equal((await f.capture()).workflow.namespaceRoutingChoiceReceipts.length,1);
});

test('a lost commit acknowledgement preserves its real timeout and recovers without another choice',async t=>{
  const f=await pending(t),original=Object.assign(new Error('The choice acknowledgement exceeded its deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:8765}});let lost=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!lost&&args[1].events.some(item=>item.payload?.operation==='decision.choose')){lost=true;throw original;}return result;}};
  await assert.rejects(make(f,{records}).run('decision.choose',choose(f)),error=>error===original);assert.equal(lost,true);
  const head=await f.head(),result=await make(f,{access:access(f,[]),clock:{now(){throw Error('No timestamp for acknowledgement.');}}}).run('decision.choose',choose(f));
  assert.equal(result.currentPhase,'review');assert.deepEqual(await f.head(),head);assert.equal((await f.capture()).workflow.namespaceRoutingChoiceReceipts.length,1);
});

test('an old receipt acknowledges only the original human and exact normalized intent',async t=>{
  const f=await pending(t);await f.choiceEngine.run('decision.choose',choose(f));const head=await f.head();
  await assert.rejects(f.choiceEngine.run('decision.choose',choose(f,{reason:'A different intent.'})),{code:'DECISION_NOT_PENDING'});
  const another={current:()=>({...access(f,[]).current(),principalId:'another-human'})};
  await assert.rejects(make(f,{access:another}).run('decision.choose',choose(f)),{code:'DECISION_NOT_PENDING'});
  const changedIdentity={current:()=>({...access(f,[]).current(),identity:{email:'changed@example.test',name:'Changed identity'}})};
  await assert.rejects(make(f,{access:changedIdentity}).run('decision.choose',choose(f)),{code:'ENGINE_ACTOR_CHANGED'});
  assert.deepEqual(await f.head(),head);
});

test('a changed pending key cannot replace the actual approved question',async t=>{
  const f=await pending(t);await corruptState(f,workflow=>{workflow.pendingDecision.key='b'.repeat(16);},'tamper-question-key');
  const head=await f.head();
  await assert.rejects(f.choiceEngine.run('decision.context'),{code:'ENGINE_STORAGE_CORRUPT'});
  await assert.rejects(f.choiceEngine.run('decision.choose',choose(f,{expected:'b'.repeat(16)})),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.deepEqual(await f.head(),head);
});

test('missing approval bytes and real read errors retain their exact recovery identity',async t=>{
  const f=await pending(t),snapshot=await f.capture(),reference=snapshot.workflow.phases.intake.approvals[0].namespaceVote.record;
  const missing={...f.content,read(scope,ref,options){return ref.sha256===reference.sha256?Promise.resolve({status:'missing',data:null}):f.content.read(scope,ref,options);}};
  await assert.rejects(make(f,{content:missing}).run('decision.context'),error=>error.code==='ENGINE_STORAGE_CONTENT_MISSING'&&error.details.reference.sha256===reference.sha256);
  const original=Object.assign(new Error('Application content read was denied.'),{code:'EACCES',path:'opaque-app-resource'});
  const denied={...f.content,read(scope,ref,options){if(ref.sha256===reference.sha256)throw original;return f.content.read(scope,ref,options);}};
  await assert.rejects(make(f,{content:denied}).run('decision.context'),error=>error===original);
});

test('a changed live receipt pointer cannot replace an originally accepted choice',async t=>{
  const f=await pending(t);await f.choiceEngine.run('decision.choose',choose(f));
  await corruptState(f,async workflow=>{
    const link=workflow.namespaceRoutingChoiceReceipts[0],value=JSON.parse(Buffer.from((await f.content.read(f.scope,link.record)).data));
    value.recordedAt='2026-11-09T00:00:00.000Z';link.record=(await f.content.put(f.scope,'evidence',Buffer.from(canonicalJson(value)))).reference;
  },'tamper-choice-pointer');
  const head=await f.head();await assert.rejects(f.choiceEngine.run('decision.choose',choose(f)),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.deepEqual(await f.head(),head);
});

test('unknown receipt versions remain unsupported and malformed inventories remain corruption',async t=>{
  for(const future of [false,true]) {
    const f=await pending(t);if(future)await f.choiceEngine.run('decision.choose',choose(f));
    await corruptState(f,workflow=>{if(future)workflow.namespaceRoutingChoiceReceipts[0].schemaVersion=2;else workflow.namespaceRoutingChoiceReceipts=null;},'tamper-choice-inventory');
    const head=await f.head();await assert.rejects(f.choiceEngine.run('decision.choose',choose(f)),{code:future?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});
    assert.deepEqual(await f.head(),head);
  }
});

test('same-epoch fencing refuses new choices but still acknowledges a genuinely accepted original receipt',async t=>{
  const f=await pending(t),input=choose(f),first=await f.choiceEngine.run('decision.choose',input);
  const authority=await f.records.read(f.scope,'state',LIFECYCLE_AUTHORITY_KEY);
  await f.records.transact(f.scope,{operationId:'fence-after-human-choice',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:authority.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...authority.record.value,status:'fenced'}}],events:[]});
  const head=await f.head();assert.deepEqual(await make(f,{access:access(f,[])}).run('decision.choose',input),first);assert.deepEqual(await f.head(),head);
});

test('concurrent choices accept one route and leave no duplicate decision record',async t=>{
  const f=await pending(t),inputs=[choose(f),choose(f,{option:'finish'})];
  const results=await Promise.allSettled(inputs.map(input=>make(f).run('decision.choose',input)));
  const accepted=results.filter(item=>item.status==='fulfilled');assert.equal(accepted.length,1);
  const rejected=results.find(item=>item.status==='rejected');assert.ok(['ENGINE_CONTEXT_CHANGED','DECISION_NOT_PENDING','SDA_NAMESPACE_REVISION_CONFLICT'].includes(rejected.reason.code),rejected.reason.code);
  const snapshot=await f.capture(),head=await f.head();assert.equal(snapshot.workflow.namespaceRoutingChoiceReceipts.length,1);
  assert.equal(snapshot.workflow.history.filter(item=>item.event==='decision_made').length,1);
  const index=results.findIndex(item=>item.status==='fulfilled');assert.deepEqual(await f.choiceEngine.run('decision.choose',inputs[index]),accepted[0].value);
  assert.deepEqual(await f.head(),head);
});
