import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceCodeReuseFixture} from './helpers/namespace-code-reuse-fixture.mjs';
const publish={phaseId:'build',authored:'governed-agent',channel:'copilot-host'};
for(const backend of ['filesystem','sqlite','application'])for(const recovery of [false,true])test('qualified Code reuse retains actual acceptance: '+backend+' recovery='+recovery,{timeout:180000},async t=>{
 const f=await namespaceCodeReuseFixture(t,{backend,recovery}),view=await f.view();assert.equal(view.manifest.profile,'sflow-namespace-evidence-reuse-context/v3');
 const {request,result}=await f.decide();assert.equal(result.record.schemaVersion,3);await f.rebase();
 await f.engine.run('phase.publish',publish);const phase=(await f.capture()).workflow.phases.build,publication=await f.json(phase.publicationBindings[0].record),binding=publication.policyEvidence.find(row=>row.kind==='code-delivery/v39'),manifest=await f.json(binding.record),report=await f.json(manifest.report);
 assert.equal(publication.checks,null);assert.equal(publication.policyEvidence.some(row=>row.kind==='test-recovery/v3'),recovery);assert.equal(report.reusedExecution.receiverExecuted,false);assert.equal(report.reusedExecution.checks.operationId,f.producer.producerOperationId);assert.equal(f.starts(),1);
 await f.engine.run('phase.submit',{phaseId:'build'});f.human();const review=(await f.engine.run('phase.review',{phaseId:'build'})).manifest.reviewBinding;
 await f.engine.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:review.generation,reviewPacketSha256:review.packetSha256}});
 await rm(f.root,{recursive:true,force:true});const offline=f.make({working:undefined,sources:[],checks:{mode:'retained-only'},clock:{now(){throw Error('Do not restamp accepted reuse.');}}});
 assert.deepEqual((await offline.run('decision.evidence-reuse',request)).record,result.record);f.author();assert.equal((await offline.run('phase.publish',publish)).status,'retained');
});
