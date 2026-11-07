import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {createGitEngine} from '../src/engine-compatibility/git-publication.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {publishedPlanningStory,CLI} from './helpers/submitted-planning-story.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
const reason='The approved value lives in the result module; the old plan named the value module.';

async function fixture(t,id) {
  const f=await publishedPlanningStory(t,id,{configure(config){
    config.approvalAuthorities['architecture-reviewers']={label:'Plan owners',allowAnyGitIdentity:false,
      members:[{email:'history.tester@example.com'}]};
  }});
  f.cli('submit','planning','--skip-checks');f.cli('approve','planning','--yes');
  return f;
}

async function asActor(name,operation) {
  const old={mode:process.env.NODE_ENV,identity:process.env.SINGULARITY_FLOW_TEST_IDENTITY};
  process.env.NODE_ENV='test';process.env.SINGULARITY_FLOW_TEST_IDENTITY=name;
  try{return await operation();}finally{
    if(old.mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old.mode;
    if(old.identity===undefined)delete process.env.SINGULARITY_FLOW_TEST_IDENTITY;else process.env.SINGULARITY_FLOW_TEST_IDENTITY=old.identity;
  }
}

async function observedCli(f,name,args) {
  const file=path.join(f.directory,name+'.json');
  const result=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,
    CLI,'--no-model',...args,'--json'],{cwd:f.root,allowFailure:true,env:{...process.env,NODE_ENV:'test',
      SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  return {actual:JSON.parse(result.stdout),observed:JSON.parse(await readFile(file,'utf8'))};
}

test('SDK amendments and CLI supporting changes share native records and plan authority',async t=>{
  const id='SDK-PLAN-AMEND',f=await fixture(t,id),api=createSflow({root:f.root});
  const before=(await loadAcceptedStoryExecution(f.root,id)).workflow;
  await asActor('History Tester',async()=>{
    const receipt=await api.run('decision.plan',{workId:id,changes:[{kind:'add-location',clauseId:`${id}:REQ-002`,path:'src/helper.mjs'}],reason});
    assert.equal(receipt.recordKind,'plan-amendment');assert.equal(receipt.record.id,'PAM-001');
    assert.equal(receipt.authorityGroup,'architecture-reviewers');assert.equal(receipt.currentPhase,'implementation');
    assert.equal(f.git('rev-parse','HEAD'),receipt.revision);
  });
  const {actual,observed}=await observedCli(f,'amendment',['decision','plan',id,'--add-supporting','package.json=build-configuration',
    '--supporting-reason','The package manifest supports the approved implementation.','--reason',reason]);
  assert.equal(observed.operation,'decision.plan');
  assert.deepEqual(actual.data.amendment,observed.result.record);
  assert.equal(actual.data.commit,observed.result.revision);assert.equal(actual.data.pushed,observed.result.effects.pushed);
  const head=f.git('rev-parse','HEAD');
  await asActor('Unrelated Reviewer',async()=>{
    await assert.rejects(api.run('decision.plan',{workId:id,changes:[{kind:'add-location',clauseId:`${id}:REQ-002`,path:'src/other.mjs'}],reason}),
      {code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});
  });
  assert.equal(f.git('rev-parse','HEAD'),head);
  const after=(await loadAcceptedStoryExecution(f.root,id)).workflow;
  assert.equal(after.planAmendments.length,2);assert.equal(after.currentPhase,'implementation');
  assert.deepEqual(after.phases.planning.approvals,before.phases.planning.approvals);
});

test('headless correction preview, CLI preview and live-review port keep the exact approved plan binding',async t=>{
  const id='SDK-PLAN-CORRECT',f=await fixture(t,id),api=createSflow({root:f.root});
  const input={workId:id,ownerPhase:'planning',operations:[{op:'replace-location',clauseId:`${id}:REQ-002`,from:'src/value.mjs',to:'src/result.mjs'}],reason};
  const before=(await loadAcceptedStoryExecution(f.root,id)).workflow,head=f.git('rev-parse','HEAD');
  await asActor('History Tester',async()=>{
    const preview=await api.run('plan.correction.preview',input);
    assert.equal(preview.review.ownerPhase,'planning');assert.equal(preview.review.ownerGeneration,1);
    assert.equal(preview.currentPhase,'implementation');assert.deepEqual(preview.effects,{committed:false,pushed:false});
    assert.equal(f.git('rev-parse','HEAD'),head);
    const {actual,observed}=await observedCli(f,'correction-preview',['decision','plan',id,
      '--owner','planning','--replace-location',`${id}:REQ-002=src/value.mjs:src/result.mjs`,'--reason',reason,'--dry-run']);
    assert.equal(observed.operation,'plan.correction.preview');
    assert.equal(actual.data.previewSha256,preview.review.previewSha256);
    assert.deepEqual(actual.data.operations,preview.review.operations);
    assert.deepEqual(actual.data.authorityGroups,preview.review.authorityGroups);
    const outdir=await mkdtemp(fileURLToPath(new URL('../.bundle-test-plan-correction-',import.meta.url)));
    t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');
    await buildCliBundle({outdir});
    const bundled=run(process.execPath,[CLI,'--no-model','decision','plan',id,'--owner','planning',
      '--replace-location',`${id}:REQ-002=src/value.mjs:src/result.mjs`,'--reason',reason,'--dry-run','--json'],
      {cwd:f.root,allowFailure:true,env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',
        SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
    assert.equal(bundled.status,0,bundled.stdout+'\n'+bundled.stderr);
    assert.deepEqual(JSON.parse(bundled.stdout).data,actual.data,'packaged and source correction previews must match exactly');
    const duplicateRow=f.run(process.execPath,[CLI,'--no-model','decision','plan',id,'--add-row',`${id}:REQ-002=src/value.mjs`,
      '--test','test/value.test.mjs','--reason',reason,'--dry-run','--json'],{allowFailure:true});
    assert.notEqual(duplicateRow.status,0);
    const duplicateError=JSON.parse(duplicateRow.stdout).error;
    assert.equal(duplicateError.code,'PLAN_ROW_CORRECTION_INVALID');
    assert.match(duplicateError.message,/already has a row/u,'absent optional row flags must reach native row validation');
    await assert.rejects(api.run('plan.correct',input),{code:'ACTION_TERMINAL_PRESENTATION_REQUIRED'});
    assert.equal(f.git('rev-parse','HEAD'),head,'an ordinary API call cannot invent a human confirmation');
    let consumed=0;
    const cancelled=createGitEngine({root:f.root,planCorrectionInteraction:{capture:async()=>null,
      consume:async()=>{consumed++;throw new Error('cancelled review must not consume');}}});
    assert.equal((await cancelled.engine.run('plan.correct',input)).status,'cancelled');
    assert.equal(consumed,0);assert.equal(f.git('rev-parse','HEAD'),head);
    const seen=[];
    const confirmed=createGitEngine({root:f.root,planCorrectionInteraction:{
      capture:async(root,plan,action)=>{
        assert.equal(root,f.root);assert.equal(plan.subject.phaseId,'planning');
        assert.equal(plan.planHash,preview.review.previewSha256);assert.equal(action.confirmation.required,true);
        seen.push(structuredClone(plan));
        plan.operations.push({op:'injected-after-preview'});
        return {token:'test-live-review'};
      },
      consume:async(root,token,plan,action,options)=>{
        consumed++;assert.equal(token,'test-live-review');assert.equal(options.requireTerminalPresentation,true);
        assert.deepEqual(plan.operations,preview.review.operations,'host mutation cannot rewrite the internal reviewed card');
        assert.equal(action.actionId,`PRC-${preview.review.previewSha256.slice(0,24)}`);
        return {authorizationId:randomUUID()};
      }
    }});
    const recorded=await confirmed.engine.run('plan.correct',input);
    assert.equal(recorded.record.id,'PRC-001');assert.equal(recorded.record.ownerPhase,'planning');
    assert.equal(recorded.record.ownerMapSha256,before.phases.planning.claimMaps.planned.sha256);
    assert.equal(recorded.record.ownerGeneration,1);assert.equal(recorded.currentPhase,'implementation');
    assert.equal(recorded.authorityGroup,'architecture-reviewers');assert.equal(consumed,1);
    assert.deepEqual(seen[0].rowsBefore[`${id}:REQ-002`].expectedPaths,['src/value.mjs']);
    assert.equal(f.git('rev-parse','HEAD'),recorded.revision);
    const after=(await loadAcceptedStoryExecution(f.root,id)).workflow;
    assert.equal(after.currentPhase,'implementation');assert.equal(after.phases.implementation.generation,0);
    assert.deepEqual(after.phases.planning.approvals,before.phases.planning.approvals);
    assert.equal(after.planAmendments.length,1);
  });
});

test('a correction recorded by another session during review is preserved and the stale review never consumes consent',async t=>{
  const id='SDK-PLAN-RACE',f=await fixture(t,id);
  const operations=[{op:'replace-location',clauseId:`${id}:REQ-002`,from:'src/value.mjs',to:'src/result.mjs'}];
  await asActor('History Tester',async()=>{
    let innerRevision=null,outerConsumes=0;
    const inner=createGitEngine({root:f.root,planCorrectionInteraction:{
      capture:async()=>({token:'concurrent-live-review'}),consume:async()=>({authorizationId:randomUUID()})}});
    const outer=createGitEngine({root:f.root,planCorrectionInteraction:{
      capture:async()=>{
        const result=await inner.engine.run('plan.correct',{workId:id,ownerPhase:'planning',
          operations:[{...operations[0],to:'src/concurrent.mjs'}],reason:'The plan owner reviewed and recorded this concurrent module correction.'});
        innerRevision=result.revision;
        return {token:'stale-live-review'};
      },
      consume:async()=>{outerConsumes++;return {authorizationId:randomUUID()};}
    }});
    await assert.rejects(outer.engine.run('plan.correct',{workId:id,ownerPhase:'planning',operations,reason}),error=>
      Boolean(error.code)&&!error.enginePublication);
    assert.equal(outerConsumes,0,'the exact-plan recheck precedes consumption of the stale human review');
    assert.ok(innerRevision);assert.equal(f.git('rev-parse','HEAD'),innerRevision);
    const after=(await loadAcceptedStoryExecution(f.root,id)).workflow;
    assert.equal(after.planAmendments.length,1);
    assert.equal(after.planAmendments[0].operations[0].to,'src/concurrent.mjs');
    assert.equal(after.currentPhase,'implementation');assert.equal(after.phases.planning.generation,1);
  });
});
