import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {createNamespaceReadSession} from '../src/engine-storage/namespace-read-session.mjs';
import {namespaceArtifactSetPolicies,phaseArtifactInspectionManifest} from '../src/kernel/namespace-artifact-sets.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../src/engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_DIGESTS} from '../src/records.mjs';
import {createNamespacePublicationReader} from '../src/engine-storage/namespace-publication-reader.mjs';
import {createNamespaceStoryObserver,memoNamespaceObservedWitness} from '../src/engine-storage/namespace-story-reader.mjs';
const configure=source=>{source.definition.artifactSets={packet:{primary:'plan.md',members:[{path:'plan.md',role:'requirements',required:true},
  {path:'evidence/',role:'supporting-evidence',required:true},{path:'evidence/notes.txt',role:'test-report',required:true},
  {path:'optional.txt',role:'planning',authority:'advisory'}]}};source.definition.phases.intake.artifactSet='packet';
  source.definition.inputsMode='enforce';source.definition.phases.followup={...structuredClone(source.definition.phases.intake),artifactSet:undefined,
    label:'Followup',artifact:{path:'artifacts/followup/report.md'},inputs:[{phase:'intake'}]};delete source.definition.phases.followup.artifactSet;
  source.definition.workTypes.simple.phases=['intake','followup'];source.agents[0].phases.push('followup');source.agents[0].defaultFor.push('followup');};
async function working(f){await f.bootstrap();f.control.permissions.push('phase.artifact.attach','phase.artifact.remove','phase.artifact.inspect','phase.prepublish');
  f.control.permissions.push('phase.inputs');await f.engine.run('phase.prepare',{phaseId:'intake'});const d=await f.engine.run('phase.draft.read',{phaseId:'intake'}),content=(await f.local.content.put(f.scope,'local',Buffer.from('# Checked intake\n\nThis author documented the actual request.\n'))).reference;
  await f.engine.run('phase.draft.write',{operationId:'authored-primary',workId:f.workId,phaseId:'intake',expectedRevision:d.manifest.draft.revision,content,reason:'Complete the primary document.'});}
async function attach(f,path,data,operationId){const d=await f.engine.run('phase.draft.read',{phaseId:'intake'}),content=(await f.local.content.put(f.scope,'local',Buffer.from(data))).reference;
  const input={operationId,workId:f.workId,phaseId:'intake',expectedRevision:d.manifest.draft.revision,memberPath:path,content,reason:'Retain this explicitly declared output.'};
  return {input,result:await f.engine.run('phase.artifact.attach',input)};}
for(const backend of ['filesystem','sqlite','application'])test(backend+': typed output publication and independent approval retain every member through takeover',{timeout:120000},async t=>{
  const f=await namespaceEngineFixture(t,{backend,configure});await working(f);const before=await f.capture();
  const missing=await f.engine.run('phase.prepublish',{phaseId:'intake'});assert.equal(missing.manifest.qualityDisposition,'correction-required');
  assert.ok(missing.manifest.findings.some(row=>row.code==='PHASE_ARTIFACT_SET_INCOMPLETE'));assert.deepEqual(await f.capture(),before);
  assert.ok(missing.manifest.findings.filter(row=>row.code==='PHASE_ARTIFACT_SET_INCOMPLETE').every(row=>row.policy.repairableByProducer&&row.path));
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),error=>error.code==='PHASE_ARTIFACT_SET_INCOMPLETE'
    &&error.details.missing.includes('evidence/')&&error.details.actions[0].operation==='phase.artifact.attach');
  const bytes=Buffer.from('Actual recorded evidence, not a test execution or visual attestation.\n'),a=await attach(f,'evidence/notes.txt',bytes,'attach-notes');
  const b=await attach(f,'evidence/copy.txt',bytes,'attach-same-content-other-path');assert.equal(a.result.member.content.sha256,b.result.member.content.sha256);
  assert.equal((await f.content.read(f.scope,{...a.result.member.content,namespace:'evidence'})).status,'missing','private outputs do not upload during attachment');
  const replay=await f.engine.run('phase.artifact.attach',a.input);assert.equal(replay.replayed,true);assert.equal(replay.revision,a.result.revision);
  const inventory=await f.engine.run('phase.artifact.inspect',{phaseId:'intake',maximumEntries:1});assert.equal(inventory.manifest.totals.files,2);assert.equal(inventory.manifest.truncated,true);
  const metadata=await f.engine.run('phase.artifact.inspect',{phaseId:'intake',maximumEntries:0});assert.equal(metadata.manifest.totals.files,2);assert.equal(metadata.manifest.members.length,0);
  const ready=await f.engine.run('phase.prepublish',{phaseId:'intake'});assert.equal(ready.manifest.qualityDisposition,'ready');
  const publication=await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});assert.equal(publication.generation,1);
  const snapshot=await f.capture(),documents=snapshot.workflow.namespaceDocuments.filter(row=>row.kind==='artifact-set-member');assert.equal(documents.length,2);
  assert.equal(snapshot.workflow.phases.intake.artifacts.length,3);
  await f.engine.run('phase.submit',{phaseId:'intake'});f.asReviewer();
  const displayed=await f.engine.run('phase.review',{phaseId:'intake'});assert.ok(displayed.manifest.reviewBinding);assert.equal(displayed.manifest.items.filter(row=>row.integrity==='matched').length,3);
  const reviews=await f.engine.run('phase.review.resources',{phaseId:'intake'}),members=reviews.manifest.resources.filter(row=>row.kind==='artifact-set-member');assert.equal(members.length,2);
  for(const resource of members){const result=await f.engine.run('document.read',{reference:resource.reference});assert.equal(result.document.content.text,bytes.toString());}
  const replayEngine=f.make({working:null});const retained=await replayEngine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});assert.equal(retained.status,'retained');
  await f.review('intake');f.asAuthor();
  const input=await f.engine.run('phase.inputs',{phaseId:'followup',dryRun:true}),ids=input.manifest.resources.filter(row=>row.kind==='supporting-document').map(row=>row.id);
  for(const doc of documents)assert.ok(ids.includes(doc.id),'the approved member is in the downstream phase read manifest');
  const observer=createNamespaceStoryObserver(f.options),reader=createNamespacePublicationReader({observer,scope:f.scope,workId:f.workId});
  const accepted=await reader.accepted(snapshot.workflow.phases.intake.publicationBindings[0],'intake');
  assert.ok(reader.policies.owners(accepted).includes('artifact-set'));
});
test('output mutations have exact path, permission, revision and replay identity fences',{timeout:120000},async t=>{
  const f=await namespaceEngineFixture(t,{configure});await working(f);
  const first=await attach(f,'evidence/notes.txt','Retained notes.','attach-first');
  for(const memberPath of ['../other.txt','/absolute','plan.md','undeclared.txt','evidence//alias.txt']){
    const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
    await assert.rejects(f.engine.run('phase.artifact.attach',{...first.input,operationId:'bad-'+String(memberPath.length)+'-'+memberPath.replace(/[^a-z]/gu,''),
      memberPath,expectedRevision:draft.manifest.draft.revision}));}
  const snapshot=await f.capture();f.asReviewer();await assert.rejects(f.engine.run('phase.artifact.attach',first.input),{code:'ENGINE_ACTOR_CHANGED'});f.asAuthor();
  await assert.rejects(f.engine.run('phase.artifact.attach',{...first.input,operationId:'stale-expected-revision'}),{code:'ENGINE_CONTEXT_CHANGED'});
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'}),remove={operationId:'remove-notes',workId:f.workId,phaseId:'intake',memberPath:'evidence/notes.txt',expectedRevision:draft.manifest.draft.revision,reason:'Remove this draft output.'};
  const removed=await f.engine.run('phase.artifact.remove',remove);assert.equal(removed.member.content,null);assert.equal((await f.engine.run('phase.artifact.inspect',{phaseId:'intake'})).manifest.totals.files,0);
  assert.equal((await f.engine.run('phase.artifact.remove',remove)).replayed,true);assert.deepEqual(await f.capture(),snapshot);
  f.control.permissions=f.control.permissions.filter(value=>value!=='phase.artifact.attach');
  const current=await f.engine.run('phase.draft.read',{phaseId:'intake'});await assert.rejects(f.engine.run('phase.artifact.attach',{...first.input,operationId:'revoked-member',expectedRevision:current.manifest.draft.revision}),{code:'ENGINE_AUTHORITY_REQUIRED'});
});
test('actual attached-byte failures keep their original error identity and never accept a bundle',{timeout:120000},async t=>{
  const f=await namespaceEngineFixture(t,{configure});await working(f);const attached=await attach(f,'evidence/notes.txt','Exact private bytes.','attach-error-subject');
  const failure=Object.freeze(Object.assign(Error('The actual private attachment read timed out.'),{code:'ETIMEDOUT',timeoutMs:300000}));
  const engine=f.make({working:{records:f.local.records,content:{...f.local.content,async read(scope,reference,options){if(reference.sha256===attached.input.content.sha256)throw failure;
    return f.local.content.read(scope,reference,options);}}}}),before=await f.capture();
  await assert.rejects(engine.run('phase.prepublish',{phaseId:'intake'}),error=>error===failure);
  await assert.rejects(engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),error=>error===failure);assert.deepEqual(await f.capture(),before);
});
test('typed output hashes follow exact member identities and directory contents, without making a visual or execution claim',()=>{
  const values=namespaceArtifactSetPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
  const config={phases:{intake:{}},workTypes:{simple:{}}};configure({definition:config,agents:[{phases:[],defaultFor:[]}]});
  const phase={id:'intake',artifactSet:'packet',requiredArtifact:{path:'artifacts/intake/plan.md'}},workflow={workItem:{id:'w'}},primary={namespace:'evidence',sha256:'a'.repeat(64),bytes:10},
    files=[{path:'evidence/notes.txt',content:{namespace:'evidence',sha256:'b'.repeat(64),bytes:12}},{path:'evidence/other.txt',content:{namespace:'evidence',sha256:'c'.repeat(64),bytes:14}}];
  const report=values.catalog(config,workflow,phase,{primary,files});assert.deepEqual(values.catalog(config,workflow,phase,{primary,files:[...files].reverse()}),report);
  const altered=structuredClone(files);altered[1].content.sha256='d'.repeat(64);assert.notEqual(values.catalog(config,workflow,phase,{primary,files:altered}).bundleSha256,report.bundleSha256);
  assert.equal(Object.hasOwn(report,'testsPassed'),false);assert.equal(Object.hasOwn(report,'visualAccepted'),false);
  assert.throws(()=>values.catalog(config,workflow,phase,{primary,files:[]}),{code:'PHASE_ARTIFACT_SET_INCOMPLETE'});
  assert.throws(()=>phaseArtifactInspectionManifest('w','intake',{workId:'w',phase:'intake',revision:'rev',status:'observed',draft:null,set:null,members:[{}]}),{code:'ENGINE_PORT_RESULT_INVALID'});
});
test('only a genuine observer can reuse an immutable witness proof through its actual invocation ports',async t=>{
  const f=await namespaceEngineFixture(t),session=createNamespaceReadSession({records:f.records,content:f.content}),
    observer=createNamespaceStoryObserver({...f.options,records:session.records,content:session.content}),identity={link:'retained-fixture'},
    clone={...observer};let reads=0;const observe=async()=>({recordId:'WIT-001',sequence:++reads});
  await session.run(async()=>{const [a,b]=await Promise.all([memoNamespaceObservedWitness(observer,identity,observe),memoNamespaceObservedWitness(observer,identity,observe)]);
    assert.equal(reads,1);a.recordId='mutated';assert.equal(b.recordId,'WIT-001');
    await observer.withReadScope(scoped=>memoNamespaceObservedWitness(scoped,identity,observe));assert.equal(reads,1);
    await memoNamespaceObservedWitness(clone,identity,observe);assert.equal(reads,2);});
  await session.run(()=>memoNamespaceObservedWitness(observer,identity,observe));assert.equal(reads,3);
});
