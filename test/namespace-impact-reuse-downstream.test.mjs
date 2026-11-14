import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './helpers/namespace-selective-test-recovery-fixture.mjs';
import {fixtureImpactUnit} from './helpers/source-impact-fixture.mjs';
import {reuseReason} from './helpers/namespace-code-reuse-fixture.mjs';
import {verificationWorkflow,codeInputArtifact} from './helpers/namespace-code-input-fixture.mjs';
import {releaseReport} from './helpers/namespace-release-fixture.mjs';import {planText} from './helpers/namespace-specification-fixture.mjs';
const publish={authored:'governed-agent',channel:'copilot-host'};
async function journey(t,backend){
 const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`').replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
  +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n';
 const f=await namespaceSelectiveTestRecoveryFixture(t,{backend,repositories:2,plan,reuse:'environment-qualified-selected',
  baselineFiles:{'test/first.test.js':"import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../src/converter.js';test('first stable regression',()=>assert.equal(convert(0),'0'));\n"},
  configure:source=>{source.definition.testRecovery.reuseProfile='environment-qualified-selected/v1';verificationWorkflow(source);
   source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',writeScope:'artifact-only',
    inputs:[{phase:'build'},{phase:'verify'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
    approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
   source.definition.workTypes.simple.phases.push('release');source.agents.push({...source.agents[0],id:'release-author',label:'Release author',phases:['release'],defaultFor:['release']});
  }}),checks={...f.checks,combinedEvidenceReuse:true,impact:fixtureImpactUnit(f)},engine=f.make({checks}),input={phaseId:'build',baselineOperationId:'pre-feature-full-execution',mode:'changed-and-affected'};
 f.control.permissions.push('evidence-reuse.context','decision.evidence-reuse');
 async function approve(phaseId){await engine.run('phase.submit',{phaseId});f.human();const b=(await engine.run('phase.review',{phaseId})).manifest.reviewBinding;
  await engine.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:b.generation,reviewPacketSha256:b.packetSha256}});}
 async function write(phaseId,text){await engine.run('phase.prepare',{phaseId});const draft=await engine.run('phase.draft.read',{phaseId});await engine.run('phase.draft.write',{
  operationId:'author-impact-'+phaseId,workId:f.inputs.workId,phaseId,expectedRevision:draft.manifest.draft.revision,content:await f.upload(text),reason:reuseReason});}
 f.human();const view=await engine.run('test-recovery.select-context',input);await engine.run('test-recovery.select-confirm',{...input,operationId:'review-two-repo-impact',expectedContext:view.manifest.expectedContext,
  reason:selectionReason,expires:'2026-11-09',followUpOwner:'suite-owners',remediationRef:'SCOPE-1'});await f.rebase();
 const run=await engine.run('phase.checks.run',{operationId:'impact-original-execution',workId:f.inputs.workId,phaseId:'build'});assert.equal(run.verdict,'passed');
 f.human();const producer={producerPhaseId:'build',producerOperationId:'impact-original-execution'},reusable=await engine.run('evidence-reuse.context',{phaseId:'build',...producer});
 for(const row of reusable.manifest.candidates)await engine.run('decision.evidence-reuse',{phaseId:'build',...producer,attemptId:row.taskId,reason:reuseReason,expires:'2026-11-09'});
 await f.rebase('rebase-two-repo-impact-reuse');await engine.run('phase.publish',{phaseId:'build',...publish});await approve('build');const starts=f.starts();
 f.author();f.control.agentId='verifier';f.control.now='2026-11-10T00:00:00.000Z';await write('verify',codeInputArtifact);
 await assert.rejects(engine.run('phase.publish',{phaseId:'verify',...publish}),error=>['SELECTIVE_TEST_RECOVERY_NOT_CURRENT','ENGINE_EVIDENCE_REUSE_NOT_CURRENT'].includes(error.code));
 const empty=f.make({working:null,sources:[],sourceReaders:[],checks:{mode:'retained-only'}});f.human();
 const scope=(await empty.run('test-recovery.select-context',input)).manifest;assert.equal(scope.expectedContext,view.manifest.expectedContext);assert.equal(scope.sourceObservation,'retained-original');assert.equal(scope.purpose,'renew-original-permission');
 await empty.run('test-recovery.select-confirm',{...input,operationId:'renew-two-repo-impact',expectedContext:scope.expectedContext,reason:selectionReason,expires:'2026-11-28',followUpOwner:'suite-owners',remediationRef:'SCOPE-2'});
 const renewals=(await empty.run('evidence-reuse.context',{phaseId:'build'})).manifest;assert.equal(renewals.purpose,'renew-original-permission');assert.equal(renewals.candidates.length,4);
 for(const action of renewals.actions.filter(row=>row.operation==='decision.evidence-reuse'))await empty.run(action.operation,{...action.inputs,reason:reuseReason,expires:'2026-11-28'});
 f.author();f.control.agentId='verifier';const draft=await engine.run('phase.draft.read',{phaseId:'verify'});await engine.run('phase.draft.rebase',{operationId:'continue-impact-verification',workId:f.inputs.workId,phaseId:'verify',
  expectedRevision:draft.manifest.draft.revision,confirm:draft.manifest.draft.bodySha256,reason:reuseReason});await engine.run('phase.publish',{phaseId:'verify',...publish});
 const p=await f.json((await f.capture()).workflow.phases.verify.publicationBindings[0].record),b=p.policyEvidence.find(row=>row.kind==='approved-code-inputs/v5'),report=await f.json((await f.json(b.record)).report),source=report.inputs.find(row=>row.phase==='build');
 assert.equal(source.testReuse.receiverExecuted,false);assert.equal(source.testSelection.receiverExecuted,false);assert.equal(source.testSelection.excluded.length,2);
 assert.ok(source.tests.every(row=>row.tests.passed===1));await approve('verify');f.author();f.control.agentId='release-author';await write('release',releaseReport());
 await engine.run('phase.publish',{phaseId:'release',...publish});await approve('release');assert.equal(f.starts(),starts);
 const evidence=(await engine.run('story.evidence',{})).manifest;assert.equal(evidence.report.completion.kind,'complete-with-exceptions');
 assert.ok(evidence.excluded.some(row=>row.reason==='reviewed-unselected-baseline-cases-are-not-executed'));
 for(const root of f.roots)await rm(root,{recursive:true,force:true});f.author();const offline=f.make({working:null,sources:[],checks:{mode:'retained-only'},clock:{now(){throw Error('Replay may not acquire new execution or timestamps.');}}});
 assert.equal((await offline.run('phase.publish',{phaseId:'release',...publish})).status,'retained');
}
const backends=['filesystem','sqlite','application'],worker=process.argv.indexOf('--impact-journey');
if(worker>=0){
 const backend=process.argv[worker+1];assert.ok(backends.includes(backend));
 await test('two repositories retain impact and reuse permissions through Release and empty-device renewal: '+backend,{timeout:180000},t=>journey(t,backend));
}else for(const backend of backends)test('two repositories retain impact and reuse permissions through Release and empty-device renewal: '+backend,{timeout:180000},async()=>{
 // Exercise the real embedding process. Node's outer test worker tracks every nested promise;
 // it supervises this consumer without changing the journey's assertions or parent deadline.
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const result=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),'--impact-journey',backend],{
  env,timeout:170000,maxBuffer:2*1024*1024});
 assert.ok(result.stdout.includes('two repositories retain impact and reuse permissions through Release and empty-device renewal: '+backend));
});
