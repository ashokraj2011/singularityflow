import test from 'node:test';import assert from 'node:assert/strict';import {createEngine} from '../src/engine-sdk/index.mjs';
const ref=namespace=>({namespace,sha256:'a'.repeat(64),bytes:10}),facts={schemaVersion:1,format:'sflow-namespace-constitution-exception-context/v1',
  workId:'story',phase:'review',generation:1,revision:'r1',article:{id:'ART-001',articleSha256:'b'.repeat(64)},expectedContext:'sha256:'+'c'.repeat(64),
  source:{profile:'sflow-namespace-constitution-exception-source/v1',configuration:{key:'approved',content:ref('config')},storySource:ref('state'),
    publication:{generation:1,record:ref('evidence')},reviewPacket:ref('evidence'),constitution:{articleId:'ART-001',articleSha256:'b'.repeat(64),
      policy:ref('evidence'),report:ref('evidence'),source:ref('config')}},existing:[],authorities:['reviewers'],
  recording:{status:'requires-human-review',requiredOwners:[]},read:{operation:'phase.review.resources',inputs:{workId:'story',phaseId:'review'}},
  machinePoliciesWaived:false,phaseApproved:false},context=()=>({subject:{kind:'story',id:'story'},workflow:{status:'in_progress',currentPhase:'review',phases:{review:{generation:1,status:'awaiting_approval'}}}});
test('article context shape cannot borrow another publication, accept missing source proof or claim machine-policy success',async()=>{
  for(const change of [row=>{row.workId='other';},row=>{row.generation=2;},row=>{row.article.id='ART-002';},row=>{delete row.source.publication;},
    row=>{row.source.reviewPacket.namespace='local';},row=>{row.source.constitution.articleSha256='f'.repeat(64);},row=>{row.machinePoliciesWaived=true;},
    row=>{row.recording.status='ready';},row=>{row.phaseApproved=true;}]){
    const returned=structuredClone(facts);change(returned);const engine=createEngine({ports:{constitutionExceptionContext:{load:context,read:()=>returned}}});
    await assert.rejects(engine.run('constitution.exception.context',{articleId:'ART-001'}),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const engine=createEngine({ports:{constitutionExceptionContext:{load:context,read:()=>facts}}});
  assert.equal((await engine.run('constitution.exception.context',{articleId:'art-001'})).manifest.article.id,'ART-001');
});
test('article inputs fail before host access and an actual article read error keeps its exact identity',async()=>{
  const forbidden=()=>{throw Error('Missing article inputs must not reach a host.');},engine=createEngine({ports:{constitutionExceptionContext:{load:forbidden,read:forbidden},
    decisionRecord:{load:forbidden,prepare:forbidden,commit:forbidden,finish:forbidden}}});
  await assert.rejects(engine.run('constitution.exception.context',{}),{code:'ENGINE_INPUT_INVALID'});
  await assert.rejects(engine.run('decision.constitution-exception',{phaseId:'review',articleId:'ART-001'}),{code:'ENGINE_INPUT_INVALID'});
  const denied=Object.freeze(Object.assign(Error('The actual pinned article cannot be read.'),{code:'EACCES'})),
    broken=createEngine({ports:{constitutionExceptionContext:{load:context,read(){throw denied;}}}});
  await assert.rejects(broken.run('constitution.exception.context',{articleId:'ART-001'}),error=>error===denied);
});
