import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {STARTER_CHECKLIST} from '../src/engine-compatibility/node-specification-policy.mjs';
import {namespaceSpecificationFixture,specificationText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
const reason='The independent reviewer classified this exact retained request as contextual information.',
  storyText=JSON.stringify({acceptanceCriteria:['Retain the observed conversion tests.','Document the observable input boundaries.']}),
  permissions=['decisions.list','decisions.record','decision.scope','decision.applicability'];
async function fixture(t,backend='sqlite'){
  const f=await namespaceEngineFixture(t,{backend,storyText});await f.bootstrap();f.control.permissions.push(...permissions);f.asReviewer();
  const shown=await f.engine.run('decisions.list'),items=shown.manifest.policy.items.filter(row=>row.kind==='scope-disposition');assert.equal(items.length,2);
  const input={workId:f.workId,confirmation:shown.manifest.policy.packetSha256,answers:{choose:Object.fromEntries(items.map(row=>[row.id,'scope-informative'])),
    reason:Object.fromEntries(items.map(row=>[row.id,reason]))}};
  return {...f,input,items};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': one reviewed batch records actual domain decisions and replays after completion on another host',async t=>{
  const f=await fixture(t,backend),before=await f.capture(),result=await f.engine.run('decisions.record',f.input);
  assert.equal(result.effects.recordedEntries,2);assert.equal(result.recorded.length,2);assert.ok(result.recorded.every(row=>row.value.authorityGroup==='reviewers'));
  const after=await f.capture();assert.equal(after.workflow.scopeDispositions.length,2);assert.notEqual(after.revision,before.revision);
  assert.equal((await f.engine.run('decisions.list')).manifest.policy.items.some(row=>row.kind==='scope-disposition'),false);
  f.asAuthor();await f.author();await f.review();f.asReviewer();assert.equal((await f.capture()).workflow.status,'closed');
  f.control.agentId='analyst'; // A different phase prompt does not change the original human's identity.
  const closed=await f.capture(),takeover=f.make({working:null,clock:{now(){throw Error('Accepted batches must not restamp their time.');}}});
  assert.deepEqual(await takeover.run('decisions.record',f.input),result);assert.deepEqual(await f.capture(),closed);
});
test('confirmation, outside authority and forged item answers stop before retaining a batch intent',async t=>{
  const f=await fixture(t),before=await f.capture(),runtimeBefore=await f.records.list(f.scope,'runtime',{limit:1000,prefix:'decision-batches/'});
  await assert.rejects(f.engine.run('decisions.record',{...f.input,confirmation:'sha256:'+'0'.repeat(64)}),{code:'DECISIONS_PACKET_CHANGED'});
  await assert.rejects(f.engine.run('decisions.record',{...f.input,answers:{choose:{d999:'scope-informative'}}}),{code:'DECISIONS_ANSWER_INVALID'});
  assert.deepEqual(await f.capture(),before);assert.deepEqual((await f.records.list(f.scope,'runtime',{limit:1000,prefix:'decision-batches/'})).entries,runtimeBefore.entries);
  Object.assign(f.control,{principalId:'unrelated',identity:{name:'Other human',email:'other@example.test',login:null}});
  const shown=await f.engine.run('decisions.list'),input={...f.input,confirmation:shown.manifest.policy.packetSha256};
  await assert.rejects(f.engine.run('decisions.record',input),{code:'DECISIONS_NOT_YOURS'});assert.deepEqual(await f.capture(),before);
});
for(const stage of ['intent','decision','completion'])test('a lost '+stage+' acknowledgement retains its genuine error and resumes without duplicate decisions',async t=>{
  const f=await fixture(t),timeout=Object.freeze(Object.assign(Error('The actual '+stage+' reply timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:9182,stage}}));let lost=false;
  const records={...f.records,async transact(scope,tx,options){const accepted=await f.records.transact(scope,tx,options),match=stage==='intent'?tx.operationId.startsWith('decision-batch-')&&!tx.operationId.startsWith('decision-batch-complete-')
      :stage==='completion'?tx.operationId.startsWith('decision-batch-complete-'):tx.events.some(row=>row.payload?.operation==='decision.scope');
    if(match&&!lost){lost=true;throw timeout;}return accepted;}};
  await assert.rejects(f.make({records}).run('decisions.record',f.input),error=>error===timeout);
  assert.equal(lost,true);const prefix=(await f.capture()).workflow.scopeDispositions?.length??0;assert.ok(prefix<=2);
  const result=await f.make({working:null}).run('decisions.record',f.input);assert.equal(result.effects.recordedEntries,2);
  const after=await f.capture();assert.equal(after.workflow.scopeDispositions.length,2);assert.equal(new Set(after.workflow.namespaceDecisionReceipts.map(row=>row.operationId)).size,2);
  assert.deepEqual(await f.make({working:null}).run('decisions.record',f.input),result);
});
test('unrelated work between two effects preserves the accepted prefix and requires a newly reviewed suffix',async t=>{
  const f=await fixture(t);let injected=false;
  const records={...f.records,async transact(scope,tx,options){const accepted=await f.records.transact(scope,tx,options);
    if(!injected&&tx.events.some(row=>row.payload?.operation==='decision.scope')){injected=true;
      await f.engine.run('decision.applicability',{operationId:'outside-reviewed-batch',responsibility:'verify',reason});}return accepted;}};
  await assert.rejects(f.make({records}).run('decisions.record',f.input),error=>error.code==='ENGINE_CONTEXT_CHANGED'&&error.engineDecisionEffects.recorded.length===1);
  let current=await f.capture();assert.equal(current.workflow.scopeDispositions.length,1);assert.equal(current.workflow.applicability.length,1);
  await assert.rejects(f.engine.run('decisions.record',f.input),{code:'ENGINE_CONTEXT_CHANGED'});
  const shown=await f.engine.run('decisions.list'),item=shown.manifest.policy.items.find(row=>row.kind==='scope-disposition'),input={confirmation:shown.manifest.policy.packetSha256,
    answers:{choose:{[item.id]:'scope-informative'},reason:{[item.id]:reason}}};
  assert.equal((await f.engine.run('decisions.record',input)).effects.recordedEntries,1);
  current=await f.capture();assert.equal(current.workflow.scopeDispositions.length,2);assert.equal(current.workflow.applicability.length,1);
});
test('completeness remains an explicit checklist review and is offered only after actual scope accounting',async t=>{
  const f=await fixture(t);f.control.permissions.push('decision.completeness');
  const fresh=await f.engine.run('decisions.list');f.input.confirmation=fresh.manifest.policy.packetSha256;
  assert.equal(fresh.manifest.policy.offered.length,0);await f.engine.run('decisions.record',f.input);
  const listed=await f.engine.run('decisions.list'),item=listed.manifest.policy.offered.find(row=>row.kind==='completeness-review');assert.ok(item);
  const input={confirmation:listed.manifest.policy.packetSha256,answers:{choose:{[item.id]:'completeness-review'},reason:{[item.id]:reason}}};
  await assert.rejects(f.engine.run('decisions.record',input),{code:'DECISIONS_ANSWER_INVALID'});
  input.answers.article={[item.id]:STARTER_CHECKLIST.articles.map(({id})=>({article:id,decision:'satisfied'}))};
  const result=await f.engine.run('decisions.record',input);assert.equal(result.recorded[0].kind,'completeness-review');
  assert.equal((await f.capture()).workflow.completenessReviews.length,1);
  assert.equal((await f.engine.run('decisions.list')).manifest.policy.offered.length,0);
});
test('a private specification edit after batch retention cannot authorize its old clause decision',async t=>{
  const f=await namespaceSpecificationFixture(t,{backend:'sqlite',storyText});f.control.permissions.push(...permissions);
  await f.engine.run('phase.prepare',{phaseId:'intake'});let draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'batch-private-original',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(specificationText),reason});
  const common={...f.common,working:{records:f.localRecords,content:f.localContent}},engine=createNamespaceEngine(common),
    author={principalId:f.control.principalId,actorKind:f.control.actorKind,agentId:f.control.agentId,creator:structuredClone(f.control.creator)},
    human={principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}};
  Object.assign(f.control,human);const shown=await engine.run('decisions.list'),item=shown.manifest.policy.items.find(row=>row.kind==='scope-disposition'),
    input={confirmation:shown.manifest.policy.packetSha256,answers:{choose:{[item.id]:'scope-included'},clause:{[item.id]:['STORY-1:AC-001']},reason:{[item.id]:reason}}},
    before=await f.capture();let changed=false;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(!changed&&tx.operationId.startsWith('decision-batch-')){changed=true;Object.assign(f.control,author);draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
      await f.engine.run('phase.draft.write',{operationId:'batch-private-changed',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
        content:await f.upload(specificationText+'\nThe authored condition has changed since human inspection.\n'),reason});Object.assign(f.control,human);}return result;}};
  await assert.rejects(createNamespaceEngine({...common,records}).run('decisions.record',input),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.equal(changed,true);assert.deepEqual(await f.capture(),before);
  await assert.rejects(createNamespaceEngine(common).run('decisions.record',input),{code:'ENGINE_CONTEXT_CHANGED'});
});
test('concurrent acknowledgements return the first accepted outcome even if later decisions change the live list',async t=>{
  const f=await fixture(t);let concurrent=null,intercepted=false;
  const records={...f.records,async transact(scope,tx,options){
    if(!intercepted&&tx.operationId.startsWith('decision-batch-complete-')){intercepted=true;
      await f.engine.run('decision.applicability',{operationId:'later-than-completed-batch',responsibility:'verify',reason});
      concurrent=await f.engine.run('decisions.record',f.input);}return f.records.transact(scope,tx,options);}};
  const result=await f.make({records}).run('decisions.record',f.input);assert.ok(intercepted);assert.deepEqual(result,concurrent);
  const snapshot=await f.capture();assert.equal(snapshot.workflow.scopeDispositions.length,2);assert.equal(snapshot.workflow.applicability.length,1);
  assert.deepEqual(await f.engine.run('decisions.record',f.input),result);assert.deepEqual(await f.capture(),snapshot);
});
test('failure to inspect the post-decision list preserves its exact error and already accepted decisions',async t=>{
  const f=await fixture(t),original=Object.assign(Error('The actual post-decision identity read timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:7811}});
  const access={async current(request){if(request.operation==='decisions.record'&&(await f.capture()).workflow.scopeDispositions?.length===2)throw original;
    return f.access.current(request);}};
  await assert.rejects(f.make({access}).run('decisions.record',f.input),error=>error===original&&error.engineDecisionEffects.recorded.length===2);
  assert.equal((await f.capture()).workflow.scopeDispositions.length,2);
  assert.equal((await f.make({working:null}).run('decisions.record',f.input)).effects.recordedEntries,2);
});
