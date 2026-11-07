import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const sha='a'.repeat(64),ref={kind:'phase-document',id:'opaque-1',workId:'STORY-1',phase:'team-code',generation:2};
function fixture(hook=()=>{}) {
  const context={subject:{kind:'story',id:'STORY-1'},workflow:{workItem:{id:'STORY-1',branch:'team/feature'},currentPhase:'team-code',
    phases:{'team-code':{id:'team-code',generation:2,status:'awaiting_approval',artifacts:[{path:'artifacts/code.md',sha256:sha,size:3}]}}}};
  const resolved={workId:'STORY-1',id:'PRIMARY',reference:ref,phase:'team-code',generation:2,sourceKey:'artifacts/code.md',
    role:'artifact',name:'Code summary',kind:'implementation-summary',mimeType:'text/markdown',locality:'project',
    expected:{sha256:sha,bytes:3},maximumBytes:16,uri:null};
  const facts={id:'PRIMARY',revision:'opaque-revision',observed:{sha256:sha,bytes:3,binary:false},
    content:{kind:'text',text:'€',bytes:3,truncated:false},extractionFailure:null};
  const calls=[],args={},port={};
  for(const stage of ['load','resolve','read'])port[stage]=async(...values)=>{
    calls.push(stage);args[stage]=values;
    const result=await hook(stage,{context,resolved,facts,calls},values);
    return result!==undefined?result:stage==='load'?context:stage==='resolve'?resolved:facts;
  };
  return {context,resolved,facts,calls,args,engine:createEngine({ports:{documentRead:port}})};
}

test('registered document reads return immutable bounded domain text with no host paths or consent',async()=>{
  const operation=ENGINE_OPERATIONS.find(entry=>entry.id==='document.read');
  assert.equal(operation.effect,'read');assert.equal(operation.humanDecision,false);assert.deepEqual(operation.stages,['load','resolve','read']);
  const f=fixture(),result=await f.engine.run('document.read',{reference:ref});
  assert.deepEqual(f.calls,['load','resolve','read']);assert.equal(result.document.contract,'sflow-document-read/v1');
  assert.equal(result.document.content.text,'€');assert.equal(result.document.integrity,'matched');assert.equal(result.document.provenance,'retained');
  assert.equal(Object.isFrozen(result.document.content),true);assert.equal('sourceKey' in result.document,false);
  assert.equal('absolutePath' in result.document,false);assert.equal('commandGuidance' in result,false);
  assert.deepEqual(result.effects,{committed:false,pushed:false,humanReviewRecorded:false,approvalRecorded:false});
});

test('invalid references, budgets, host flags and getters fail before any I/O',async()=>{
  const f=fixture();
  for(const extra of [{root:'/other'},{workflow:{}},{actor:'forged'},{presentation:{}},{maximumBytes:1048577},{maximumBytes:-1},
    {maximumBytes:1.5},{includeDetached:'yes'},{reference:''},{reference:{...ref,generation:-1}},
    {reference:{...ref,path:'../private'}},{reference:{kind:'story-document',id:'D'}},
    {get workId(){throw Error('do not execute');}}]) {
    const descriptors=Object.getOwnPropertyDescriptors(extra);
    const input=Object.defineProperties({reference:ref},descriptors);
    await assert.rejects(f.engine.run('document.read',input),{code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(f.calls,[]);
});

test('generation and canonical Story references are checked before catalog or file reads',async()=>{
  for(const reference of [{...ref,generation:1},{...ref,workId:'OTHER'}]) {
    const f=fixture();
    await assert.rejects(f.engine.run('document.read',{reference}),{code:reference.workId==='OTHER'?'ACTIVE_SUBJECT_MISMATCH':'DOCUMENT_REFERENCE_STALE'});
    assert.deepEqual(f.calls,['load']);
  }
  const f=fixture();
  assert.equal((await f.engine.run('document.read',{reference:'PRIMARY',workId:'team/feature'})).subject.id,'STORY-1');
  const wrong=fixture();await assert.rejects(wrong.engine.run('document.read',{reference:'PRIMARY',workId:'OTHER'}),{code:'ACTIVE_SUBJECT_MISMATCH'});
  const malformed=fixture(stage=>stage==='load'?{subject:{kind:'story',id:1},workflow:{workItem:{id:1}}}:undefined);
  await assert.rejects(malformed.engine.run('document.read',{reference:'PRIMARY'}),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.deepEqual(malformed.calls,['load']);
});

test('a resolver cannot replace a captured retained hash, member, phase or generation',async()=>{
  for(const change of [value=>{value.expected.sha256='b'.repeat(64);},value=>{value.sourceKey='other.md';},
    value=>{value.generation=3;},value=>{value.reference={...ref,id:'other'};},value=>{value.phase='constructor';}]) {
    const f=fixture((stage,{context,resolved})=>{if(stage==='resolve') {
      context.workflow.phases['team-code'].artifacts[0].sha256='b'.repeat(64);change(resolved);
    }});
    await assert.rejects(f.engine.run('document.read',{reference:ref}),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.deepEqual(f.calls,['load','resolve']);
  }
});

test('catalog files and current snapshots report their different byte provenance honestly',async()=>{
  const f=fixture((stage,{resolved})=>{if(stage==='resolve')Object.assign(resolved,{id:'DOC-001',reference:{kind:'story-document',id:'DOC-001',workId:'STORY-1'},
    phase:null,generation:null,role:'file',sourceKey:null,locality:'machine-local'});});
  f.facts.id='DOC-001';
  const file=await f.engine.run('document.read',{reference:'Requirements'});
  assert.equal(file.document.locality,'machine-local');assert.equal(file.document.provenance,'catalog');
  const snapshot=fixture((stage,{context,resolved})=>{
    if(stage==='load')context.workflow.phases['team-code'].artifacts=[];
    if(stage==='resolve')resolved.expected=null;
  });
  assert.equal((await snapshot.engine.run('document.read',{reference:'PRIMARY'})).document.integrity,'unbound');
  const changed=fixture((stage,{facts})=>{if(stage==='read')facts.observed.sha256='c'.repeat(64);});
  assert.equal((await changed.engine.run('document.read',{reference:'PRIMARY'})).document.integrity,'changed');
});

test('UTF-8 byte counts, truncation, shape and native policy budgets cannot be overstated',async()=>{
  for(const change of [facts=>{facts.content.bytes=1;},facts=>{facts.content.text='four';facts.content.bytes=4;},
    facts=>{facts.content.text='';facts.content.bytes=0;},facts=>{facts.content.command='run something';},
    facts=>{facts.content=null;},facts=>{facts.observed.sha256='bad';},facts=>{facts.absolutePath='/host';}]) {
    const f=fixture((stage,{resolved,facts})=>{if(stage==='resolve')resolved.maximumBytes=3;if(stage==='read')change(facts);});
    await assert.rejects(f.engine.run('document.read',{reference:ref,maximumBytes:3}),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const f=fixture((stage,{resolved,facts})=>{
    if(stage==='resolve')resolved.maximumBytes=0;
    if(stage==='read')Object.assign(facts.content,{text:'',bytes:0,truncated:true});
  });
  assert.equal((await f.engine.run('document.read',{reference:ref,maximumBytes:0})).document.content.truncated,true);
});

test('verified binary metadata and bounded extracted text never become a visual sign-off',async()=>{
  for(const mode of ['binary','extracted','unreadable']) {
    const f=fixture((stage,{facts})=>{if(stage==='read') {
      facts.observed.binary=true;
      facts.content=mode==='extracted'?{kind:'extracted-text',text:'€',bytes:3,truncated:false,sha256:sha,extractor:'source-text',version:2}:null;
      if(mode==='unreadable')facts.extractionFailure={reason:'Native extractor could not read this format.'};
    }});
    const result=await f.engine.run('document.read',{reference:ref});
    assert.equal(result.document.observed.binary,true);assert.equal(result.effects.humanReviewRecorded,false);
    if(mode==='unreadable')assert.match(result.document.extractionFailure.reason,/could not read/);
  }
});

test('external links are data references, not fetched bytes or verified content',async()=>{
  const f=fixture((stage,{resolved,facts})=>{
    if(stage==='resolve')Object.assign(resolved,{id:'DOC-001',reference:{kind:'story-document',id:'DOC-001',workId:'STORY-1'},
      role:'url',phase:null,generation:null,sourceKey:null,expected:null,locality:'external',uri:'https://example.com/reference'});
    if(stage==='read')Object.assign(facts,{id:'DOC-001',observed:null,content:null});
  });
  const result=await f.engine.run('document.read',{reference:'DOC-001'});
  assert.equal(result.document.integrity,'reference-only');assert.equal(result.document.provenance,'external');
});

test('native errors keep their original identity, causes and recovery at every stage without retries',async()=>{
  for(const at of ['load','resolve','read']) {
    const error=new SingularityFlowError('Original unavailable document.',{code:'DOCUMENT_LOCAL_UNAVAILABLE',
      cause:Object.assign(new Error('Volume denied read'),{code:'EACCES'}),details:{recovery:'original exact restore route'}});
    const f=fixture(stage=>{if(stage===at)throw error;});
    await assert.rejects(f.engine.run('document.read',{reference:ref}),actual=>actual===error&&actual.cause.code==='EACCES');
    assert.equal(f.calls.filter(stage=>stage===at).length,1);
  }
});

test('cancellation and accessor results stop the read before any later stage',async()=>{
  for(const at of ['load','resolve','read']) {
    const controller=new AbortController(),f=fixture(stage=>{if(stage===at)controller.abort();});
    await assert.rejects(f.engine.run('document.read',{reference:ref},{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
    assert.equal(f.calls.at(-1),at);
  }
  const f=fixture((stage,{facts})=>{if(stage==='read')Object.defineProperty(facts,'revision',{enumerable:true,
    get(){throw Error('do not invoke native getter');}});});
  await assert.rejects(f.engine.run('document.read',{reference:ref}),error=>error.code==='ENGINE_PORT_RESULT_INVALID'&&error.cause.code==='ENGINE_INPUT_INVALID');
});
