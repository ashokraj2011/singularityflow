import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {namespaceSpecificationFixture,specificationText,planText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespacePublicationReader} from '../src/engine-storage/namespace-publication-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {namespacePublicationValue} from '../src/engine-storage/namespace-publication-contract.mjs';
import {namespacePublicationRecordProfile,PHASE_PUBLICATION_SCHEMAS,NAMESPACE_SPECIFICATION_SCHEMAS,canonicalJson} from '../src/foundation/record-schema.mjs';
import {profileForCommand,profileCeiling,profileIsExact} from '../src/verification/profiles.mjs';
import {commandCovering} from '../src/verification/adapters.mjs';
import {plannedClaimContractFindings} from '../src/kernel/specification-values.mjs';
import {createNamespaceLifecycleCommitter} from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import {namespacePhaseCheckFixture} from './helpers/namespace-phase-check-fixture.mjs';
import {createNamespacePublicationEngine} from '../src/engine-storage/namespace-publication.mjs';
import {verificationContractPolicies} from '../src/kernel/verification-policy.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';

const publishInput={phaseId:'intake',authored:'governed-agent',channel:'copilot-host'};
async function record(f,phaseId='intake') {
  const snapshot=await f.capture(),binding=snapshot.workflow.phases[phaseId].publicationBindings[0],publication=await f.json(binding.record),
    evidence=await f.json(publication.specifications.record);
  return {snapshot,binding,publication,evidence};
}
function reader(f,overrides={}) {return createNamespacePublicationReader({scope:f.scope,workId:f.inputs.workId,
  observer:createNamespaceStoryObserver({...f.common,...overrides})});}

test('adapter profiles and most-specific command selection preserve the independently captured native values',async()=>{
  const oracle=JSON.parse(await readFile(new URL('./fixtures/namespace-specification-policy/native-planning-v1.json',import.meta.url)));
  assert.equal(oracle.capturedAtCommit,'5cd644f1f');assert.equal(oracle.cases.length,28);
  for(const entry of oracle.cases) {
    const profile=profileForCommand(entry.command);assert.equal(profile,entry.profile);
    assert.equal(profileCeiling(profile),entry.ceiling);assert.equal(profileIsExact(profile),entry.exact);
  }
  for(const entry of oracle.rootCases)assert.equal(commandCovering(entry.commands,entry.candidate)?.id??null,entry.selected);
  assert.deepEqual(Object.keys(verificationContractPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS)),[
    'proseVerificationDeclarations','validateRetainedEvidenceDeclarations','parseVerificationContracts','normalizeVerificationContracts',
    'mergedVerificationContracts','effectiveContract','contractRequiresTestTag','testSlotFor','contractSha256','witnessMappingCore','witnessMappingSha256']);
});

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: scope and plan retain exact shared records and independent human approval`,async t=>{
  const text=backend==='filesystem'?'\ufeff'+specificationText:specificationText;
  const f=await namespaceSpecificationFixture(t,{backend}),published=await f.author('intake',text),scope=await record(f);
  assert.equal(published.status,'published');assert.equal(scope.publication.schemaVersion,3);
  assert.equal(scope.publication.profile,'sflow-specification-publication/v1');assert.equal(scope.publication.checks,null);
  const index=await f.json(scope.evidence.index);
  assert.deepEqual(index.clauses.map(clause=>clause.id),['STORY-1:REQ-001','STORY-1:AC-001']);
  assert.equal(index.source.sha256,scope.publication.artifact.content.sha256);assert.equal(index.source.bytes,Buffer.byteLength(text));
  assert.equal(scope.evidence.planned,null);assert.deepEqual(scope.evidence.inputs,[]);assert.equal(scope.evidence.recordedAt,scope.publication.publishedAt);
  const approved=await f.approve('intake');assert.equal(approved.currentPhase,'design');assert.equal(approved.approval.selfApproval,false);
  await f.author('design',planText);const plan=await record(f,'design'),claims=await f.json(plan.evidence.planned);
  assert.equal(plan.evidence.index,null);assert.equal(claims.schemaVersion,2);assert.equal(claims.workId,f.inputs.workId);assert.equal(claims.generation,1);
  assert.deepEqual(Object.keys(claims.claims),['STORY-1:AC-001','STORY-1:REQ-001']);
  assert.equal(claims.recordedAt,plan.publication.publishedAt);assert.deepEqual(claims.claims['STORY-1:REQ-001'].tests,['test/converter.test.js']);
  assert.deepEqual(plan.evidence.inputs,[{phase:'intake',generation:1,publication:scope.binding}]);
  assert.equal(plan.evidence.capabilities.status,'declared');assert.equal(plan.evidence.capabilities.launcherObservation,'not-observed');
  assert.equal((await f.approve('design')).currentPhase,'build');
  const verified=await reader(f).accepted(plan.binding,'design');assert.equal(verified.operationId,plan.publication.operationId);
  assert.deepEqual((await f.capture()).workflow.phases.build.checks,[],'a planned command is not passing test evidence');
});

test('publication v1/v2 stay strict and the specification profile is a separately versioned contract',async t=>{
  assert.deepEqual(namespacePublicationRecordProfile({schemaVersion:1}),{version:1,format:'sflow-namespace-phase-publication/v1',profile:'sflow-primary-document-publication/v1',checks:false});
  assert.deepEqual(namespacePublicationRecordProfile({schemaVersion:2}),{version:2,format:'sflow-namespace-phase-publication/v2',profile:'sflow-primary-document-publication/v2',checks:true});
  assert.equal(NAMESPACE_SPECIFICATION_SCHEMAS.manifest.currentVersion,1);
  const f=await namespaceSpecificationFixture(t);await f.author('intake',specificationText);const {publication}=await record(f),context={projectId:f.scope.projectId,workId:f.inputs.workId,phaseId:'intake'};
  for(const version of [1,2])assert.throws(()=>namespacePublicationValue({...publication,schemaVersion:version,
    format:'sflow-namespace-phase-publication/v'+version,profile:'sflow-primary-document-publication/v'+version},context),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.throws(()=>namespacePublicationValue({...publication,schemaVersion:PHASE_PUBLICATION_SCHEMAS.manifest.maximumReadableVersion+1},context),{code:'ENGINE_STORAGE_UNSUPPORTED'});
});

test('accepted specification retries preserve the original index and timestamp without a new clock or approval',async t=>{
  const f=await namespaceSpecificationFixture(t);await f.author('intake',specificationText);const before=await f.head(),original=await record(f);
  const result=await f.publish({clock:{now(){throw Error('Do not restamp the original specification.');}}}).run('phase.publish',publishInput);
  assert.equal(result.status,'retained');assert.deepEqual(await f.head(),before);assert.deepEqual((await record(f)).publication,original.publication);
  assert.deepEqual((await f.capture()).workflow.phases.intake.approvals,[]);
});

test('later definitions cannot silently replace an approved clause or enter a plan without exact test bindings',async t=>{
  const f=await namespaceSpecificationFixture(t);await f.author('intake',specificationText);await f.approve('intake');const before=await f.head();
  await assert.rejects(f.author('design',planText.replace('`test/converter.test.js`','-')),{code:'SPEC_PLANNED_TEST_BINDING_REQUIRED'});
  // Preparing a private generation legitimately changes its canonical preparation binding, never publication.
  assert.equal((await f.capture()).workflow.phases.design.generation,0);assert.equal((await f.capture()).workflow.phases.intake.status,'approved');
  assert.ok(before.record.version);
  const duplicate=await namespaceSpecificationFixture(t,{configure:source=>{
    source.definition.phases.design.artifact.kind='implementation-spec';source.definition.workTypes.simple.plannedClaims.clausePhases.push('design');
  }});
  await duplicate.author('intake',specificationText);await duplicate.approve('intake');
  await assert.rejects(duplicate.author('design',specificationText+'\n'+planText),{code:'SPEC_CLAUSE_REDEFINED'});
  assert.equal((await duplicate.capture()).workflow.phases.design.generation,0);
});

test('an enforced definition needs stable anchors and an unselected artifact kind cannot enlarge the approved clause universe',async t=>{
  const empty=await namespaceSpecificationFixture(t);
  await assert.rejects(empty.author('intake','# Specification\n\nConvert an integer and retain its tests.'),error=>error.message.includes('requires stable clause anchors'));
  assert.equal((await empty.capture()).workflow.phases.intake.generation,0);
  const selected=await namespaceSpecificationFixture(t,{configure:source=>{source.definition.phases.design.artifact.kind='implementation-spec';}});
  await selected.author('intake',specificationText);await selected.approve('intake');
  await selected.author('design',planText+'\n[STORY-1:REQ-009] This phase is not a pinned clause-definition producer.\n');
  const plan=await record(selected,'design');assert.equal(plan.evidence.index,null);
  assert.deepEqual(Object.keys((await selected.json(plan.evidence.planned)).claims),['STORY-1:AC-001','STORY-1:REQ-001']);
});

test('allocation and placeholder checks retain the native rule values for arbitrary code-step names',()=>{
  const claims={C:{testDisposition:'not-applicable',testReason:'TODO',steps:['unknown']},A:{testDisposition:'not-applicable',testReason:'<reason>',steps:['one']}};
  assert.deepEqual(plannedClaimContractFindings(claims,['one','two']),{placeholderReasons:['A','C'],misallocated:['C to unknown'],idle:['two']});
});

test('a missing declared command remains pending without fabricating execution or blocking specification authoring',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:source=>{source.definition.phases.build.qualityCommands=[];}});
  await f.author('intake',specificationText);await f.approve('intake');await f.author('design',planText);
  const plan=await record(f,'design');assert.equal(plan.evidence.capabilities.status,'configuration-pending');
  assert.ok(plan.evidence.capabilities.pending.every(message=>message.includes('no pinned test command')));
  assert.equal((await f.capture()).workflow.phases.design.generation,1);assert.deepEqual((await f.capture()).workflow.phases.build.checks,[]);
});

test('a declared runner with insufficient assurance refuses the plan before code is authored',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:source=>{
    source.definition.phases.build.qualityCommands=[{id:'module-tests',argv:['test-tool'],kind:'test',modelPolicy:'never',affectedRoots:['.'],
      ecosystem:'node',result:{adapter:'junit-xml',path:'results/tests.xml'}}];
  }});
  await f.author('intake',specificationText);await f.approve('intake');
  const text=planText+'\n## Verification contracts\n\n| Criterion | Slot | Method | Witness | Required assurance |\n| --- | --- | --- | --- | --- |\n'
    +'| STORY-1:AC-001 | unit | test | `test/converter.test.js` | exact-local-observed |\n';
  await assert.rejects(f.author('design',text),error=>error.code==='TEST_CAPABILITY_UNSUPPORTED'&&error.details.problems.some(problem=>problem.includes('module-observed')));
  assert.equal((await f.capture()).workflow.phases.design.generation,0);
});

test('specification evidence does not waive a required clarification record',async t=>{
  const f=await namespaceSpecificationFixture(t,{configure:source=>{source.definition.phases.intake.clarification.mode='required';}});
  await assert.rejects(f.author('intake',specificationText),error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.required.includes('clarification-record'));
  assert.equal((await f.capture()).workflow.phases.intake.generation,0);
});

test('changing a retained index cannot become valid merely by storing new content digests',async t=>{
  const f=await namespaceSpecificationFixture(t);await f.author('intake',specificationText);const original=await record(f),index=await f.json(original.evidence.index);
  index.clauses[0].body='An invented approved requirement';
  const save=async value=>(await f.content.put(f.scope,'evidence',Buffer.from(canonicalJson(value)))).reference;
  const changed={...original.evidence,index:await save(index)},publication={...original.publication,specifications:{...original.publication.specifications,record:await save(changed)}},
    binding={...original.binding,record:await save(publication)};
  await assert.rejects(reader(f).read(binding,'intake',{specificationTraversal:new Map([[canonicalJson(publication),Promise.resolve(changed)]])}),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.deepEqual((await record(f)).binding,original.binding);
});

test('future specification bindings, manifests and derived records remain unsupported rather than corrupt',async t=>{
  const f=await namespaceSpecificationFixture(t);await f.author('intake',specificationText);const original=await record(f),
    context={projectId:f.scope.projectId,workId:f.inputs.workId,phaseId:'intake'};
  assert.throws(()=>namespacePublicationValue({...original.publication,specifications:{...original.publication.specifications,schemaVersion:2}},context),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  const save=async value=>(await f.content.put(f.scope,'evidence',Buffer.from(canonicalJson(value)))).reference;
  const index=await f.json(original.evidence.index);
  for(const changed of [{...original.evidence,schemaVersion:2},{...original.evidence,index:await save({...index,schemaVersion:2})}]) {
    const publication={...original.publication,specifications:{...original.publication.specifications,record:await save(changed)}},
      binding={...original.binding,record:await save(publication)};
    await assert.rejects(reader(f).read(binding,'intake'),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  }
});

test('mutating a previously checked value cannot carry its private proof into another identity',async t=>{
  const f=await namespaceSpecificationFixture(t);await f.author('intake',specificationText);const original=await record(f),r=reader(f),
    value=await r.read(original.binding,'intake'),plan=await createNamespaceLifecycleCommitter(f.common).intent(value.operationId);
  assert.equal(r.specifications.owners(value).length,3);
  value.actor.principalId='another-person';assert.deepEqual(r.specifications.owners(value),[]);
  assert.deepEqual(r.specifications.evidence(value),[]);assert.throws(()=>r.verifyPlan(value,plan),{code:'ENGINE_STORAGE_CORRUPT'});
});

test('specification evidence must name the actual conditional publication basis and appear in its accepted evidence set',async t=>{
  const f=await namespaceSpecificationFixture(t);await f.author('intake',specificationText);const original=await record(f),r=reader(f),value=await r.read(original.binding,'intake'),
    plan=await createNamespaceLifecycleCommitter(f.common).intent(value.operationId);
  assert.doesNotThrow(()=>r.verifyPlan(value,plan));
  assert.throws(()=>r.verifyPlan(value,{...plan,evidence:plan.evidence.filter(item=>item.sha256!==original.evidence.index.sha256)}),{code:'ENGINE_STORAGE_CORRUPT'});
  const basis=structuredClone(plan.basis);basis.head.operationId='another-preparation';
  assert.throws(()=>r.verifyPlan(value,{...plan,basis}),{code:'ENGINE_STORAGE_CORRUPT'});
});

test('real specification content permission and timeout errors preserve their original identity',async t=>{
  const f=await namespaceSpecificationFixture(t);await f.author('intake',specificationText);const original=await record(f);
  for(const failure of [Object.assign(new Error('The retained index is not readable.'),{code:'EACCES',path:'content.db'}),
    Object.assign(new Error('The shared index read exceeded its deadline.'),{code:'ETIMEDOUT',timeoutMs:300000})]) {
    const content={...f.content,async read(scope,reference,options){if(reference.sha256===original.evidence.index.sha256)throw failure;return f.content.read(scope,reference,options);}};
    await assert.rejects(reader(f,{content}).accepted(original.binding,'intake'),error=>error===failure);
  }
});

test('the specification profile retains actual check proof without treating a declared test runner as execution',async t=>{
  const f=await namespacePhaseCheckFixture(t,{configure:source=>{
    source.definition.spec={mode:'enforce',namespace:'STORY-1',coverage:'enforce',acceptance:'presence'};
    source.definition.phases.intake.artifact.kind='requirements';
    source.definition.workTypes.simple.omits=source.definition.workTypes.simple.omits.filter(item=>!['scope','plan'].includes(item.responsibility));
  }});
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'author-checked-specification',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:draft.manifest.draft.revision,content:await f.upload(specificationText),reason:'Retain the requirements checked by the configured command.'});
  await f.engine.run('phase.checks.run',f.input);f.accessControl.permissions.push('phase.publish');
  await createNamespacePublicationEngine(f.options).run('phase.publish',publishInput);
  const snapshot=(await f.state()).snapshot,reference=snapshot.workflow.phases.intake.publicationBindings[0].record,
    publication=JSON.parse(Buffer.from((await f.content.read(f.scope,reference)).data));
  assert.equal(publication.schemaVersion,3);assert.ok(publication.checks.result.content);
  assert.equal(publication.specifications.record.namespace,'evidence');assert.equal(f.control.starts,1);
});
