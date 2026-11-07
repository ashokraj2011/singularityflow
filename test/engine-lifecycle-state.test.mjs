import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import * as core from '../src/kernel/lifecycle-transitions.mjs';
import * as compatibility from '../src/lifecycle-transitions.mjs';
import {cancelledStoryRefusal} from '../src/phase-transition-routes.mjs';
import {beginPhaseSubmission,applyPhaseSubmissionDisposition,submittedDecisionInputPlan,applySubmittedDecisionInput,
  recordPhaseApprovalState} from '../src/kernel/lifecycle-transitions.mjs';
import {submissionDecisionIntent} from '../src/kernel/submission-intent.mjs';

const at='2026-11-08T10:00:00.000Z';
function phase(mode='required') {
  return {id:'custom-delivery',status:'in_progress',generation:3,submittedAt:null,approvedAt:null,approvedBy:null,
    approvalPolicy:{mode},approvalDisposition:'policy_waived',approvalWaiver:{policyId:'OLD'},
    submissionArchitectureDecision:{generation:2},artifacts:[{path:'retained.md',sha256:'a'.repeat(64)}],
    approvals:[{decision:'approved',invalidatedAt:'earlier',generation:2}],history:[{event:'phase_generated',generation:3}]};
}

test('aggregate moves preserve every original function body and all public compatibility identities',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/engine-lifecycle/native-v1.json',import.meta.url),'utf8'));
  const source=await readFile(new URL('../src/kernel/lifecycle-transitions.mjs',import.meta.url),'utf8');
  const ast=ts.createSourceFile('lifecycle-transitions.mjs',source,ts.ScriptTarget.Latest,true);
  for(const [name,expected] of Object.entries(fixture.functions)) {
    const node=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
    assert.ok(node,name);assert.equal(createHash('sha256').update(node.body.getText(ast)).digest('hex'),expected,name);
    if(!['phaseIndex','upcomingAfterOutcome','resolvePhaseChangeRequests'].includes(name))assert.equal(compatibility[name],core[name],name);
  }
  assert.equal(compatibility.cancelledStoryRefusal,cancelledStoryRefusal);
  const error=cancelledStoryRefusal({workItem:{id:'CANCELLED-1'}});
  assert.equal(error.code,'STORY_CANCELLED');assert.deepEqual(error.details.recoveryCommands,
    ['singularity-flow start <NEW-WORK-ID>','singularity-flow cancel CANCELLED-1 --release']);
});

test('submission records only the supplied checkpoint and preserves all historical evidence',()=>{
  const record=phase(),artifacts=record.artifacts,approvals=record.approvals,history=record.history;
  beginPhaseSubmission(record,at);
  assert.equal(record.submissionArchitectureDecision,null);assert.equal(record.submittedAt,at);
  assert.equal(record.status,'in_progress');assert.equal(record.approvalDisposition,'policy_waived');
  assert.equal(record.artifacts,artifacts);assert.equal(record.approvals,approvals);assert.equal(record.history,history);
});

test('completion selection and change-request resolution remain data-only and generation-bound',()=>{
  const record=phase(),later={id:'later',status:'not_started',approvals:[]};
  const workflow={phaseOrder:[record.id,later.id],phases:{[record.id]:record,later},changeRequests:[
    {id:'CR-1',status:'open',targetPhase:record.id},{id:'CR-2',status:'open',targetPhase:later.id},
    {id:'CR-3',status:'resolved',targetPhase:record.id,resolvedAt:'earlier'}]};
  assert.equal(core.upcomingAfterOutcome(workflow,record,null),later);
  assert.equal(core.upcomingAfterOutcome(workflow,record,{kind:'forward',target:'later'}),later);
  assert.equal(core.upcomingAfterOutcome(workflow,record,{kind:'pause'}),null);
  assert.deepEqual(core.resolvePhaseChangeRequests(workflow,record,{at,actor:'actor',completionDisposition:'not_required'}),['CR-1']);
  assert.deepEqual(workflow.changeRequests[0].resolution,{phase:record.id,generation:3,
    artifactSha256:[{path:'retained.md',sha256:'a'.repeat(64)}],completedAt:at,completionDisposition:'not_required'});
  assert.equal(workflow.changeRequests[1].status,'open');assert.equal(workflow.changeRequests[2].resolvedAt,'earlier');
  assert.deepEqual(core.resolvePhaseChangeRequests(workflow,record,{at:'later',actor:'another'}),[]);
});

test('no-approval, evaluated policy and human-review dispositions keep distinct evidence and authority meanings',()=>{
  const waiver={eligible:true,policyId:'quick-fix-low-risk-v1',policyHash:'sha256:'+'b'.repeat(64),
    sourceCommit:'c'.repeat(40),predicates:[{id:'bounded',passed:true}]};
  for(const [name,mode,facts,status,disposition] of [
    ['no approval','none',{},'approved','not_required'],
    ['required approval','required',{},'awaiting_approval',null],
    ['unsupported policy','policy',{},'awaiting_approval',null],
    ['evaluated waiver','policy',{waiver},'approved','policy_waived'],
    ['ineligible waiver','policy',{waiver:{...waiver,eligible:false}},'awaiting_approval',null],
    ['failed validation','none',{reviewableFailure:true},'awaiting_approval',null],
    ['application review owed','none',{applicationReviewPending:true},'awaiting_approval',null],
    ['waiver with failed validation','policy',{waiver,reviewableFailure:true},'awaiting_approval',null],
    ['waiver with application review owed','policy',{waiver,applicationReviewPending:true},'awaiting_approval',null]
  ]) {
    const record=phase(mode);record.workIntervalReconciliation={reconciliationSha256:'sha256:'+'d'.repeat(64)};
    const artifacts=record.artifacts,approvals=structuredClone(record.approvals),history=structuredClone(record.history);
    beginPhaseSubmission(record,at);
    const completed=applyPhaseSubmissionDisposition(record,{reviewableFailure:false,applicationReviewPending:false,waiver:null,...facts});
    assert.equal(completed,status==='approved',name);assert.equal(record.status,status,name);
    assert.equal(record.approvalDisposition??null,disposition,name);assert.equal(record.approvedBy,null,name);
    assert.equal(record.artifacts,artifacts,name);assert.deepEqual(record.approvals,approvals,name);assert.deepEqual(record.history,history,name);
    if(disposition==='policy_waived')assert.deepEqual(record.approvalWaiver,{policyId:waiver.policyId,policySha256:waiver.policyHash,
      sourceCommit:waiver.sourceCommit,reconciliationSha256:record.workIntervalReconciliation.reconciliationSha256,predicates:waiver.predicates,waivedAt:at});
    if(status==='awaiting_approval')assert.equal(Object.hasOwn(record,'approvalWaiver'),false,name);
  }
});

test('partial human votes do not complete or rewrite artifacts, and a checked threshold records exact human ownership',()=>{
  for(const reached of [false,true]) {
    const record=phase();record.status='awaiting_approval';const artifacts=record.artifacts;
    const decision={decision:'approved',at,actor:{login:'reviewer'},generation:3,reviewPacketSha256:'e'.repeat(64),selfApproval:false};
    recordPhaseApprovalState(record,decision,{key:'reviewer',reached});
    assert.equal(record.approvals.at(-1),decision);assert.equal(record.artifacts,artifacts);
    assert.equal(record.status,reached?'approved':'awaiting_approval');assert.equal(record.approvedAt,reached?at:null);
    assert.equal(record.approvedBy,reached?'reviewer':null);assert.equal(Object.hasOwn(record,'approvalDisposition'),false);
    assert.equal(Object.hasOwn(record,'approvalWaiver'),false);assert.equal(record.history.length,1);
  }
});

test('decision input normalization precedes recording and retries retain the exact accepted input record',()=>{
  const record=phase(),workflow={resolution:{decisions:[{id:'channel',label:'Channel',after:record.id,mode:'auto',
    inputs:[{name:'channel',type:'enum',values:['Web','Mobile']},{name:'count',type:'number',minimum:0,maximum:5}]}]}};
  const before=structuredClone(record);
  for(const values of [{},{channel:'unknown',count:1},{channel:'web',count:9},{channel:'web',count:1,unknown:'x'}]) {
    assert.throws(()=>submittedDecisionInputPlan(workflow,record,values));assert.deepEqual(record,before);
  }
  const plan=submittedDecisionInputPlan(workflow,record,{channel:'web',count:'2'});
  const saved=applySubmittedDecisionInput(record,plan,{at,actorId:'actor'});
  assert.deepEqual(saved,{schemaVersion:1,decision:'channel',values:{channel:'Web',count:2},recordedAt:at,recordedBy:'actor'});
  const retained=submittedDecisionInputPlan(workflow,record,{});assert.equal(retained.kind,'retained');assert.equal(retained.record,saved);
  assert.deepEqual(submissionDecisionIntent(workflow,record,{}),{ignoredDecisionValues:false});
  record.status='awaiting_approval';assert.deepEqual(submissionDecisionIntent(workflow,record,{unknown:'ignored'}),{ignoredDecisionValues:true});
});

test('new lifecycle state helpers import and execute without infrastructure or executable discovery',()=>{
  const moduleUrl=new URL('../src/kernel/lifecycle-transitions.mjs',import.meta.url).href;
  const script=`
    import {registerHooks} from 'node:module';
    const blocked=[];const hook=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('node:')){blocked.push(specifier);throw new Error(specifier);}return next(specifier,context);}});
    const core=await import(${JSON.stringify(moduleUrl)});
    const p={id:'team-phase',generation:0,status:'in_progress',approvalPolicy:{mode:'none'},approvals:[],artifacts:[]};
    const workflow={status:'in_progress',currentPhase:p.id,phaseOrder:[p.id],phases:{[p.id]:p}};
    core.beginPhaseSubmission(p,'explicit-time');
    if(!core.applyPhaseSubmissionDisposition(p,{reviewableFailure:false,applicationReviewPending:false,waiver:null}))throw new Error('not completed');
    core.advanceCompletedPhase(workflow,p,'explicit-time');
    if(workflow.status!=='closed'||workflow.currentPhase!==null)throw new Error('not advanced');
    if(blocked.length)throw new Error('infrastructure imported');hook.deregister();
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PATH:''},encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
});
