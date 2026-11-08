/** Wire validation only: these detached proposals do not cast or retain a human vote. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonicalJson,NAMESPACE_APPROVAL_SCHEMAS} from '../src/foundation/record-schema.mjs';
import {normalizeDecisions} from '../src/kernel/workflow-decisions.mjs';
import {routedApprovalSelection} from '../src/kernel/routed-approval.mjs';
import {namespaceApprovalRecord,namespaceApprovalValue,namespaceApprovalReceipt,namespaceApprovalReceiptValue,namespaceApprovalReceipts,
  NAMESPACE_ROUTED_APPROVAL_PROFILE} from '../src/engine-storage/namespace-approval-contract.mjs';
const capture=JSON.parse(await readFile(new URL('./fixtures/namespace-approval-packets/native-v1.json',import.meta.url),'utf8'));
function proposal(kind='branch',reached=true) {
  const {schemaVersion,format,profile,...data}=JSON.parse(capture.cases[0].wire);
  const phases=['intake','next'].map(id=>({id,label:id,inputs:[],approval:{mode:'required',authorities:['reviewers']}}));
  const entry=kind==='ask'?{id:'direction',label:'Direction',kind,after:'intake',routes:[{id:'next',label:'Next',to:'next'},{id:'end',label:'End',to:'end'}]}
    :kind==='loop'?{id:'quality',label:'Quality',kind,after:'intake',inputs:[{name:'result',values:['Pass','Repair']}],goal:{result:'Pass'},back:'intake',maxRounds:1}
      :{id:'channel',label:'Channel',kind,after:'intake',inputs:[{name:'channel',values:['Web','Mobile']}],
        routes:[{id:'web',label:'Web',when:{channel:'Web'},to:'next'},{id:'end',label:'End',to:'end'}]};
  const workflow={phaseOrder:['intake','next'],resolution:{decisions:normalizeDecisions([entry],{phases,approvalAuthorities:{reviewers:{}}})},
    phases:{intake:{id:'intake',generation:1},next:{id:'next',generation:0}}};
  if(kind!=='ask')workflow.phases.intake.decisionInputs={schemaVersion:1,decision:entry.id,values:kind==='loop'?{result:'Repair'}:{channel:'Web'},recordedAt:data.recordedAt,recordedBy:'author'};
  const selected=routedApprovalSelection(workflow,workflow.phases.intake,{reached,at:data.recordedAt});
  const routing={schemaVersion:1,format:'sflow-namespace-phase-approval-routing/v1',decision:selected.decision,outcome:selected.outcome,
    pendingKey:selected.pending?createHash('sha256').update(canonicalJson(selected.pending)).digest('hex').slice(0,16):null};
  const value=namespaceApprovalRecord({...data,currentPhase:selected.currentPhase,thresholdReached:reached},{routing});
  return {value,binding:{projectId:data.projectId,workId:data.workId,phaseId:'intake'},data};
}
test('the explicit v2 vote profile binds branch, loop, ask and partial-threshold wire meanings',()=>{
  for(const [kind,reached]of [['branch',true],['loop',true],['ask',true],['branch',false]]) {
    const {value,binding}=proposal(kind,reached);
    assert.equal(namespaceApprovalValue(value,binding),value);assert.equal(value.schemaVersion,2);assert.equal(value.profile,NAMESPACE_ROUTED_APPROVAL_PROFILE);
    assert.equal(value.thresholdReached,value.routing.outcome!==null);assert.equal(value.routing.pendingKey!==null,value.routing.outcome?.kind==='pause');
  }
});
test('malformed routing fields cannot masquerade as a human-approved pinned outcome',()=>{
  const {value,binding}=proposal();
  for(const change of [v=>{v.routing.decision='other';},v=>{v.routing.outcome.after='another-phase';},v=>{v.routing.outcome.target=null;},
    v=>{v.routing.outcome.by='person';},v=>{v.routing.outcome.skipped=['next','next'];},v=>{v.routing.pendingKey='a'.repeat(16);},
    v=>{v.routing.outcome.ready=true;},v=>{v.routing.outcome=null;},v=>{v.routing.recordedBy='caller';}]) {
    const changed=structuredClone(value);change(changed);
    assert.throws(()=>namespaceApprovalValue(changed,binding),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  const ask=proposal('ask');ask.value.routing.pendingKey=null;
  assert.throws(()=>namespaceApprovalValue(ask.value,ask.binding),{code:'ENGINE_STORAGE_CORRUPT'});
});
test('future routed vote families preserve unsupported-schema errors rather than becoming missing evidence',()=>{
  const {value,binding}=proposal();
  for(const change of [v=>{v.schemaVersion=NAMESPACE_APPROVAL_SCHEMAS.vote.maximumReadableVersion+1;},v=>{v.routing.schemaVersion=2;}]) {
    const changed=structuredClone(value);change(changed);
    assert.throws(()=>namespaceApprovalValue(changed,binding),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  }
});
test('the writer owns wire profile metadata and cannot reinterpret a v1 vote through caller fields',()=>{
  const {data}=proposal();
  for(const field of ['schemaVersion','format','profile','routing'])assert.throws(()=>namespaceApprovalRecord({...data,[field]:'caller'}),{code:'ENGINE_INPUT_INVALID'});
  assert.equal(namespaceApprovalRecord(data).schemaVersion,1);assert.equal(Object.hasOwn(namespaceApprovalRecord(data),'routing'),false);
});

test('receipt links keep exact scope and vote references and cannot hide malformed or duplicate inventories',()=>{
  const {value,binding:scope}=proposal(),wire=Buffer.from(canonicalJson(value));
  const binding={schemaVersion:1,format:'sflow-namespace-phase-approval-binding/v1',generation:value.generation,
    record:{namespace:'evidence',sha256:createHash('sha256').update(wire).digest('hex'),bytes:wire.byteLength}};
  const receipt=namespaceApprovalReceipt(value,binding);
  assert.deepEqual(receipt.record,binding.record);assert.equal(receipt.principalId,value.actor.principalId);
  assert.equal(namespaceApprovalReceipts({namespaceApprovalReceipts:[receipt]},scope).length,1);
  assert.deepEqual(namespaceApprovalReceipts({},scope),[]);
  for(const inventory of [null,{},[receipt,structuredClone(receipt)]])assert.throws(()=>namespaceApprovalReceipts({namespaceApprovalReceipts:inventory},scope),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.throws(()=>namespaceApprovalReceiptValue({...receipt,projectId:'another-project'},scope),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.throws(()=>namespaceApprovalReceiptValue({...receipt,schemaVersion:2},scope),{code:'ENGINE_STORAGE_UNSUPPORTED'});
});
