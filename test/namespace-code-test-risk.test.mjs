import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespaceSubmissionReader} from '../src/engine-storage/namespace-submission-reader.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
const reason='The independent integration pipeline verifies this exact service before accepting the deployment.';
const serviceTest="import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import {once} from 'node:events';\n"
  +"import {convert} from '../src/converter.js';\n// @ac:STORY-1:AC-001\n"
  +"test('converts the approved value',async()=>{assert.equal(convert(255),'FF');const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));await once(net.connect({host:'127.0.0.1',port}),'connect');});\n";
async function fixture(t,backend='sqlite',extra={}){
  const f=await namespaceTestWitnessFixture(t,{backend,testSource:serviceTest,run:false,...extra});
  f.control.permissions.push('test-risk.context','decision.test-risk','phase.prepublish','phase.review','phase.review.resources','story.evidence');
  const author=()=>Object.assign(f.control,{principalId:'author',agentId:'analyst',creator:{name:'Phase author',email:'reviewer@example.test',login:null}}),
    human=()=>Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}}),
    make=extra=>createNamespaceEngine({...f.options,checks:f.checks,...extra}),engine=make(),observer=createNamespaceStoryObserver(f.options),
    rebase=async id=>{const {manifest}=await engine.run('phase.draft.read',{phaseId:'build'});return engine.run('phase.draft.rebase',{
      operationId:id,workId:f.inputs.workId,phaseId:'build',expectedRevision:manifest.draft.revision,confirm:manifest.draft.bodySha256,reason});};
  author();const context=await engine.run('test-risk.context',{phaseId:'build'}),request={phaseId:'build',commandId:'node-tests',
    argvSha256:context.manifest.commands[0].argvSha256,causeClass:'service-unreachable',cause:'The required integration service is unavailable on this device.',reason,expires:'2026-11-20'};
  return {...f,engine,make,observer,request,author,human,rebase};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': actual Code and failed environment tests retain separate human risk evidence through independent approval',{timeout:120000},async t=>{
  const f=await fixture(t,backend);f.human();const risk=await f.engine.run('decision.test-risk',f.request);
  assert.equal(risk.record.schemaVersion,2);f.author();await f.rebase('risk-continuation');
  await f.engine.run('phase.source.retain',{operationId:'risk-code-bytes',workId:f.inputs.workId,phaseId:'build'});
  const run=await f.engine.run('phase.checks.run',{operationId:'risk-code-execution',workId:f.inputs.workId,phaseId:'build'});
  assert.equal(run.verdict,'failed');assert.equal(run.checks[0].tests.failed,1);
  const ready=await f.engine.run('phase.prepublish',{phaseId:'build'});assert.equal(ready.manifest.qualityDisposition,'ready');assert.equal(ready.manifest.readiness.requiredTests,'accepted-environment-failure');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const snapshot=(await f.observer.inspect()).snapshot,checks=createNamespacePhaseCheckReader(f.options),
    packets=createNamespaceSubmissionReader({observer:f.observer,...f.options,checks}),
    publication=await packets.publicationReader.accepted(snapshot.workflow.phases.build.publicationBindings[0],'build'),
    code=packets.publicationReader.policies.codeEvidence(publication);
  assert.equal(publication.checks,null);assert.equal(code.report.schemaVersion,32);
  assert.equal(code.report.executionException.testsPassed,false);assert.equal(code.report.acceptance[0].result.status,'failed');
  assert.deepEqual(code.report.acceptance[0].executionException.decisions,[risk.record.id]);
  assert.ok(publication.policyEvidence.some(row=>row.kind==='test-risk/v2'));
  await f.engine.run('phase.submit',{phaseId:'build'});f.human();
  const review=await f.engine.run('phase.review',{phaseId:'build'}),b=review.manifest.reviewBinding;
  const outcome=await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}});
  assert.equal(outcome.status,'recorded');assert.equal(f.starts(),1);
  const completed=(await f.engine.run('story.evidence',{})).manifest;
  assert.equal(completed.profile,'sflow-namespace-evidence-context/v4');assert.equal(completed.report.completion.kind,'complete-with-exceptions');
  const before=await f.capture(),takeover=f.make({working:null,sources:[],checks:undefined,clock:{now(){throw Error('Original approval replay has no new clock.');}}});
  assert.equal((await takeover.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}})).status,'recorded');
  assert.deepEqual(await f.capture(),before);
});
test('Code recovery risks need the actual agreement, enabled category and explicit human confirmation',{timeout:120000},async t=>{
  const f=await fixture(t,'sqlite',{configure:source=>{source.definition.testRecovery={enabled:true,riskAuthorities:['reviewers'],enabledRiskCategories:['validation-unavailable'],maxRiskDays:20};},
    beforeSpecification:async f=>{
      f.control.permissions.push('test-recovery.context','test-recovery.confirm');
      const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent}}),view=await engine.run('test-recovery.context',{});
      await engine.run('test-recovery.confirm',{operationId:'original-recovery-agreement',phaseId:'intake',expectedContext:view.manifest.expectedContext,reason});
    }});
  f.control.permissions.push('test-risk.confirm-recovery');f.human();
  await assert.rejects(f.engine.run('decision.test-risk',f.request),{code:'TEST_RECOVERY_RISK_CONFIRMATION_REQUIRED'});
  const view=await f.engine.run('test-risk.context',{phaseId:'build'}),request={...f.request,operationId:'explicit-recovery-environment-risk',expectedRecovery:view.manifest.expectedRecovery};
  await assert.rejects(f.engine.run('test-risk.confirm-recovery',{...request,expectedRecovery:'sha256:'+'0'.repeat(64)}),{code:'TEST_RECOVERY_RISK_CONFIRMATION_REQUIRED'});
  const decision=await f.engine.run('test-risk.confirm-recovery',request);assert.equal(decision.record.schemaVersion,3);
  f.author();await f.rebase('exact-recovery-risk-continuation');await f.engine.run('phase.source.retain',{operationId:'recovery-risk-source',workId:f.inputs.workId,phaseId:'build'});
  assert.equal((await f.engine.run('phase.checks.run',{operationId:'recovery-risk-tests',workId:f.inputs.workId,phaseId:'build'})).verdict,'failed');
  assert.equal((await f.engine.run('phase.prepublish',{phaseId:'build'})).manifest.qualityDisposition,'ready');
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'build'});f.human();
  const review=await f.engine.run('phase.review',{phaseId:'build'}),b=review.manifest.reviewBinding;
  await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}});
  assert.equal(f.starts(),1);assert.equal((await f.observer.inspect()).snapshot.workflow.namespaceTestRecoveryAgreements.length,1);
});
test('an accepted Code environment failure cannot waive a required human visual witness',{timeout:120000},async t=>{
  const plan=planText+'\n## Verification contracts\n\n| Criterion | Slot | Method | Witness | Role | Combination |\n| --- | --- | --- | --- | --- | --- |\n'
    +'| STORY-1:AC-001 | tests | test | `test/converter.test.js` | primary | all |\n'
    +'| STORY-1:AC-001 | converter-screen | visual | `converter` | primary | all |\n',
    f=await fixture(t,'sqlite',{plan,configure(source){source.definition.artifactSets={delivery:{primary:'summary.md',members:[
      {path:'summary.md',role:'implementation-summary',required:true},{path:'proof.png',role:'supporting-evidence',required:true}]}};source.definition.phases.build.artifactSet='delivery';},
      async afterPrepare(f,engine){f.control.permissions.push('phase.artifact.attach');const draft=await engine.run('phase.draft.read',{phaseId:'build'});
        await engine.run('phase.artifact.attach',{operationId:'retain-mixed-risk-fixture',workId:f.inputs.workId,phaseId:'build',memberPath:'proof.png',
          expectedRevision:draft.manifest.draft.revision,content:await f.upload(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])),reason:'Retain isolated fixture bytes; this is not a production screenshot.'});}});
  f.control.permissions.push('witness.context','decision.witness');f.human();await f.engine.run('decision.test-risk',f.request);f.author();await f.rebase('mixed-risk-continuation');
  await f.engine.run('phase.source.retain',{operationId:'mixed-risk-source',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.checks.run',{operationId:'mixed-risk-check',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'build'});f.human();
  const b=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding,
    approval={phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}};
  await assert.rejects(f.engine.run('phase.approve',approval),error=>error.code==='ENGINE_WITNESS_DECISION_REQUIRED'&&error.details.criteria[0].slots.some(row=>row.method==='visual'&&row.status==='missing'));
  const query={clauseId:'STORY-1:AC-001',slotName:'converter-screen',file:'singularity/work-items/'+f.inputs.workId+'/artifacts/build/proof.png'},
    view=(await f.engine.run('witness.context',query)).manifest;
  await f.engine.run('decision.witness',{operationId:'review-mixed-risk-image',...query,expectedContext:view.contextBinding,expectedFile:'sha256:'+view.file.content.sha256,
    answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),reason:'The isolated fixture reviewer confirms this exact retained output and criterion.'});
  try{await f.engine.run('phase.approve',approval);}catch(cause){t.diagnostic(JSON.stringify(cause.details));throw cause;}
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),1);
});
test('late phases expose expired Code permissions and renew the original owner without a duplicate obligation decision',{timeout:120000},async t=>{
  const f=await fixture(t,'sqlite',{configure(source){source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/report.md',kind:'phase-document'},defaultTemplate:'intake.md',
    inputs:[{phase:'build'}],clarification:{mode:'off',markers:{mode:'off'}},specificationQuality:{mode:'off'},approval:{authorities:['reviewers'],minimum:1,rejectTo:['build'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('release');source.agents[0].phases.push('release');source.agents[0].defaultFor.push('release');}});
  f.control.permissions.push('decisions.list');f.human();await f.engine.run('decision.test-risk',f.request);f.author();await f.rebase('before-code-risk-publication');
  await f.engine.run('phase.source.retain',{operationId:'late-risk-code',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.checks.run',{operationId:'late-risk-check',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'build'});f.human();
  async function approve(phaseId){const b=(await f.engine.run('phase.review',{phaseId})).manifest.reviewBinding;
    return f.engine.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:b.generation,reviewPacketSha256:b.packetSha256}});}
  await approve('build');f.control.now='2026-11-21T00:00:00.000Z';
  const view=(await f.engine.run('story.evidence',{})).manifest,policy=view.report.rows.find(row=>row.type==='EXECUTION-POLICY');
  assert.equal(policy.result,'pending');assert.ok(policy.actions.some(row=>row.operation==='test-risk.context'&&row.inputs.phaseId==='build'));
  const list=(await f.engine.run('decisions.list',{})).manifest.policy;assert.ok([...list.offered,...(list.required??[])].some(row=>row.kind==='test-run-risk'));
  f.author();await f.engine.run('phase.prepare',{phaseId:'release'});const draft=(await f.engine.run('phase.draft.read',{phaseId:'release'})).manifest.draft;
  await f.engine.run('phase.draft.write',{operationId:'late-risk-release',workId:f.inputs.workId,phaseId:'release',expectedRevision:draft.revision,
    content:await f.upload('# Release\n\n## Agent brief\n\nThe original failed environment execution is disclosed; only its original human owner may renew its permission.\n'),reason});
  await f.engine.run('phase.publish',{phaseId:'release',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'release'});f.human();
  await assert.rejects(approve('release'),{code:'ENGINE_TERMINAL_EVIDENCE_REQUIRED'});
  await f.engine.run('decision.test-risk',{...f.request,expires:'2026-12-01'});await approve('release');
  const state=await f.capture();assert.equal(state.workflow.status,'closed');assert.equal(state.workflow.namespaceTestRunRisks.length,2);
  assert.equal((state.workflow.namespaceObligationRisks??[]).length,0);assert.equal(f.starts(),1);
});
