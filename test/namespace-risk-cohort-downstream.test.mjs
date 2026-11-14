import test from 'node:test';import assert from 'node:assert/strict';import {rm,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
import {namespaceCombinedRiskFixture} from './helpers/namespace-combined-risk-fixture.mjs';
import {verificationWorkflow} from './helpers/namespace-code-input-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';import {releaseReport} from './helpers/namespace-release-fixture.mjs';
const publish={authored:'governed-agent',channel:'copilot-host'},backends=['filesystem','sqlite','application'],kinds=['known','environment'];
async function journey(t,kind,backend){
 const plan=planText.replaceAll('`src/converter.js`','`frontend/src/converter.js`, `backend/src/converter.js`').replaceAll('`test/converter.test.js`','`frontend/test/converter.test.js`, `backend/test/converter.test.js`')
  +'\n## Repository roots\n\n| Repository | Plan root |\n| --- | --- |\n| app | frontend |\n| service-1 | backend |\n',
  f=await namespaceCombinedRiskFixture(t,{kind,backend,repositories:2,plan,configure(source){source.definition.testRecovery.maxEvidenceAgeSeconds=30*86400;verificationWorkflow(source);
    source.definition.phases.release={label:'Release',artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',writeScope:'artifact-only',
      inputs:[{phase:'build'},{phase:'verify'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
      approval:{authorities:['reviewers'],minimum:1,rejectTo:['build','release'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('release');source.agents.push({...source.agents[0],id:'release-author',label:'Release author',phases:['release'],defaultFor:['release']});}}),
  tracing=process.env.SFLOW_TEST_JOURNEY_TIMINGS==='1',engine=tracing?{async run(operation,input){const started=performance.now();
    process.stderr.write(JSON.stringify({stage:operation,phase:input.phaseId??null,event:'start'})+'\n');
    try{return await f.engine.run(operation,input);}finally{process.stderr.write(JSON.stringify({stage:operation,phase:input.phaseId??null,event:'end',ms:Math.round(performance.now()-started)})+'\n');}}}:f.engine;
 if(tracing)process.stderr.write(JSON.stringify({stage:'fixture-ready',elapsedMs:Math.round(performance.now())})+'\n');
 f.control.permissions.push('upstream.raise','upstream.decide');let writes=0;
 async function approve(phaseId){await engine.run('phase.submit',{phaseId});f.human();const b=(await engine.run('phase.review',{phaseId})).manifest.reviewBinding;
  return engine.run('phase.approve',{phaseId,confirmation:{workId:f.inputs.workId,phase:phaseId,generation:b.generation,reviewPacketSha256:b.packetSha256}});}
 async function author(phaseId,text,prepare=true){if(prepare)await engine.run('phase.prepare',{phaseId});const draft=(await engine.run('phase.draft.read',{phaseId})).manifest.draft;
  return engine.run('phase.draft.write',{operationId:'author-combined-'+phaseId+'-'+(++writes),phaseId,workId:f.inputs.workId,expectedRevision:draft.revision,content:await f.upload(text),reason:f.reason});}
 async function report(phaseId,prefix){const p=await f.json((await f.capture()).workflow.phases[phaseId].publicationBindings[0].record),b=p.policyEvidence.find(row=>row.kind.startsWith(prefix)),m=await f.json(b.record);
  return {publication:p,binding:b,manifest:m,report:await f.json(m.report)};}
 await engine.run('phase.publish',{phaseId:'build',...publish});await approve('build');const starts=f.starts();f.author();f.control.agentId='verifier';f.control.now='2026-11-21T00:00:00.000Z';
 await author('verify','# Verification\n\n## Agent brief\n\nOriginal selected tests and failed evidence remain attributed to Code. This phase did not execute another test or turn the failure into a pass.\n');
 await assert.rejects(engine.run('phase.publish',{phaseId:'verify',...publish}),error=>['TEST_RUN_RISK_NOT_COVERED','SELECTIVE_TEST_RECOVERY_NOT_CURRENT','TEST_COHORT_NOT_COVERED'].includes(error.code));
 const empty=f.make({working:null,sources:[],sourceReaders:[],checks:{mode:'retained-only'}});f.human();
 await empty.run(kind==='known'?'test-risk.confirm-known':'test-risk.confirm-recovery',{...f.riskRequest,operationId:'renew-original-failure',expires:'2026-11-28'});
 await empty.run('test-recovery.select-confirm',{...f.selectionRequest,operationId:'renew-original-scope',expires:'2026-11-28'});
 await empty.run('test-cohort.confirm',{...f.cohortRequest,operationId:'renew-original-cohort',expires:'2026-11-28'});
 f.author();f.control.agentId='verifier';const draft=(await engine.run('phase.draft.read',{phaseId:'verify'})).manifest.draft;
 await engine.run('phase.draft.rebase',{operationId:'continue-combined-verification',workId:f.inputs.workId,phaseId:'verify',expectedRevision:draft.revision,confirm:draft.bodySha256,reason:f.reason});
 assert.equal((await engine.run('phase.prepublish',{phaseId:'verify'})).manifest.qualityDisposition,'ready');
 const filename=path.join(f.roots[1],'src/converter.js'),bytes=await readFile(filename);await writeFile(filename,Buffer.concat([bytes,Buffer.from('\n// Unreviewed receiving change\n')]));
 await assert.rejects(engine.run('phase.publish',{phaseId:'verify',...publish}),{code:'PRIOR_CODE_TEST_EVIDENCE_REQUIRED'});await writeFile(filename,bytes);
 await engine.run('phase.publish',{phaseId:'verify',...publish});const verification=await report('verify','approved-code-inputs/'),input=verification.report.inputs.find(row=>row.phase==='build');
 assert.equal(verification.binding.kind,kind==='known'?'approved-code-inputs/v7':'approved-code-inputs/v6');assert.equal(input.executionRisk.testsPassed,false);
 assert.equal(input.testSelection.receiverExecuted,false);assert.equal(input.testSelection.excluded.length,2);assert.equal(input.tests.filter(row=>row.tests.failed===1).length,2);
 await approve('verify');let markdown=releaseReport();
 if(kind==='environment'){f.human();await engine.run('upstream.raise',{operationId:'disclose-unavailable-acceptance',workId:f.inputs.workId,phaseId:'build',
   about:'STORY-1:AC-001 original test execution',problem:'STORY-1:AC-001 remains partial because the genuine service-dependent test failed in Code; it has no passing receiving execution.',proposed:'accept-risk',authored:'human'});
  await engine.run('upstream.decide',{operationId:'review-unavailable-acceptance',workId:f.inputs.workId,issueId:'UPI-001',outcome:'accept-risk',
    reason:'The authorized producer reviewer accepts the disclosed service limitation for this exact generation and clause.',expires:'2026-11-22T00:00:00.000Z'});
  markdown=markdown.replace('| STORY-1:AC-001 | matched |','| STORY-1:AC-001 | partial UPI-001 |');}
 f.author();f.control.agentId='release-author';await author('release',kind==='environment'?releaseReport():markdown);
 if(kind==='environment'){await assert.rejects(engine.run('phase.publish',{phaseId:'release',...publish}),error=>error.code==='ARTIFACT_AUTHORING_INCOMPLETE'&&error.details.findings.some(row=>row.code==='conformance.evidence-not-matched'));
  await author('release',markdown,false);}
 await engine.run('phase.publish',{phaseId:'release',...publish});const release=await report('release','conformance/');
 assert.equal(release.binding.kind,kind==='known'?'conformance/v3':'conformance/v6');assert.ok(release.report.executionExceptions.every(row=>row.testsPassed===false&&row.receiverExecuted===false));
 await approve('release');assert.equal(f.starts(),starts);assert.equal((await engine.run('story.evidence',{})).manifest.report.completion.kind,'complete-with-exceptions');
 for(const root of f.roots)await rm(root,{recursive:true,force:true});f.author();f.control.agentId='release-author';const offline=f.make({working:null,sources:[],checks:{mode:'retained-only'},clock:{now(){throw Error('Receipt replay cannot restamp or recreate an execution.');}}});
 assert.equal((await offline.run('phase.publish',{phaseId:'release',...publish})).status,'retained');
}
const worker=process.argv.indexOf('--combined-risk-journey');
if(worker>=0){const kind=process.argv[worker+1],backend=process.argv[worker+2];assert.ok(kinds.includes(kind));assert.ok(backends.includes(backend));
 // This is an actual headless consumer. The outer test owns its deadline and assertions;
 // avoid a second test harness tracking every promise inside the SDK and filesystem ports.
 const cleanup=[];try{await journey({after(callback){cleanup.push(callback);}},kind,backend);
  process.stdout.write('two repositories carry '+kind+' scope and failure permissions through Release: '+backend+'\n');}
 finally{const results=await Promise.allSettled(cleanup.toReversed().map(callback=>callback()));for(const result of results)if(result.status==='rejected')throw result.reason;}
}else for(const kind of kinds)for(const backend of backends)test('two repositories carry '+kind+' scope and failure permissions through Release: '+backend,{timeout:180000},async t=>{
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const result=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),'--combined-risk-journey',kind,backend],{env,timeout:170000,maxBuffer:2*1024*1024});
 assert.ok(result.stdout.includes('two repositories carry '+kind+' scope and failure permissions through Release: '+backend));
 if(env.SFLOW_TEST_JOURNEY_TIMINGS==='1'&&result.stderr.trim())t.diagnostic(result.stderr.trim());
});
