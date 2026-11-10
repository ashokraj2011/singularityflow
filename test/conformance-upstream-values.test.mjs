import test from 'node:test';import assert from 'node:assert/strict';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {conformanceVerdictPolicies,evaluateConformanceEvidence} from '../src/kernel/conformance-report.mjs';
const policy=conformanceVerdictPolicies(NODE_TEXT_DIGESTS),markdown='| Clause ID | Verdict |\n| --- | --- |\n| W:REQ-001 | partial (UPI-001) |\n',
  workflow={workItem:{id:'W'},phaseOrder:['build','verify','release'],phases:{build:{approvals:[]},verify:{approvals:[]},release:{approvals:[]}},
    upstreamIssues:[{id:'UPI-001',phase:'verify',about:'W:REQ-001',problem:'The retained verification record has an explicit evidence gap.',impact:null,source:null}]},
  options={workflow,phaseId:'release',clauseIds:['W:REQ-001'],observations:[{clauseId:'W:REQ-001',phase:'build',verdict:'partial'}]};
test('a linked partial names the actual issue owner rather than its detecting phase or an unrelated Code owner',()=>{
  const result=policy.linkedConformanceEvidence(markdown,options);assert.deepEqual(result.findings,[]);
  assert.deepEqual(result.gaps,[{clauseId:'W:REQ-001',verdict:'partial',owners:['verify'],issueRefs:['UPI-001']}]);
  assert.deepEqual(evaluateConformanceEvidence(markdown,options).gaps,[{clauseId:'W:REQ-001',verdict:'partial',owners:['build']}]);
});
test('a conformance annotation cannot reuse an issue or human decision about another clause',()=>{
  const unrelated=structuredClone(workflow);unrelated.upstreamIssues[0].about='W:REQ-002';
  assert.ok(policy.linkedConformanceEvidence(markdown,{...options,workflow:unrelated}).findings.some(row=>row.code==='conformance.upstream-clause-unbound'));
  assert.ok(policy.linkedConformanceEvidence(markdown.replace('UPI-001','UPI-999'),options).findings.some(row=>row.code==='conformance.upstream-issue-unknown'));
  const current=structuredClone(workflow);current.upstreamIssues[0].phase='release';
  assert.ok(policy.linkedConformanceEvidence(markdown,{...options,workflow:current}).findings.some(row=>row.code==='conformance.upstream-owner-invalid'));
});
