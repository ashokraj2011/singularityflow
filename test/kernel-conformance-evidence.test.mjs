import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateConformanceEvidence,conformanceTableRows} from '../src/kernel/conformance-report.mjs';
const ids=['APP:REQ-001','APP:AC-001'],workflow={phaseOrder:[],phases:{}},report=(verdict='matched')=>
  '# Conformance\n\n| Clause ID | Verdict |\n| --- | --- |\n| APP:REQ-001 | '+verdict+' |\n| APP:AC-001 | '+verdict+' |\n',
  observations=ids.map(clauseId=>({clauseId,phase:'code',generation:1,repositoryId:'app',verdict:'matched',witnesses:[{id:'actual-test',status:'met'}]}));
test('matched conformance needs observed delivery and actual acceptance witnesses',()=>{
  assert.deepEqual(evaluateConformanceEvidence(report(),{workflow,clauseIds:ids,observations}).findings,[]);
  assert.equal(evaluateConformanceEvidence(report(),{workflow,clauseIds:ids}).findings.filter(row=>row.code==='conformance.evidence-not-matched').length,2);
  const withoutRun=structuredClone(observations);withoutRun[1].witnesses=[];
  assert.deepEqual(evaluateConformanceEvidence(report(),{workflow,clauseIds:ids,observations:withoutRun}).findings.map(row=>row.clauseId),['APP:AC-001']);
  const withoutIdentity=structuredClone(observations);withoutIdentity[1].witnesses[0].id=null;
  assert.ok(evaluateConformanceEvidence(report(),{workflow,clauseIds:ids,observations:withoutIdentity}).findings.some(row=>row.code==='conformance.evidence-not-matched'));
});
test('honest partial rows are retained as owned gaps and never rewritten as matched',()=>{
  const value=evaluateConformanceEvidence(report('partial'),{workflow,clauseIds:ids,observations});
  assert.deepEqual(value.findings,[]);assert.equal(value.gaps.length,2);assert.deepEqual(value.gaps[0].owners,['code']);
  assert.ok(value.rows.every(row=>row.verdict==='partial'));assert.ok(conformanceTableRows(report('partial')).every(row=>row.verdict==='partial'));
});
test('contradictory verdict prose, missing rows and duplicate rows require report correction',()=>{
  const text=report()+'\n## Upstream discrepancies\n\nAPP:REQ-001 remains partial.\n';
  assert.ok(evaluateConformanceEvidence(text,{workflow,clauseIds:ids,observations}).findings.some(row=>row.code==='conformance.verdict-contradicted'));
  assert.ok(evaluateConformanceEvidence(report().replace('| APP:AC-001 | matched |',''),{workflow,clauseIds:ids,observations}).findings.some(row=>row.code==='conformance.clause-row-missing'));
  assert.ok(evaluateConformanceEvidence(report()+'| APP:AC-001 | matched |\n',{workflow,clauseIds:ids,observations}).findings.some(row=>row.code==='conformance.clause-row-duplicate'));
});


test('plain legacy review documents do not acquire the new Code-backed conformance owner',async()=>{
  const {primaryDocumentPublicationRequirements}=await import('../src/kernel/publication-intent.mjs'),phase={id:'review',requiredArtifact:{kind:'conformance-report'},writeScope:'artifact-only',inputs:[]},
    workflow={phases:{review:phase},phaseOrder:['review'],resolution:{spec:{mode:'off'},plannedClaims:{mode:'disabled'}}};
  assert.equal(primaryDocumentPublicationRequirements(workflow,phase).includes('conformance-report'),false);
});
