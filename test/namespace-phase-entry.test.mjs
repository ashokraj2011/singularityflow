/** Real namespace entry, human replies and exact body reads through one Engine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {namespacePreparationFixture} from './helpers/namespace-preparation-fixture.mjs';
import {namespaceSpecificationFixture,specificationText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
const reply=[{question:'Which behavior belongs in the document?',answer:'Retain the confirmed converter scope and its input boundaries.'}];
async function fixture(t,{backend='filesystem',required=false,code=false}={}) {
  const f=await namespacePreparationFixture(t,{backend,code,configure:source=>{source.definition.phases.intake.clarification={mode:required?'required':'off',markers:{mode:'off'}};}});
  f.control.permissions.push('phase.enter','phase.context.read','clarification.record','phase.publish');
  const options={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock,
    sources:f.unit?[f.unit]:[],working:{records:f.localRecords,content:f.localContent}},make=extra=>createNamespaceEngine({...options,...extra}),engine=make();
  const enter=(extra={})=>engine.run('phase.enter',{phaseId:'intake',compose:true,...extra});
  const read=(entry,resource,extra={})=>engine.run('phase.context.read',{workId:f.inputs.workId,phaseId:'intake',contextSha256:entry.manifest.context.sha256,resourceId:resource.id,...extra});
  return {...f,options,make,engine,enter,read};
}
for(const backend of ['filesystem','sqlite','application']) {
  test(backend+': entry issues actual source/author/template references before preparation without writing a draft or phase',async t=>{
    const f=await fixture(t,{backend,required:true}),before=await f.head(),result=await f.enter();
    assert.equal(result.manifest.contract,'sflow-phase-entry-manifest/v2');assert.equal(result.status,'clarification-required');
    assert.equal(result.authoringAllowed,false);assert.equal(result.manifest.clarification.questioningAllowed,true);
    assert.notEqual(result.manifest.context.sha256,result.manifest.clarification.contextSha256);
    assert.deepEqual(result.manifest.resources.map(item=>item.kind),['agent','skill','instruction','instruction','story-source','artifact-template']);
    const source=result.manifest.resources.find(item=>item.kind==='story-source'),body=await f.read(result,source);
    assert.match(body.content.text,/Add a converter/);assert.equal(body.reference.sha256,source.reference.sha256);
    assert.deepEqual(await f.head(),before);assert.equal((await f.engine.run('phase.draft.read',{phaseId:'intake'})).manifest.status,'missing');
    assert.equal(result.effects.clarificationStagingIssued,false);assert.equal(result.effects.modelInvocations,0);
    const request={operationId:'answer-entry',workId:f.inputs.workId,phaseId:'intake',agentId:result.manifest.authorAgentId,
      contextSha256:result.manifest.clarification.contextSha256,responses:reply};
    const recorded=await f.engine.run('clarification.record',request),answered=await f.enter();
    assert.equal(answered.status,'preparation-required');assert.equal(answered.manifest.clarification.questioningAllowed,false);
    assert.equal(answered.manifest.clarification.recordingAllowed,false);
    const human=answered.manifest.resources.find(item=>item.kind==='human-clarifications'),humanBody=await f.read(answered,human);
    assert.equal(human.reference.sha256,recorded.reference.sha256);assert.equal(JSON.parse(humanBody.content.text).responses[0].answer,reply[0].answer);
    await assert.rejects(f.read(result,source),{code:'ENGINE_CONTEXT_CHANGED'});
  });
  test(backend+': a prepared draft admits authoring, edits invalidate only the read plan, and publication cannot reopen questioning',async t=>{
    const f=await fixture(t,{backend,required:true}),before=await f.head(),initial=await f.enter();
    await f.engine.run('clarification.record',{operationId:'confirmed-current-inputs',workId:f.inputs.workId,phaseId:'intake',
      agentId:initial.manifest.authorAgentId,contextSha256:initial.manifest.clarification.contextSha256,responses:reply});
    await f.engine.run('phase.prepare',{phaseId:'intake'});
    const entry=await f.enter();assert.equal(entry.status,'authoring-entry');assert.equal(entry.authoringAllowed,true);
    const resource=entry.manifest.resources.find(item=>item.kind==='current-draft');assert.ok(resource);
    assert.equal((await f.read(entry,resource)).content.kind,'text');
    await f.engine.run('phase.draft.write',{operationId:'author-context-draft',workId:f.inputs.workId,phaseId:'intake',expectedRevision:entry.manifest.draft.revision,
      content:await f.upload('# Completed scope\n\nThe confirmed converter scope includes boundary evidence.\n'),reason:'Author the real current artifact.'});
    await assert.rejects(f.read(entry,resource),{code:'ENGINE_CONTEXT_CHANGED'});
    const edited=await f.enter();assert.notEqual(edited.manifest.context.sha256,entry.manifest.context.sha256);
    assert.equal(edited.manifest.clarification.contextSha256,entry.manifest.clarification.contextSha256);assert.deepEqual(await f.head(),before);
    await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
    const published=await f.enter();assert.equal(published.status,'retained-generation');assert.equal(published.authoringAllowed,false);
    assert.equal(published.manifest.clarification.questioningAllowed,false);assert.equal(published.manifest.actions[0].operation,'phase.review');
    assert.equal(published.manifest.clarification.recordingAllowed,false);
    const takeover=await f.make({working:null}).run('phase.enter',{phaseId:'intake',compose:true});
    assert.equal(takeover.status,'retained-generation');assert.equal(takeover.manifest.draft,null);
    assert.equal(takeover.manifest.clarification.questioningAllowed,false);
    assert.equal(takeover.manifest.clarification.record.reference.sha256,published.manifest.clarification.record.reference.sha256);
    const answers=takeover.manifest.resources.find(item=>item.kind==='human-clarifications');
    const retained=await f.make({working:null}).run('phase.context.read',{workId:f.inputs.workId,phaseId:'intake',
      contextSha256:takeover.manifest.context.sha256,resourceId:answers.id});
    assert.equal(JSON.parse(retained.content.text).responses[0].answer,reply[0].answer);
  });
}
test('actual private generation intent and bound source units determine code authoring readiness',async t=>{
  const f=await fixture(t,{code:true});const unopened=await f.enter();assert.equal(unopened.codeAuthoringReady,false);
  await f.engine.run('phase.prepare',{phaseId:'intake'});const opened=await f.enter();assert.equal(opened.codeAuthoringReady,true);
  const intent=opened.manifest.resources.find(item=>item.kind==='generation-intent'),body=await f.read(opened,intent);
  assert.equal(JSON.parse(body.content.text).generation,1);
  const missing=await f.make({sources:[]}).run('phase.enter',{phaseId:'intake',compose:true});
  assert.equal(missing.codeAuthoringReady,false);assert.equal(missing.authoringAllowed,false);
  assert.ok(missing.manifest.blockers.some(item=>item.code==='ENGINE_SOURCE_UNIT_UNAVAILABLE'));
});
test('read budgets, UTF-8 boundaries, base64 chunks and metadata reads retain original body identity',async t=>{
  const f=await fixture(t);await f.engine.run('phase.prepare',{phaseId:'intake'});
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'multibyte-context',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload('\ufeffé中𠜎-end'),reason:'Retain exact UTF-8 bytes for bounded reads.'});
  const entry=await f.enter(),resource=entry.manifest.resources.find(item=>item.kind==='current-draft');
  const limited=await f.read(entry,resource,{maximumBytes:6});assert.equal(limited.content.text,'\ufeffé');assert.equal(limited.content.bytes,5);assert.equal(limited.content.truncated,true);
  const bytes=await f.read(entry,resource,{representation:'base64',offset:3,maximumBytes:5});assert.equal(bytes.content.bytes,5);
  assert.deepEqual(Buffer.from(bytes.content.base64,'base64'),Buffer.from('\ufeffé中𠜎-end').subarray(3,8));
  assert.equal((await f.read(entry,resource,{representation:'metadata'})).content,null);
  await assert.rejects(f.read(entry,resource,{offset:1}),{code:'ENGINE_INPUT_INVALID'});
});

test('binary resources return explicit encoding and exact byte chunks instead of pretending to be text',async t=>{
  const f=await fixture(t);await f.engine.run('phase.prepare',{phaseId:'intake'});
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'}),image=Buffer.from([137,80,78,71,0,255,8,10]);
  const content=(await f.localContent.put(f.scope,'local',image)).reference;
  await f.engine.run('phase.draft.write',{operationId:'save-binary-resource',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:draft.manifest.draft.revision,content,reason:'Retain the original binary draft bytes.'});
  const entry=await f.enter(),resource=entry.manifest.resources.find(item=>item.kind==='current-draft');
  const text=await f.read(entry,resource);assert.equal(text.encoding,'binary');assert.equal(text.content,null);
  const chunk=await f.read(entry,resource,{representation:'base64',offset:2,maximumBytes:3});
  assert.deepEqual(Buffer.from(chunk.content.base64,'base64'),image.subarray(2,5));assert.equal(chunk.reference.sha256,content.sha256);
  await assert.rejects(f.read(entry,resource,{representation:'base64',offset:9}),{code:'ENGINE_INPUT_INVALID'});
});

test('a phase read includes accepted predecessor bytes only after actual publication and independent approval',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:source=>{source.definition.inputsMode='enforce';}});
  await f.author('intake',specificationText);await f.approve('intake');
  f.control.permissions.push('phase.enter','phase.context.read');
  const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent}}),before=await f.capture();
  const entry=await engine.run('phase.enter',{phaseId:'design',compose:true});assert.equal(entry.status,'preparation-required');
  const upstream=entry.manifest.resources.find(item=>item.kind==='approved-input');assert.equal(upstream.phase,'intake');assert.equal(upstream.generation,1);
  const read=await engine.run('phase.context.read',{workId:f.inputs.workId,phaseId:'design',contextSha256:entry.manifest.context.sha256,resourceId:upstream.id});
  assert.equal(read.content.text,specificationText);assert.deepEqual(await f.capture(),before);
  await assert.rejects(engine.run('phase.enter',{phaseId:'intake'}),{code:'PHASE_DRAFT_NOT_ACTIVE'});
});

test('missing author permission and an unbound agent remain explicit without repeating human questions',async t=>{
  const f=await fixture(t);await f.engine.run('phase.prepare',{phaseId:'intake'});
  f.control.permissions=f.control.permissions.filter(permission=>permission!=='phase.draft.write');
  const held=await f.enter();assert.equal(held.authoringAllowed,false);assert.equal(held.status,'author-permission-required');
  assert.deepEqual(held.manifest.actions[0].prerequisites,['phase.draft.write-permission']);
  f.control.agentId=null;const agent=await f.enter();assert.equal(agent.authoringAllowed,false);
  assert.ok(agent.manifest.blockers.some(item=>item.code==='AGENT_SESSION_REQUIRED'));
  assert.equal(agent.manifest.clarification.questioningAllowed,false);
});

test('source changes invalidate a read and cannot borrow a generation opened against other bytes',async t=>{
  const f=await fixture(t,{code:true});await f.engine.run('phase.prepare',{phaseId:'intake'});
  const entry=await f.enter(),resource=entry.manifest.resources.find(item=>item.kind==='story-source');let calls=0;
  const source={...f.unit,async capture(options){if(++calls===2)await writeFile(path.join(f.sourceRoot,'app.js'),'export const answer = 43;');return f.unit.capture(options);}};
  await assert.rejects(f.make({sources:[source]}).run('phase.context.read',{workId:f.inputs.workId,phaseId:'intake',
    contextSha256:entry.manifest.context.sha256,resourceId:resource.id}),{code:'ENGINE_SOURCE_CHANGED'});
  assert.equal(calls,2);
  await assert.rejects(f.read(entry,resource),{code:'ENGINE_CONTEXT_CHANGED'});
});

test('a reply arriving during context reading invalidates the observed absent checkpoint without altering the Story',async t=>{
  const f=await fixture(t,{required:true}),entry=await f.enter(),before=await f.head();let calls=0;
  const access={async current(request){if(request.operation==='phase.context.read'&&++calls===2)await f.engine.run('clarification.record',{
    operationId:'answer-during-read',workId:f.inputs.workId,phaseId:'intake',contextSha256:entry.manifest.clarification.contextSha256,responses:reply});
    return f.access.current(request);}};
  const resource=entry.manifest.resources.find(item=>item.kind==='story-source');
  await assert.rejects(f.make({access}).run('phase.context.read',{workId:f.inputs.workId,phaseId:'intake',
    contextSha256:entry.manifest.context.sha256,resourceId:resource.id}),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.deepEqual(await f.head(),before);assert.equal((await f.enter()).status,'preparation-required');
});

test('private edits during a context read preserve authored bytes and require a fresh manifest',async t=>{
  const f=await fixture(t);await f.engine.run('phase.prepare',{phaseId:'intake'});const entry=await f.enter();let calls=0;
  const access={async current(request){if(request.operation==='phase.context.read'&&++calls===2)await f.engine.run('phase.draft.write',{
    operationId:'edit-during-read',workId:f.inputs.workId,phaseId:'intake',expectedRevision:entry.manifest.draft.revision,
    content:await f.upload('A concurrently authored document.'),reason:'Retain the actual concurrent author edit.'});return f.access.current(request);}};
  const resource=entry.manifest.resources.find(item=>item.kind==='current-draft');
  await assert.rejects(f.make({access}).run('phase.context.read',{workId:f.inputs.workId,phaseId:'intake',
    contextSha256:entry.manifest.context.sha256,resourceId:resource.id}),{code:'ENGINE_CONTEXT_CHANGED'});
  const fresh=await f.enter();assert.equal((await f.read(fresh,fresh.manifest.resources.find(item=>item.kind==='current-draft'))).content.text,'A concurrently authored document.');
});

test('permission changes and cancellation are rechecked before returning a context body',async t=>{
  const f=await fixture(t),entry=await f.enter(),resource=entry.manifest.resources.find(item=>item.kind==='story-source');
  for(const cancel of [false,true]) {
    const controller=new AbortController();let calls=0;
    const access={async current(request){const facts=await f.access.current(request);if(request.operation==='phase.context.read'&&++calls===2){
      if(cancel)controller.abort();else facts.permissions=facts.permissions.filter(permission=>permission!=='phase.draft.write');}return facts;}};
    await assert.rejects(f.make({access}).run('phase.context.read',{workId:f.inputs.workId,phaseId:'intake',
      contextSha256:entry.manifest.context.sha256,resourceId:resource.id},{signal:controller.signal}),{code:cancel?'ENGINE_OPERATION_CANCELLED':'ENGINE_CONTEXT_CHANGED'});
    assert.equal(calls,2);
  }
});

test('real content permission and timeout errors keep their identity and details in both entry and exact reads',async t=>{
  const f=await fixture(t),entry=await f.enter(),source=entry.manifest.resources.find(item=>item.kind==='story-source');
  for(const failure of [Object.assign(Error('Original content permission error.'),{code:'EACCES',path:'actual-content.db'}),
    Object.assign(Error('Original content deadline.'),{code:'ETIMEDOUT',timeoutMs:300000})]) {
    const content={...f.content,read(scope,reference,options){if(reference.sha256===source.reference.sha256)throw failure;return f.content.read(scope,reference,options);}};
    const engine=f.make({content});
    await assert.rejects(engine.run('phase.enter',{phaseId:'intake',compose:true}),actual=>actual===failure);
    await assert.rejects(engine.run('phase.context.read',{workId:f.inputs.workId,phaseId:'intake',contextSha256:entry.manifest.context.sha256,resourceId:source.id}),actual=>actual===failure);
  }
});
