import test from 'node:test';
import assert from 'node:assert/strict';
import {namespaceSpecificationFixture,specificationText,planText} from './helpers/namespace-specification-fixture.mjs';
import {namespacePreparationFixture} from './helpers/namespace-preparation-fixture.mjs';
import {STARTER_CHECKLIST} from '../src/engine-compatibility/node-specification-policy.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePublicationReader} from '../src/engine-storage/namespace-publication-reader.mjs';
import {createNamespacePublicationEngine} from '../src/engine-storage/namespace-publication.mjs';
import {createNamespaceSubmissionEngine} from '../src/engine-storage/namespace-submission.mjs';
import {createNamespaceSubmissionReader} from '../src/engine-storage/namespace-submission-reader.mjs';
import {createNamespaceApprovalReader} from '../src/engine-storage/namespace-approval-reader.mjs';
import {createNamespaceApprovalEngine} from '../src/engine-storage/namespace-approval.mjs';
import {createNamespaceLifecycleCommitter} from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import {canonicalJson,PHASE_PUBLICATION_SCHEMAS,NAMESPACE_PHASE_POLICY_SCHEMAS} from '../src/foundation/record-schema.mjs';

const fullText=specificationText.replace('## Requirements','## Actors\n\nCalculator user.\n\n## User scenarios\n\n### S1 — Convert a value\n\nGiven input 255, When conversion is requested, Then the result is FF.\n\n## Requirements');
const answers=STARTER_CHECKLIST.articles.map(article=>({article:article.id,decision:'satisfied'}));
const enforce=source=>{source.definition.phases.intake.specificationQuality={mode:'enforce'};};
const publicationReader=(f,options={})=>createNamespacePublicationReader({scope:f.scope,workId:f.inputs.workId,
  observer:createNamespaceStoryObserver({...f.common,...options})});
const save=(f,value)=>f.content.put(f.scope,'evidence',Buffer.from(canonicalJson(value))).then(result=>result.reference);
async function retained(f) {
  const snapshot=await f.capture(),binding=snapshot.workflow.phases.intake.publicationBindings[0],publication=await f.json(binding.record),
    policy=publication.policyEvidence[0],manifest=await f.json(policy.record),report=await f.json(manifest.report);
  return {snapshot,binding,publication,policy,manifest,report};
}
async function approvalInput(f,phaseId='intake') {
  const {manifest}=await f.reviewer.run('phase.review',{phaseId}),binding=manifest.reviewBinding;
  return {phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}};
}

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: actual analysis and independent checklist survive publication, approval and downstream planning`,async t=>{
  const f=await namespaceSpecificationFixture(t,{backend,configure:enforce});
  await f.author('intake',backend==='filesystem'?'\ufeff'+fullText:fullText);
  const current=await retained(f);
  assert.equal(current.publication.schemaVersion,4);assert.equal(current.publication.profile,'sflow-policy-publication/v1');
  assert.equal(current.policy.kind,'specification-analysis/v1');assert.equal(current.report.findings.length,0);
  assert.equal(current.report.binding.artifactSha256,current.publication.artifact.content.sha256);
  assert.equal(current.manifest.recordedAt,current.publication.publishedAt);assert.equal(current.manifest.previous,null);
  const resource=(await f.engine.run('document.read',{reference:{kind:'story-document',workId:f.inputs.workId,id:'ANALYSIS-intake-GEN-1'}})).document;
  assert.deepEqual(JSON.parse(resource.content.text),current.report);
  // No checklist answers are fabricated by publication or submission.
  const before=await f.head();let missing;
  await assert.rejects(f.approve('intake'),error=>{missing=error;return error.code==='APPROVAL_CHECKLIST_INCOMPLETE';});
  assert.equal(missing.details.articles.length,6);assert.equal(missing.details.actions[0].operation,'phase.approve');
  assert.equal((await f.capture()).workflow.phases.intake.status,'awaiting_approval');
  const submitted=await f.head(),input=await approvalInput(f);
  const review=await f.reviewer.run('phase.review.resources',{phaseId:'intake'}),analysis=review.manifest.resources.find(item=>item.kind==='specification-analysis');
  assert.ok(analysis);assert.equal(analysis.expected.sha256,current.manifest.report.sha256);
  assert.deepEqual(JSON.parse((await f.reviewer.run('document.read',{reference:analysis.reference})).document.content.text),current.report);
  await assert.rejects(f.reviewer.run('phase.approve',input),{code:'APPROVAL_CHECKLIST_INCOMPLETE'});
  assert.deepEqual(await f.head(),submitted,'missing answers do not mutate the submitted Story');assert.notDeepEqual(submitted,before);
  const result=await f.reviewer.run('phase.approve',{...input,checklist:answers});
  assert.equal(result.approval.selfApproval,false);assert.equal(result.currentPhase,'design');
  const accepted=await f.capture(),decision=accepted.workflow.phases.intake.approvals[0],vote=await f.json(decision.namespaceVote.record),set=await f.json(vote.artifactSet);
  assert.equal(vote.schemaVersion,1,'the original ordinary vote envelope stays v1');assert.equal(set.schemaVersion,2);
  assert.deepEqual(set.policyChecklist.evidence,current.policy);assert.deepEqual(set.policyChecklist.result.decisions,answers);
  assert.equal(set.policyChecklist.result.required,true);assert.equal(set.policyChecklist.result.errors.length,0);
  const reader=publicationReader(f),value=await reader.accepted(current.binding,'intake'),plan=await createNamespaceLifecycleCommitter(f.common).intent(value.operationId);
  assert.deepEqual(reader.policies.owners(value),['specification-analysis']);
  assert.doesNotThrow(()=>reader.verifyPlan(value,plan));
  for(const reference of [current.policy.record,current.manifest.report])assert.throws(()=>reader.verifyPlan(value,{...plan,evidence:plan.evidence.filter(item=>item.sha256!==reference.sha256)}),{code:'ENGINE_STORAGE_CORRUPT'});
  value.actor.principalId='invented-author';assert.deepEqual(reader.policies.owners(value),[]);
  await f.author('design',planText);assert.equal((await f.approve('design')).currentPhase,'build');
  const retry=await f.reviewer.run('phase.approve',{...input,checklist:answers});assert.equal(retry.approval.selfApproval,false);
  await assert.rejects(f.reviewer.run('phase.approve',{...input,checklist:answers.map(answer=>({...answer,reason:'Changed after acceptance.'}))}),{code:'ENGINE_OPERATION_ID_REUSED'});
});

test('enforced quality defects and unresolved markers offer author repairs without recording publication',async t=>{
  for(const [configure,text,kind] of [[enforce,specificationText,'missing-required-section'],[
    source=>{enforce(source);source.definition.phases.intake.clarification.markers.mode='block';},fullText+'\n[NEEDS CLARIFICATION: What is the upper bound?]\n','unresolved-clarification']]) {
    const f=await namespaceSpecificationFixture(t,{configure});let finding;
    await assert.rejects(f.author('intake',text),error=>{finding=error;return error.code==='ARTIFACT_AUTHORING_INCOMPLETE';});
    assert.ok(finding.details.findings.some(item=>item.kind===kind));assert.equal(finding.details.operation,'phase.draft.write');
    const state=await f.capture();assert.equal(state.workflow.phases.intake.generation,0);assert.deepEqual(state.workflow.phases.intake.approvals,[]);
    assert.equal((await f.author('intake',fullText)).status,'published','repair uses the existing Story and actual draft');
  }
});

test('an arbitrary reviewed-document phase can retain analysis without inventing specification claims or execution',async t=>{
  const f=await namespacePreparationFixture(t,{configure:source=>{source.definition.phases.intake.specificationQuality={mode:'enforce'};}});
  f.control.permissions.push('phase.publish','phase.submit');await f.engine.run('phase.prepare',{phaseId:'intake'});
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'author-reviewed-document',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload('# Review\n\n## Actors\n\nReviewer.\n\n## User scenarios\n\nInspect an observation.\n\n## Requirements\n\nRetain the observation and its limitations.\n'),reason:'Complete the configured review document.'});
  const common={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock};
  await createNamespacePublicationEngine({...common,localRecords:f.localRecords,localContent:f.localContent}).run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  const observer=createNamespaceStoryObserver(common),snapshot=(await observer.inspect()).snapshot,binding=snapshot.workflow.phases.intake.publicationBindings[0],
    published=await createNamespacePublicationReader({observer,scope:f.scope,workId:f.inputs.workId}).accepted(binding,'intake');
  assert.equal(published.specifications,null);assert.equal(published.checks,null);assert.equal(published.profile,'sflow-policy-publication/v1');
  assert.equal((await createNamespaceSubmissionEngine(common).run('phase.submit',{phaseId:'intake'})).status,'awaiting-approval');
});

test('advisory quality retains disclosed findings without claiming completeness or bypassing human authority',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:source=>{source.definition.phases.intake.specificationQuality.mode='warn';}});
  await f.author('intake',specificationText);const current=await retained(f);
  assert.ok(current.report.findings.some(finding=>finding.kind==='missing-required-section'));
  assert.match(current.report.disclaimer,/no claim.*complete/u);assert.equal(Object.hasOwn(current.report,'approved'),false);
  await f.approve('intake');const snapshot=await f.capture(),vote=await f.json(snapshot.workflow.phases.intake.approvals[0].namespaceVote.record),set=await f.json(vote.artifactSet);
  assert.equal(set.policyChecklist.result.required,false);assert.equal(set.policyChecklist.result.warnings.length,6);
  assert.deepEqual(set.policyChecklist.result.decisions,[]);
});

test('a real approved rework retains the previous generation and cannot treat a deleted question as answered',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:source=>{
    source.definition.phases.intake.specificationQuality.mode='warn';source.definition.phases.intake.clarification.markers.mode='warn';
    source.definition.phases.design.specificationQuality.mode='enforce';
    source.definition.workTypes.simple.decisions=[{id:'quality',label:'Quality review',kind:'loop',after:'design',
      inputs:[{name:'verdict',values:['Pass','Repair']}],goal:{verdict:'Pass'},back:'intake',maxRounds:1}];
  }});
  await f.author('intake',fullText+'\n[NEEDS CLARIFICATION: What is the upper bound?]\n');const first=await retained(f);
  await f.approve('intake');await f.author('design','## Actors\n\nDeveloper.\n\n## User scenarios\n\nImplement the converter.\n\n## Requirements\n\nUse the approved requirements.\n\n'+planText);
  await createNamespaceSubmissionEngine(f.common).run('phase.submit',{phaseId:'design',decisionValues:{verdict:'Repair'}});
  const input=await approvalInput(f,'design'),approved=await f.reviewer.run('phase.approve',{...input,checklist:answers});
  assert.equal((await f.capture()).workflow.currentPhase,'intake');
  assert.deepEqual(await f.reviewer.run('phase.approve',{...input,checklist:answers}),approved);
  await assert.rejects(f.reviewer.run('phase.approve',{...input,checklist:answers.map(answer=>({...answer,reason:'A later replacement.'}))}),{code:'ENGINE_OPERATION_ID_REUSED'});
  try{await f.engine.run('phase.prepare',{phaseId:'intake'});}catch(error) {
    assert.equal(error.code,'ENGINE_DRAFT_BASIS_CHANGED');
    await f.engine.run('phase.draft.rebase',{operationId:'rebase-actual-specification',workId:f.inputs.workId,phaseId:'intake',
      expectedRevision:error.details.revision,confirm:error.details.confirm,reason:'Retain the actual reviewed draft for its successor generation.'});
  }
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'author-actual-successor',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:draft.manifest.draft.revision,content:await f.upload(fullText),reason:'Keep the authored requirements and disclose the unanswered removed marker.'});
  await f.publish().run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});
  const successorSnapshot=await f.capture(),binding=successorSnapshot.workflow.phases.intake.publicationBindings.find(item=>item.generation===2),
    publication=await f.json(binding.record),manifest=await f.json(publication.policyEvidence[0].record),report=await f.json(manifest.report);
  assert.deepEqual(manifest.previous,first.binding);assert.equal(report.markers.open.length,0);assert.equal(report.markers.resolved.length,0);
  assert.equal(report.markers.vanished[0].question,'What is the upper bound?');
  assert.ok(report.findings.some(item=>item.kind==='clarification-removed-unanswered'));
  assert.equal((await publicationReader(f).accepted(binding,'intake')).generation,2);
});

test('a checklist cannot grant self-approval or narrower exception authority',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:source=>{
    enforce(source);source.definition.approvalAuthorities.architects={members:[{email:'architect@example.test'}]};
    source.definition.phases.intake.specificationQuality.exceptionAuthority='architects';
  }});
  await f.author('intake',fullText);await assert.rejects(f.approve('intake'),{code:'APPROVAL_CHECKLIST_INCOMPLETE'});
  const input=await approvalInput(f),author=createNamespaceApprovalEngine(f.common);
  for(const checklist of [[null],[{article:'completeness',decision:true}],[{article:'completeness',decision:'satisfied',ready:true}]]) {
    await assert.rejects(f.reviewer.run('phase.approve',{...input,checklist}),error=>error.code==='ENGINE_INPUT_INVALID'&&error.details.field==='checklist');
  }
  await assert.rejects(author.run('phase.approve',{...input,checklist:answers}),{code:'APPROVAL_SELF_APPROVAL_PROHIBITED'});
  const exception=answers.map((answer,index)=>index===0?{...answer,decision:'exception',reason:'The supported scope is deliberately limited.'}:answer);
  await assert.rejects(f.reviewer.run('phase.approve',{...input,checklist:exception}),error=>error.code==='APPROVAL_CHECKLIST_INCOMPLETE'&&error.details.errors.some(message=>message.includes('architects')));
  assert.equal((await f.capture()).workflow.phases.intake.approvals.length,0);
  assert.equal((await f.reviewer.run('phase.approve',{...input,checklist:answers})).currentPhase,'design');
});

test('stored analysis cannot be changed, reanchored, or promoted by new hashes or caller readiness flags',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:enforce});await f.author('intake',fullText);const current=await retained(f);
  const changedReport={...current.report,disclaimer:'Verified complete and approved.'};
  for(const manifest of [{...current.manifest,report:await save(f,changedReport)},
    {...current.manifest,artifact:{...current.manifest.artifact,key:'artifacts/intake/other.md'}},
    {...current.manifest,actor:{...current.manifest.actor,principalId:'someone-else'}}]) {
    const publication={...current.publication,policyEvidence:[{...current.policy,record:await save(f,manifest)}]},binding={...current.binding,record:await save(f,publication)};
    await assert.rejects(publicationReader(f).read(binding,'intake',{ready:true}),{code:'ENGINE_STORAGE_CORRUPT'});
  }
  const r=publicationReader(f),value=await r.read(current.binding,'intake');
  assert.deepEqual(r.policies.owners({...value}),[],'private verification cannot be copied to a lookalike value');
  assert.deepEqual((await retained(f)).binding,current.binding);
});

test('an asynchronous input mutation cannot acquire policy proof under the changed publication identity',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:enforce});await f.author('intake',fullText);const current=await retained(f),
    value=await publicationReader(f).read(current.binding,'intake');let changed=false;
  const content={...f.content,async read(scope,reference,options){const result=await f.content.read(scope,reference,options);
    if(!changed&&reference.sha256===current.manifest.report.sha256){changed=true;value.actor.principalId='changed-during-read';}return result;}};
  const r=publicationReader(f,{content});
  await assert.rejects(r.policies.verify(value),{code:'ENGINE_CONTEXT_CHANGED'});assert.equal(changed,true);assert.deepEqual(r.policies.owners(value),[]);
});

test('future policy bindings, reports and manifests remain unsupported; missing bytes and real I/O failures retain identity',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:enforce});await f.author('intake',fullText);const current=await retained(f);
  const variants=[{...current.policy,kind:'future-policy/v1'},
    {...current.policy,schemaVersion:NAMESPACE_PHASE_POLICY_SCHEMAS.binding.maximumReadableVersion+1},
    {...current.policy,record:await save(f,{...current.manifest,schemaVersion:NAMESPACE_PHASE_POLICY_SCHEMAS.analysis.maximumReadableVersion+1})},
    {...current.policy,record:await save(f,{...current.manifest,report:await save(f,{...current.report,schemaVersion:2})})}];
  for(const policy of variants) {
    const binding={...current.binding,record:await save(f,{...current.publication,policyEvidence:[policy]})};
    await assert.rejects(publicationReader(f).read(binding,'intake'),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  }
  assert.equal(PHASE_PUBLICATION_SCHEMAS.manifest.currentVersion,5);
  for(const failure of [Object.assign(new Error('Analysis permission denied.'),{code:'EACCES',path:'content.db'}),
    Object.assign(new Error('Analysis timed out.'),{code:'ETIMEDOUT',timeoutMs:300000})]) {
    const content={...f.content,read(scope,reference,options){if(reference.sha256===current.manifest.report.sha256)throw failure;return f.content.read(scope,reference,options);}};
    await assert.rejects(publicationReader(f,{content}).accepted(current.binding,'intake'),error=>error===failure);
  }
  const missing={...f.content,read(scope,reference,options){return reference.sha256===current.manifest.report.sha256
    ?{status:'missing',reference,data:null}:f.content.read(scope,reference,options);}};
  await assert.rejects(publicationReader(f,{content:missing}).accepted(current.binding,'intake'),error=>error.code==='ENGINE_STORAGE_CONTENT_MISSING'&&error.details.reference.sha256===current.manifest.report.sha256);
  const duplicate={...current.binding,record:await save(f,{...current.publication,policyEvidence:[current.policy,current.policy]})};
  await assert.rejects(publicationReader(f).read(duplicate,'intake'),{code:'ENGINE_STORAGE_CORRUPT'});
});

test('human checklist replay binds the exact submitted report, original reasons and accepted evidence',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:enforce});await f.author('intake',fullText);await f.approve('intake',answers);
  const snapshot=await f.capture(),decision=snapshot.workflow.phases.intake.approvals[0],vote=await f.json(decision.namespaceVote.record),set=await f.json(vote.artifactSet),
    observer=createNamespaceStoryObserver(f.common),packets=createNamespaceSubmissionReader({observer,scope:f.scope,workId:f.inputs.workId}),
    proof=await packets.inspect(snapshot,'intake'),reader=createNamespaceApprovalReader({observer,scope:f.scope,workId:f.inputs.workId});
  const accepted=await reader.readAccepted(decision.namespaceVote,'intake',proof);
  assert.ok(reader.evidence(accepted).length>=2);
  const forged={...set,policyChecklist:{...set.policyChecklist,result:{...set.policyChecklist.result,decisions:[],required:false}}},
    changed={...vote,artifactSet:await save(f,forged)},binding={...decision.namespaceVote,record:await save(f,changed)};
  await assert.rejects(reader.read(binding,'intake',proof),{code:'ENGINE_STORAGE_CORRUPT'});
  const altered={...set,policyChecklist:{...set.policyChecklist,result:{...set.policyChecklist.result,decisions:answers.map(answer=>({...answer,reason:'An invented later reason.'}))}}},
    alteredVote={...vote,artifactSet:await save(f,altered)},alteredBinding={...decision.namespaceVote,record:await save(f,alteredVote)};
  await assert.rejects(reader.readAccepted(alteredBinding,'intake',proof),{code:'ENGINE_STORAGE_CORRUPT'});
  accepted.actor.principalId='changed-after-reading';assert.deepEqual(reader.evidence(accepted),[]);
});
