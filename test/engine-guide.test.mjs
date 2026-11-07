import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createEngine} from '../src/engine-sdk/index.mjs';
import {phaseGovernancePlan,sourceReviewContinuationPlan,phaseHandoffPlan,workflowGuidePlan,phaseAuthoringPlan,
  phaseExplicitlyReopened,pendingIntentAmendmentAcknowledgement} from '../src/kernel/phase-policy.mjs';
import {phaseExplicitlyReopened as compatibilityReopen} from '../src/sequence.mjs';
import {pendingIntentAmendmentAcknowledgement as compatibilityAmendment} from '../src/source-review-policy.mjs';
import {workflowGuide,phaseHandoff} from '../src/guide.mjs';
import {phaseGovernanceHold} from '../src/phase-governance-routing.mjs';
import {convergenceTransitionRoute} from '../src/phase-transition-routes.mjs';
import {sourceReviewContinuation} from '../src/source-review-continuation.mjs';
import {phaseAuthoringProgress} from '../src/phase-authoring-progress.mjs';
import {continuationCases} from './helpers/continuation-cases.mjs';

test('31 native guide, review, hold, authoring and Convergence outputs retain their exact pre-extraction bytes',async()=>{
  const baseline=JSON.parse(await readFile(new URL('./fixtures/engine-continuation/native-v1.json',import.meta.url),'utf8'));
  assert.equal(baseline.baseline,'4425a3be8');
  for(const f of continuationCases()) {
    const before=JSON.stringify(f.workflow),progress=phaseAuthoringProgress(f.workflow,f.phase,{draftEvidence:f.draftEvidence});
    const output={guide:workflowGuide(f.workflow,{sourceReviewEvidence:f.review,...f.explicitProgress?{authoringProgress:progress}:{}}),
      handoff:phaseHandoff(f.workflow,f.phase,{sourceReviewEvidence:f.review}),hold:phaseGovernanceHold(f.workflow,f.phase),
      convergence:convergenceTransitionRoute(f.workflow,f.phase),review:sourceReviewContinuation(f.workflow,f.phase,f.review),progress};
    assert.equal(createHash('sha256').update(JSON.stringify(output)).digest('hex'),baseline.cases[f.name].sha256,f.name);
    assert.equal(output.guide.nextActions[0]?.command??null,baseline.cases[f.name].firstCommand,f.name);
    assert.equal(output.review.classification,baseline.cases[f.name].reviewClassification,f.name);
    assert.equal(JSON.stringify(f.workflow),before,'routing cannot mutate '+f.name);
  }
  const sample=continuationCases()[0],readOnly=createEngine({ports:{storyGuide:{async load(){
    return {subject:{kind:'story',id:'CONT-1'},workflow:sample.workflow};
  }}}});
  const proposed=await readOnly.run('story.guide');
  await assert.rejects(readOnly.run(proposed.manifest.actions[0].operation.id,proposed.manifest.actions[0].operation.inputs),
    {code:'ENGINE_PORT_UNAVAILABLE'},'a guide does not install or authorize a lifecycle writer');
});

test('the registered guide returns semantic actions with explicit prerequisites and zero host or model wording',async()=>{
  const expected={
    'document-unpublished':'prepare-phase','document-published-review-pin':'check-source-review-status',
    'document-published-no-review':'submit-phase','review-ready':'check-source-review-status',
    'submitted-review-correction':'approve-phase','author-is-reviewer':'select-phase-author',
    'amendment-acknowledgement-first':'acknowledge-intent-amendment','pending-routing-decision':'inspect-workflow-decision',
    'closed':'inspect-workflow-progress','cancelled-with-decision':'view-archived-documents',
    'code-generation-not-open':'prepare-phase','code-generation-open':'resume-phase-authoring',
    'code-consumed-unpublished':'resume-phase-authoring','convergence-unpublished':'prepare-phase',
    'convergence-no-record':'recover-publication-record','convergence-retained':'advance-convergence'
  };
  for(const f of continuationCases()) {
    f.workflow.prompt='PRIVATE MODEL WORDING';f.workflow.documents={content:'PRIVATE UPLOADED DOCUMENT'};
    const calls=[],engine=createEngine({ports:{storyGuide:{async load(input){calls.push(input);
      return {subject:{kind:'story',id:'CONT-1'},workflow:f.workflow};}}}});
    const result=await engine.run('story.guide',{workId:'CONT-1'});
    assert.equal(result.manifest.contract,'sflow-workflow-continuation/v1');
    assert.equal(result.manifest.actions[0].workId,'CONT-1');assert.equal(calls.length,1);
    if(expected[f.name])assert.equal(result.manifest.actions[0].kind,expected[f.name],f.name);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|singularity-flow|\/sf-|\/sflow-|"(?:command|argv|skill|reason|instruction|prompt)":/u);
    assert.equal(result.manifest.authorityGranted,false);assert.equal(result.manifest.finalBindingChecked,false);
    assert.equal(result.manifest.automaticAdvance,false);assert.equal(result.effects.approvalRecorded,false);
    assert.equal(result.effects.modelInvocations,0);assert.equal(Object.isFrozen(result.manifest.actions),true);
    for(const action of result.manifest.actions)if(action.operation) {
      assert.ok(engine.operations.some(entry=>entry.id===action.operation.id));
      assert.equal(action.operation.inputs.workId,'CONT-1');
    }
  }
});

test('human and publication prerequisites keep their order across custom phases',()=>{
  const cases=new Map(continuationCases().map(f=>[f.name,f]));
  const ack=cases.get('amendment-acknowledgement-first');
  assert.equal(phaseGovernancePlan(ack.workflow,ack.phase).actions[0].kind,'acknowledge-intent-amendment');
  assert.deepEqual(phaseGovernancePlan(ack.workflow,ack.phase).actions[0].requires,['explicit-human-choice']);
  const pending=cases.get('pending-routing-decision');pending.phase.status='awaiting_approval';
  assert.equal(workflowGuidePlan(pending.workflow).actions[0].kind,'inspect-workflow-decision');
  const ready=cases.get('document-unpublished');
  assert.equal(sourceReviewContinuationPlan(ready.workflow,ready.phase,{status:'ready'}).actions[0].kind,'prepare-phase');
  const held=cases.get('review-human-disposition');
  assert.equal(sourceReviewContinuationPlan(held.workflow,held.phase,held.review).actions[0].kind,'decide-source-review-finding');
  const convergence=cases.get('convergence-retained');
  assert.deepEqual(phaseHandoffPlan(convergence.workflow,convergence.phase).actions[0].requires,['reviewed-result-digest','explicit-human-choice']);
  const code=cases.get('code-consumed-unpublished');
  assert.equal(phaseAuthoringPlan(code.workflow,code.phase).stage,'review-successor');
  assert.equal(phaseExplicitlyReopened,compatibilityReopen);assert.equal(pendingIntentAmendmentAcknowledgement,compatibilityAmendment);
});

test('unknown host inputs, cancellation and mismatched bindings cannot enter or redirect a guide query',async()=>{
  const f=continuationCases()[0],calls=[];
  const port={async load(input){calls.push(input);return {subject:{kind:'story',id:'CONT-1'},workflow:f.workflow};}};
  const engine=createEngine({ports:{storyGuide:port}}),controller=new AbortController();controller.abort();
  for(const input of [null,[],{root:'/other'},{workId:1},{workId:''},{workId:'a'.repeat(513)},
    {sourceReviewEvidence:{status:'ready'}},{authoringState:{available:true}},{fetch:true}]) {
    await assert.rejects(engine.run('story.guide',input),{code:'ENGINE_INPUT_INVALID'});
  }
  await assert.rejects(engine.run('story.guide',{}, {signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  assert.deepEqual(calls,[]);
  await assert.rejects(engine.run('story.guide',{workId:'OTHER'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  const malformed=createEngine({ports:{storyGuide:{async load(){return {subject:{kind:'story',id:'CONT-1'},workflow:{workItem:{id:'CONT-1'}}};}}}});
  await assert.rejects(malformed.run('story.guide'),{code:'ENGINE_PORT_RESULT_INVALID'});
  const original=new Error('actual native failure',{cause:new Error('original cause')});original.code='GUIDE_RECORD_UNAVAILABLE';
  const failed=createEngine({ports:{storyGuide:{async load(){throw original;}}}});
  await assert.rejects(failed.run('story.guide'),error=>error===original);
  const lateController=new AbortController(),late=createEngine({ports:{storyGuide:{async load(){lateController.abort();return {};}}}});
  await assert.rejects(late.run('story.guide',{}, {signal:lateController.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
});

test('guide presentation refuses an unknown semantic action instead of executing text from a record',async()=>{
  const {continuationActionPresentation}=await import('../src/phase-transition-routes.mjs');
  assert.throws(()=>continuationActionPresentation({kind:'shell',command:'untrusted'}),{code:'ENGINE_CONTINUATION_UNSUPPORTED'});
});
