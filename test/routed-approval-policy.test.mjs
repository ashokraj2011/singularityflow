import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDecisions} from '../src/kernel/workflow-decisions.mjs';
import {routedApprovalSelection,planRoutedApproval} from '../src/kernel/routed-approval.mjs';
const at='2026-11-08T18:00:00.000Z';
function fixture(kind='branch') {
  const phases=['capture','review','finish'].map(id=>({id,label:id,inputs:[],approval:{mode:'required',authorities:['reviewers']}}));
  const entry=kind==='loop'?{id:'quality',label:'Quality loop',kind:'loop',after:'review',inputs:[{name:'verdict',values:['Pass','Repair']}],
    goal:{verdict:'Pass'},back:'capture',maxRounds:1}:kind==='ask'?{id:'direction',label:'Choose direction',kind:'ask',after:'capture',
    routes:[{id:'continue',label:'Continue',to:'next'},{id:'finish',label:'Finish',to:'end'}]}:
    {id:'channel',label:'Choose channel',kind:'branch',after:'capture',inputs:[{name:'channel',values:['Web','Mobile']}],
      routes:[{id:'web',label:'Web',when:{channel:'Web'},to:'finish'},{id:'mobile',label:'Mobile',to:'end'}]};
  const decisions=normalizeDecisions([entry],{phases,approvalAuthorities:{reviewers:{}}}),currentPhase=entry.after;
  const workflow={workItem:{id:'example'},currentPhase,status:'in_progress',phaseOrder:phases.map(item=>item.id),resolution:{decisions},history:[],
    phases:Object.fromEntries(phases.map((phase,index)=>[phase.id,{...phase,generation:1,artifacts:[],approvals:[],
      status:phase.id===currentPhase?'awaiting_approval':index<phases.findIndex(item=>item.id===currentPhase)?'approved':'not_started'}]))};
  if(kind!=='ask')workflow.phases[currentPhase].decisionInputs={schemaVersion:1,decision:entry.id,
    values:kind==='loop'?{verdict:'Repair'}:{channel:'Web'},recordedAt:at,recordedBy:'author'};
  return workflow;
}
function facts(workflow,reached=true) {
  const phase=workflow.phases[workflow.currentPhase],selected=routedApprovalSelection(workflow,phase,{reached,at});
  return {decision:{decision:'approved',generation:1,at,principalId:'reviewer',authorityGroup:'reviewers'},reached,at,
    actorId:'reviewer',agentId:null,authorityGroup:'reviewers',outcome:selected.outcome,pending:selected.pending?{...selected.pending,key:'a'.repeat(16)}:null};
}

test('a partial human threshold records its vote without applying a route or mutating the input',()=>{
  const workflow=fixture(),before=structuredClone(workflow),input=facts(workflow,false),result=planRoutedApproval(workflow,'capture',input);
  assert.equal(result.workflow.phases.capture.approvals.length,1);assert.equal(result.workflow.phases.capture.status,'awaiting_approval');
  assert.equal(result.workflow.currentPhase,'capture');assert.equal(result.outcome,null);assert.equal(result.workflow.decisionLog,undefined);
  assert.deepEqual(workflow,before);result.workflow.phases.capture.approvals[0].at='changed';assert.equal(input.decision.at,at);
});

test('a pinned forward route skips only its declared range after human approval',()=>{
  const workflow=fixture(),before=structuredClone(workflow),result=planRoutedApproval(workflow,'capture',facts(workflow));
  assert.equal(result.workflow.phases.capture.status,'approved');assert.equal(result.workflow.phases.review.status,'skipped');
  assert.equal(result.workflow.phases.finish.status,'in_progress');assert.equal(result.workflow.currentPhase,'finish');
  assert.deepEqual(result.workflow.phases.review.skippedBy,{decision:'channel',route:'web'});
  assert.equal(result.workflow.decisionLog[0].kind,'forward');assert.deepEqual(workflow,before);
});

test('a pinned end route closes the Story and does not manufacture approvals for skipped phases',()=>{
  const workflow=fixture();workflow.phases.capture.decisionInputs.values.channel='Mobile';
  const result=planRoutedApproval(workflow,'capture',facts(workflow));
  assert.equal(result.workflow.status,'closed');assert.equal(result.workflow.currentPhase,null);
  assert.deepEqual(['review','finish'].map(id=>[result.workflow.phases[id].status,result.workflow.phases[id].approvals.length]),[['skipped',0],['skipped',0]]);
});

test('an ask decision retains an approved current phase and an unanswered exact question',()=>{
  const workflow=fixture('ask'),result=planRoutedApproval(workflow,'capture',facts(workflow));
  assert.equal(result.workflow.phases.capture.status,'approved');assert.equal(result.workflow.currentPhase,'capture');
  assert.equal(result.workflow.phases.review.status,'not_started');assert.equal(result.workflow.pendingDecision.key,'a'.repeat(16));
  assert.deepEqual(result.workflow.pendingDecision.options.map(item=>item.id),['continue','finish']);
  assert.equal(result.workflow.decisionLog[0].kind,'pause');assert.equal(result.workflow.decisionLog[0].pendingKey,'a'.repeat(16));
});

test('a failed approved round reopens its range, invalidates the actual vote and preserves generation counters',()=>{
  const workflow=fixture('loop'),before=structuredClone(workflow);
  workflow.phases.capture.approvals.push({decision:'approved',generation:1,at:'earlier'});
  workflow.decisionRounds={quality:{count:0,auditMarker:'preserve'}};
  workflow.lineage={submissions:[{phase:'review',generation:1,packetSha256:'b'.repeat(64)}]};
  const original=structuredClone(workflow),result=planRoutedApproval(workflow,'review',facts(workflow));
  assert.equal(result.workflow.currentPhase,'capture');assert.equal(result.workflow.phases.capture.status,'in_progress');
  assert.equal(result.workflow.phases.review.status,'not_started');assert.equal(result.workflow.phases.review.approvals[0].invalidatedAt,at);
  assert.equal(result.workflow.phases.capture.approvals[0].invalidatedAt,at);
  assert.equal(result.workflow.phases.review.decisionInputs,undefined);assert.equal(result.workflow.phases.review.generation,1);
  assert.deepEqual(result.workflow.decisionRounds.quality,{count:1,lastAt:at,auditMarker:'preserve'});
  assert.equal(result.workflow.changeRequests[0].reviewPacketSha256,'b'.repeat(64));assert.equal(result.workflow.changeRequests[0].status,'open');
  assert.equal(result.workflow.changeRequests[0].sourceGeneration,1);assert.equal(result.workflow.changeRequests[0].targetPhase,'capture');
  assert.deepEqual(workflow,original);assert.equal(before.phases.review.status,'awaiting_approval');
});

test('an exhausted loop pauses for a person without incrementing its limit or reporting a successful result',()=>{
  const workflow=fixture('loop');workflow.decisionRounds={quality:{count:1,lastAt:'earlier'}};
  const result=planRoutedApproval(workflow,'review',facts(workflow));
  assert.equal(result.workflow.currentPhase,'review');assert.equal(result.workflow.phases.review.status,'approved');
  assert.equal(result.workflow.pendingDecision.reason,'limit');assert.deepEqual(result.workflow.pendingDecision.values,{verdict:'Repair'});
  assert.equal(result.workflow.decisionRounds.quality.count,1);assert.equal(result.workflow.changeRequests,undefined);
  assert.equal(result.workflow.phases.capture.status,'approved');
});

test('a goal-met loop moves forward without rework or a synthetic execution verdict',()=>{
  const workflow=fixture('loop');workflow.phases.review.decisionInputs.values.verdict='Pass';
  const result=planRoutedApproval(workflow,'review',facts(workflow));
  assert.equal(result.workflow.currentPhase,'finish');assert.equal(result.workflow.phases.finish.status,'in_progress');
  assert.equal(result.workflow.changeRequests,undefined);assert.equal(result.workflow.decisionRounds,undefined);
  assert.equal(result.workflow.phases.review.testExecution,undefined);
});

test('changed routes, stale questions, malformed rework and mismatched votes cannot partly change the caller',()=>{
  for(const [kind,change]of [['branch',(w,f)=>{f.outcome.target='review';}],['ask',(w,f)=>{f.pending.options[0].to='end';}],
    ['loop',(w,f)=>{w.phases.capture.approvals=null;}],['loop',(w,f)=>{w.decisionRounds={quality:{count:'invalid'}};}],
    ['branch',(w,f)=>{f.decision.principalId='other';}],['branch',(w,f)=>{f.decision.generation=2;}],
    ['branch',(w,f)=>{w.currentPhase='review';}]]) {
    const workflow=fixture(kind),input=facts(workflow);change(workflow,input);const before=structuredClone(workflow),supplied=structuredClone(input);
    assert.throws(()=>planRoutedApproval(workflow,kind==='loop'?'review':'capture',input));
    assert.deepEqual(workflow,before);assert.deepEqual(input,supplied);
  }
});
