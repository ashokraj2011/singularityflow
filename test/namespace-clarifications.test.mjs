/** Real checkpoints, shared replay and publication admission on every opt-in namespace backend. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceSpecificationFixture,specificationText,planText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceClarificationEngine} from '../src/engine-storage/namespace-clarifications.mjs';
import {createNamespacePublicationReader} from '../src/engine-storage/namespace-publication-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceLifecycleReceiptReader} from '../src/engine-storage/namespace-lifecycle-receipt-reader.mjs';
import {CLARIFICATION_EVIDENCE} from '../src/engine-storage/namespace-clarification-reader.mjs';
import {createFilesystemSourceUnit} from '../src/sgos/filesystem-source-unit.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const responses=[{question:'What should the converter display?',answer:'Convert non-negative integers to uppercase hexadecimal and retain automated boundary tests.'}];
async function fixture(t,backend,mode='required',configure=()=>{}) {
  const f=await namespaceSpecificationFixture(t,{backend,configure(source){source.definition.phases.intake.clarification={mode,maxQuestions:3,topics:['scope','boundaries'],markers:{mode:'off'}};configure(source);}});
  f.control.permissions.push('clarification.record');
  const options={...f.common,working:{records:f.localRecords,content:f.localContent}};
  const engine=createNamespaceEngine(options),make=extra=>createNamespaceClarificationEngine({...f.common,localContent:f.localContent,...extra});
  const status=()=>engine.run('clarification.status',{phaseId:'intake'});
  const input=async(operationId='answer-intake',extra={})=>({operationId,workId:f.inputs.workId,phaseId:'intake',contextSha256:(await status()).context.sha256,responses,...extra});
  return {...f,engine,make,status,input};
}
for(const backend of ['filesystem','sqlite','application']) {
  test(backend+': required human replies survive takeover and admit actual publication, submission and independent approval',async t=>{
    const f=await fixture(t,backend),before=await f.head(),initial=await f.status();
    assert.equal(initial.ready,false);assert.equal(initial.record,null);assert.equal(initial.checkpoint.questioningAllowed,true);
    assert.equal(initial.context.manifest.resources[0].kind,'story-source');
    await assert.rejects(f.author('intake',specificationText),{code:'CLARIFICATION_REQUIRED'});
    const request=await f.input(),recorded=await f.engine.run('clarification.record',request);
    assert.equal(recorded.status,'recorded');assert.equal(recorded.completed,true);assert.deepEqual(await f.head(),before,'a reply is not a lifecycle approval or head mutation');
    const retry=await f.make({localContent:null}).run('clarification.record',request);
    assert.equal(retry.replayed,true);assert.equal(retry.recordedAt,recorded.recordedAt);assert.deepEqual(retry.reference,recorded.reference);
    const status=await f.make({localContent:null}).run('clarification.status',{phaseId:'intake'});
    assert.equal(status.ready,true);assert.equal(status.checkpoint.questioningAllowed,false);
    const published=await f.publish().run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
    assert.equal(published.status,'published');const snapshot=await f.capture(),binding=snapshot.workflow.phases.intake.publicationBindings[0];
    const observer=createNamespaceStoryObserver(f.common),reader=createNamespacePublicationReader({observer,scope:f.scope,workId:f.inputs.workId});
    const publication=await reader.accepted(binding,'intake');
    assert.ok(publication.policyEvidence.some(item=>item.kind===CLARIFICATION_EVIDENCE));
    assert.ok(reader.policies.owners(publication).includes('clarification-record'));
    const accepted=await createNamespaceLifecycleReceiptReader(f.common).accepted(publication.operationId);
    assert.equal(accepted.plan.schemaVersion,2);assert.equal(accepted.plan.readBindings.length,1);
    const publishedStatus=await f.status();assert.equal(publishedStatus.status,'published');
    assert.equal(publishedStatus.checkpoint.questioningAllowed,false);assert.deepEqual(publishedStatus.record.reference,recorded.reference);
    assert.equal((await f.publish().run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'})).status,'retained');
    await f.approve('intake');assert.equal((await f.capture()).workflow.currentPhase,'design');
    const resources=await f.reviewer.run('phase.review.resources',{phaseId:'intake'}),resource=resources.manifest.resources.find(item=>item.kind==='clarification-record');
    assert.ok(resource);assert.equal(resource.expected.sha256,recorded.reference.sha256);
    const document=await f.engine.run('document.read',{reference:resource.reference});assert.equal(document.document.integrity,'matched');
  });
  test(backend+': optional absence has v3 conditional acceptance and no fabricated answers',async t=>{
    const f=await fixture(t,backend,'when-needed');assert.equal((await f.status()).ready,true);
    const published=await f.author('intake',specificationText);assert.equal(published.status,'published');
    const snapshot=await f.capture(),binding=snapshot.workflow.phases.intake.publicationBindings[0],reader=createNamespacePublicationReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId});
    const publication=await reader.accepted(binding,'intake'),proof=await createNamespaceLifecycleReceiptReader(f.common).accepted(publication.operationId);
    assert.equal(proof.plan.schemaVersion,3);assert.equal(proof.plan.readBindings[0].version,null);
    const checkpoint=await f.json(publication.policyEvidence.find(item=>item.kind===CLARIFICATION_EVIDENCE).record);
    assert.equal(checkpoint.response,null);assert.equal(Object.hasOwn(checkpoint,'responses'),false);
  });
  test(backend+': conflicting answers need explicit reviewed replacement; pending deferrals remain repairable',async t=>{
    const f=await fixture(t,backend),first=await f.input();await f.engine.run('clarification.record',first);
    const conflict={...first,operationId:'conflicting-reply',responses:[{...responses[0],answer:'A different contract.'}]};
    await assert.rejects(f.engine.run('clarification.record',conflict),{code:'CLARIFICATION_RESPONSE_CONFLICT'});
    const replacement=await f.engine.run('clarification.record',{...conflict,replace:true,reason:'The human explicitly reviewed the revised answer.'});
    assert.equal(replacement.completed,true);
    await f.engine.run('clarification.record',{...first,operationId:'pending-reply',responses:[{question:'Which overflow behavior?',answer:'Owner will confirm the boundary.',status:'deferred',blocking:true}]});
    assert.equal((await f.status()).ready,false);await assert.rejects(f.author('intake',specificationText),{code:'CLARIFICATION_REQUIRED'});
    await f.engine.run('clarification.record',{...first,operationId:'resolved-reply',replace:true,reason:'The human resolved the deferred contract.',responses});
    assert.equal((await f.status()).ready,true);
    assert.equal((await f.publish().run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'})).status,'published');
  });
}
test('checkpoint admission checks permission, exact human authority, original request and actual context',async t=>{
  const f=await fixture(t,'sqlite'),input=await f.input();
  const as=(identity,actorKind='human',permissions=['clarification.record'])=>f.make({access:{current:()=>({projectId:f.scope.projectId,principalId:'other',identity,actorKind,agentId:null,permissions})}});
  await assert.rejects(as({name:'Unknown',email:'unknown@example.test',login:null}).run('clarification.record',input),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});
  await assert.rejects(as(f.control.creator,'service').run('clarification.record',input),{code:'CLARIFICATION_AUTHORITY_REQUIRED'});
  await assert.rejects(as(f.control.creator,'human',[]).run('clarification.record',input),{code:'ENGINE_AUTHORITY_REQUIRED'});
  await assert.rejects(f.engine.run('clarification.record',{...input,contextSha256:'f'.repeat(64)}),{code:'CLARIFICATION_RECORD_BINDING_MISMATCH'});
  await assert.rejects(f.engine.run('clarification.record',{...input,responses:[{id:{text:'Q-001'},question:'Scope?',answer:'The human scope.'}]}),{code:'ENGINE_INPUT_INVALID'});
  await f.engine.run('clarification.record',input);
  await assert.rejects(f.engine.run('clarification.record',{...input,responses:[{question:'Different?',answer:'Different.'}]}),{code:'ENGINE_OPERATION_ID_REUSED'});
  const receipt=await as({...f.control.creator},'human',[]).run('clarification.record',input).catch(error=>error);
  assert.equal(receipt.code,'ENGINE_ACTOR_CHANGED','a different principal cannot claim the original reply');
});

test('exact answers from a new invocation reuse the accepted record without a new clock or question IDs',async t=>{
  const f=await fixture(t,'filesystem'),first=await f.input();const recorded=await f.engine.run('clarification.record',first);
  const noClock=f.make({clock:{now(){throw Error('Identical human answers must not be restamped.');}}});
  const reused=await noClock.run('clarification.record',{...first,operationId:'retry-same-human-answers'});
  assert.equal(reused.replayed,true);assert.equal(reused.originalOperationId,first.operationId);
  assert.deepEqual(reused.reference,recorded.reference);assert.deepEqual(reused.responses.map(item=>item.id),['Q-001']);
});

test('lost clarification acknowledgement retains original bytes and timeout details for a later takeover',async t=>{
  const f=await fixture(t,'sqlite'),input=await f.input(),failure=Object.assign(Error('Clarification acknowledgement timed out.'),{code:'ETIMEDOUT',timeoutMs:300000});let lost=false;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(!lost&&tx.operationId.startsWith('clarification-')){lost=true;throw failure;}return result;}};
  await assert.rejects(f.make({records}).run('clarification.record',input),cause=>cause===failure);
  assert.equal(lost,true);const restored=await f.make({clock:{now(){throw Error('An accepted answer cannot be restamped.');}}}).run('clarification.record',input);
  assert.equal(restored.replayed,true);assert.equal((await f.status()).ready,true);
  for(const issue of [Object.assign(Error('Evidence permission denied.'),{code:'EACCES',path:'content.db'}),Object.assign(Error('Evidence unavailable.'),{code:'ETIMEDOUT',timeoutMs:300000})]) {
    const content={...f.content,read(scope,reference,options){if(reference.sha256===restored.reference.sha256)throw issue;return f.content.read(scope,reference,options);}};
    await assert.rejects(f.make({content}).run('clarification.status',{phaseId:'intake'}),cause=>cause===issue);
  }
});

test('a clarification racing publication preserves the old candidate and retries with a new current checkpoint',async t=>{
  const f=await fixture(t,'filesystem','when-needed');
  await f.engine.run('phase.prepare',{phaseId:'intake'});const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'author-race-draft',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(specificationText),reason:'Complete the preserved artifact before the independent answer arrives.'});
  const request=await f.input('arriving-answer');let raced=false;
  const records={...f.records,async transact(scope,tx,options){
    if(!raced&&tx.operationId.startsWith('lifecycle-')){raced=true;await f.engine.run('clarification.record',request);}
    return f.records.transact(scope,tx,options);
  }};
  await assert.rejects(f.publish({records}).run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),{code:'SDA_NAMESPACE_REVISION_CONFLICT'});
  assert.equal(raced,true);assert.equal((await f.capture()).workflow.phases.intake.generation,0);
  const repaired=await f.publish().run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  assert.equal(repaired.status,'published');const snapshot=await f.capture(),published=await f.json(snapshot.workflow.phases.intake.publicationBindings[0].record),
    proof=await createNamespaceLifecycleReceiptReader(f.common).accepted(published.operationId);
  assert.equal(proof.plan.schemaVersion,2);assert.notEqual(proof.plan.readBindings[0].version,null);
});

test('recording permission is rechecked before acceptance, and question budgets are phase-wide',async t=>{
  const f=await fixture(t,'sqlite'),input=await f.input();let calls=0;
  const access={async current(request){const facts=await f.access.current(request);if(request.operation==='clarification.record'&&++calls===2)facts.permissions=[];return facts;}};
  await assert.rejects(f.make({access}).run('clarification.record',input),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.equal((await f.status()).record,null);
  await f.engine.run('clarification.record',input);
  const extra=[1,2,3].map(value=>({question:'Additional question '+value,answer:'Human answer '+value}));
  await assert.rejects(f.engine.run('clarification.record',{...input,operationId:'too-many-questions',responses:extra}),cause=>cause.message.includes('no more than 3'));
  assert.deepEqual((await f.status()).record.responses.map(item=>item.id),['Q-001']);
});

test('a recorded answer does not hide a marker that remains in the authored specification',async t=>{
  const f=await fixture(t,'filesystem','required',source=>{
    source.definition.phases.intake.specificationQuality={mode:'warn'};
    source.definition.phases.intake.clarification.markers={mode:'block'};
  });
  const marker='What is the maximum input?',input=await f.input('resolve-boundary',{responses:[{question:marker,answer:'Accept non-negative safe integers.',marker}]});
  await f.engine.run('clarification.record',input);
  await assert.rejects(f.author('intake',specificationText+'\n[NEEDS CLARIFICATION: '+marker+']\n'),{code:'ARTIFACT_AUTHORING_INCOMPLETE'});
  await f.author('intake',specificationText+'\nThe confirmed maximum input is Number.MAX_SAFE_INTEGER.\n');
  const snapshot=await f.capture(),published=await f.json(snapshot.workflow.phases.intake.publicationBindings[0].record),analysis=published.policyEvidence.find(item=>item.kind==='specification-analysis/v1'),
    manifest=await f.json(analysis.record),report=await f.json(manifest.report);
  assert.equal(report.markers.open.length,0);assert.equal(report.markers.resolved.length,0);
  assert.equal((await createNamespacePublicationReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId}).accepted(snapshot.workflow.phases.intake.publicationBindings[0],'intake')).generation,1);
});

test('a real routed successor resolves its previous marker only with the accepted human answer',async t=>{
  const f=await fixture(t,'filesystem','when-needed',source=>{
    source.definition.phases.intake.specificationQuality={mode:'warn'};source.definition.phases.intake.clarification.markers={mode:'warn'};
    source.definition.workTypes.simple.decisions=[{id:'quality',label:'Quality review',kind:'loop',after:'design',
      inputs:[{name:'verdict',values:['Pass','Repair']}],goal:{verdict:'Pass'},back:'intake',maxRounds:1}];
  });
  const marker='What is the maximum input?';
  await f.author('intake',specificationText+'\n[NEEDS CLARIFICATION: '+marker+']\n');await f.approve('intake');
  await f.author('design',planText);await f.approve('design',undefined,{verdict:'Repair'});
  assert.equal((await f.capture()).workflow.currentPhase,'intake');
  assert.equal((await f.status()).checkpoint.questioningAllowed,true,'an explicitly reopened generation can assess its own input questions');
  const request=await f.input('answer-successor',{responses:[{question:marker,answer:'Accept non-negative safe integers.',marker}]});
  const reply=await f.engine.run('clarification.record',request);assert.equal(reply.generation,2);
  try{await f.engine.run('phase.prepare',{phaseId:'intake'});}catch(cause){
    assert.equal(cause.code,'ENGINE_DRAFT_BASIS_CHANGED');
    await f.engine.run('phase.draft.rebase',{operationId:'retain-reworked-draft',workId:f.inputs.workId,phaseId:'intake',
      expectedRevision:cause.details.revision,confirm:cause.details.confirm,reason:'Review and retain the existing document for the successor.'});
  }
  await f.author('intake',specificationText+'\nThe confirmed maximum input is Number.MAX_SAFE_INTEGER.\n');
  const snapshot=await f.capture(),binding=snapshot.workflow.phases.intake.publicationBindings.find(item=>item.generation===2),published=await f.json(binding.record),
    manifest=await f.json(published.policyEvidence.find(item=>item.kind==='specification-analysis/v1').record),report=await f.json(manifest.report);
  assert.equal(report.markers.open.length,0);assert.equal(report.markers.vanished.length,0);assert.equal(report.markers.resolved[0].question,marker);
  assert.equal((await createNamespacePublicationReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId}).accepted(binding,'intake')).generation,2);
});

test('a human responder can use the issued author hint without becoming the phase author',async t=>{
  const f=await fixture(t,'sqlite','required');
  const status=await f.status();assert.equal(status.context.manifest.agentId,'analyst');
  const person={name:'Independent reviewer',email:'independent@example.test',login:null};
  const engine=f.make({access:{current:()=>({projectId:f.scope.projectId,principalId:'human-responder',actorKind:'human',identity:person,agentId:null,permissions:['clarification.record']})}});
  const request={...await f.input(),agentId:status.context.manifest.agentId};
  const reply=await engine.run('clarification.record',request);assert.equal(reply.actor.principalId,'human-responder');
  assert.equal((await f.status()).record.actor.principalId,'human-responder');assert.equal((await f.capture()).workflow.phases.intake.generation,0);
});

test('required conversational replies apply to the governed-agent route without inventing replies for human publication',async t=>{
  const f=await fixture(t,'filesystem');
  await f.engine.run('phase.prepare',{phaseId:'intake'});const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'human-artifact',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(specificationText),reason:'Retain the actual document authored for human publication.'});
  const published=await f.publish().run('phase.publish',{phaseId:'intake',authored:'human'});assert.equal(published.status,'published');
  const status=await f.status();assert.equal(status.status,'published');assert.equal(status.record,null);assert.equal(status.checkpoint.questioningAllowed,false);
});

test('a legitimate source-binding change keeps original replies and issues an explicit reviewed rebind route',async t=>{
  const f=await fixture(t,'filesystem'),first=await f.input(),accepted=await f.engine.run('clarification.record',first);
  const root=path.join(f.directory,'clarification-source');await mkdir(root);await writeFile(path.join(root,'app.js'),'export const answer = 255;\n');
  const unit=await createFilesystemSourceUnit({root,id:'clarification-source',projectId:f.scope.projectId,repositoryId:'app'}),engine=createNamespaceEngine({...f.common,sources:[unit]}),
    snapshot=await f.capture();
  await engine.run('source.bind',{operationId:'select-actual-source',workId:f.inputs.workId,expectedRevision:snapshot.revision,repositories:['app'],reason:'Review the actual source binding for this specification.'});
  const status=await f.status();assert.equal(status.ready,false);assert.equal(status.checkpoint.stage,'inspect-binding');
  assert.equal(status.checkpoint.questioningAllowed,false);assert.equal(status.record.contextSha256,accepted.contextSha256);
  assert.notEqual(status.context.sha256,status.record.contextSha256);assert.equal(status.actions[0].inputs.replace,true);
  const changed=await f.input('reviewed-source-answers');
  await assert.rejects(f.engine.run('clarification.record',changed),cause=>cause.code==='CLARIFICATION_RECORD_BINDING_MISMATCH'&&cause.details.replace===true);
  await f.engine.run('clarification.record',{...changed,replace:true,reason:'The human reviewed the new source binding and retained the confirmed scope.'});
  assert.equal((await f.status()).ready,true);
  assert.deepEqual((await f.make().run('clarification.record',first)).reference,accepted.reference,'an old acknowledgement remains its historical fact');
});
