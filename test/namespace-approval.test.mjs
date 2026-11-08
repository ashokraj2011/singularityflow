import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceApprovalFixture} from './helpers/namespace-approval-fixture.mjs';
import {createNamespaceReadEngine} from '../src/engine-storage/namespace-reader.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {createNamespaceLifecycleCommitter} from '../src/engine-storage/namespace-lifecycle-commit.mjs';
const input={phaseId:'intake'};
const other={name:'Independent reviewer',email:'independent@example.test',login:null};
const reviewerAccess=(f,principalId,identity)=>({current:()=>({projectId:f.scope.projectId,principalId,actorKind:'human',identity,
  agentId:null,permissions:['phase.approve']})});
const independent=source=>{source.definition.approvalAuthorities.reviewers.members.push({email:other.email});
  source.definition.phases.intake.approval.allowSelfApproval=false;};

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: an actual namespace Story reaches human-approved completion and preserves its original vote receipt`,async t=>{
  const f=await namespaceApprovalFixture(t,{backend});await f.submit();const before=await f.capture(),privateHead=await f.localRecords.list(f.scope,'local',{limit:100});
  const confirmation=await f.confirmation(),result=await f.makeApproval().run('phase.approve',{phaseId:'intake',confirmation});
  assert.equal(result.status,'recorded');assert.equal(result.approval.thresholdReached,true);assert.equal(result.approval.selfApproval,true);
  const after=await f.capture(),phase=after.workflow.phases.intake;
  assert.equal(after.workflow.status,'closed');assert.equal(after.workflow.currentPhase,null);assert.equal(phase.status,'approved');
  assert.equal(phase.approvals.length,1);assert.equal(phase.approvals[0].reviewPacketSha256,confirmation.reviewPacketSha256);
  assert.equal(result.revision,after.revision);assert.equal(result.currentPhase,null);assert.deepEqual(result.effects,{committed:true,pushed:false});
  assert.deepEqual(phase.artifacts,before.workflow.phases.intake.artifacts);assert.deepEqual(phase.checks,[]);
  assert.deepEqual(await f.localRecords.list(f.scope,'local',{limit:100}),privateHead);
  const vote=JSON.parse(Buffer.from((await f.content.read(f.scope,phase.approvals[0].namespaceVote.record)).data));
  assert.equal(vote.actor.principalId,f.control.principalId);assert.equal(vote.recordedAt,phase.approvedAt);
  assert.equal(Object.hasOwn(vote,'sourceCommit'),false);assert.equal(Object.hasOwn(vote,'testsPassed'),false);
  const reader=createNamespaceReadEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId});
  const review=await reader.run('phase.review',{phaseId:'intake'});assert.equal(review.manifest.integrity,'matched');assert.equal(review.manifest.reviewBinding,null);
  assert.equal((await reader.run('document.read',{reference:review.manifest.items[0].reference})).document.content.text.includes('Actual intake result'),true);
  const acceptedHead=await f.head();f.control.permissions=[];
  f.control.agentId=null;
  const noWrites={...f.records,transact(){throw Error('Acknowledgement cannot create another write.');}};
  assert.deepEqual(await f.makeApproval({records:noWrites,clock:{now(){throw Error('Acknowledgement cannot restamp the vote.');}}}).run('phase.approve',{phaseId:'intake'}),result);
  assert.deepEqual(await f.head(),acceptedHead);
  assert.equal((await f.capture()).workflow.history.filter(item=>item.event==='phase_approved').length,1);
});

test('self-approval is refused by the pinned policy; an independent authorized human can complete the phase',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:independent});await f.submit();const confirmation=await f.confirmation(),before=await f.head();
  await assert.rejects(f.makeApproval().run('phase.approve',{...input,confirmation}),{code:'APPROVAL_SELF_APPROVAL_PROHIBITED'});
  assert.deepEqual(await f.head(),before);
  const result=await f.makeApproval({access:reviewerAccess(f,'independent-reviewer',other)}).run('phase.approve',{...input,confirmation});
  assert.equal(result.approval.selfApproval,false);assert.equal(result.approval.actorId,'independent-reviewer');
  assert.equal((await f.capture()).workflow.status,'closed');
});

test('an authenticated author cannot gain independence by changing their email address',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:independent});await f.submit();const confirmation=await f.confirmation();
  const access=reviewerAccess(f,f.control.principalId,other);
  await assert.rejects(f.makeApproval({access}).run('phase.approve',{...input,confirmation}),{code:'APPROVAL_SELF_APPROVAL_PROHIBITED'});
  assert.equal((await f.capture()).workflow.phases.intake.approvals.length,0);
});

test('two required authorities need distinct human votes; acknowledging an earlier vote returns its original outcome',async t=>{
  const second={name:'Security reviewer',email:'security@example.test',login:null};
  const f=await namespaceApprovalFixture(t,{configure:source=>{
    source.definition.approvalAuthorities.reviewers.members.push({email:other.email});
    source.definition.approvalAuthorities.security={label:'Security',members:[{email:second.email}]};
    source.definition.phases.intake.approval={authorities:['reviewers','security'],requiredAuthorities:['reviewers','security'],minimum:2,rejectTo:['intake'],allowSelfApproval:false};
  }});await f.submit();const confirmation=await f.confirmation();
  const first=f.makeApproval({access:reviewerAccess(f,'independent',other)}),security=f.makeApproval({access:reviewerAccess(f,'security',second)});
  const partial=await first.run('phase.approve',{...input,confirmation});assert.equal(partial.approval.thresholdReached,false);
  assert.equal(partial.currentPhase,'intake');assert.equal((await f.capture()).workflow.phases.intake.status,'awaiting_approval');
  await assert.rejects(f.makeApproval({access:reviewerAccess(f,'another-principal-same-person',other)}).run('phase.approve',{...input,confirmation}),
    {code:'APPROVAL_IDENTITY_ALREADY_RECORDED'});
  const complete=await security.run('phase.approve',{...input,confirmation});assert.equal(complete.approval.thresholdReached,true);
  const after=await f.capture();assert.equal(after.workflow.status,'closed');assert.equal(after.workflow.phases.intake.approvals.length,2);
  assert.deepEqual(await first.run('phase.approve',input),partial,'acknowledgement is the original vote, not a new present-state claim');
  assert.equal((await f.capture()).revision,after.revision);
});

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: two authored phases complete through registered operations with a different reviewing principal`,async t=>{
  const f=await namespaceApprovalFixture(t,{backend,configure:source=>{
    independent(source);
    source.definition.phases['final-review']={...structuredClone(source.definition.phases.intake),label:'Final review',
      artifact:{path:'artifacts/final-review/report.md'},defaultTemplate:'intake.md',inputs:[{phase:'intake'}],
      approval:{authorities:['reviewers'],minimum:1,rejectTo:['final-review'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('final-review');source.agents[0].phases.push('final-review');source.agents[0].defaultFor.push('final-review');
  }});
  const human=f.makeApproval({access:reviewerAccess(f,'independent',other)});
  for(const phaseId of ['intake','final-review']) {
    await f.submit(phaseId);const confirmation=await f.confirmation(human,phaseId);
    const approved=await human.run('phase.approve',{phaseId,confirmation});assert.equal(approved.approval.thresholdReached,true);
    assert.equal(approved.currentPhase,phaseId==='intake'?'final-review':null);
  }
  const complete=await f.capture();assert.equal(complete.workflow.status,'closed');
  assert.deepEqual(Object.values(complete.workflow.phases).map(phase=>[phase.status,phase.generation,phase.approvals.length]),[['approved',1,1],['approved',1,1]]);
  for(const phaseId of ['intake','final-review'])assert.equal((await human.run('phase.review',{phaseId})).manifest.integrity,'matched');
});

test('revoked permission preserves a prepared vote and restoring it resumes its original timestamp',async t=>{
  const f=await namespaceApprovalFixture(t);await f.submit();const confirmation=await f.confirmation(),at=f.control.now;let calls=0;
  f.control.draftHook=(_count,request)=>{if(request.operation==='phase.approve'&&++calls===3)f.control.permissions=f.control.permissions.filter(item=>item!=='phase.approve');};
  await assert.rejects(f.makeApproval().run('phase.approve',{...input,confirmation}),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.equal((await f.capture()).workflow.phases.intake.approvals.length,0);
  f.control.draftHook=()=>{};f.control.permissions.push('phase.approve');
  const result=await f.makeApproval({clock:{now(){throw Error('Resume the original prepared human vote.');}}}).run('phase.approve',{
    ...input,workId:f.inputs.workId,confirmation,fetch:false,agent:'analyst',checklist:[],witnessMappings:[],bindingDecisions:[],confirmEvidence:false});
  assert.equal(result.approval.thresholdReached,true);assert.equal((await f.capture()).workflow.phases.intake.approvedAt,at);
});

test('changing the authenticated person after preparation cannot accept another persons vote',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:source=>source.definition.approvalAuthorities.reviewers.members.push({email:other.email})});
  await f.submit();const confirmation=await f.confirmation(),original={principalId:f.control.principalId,creator:structuredClone(f.control.creator)};let candidate=null;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    const prepared=tx.changes.find(change=>change.namespace==='runtime'&&change.value?.operation==='phase.approve');
    if(prepared&&!candidate){candidate={key:prepared.key,value:structuredClone(prepared.value)};f.control.principalId='another-reviewer';f.control.creator=other;}return result;}};
  await assert.rejects(f.makeApproval({records}).run('phase.approve',{...input,confirmation}),{code:'ENGINE_ACTOR_CHANGED'});
  assert.equal((await f.capture()).workflow.phases.intake.approvals.length,0);Object.assign(f.control,original);
  await f.makeApproval({clock:{now(){throw Error('The original reviewer resumes the retained timestamp.');}}}).run('phase.approve',{...input,confirmation});
  assert.deepEqual((await f.records.read(f.scope,'runtime',candidate.key)).record.value,candidate.value);
  assert.equal((await f.capture()).workflow.phases.intake.approvals[0].principalId,original.principalId);
});

test('a lost final acknowledgement preserves the actual timeout and recovers the accepted human vote',async t=>{
  const f=await namespaceApprovalFixture(t);await f.submit();const confirmation=await f.confirmation();let lost=false;
  const timeout=Object.freeze(Object.assign(new Error('actual final acknowledgement deadline'),{code:'ETIMEDOUT',details:{deadlineMs:300000}}));
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(!lost&&tx.changes.some(change=>change.namespace==='evidence'&&change.value?.operation==='phase.approve')){lost=true;throw timeout;}return result;}};
  await assert.rejects(f.makeApproval({records}).run('phase.approve',{...input,confirmation}),error=>error===timeout);
  const accepted=await f.capture();assert.equal(accepted.workflow.status,'closed');
  const result=await f.makeApproval({clock:{now(){throw Error('The committed vote cannot be restamped.');}}}).run('phase.approve',input);
  assert.equal(result.revision,accepted.revision);assert.equal((await f.capture()).workflow.phases.intake.approvals.length,1);
});

test('accepted approval acknowledgements survive writer fencing and do not create another decision',async t=>{
  const f=await namespaceApprovalFixture(t);await f.submit();const confirmation=await f.confirmation();
  const result=await f.makeApproval().run('phase.approve',{...input,confirmation}),authority=await f.readAuthority();
  await f.records.transact(f.scope,{operationId:'fence-approved-writer',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:authority.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...authority.record.value,status:'fenced'}}],events:[]});
  f.control.permissions=[];
  assert.deepEqual(await f.makeApproval({clock:{now(){throw Error('Do not authorize a new approval while fenced.');}}}).run('phase.approve',input),result);
});

test('corrupt active vote metadata cannot contribute to approval or be acknowledged as a receipt',async t=>{
  const f=await namespaceApprovalFixture(t);await f.submit();const confirmation=await f.confirmation();
  await f.makeApproval().run('phase.approve',{...input,confirmation});const head=await f.head();
  const body=JSON.parse(Buffer.from((await f.content.read(f.scope,head.record.value.state)).data));
  body.workflow.phases.intake.approvals[0].selfApproval=false;
  const corrupted=(await f.content.put(f.scope,'state',Buffer.from(canonicalJson(body)))).reference;
  await f.records.transact(f.scope,{operationId:'inject-inconsistent-vote-metadata',preconditions:[{namespace:'state',key:head.record.key,version:head.record.version}],
    changes:[{op:'put',namespace:'state',key:head.record.key,immutable:false,value:{...head.record.value,state:corrupted}}],events:[]});
  await assert.rejects(f.makeApproval().run('phase.approve',input),{code:'ENGINE_STORAGE_CORRUPT'});
});

test('another authorized vote after preparation preserves the old candidate and requires a fresh quorum basis',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:source=>{
    source.definition.approvalAuthorities.reviewers.members.push({email:other.email});source.definition.phases.intake.approval.minimum=2;
  }});await f.submit();const confirmation=await f.confirmation();let candidate=null;
  const independent=f.makeApproval({access:reviewerAccess(f,'independent',other)});
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    const prepared=tx.changes.find(change=>change.namespace==='runtime'&&change.value?.operation==='phase.approve');
    if(prepared&&!candidate){candidate={key:prepared.key,value:structuredClone(prepared.value)};
      await independent.run('phase.approve',{...input,confirmation});}return result;}};
  await assert.rejects(f.makeApproval({records}).run('phase.approve',{...input,confirmation}),{code:'ENGINE_CONTEXT_CHANGED'});
  const moved=await f.capture();assert.equal(moved.workflow.phases.intake.approvals.length,1);assert.equal(moved.workflow.phases.intake.status,'awaiting_approval');
  await f.makeApproval().run('phase.approve',{...input,confirmation});
  assert.deepEqual((await f.records.read(f.scope,'runtime',candidate.key)).record.value,candidate.value);
  const after=await f.capture();assert.equal(after.workflow.status,'closed');assert.equal(after.workflow.phases.intake.approvals.length,2);
  assert.deepEqual(after.workflow.phases.intake.approvals[0],moved.workflow.phases.intake.approvals[0]);
  await assert.rejects(createNamespaceLifecycleCommitter({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,
    authority:f.authority}).commit(candidate.value.operationId),{code:'SDA_NAMESPACE_REVISION_CONFLICT'});
});

test('concurrent approval attempts for one person record one vote and reconcile the original receipt',async t=>{
  const f=await namespaceApprovalFixture(t);await f.submit();const confirmation=await f.confirmation();let sample=0;
  const clock={now:()=>sample++?'2026-11-08T01:00:00.000Z':'2026-11-08T00:00:00.000Z'};
  const results=await Promise.allSettled([f.makeApproval({clock}).run('phase.approve',{...input,confirmation}),f.makeApproval({clock}).run('phase.approve',{...input,confirmation})]);
  assert.ok(results.some(result=>result.status==='fulfilled'));
  for(const result of results)if(result.status==='rejected')assert.ok(['ENGINE_CONTEXT_CHANGED','SDA_NAMESPACE_REVISION_CONFLICT'].includes(result.reason.code),result.reason.stack);
  const replay=await f.makeApproval({clock:{now(){throw Error('Reconcile the committed vote.');}}}).run('phase.approve',input);
  const after=await f.capture();assert.equal(after.workflow.phases.intake.approvals.length,1);assert.equal(replay.revision,after.revision);
  for(const result of results)if(result.status==='fulfilled')assert.deepEqual(result.value,replay);
});

test('unqualified identities and read-only agents cannot create approval votes',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:source=>source.agents.push({id:'independent-source-reviewer',label:'Independent source reviewer',
    phases:['intake'],defaultFor:[],mode:'read-only-review',body:source.agents[0].body,skills:[],instructions:[]})});
  await f.submit();const confirmation=await f.confirmation(),before=await f.head();
  await assert.rejects(f.makeApproval({access:reviewerAccess(f,'not-a-member',{name:'Other human',email:'other@example.test',login:null})}).run('phase.approve',{...input,confirmation}),
    {code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});
  f.control.agentId='independent-source-reviewer';
  await assert.rejects(f.makeApproval().run('phase.approve',{...input,confirmation}),{code:'SOURCE_REVIEW_REVIEWER_CANNOT_APPROVE'});
  assert.deepEqual(await f.head(),before);
});

test('an exact submitted packet and authenticated human permission are required before any approval write',async t=>{
  const f=await namespaceApprovalFixture(t);
  await assert.rejects(f.makeApproval().run('phase.approve',{phaseId:'intake'}),{code:'PHASE_GENERATION_REQUIRED'});
  await f.submit();const confirmation=await f.confirmation(),before=await f.head();
  await assert.rejects(f.makeApproval().run('phase.approve',{phaseId:'intake'}),{code:'ENGINE_APPROVAL_CONFIRMATION_REQUIRED'});
  await assert.rejects(f.makeApproval().run('phase.approve',{phaseId:'intake',confirmation:{...confirmation,reviewPacketSha256:'0'.repeat(64)}}),{code:'ENGINE_APPROVAL_CONFIRMATION_STALE'});
  f.control.permissions=f.control.permissions.filter(item=>item!=='phase.approve');
  await assert.rejects(f.makeApproval().run('phase.approve',{phaseId:'intake',confirmation}),{code:'ENGINE_AUTHORITY_REQUIRED'});
  f.control.permissions.push('phase.approve');f.control.actorKind='service';
  await assert.rejects(f.makeApproval().run('phase.approve',{phaseId:'intake',confirmation}),{code:'ENGINE_HUMAN_AUTHORITY_REQUIRED'});
  assert.deepEqual(await f.head(),before);
});

for(const stage of ['read','write'])test(`actual ${stage} failures retain their permission/timeout details without recording approval`,async t=>{
  const f=await namespaceApprovalFixture(t);await f.submit();const confirmation=await f.confirmation(),snapshot=await f.capture(),before=await f.head();
  const failure=Object.freeze(Object.assign(new Error(stage==='read'?'actual remote object deadline':'actual evidence permission failure'),
    {code:stage==='read'?'ETIMEDOUT':'EACCES',details:{stage,deadlineMs:300000}}));
  const content={...f.content,
    async read(scope,reference,options){if(stage==='read'&&reference.sha256===snapshot.workflow.phases.intake.namespaceSubmission.record.sha256)throw failure;
      return f.content.read(scope,reference,options);},
    async put(scope,namespace,data,options){if(stage==='write'&&namespace==='evidence')throw failure;return f.content.put(scope,namespace,data,options);}};
  await assert.rejects(f.makeApproval({content}).run('phase.approve',{...input,confirmation}),error=>error===failure);
  assert.deepEqual(await f.head(),before);
});

test('additional approval features require actual owners instead of silently accepting caller attestations',async t=>{
  const f=await namespaceApprovalFixture(t);await f.submit();const confirmation=await f.confirmation(),before=await f.head();
  for(const extra of [{fetch:true},{confirmEvidence:true},{checklist:[{article:'fabricated',answer:'yes'}]}]) {
    await assert.rejects(f.makeApproval().run('phase.approve',{...input,confirmation,...extra}),error=>error.code==='ENGINE_PORT_UNAVAILABLE'
      &&error.details.operation==='phase.approve'&&error.details.required.length>0);
  }
  assert.deepEqual(await f.head(),before);
});

test('future vote schemas retain their upgrade error and are never interpreted as a missing approval',async t=>{
  const f=await namespaceApprovalFixture(t);await f.submit();const confirmation=await f.confirmation();
  await f.makeApproval().run('phase.approve',{...input,confirmation});const head=await f.head();
  const body=JSON.parse(Buffer.from((await f.content.read(f.scope,head.record.value.state)).data)),decision=body.workflow.phases.intake.approvals[0];
  const vote=JSON.parse(Buffer.from((await f.content.read(f.scope,decision.namespaceVote.record)).data));vote.schemaVersion=2;
  decision.namespaceVote.record=(await f.content.put(f.scope,'evidence',Buffer.from(canonicalJson(vote)))).reference;
  const future=(await f.content.put(f.scope,'state',Buffer.from(canonicalJson(body)))).reference;
  await f.records.transact(f.scope,{operationId:'inject-future-vote',preconditions:[{namespace:'state',key:head.record.key,version:head.record.version}],
    changes:[{op:'put',namespace:'state',key:head.record.key,immutable:false,value:{...head.record.value,state:future}}],events:[]});
  await assert.rejects(f.makeApproval().run('phase.approve',input),error=>error.code==='ENGINE_STORAGE_UNSUPPORTED'&&error.cause.code==='SCHEMA_VERSION_FUTURE');
});
