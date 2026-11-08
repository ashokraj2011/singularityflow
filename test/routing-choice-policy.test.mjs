import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDecisions} from '../src/kernel/workflow-decisions.mjs';
import {routedApprovalSelection,planRoutedApproval,routingChoiceSelection,planRoutingChoice,routingChoiceRequirements} from '../src/kernel/routed-approval.mjs';
import {decisionContextSelection} from '../src/kernel/decision-plan.mjs';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
const at='2026-11-08T18:00:00.000Z',key='a'.repeat(16),human={at,actorId:'reviewer',agentId:null,authorityGroup:'reviewers'};
function question({kind='ask',anyStep=false,enforceConditions=false}={}) {
  const phases=['capture','review','finish'].map(id=>({id,label:id,inputs:[],approval:{mode:'required',authorities:['reviewers']}}));
  const entry=kind==='loop'?{id:'quality',label:'Quality loop',kind:'loop',after:'review',inputs:[{name:'verdict',values:['Pass','Repair']}],
    goal:{verdict:'Pass'},back:'capture',maxRounds:1,enforceConditions}
    :{id:'direction',label:'Choose direction',kind:'ask',after:'capture',anyStep,
      routes:[{id:'continue',label:'Continue',to:'next'},{id:'finish',label:'Finish',to:'end'}]};
  const decisions=normalizeDecisions([entry],{phases,approvalAuthorities:{reviewers:{}}});
  const workflow={workItem:{id:'example'},phaseOrder:phases.map(item=>item.id),currentPhase:entry.after,status:'in_progress',history:[],resolution:{decisions},
    phases:Object.fromEntries(phases.map((phase,index)=>[phase.id,{...phase,generation:1,artifacts:[],approvals:[],
      status:phase.id===entry.after?'awaiting_approval':index<phases.findIndex(item=>item.id===entry.after)?'approved':'not_started'}]))};
  const phase=workflow.phases[entry.after];
  if(kind==='loop') {
    phase.decisionInputs={schemaVersion:1,decision:entry.id,values:{verdict:'Repair'},recordedAt:at,recordedBy:'author'};
    workflow.decisionRounds={quality:{count:1,audit:'preserve'}};
  }
  const selected=routedApprovalSelection(workflow,phase,{reached:true,at});
  return planRoutedApproval(workflow,phase.id,{...human,reached:true,
    decision:{decision:'approved',generation:1,at,principalId:human.actorId,authorityGroup:human.authorityGroup},
    outcome:selected.outcome,pending:{...selected.pending,key}}).workflow;
}
const request=(extra={})=>({option:'continue',to:null,expected:key,reason:'Human reviewed this route.',...extra});

test('human continuation is a detached proposal over the exact approved question',()=>{
  const workflow=question(),before=structuredClone(workflow),result=planRoutingChoice(workflow,request(),human);
  assert.equal(result.workflow.currentPhase,'review');assert.equal(result.workflow.phases.review.status,'in_progress');
  assert.equal(result.workflow.phases.capture.approvals.length,1);assert.equal(result.workflow.pendingDecision,undefined);
  assert.equal(result.outcome.by,'person');assert.equal(result.workflow.decisionLog.at(-1).pendingKey,key);
  assert.equal(result.workflow.history.at(-1).event,'decision_made');assert.deepEqual(workflow,before);
});

test('an explicit end choice skips without manufacturing phase approvals or evidence',()=>{
  const result=planRoutingChoice(question(),request({option:'finish'}),human);
  assert.equal(result.workflow.status,'closed');assert.equal(result.workflow.currentPhase,null);
  for(const id of ['review','finish']) {
    assert.equal(result.workflow.phases[id].status,'skipped');assert.deepEqual(result.workflow.phases[id].approvals,[]);
    assert.equal(result.workflow.phases[id].testExecution,undefined);
  }
});

test('an authorized manual rework after a limit adds a real round and clears affected decisions',()=>{
  const workflow=question({kind:'loop',enforceConditions:true});
  assert.deepEqual(decisionContextSelection(workflow).question.reopenableSteps,['capture']);
  const result=planRoutingChoice(workflow,request({option:null,to:'capture'}),human);
  assert.equal(result.workflow.currentPhase,'capture');assert.equal(result.workflow.decisionRounds.quality.count,2);
  assert.equal(result.workflow.decisionRounds.quality.audit,'preserve');assert.equal(result.workflow.phases.review.generation,1);
  assert.equal(result.workflow.phases.review.approvals[0].invalidatedAt,at);assert.equal(result.workflow.phases.review.decisionInputs,undefined);
  assert.equal(result.workflow.changeRequests[0].decision.by,'person');assert.equal(result.workflow.changeRequests[0].decision.maxRounds,1);
  assert.equal(result.workflow.changeRequests[0].comment,request().reason);assert.equal(result.workflow.changeRequests[0].status,'open');
});

test('enforced conditions cannot be turned into a human passing result',()=>{
  const workflow=question({kind:'loop',enforceConditions:true}),before=structuredClone(workflow);
  assert.throws(()=>planRoutingChoice(workflow,request({option:'goal-met'}),human));
  assert.throws(()=>planRoutingChoice(workflow,request({option:null,to:'finish'}),human),{code:'DECISION_STEP_NOT_ALLOWED'});
  assert.deepEqual(workflow,before);
});

test('an arbitrary named step still respects pinned dependencies',()=>{
  const workflow=question({anyStep:true});workflow.phases.finish.inputs=[{phase:'review',optional:false}];
  const before=structuredClone(workflow);
  assert.throws(()=>planRoutingChoice(workflow,request({option:null,to:'finish'}),human),{code:'DECISION_STEP_NOT_ALLOWED'});
  assert.deepEqual(workflow,before);
});

test('stale or missing confirmation, absent reason, conflicting targets and malformed rework leave input intact',()=>{
  for(const [input,code]of [[{expected:null},'ENGINE_DECISION_CONFIRMATION_REQUIRED'],[{expected:'b'.repeat(16)},'DECISION_STALE'],
    [{reason:'  '},'DECISION_REASON_REQUIRED'],[{to:'finish'},'DECISION_CHOICE_REQUIRED'],[{option:'missing'},'DECISION_OPTION_UNKNOWN']]) {
    const workflow=question(),before=structuredClone(workflow);
    assert.throws(()=>planRoutingChoice(workflow,request(input),human),{code});assert.deepEqual(workflow,before);
  }
  const workflow=question({anyStep:true});workflow.phases.review.approvals=null;const before=structuredClone(workflow);
  assert.throws(()=>planRoutingChoice(workflow,request({option:null,to:'capture'}),human),{code:'LIFECYCLE_TRANSITION_INVALID'});
  assert.deepEqual(workflow,before);
});

test('changed pending options, authorities and facts cannot replace the pinned question',()=>{
  for(const change of [w=>w.pendingDecision.options[0].to='end',w=>w.pendingDecision.by.push('unrelated'),
    w=>w.pendingDecision.values={verdict:'Pass'},w=>w.phases.capture.status='in_progress',w=>w.currentPhase='review']) {
    const workflow=question();change(workflow);
    assert.throws(()=>decisionContextSelection(workflow),{code:'DECISION_STATE_INVALID'});
  }
});

test('routing admission considers future delivery responsibilities as well as the current review',()=>{
  const workflow=question();workflow.resolution.obligationGraph={nodes:workflow.phaseOrder.map(id=>({id,responsibilities:['review']}))};
  assert.equal(routingChoiceRequirements(workflow,workflow.phases.capture).includes('routing-delivery-obligations'),false);
  workflow.resolution.obligationGraph.nodes.at(-1).responsibilities=['implement'];
  assert.equal(routingChoiceRequirements(workflow,workflow.phases.capture).includes('routing-delivery-obligations'),true);
});

test('the registered decision context returns bounded provenance without side effects or host decoration',async()=>{
  const workflow=question(),proof={generation:1,reviewPacketSha256:'b'.repeat(64),approvalSha256:'c'.repeat(64)},calls=[];
  const facts={workId:'example',phase:'capture',revision:'opaque-observed-revision',pendingKey:key,proof};
  const engine=createEngine({ports:{decisionContext:{load:()=>({subject:{kind:'story',id:'example',privateHostData:'omit'},workflow}),
    read:async(...args)=>{calls.push(args);return facts;}}}});
  const result=await engine.run('decision.context',{workId:'example'});
  assert.deepEqual(result.subject,{kind:'story',id:'example'});assert.deepEqual(result.effects,{committed:false,pushed:false,humanDecisionRecorded:false});
  assert.equal(result.manifest.question.key,key);assert.equal(result.manifest.question.generation,1);assert.deepEqual(result.manifest.proof,proof);
  assert.equal(calls.length,1);assert.equal(ENGINE_OPERATIONS.find(item=>item.id==='decision.context').humanDecision,false);
  assert.equal(Object.isFrozen(result.manifest.question.options),true);
  for(const bad of [{...facts,pendingKey:'d'.repeat(16)},{...facts,proof:null},{...facts,proof:{...proof,generation:2}},{...facts,command:'shell'}]) {
    const wrong=createEngine({ports:{decisionContext:{load:()=>({subject:{kind:'story',id:'example'},workflow}),read:()=>bad}}});
    await assert.rejects(wrong.run('decision.context'),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  await assert.rejects(engine.run('decision.context',{workId:'other'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  const nonJson=createEngine({ports:{decisionContext:{load:()=>({subject:{kind:'story',id:'example'},workflow}),read:()=>({callback(){}})}}});
  await assert.rejects(nonJson.run('decision.context'),{code:'ENGINE_PORT_RESULT_INVALID'});
  const abort=new AbortController();abort.abort();const count=calls.length;
  await assert.rejects(engine.run('decision.context',{}, {signal:abort.signal}),{code:'ENGINE_OPERATION_CANCELLED'});assert.equal(calls.length,count);
});

test('a Story without a pending question has an explicit empty decision context',async()=>{
  const workflow=planRoutingChoice(question(),request({option:'finish'}),human).workflow;
  const engine=createEngine({ports:{decisionContext:{load:()=>({subject:{kind:'story',id:'example'},workflow}),
    read:()=>({workId:'example',phase:null,revision:'terminal-revision',pendingKey:null,proof:null})}}});
  assert.equal((await engine.run('decision.context')).manifest.question,null);
  assert.throws(()=>routingChoiceSelection(workflow,request()),{code:'DECISION_NOT_PENDING'});
});
