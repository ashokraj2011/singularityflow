import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {namespaceSpecificationFixture,specificationText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {STARTER_CHECKLIST} from '../src/engine-compatibility/node-specification-policy.mjs';
const reason='The authenticated scope reviewer assessed this exact statement and its intended classification.',
  storyText=JSON.stringify({acceptanceCriteria:['Retain test cases for the confirmed behavior.']});
const checklist=STARTER_CHECKLIST.articles.map(article=>({article:article.id,decision:'satisfied'}));
function permissions(f){f.control.permissions.push('scope.context','decision.scope','decision.completeness','decision.applicability');}
for(const backend of ['filesystem','sqlite','application'])test(backend+': real scope, completeness and applicability decisions replay their original receipts after completion',async t=>{
  const f=await namespaceEngineFixture(t,{backend,storyText});await f.bootstrap();permissions(f);f.asReviewer();
  const before=await f.capture(),shown=await f.engine.run('scope.context'),item=shown.manifest.inventory.items[0];
  assert.equal(shown.manifest.inventory.summary.unresolved,1);assert.deepEqual(await f.capture(),before);
  const input={operationId:'scope-one',item:item.id,disposition:'excluded',reason},first=await f.engine.run('decision.scope',input);
  assert.equal(first.record.item,item.id);assert.equal(first.record.disposition,'excluded');assert.equal(first.actorId,'independent-reviewer');
  assert.equal((await f.engine.run('scope.context')).manifest.inventory.summary.excluded,1);
  await f.engine.run('decision.scope',{...input,operationId:'scope-two',disposition:'informative'});
  const latest=await f.capture();assert.equal(latest.workflow.scopeDispositions.length,2);assert.ok(latest.workflow.scopeDispositions[0].withdrawnAt);
  assert.deepEqual(await f.engine.run('decision.scope',input),first);assert.deepEqual(await f.capture(),latest);
  await assert.rejects(f.engine.run('decision.scope',{...input,disposition:'deferred'}),{code:'ENGINE_OPERATION_ID_REUSED'});
  await assert.rejects(f.engine.run('decision.scope',{operationId:'unknown-clause',item:item.id,disposition:'included',clauseIds:['S:REQ-999'],reason}),{code:'SCOPE_CLAUSE_UNKNOWN'});
  const inventory=(await f.engine.run('scope.context')).manifest.inventory;
  await f.engine.run('decision.completeness',{operationId:'complete-scope',confirm:inventory.inventorySha256,checklist,reason});
  assert.equal((await f.engine.run('scope.context')).manifest.completenessReview.inventorySha256,inventory.inventorySha256);
  const applicability=await f.engine.run('decision.applicability',{operationId:'omit-delivery',responsibility:'implement',reason});
  assert.equal(applicability.record.responsibility,'implement');assert.equal((await f.capture()).workflow.currentPhase,'intake');
  await f.author();await f.review();f.asReviewer();const completed=await f.capture();assert.equal(completed.workflow.status,'closed');
  assert.deepEqual(await f.make({clock:{now(){throw Error('An accepted decision cannot restamp its timestamp.');}}}).run('decision.scope',input),first);
  assert.deepEqual(await f.capture(),completed);
});
test('included scope uses real published clause definitions and keeps human identity separate from the author',async t=>{
  const f=await namespaceSpecificationFixture(t,{storyText});permissions(f);await f.author('intake',specificationText);
  const engine=createNamespaceEngine({...f.common}),shown=await engine.run('scope.context'),item=shown.manifest.inventory.items[0];
  assert.deepEqual(shown.manifest.knownClauseIds,['STORY-1:AC-001','STORY-1:REQ-001']);
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const result=await engine.run('decision.scope',{operationId:'link-real-clause',item:item.id,disposition:'included',clauseIds:['STORY-1:AC-001'],reason});
  assert.equal(result.actorId,'independent-reviewer');assert.deepEqual(result.record.clauseIds,['STORY-1:AC-001']);
  assert.equal((await engine.run('scope.context')).manifest.inventory.summary.included,1);
});
test('scope decisions preserve actual timeout details and reconcile a lost acknowledgement without duplicate records',async t=>{
  const f=await namespaceEngineFixture(t,{storyText});await f.bootstrap();permissions(f);f.asReviewer();const item=(await f.engine.run('scope.context')).manifest.inventory.items[0],
    input={operationId:'lost-scope',item:item.id,disposition:'informative',reason},timeout=Object.assign(new Error('The actual transaction reply timed out.'),{code:'ETIMEDOUT',details:{deadlineMs:4567}});let lost=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!lost&&args[1].events.some(row=>row.payload?.operation==='decision.scope')){lost=true;throw timeout;}return result;}};
  await assert.rejects(f.make({records}).run('decision.scope',input),error=>error===timeout);assert.equal(lost,true);
  const state=await f.capture();await f.engine.run('decision.scope',input);assert.deepEqual(await f.capture(),state);
  assert.equal(state.workflow.namespaceDecisionReceipts.length,1);
});

for(const backend of ['filesystem','sqlite','application'])test(backend+': human scope choices can name the current authored specification before publication and replay without its device',async t=>{
  const f=await namespaceSpecificationFixture(t,{backend,storyText});permissions(f);
  await f.engine.run('phase.prepare',{phaseId:'intake'});
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'draft-scope-contract',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:draft.manifest.draft.revision,content:await f.upload(specificationText),reason:'Author the exact current specification before deciding its scope.'});
  const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent}}),
    shown=await engine.run('scope.context'),item=shown.manifest.inventory.items[0],before=await f.capture();
  assert.deepEqual(shown.manifest.knownClauseIds,['STORY-1:AC-001','STORY-1:REQ-001']);
  assert.equal(before.workflow.phases.intake.generation,0);assert.equal(before.workflow.phases.intake.publicationBindings?.length??0,0);
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const request={operationId:'scope-from-private-draft',item:item.id,disposition:'included',clauseIds:['STORY-1:AC-001'],reason},
    accepted=await engine.run('decision.scope',request),after=await f.capture();
  assert.equal(accepted.record.item,item.id);assert.equal(after.workflow.phases.intake.generation,0);
  assert.equal((await engine.run('scope.context')).manifest.inventory.summary.included,1);
  const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('Do not restamp a retained scope choice.');}}});
  assert.deepEqual(await replay.run('decision.scope',request),accepted);assert.deepEqual(await f.capture(),after);
  assert.deepEqual((await replay.run('scope.context')).manifest.knownClauseIds,[]);
});

test('an interrupted prepared scope decision cannot accept a subsequently edited private specification',async t=>{
  const f=await namespaceSpecificationFixture(t,{storyText});permissions(f);await f.engine.run('phase.prepare',{phaseId:'intake'});
  let draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'original-private-scope',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(specificationText),reason:'Author the exact specification the human is about to classify.'});
  const options={...f.common,working:{records:f.localRecords,content:f.localContent}},engine=createNamespaceEngine(options),item=(await engine.run('scope.context')).manifest.inventory.items[0],
    author={principalId:f.control.principalId,actorKind:f.control.actorKind,agentId:f.control.agentId,creator:structuredClone(f.control.creator)};
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const input={operationId:'interrupted-private-scope',item:item.id,disposition:'included',clauseIds:['STORY-1:AC-001'],reason},
    interruption=Object.assign(new Error('The preparation acknowledgement was lost.'),{code:'ETIMEDOUT'});let lost=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!lost&&args[1].changes.some(row=>row.namespace==='runtime'&&row.value?.operation==='decision.scope')){lost=true;throw interruption;}return result;}};
  await assert.rejects(createNamespaceEngine({...options,records}).run('decision.scope',input),error=>error===interruption);assert.equal(lost,true);
  const before=await f.capture();Object.assign(f.control,author);draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'changed-private-scope',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(specificationText+'\nThe specification now has another explicitly authored condition.\n'),reason:'Change the private specification after the interrupted human decision.'});
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  await assert.rejects(engine.run('decision.scope',input),{code:'ENGINE_CONTEXT_CHANGED'});assert.deepEqual(await f.capture(),before);
});
