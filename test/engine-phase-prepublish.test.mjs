import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';
import * as findingPolicy from '../src/kernel/phase-findings.mjs';
import * as oldFindingPolicy from '../src/phase-finding-policy.mjs';
import * as generation from '../src/kernel/phase-policy.mjs';
import * as oldInspection from '../src/phase-inspection-generation.mjs';
import {phaseNeedsGeneration as oldNeed} from '../src/phase-generation-need.mjs';
import {sourceReviewRequired,sourceReviewAuthorConflict} from '../src/source-review-policy.mjs';

const finding=(patch={})=>({code:'artifact.template.unchanged',sourceCode:null,category:'authoring',message:'Original diagnostic.',
  phaseId:null,path:'artifact.md',line:12,clauseId:null,upstreamDecisionComplete:false,coverageReviewRequired:false,riskEligible:false,...patch});
function fixture(hook=()=>{}) {
  const workflow={workItem:{id:'CHECK-1'},currentPhase:'custom-phase',phases:{'custom-phase':{id:'custom-phase',status:'in_progress',generation:0}}};
  const facts={workId:'CHECK-1',phase:'custom-phase',generation:1,phaseStatus:'in_progress',inspectionStage:'authoring',
    readiness:{lifecycle:true,authoring:true,knownRecoveryBlockers:true,requiredTests:'not-run',publicationTransaction:'not-run'},
    producer:'governed-agent',qualityDisposition:'checked',draftFingerprint:'exact-fingerprint',findings:[],advisories:[],warningCount:0,
    correction:{class:'agent-authoring',sameTurn:false,requiresNewGeneration:false},task:null};
  const calls=[],port={};
  for(const stage of ['load','inspect'])port[stage]=async(...args)=>{calls.push(stage);await hook(stage,{workflow,facts,args});return stage==='load'?{workflow}:facts;};
  return {workflow,facts,calls,engine:createEngine({ports:{phasePrepublish:port}})};
}

test('registered prepublish reports admission for an attempt without asserting fresh tests, approval or final binding',async()=>{
  assert.equal(ENGINE_OPERATIONS.find(operation=>operation.id==='phase.prepublish').effect,'inspection');
  const f=fixture(),result=await f.engine.prepublishPhase({workId:'CHECK-1',phaseId:'custom-phase'});
  assert.deepEqual(f.calls,['load','inspect']);assert.equal(result.status,'ready');
  assert.equal(result.manifest.contract,'sflow-phase-prepublish-manifest/v1');assert.equal(result.manifest.admittedForAttempt,true);
  for(const key of ['finalBindingChecked','testsRun','mutationAuthorityGranted','approvalRecorded','humanReviewRecorded'])assert.equal(result.manifest[key],false);
  for(const key of ['draftChanged','testsRun','committed','pushed','approvalRecorded','storyAdvanced','finalBindingChecked'])assert.equal(result.effects[key],false);
  assert.equal(result.effects.localProgressMayBeWritten,true);assert.equal(result.effects.modelInvocations,0);
  assert.equal('commands' in result,false);assert.equal(Object.isFrozen(result.manifest.readiness),true);
});

test('readiness requires every native prerequisite and an advisory never becomes a blocking finding',async()=>{
  for(const key of ['authoring','knownRecoveryBlockers']) {
    const f=fixture((stage,{facts})=>{if(stage==='inspect')facts.readiness[key]=false;});
    assert.equal((await f.engine.run('phase.prepublish')).status,'correction-required');
  }
  const advisory=fixture((stage,{facts})=>{if(stage==='inspect'){
    facts.advisories=[{code:'documentation.advisory',category:'documentation',message:'Original advice',
      requiredBefore:null,ownerPhase:null,clauseId:null,issueRefs:[],status:null}];facts.warningCount=2;
  }});
  const result=await advisory.engine.run('phase.prepublish');assert.equal(result.status,'ready');assert.equal(result.manifest.warningCount,2);
  assert.equal(result.manifest.advisories.length,1);assert.deepEqual(result.manifest.findings,[]);
});

test('kernel finding rules retain integrity precedence, upstream ownership and human scope review',async()=>{
  const f=fixture((stage,{facts})=>{if(stage==='inspect'){
    facts.readiness.authoring=false;
    facts.findings=[finding(),finding({code:'GENERATION_BINDING_REQUIRED',sourceCode:'artifact.required.too-short'}),
      finding({code:'conformance.verdict-incomplete',phaseId:'upstream-code'}),
      finding({code:'SPEC_COVERAGE_INCOMPLETE',riskEligible:true,coverageReviewRequired:true}),
      finding({code:'SPEC_COVERAGE_INCOMPLETE',upstreamDecisionComplete:true})];
  }});
  const result=await f.engine.run('phase.prepublish');assert.equal(result.status,'correction-required');
  const rows=result.manifest.findings;
  assert.equal(rows[0].policy.repairableByProducer,true);assert.equal(rows[1].canonicalCode,'GENERATION_BINDING_REQUIRED');
  assert.equal(rows[1].policy.classification,'integrity-or-authority');
  assert.equal(rows[2].policy.classification,'upstream-defect');assert.equal(rows[2].affectedPhase,'upstream-code');
  assert.equal(rows[3].policy.repair,'scope-or-evidence-review');assert.equal(rows[3].policy.riskEligible,false);
  assert.equal(rows[4].policy.classification,'upstream-decision');
  for(const row of rows)assert.equal(row.policy.automaticRiskAcceptance,false);
});

test('host/provider/actor flags are rejected before I/O and differently bound or command-bearing facts are refused',async()=>{
  const f=fixture();
  for(const inputs of [{root:'/other'},{actor:'reviewer'},{modelEnabled:false},{forAgent:true},{provider:'model'},{workflow:{}},
    {get workId(){throw Error('do not invoke');}}])await assert.rejects(f.engine.run('phase.prepublish',inputs),{code:'ENGINE_INPUT_INVALID'});
  assert.deepEqual(f.calls,[]);
  for(const change of [facts=>{facts.workId='OTHER';},facts=>{facts.phase='other';},facts=>{facts.generation=2;},
    facts=>{facts.readiness.lifecycle=false;},facts=>{facts.commands={publish:'shell'};},facts=>{facts.findings=[finding()];},
    facts=>{facts.advisories[0]={code:'advice',category:null,message:'x',command:'shell'};}]) {
    const bad=fixture((stage,{facts})=>{if(stage==='inspect')change(facts);});
    await assert.rejects(bad.engine.run('phase.prepublish'),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
});

test('generation selection preserves retained evidence, monotonic successors and inactive-phase refusals',async()=>{
  const f=fixture((stage,{workflow,facts})=>{if(stage==='load'){
    const phase=workflow.phases['custom-phase'];phase.generation=3;phase.generationIntent={status:'consumed',generation:3};
    facts.generation=3;facts.inspectionStage='published';facts.readiness.publicationTransaction='already-published';
  }});
  assert.equal((await f.engine.run('phase.prepublish')).generation,3);
  f.workflow.phases.old={id:'old',status:'approved',generation:1};
  await assert.rejects(f.engine.run('phase.prepublish',{phaseId:'old'}),{code:'PHASE_DRAFT_NOT_ACTIVE'});
  for(const phaseId of ['missing','constructor','__proto__'])await assert.rejects(f.engine.run('phase.prepublish',{phaseId}));
  const wrong=fixture();await assert.rejects(wrong.engine.run('phase.prepublish',{workId:'OTHER'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  assert.deepEqual(wrong.calls,['load']);
});

test('interrupted tasks and exhausted budgets remain visible without granting edit authority or resetting them',async()=>{
  const f=fixture((stage,{facts})=>{if(stage==='inspect')facts.task={operationId:'task-1',state:'inspect-interrupted-operation',
    continuationBudget:{consumed:3,maximum:2}};});
  const result=await f.engine.run('phase.prepublish');
  assert.deepEqual(result.manifest.task.continuationBudget,{consumed:3,maximum:2});assert.equal(result.manifest.mutationAuthorityGranted,false);
});

test('native errors, causes and cancellation keep exact identity and local-progress diagnostics without retry',async()=>{
  for(const at of ['load','inspect']) {
    const error=new SingularityFlowError('Native filesystem error',{code:'EACCES',cause:new Error('volume'),details:{recovery:'exact owner route'}});
    const f=fixture(stage=>{if(stage===at)throw error;});
    await assert.rejects(f.engine.run('phase.prepublish'),actual=>actual===error&&actual.cause.message==='volume');
    assert.equal(error.enginePhasePrepublish.pendingStage,at);assert.equal(f.calls.filter(stage=>stage===at).length,1);
  }
  const controller=new AbortController(),cancelled=fixture(stage=>{if(stage==='inspect')controller.abort();});
  await assert.rejects(cancelled.engine.run('phase.prepublish',{}, {signal:controller.signal}),error=>
    error.code==='ENGINE_OPERATION_CANCELLED'&&error.enginePhasePrepublish.localProgressMayBeWritten===true);
  const original=Object.defineProperty(new Error('Original error'),'enginePhasePrepublish',{value:null,writable:false});
  const readonly=fixture(stage=>{if(stage==='inspect')throw original;});await assert.rejects(readonly.engine.run('phase.prepublish'),error=>error===original);
});

test('legacy exports retain function identity while generation and finding policy have pure kernel owners',()=>{
  for(const name of ['phaseFindingCode','phaseFindingIdentity','phaseFindingPolicy','isArtifactQualityFinding'])assert.equal(oldFindingPolicy[name],findingPolicy[name]);
  for(const name of ['hasPublishedPhaseGeneration','requiresProspectivePhaseInspection','phaseInspectionGeneration'])assert.equal(oldInspection[name],generation[name]);
  assert.equal(oldNeed,generation.phaseNeedsGeneration);assert.equal(sourceReviewRequired,generation.sourceReviewRequired);
  assert.equal(sourceReviewAuthorConflict,generation.sourceReviewAuthorConflict);
});

test('binding selection does not enumerate retained artifacts or submission history before the native check',async()=>{
  const f=fixture((stage,{workflow})=>{if(stage==='load'){
    Object.defineProperty(workflow,'lineage',{get(){throw Error('Unrelated submission history');}});
    Object.defineProperty(workflow.phases['custom-phase'],'artifacts',{get(){throw Error('Unrelated retained-document inventory');}});
  }});
  assert.equal((await f.engine.run('phase.prepublish')).status,'ready');
  assert.deepEqual(f.calls,['load','inspect']);
});

test('an advisory retains its linked upstream owner and approval deadline without becoming a publication blocker',async()=>{
  const f=fixture((stage,{facts})=>{if(stage==='inspect')facts.advisories=[{
    code:'conformance.verdict-incomplete',category:'traceability',message:'Keep the honest partial verdict.',
    requiredBefore:'approve',ownerPhase:'upstream-verification',clauseId:'CHECK-1:AC-001',issueRefs:['UPI-001','UPI-002'],status:'open'}];});
  const result=await f.engine.run('phase.prepublish');
  assert.equal(result.status,'ready');assert.deepEqual(result.manifest.findings,[]);
  assert.deepEqual(result.manifest.advisories[0].issueRefs,['UPI-001','UPI-002']);
  assert.equal(result.manifest.advisories[0].requiredBefore,'approve');assert.equal(result.manifest.advisories[0].ownerPhase,'upstream-verification');
  assert.equal(result.manifest.approvalRecorded,false);
});
