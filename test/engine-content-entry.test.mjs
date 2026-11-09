/** Content-manifest validation cannot accept missing sources or differently bound read plans. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {phaseEntryProtocol,phaseContextResources,CONTENT_PHASE_ENTRY_PROFILE} from '../src/kernel/phase-entry.mjs';
const digest='a'.repeat(64),reference={namespace:'state',sha256:digest,bytes:20};
const resource=(kind,id,extra={})=>({id,kind,reference,locality:'project',availability:'verified',phase:null,generation:null,...extra});
function fixture() {
  const protocol=phaseEntryProtocol({manifestProfile:CONTENT_PHASE_ENTRY_PROFILE}),context={projectId:'project',paused:false,modelEnabled:true,
    subject:{kind:'story',id:'story'},revision:'actual-revision',ready:true,inspectionGeneration:1,generatesCode:false,codeGenerationReady:false,deterministic:false,agentId:'author',
    workflow:{workItem:{id:'story'},currentPhase:'custom',phases:{custom:{id:'custom',defaultAgent:'author',generation:0,status:'in_progress',clarification:{mode:'off'}}},resolution:{inputsMode:'enforce',phases:[{id:'custom',inputs:[]}]}}};
  const binding=protocol.selection(context,{}),facts={workId:'story',phase:'custom',generation:0,inspectionGeneration:1,projectId:'project',
    authoring:{entry:{status:'authoring-entry',reason:null},policyVerified:true,policyReason:null,hasAuthoringRoute:true,targetGeneration:null},
    recovery:{requiresRecovery:false,actions:[],blockers:[]},references:{status:'not-configured'},deterministic:false,
    documents:{status:'ready',localDocumentCount:0,documentCount:0,missing:[]},budgets:{documentPreviewBytes:65536,supportingTotalBytes:49152},
    resources:[resource('agent','author'),resource('story-source','source'),resource('artifact-template','template')],
    contextIdentity:{sha256:digest,bytes:100},permissions:['phase.enter','phase.draft.write'],draft:null,blockers:[],
    configuration:{key:'configuration/approved',content:{...reference,namespace:'config'}}};
  return {protocol,binding,facts};
}
test('the resource order retains dependency order, exact references and byte budgets',()=>{
  const values=[resource('story-source','source'),resource('instruction','first'),resource('skill','nested'),resource('instruction','second'),resource('constitution','constitution')];
  const result=phaseContextResources(values,{maximumBytes:5});assert.deepEqual(result.map(item=>item.id),['constitution','first','nested','second','source']);
  assert.deepEqual(result.map(item=>item.order),[1,2,3,4,5]);assert.ok(result.every(item=>item.budgetBytes===5));
  assert.deepEqual(values[0],resource('story-source','source'),'inventory construction does not mutate source facts');
  assert.throws(()=>phaseContextResources([resource('story-source','same'),resource('instruction','same')]),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.throws(()=>phaseContextResources([resource('supporting-document','local',{reference:{...reference,namespace:'local'}})]),{code:'ENGINE_PORT_RESULT_INVALID'});
  const missing=phaseContextResources([resource('supporting-document','local',{reference:{...reference,namespace:'local'},locality:'machine-local',availability:'reupload-required'})]);
  assert.equal(missing[0].availability,'reupload-required');
  const retained=phaseContextResources([resource('supporting-document','local',{reference:{...reference,namespace:'local'},locality:'machine-local',availability:'verify-on-read'})]);
  assert.equal(retained[0].availability,'verify-on-read');
  assert.throws(()=>phaseContextResources([resource('supporting-document','shared',{availability:'verify-on-read'})]),{code:'ENGINE_PORT_RESULT_INVALID'});
});
test('missing source, author, template, required input and undeclared document records cannot become admitted context',()=>{
  for(const mutate of [facts=>facts.resources.shift(),facts=>facts.resources.pop(),facts=>facts.resources.splice(1,1),
    facts=>facts.resources.push(resource('supporting-document','unaccounted')),
    facts=>facts.resources.push(resource('current-draft','unissued',{reference:{...reference,namespace:'local'},locality:'machine-local'}))]) {
    const f=fixture();mutate(f.facts);assert.throws(()=>f.protocol.inspection(f.binding,f.facts),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const f=fixture();f.binding.inputs=[{phase:'spec',generation:1,status:'approved',required:true,retained:[{role:'artifact',sha256:digest,bytes:20}]}];
  assert.throws(()=>f.protocol.inspection(f.binding,f.facts),{code:'ENGINE_PORT_RESULT_INVALID'});
  f.facts.resources.push(resource('approved-input','spec',{phase:'spec',generation:1}));assert.equal(f.protocol.inspection(f.binding,f.facts).admission.allowed,true);
  f.facts.resources.at(-1).reference={...reference,sha256:'b'.repeat(64)};
  assert.throws(()=>f.protocol.inspection(f.binding,f.facts),{code:'ENGINE_PORT_RESULT_INVALID'});
});
test('composition and clarification payloads cannot smuggle model prose or caller-computed readiness',()=>{
  const f=fixture();
  const composition={workId:'story',phase:'custom',generation:1,sha256:digest,bytes:100};
  assert.throws(()=>f.protocol.composition(f.binding,{...composition,text:'Prompt prose'}),{code:'ENGINE_PORT_RESULT_INVALID'});
  const clarification={workId:'story',phase:'custom',generation:1,contextSha256:digest,record:null};
  for(const extra of [{ready:true},{questioningAllowed:false},{answers:[]}])assert.throws(()=>f.protocol.clarification(f.binding,{...clarification,...extra}),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.equal(f.protocol.clarification(f.binding,clarification).recordState,'not-applicable');
});
