import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture,actualWitnessTest} from './helpers/namespace-test-witness-fixture.mjs';
import {namespaceTargetedRepairFixture,unrelatedSource} from './helpers/namespace-targeted-repair-fixture.mjs';
import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';import {planText} from './helpers/namespace-specification-fixture.mjs';
import {WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
import {createNamespaceDraftStore} from '../src/engine-storage/namespace-draft-store.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'},reason='The independent integration pipeline verifies this service before accepting the deployment.',
  serviceTest="import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import {once} from 'node:events';\n"
    +"import {convert} from '../src/converter.js';\n// @ac:STORY-1:AC-001\n"
    +"test('converts the approved value',async()=>{assert.equal(convert(255),'FF');const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));await once(net.connect({host:'127.0.0.1',port}),'connect');});\n",
  plan=planText+'\n## Verification contracts\n\n| Criterion | Slot | Method | Witness | Role | Combination |\n| --- | --- | --- | --- | --- | --- |\n'
    +'| STORY-1:AC-001 | tests | test | `test/converter.test.js` | primary | all |\n| STORY-1:AC-001 | converter-screen | visual | `converter` | primary | all |\n';
for(const risk of [false,true])test('a reviewed successor '+(risk?'retains failed environment checks and':'runs fresh passing checks and')+' requires a new exact visual witness',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite',run:false,plan,testSource:risk?serviceTest:actualWitnessTest,configure(source){
    source.definition.artifactSets={delivery:{primary:'summary.md',members:[{path:'summary.md',role:'implementation-summary',required:true},{path:'proof.png',role:'supporting-evidence',required:true}]}};
    source.definition.phases.build.artifactSet='delivery';}});
  f.control.permissions.push('phase.begin','phase.rollover','phase.artifact.attach','phase.artifact.inspect','test-risk.context','decision.test-risk','story.evidence');
  const human=f.make({access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['witness.context','decision.witness','test-risk.context','decision.test-risk','phase.review','phase.approve']})}});
  if(risk){const view=await human.run('test-risk.context',{phaseId:'build'});await human.run('decision.test-risk',{phaseId:'build',commandId:'node-tests',argvSha256:view.manifest.commands[0].argvSha256,
    causeClass:'service-unreachable',cause:'The required integration service is unavailable on this device.',reason,expires:'2026-11-20'});
    const {manifest}=await f.engine.run('phase.draft.read',{phaseId:'build'});await f.engine.run('phase.draft.rebase',{operationId:'before-visual-risk-rollover',workId:f.inputs.workId,phaseId:'build',
      expectedRevision:manifest.draft.revision,confirm:manifest.draft.bodySha256,reason});}
  async function attach(generation){const {manifest}=await f.engine.run('phase.draft.read',{phaseId:'build'});await f.engine.run('phase.artifact.attach',{
    operationId:'reviewed-visual-'+generation,workId:f.inputs.workId,phaseId:'build',memberPath:'proof.png',expectedRevision:manifest.draft.revision,
    content:await f.upload(Buffer.from([137,80,78,71,13,10,26,10,generation])),reason:'Retain isolated binary fixture bytes for this actual generation; this is not production visual evidence.'});}
  const query={clauseId:'STORY-1:AC-001',slotName:'converter-screen',file:'singularity/work-items/'+f.inputs.workId+'/artifacts/build/proof.png'};
  async function witness(generation){const view=(await human.run('witness.context',query)).manifest;assert.equal(view.result.status,'missing');
    await human.run('decision.witness',{...query,operationId:'reviewed-successor-visual-'+generation,expectedContext:view.contextBinding,expectedFile:'sha256:'+view.file.content.sha256,
      answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),reason:'The independent fixture reviewer inspected this exact generation and its retained binary fixture.'});}
  await attach(1);await f.engine.run('phase.source.retain',{operationId:'reviewed-visual-source-one',workId:f.inputs.workId,phaseId:'build'});await f.runChecks('reviewed-visual-checks-one');
  await f.engine.run('phase.publish',publish);await witness(1);
  await writeFile(path.join(f.root,'src/converter.js'),converterSource+'// Keep the approved conversion current in the reviewed successor.\n');
  const view=await f.engine.run('phase.rollover',{phaseId:'build'});await f.engine.run('phase.rollover',{phaseId:'build',confirm:view.plan.confirmation});
  assert.equal((await f.engine.run('phase.artifact.inspect',{phaseId:'build'})).manifest.members.length,0,'a previous visual member cannot be stamped as a fresh generation');
  await attach(2);await f.engine.run('phase.source.retain',{operationId:'reviewed-visual-source-two',workId:f.inputs.workId,phaseId:'build'});await f.runChecks('reviewed-visual-checks-two');
  await f.engine.run('phase.publish',publish);const snapshot=await f.capture(),publication=await f.json(snapshot.workflow.phases.build.publicationBindings[1].record),
    policy=publication.policyEvidence.find(row=>row.kind==='code-delivery/v'+(risk?36:35)),report=await f.json((await f.json(policy.record)).report);
  assert.equal(risk?report.evidenceVersion:report.schemaVersion,35);if(risk)assert.equal(report.executionException.testsPassed,false);
  await f.engine.run('phase.submit',{phaseId:'build'});const b=(await human.run('phase.review',{phaseId:'build'})).manifest.reviewBinding,
    approval={phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}};
  await assert.rejects(human.run('phase.approve',approval),{code:'ENGINE_WITNESS_DECISION_REQUIRED'});await witness(2);
  assert.equal((await human.run('phase.approve',approval)).approval.selfApproval,false);assert.equal(f.starts(),2);
});
test('reviewed opening preserves an authenticated targeted return and rejects unrelated source before writing its generation',{timeout:120000},async t=>{
  const f=await namespaceTargetedRepairFixture(t,{backend:'sqlite'});await f.reviewer.run('phase.reject',f.request);f.control.agentId='analyst';f.control.permissions.push('phase.begin','phase.rollover');
  const before=await f.head();await writeFile(path.join(f.root,'src/other.js'),unrelatedSource+'// This path belongs to the other requirement.\n');
  for(const operation of ['phase.begin','phase.rollover'])await assert.rejects(f.engine.run(operation,{phaseId:'build'}),{code:'ENGINE_TARGETED_REPAIR_SCOPE_EXCEEDED'});
  assert.deepEqual(await f.head(),before);await writeFile(path.join(f.root,'src/other.js'),unrelatedSource);
  const opened=await f.engine.run('phase.begin',{phaseId:'build'});assert.equal(opened.generation,2);await f.begin();
  await f.engine.run('phase.source.retain',{operationId:'reviewed-targeted-source',workId:f.inputs.workId,phaseId:'build'});await f.runChecks('reviewed-targeted-checks');
  await f.engine.run('phase.publish',publish);const result=await f.published('build');assert.equal(result.report.preflight.history.profile,'sflow-namespace-code-history/v8');
  const draft=createNamespaceDraftStore({records:f.localRecords,content:f.localContent,scope:f.scope,workId:f.inputs.workId,phaseId:'build'}),beforeReview=await draft.capture();
  await assert.rejects(f.engine.run('phase.rollover',{phaseId:'build'}),error=>error.code==='GENERATION_ROLLOVER_REVIEW_REQUIRED'&&error.details.actions[0].operation==='phase.review');
  assert.deepEqual(await draft.capture(),beforeReview,'the next author-only generation cannot be offered and then fail after its first write');
  await f.approve('build');
});
