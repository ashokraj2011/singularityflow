import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {planCorrectionOwner} from '../src/kernel/decision-plan.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const request={workId:'STORY-1',ownerPhase:'team-plan',operations:[{op:'replace-location',clauseId:'STORY-1:AC-001',from:'src/old.mjs',to:'src/value.mjs'}],
  reason:'The approved behavior lives in the value module, not the legacy module.'};
const map='a'.repeat(64),preview='b'.repeat(64);

function fixture(hook=()=>{}) {
  const context={subject:{kind:'story',id:'STORY-1'},workflow:{workItem:{id:'STORY-1'},status:'in_progress',currentPhase:'team-code',
    phaseOrder:['team-plan','team-code'],phases:{'team-plan':{id:'team-plan',generation:2,status:'approved',claimMaps:{planned:{sha256:map}}},
      'team-code':{id:'team-code',generation:1,status:'in_progress'}}}};
  const operations=[{...request.operations[0],previousClaimSha256:'c'.repeat(64)}];
  const review={workId:'STORY-1',currentPhase:'team-code',ownerPhase:'team-plan',ownerGeneration:2,ownerMapSha256:map,
    previewSha256:preview,operations,authorityGroups:['plan-owners'],reason:request.reason,upstreamIssue:null};
  const authorization={workId:'STORY-1',ownerPhase:'team-plan',ownerGeneration:2,previewSha256:preview,
    confirmed:true,actorId:'native-reviewer',authorityGroup:'plan-owners'};
  const record={id:'PRC-001',kind:'plan-row-correction',ownerPhase:'team-plan',ownerGeneration:2,ownerMapSha256:map,
    operations,reason:request.reason,upstreamIssue:null,actor:'native-reviewer',authorityGroup:'plan-owners',
    reviewAssurance:'live-terminal-exact-plan-review'};
  const facts={workId:'STORY-1',currentPhase:'team-code',record,revision:'d'.repeat(40),pushed:true,actorId:'native-reviewer',authorityGroup:'plan-owners'};
  const token={sha:facts.revision,pushed:true},calls=[],observed={},port={};
  for(const stage of ['load','prepare','review','authorize','commit','finish'])port[stage]=async(...args)=>{
    calls.push(stage);observed[stage]=args;
    const replacement=await hook(stage,{context,review,authorization,facts,token,calls},args);
    if(replacement!==undefined)return replacement;
    return stage==='load'?context:stage==='prepare'?args[1]:stage==='review'?review:stage==='authorize'?authorization:stage==='commit'?token:facts;
  };
  return {context,review,authorization,facts,token,calls,observed,port,engine:createEngine({ports:{planCorrection:port}})};
}

test('preview binds the exact approved plan without identity, authorization or mutation',async()=>{
  const f=fixture(),result=await f.engine.run('plan.correction.preview',request);
  assert.deepEqual(f.calls,['load','prepare','review']);
  assert.equal(result.status,'ready-to-review');assert.equal(result.review.ownerPhase,'team-plan');
  assert.equal(result.phase,'team-code');assert.equal(result.currentPhase,'team-code');
  assert.equal(result.revision,null);assert.deepEqual(result.effects,{committed:false,pushed:false});
  assert.equal(Object.isFrozen(result.review.operations[0]),true);
  assert.equal('actorId' in result,false);assert.equal('record' in result,false);
});

test('confirmed correction records only the reviewed operations and preserves the current phase',async()=>{
  const f=fixture(),result=await f.engine.run('plan.correct',request);
  assert.deepEqual(f.calls,['load','prepare','review','authorize','commit','finish']);
  assert.equal(result.status,'recorded');assert.equal(result.record.ownerGeneration,2);
  assert.equal(result.currentPhase,'team-code');assert.deepEqual(result.effects,{committed:true,pushed:true});
  assert.equal(result.record.reviewAssurance,'live-terminal-exact-plan-review');
  assert.equal('commandGuidance' in result,false);
});

test('refusing a trusted human confirmation cancels without recording',async()=>{
  const f=fixture((stage,{authorization})=>{if(stage==='authorize')authorization.confirmed=false;});
  const result=await f.engine.run('plan.correct',request);
  assert.equal(result.status,'cancelled');assert.equal(result.revision,null);
  assert.deepEqual(result.effects,{committed:false,pushed:false});
  assert.deepEqual(f.calls,['load','prepare','review','authorize']);
});

test('caller authority, callbacks, one-time grants, raw records and invalid operation arrays fail before I/O',async()=>{
  const f=fixture();
  for(const value of [{actor:'forged'},{authorityGroup:'forged'},{authorizationId:'forged'},{grant:{token:'forged'}},
    {capture(){}},{consume(){}},{workflow:{}},{record:{}},{operations:'replace'},{operations:[null]},
    {get reason(){throw new Error('caller getter must not execute');}}]) {
    await assert.rejects(f.engine.run('plan.correct',value),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});

test('closed Story and absent or ambiguous approved owners keep their domain refusals',async()=>{
  const closed=fixture((stage,{context})=>{if(stage==='load')context.workflow.status='closed';});
  await assert.rejects(closed.engine.run('plan.correct',request),{code:'PLAN_AMENDMENT_STORY_CLOSED'});
  assert.deepEqual(closed.calls,['load']);
  const f=fixture(),w=f.context.workflow;
  assert.equal(planCorrectionOwner(w,null).id,'team-plan');
  assert.throws(()=>planCorrectionOwner(w,'team-code'),{code:'PLAN_ROW_CORRECTION_INVALID'});
  w.phases['other-plan']={...structuredClone(w.phases['team-plan']),id:'other-plan'};w.phaseOrder.push('other-plan');
  assert.throws(()=>planCorrectionOwner(w,null),/several approved plans/u);
  w.phases['team-plan'].status='in_progress';w.phases['other-plan'].status='not_started';
  assert.throws(()=>planCorrectionOwner(w,null),/no approved plan/u);
});

test('a port cannot substitute a different owner, generation, map, current phase or reason',async()=>{
  for(const changed of [{ownerPhase:'other-plan'},{ownerGeneration:3},{ownerMapSha256:'f'.repeat(64)},
    {currentPhase:'other-code'},{reason:'A different plan correction.'},{previewSha256:'bad'},{authorityGroups:[]}]) {
    const f=fixture((stage,{review})=>{if(stage==='review')Object.assign(review,changed);});
    await assert.rejects(f.engine.run('plan.correct',request),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.deepEqual(f.calls,['load','prepare','review']);
  }
});

test('authorization must name the same reviewed owner and digest, with an allowed native group',async()=>{
  for(const changed of [{ownerPhase:'other-plan'},{ownerGeneration:3},{previewSha256:'e'.repeat(64)},
    {authorityGroup:'unrelated-group'},{actorId:null},{confirmed:'yes'},{token:'unexpected-public-token'}]) {
    const f=fixture((stage,{authorization})=>{if(stage==='authorize')Object.assign(authorization,changed);});
    await assert.rejects(f.engine.run('plan.correct',request),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.equal(f.calls.includes('commit'),false);
  }
});

test('cancellation at any pre-commit boundary prevents the next effect',async()=>{
  for(const stop of ['prepare','review','authorize']) {
    const controller=new AbortController();
    const f=fixture(stage=>{if(stage===stop)controller.abort();});
    await assert.rejects(f.engine.run('plan.correct',request,{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
    assert.equal(f.calls.includes('commit'),false);
  }
  const controller=new AbortController(),f=fixture(stage=>{if(stage==='commit')controller.abort();});
  const result=await f.engine.run('plan.correct',request,{signal:controller.signal});
  assert.equal(result.status,'recorded');assert.equal(result.effects.committed,true);
});

test('native review, authority, presence and stale-plan errors retain exact identity and recovery',async()=>{
  for(const stage of ['review','authorize','commit']) {
    const cause=new Error('original native cause');
    const error=new SingularityFlowError('original native refusal',{code:'ACTION_TERMINAL_PRESENTATION_REQUIRED',cause,details:{preserved:true}});
    const f=fixture(where=>{if(where===stage)throw error;});
    await assert.rejects(f.engine.run('plan.correct',request),found=>found===error&&found.cause===cause);
    assert.equal(f.calls.includes('finish'),false);
  }
});

test('a bad result cannot conceal a committed correction or claim a changed operation set',async()=>{
  for(const changed of [{currentPhase:'other-code'},{revision:null},{actorId:'other-reviewer'},
    {record:{id:'other-record'}},{record:{...fixture().facts.record,operations:[]}}]) {
    const f=fixture((stage,{facts})=>{if(stage==='finish')Object.assign(facts,changed);});
    await assert.rejects(f.engine.run('plan.correct',request),error=>error.code==='ENGINE_PORT_RESULT_INVALID'&&error.enginePublication===f.token);
  }
});

test('native port facts stay bounded JSON, and a post-commit encoding failure retains publication',async()=>{
  for(const stage of ['review','authorize','finish']) {
    const f=fixture(where=>where===stage?{callback(){}}:undefined);
    await assert.rejects(f.engine.run('plan.correct',request),error=>error.code==='ENGINE_PORT_RESULT_INVALID'
      &&(stage!=='finish'||error.enginePublication===f.token));
  }
});
