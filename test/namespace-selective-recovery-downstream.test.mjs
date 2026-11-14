import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './helpers/namespace-selective-test-recovery-fixture.mjs';
import {verificationWorkflow,codeInputArtifact} from './helpers/namespace-code-input-fixture.mjs';
import {releaseReport} from './helpers/namespace-release-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
const publish={authored:'governed-agent',channel:'copilot-host'};
test('two repositories carry selective counts and original-owner renewal through Verification and Release',{timeout:180000},async t=>{
  const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
    .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
    +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n',
    f=await namespaceSelectiveTestRecoveryFixture(t,{repositories:2,plan,configure:source=>{
      verificationWorkflow(source);source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',
        writeScope:'artifact-only',inputs:[{phase:'build'},{phase:'verify'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
        approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
      source.definition.workTypes.simple.phases.push('release');source.agents.push({...source.agents[0],id:'release-author',label:'Release author',phases:['release'],defaultFor:['release']});
    }});
  async function approve(phaseId){await f.engine.run('phase.submit',{phaseId});f.human();const binding=(await f.engine.run('phase.review',{phaseId})).manifest.reviewBinding;
    await f.engine.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}});}
  async function write(phaseId,text){await f.engine.run('phase.prepare',{phaseId});const draft=await f.engine.run('phase.draft.read',{phaseId});
    await f.engine.run('phase.draft.write',{operationId:'write-selected-'+phaseId,workId:f.inputs.workId,phaseId,expectedRevision:draft.manifest.draft.revision,
      content:await f.upload(text),reason:'Retain exact original test counts and the reviewed unexecuted inventory.'});}
  await f.confirm();await f.rebase();const run=await f.run();assert.equal(run.verdict,'passed');assert.equal(run.checks.filter(row=>row.id==='legacy-tests').length,2);
  assert.ok(run.checks.filter(row=>row.id==='legacy-tests').every(row=>row.tests.discovered===1));
  await f.engine.run('phase.publish',{phaseId:'build',...publish});await approve('build');const starts=f.starts();
  f.author();f.control.agentId='verifier';f.control.now='2026-11-21T00:00:00.000Z';await write('verify',codeInputArtifact);
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'verify',...publish}),{code:'SELECTIVE_TEST_RECOVERY_NOT_CURRENT'});
  f.human();const view=await f.view();await f.engine.run('test-recovery.select-confirm',{...f.contextInput,operationId:'renew-two-repository-scope',expectedContext:view.manifest.expectedContext,
    reason:selectionReason,expires:'2026-12-01',followUpOwner:'suite-maintainers',remediationRef:'TEST-SCOPE-2'});
  f.author();f.control.agentId='verifier';const draft=await f.engine.run('phase.draft.read',{phaseId:'verify'});
  await f.engine.run('phase.draft.rebase',{operationId:'continue-selected-verification',workId:f.inputs.workId,phaseId:'verify',expectedRevision:draft.manifest.draft.revision,
    confirm:draft.manifest.draft.bodySha256,reason:'Keep the original producer execution after its original owner renewed permission.'});
  await f.engine.run('phase.publish',{phaseId:'verify',...publish});
  const state=await f.capture(),publication=await f.json(state.workflow.phases.verify.publicationBindings[0].record),
    binding=publication.policyEvidence.find(row=>row.kind==='approved-code-inputs/v3'),manifest=await f.json(binding.record),report=await f.json(manifest.report),producer=report.inputs.find(row=>row.phase==='build');
  assert.equal(producer.testSelection.receiverExecuted,false);assert.equal(producer.testSelection.excluded.length,2);assert.equal(producer.testSelection.impactComplete,false);
  assert.ok(producer.tests.filter(row=>row.commandId==='legacy-tests').every(row=>row.tests.passed===1));assert.equal(publication.checks,null);
  await approve('verify');f.author();f.control.agentId='release-author';await write('release',releaseReport());
  await f.engine.run('phase.publish',{phaseId:'release',...publish});await approve('release');
  assert.equal(f.starts(),starts);const evidence=(await f.engine.run('story.evidence',{})).manifest;
  assert.equal(evidence.report.completion.kind,'complete-with-exceptions',JSON.stringify({completion:evidence.report.completion,
    lifecycle:evidence.report.lifecycle,decision:evidence.report.decision,input:evidence.report.inputSha256,terminal:(await f.capture()).workflow.completion}));
  assert.ok(evidence.excluded.some(row=>row.reason==='reviewed-unselected-baseline-cases-are-not-executed'));
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const offline=f.make({working:null,sources:[],checks:undefined,clock:{now(){throw Error('Replay cannot use a new host or clock.');}}});
  assert.equal((await offline.run('phase.publish',{phaseId:'release',...publish})).status,'retained');
});
