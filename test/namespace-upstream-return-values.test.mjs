import test from 'node:test';import assert from 'node:assert/strict';
import {raiseUpstreamIssue,planNamespaceUpstreamReturn,NAMESPACE_UPSTREAM_RETURN_PROFILE} from '../src/kernel/upstream-issues.mjs';
const at='2026-11-10T00:00:00.000Z',facts={at,actorId:'reviewer',actorKind:'human',agentId:null,authorityGroup:'reviewers'},
  request={phaseId:'intake',issueId:'UPI-001',outcome:'return',reason:'Correct the original producer before the current phase relies on its omitted consequence.'};
function fixture(){const workflow={workItem:{id:'return-values'},status:'in_progress',currentPhase:'code',phaseOrder:['intake','code'],history:[],
  phases:{intake:{id:'intake',status:'approved',generation:1,approvalPolicy:{authorities:['reviewers']},artifacts:[{path:'scope.md',sha256:'a'.repeat(64)}],approvals:[]},
    code:{id:'code',status:'in_progress',generation:0,artifacts:[],approvals:[]}}};
  const issue=raiseUpstreamIssue(workflow,{phase:'intake',about:'observable consequence',problem:'The approved document omitted an observable consequence.',
    raisedBy:'author',authored:'human',at});return {workflow,source:{issue,issueProducer:{schemaVersion:1,format:'sflow-phase-publication-binding/v1',generation:1,
      record:{namespace:'evidence',sha256:'b'.repeat(64),bytes:50}}}};}
test('a namespace upstream return preserves its input and opens one generation-zero repair without a fabricated packet',()=>{
  const {workflow,source}=fixture(),original=structuredClone(workflow),planned=planNamespaceUpstreamReturn(workflow,request,facts,source),cr=planned.outcome.record.changeRequest;
  assert.deepEqual(workflow,original);assert.equal(cr.profile,NAMESPACE_UPSTREAM_RETURN_PROFILE);assert.equal(cr.sourceGeneration,0);assert.equal(cr.reviewPacketSha256,null);
  assert.equal(planned.workflow.currentPhase,'intake');assert.equal(planned.workflow.upstreamIssueDecisions.length,1);assert.equal(planned.workflow.changeRequests.length,1);
  assert.deepEqual(cr.upstreamIssue.producer,source.issueProducer);assert.deepEqual(planned.workflow.phases.intake.artifacts,original.phases.intake.artifacts);
});
test('a refused return cannot mutate the original Story or invent another owner',()=>{
  for(const change of [workflow=>{workflow.status='closed';},workflow=>{workflow.phases.code.status='not_started';}]){
    const {workflow,source}=fixture();change(workflow);const original=structuredClone(workflow);
    assert.throws(()=>planNamespaceUpstreamReturn(workflow,request,facts,source),{code:'UPSTREAM_ISSUE_RETURN_UNAVAILABLE'});assert.deepEqual(workflow,original);}
  const {workflow,source}=fixture(),original=structuredClone(workflow);
  assert.throws(()=>planNamespaceUpstreamReturn(workflow,{...request,link:'CR-999'},facts,source),{code:'UPSTREAM_ISSUE_INVALID'});
  assert.throws(()=>planNamespaceUpstreamReturn(workflow,{...request,reason:'too short'},facts,source),{code:'UPSTREAM_ISSUE_REASON_REQUIRED'});
  assert.deepEqual(workflow,original);
});
