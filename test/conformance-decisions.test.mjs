import test from 'node:test';import assert from 'node:assert/strict';
import {conformanceDecisionSelection,planConformanceDecision,conformanceDecisionActive,planNamespaceRejection} from '../src/kernel/conformance-decisions.mjs';
import {upstreamDispositionFacts} from '../src/kernel/decision-plan.mjs';
const at='2026-11-08T00:00:00.000Z',expected='a'.repeat(64),packet='b'.repeat(64),
  source={generation:1,expected,gaps:[{clauseId:'S:REQ-001',verdict:'partial',owners:['build']}],reviewPacket:{sha256:packet}},
  request={phaseId:'release',expected,clauseId:'S:REQ-001',ownerPhase:'build',outcome:'accept-risk',expires:'2026-11-09',reason:'The upstream owner accepts this bounded limitation.'},
  facts={at,actorId:'reviewer',agentId:null,authorityGroup:'engineering'};
const workflow=()=>({workItem:{id:'S'},status:'in_progress',currentPhase:'release',phaseOrder:['build','release'],history:[],
  phases:{build:{id:'build',status:'approved',generation:1,approvals:[],artifacts:[]},
    release:{id:'release',status:'awaiting_approval',generation:1,approvals:[],artifacts:[],approvalPolicy:{rejectTo:['build','release']}}}});
test('human conformance dispositions keep partial verdicts and never complete or approve the phase',()=>{
  const w=workflow(),before=structuredClone(w),planned=planConformanceDecision(w,request,facts,source);
  assert.deepEqual(w,before);assert.equal(planned.workflow.currentPhase,'release');assert.deepEqual(planned.workflow.phases,w.phases);
  assert.equal(planned.outcome.verdict,'partial');assert.equal(planned.outcome.expiresAt,'2026-11-09T00:00:00.000Z');
  assert.equal(conformanceDecisionActive({request,outcome:planned.outcome},'2026-11-09T00:00:00.000Z'),false);
});
for(const [name,change,code]of [
  ['stale report',r=>r.expected='c'.repeat(64),'ENGINE_DECISION_CONFIRMATION_STALE'],
  ['wrong upstream owner',r=>r.ownerPhase='release','ENGINE_CONFORMANCE_OWNER_INVALID'],
  ['unknown clause',r=>r.clauseId='S:REQ-999','ENGINE_CONFORMANCE_OWNER_INVALID'],
  ['unsupported outcome',r=>r.outcome='approve','ENGINE_INPUT_INVALID'],
  ['no reason',r=>r.reason='yes','UPSTREAM_ISSUE_REASON_REQUIRED'],
  ['expired risk',r=>r.expires=at,'UPSTREAM_ISSUE_RISK_EXPIRY_REQUIRED'],
  ['unbounded risk',r=>r.expires='2027-11-09','UPSTREAM_ISSUE_RISK_EXPIRY_REQUIRED']])test(name,()=>{
    const r=structuredClone(request);change(r);assert.throws(()=>conformanceDecisionSelection(workflow(),r,source,{at}),{code});
  });
test('the native and namespace expiry rule requires a reason and dates only accepted risks',()=>{
  assert.deepEqual(upstreamDispositionFacts({outcome:'dismiss',reason:request.reason,at}),{reason:request.reason,expiresAt:null});
  assert.throws(()=>upstreamDispositionFacts({outcome:'dismiss',reason:request.reason,expiresAt:'2026-11-09',at}),{code:'UPSTREAM_ISSUE_INVALID'});
});
test('reviewer return reopens exactly the configured range without changing generations or source evidence',()=>{
  const w=workflow();w.sourceBindings={current:{operationId:'original'}};const before=structuredClone(w),
    result=planNamespaceRejection(w,{phaseId:'release',target:'build',reason:request.reason,confirm:packet},facts,source);
  assert.deepEqual(w,before);assert.equal(result.workflow.currentPhase,'build');assert.deepEqual(result.workflow.sourceBindings,w.sourceBindings);
  assert.equal(result.workflow.phases.build.generation,1);assert.equal(result.workflow.phases.release.status,'not_started');
  assert.equal(result.outcome.changeRequest.reviewPacketSha256,packet);
  assert.throws(()=>planNamespaceRejection(w,{phaseId:'release',target:'build',reason:request.reason,confirm:expected},facts,source),{code:'ENGINE_APPROVAL_CONFIRMATION_STALE'});
});
test('an authorized return to an unstarted phase preserves generation zero for its first actual preparation',()=>{
  const w=workflow();Object.assign(w.phases.build,{status:'skipped',generation:0});const before=structuredClone(w),
    result=planNamespaceRejection(w,{phaseId:'release',target:'build',reason:request.reason,confirm:packet},facts,source);
  assert.deepEqual(w,before);assert.equal(result.workflow.currentPhase,'build');assert.equal(result.workflow.phases.build.generation,0);
  assert.equal(result.workflow.phases.build.reworkRevalidation.generation,0);assert.equal(result.workflow.phases.build.status,'in_progress');
});
