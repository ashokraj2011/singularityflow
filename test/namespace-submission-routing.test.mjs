import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonicalJson,NAMESPACE_SUBMISSION_SCHEMAS,namespaceSubmissionRecordProfile} from '../src/foundation/record-schema.mjs';
import {namespaceSubmissionRecord,namespaceSubmissionValue,NAMESPACE_SUBMISSION_DECISION_PROFILE} from '../src/engine-storage/namespace-submission-contract.mjs';
import {namespaceApprovalFixture} from './helpers/namespace-approval-fixture.mjs';
import {createNamespaceSubmissionEngine} from '../src/engine-storage/namespace-submission.mjs';
import {createNamespaceSubmissionReader} from '../src/engine-storage/namespace-submission-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
const capture=JSON.parse(await readFile(new URL('./fixtures/namespace-submission-packets/native-v1.json',import.meta.url),'utf8'));
const configure=source=>{source.definition.workTypes.simple.decisions=[{id:'channel',label:'Channel',after:'intake',kind:'branch',
  inputs:[{name:'channel',values:['Web','Mobile']},{name:'confidence',type:'number',minimum:0,maximum:100}],
  routes:[{id:'web',label:'Web',when:{channel:'Web'},to:'next'},{id:'other',label:'Other',to:'end',
    omits:structuredClone(source.definition.workTypes.simple.omits)}]}];};
const make=(f,extra={})=>createNamespaceSubmissionEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,
  authority:f.authority,access:f.access,clock:f.clock,...extra});

test('captured v1 submission packets retain exact bytes, schema and their original decision-free meaning',()=>{
  assert.equal(capture.baseline,'e34bcd6e2');assert.equal(capture.cases.length,3);
  for(const entry of capture.cases) {
    const value=JSON.parse(entry.wire),binding={projectId:entry.projectId,workId:entry.workId,phaseId:entry.phaseId};
    assert.equal(namespaceSubmissionValue(value,binding),value);assert.equal(value.schemaVersion,1);assert.equal(Object.hasOwn(value,'routing'),false);
    const {schemaVersion,format,profile,...data}=value,rebuilt=namespaceSubmissionRecord(data);
    assert.equal(canonicalJson(rebuilt),entry.wire);assert.equal(createHash('sha256').update(canonicalJson(rebuilt)).digest('hex'),entry.sha256);
    assert.throws(()=>namespaceSubmissionValue({...value,routing:null},binding),{code:'ENGINE_STORAGE_CORRUPT'});
    assert.throws(()=>namespaceSubmissionValue({...value,schemaVersion:2,format:'sflow-namespace-phase-review-packet/v2',profile:NAMESPACE_SUBMISSION_DECISION_PROFILE},binding),
      {code:'ENGINE_STORAGE_CORRUPT'});
    assert.throws(()=>namespaceSubmissionValue({...value,schemaVersion:NAMESPACE_SUBMISSION_SCHEMAS.packet.maximumReadableVersion+1},binding),error=>error.code==='ENGINE_STORAGE_UNSUPPORTED'&&error.cause.code==='SCHEMA_VERSION_FUTURE');
  }
  assert.equal(namespaceSubmissionRecordProfile({schemaVersion:1}).routing,false);
  assert.equal(namespaceSubmissionRecordProfile({schemaVersion:2}).routing,true);
});

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: normalized decision inputs are retained in an actual v2 submitted review packet`,async t=>{
  const f=await namespaceApprovalFixture(t,{backend,configure});
  const result=await f.submit('intake',{channel:' web ',confidence:'75'}),snapshot=await f.capture(),phase=snapshot.workflow.phases.intake;
  const packet=JSON.parse(Buffer.from((await f.content.read(f.scope,phase.namespaceSubmission.record)).data));
  assert.equal(packet.schemaVersion,2);assert.equal(packet.profile,NAMESPACE_SUBMISSION_DECISION_PROFILE);
  assert.deepEqual(packet.routing.record.values,{channel:'Web',confidence:75});assert.equal(packet.routing.decision,'channel');
  assert.deepEqual(packet.routing.record,phase.decisionInputs);assert.deepEqual(packet.routing.reused,[]);
  assert.equal(packet.routing.record.recordedBy,f.control.principalId);assert.equal(packet.routing.record.recordedAt,packet.submittedAt);
  const engine=make(f),review=await engine.run('phase.review',{phaseId:'intake'});
  assert.equal(review.manifest.reviewBinding.packetSha256,result.submission.reviewPacket);assert.equal(review.manifest.approvalRecorded,false);
  const document=await engine.run('document.read',{reference:{kind:'story-document',id:'REVIEW-intake-GEN-1',workId:f.inputs.workId}});
  assert.deepEqual(JSON.parse(document.document.content.text),packet);
  const replay=await make(f,{access:{current(){throw Error('Acknowledge the original submitted inputs.');}},clock:{now(){throw Error('No new decision-input timestamp.');}}})
    .run('phase.submit',{phaseId:'intake',decisionValues:{channel:'Mobile',confidence:1}});
  assert.equal(replay.status,'retained');assert.equal(replay.submission.reviewPacket,result.submission.reviewPacket);
  assert.deepEqual((await f.capture()).workflow.phases.intake.decisionInputs,phase.decisionInputs);
  const approval=await f.makeApproval().run('phase.approve',{phaseId:'intake',confirmation:await f.confirmation()});
  assert.equal(approval.approval.thresholdReached,true);assert.equal(approval.currentPhase,null);
  const complete=await f.capture();assert.equal(complete.workflow.status,'closed');
  const vote=JSON.parse(Buffer.from((await f.content.read(f.scope,complete.workflow.phases.intake.approvals[0].namespaceVote.record)).data));
  assert.equal(vote.schemaVersion,2);assert.equal(vote.routing.outcome.kind,'end');
});

test('missing, unknown and out-of-range inputs cannot record a submission or sample a new clock',async t=>{
  const f=await namespaceApprovalFixture(t,{configure});await assert.rejects(f.submit(),{code:'DECISION_INPUTS_MISSING'});
  const before=await f.head(),calls=f.control.clockCalls;
  for(const [values,code]of [[{channel:'Desktop',confidence:30},'DECISION_INPUT_INVALID'],[{channel:'Web',confidence:101},'DECISION_INPUT_INVALID'],
    [{channel:'Web',confidence:30,other:'bad'},'DECISION_INPUT_UNKNOWN']]) {
    await assert.rejects(make(f).run('phase.submit',{phaseId:'intake',decisionValues:values}),{code});
  }
  assert.deepEqual(await f.head(),before);assert.equal(f.control.clockCalls,calls);
  assert.equal((await f.capture()).workflow.phases.intake.status,'in_progress');
});

test('a prepared input submission resumes the same normalized intent and original clock sample',async t=>{
  const f=await namespaceApprovalFixture(t,{configure});await assert.rejects(f.submit(),{code:'DECISION_INPUTS_MISSING'});let calls=0;
  f.control.draftHook=(_count,request)=>{if(request.operation==='phase.submit'&&++calls===3)f.control.permissions=f.control.permissions.filter(item=>item!=='phase.submit');};
  const at=f.control.now;
  await assert.rejects(make(f).run('phase.submit',{phaseId:'intake',decisionValues:{channel:' web ',confidence:'075'}}),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.equal((await f.capture()).workflow.phases.intake.decisionInputs,undefined);
  f.control.draftHook=()=>{};f.control.permissions.push('phase.submit');
  await make(f,{clock:{now(){throw Error('The normalized retry must reuse its prepared timestamp.');}}}).run('phase.submit',
    {phaseId:'intake',decisionValues:{channel:'Web',confidence:75}});
  assert.equal((await f.capture()).workflow.phases.intake.decisionInputs.recordedAt,at);
});

test('altered canonical input values cannot acquire the retained packet review binding',async t=>{
  const f=await namespaceApprovalFixture(t,{configure});await f.submit('intake',{channel:'Web',confidence:75});const snapshot=await f.capture();
  const observer=createNamespaceStoryObserver({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority});
  const reader=createNamespaceSubmissionReader({observer,scope:f.scope,workId:f.inputs.workId}),corrupt=structuredClone(snapshot);
  corrupt.workflow.phases.intake.decisionInputs.values.channel='Mobile';
  await assert.rejects(reader.review(corrupt,'intake'),error=>error.code==='ENGINE_STORAGE_CORRUPT'&&error.cause.code==='SUBMISSION_ROUTING_BINDING_CHANGED');
  const valid=await reader.review(snapshot,'intake');assert.equal(valid.packetSha256,snapshot.workflow.phases.intake.namespaceSubmission.record.sha256);
});

test('an ask decision retains its pending-choice intent without inventing input values or a human answer',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:source=>{source.definition.workTypes.simple.decisions=[{id:'direction',label:'Where next?',after:'intake',kind:'ask',
    routes:[{id:'continue',label:'Continue',to:'next'},{id:'stop',label:'Stop',to:'end',omits:structuredClone(source.definition.workTypes.simple.omits)}]}];}});
  await f.submit();const snapshot=await f.capture(),phase=snapshot.workflow.phases.intake;
  const packet=JSON.parse(Buffer.from((await f.content.read(f.scope,phase.namespaceSubmission.record)).data));
  assert.equal(packet.schemaVersion,2);assert.equal(packet.routing.decision,'direction');assert.equal(packet.routing.record,null);
  assert.deepEqual(packet.routing.reused,[]);assert.equal(phase.decisionInputs,undefined);
  assert.equal(phase.status,'awaiting_approval');assert.equal(snapshot.workflow.pendingDecision,undefined);assert.deepEqual(phase.approvals,[]);
});

test('v2 routing validation rejects altered provenance, duplicate sources and unsupported nested schemas',async t=>{
  const f=await namespaceApprovalFixture(t,{configure});await f.submit('intake',{channel:'Web',confidence:75});
  const snapshot=await f.capture(),phase=snapshot.workflow.phases.intake;
  const packet=JSON.parse(Buffer.from((await f.content.read(f.scope,phase.namespaceSubmission.record)).data));
  const binding={projectId:f.scope.projectId,workId:f.inputs.workId,phaseId:'intake'};
  for(const change of [value=>{value.routing.record.decision='another';},value=>{value.routing.record.recordedBy='';},
    value=>{value.routing.record.values.channel=['Web'];},value=>{value.routing.record.approved=true;},
    value=>{value.routing.reused=[{decision:'earlier',phase:'earlier',generation:1,values:{channel:'Web'},packet:phase.namespaceSubmission.record},
      {decision:'earlier',phase:'earlier',generation:1,values:{channel:'Mobile'},packet:phase.namespaceSubmission.record}];},
    value=>{value.routing.reused=[{decision:'earlier',phase:'earlier',generation:1,values:{channel:'Web'},packet:{...phase.namespaceSubmission.record,namespace:'local'}}];}]) {
    const changed=structuredClone(packet);change(changed);
    assert.throws(()=>namespaceSubmissionValue(changed,binding),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  for(const change of [value=>{value.routing.schemaVersion=2;},value=>{value.routing.record.schemaVersion=2;}]) {
    const changed=structuredClone(packet);change(changed);
    assert.throws(()=>namespaceSubmissionValue(changed,binding),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  }
});

test('v2 proof reads preserve the actual storage deadline, permission and missing-content errors',async t=>{
  const f=await namespaceApprovalFixture(t,{configure});await f.submit('intake',{channel:'Web',confidence:75});
  const snapshot=await f.capture(),packet=snapshot.workflow.phases.intake.namespaceSubmission.record;
  const observer=createNamespaceStoryObserver({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority});
  for(const code of ['SDA_CONTENT_DEADLINE_EXCEEDED','SDA_CONTENT_PERMISSION_DENIED','SDA_CONTENT_NOT_FOUND']) {
    const original=Object.assign(new Error('Retained packet access failed.'),{code,details:{reference:packet,deadlineMs:1234}});
    const reader=createNamespaceSubmissionReader({observer:{...observer,async bytes(reference,...args){
      if(reference.sha256===packet.sha256)throw original;return observer.bytes(reference,...args);
    }},scope:f.scope,workId:f.inputs.workId});
    await assert.rejects(reader.review(snapshot,'intake'),error=>error===original);
  }
});

test('an altered approved flag cannot make submitted routing values an approved reuse source',async t=>{
  const f=await namespaceApprovalFixture(t,{configure:source=>{
    configure(source);
    source.definition.phases['delivery']={...structuredClone(source.definition.phases.intake),label:'Delivery',
      artifact:{path:'artifacts/delivery/report.md'},defaultTemplate:'intake.md',inputs:[{phase:'intake'}],
      approval:{authorities:['reviewers'],minimum:1,rejectTo:['delivery']}};
    source.definition.workTypes.simple.phases.push('delivery');source.agents[0].phases.push('delivery');source.agents[0].defaultFor.push('delivery');
    source.definition.workTypes.simple.decisions.push({id:'delivery-channel',label:'Delivery channel',after:'delivery',kind:'branch',
      inputs:[{name:'channel',from:'channel'}],routes:[
        {id:'web',label:'Web',when:{channel:'Web'},to:'end',omits:structuredClone(source.definition.workTypes.simple.omits)},
        {id:'other',label:'Other',to:'end',omits:structuredClone(source.definition.workTypes.simple.omits)}]});
  }});
  await f.submit('intake',{channel:'Web',confidence:75});
  const snapshot=await f.capture(),original=snapshot.workflow.phases.intake.namespaceSubmission.record;
  const forged=structuredClone(snapshot);forged.workflow.phases.intake.status='approved';
  const observer=createNamespaceStoryObserver({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority});
  const reader=createNamespaceSubmissionReader({observer,scope:f.scope,workId:f.inputs.workId});
  await assert.rejects(reader.inspectApprovedMany(forged,['intake']),
    error=>error.code==='ENGINE_STORAGE_CORRUPT'&&error.message.includes('human approval threshold'));
  const candidate=JSON.parse(Buffer.from((await f.content.read(f.scope,original)).data));
  candidate.phase='delivery';candidate.routing={schemaVersion:1,format:'sflow-namespace-submission-routing/v1',decision:'delivery-channel',record:null,
    reused:[{decision:'channel',phase:'intake',generation:1,values:{channel:'Web'},packet:original}]};
  await assert.rejects(reader.verifyRouting(forged,'delivery',candidate),
    error=>error.code==='ENGINE_STORAGE_CORRUPT'&&error.message.includes('human approval threshold'));
  // The forged projection is never stored and cannot grant approval to the actual Story.
  const actual=await f.capture();assert.equal(actual.workflow.phases.intake.status,'awaiting_approval');
  assert.deepEqual(actual.workflow.phases.intake.approvals,[]);assert.equal(actual.workflow.currentPhase,'intake');
});

test('source approval proof requires real vote bytes and coalesces packet reads only within one invocation',async t=>{
  const f=await namespaceApprovalFixture(t);await f.submit();
  await f.makeApproval().run('phase.approve',{phaseId:'intake',confirmation:await f.confirmation()});
  const snapshot=await f.capture(),phase=snapshot.workflow.phases.intake,packet=phase.namespaceSubmission.record;
  const observer=createNamespaceStoryObserver({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority});
  let packetReads=0;
  const reader=createNamespaceSubmissionReader({observer:{...observer,bytes(reference,...args){
    if(reference.sha256===packet.sha256)packetReads++;return observer.bytes(reference,...args);
  }},scope:f.scope,workId:f.inputs.workId});
  const proofs=await reader.inspectApprovedMany(snapshot,['intake','intake']);
  assert.equal(proofs.length,2);assert.deepEqual(proofs[0].binding.record,packet);assert.equal(packetReads,1);
  await reader.inspectApprovedMany(snapshot,['intake']);assert.equal(packetReads,2);
  const original=Object.assign(new Error('Approved source vote access timed out.'),{code:'SDA_CONTENT_DEADLINE_EXCEEDED',details:{deadlineMs:1234}});
  const blocked=createNamespaceSubmissionReader({observer:{...observer,bytes(reference,...args){
    if(reference.sha256===phase.approvals[0].namespaceVote.record.sha256)throw original;return observer.bytes(reference,...args);
  }},scope:f.scope,workId:f.inputs.workId});
  await assert.rejects(blocked.inspectApprovedMany(snapshot,['intake']),error=>error===original);
});
