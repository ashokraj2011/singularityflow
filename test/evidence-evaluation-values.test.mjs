import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {evaluateEvidence as native} from '../src/evidence/evaluate.mjs';
import {evidenceEvaluationPolicies,EVIDENCE_EVALUATION_PROFILE,reviewFacetValue} from '../src/kernel/evidence-evaluation.mjs';
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX} from '../src/records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {countedApprovals,countedRecords} from '../src/presence/counted.mjs';
import {applicabilityStatus,endpointTaken} from '../src/evidence/applicability.mjs';
const captured=JSON.parse(await readFile(new URL('./fixtures/native-evidence-evaluation-v1.json',import.meta.url),'utf8')),
  rules=evidenceEvaluationPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS);
for(const fixture of captured.cases)test('native evidence value compatibility: '+fixture.name,()=>{
  const before=structuredClone(fixture.graph);assert.deepEqual(native(fixture.graph,fixture.options),fixture.result);
  assert.equal(rules.evidenceGraph(fixture.graph).inputSha256,fixture.graphSha256);
  assert.deepEqual(fixture.graph,before,'Evaluation does not change any observed evidence.');
});
test('shared evidence rules require time, retain the observation and emit structured actions',()=>{
  for(const fixture of captured.cases){
    const workflow=fixture.graph.workflow,admission={reviewApprovals:Object.fromEntries(Object.entries(workflow.phases).map(([id,phase])=>
      [id,countedApprovals(workflow,(phase.approvals??[]).filter(row=>row.decision==='approved'&&!row.invalidatedAt))])),
      riskDecisions:countedRecords(workflow,workflow.riskDecisions),applicability:applicabilityStatus(workflow,endpointTaken(workflow))},
      result=rules.evaluateEvidence(fixture.graph,{...fixture.options,admission});
    assert.equal(result.profile,EVIDENCE_EVALUATION_PROFILE);assert.deepEqual(result.decision,fixture.result.decision);
    assert.deepEqual(result.completion,fixture.result.completion);assert.deepEqual(result.rows.map(row=>row.obligations),fixture.result.rows.map(row=>row.obligations));
    assert.ok(result.rows.flatMap(row=>row.actions).every(action=>!Object.hasOwn(action,'command')));
  }
  const scope=rules.evaluateEvidence(captured.cases[6].graph,captured.cases[6].options).rows.find(row=>row.type==='SCOPE');
  assert.deepEqual(scope.actions.map(row=>row.operation),['decision.scope','decision.scope']);
  assert.ok(scope.actions[0].requiredInputs.includes('clauseIds'));
  const correction=rules.evaluateEvidence(captured.cases[10].graph,captured.cases[10].options).rows.flatMap(row=>row.findings).find(row=>row.correction);
  assert.equal(correction.correction.ownerPhase,'intake');assert.equal(correction.correction.kind,'plan-test-only');
  assert.throws(()=>rules.evaluateEvidence(captured.cases[0].graph),{code:'ENGINE_INPUT_INVALID'});
});
test('review facets use the supplied admitted approval inventory without claiming identity authentication',()=>{
  const phase=captured.cases[0].graph.workflow.phases.implementation;
  assert.equal(reviewFacetValue(phase,null,[]),'pending');
  assert.equal(reviewFacetValue(phase,null,phase.approvals),'approved');
});
test('explicit execution permissions have a separate evidence profile, input digest and original-owner recovery',()=>{
  const fixture=captured.cases[0],observation={profile:'sflow-namespace-execution-permission/v1',kind:'test-cohort',phaseId:'implementation',generation:1,
    disposition:'uncovered',policy:{kind:'test-cohort/v1'},references:[],actions:[{operation:'test-cohort.context',inputs:{phaseId:'implementation'},requiredInputs:['baselineOperationId','observedOperationId']}]},
    graph=rules.evidenceGraph({...fixture.graph,executionPolicies:[observation]}),result=rules.evaluateEvidence(graph,fixture.options),
    row=result.rows.find(row=>row.type==='EXECUTION-POLICY');
  assert.notEqual(graph.inputSha256,fixture.graphSha256);assert.equal(result.profile,'sflow-evidence-evaluation/v4');assert.equal(result.decision.gate,'block');
  assert.equal(row.result,'pending');assert.deepEqual(row.actions,observation.actions);assert.equal(row.obligations[0].subject,'story');
  assert.ok(row.actions.every(action=>action.operation!=='decision.risk'),'an original cohort gap does not create a competing generic decision');
  const active=rules.evaluateEvidence(rules.evidenceGraph({...fixture.graph,executionPolicies:[{...observation,disposition:'active'}]}),fixture.options);
  assert.equal(active.rows.find(row=>row.type==='EXECUTION-POLICY').result,'satisfied-with-exception');
  assert.deepEqual(native(fixture.graph,fixture.options),fixture.result,'ordinary native evidence bytes retain their original meaning');
});
