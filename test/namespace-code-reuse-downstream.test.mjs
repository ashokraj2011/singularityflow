import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceCodeReuseFixture,reuseReason} from './helpers/namespace-code-reuse-fixture.mjs';
import {verificationWorkflow,codeInputArtifact} from './helpers/namespace-code-input-fixture.mjs';
import {releaseReport} from './helpers/namespace-release-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
const publish={authored:'governed-agent',channel:'copilot-host'};
for(const backend of ['filesystem','sqlite','application'])test('two repositories retain full Code reuse and original-owner renewal through Release: '+backend,{timeout:180000},async t=>{
 const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`')
  .replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
  +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n';
 const f=await namespaceCodeReuseFixture(t,{backend,recovery:true,repositories:2,plan,configure:source=>{
  verificationWorkflow(source);source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',
   writeScope:'artifact-only',inputs:[{phase:'build'},{phase:'verify'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
   approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
  source.definition.workTypes.simple.phases.push('release');source.agents.push({...source.agents[0],id:'release-author',label:'Release author',phases:['release'],defaultFor:['release']});
 }});
 async function approve(phaseId){await f.engine.run('phase.submit',{phaseId});f.human();const binding=(await f.engine.run('phase.review',{phaseId})).manifest.reviewBinding;
  await f.engine.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256}});}
 async function write(phaseId,text){await f.engine.run('phase.prepare',{phaseId});const draft=await f.engine.run('phase.draft.read',{phaseId});
  await f.engine.run('phase.draft.write',{operationId:'write-qualified-'+phaseId,workId:f.inputs.workId,phaseId,expectedRevision:draft.manifest.draft.revision,
   content:await f.upload(text),reason:reuseReason});}
 const decisions=await f.decideAll({expires:'2026-11-09'});assert.equal(decisions.length,2);await f.rebase();
 await f.engine.run('phase.publish',{phaseId:'build',...publish});await approve('build');assert.equal(f.starts(),2);
 f.author();f.control.agentId='verifier';f.control.now='2026-11-10T00:00:00.000Z';await write('verify',codeInputArtifact);
 await assert.rejects(f.engine.run('phase.publish',{phaseId:'verify',...publish}),error=>error.code==='ENGINE_EVIDENCE_REUSE_NOT_CURRENT'
  &&error.details.actions[0].inputs.phaseId==='build');
 const renewals=await f.decideAll({expires:'2026-12-01'});assert.equal(renewals.length,2);
 assert.deepEqual(renewals.map(row=>row.record.producer),decisions.map(row=>row.record.producer));
 f.author();f.control.agentId='verifier';const draft=await f.engine.run('phase.draft.read',{phaseId:'verify'});
 await f.engine.run('phase.draft.rebase',{operationId:'continue-qualified-verification',workId:f.inputs.workId,phaseId:'verify',expectedRevision:draft.manifest.draft.revision,
  confirm:draft.manifest.draft.bodySha256,reason:reuseReason});
 await f.engine.run('phase.publish',{phaseId:'verify',...publish});
 const state=await f.capture(),publication=await f.json(state.workflow.phases.verify.publicationBindings[0].record),
  binding=publication.policyEvidence.find(row=>row.kind==='approved-code-inputs/v4'),manifest=await f.json(binding.record),report=await f.json(manifest.report),producer=report.inputs.find(row=>row.phase==='build');
 assert.equal(producer.testReuse.receiverExecuted,false);assert.equal(producer.testReuse.checks.operationId,f.producer.producerOperationId);
 assert.equal(producer.tests.length,2);assert.ok(producer.tests.every(row=>row.tests.passed===1&&row.tests.failed===0));assert.equal(publication.checks,null);
 await approve('verify');f.author();f.control.agentId='release-author';await write('release',releaseReport());
 await f.engine.run('phase.publish',{phaseId:'release',...publish});await approve('release');
 f.control.permissions.push('story.evidence');assert.equal(f.starts(),2);const evidence=(await f.engine.run('story.evidence',{})).manifest;
 assert.equal(evidence.report.completion.kind,'complete',JSON.stringify(evidence.report.completion));
 assert.ok(evidence.report.rows.some(row=>row.executionPolicy?.kind==='evidence-reuse'&&row.executionPolicy.disposition==='active'&&row.result==='satisfied'));
 assert.ok(!evidence.excluded.some(row=>row.reason.includes('not-executed')||row.reason.includes('risk')));
 for(const root of f.roots)await rm(root,{recursive:true,force:true});
 const offline=f.make({working:null,sources:[],checks:undefined,clock:{now(){throw Error('Replay cannot restamp original approvals or executions.');}}});
 assert.equal((await offline.run('phase.publish',{phaseId:'release',...publish})).status,'retained');
});
