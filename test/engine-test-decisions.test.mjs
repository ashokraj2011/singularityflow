import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {resolveTestEvidenceIntent,standaloneDecisionRequest} from '../src/kernel/decision-plan.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const command={id:'checks',kind:'test',argv:['node','checks.mjs'],workingDirectory:'.',affectedRoots:['src'],
  modelPolicy:'never',result:{adapter:'sflow-test-result-v1',path:'.sflow/results/checks.json',minimumDiscovered:1}};
const cases=[
  ['decision.evidence-reuse',{phaseId:'team-test',attemptId:'TA-1',reason:'Reviewed retained run'}],
  ['decision.visual-profile',{phaseId:'team-test',profileId:'tablet',notApplicable:true,reason:'Reviewed device scope'}],
  ['decision.test-narrowing',{phaseId:'team-test',commandId:'checks',reason:'Reviewed focused suite'}],
  ['decision.test-risk',{phaseId:'team-test',commandId:'checks',causeClass:'environment.unavailable',reason:'Reviewed environment'}],
  ['test-command.request',{phaseId:'team-test',command,reason:'Request this exact repository runner'}],
  ['test-command.decide',{accept:'TCD-001',reason:'Reviewed exact request'}]
];

function fixture(operation='test-command.request',hook=()=>{}) {
  const descriptor=ENGINE_OPERATIONS.find(entry=>entry.id===operation),calls=[];
  const context={subject:{kind:'story',id:'WORK-1'},workflow:{workItem:{id:'WORK-1'},status:'in_progress',
    currentPhase:'team-code',phases:{'team-code':{},'team-test':{requiredArtifact:{kind:'visual-test-evidence'}}}}};
  const facts={workId:'WORK-1',phase:'team-test',recordKind:descriptor.recordKind,record:{id:'record-1',phase:'team-test'},
    revision:'a'.repeat(40),pushed:false,actorId:'native-actor',authorityGroup:descriptor.authority==='requester'?null:'test-reviewers',
    currentPhase:'team-code',...(descriptor.allowRetained?{retained:false}:{})};
  const token={sha:facts.revision,pushed:false};
  const port={};
  for(const stage of ['load','prepare','resolve','commit','finish'])port[stage]=async(...args)=>{
    calls.push(stage);
    const replacement=await hook(stage,{context,facts,token,calls},args);
    if(replacement!==undefined)return replacement;
    if(stage==='load')return context;
    if(stage==='prepare')return args[1];
    if(stage==='resolve') {
      const {notApplicable,...request}=args[1];
      if(operation==='test-command.request')return {phaseId:request.phaseId,command:request.command,repin:null,reason:request.reason};
      return {...request,phaseId:request.phaseId??'team-test'};
    }
    return stage==='commit'?token:facts;
  };
  return {context,facts,token,calls,port,engine:createEngine({ports:{testDecisionRecord:port}})};
}

for(const [operation,input] of cases)test(`${operation} resolves a bound target before the existing writer, with no phase advancement`,async()=>{
  const f=fixture(operation);
  const receipt=await f.engine.run(operation,{workId:'WORK-1',...input});
  assert.deepEqual(f.calls,['load','prepare','resolve','commit','finish']);
  assert.equal(receipt.operation,operation);
  assert.equal(receipt.phase,'team-test');
  assert.equal(receipt.currentPhase,'team-code');
  assert.deepEqual(receipt.effects,{committed:true,pushed:false});
  assert.equal(Object.isFrozen(receipt.record),true);
  assert.equal('commandGuidance' in receipt,false);
});

test('requester and human acceptance are distinct vocabulary, and the earlier four-stage decision port is unchanged',()=>{
  const request=ENGINE_OPERATIONS.find(entry=>entry.id==='test-command.request');
  const accept=ENGINE_OPERATIONS.find(entry=>entry.id==='test-command.decide');
  assert.equal(request.humanDecision,false);assert.equal(request.authority,'requester');
  assert.equal(accept.humanDecision,true);assert.equal(accept.authority,'reviewer');
  assert.deepEqual(request.stages,['load','prepare','resolve','commit','finish']);
  assert.deepEqual(ENGINE_OPERATIONS.find(entry=>entry.id==='decision.scope').stages,['load','prepare','commit','finish']);
  const f=fixture();delete f.port.resolve;
  assert.throws(()=>createEngine({ports:{testDecisionRecord:f.port}}),{code:'ENGINE_INPUT_INVALID'});
});

test('authority, private repin records, callbacks and issued records cannot be injected before I/O',async()=>{
  const f=fixture();
  for(const injection of [{actor:'reviewer'},{authorityGroup:'reviewers'},{record:{id:'TCD-001'}},
    {repin:{commandId:'checks'}},{policy:{}},{callback(){}},{sourceRoots:[{}]},
    {get reason(){throw new Error('getter must not run');}}]) {
    await assert.rejects(f.engine.run('test-command.request',injection),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});

test('all six operations preserve closed-Story admission before host preparation',async()=>{
  for(const [operation] of cases) {
    const f=fixture(operation,(stage,{context})=>{if(stage==='load')context.workflow.status='closed';});
    await assert.rejects(f.engine.run(operation,{}),error=>/CLOSED$/u.test(error.code));
    assert.deepEqual(f.calls,['load']);
  }
});

test('cancellation during repository resolution cannot reach a writer',async()=>{
  const controller=new AbortController();
  const f=fixture('test-command.request',stage=>{if(stage==='resolve')controller.abort();});
  await assert.rejects(f.engine.run('test-command.request',cases[4][1],{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  assert.deepEqual(f.calls,['load','prepare','resolve']);
});

test('a resolver cannot redirect a requested phase, invent a phase, or smuggle authority',async()=>{
  for(const resolved of [{phaseId:'team-code',command},{phaseId:'absent',command},{phaseId:'team-test',command,actor:'forged'},{}]) {
    const f=fixture('test-command.request',stage=>stage==='resolve'?resolved:undefined);
    await assert.rejects(f.engine.run('test-command.request',cases[4][1]),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.deepEqual(f.calls,['load','prepare','resolve']);
  }
});

test('a retained duplicate has no new commit, push or invented review authority',async()=>{
  const f=fixture('test-command.request',(stage,{facts})=>{
    if(stage==='finish')Object.assign(facts,{retained:true,revision:null,pushed:false,
      record:{id:'TCD-001',phase:'team-test',requestedBy:'original-requester'}});
  });
  const result=await f.engine.run('test-command.request',cases[4][1]);
  assert.equal(result.status,'retained');assert.equal(result.revision,null);
  assert.equal(result.record.requestedBy,'original-requester');
  assert.equal(result.authorityGroup,null);
  assert.deepEqual(result.effects,{committed:false,pushed:false});
});

test('invalid post-write facts preserve the actual publication token and cannot claim acceptance or advancement',async()=>{
  for(const changed of [{record:{phase:'other'}},{currentPhase:'team-test'},{authorityGroup:'invented-review'},
    {retained:true},{retained:true,revision:null,pushed:true},{revision:null}]) {
    const f=fixture('test-command.request',(stage,{facts})=>{if(stage==='finish')Object.assign(facts,changed);});
    await assert.rejects(f.engine.run('test-command.request',cases[4][1]),error=>
      error.code==='ENGINE_PORT_RESULT_INVALID'&&error.enginePublication===f.token);
  }
  const f=fixture('test-command.decide',(stage,{facts})=>{if(stage==='finish')facts.authorityGroup=null;});
  await assert.rejects(f.engine.run('test-command.decide',cases[5][1]),{code:'ENGINE_PORT_RESULT_INVALID'});
});

test('native refusal identity and recovery cause are not projected into a different failure',async()=>{
  const cause=new Error('retained transport detail');
  const refused=new SingularityFlowError('native writer refused',{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED',cause,
    details:{phase:'team-test',recovery:'preserve'}});
  const f=fixture('test-command.decide',stage=>{if(stage==='commit')throw refused;});
  await assert.rejects(f.engine.run('test-command.decide',cases[5][1]),error=>error===refused&&error.cause===cause);
  assert.equal(f.calls.includes('finish'),false);
});

test('test command requests cannot mix explicit commands, suggestions, repins or reviewer outcomes',async()=>{
  for(const request of [{phaseId:'team-test'},{phaseId:'team-test',command,suggestionId:'node'},
    {phaseId:'team-test',repinId:'checks',sourceRoots:['src']}]) {
    const f=fixture();
    await assert.rejects(f.engine.run('test-command.request',request),{code:'TEST_COMMAND_DECISION_INVALID'});
    assert.deepEqual(f.calls,['load','prepare']);
  }
  const f=fixture('test-command.decide');
  await assert.rejects(f.engine.run('test-command.decide',{accept:'TCD-001',revoke:'TCD-001'}),{code:'TEST_COMMAND_DECISION_INVALID'});
});

test('pure target resolution preserves unknown-record, skipped-phase, visual-role and cause-class refusals',()=>{
  const workflow=fixture().context.workflow;
  const intent=(operation,input,facts)=>resolveTestEvidenceIntent(operation,workflow,standaloneDecisionRequest(operation,input),facts);
  for(const [operation,input,code] of [
    ['decision.evidence-reuse',{phaseId:'team-test'},'EVIDENCE_REUSE_INVALID'],
    ['decision.evidence-reuse',{revoke:'ERU-1'},'EVIDENCE_REUSE_UNKNOWN'],
    ['decision.visual-profile',{phaseId:'team-code',profileId:'tablet',notApplicable:true},'VISUAL_PROFILE_DECISION_INVALID'],
    ['decision.test-narrowing',{revoke:'TNR-1'},'TEST_NARROWING_UNKNOWN'],
    ['decision.test-risk',{phaseId:'team-test',argvSha256:'a'.repeat(64)},'TEST_RUN_RISK_INVALID'],
    ['decision.test-risk',{phaseId:'team-test',causeClass:'code.failure'},'TEST_RUN_RISK_INVALID']
  ])assert.throws(()=>intent(operation,input),{code});
  assert.equal(intent('decision.evidence-reuse',{revoke:'ERU-1'},
    {target:{id:'ERU-1',phase:'team-test'}}).phaseId,'team-test');
  workflow.phases['team-test'].status='skipped';
  assert.throws(()=>intent('decision.evidence-reuse',{phaseId:'team-test',attemptId:'TA-1'}),{code:'EVIDENCE_REUSE_INVALID'});
});
