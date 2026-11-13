import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceKnownTestRiskFixture} from './helpers/namespace-known-test-risk-fixture.mjs';
import {converterSource} from './helpers/namespace-source-clause-fixture.mjs';
import {verificationWorkflow,codeInputArtifact} from './helpers/namespace-code-input-fixture.mjs';import {releaseReport} from './helpers/namespace-release-fixture.mjs';
test('reviewed successors retain known failures separately and require a fresh exact generation risk decision',{timeout:180000},async t=>{
  const f=await namespaceKnownTestRiskFixture(t,{configure:source=>{
    verificationWorkflow(source);source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',writeScope:'artifact-only',
      inputs:[{phase:'build'},{phase:'verify'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
      approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('release');source.agents.push({...source.agents[0],id:'release-author',label:'Release author',phases:['release'],defaultFor:['release']});
  }});f.control.permissions.push('phase.rollover','phase.begin');f.human();await f.engine.run('test-risk.confirm-known',f.request);
  f.author();await f.rebase('risk-before-first-publication');await f.retain('risk-first-publication-source');await f.run('risk-first-publication-checks');
  const input={phaseId:'build',authored:'governed-agent',channel:'copilot-host'},publish=async label=>{
    try{return await f.engine.run('phase.publish',input);}catch(error){t.diagnostic(label+': '+JSON.stringify({code:error.code,details:error.details}));throw error;}
  };await publish('original publication');
  await writeFile(path.join(f.root,'src/converter.js'),converterSource+'// The current reviewed successor still converts the exact approved input.\n');
  const view=await f.engine.run('phase.rollover',{phaseId:'build'});await f.engine.run('phase.rollover',{phaseId:'build',confirm:view.plan.confirmation});
  await f.retain('risk-successor-source');await f.run('risk-successor-checks');
  await assert.rejects(f.engine.run('phase.publish',input),{code:'TEST_RUN_RISK_NOT_COVERED'});
  const context={phaseId:'build',baselineOperationId:'original-pre-feature-checks',observedOperationId:'risk-successor-checks'},review=await f.engine.run('test-risk.known-context',context);
  f.human();await f.engine.run('test-risk.confirm-known',{...f.request,...context,operationId:'risk-successor-human-review',expectedContext:review.manifest.expectedContext});
  f.author();await f.rebase('risk-successor-actual-continuation');await f.retain('risk-successor-final-source');await f.run('risk-successor-final-checks');
  await publish('reviewed successor publication');const snapshot=await f.capture(),publication=await f.json(snapshot.workflow.phases.build.publicationBindings.at(-1).record),
    binding=publication.policyEvidence.find(row=>row.kind==='code-delivery/v37'),manifest=await f.json(binding.record),report=await f.json(manifest.report);
  assert.equal(report.evidenceVersion,34);assert.equal(report.executionException.testsPassed,false);assert.equal(report.executionException.failedAcceptanceWaived,false);
  assert.equal(snapshot.workflow.phases.build.publicationBindings.length,2);assert.equal(snapshot.workflow.namespaceKnownTestRisks.length,2);
  await f.engine.run('phase.submit',{phaseId:'build'});f.human();const b=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
  await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:b.generation,reviewPacketSha256:b.packetSha256}});
  const starts=f.starts();
  for(const [phaseId,agentId,text]of [['verify','verifier',codeInputArtifact],['release','release-author',releaseReport()]]){
    f.author();f.control.agentId=agentId;await f.engine.run('phase.prepare',{phaseId});const d=await f.engine.run('phase.draft.read',{phaseId});
    await f.engine.run('phase.draft.write',{operationId:'reviewed-risk-'+phaseId,workId:f.inputs.workId,phaseId,expectedRevision:d.manifest.draft.revision,
      content:await f.upload(text),reason:'Carry the approved successor\'s actual failed legacy run and passing acceptance without inventing a receiving execution.'});
    await f.engine.run('phase.publish',{...input,phaseId});await f.engine.run('phase.submit',{phaseId});f.human();const binding=(await f.engine.run('phase.review',{phaseId})).manifest.reviewBinding;
    await f.engine.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  }
  assert.equal(f.starts(),starts,'Verification and Release retain Code execution rather than rerun or relabel it');
  assert.equal((await f.engine.run('story.evidence',{})).manifest.report.completion.kind,'complete-with-exceptions');
});
