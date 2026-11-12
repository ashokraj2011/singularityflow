import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {planText} from './helpers/namespace-specification-fixture.mjs';
import {WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
const plan=planText+'\n## Verification contracts\n\n| Criterion | Slot | Method | Witness | Role | Combination |\n| --- | --- | --- | --- | --- | --- |\n'
  +'| STORY-1:AC-001 | tests | test | `test/converter.test.js` | primary | all |\n'
  +'| STORY-1:AC-001 | converter-screen | visual | `converter` | primary | all |\n';
test('visual decisions expose actual retained candidates and remain a separate human ceremony',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend:'sqlite',plan,configure(source){source.definition.artifactSets={delivery:{primary:'summary.md',members:[
    {path:'summary.md',role:'implementation-summary',required:true},{path:'proof.png',role:'supporting-evidence',required:true}]}};source.definition.phases.build.artifactSet='delivery';},
    async afterPrepare(f,engine){f.control.permissions.push('phase.artifact.attach','phase.artifact.inspect','decisions.list','decisions.record','witness.context','decision.witness');
      const draft=await engine.run('phase.draft.read',{phaseId:'build'});
      await engine.run('phase.artifact.attach',{operationId:'decision-list-fixture-image',workId:f.inputs.workId,phaseId:'build',memberPath:'proof.png',
        expectedRevision:draft.manifest.draft.revision,content:await f.upload(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])),
        reason:'Retain an isolated binary fixture; this is not production visual evidence.'});}});
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const before=await f.capture(),listed=await f.engine.run('decisions.list'),item=listed.manifest.policy.items.find(row=>row.kind==='human-witness');assert.ok(item);
  const action=listed.manifest.actions.find(row=>row.item===item.id&&row.inputs.file.endsWith('/proof.png'));assert.ok(action);
  for(const candidate of listed.manifest.actions.filter(row=>row.item===item.id))assert.equal((await f.engine.run(candidate.operation,candidate.inputs)).manifest.result.status,'missing');
  await assert.rejects(f.engine.run('decisions.record',{confirmation:listed.manifest.policy.packetSha256,answers:{choose:{[item.id]:action.option}}}),
    {code:'DECISIONS_OPTION_NOT_RECORDABLE'});assert.deepEqual(await f.capture(),before);
  const context=await f.engine.run('witness.context',action.inputs);
  await f.engine.run('decision.witness',{operationId:'independent-list-fixture-witness',...action.inputs,expectedContext:context.manifest.contextBinding,
    expectedFile:'sha256:'+context.manifest.file.content.sha256,answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),
    reason:'The independent fixture reviewer inspected the exact retained candidate under this approved contract.'});
  assert.equal((await f.engine.run('decisions.list')).manifest.policy.items.some(row=>row.kind==='human-witness'),false);
  assert.equal((await f.capture()).workflow.phases.build.status,'in_progress');
});
