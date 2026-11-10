import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {WITNESS_CHECKLIST} from '../src/kernel/human-witnesses.mjs';
import {releaseReport,releasePublish} from './helpers/namespace-release-fixture.mjs';
test('a human-corrected retained output carries its real Code execution and witness through Release and shared-only takeover',{timeout:180000},async t=>{
  let human,file,input,recorded;
  const f=await namespaceTestWitnessFixture(t,{configure(source){source.definition.phases.release={label:'Release conformance',
    artifact:{path:'artifacts/release/conformance.md',kind:'conformance-report'},defaultTemplate:'intake.md',writeScope:'artifact-only',
    inputs:[{phase:'build'}],testEvidenceFrom:'build',specificationQuality:{mode:'off'},clarification:{mode:'off',markers:{mode:'off'}},
    approval:{authorities:['reviewers'],minimum:1,rejectTo:['build'],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push('release');source.agents.push({...source.agents[0],id:'release-author',label:'Release author',phases:['release'],defaultFor:['release']});},
    async afterPrepare(f,engine){file='singularity/work-items/'+f.inputs.workId+'/evidence/approved-output.png';
      // This isolated byte fixture establishes storage/provenance behavior, not a production screenshot.
      const content=(await f.content.put(f.scope,'evidence',Buffer.from([137,80,78,71,13,10,26,10]))).reference;
      human=createNamespaceEngine({...f.common,access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
        identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['plan.correction.context','plan.correction.record','witness.context','decision.witness']})}});
      const request={ownerPhase:'design',reason:'Correct the retained-output contract while preserving original tests and separate human visual review.',
        operations:[{op:'reclassify-evidence',clauseId:'STORY-1:AC-001',path:file,method:'visual',content}]},
        context=await human.run('plan.correction.context',request);
      input={...request,operationId:'release-evidence-classification',expectedPreview:'sha256:'+context.manifest.preview.previewSha256};recorded=await human.run('plan.correction.record',input);
      const draft=await engine.run('phase.draft.read',{phaseId:'build'});await engine.run('phase.draft.rebase',{operationId:'release-evidence-continue',workId:f.inputs.workId,
        phaseId:'build',expectedRevision:draft.manifest.draft.revision,confirm:draft.manifest.draft.bodySha256,reason:'Continue this Code generation after the exact human correction.'});
    }});
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await assert.rejects(f.approve('build'),{code:'ENGINE_WITNESS_DECISION_REQUIRED'});
  const query={clauseId:'STORY-1:AC-001',slotName:'retained-evidence',file},view=await human.run('witness.context',query);
  await human.run('decision.witness',{...query,operationId:'release-exact-witness',expectedContext:view.manifest.contextBinding,
    expectedFile:'sha256:'+view.manifest.file.content.sha256,answers:Object.fromEntries(WITNESS_CHECKLIST.map(id=>[id,'yes'])),
    reason:'The fixture reviewer inspected this retained result for the exact approved criterion.'});
  assert.equal((await f.approve('build')).approval.selfApproval,false);f.control.agentId='release-author';
  await f.engine.run('phase.prepare',{phaseId:'release'});const draft=await f.engine.run('phase.draft.read',{phaseId:'release'});
  await f.engine.run('phase.draft.write',{operationId:'release-corrected-output-conformance',workId:f.inputs.workId,phaseId:'release',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload(releaseReport()),reason:'Account for actual retained tests and separately authorized human acceptance.'});
  await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});assert.equal((await f.approve('release')).approval.selfApproval,false);
  const snapshot=await f.capture();assert.equal(snapshot.workflow.status,'closed');assert.equal(f.starts(),1,'Release cannot relabel an inherited run as new execution');
  assert.deepEqual(await human.run('plan.correction.record',input),recorded);assert.deepEqual(await f.capture(),snapshot);
  const shared=createNamespaceEngine({...f.common,clock:{now(){throw Error('Shared replay cannot restamp accepted publication.');}}});
  assert.equal((await shared.run('phase.publish',{phaseId:'release',...releasePublish})).status,'retained');
});
