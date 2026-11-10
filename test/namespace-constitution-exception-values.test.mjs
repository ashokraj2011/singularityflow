import test from 'node:test';import assert from 'node:assert/strict';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {namespaceConstitutionExceptionPolicies,namespaceConstitutionExceptionInput,namespaceConstitutionExceptionActive} from '../src/kernel/namespace-constitution-exceptions.mjs';
const rules=namespaceConstitutionExceptionPolicies(NODE_TEXT_DIGESTS),workflow={workItem:{id:'story'},status:'in_progress',currentPhase:'review',
  phases:{review:{id:'review',generation:1,status:'awaiting_approval'}},history:[]},
  input={phaseId:'review',articleId:'ART-001',scope:'Only the explicitly reviewed document in this generation.',reason:'The human reviewer accepts this exact limited interpretation with its documented mitigation.',
    expires:'2026-12-01T00:00:00.000Z',expectedContext:'sha256:'+'a'.repeat(64)},
  source={generation:1,contextBinding:input.expectedContext,article:{id:'ART-001',articleSha256:'b'.repeat(64),type:'judged',status:'active'},prior:[],
    identity:{publication:{generation:1,record:{namespace:'evidence',sha256:'c'.repeat(64),bytes:10}},reviewPacket:{namespace:'evidence',sha256:'d'.repeat(64),bytes:10},
      configuration:{key:'approved',content:{namespace:'config',sha256:'e'.repeat(64),bytes:10}},storySource:{namespace:'state',sha256:'f'.repeat(64),bytes:10},constitution:{articleId:'ART-001'}}},
  facts={at:'2026-11-11T00:00:00.000Z',actorId:'reviewer',agentId:null,authorityGroup:'reviewers'};
test('article exception values retain exact namespace bindings without changing approval or claiming a Git source',()=>{
  const before=structuredClone(workflow),result=rules.plan(workflow,input,facts,source),record=result.outcome.record;
  assert.deepEqual(workflow,before);assert.equal(result.workflow.phases.review.status,'awaiting_approval');assert.equal(record.id,'CEX-001');
  assert.deepEqual(record.binding.storySource,source.identity.storySource);assert.equal(Object.hasOwn(record.binding,'sourceCommit'),false);
  assert.deepEqual(rules.value(record),record);assert.equal(namespaceConstitutionExceptionActive(record,facts.at),true);
  assert.equal(namespaceConstitutionExceptionActive(record,'2026-12-02T00:00:00.000Z'),false);
});
test('a copied record, future wire, expired proposal and machine article do not become human exception authority',()=>{
  const record=rules.plan(workflow,input,facts,source).outcome.record;
  assert.throws(()=>rules.value({...record,reason:'Altered without the original decision hash.'}),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.throws(()=>rules.value({...record,schemaVersion:2}),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  assert.throws(()=>rules.plan(workflow,{...input,expires:'2026-01-01T00:00:00.000Z'},facts,source),{code:'ENGINE_INPUT_INVALID'});
  assert.throws(()=>rules.plan(workflow,input,facts,{...source,article:{...source.article,type:'enforced'}}),{code:'CONSTITUTION_EXCEPTION_NOT_JUDGED'});
  assert.throws(()=>namespaceConstitutionExceptionInput({...input,scope:'unclear'}),{code:'ENGINE_INPUT_INVALID'});
  assert.throws(()=>namespaceConstitutionExceptionActive(record,'not-a-time'),{code:'ENGINE_INPUT_INVALID'});
});
