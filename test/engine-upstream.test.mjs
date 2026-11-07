import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const reason='The earlier document must state the approved cache duration explicitly.';
const cases=[
  ['upstream.raise',{phaseId:'team-plan',about:'Caching',problem:reason},
    {fromArtifact:false,phaseId:'team-plan',about:'Caching',problem:reason,assumption:null,impact:null,proposed:null,authored:null,supersedes:null},
    {id:'UPI-002',phase:'team-plan',raisedIn:{phase:'team-code'},raisedBy:'author',agent:null,authored:'human',producerGeneration:2,
      about:'Caching',problem:reason,source:null,proposed:'unknown',assumption:null,impact:null}],
  ['upstream.decide',{issueId:'UPI-001',outcome:'dismiss',reason},
    {issueId:'UPI-001',outcome:'dismiss',reason,link:null,expires:null},
    {issue:'UPI-001',outcome:'dismiss',reason,link:null,actor:'author',authorityGroup:'plan-owners'}],
  ['forward-amendment.propose',{phaseId:'team-plan',reason},
    {phaseId:'team-plan',reason,file:null,upstreamIssue:null},
    {id:'FAM-002',phase:'team-plan',fromGeneration:2,reason,proposedBy:'author',upstreamIssue:null}],
  ['forward-amendment.decide',{amendmentId:'FAM-001',decision:'approve',reason,confirmation:'FAM-001'},
    {amendmentId:'FAM-001',decision:'approve',reason,confirmation:'FAM-001'},
    {proposal:{id:'FAM-001',phase:'team-plan'},decision:{amendment:'FAM-001',phase:'team-plan',decision:'approved',reason,actor:'author',authorityGroup:'plan-owners'},
      applied:true,approval:{phase:'team-plan',generation:3,authorityGroup:'plan-owners'}}],
  ['forward-amendment.revalidate',{amendmentId:'FAM-001',phaseId:'team-design',outcome:'unchanged',reason},
    {phaseId:'team-design',amendmentId:'FAM-001',outcome:'unchanged',reason},
    {amendment:'FAM-001',phase:'team-design',generation:1,outcome:'unchanged',reason,actor:'author',authorityGroup:'design-owners'}]
];

function fixture(entry=cases[0],hook=()=>{}) {
  const [id,input,request,record]=entry, calls=[];
  const context={subject:{kind:'story',id:'STORY-1'},workflow:{workItem:{id:'STORY-1'},status:'in_progress',currentPhase:'team-code',
    phases:{'team-plan':{generation:2,approvalPolicy:{authorities:['plan-owners']}},
      'team-design':{generation:1,approvalPolicy:{authorities:['design-owners']}},'team-code':{generation:1}},
    upstreamIssues:[{id:'UPI-001',phase:'team-plan'}],forwardAmendments:[{id:'FAM-001',phase:'team-plan',fromGeneration:2}]}};
  const plan={requests:[structuredClone(request)],actorId:'author',agent:null,
    authored:id==='upstream.raise'?'human':null,unowned:[]};
  if(id==='upstream.raise')plan.requests=[{phase:'team-plan',about:'Caching',problem:reason,assumption:null,impact:null,proposed:'unknown',source:null,supersedes:null}];
  const token={revision:'a'.repeat(40),pushed:true,record:structuredClone(record)};
  const final={workId:'STORY-1',currentPhase:'team-code',revalidate:[],refreshed:null};
  const port={};
  for(const stage of ['load','resolve','commit','finish'])port[stage]=async(...args)=>{
    calls.push(stage);const replacement=await hook(stage,{context,plan,token,final,calls},args);
    return replacement!==undefined?replacement:stage==='load'?context:stage==='resolve'?plan:stage==='commit'?token:final;
  };
  return {id,input,context,plan,token,final,calls,engine:createEngine({ports:{upstream:port}})};
}

test('the registry distinguishes author proposals, owner decisions, revalidation and read-only lists',()=>{
  for(const id of ['upstream.list',...cases.map(entry=>entry[0])])assert.ok(ENGINE_OPERATIONS.find(entry=>entry.id===id));
  for(const id of ['upstream.raise','forward-amendment.propose'])assert.equal(ENGINE_OPERATIONS.find(entry=>entry.id===id).humanDecision,false);
  assert.equal(ENGINE_OPERATIONS.find(entry=>entry.id==='forward-amendment.decide').confirmation,'exact-amendment-id');
});

test('every mutation follows the same registry path and binds its native record to its owner',async()=>{
  for(const entry of cases) {
    const f=fixture(entry),result=await f.engine.run(f.id,{workId:'STORY-1',...f.input});
    assert.deepEqual(f.calls,['load','resolve','commit','finish']);
    assert.equal(result.status,'recorded');assert.equal(result.phase,'team-code');assert.equal(result.currentPhase,'team-code');
    assert.equal(result.records.length,1);assert.equal(result.revision,f.token.revision);
    assert.deepEqual(result.effects,{committed:true,pushed:true});assert.equal(Object.isFrozen(result.records[0]),true);
    assert.equal('commandGuidance' in result,false);
  }
});

test('a closed Story can be listed without resolving identity or invoking any writer',async()=>{
  const f=fixture(cases[0],(stage,{context})=>{
    if(stage==='load')context.workflow.status='closed';
    if(stage==='resolve')return {issues:[{id:'UPI-001',phase:'team-plan',status:'open',decision:null,supersededBy:null}]};
  });
  const result=await f.engine.run('upstream.list',{workId:'STORY-1',open:true});
  assert.deepEqual(f.calls,['load','resolve']);assert.equal(result.status,'observed');
  assert.deepEqual(result.effects,{committed:false,pushed:false});assert.equal('actorId' in result,false);
  for(const entry of cases) {
    const closed=fixture(entry,(stage,{context})=>{if(stage==='load')context.workflow.status='closed';});
    await assert.rejects(closed.engine.run(closed.id,closed.input),{code:'UPSTREAM_ISSUE_STORY_CLOSED'});
    assert.deepEqual(closed.calls,['load']);
  }
});

test('authority, callbacks, raw records, alternate roots and invalid flags fail before native I/O',async()=>{
  const f=fixture();
  for(const input of [{actor:'forged'},{authorityGroup:'forged'},{record:{}},{root:'/other'},
    {capture(){}},{requests:[]},{fromArtifact:'yes'},{phaseId:12},{get reason(){throw Error('never read');}}]) {
    await assert.rejects(f.engine.run('upstream.raise',input),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});

test('an amendment needs the exact confirmed identifier before identity or writing',async()=>{
  const f=fixture(cases[3]);
  await assert.rejects(f.engine.run(f.id,{...f.input,confirmation:'FAM-002'}),{code:'FORWARD_AMENDMENT_CONFIRMATION_REQUIRED'});
  assert.deepEqual(f.calls,['load']);
});

test('native errors and accepted prefix survive a failure in a later issue transaction',async()=>{
  const native=new SingularityFlowError('Transport timed out with a retained operation.',{code:'REMOTE_TIMEOUT',details:{operationId:'pending-2'}});
  const f=fixture(cases[0],(stage,{plan},args)=>{
    if(stage==='resolve')plan.requests.push({...plan.requests[0],about:'Refresh'});
    if(stage==='commit'&&args[2].index===1)throw native;
  });
  await assert.rejects(f.engine.run(f.id,{fromArtifact:true}),error=>{
    assert.equal(error,native);assert.equal(error.details.operationId,'pending-2');
    assert.equal(error.engineUpstreamEffects.accepted.length,1);
    assert.equal(error.engineUpstreamEffects.remaining.length,1);
    return true;
  });
  assert.equal(f.calls.includes('finish'),false);
});

test('a completed artifact scan with nothing new has no publication or committed effect',async()=>{
  const f=fixture(cases[0],(stage,{plan})=>{if(stage==='resolve')plan.requests=[];});
  const result=await f.engine.run(f.id,{fromArtifact:true});
  assert.equal(result.status,'unchanged');assert.equal(result.revision,null);
  assert.deepEqual(result.records,[]);assert.deepEqual(result.publications,[]);
  assert.deepEqual(result.effects,{committed:false,pushed:false});assert.equal(f.calls.includes('commit'),false);
});

test('cancellation stops before a next effect and never reports an accepted publication as undone',async()=>{
  for(const stage of ['load','resolve']) {
    const controller=new AbortController(),f=fixture(cases[0],at=>{if(at===stage)controller.abort();});
    await assert.rejects(f.engine.run(f.id,f.input,{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
    assert.equal(f.calls.includes('commit'),false);
  }
  const controller=new AbortController(),f=fixture(cases[0],stage=>{if(stage==='commit')controller.abort();});
  assert.equal((await f.engine.run(f.id,f.input,{signal:controller.signal})).effects.committed,true);
  const batchController=new AbortController(),batch=fixture(cases[0],(stage,{plan})=>{
    if(stage==='resolve')plan.requests.push({...plan.requests[0],about:'Refresh'});
    if(stage==='commit')batchController.abort();
  });
  await assert.rejects(batch.engine.run(batch.id,{fromArtifact:true},{signal:batchController.signal}),error=>
    error.code==='ENGINE_OPERATION_CANCELLED'&&error.engineUpstreamEffects.accepted.length===1
      &&error.engineUpstreamEffects.remaining.length===1);
});

test('native permission, missing-file and unknown-publication errors pass through without a retry',async()=>{
  for(const at of ['load','resolve','commit','finish']) {
    const error=new SingularityFlowError('Preserved native cause.',{code:'NATIVE_READ_OR_WRITE_FAILED',
      details:{nextAction:'original recovery'},cause:new Error('permission denied')});
    const f=fixture(cases[1],stage=>{if(stage===at)throw error;});
    await assert.rejects(f.engine.run(f.id,f.input),actual=>actual===error&&actual.cause.message==='permission denied');
    assert.equal(f.calls.filter(stage=>stage===at).length,1);
  }
});

test('a resolver cannot replace a manual issue or return fabricated tasks after recording',async()=>{
  const swapped=fixture(cases[0],(stage,{plan})=>{if(stage==='resolve')plan.requests[0].phase='team-design';});
  await assert.rejects(swapped.engine.run(swapped.id,swapped.input),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.equal(swapped.calls.includes('commit'),false);
  const extra=fixture(cases[1],(stage,{final})=>{if(stage==='finish')final.revalidate=['team-design'];});
  await assert.rejects(extra.engine.run(extra.id,extra.input),error=>error.code==='ENGINE_PORT_RESULT_INVALID'
    &&error.engineUpstreamEffects.accepted.length===1);
});

test('post-commit output errors retain the actual accepted publication and native error identity',async()=>{
  const failure=new Error('After-state unavailable');
  const f=fixture(cases[0],stage=>{if(stage==='finish')throw failure;});
  await assert.rejects(f.engine.run(f.id,f.input),error=>error===failure&&error.engineUpstreamEffects.accepted[0].revision===f.token.revision);
  const wrong=fixture(cases[1],(stage,{token})=>{if(stage==='commit')token.record.authorityGroup='code-reviewers';});
  await assert.rejects(wrong.engine.run(wrong.id,wrong.input),error=>error.code==='ENGINE_PORT_RESULT_INVALID'
    &&error.engineUpstreamEffects.pending.revision===wrong.token.revision);
});

test('a mutable native context cannot redirect a decision to a different upstream owner',async()=>{
  const f=fixture(cases[1],(stage,{context,token})=>{if(stage==='resolve') {
    context.workflow.upstreamIssues[0].phase='team-design';token.record.authorityGroup='design-owners';
  }});
  await assert.rejects(f.engine.run(f.id,f.input),{code:'ENGINE_PORT_RESULT_INVALID'});
});

test('returns bind the actual change request and move only to its upstream target',async()=>{
  const f=fixture(cases[1],(stage,{plan,token,final})=>{
    if(stage==='resolve')plan.requests[0].outcome='return';
    if(stage==='commit')Object.assign(token.record,{outcome:'return',link:'CR-001',changeRequest:{id:'CR-001',targetPhase:'team-plan'}});
    if(stage==='finish')final.currentPhase='team-plan';
  });
  const result=await f.engine.run(f.id,{...f.input,outcome:'return'});
  assert.equal(result.currentPhase,'team-plan');assert.equal(result.records[0].link,'CR-001');
});
