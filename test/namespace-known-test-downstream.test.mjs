import test from 'node:test';import assert from 'node:assert/strict';import {rm,readFile,writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceKnownTestRiskFixture} from './helpers/namespace-known-test-risk-fixture.mjs';
import {verificationWorkflow,codeInputArtifact} from './helpers/namespace-code-input-fixture.mjs';
import {releaseReport} from './helpers/namespace-release-fixture.mjs';
const publish={authored:'governed-agent',channel:'copilot-host'};
test('approved known failures carry honest Code evidence into Verification and Release, with original-owner renewal',{timeout:180000},async t=>{
  const f=await namespaceKnownTestRiskFixture(t,{configure:source=>{
    source.definition.testRecovery.maxEvidenceAgeSeconds=30*86400;verificationWorkflow(source);
    source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',
      writeScope:'artifact-only',inputs:[{phase:'build'},{phase:'verify'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
      approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('release');
    source.agents.push({...source.agents[0],id:'release-author',label:'Release author',phases:['release'],defaultFor:['release']});
  }});
  f.control.permissions.push('phase.context.read','phase.enter');
  async function approve(phaseId){await f.engine.run('phase.submit',{phaseId});f.human();
    const b=(await f.engine.run('phase.review',{phaseId})).manifest.reviewBinding;
    return f.engine.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:b.generation,reviewPacketSha256:b.packetSha256}});}
  async function write(phaseId,content){await f.engine.run('phase.prepare',{phaseId});const d=await f.engine.run('phase.draft.read',{phaseId});
    await f.engine.run('phase.draft.write',{phaseId,operationId:'write-known-downstream-'+phaseId,workId:f.inputs.workId,expectedRevision:d.manifest.draft.revision,
      content:await f.upload(content),reason:'Retain original producer results and reviewed exceptions without claiming another execution.'});}
  async function report(phaseId,prefix){const s=await f.capture(),p=await f.json(s.workflow.phases[phaseId].publicationBindings.at(-1).record),
    b=p.policyEvidence.find(row=>row.kind.startsWith(prefix)),m=await f.json(b.record);return {publication:p,binding:b,report:await f.json(m.report)};}
  f.human();await f.engine.run('test-risk.confirm-known',f.request);f.author();await f.rebase('continue-before-downstream');
  await f.retain('original-downstream-source');await f.run('original-downstream-tests');
  await f.engine.run('phase.publish',{phaseId:'build',...publish});await approve('build');const starts=f.starts();
  f.author();f.control.agentId='verifier';f.control.now='2026-11-21T00:00:00.000Z';await write('verify',codeInputArtifact);
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'verify',...publish}),error=>error.code==='TEST_RUN_RISK_NOT_COVERED'
    &&error.details.actions.some(row=>row.operation==='test-risk.known-context'&&row.inputs.phaseId==='build'));
  f.human();await f.engine.run('test-risk.confirm-known',{...f.request,operationId:'renew-producer-during-verification',expires:'2026-12-01'});
  f.author();f.control.agentId='verifier';const d=await f.engine.run('phase.draft.read',{phaseId:'verify'});
  await f.engine.run('phase.draft.rebase',{operationId:'continue-verification-with-renewal',workId:f.inputs.workId,phaseId:'verify',expectedRevision:d.manifest.draft.revision,
    confirm:d.manifest.draft.bodySha256,reason:'Continue the unchanged verification using the original producer permission renewal.'});
  // Fresh source comparison is still mandatory for an inherited failed run.
  const filename=path.join(f.root,'src/converter.js'),bytes=await readFile(filename);await writeFile(filename,Buffer.concat([bytes,Buffer.from('\n// Another change.\n')]));
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'verify',...publish}),{code:'PRIOR_CODE_TEST_EVIDENCE_REQUIRED'});await writeFile(filename,bytes);
  await f.engine.run('phase.publish',{phaseId:'verify',...publish});const v=await report('verify','approved-code-inputs/');
  assert.equal(v.binding.kind,'approved-code-inputs/v2');assert.equal(v.publication.checks,null);const row=v.report.inputs.find(row=>row.phase==='build');
  assert.equal(row.tests.find(row=>row.commandId==='legacy-tests').tests.failed,1);assert.equal(row.tests.find(row=>row.commandId==='legacy-tests').disposition,'accepted-known-failures');
  assert.equal(row.executionRisk.testsPassed,false);assert.equal(row.executionRisk.failedAcceptanceWaived,false);assert.equal(row.executionRisk.policy.kind,'known-test-risk/v1');
  await approve('verify');f.author();f.control.agentId='release-author';await write('release',releaseReport());
  await f.engine.run('phase.publish',{phaseId:'release',...publish});const r=await report('release','conformance/');
  assert.equal(r.binding.kind,'conformance/v3');assert.equal(r.report.inputs.schemaVersion,2);assert.equal(r.report.executionExceptions[0].receiverExecuted,false);
  assert.equal(r.report.executionExceptions[0].testsPassed,false);assert.ok(r.report.rows.every(row=>row.verdict==='matched'));
  await approve('release');assert.equal(f.starts(),starts,'neither downstream phase invents or starts another test execution');
  const e=(await f.engine.run('story.evidence',{})).manifest;assert.equal(e.report.completion.kind,'complete-with-exceptions');
  assert.ok(e.excluded.some(row=>row.reason==='known-baseline-failures-remain-failed'));
  await rm(f.root,{recursive:true,force:true});const shared=f.make({working:null,sources:[],checks:undefined,clock:{now(){throw Error('Shared replay cannot restamp an accepted run.');}}});
  assert.equal((await shared.run('phase.publish',{phaseId:'release',...publish})).status,'retained');
  assert.equal((await shared.run('phase.publish',{phaseId:'verify',...publish})).status,'retained');
});
