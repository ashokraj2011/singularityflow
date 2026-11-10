import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
const plan=planText+'\n## Verification contracts\n\n| Criterion | Slot | Method | Witness | Role | Combination |\n| --- | --- | --- | --- | --- | --- |\n'
  +'| STORY-1:AC-001 | tests | test | `test/converter.test.js` | primary | all |\n'
  +'| STORY-1:AC-001 | converter-screen | visual | `converter` | primary | all |\n';
const image=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]); // An isolated binary fixture, never production visual evidence.
async function fixture(t,backend){return namespaceTestWitnessFixture(t,{backend,plan,configure(source){source.definition.artifactSets={delivery:{primary:'summary.md',members:[
  {path:'summary.md',role:'implementation-summary',required:true},{path:'proof.png',role:'supporting-evidence',required:true}]}};source.definition.phases.build.artifactSet='delivery';},
  async afterPrepare(f,engine){f.control.permissions.push('phase.artifact.attach','phase.artifact.inspect');const draft=await engine.run('phase.draft.read',{phaseId:'build'});
    await engine.run('phase.artifact.attach',{operationId:'attach-fixture-output',workId:f.inputs.workId,phaseId:'build',memberPath:'proof.png',
      expectedRevision:draft.manifest.draft.revision,content:await f.upload(image),reason:'Retain this isolated binary member as fixture evidence.'});}});}
for(const backend of ['filesystem','sqlite','application'])test(backend+': an exact human witness completes a mixed verification contract and survives shared-only replay',{timeout:180000},async t=>{
  const f=await fixture(t,backend),publication=await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  assert.equal(publication.status,'published');const current=await f.capture(),bound=current.workflow.phases.build.publicationBindings[0],published=await f.json(bound.record);
  const proof=published.policyEvidence.find(row=>row.kind==='code-delivery/v7');assert.ok(proof);const report=await f.json((await f.json(proof.record)).report);
  assert.equal(report.preflight.profile,'sflow-namespace-code-preflight/v1');assert.equal(report.acceptance[0].contract.slots.length,2);
  assert.equal(Object.hasOwn(report.acceptance[0],'humanAccepted'),false);
  const submitted=await f.engine.run('phase.submit',{phaseId:'build'});assert.equal(submitted.status,'awaiting-approval');
  assert.equal((await f.capture()).workflow.phases.build.status,'awaiting_approval');
  const access={current:request=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['witness.context','decision.witness','phase.approve']})},
    reviewer=f.make({checks:f.checks,access}),packet=await reviewer.run('phase.review.resources',{phaseId:'build'}),confirmation=packet.manifest.reviewBinding,
    approval={phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:confirmation.generation,reviewPacketSha256:confirmation.packetSha256}};
  await assert.rejects(reviewer.run('phase.approve',approval),error=>error.code==='ENGINE_WITNESS_DECISION_REQUIRED'&&error.details.criteria[0].slots.some(row=>row.method==='visual'&&row.status==='missing'));
  const file='singularity/work-items/'+f.inputs.workId+'/artifacts/build/proof.png',query={clauseId:'STORY-1:AC-001',slotName:'converter-screen',file},
    context=await reviewer.run('witness.context',query);assert.equal(context.manifest.result.status,'missing');assert.equal(context.manifest.file.content.namespace,'evidence');
  const decision={operationId:'confirmed-visual-fixture',workId:f.inputs.workId,...query,expectedContext:context.manifest.contextBinding,
    expectedFile:'sha256:'+context.manifest.file.content.sha256,answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),
    reason:'The fixture reviewer inspected this retained fixture output for the approved criterion.'};
  await assert.rejects(reviewer.run('decision.witness',{...decision,operationId:'wrong-reviewed-candidate',expectedContext:'sha256:'+'a'.repeat(64)}),{code:'WITNESS_REVIEW_CHANGED'});
  const recorded=await reviewer.run('decision.witness',decision);assert.equal(recorded.record.outcome,'met');assert.equal(recorded.record.contextBinding,context.manifest.contextBinding);
  assert.equal((await reviewer.run('witness.context',query)).manifest.result.status,'met');
  await assert.rejects(reviewer.run('decision.witness',{...decision,operationId:'duplicate-other-id'}),{code:'WITNESS_ALREADY_RECORDED'});
  const approved=await reviewer.run('phase.approve',approval);assert.equal(approved.status,'recorded');assert.equal((await f.capture()).workflow.status,'closed');
  const takeover=f.make({working:null,sources:[],sourceReaders:[],checks:undefined,access}),replay=await takeover.run('decision.witness',decision);
  assert.deepEqual(replay.record,recorded.record);assert.equal(replay.revision,recorded.revision);
  const retained=await takeover.run('phase.approve',approval);assert.equal(retained.revision,approved.revision);
  const decisionRef=(await f.capture()).workflow.namespaceDecisionReceipts.find(row=>row.operationId===decision.operationId).record,
    denied=Object.freeze(Object.assign(Error('Actual retained human record cannot be read on this device.'),{code:'EACCES'})),
    unavailable=f.make({working:null,access,content:{...f.content,async read(scope,reference,options){if(reference.sha256===decisionRef.sha256)throw denied;
      return f.content.read(scope,reference,options);}}});
  await assert.rejects(unavailable.run('witness.context',query),error=>error===denied,'a later invocation must reopen actual witness bytes');
});
