import test from 'node:test';import assert from 'node:assert/strict';
import {repositoryCoverageProjection} from '../src/kernel/repository-plan.mjs';
const indexes=[{clauses:['REQ-1','REQ-2','REQ-3'].map(id=>({id}))}];
test('repository-local coverage keeps globally unassigned requirements visible in every view',()=>{
  assert.deepEqual(repositoryCoverageProjection(indexes,[{id:'a',clauseIds:['REQ-1']},{id:'b',clauseIds:['REQ-2']}]),{
    profile:'sflow-namespace-repository-coverage/v1',repositories:[{id:'a',clauseIds:['REQ-1','REQ-3']},{id:'b',clauseIds:['REQ-2','REQ-3']}]});
});
test('whole shared views retain the original profile and unknown observations do not turn into active clauses',()=>{
  assert.equal(repositoryCoverageProjection(indexes,[{id:'a',clauseIds:['REQ-1','REQ-2','REQ-3']},{id:'b',clauseIds:['REQ-1','REQ-2','REQ-3']}]),null);
  const view=repositoryCoverageProjection(indexes,[{id:'a',clauseIds:['REQ-1','withdrawn']},{id:'b',clauseIds:['REQ-2','REQ-3']}]);
  assert.deepEqual(view.repositories[0].clauseIds,['REQ-1']);
});
