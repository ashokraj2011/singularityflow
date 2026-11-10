import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as native from '../src/forward-amendments.mjs';
import * as rules from '../src/kernel/upstream-issues.mjs';
import {forgetPersonCounts,registerPersonCounts,presencePinKey} from '../src/presence/counted.mjs';
const captured=JSON.parse(await readFile(new URL('./fixtures/forward-amendment-values/native-v1.json',import.meta.url),'utf8'));
for(const row of captured.cases)test('forward-amendment queries preserve captured native '+row.name,()=>{
  forgetPersonCounts();
  try{
    const w=structuredClone(row.workflow),phase=w.phases?.review;
    if(row.name.startsWith('presence-'))registerPersonCounts(presencePinKey(w),()=>row.name==='presence-true');
    const expected=row.outcome,sha='b'.repeat(64);
    assert.deepEqual(native.nextForwardAmendmentProposal('stories/example-story',w,'notes.md'),expected.next);
    assert.deepEqual(native.forwardAmendmentDecision(w,'FAM-001'),expected.decision);
    assert.deepEqual(native.pendingForwardAmendments(w),expected.pending);
    assert.deepEqual(native.pendingAmendmentRevalidations(w),expected.owed);
    assert.deepEqual([...native.acceptedRevalidationBindings(w,phase,sha)],expected.bindings);
    assert.deepEqual(native.forwardAmendmentTerminalBlockers(w),expected.terminal);
    assert.deepEqual(rules.nextForwardAmendmentProposal('stories/example-story',w,'notes.md'),expected.next);
    assert.deepEqual(rules.forwardAmendmentDecision(w,'FAM-001',row.observed.decisions),expected.decision);
    assert.deepEqual(rules.pendingForwardAmendments(w,row.observed.decisions),expected.pending);
    assert.deepEqual(rules.pendingAmendmentRevalidations(w,row.observed),expected.owed);
    assert.deepEqual([...rules.acceptedRevalidationBindings(w,phase,sha,row.observed.revalidations)],expected.bindings);
  }finally{forgetPersonCounts();}
});
test('admitted forward-amendment records preserve latest-wins, Number coercion and object ownership',()=>{
  const binding={producer:'notes',producerGeneration:2,inputRecordSha256:'x',producerSha256:'y'},
    prior={amendment:'FAM-001',phase:'review',generation:'2',outcome:'unchanged',binding},
    newer={...prior,amendment:'FAM-002',binding:{...binding,producerGeneration:3}},
    workflow={phases:{review:{id:'review',status:'approved',generation:2}}};
  const actual=rules.acceptedRevalidationBindings(workflow,workflow.phases.review,'x',[prior,newer]);
  assert.deepEqual(actual.get('notes'),{...newer.binding,amendment:'FAM-002'});
  assert.notEqual(actual.get('notes'),newer.binding);
  const decision={amendment:'FAM-001',decision:'rejected'};
  assert.equal(rules.forwardAmendmentDecision({},'FAM-001',[decision]),decision);
  assert.deepEqual(rules.pendingForwardAmendments({forwardAmendments:[{id:'FAM-001'}]},[decision]),[]);
});
