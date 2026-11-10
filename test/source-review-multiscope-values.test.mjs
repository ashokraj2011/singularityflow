/** A new multi-scope envelope reuses native rule evaluation without changing the v1 oracle. */
import test from 'node:test';import assert from 'node:assert/strict';
import {sourceGroundedReviewPolicies,MULTI_SCOPE_REVIEW_PROFILE} from '../src/kernel/source-grounded-review.mjs';
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX,recordSha256} from '../src/records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {sourceReviewValueInput} from './helpers/source-review-values-fixture.mjs';
const rules=sourceGroundedReviewPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS);
function input(){const {context,report}=sourceReviewValueInput(rules,{kind:'planning',test:'ready'}),second={phase:'technical-scope',generation:2,path:'technical.md',
    text:'# Technical requirement\nKeep stored drafts readable. [VALUE:REQ-002]\n',originalSha256:'b'.repeat(64)};
  context.upstreamSpecifications=[{...context.upstreamSpec,phase:'business-scope',generation:1,originalSha256:'a'.repeat(64)},second];delete context.upstreamSpec;
  context.clarifications=[{id:'clarification:current-phase',phase:'planning',generation:1,path:'plan-answers.json',sha256:'c'.repeat(64)},
    ...context.upstreamSpecifications.map(row=>({id:'clarification:approved-scope:'+row.phase,phase:row.phase,generation:row.generation,path:row.phase+'-answers.json',sha256:row.originalSha256}))];
  context.artifact.text+='| `VALUE:REQ-002` | `src/draft.mjs` | `test/draft.test.mjs` |\n';
  report.profile=MULTI_SCOPE_REVIEW_PROFILE;report.binding=rules.multiSourceReviewBinding(context);report.clarificationsReviewed=context.clarifications.map(row=>row.id);
  report.rows.push({...report.rows[0],clauseId:'VALUE:REQ-002'});return {context,report};}
function evaluate(report,context){const iterator=rules.evaluateMultiSourceGroundedReviewReplay(report,context);let step=iterator.next();while(!step.done)step=iterator.next('2026-11-11T12:00:00.000Z');return step.value;}
test('all actual approved scopes and three clarification generations are bound separately',()=>{
  const {context,report}=input(),result=evaluate(report,context);assert.equal(result.status,'ready',JSON.stringify(result));
  assert.deepEqual(result.binding.upstreamSpecifications.map(row=>[row.phase,row.generation,row.path,row.originalSha256]),[
    ['business-scope',1,'spec.md','a'.repeat(64)],['technical-scope',2,'technical.md','b'.repeat(64)]]);
  assert.equal(result.binding.clarifications.length,3);assert.equal(Object.hasOwn(result.binding,'upstreamSpec'),false);
  assert.equal(result.reportSha256,recordSha256(report));context.upstreamSpecifications[1].text+='The contract changed.\n';
  assert.equal(evaluate(report,context).status,'stale');
});
test('neither an unknown clause nor an omitted source/answer can disappear through source partitioning',()=>{
  for(const change of [r=>r.rows.push({...r.rows[0],clauseId:'VALUE:REQ-999'}),r=>r.rows.pop(),r=>r.clarificationsReviewed.pop(),r=>r.sourcesReviewed=[],r=>delete r.profile]){
    const {context,report}=input();change(report);assert.equal(evaluate(report,context).status,'correction-required');}
});
test('one exact human disposition uses the envelope hash, without accepting a different report or semantic blocker',()=>{
  const {context,report}=input();context.artifact.text=context.artifact.text.replace('| `VALUE:REQ-002` | `src/draft.mjs` | `test/draft.test.mjs` |','| `VALUE:REQ-002` | `src/draft.mjs` | not-applicable: Reviewed by the owner. |');
  const row=report.rows.find(row=>row.clauseId==='VALUE:REQ-002');Object.assign(row,{plannedTests:[],testDisposition:'not-applicable',testReason:'Reviewed by the owner.'});
  report.binding=rules.multiSourceReviewBinding(context);const pending=evaluate(report,context);
  assert.equal(pending.pendingDispositions.length,1,JSON.stringify(pending));
  const decision={id:pending.pendingDispositions[0].id,reportSha256:pending.reportSha256,decision:'accepted',reason:'A human reviewed this exact exemption.',actor:'reviewer'};
  context.humanDispositions=[{...decision,reportSha256:'0'.repeat(64)}];assert.equal(evaluate(report,context).pendingDispositions.length,1);
  context.humanDispositions=[decision];assert.equal(evaluate(report,context).pendingDispositions.length,0);
  report.findings=[{id:'real-gap',severity:'blocking',message:'The required behavior is missing.',sourceId:'story',line:2,quote:'Save a draft'}];
  assert.ok(evaluate(report,context).findings.some(row=>row.code==='reviewer-blocker'));
});
test('malformed source inventories and conflicting approved clause identities keep explicit errors',()=>{
  const {context,report}=input();context.upstreamSpecifications[1].phase='business-scope';assert.throws(()=>evaluate(report,context),{code:'SOURCE_REVIEW_MULTI_SCOPE_INVALID'});
  const other=input();other.context.upstreamSpecifications[1].text='Change the meaning. [VALUE:REQ-001]\n';
  assert.throws(()=>evaluate(other.report,other.context),{code:'SPEC_CLAUSE_REDEFINED'});
  const malformed=input();malformed.context.upstreamSpecifications[0]=null;assert.throws(()=>evaluate(malformed.report,malformed.context),{code:'SOURCE_REVIEW_MULTI_SCOPE_INVALID'});
});
test('the multi-scope contract uses and binds the actual namespace and plan policy',()=>{
  const {context,report}=input();context.specificationPolicy={mode:'enforce',namespace:'VALUE',coverage:'enforce',acceptance:'presence'};
  context.evidenceRoot='singularity/work-items/VALUE/evidence';
  report.binding=rules.multiSourceReviewBinding(context);
  const result=evaluate(report,context);assert.equal(result.status,'ready',JSON.stringify(result));assert.match(report.binding.planPolicySha256,/^[a-f0-9]{64}$/u);
  context.specificationPolicy.coverage='record';assert.equal(evaluate(report,context).status,'stale');
});
