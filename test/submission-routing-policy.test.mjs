import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDecisions} from '../src/kernel/workflow-decisions.mjs';
import {submissionRoutingSelection,assertSubmittedRoutingSelection} from '../src/kernel/submission-routing.mjs';
const at='2026-11-08T12:00:00.000Z';
function fixture() {
  const phases=['capture','assess','finish'].map(id=>({id,label:id,inputs:[],approval:{mode:'required',authorities:['reviewers']}}));
  const decisions=normalizeDecisions([
    {id:'channel',label:'Channel',after:'capture',kind:'branch',inputs:[{name:'channel',values:['Web','Mobile']},{name:'tier',values:['high','low']}],
      routes:[{id:'web',label:'Web',when:{channel:'Web'},to:'next'},{id:'other',label:'Other',to:'next'}]},
    {id:'delivery',label:'Delivery',after:'assess',kind:'branch',inputs:[{name:'channel',from:'channel'},{name:'tier',from:'channel'},{name:'grade',type:'number',minimum:0,maximum:5}],
      routes:[{id:'web',label:'Web',when:{channel:'Web'},to:'next'},{id:'other',label:'Other',to:'next'}]}
  ],{phases,approvalAuthorities:{reviewers:{}}});
  const workflow={workItem:{id:'EXAMPLE'},phaseOrder:phases.map(phase=>phase.id),resolution:{decisions},phases:Object.fromEntries(phases.map(phase=>[
    phase.id,{...phase,generation:3,status:phase.id==='capture'?'approved':'in_progress'}]))};
  workflow.phases.capture.decisionInputs={schemaVersion:1,decision:'channel',values:{channel:'Web',tier:'high'},recordedAt:at,recordedBy:'original-author'};
  workflow.phases.assess.decisionInputs={schemaVersion:1,decision:'delivery',values:{grade:4},recordedAt:at,recordedBy:'current-author'};
  return workflow;
}
test('routing selection groups reused values by their original approved decision without mutating or granting authority',()=>{
  const workflow=fixture(),before=structuredClone(workflow),selected=submissionRoutingSelection(workflow,workflow.phases.assess);
  assert.deepEqual(selected,{decision:'delivery',record:workflow.phases.assess.decisionInputs,
    reused:[{decision:'channel',phase:'capture',generation:3,values:{channel:'Web',tier:'high'}}]});
  selected.record.values.grade=0;selected.reused[0].values.tier='low';assert.deepEqual(workflow,before);
  assert.equal(submissionRoutingSelection(workflow,workflow.phases.finish),null);
});
test('unapproved, missing, noncanonical and forward input sources cannot become reusable facts',()=>{
  for(const change of [w=>{w.phases.capture.status='awaiting_approval';},w=>{delete w.phases.capture.decisionInputs;},
    w=>{w.phases.capture.decisionInputs.values.channel='web';},w=>{w.phases.assess.decisionInputs.values.grade=9;},
    w=>{w.phaseOrder=['assess','capture','finish'];},w=>{w.phaseOrder=['assess','finish'];}]) {
    const workflow=fixture();change(workflow);assert.throws(()=>submissionRoutingSelection(workflow,workflow.phases.assess));
  }
});
test('submitted routing comparison binds the exact own record and reused source generation and values',()=>{
  const workflow=fixture(),selection=submissionRoutingSelection(workflow,workflow.phases.assess);
  const routing={...selection,reused:selection.reused.map(source=>({...source,packet:{namespace:'evidence',sha256:'a'.repeat(64),bytes:1}}))};
  assert.deepEqual(assertSubmittedRoutingSelection(workflow,workflow.phases.assess,routing),selection);
  for(const change of [value=>{value.record.values.grade=3;},value=>{value.reused[0].generation++;},value=>{value.reused[0].values.tier='low';},
    value=>{value.reused=[];},value=>{value.decision='other';}]) {
    const changed=structuredClone(routing);change(changed);
    assert.throws(()=>assertSubmittedRoutingSelection(workflow,workflow.phases.assess,changed),{code:'SUBMISSION_ROUTING_BINDING_CHANGED'});
  }
});
