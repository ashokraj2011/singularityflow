import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {run} from '../src/util.mjs';
import {startedSpecificationStory,CLI} from './helpers/submitted-planning-story.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
const reason='This exact repository runner produces the structured result for the approved behavior.';
const command={id:'repository-checks',kind:'test',argv:[process.execPath,'fixture-checks.mjs'],
  workingDirectory:'.',affectedRoots:['.'],modelPolicy:'never',
  result:{adapter:'sflow-test-result-v1',path:'.sflow/results/checks.json',minimumDiscovered:1}};

async function asActor(name,operation) {
  const old={mode:process.env.NODE_ENV,identity:process.env.SINGULARITY_FLOW_TEST_IDENTITY};
  process.env.NODE_ENV='test';process.env.SINGULARITY_FLOW_TEST_IDENTITY=name;
  try{return await operation();}finally{
    if(old.mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old.mode;
    if(old.identity===undefined)delete process.env.SINGULARITY_FLOW_TEST_IDENTITY;else process.env.SINGULARITY_FLOW_TEST_IDENTITY=old.identity;
  }
}

async function capturedCli(f,name,args,actor='Command Reviewer') {
  const file=path.join(f.directory,name+'.json');
  const response=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,
    CLI,'--no-model',...args,'--json'],{cwd:f.root,allowFailure:true,env:{...process.env,NODE_ENV:'test',
      SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_IDENTITY:actor,SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file}});
  assert.equal(response.status,0,response.stdout+'\n'+response.stderr);
  const actual=JSON.parse(response.stdout),captured=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(actual.data.record,captured.result.record);
  assert.equal(actual.data.commit,captured.result.revision);
  assert.equal(actual.data.pushed,captured.result.effects.pushed);
  return {actual,receipt:captured.result};
}

test('SDK request and duplicate, CLI acceptance and SDK revocation retain native authority without running the command',async t=>{
  const id='SDK-TEST-REQUEST';
  const f=await startedSpecificationStory(t,id,{configure(config){
    config.phases.implementation.approval.allowSelfApproval=false;
    config.approvalAuthorities['engineering-reviewers']={label:'Runner owners',allowAnyGitIdentity:false,
      members:[{email:'history.tester@example.com'},{email:'command.reviewer@example.com'}]};
  },async beforeStart({root,git}) {
    await writeFile(path.join(root,'fixture-checks.mjs'),"throw new Error('requests and acceptance must never execute this command');\n");
    git('add','fixture-checks.mjs');git('commit','-qm','Add the exact repository runner');git('push','-q','origin','main');
  }});
  const api=createSflow({root:f.root});
  let requested;
  await asActor('History Tester',async()=>{
    const before=f.git('rev-parse','HEAD');
    await assert.rejects(api.run('test-command.request',{workId:id,phaseId:'implementation',command:{...command,env:{API_KEY:'private-value'}},reason}),
      {code:'QUALITY_COMMAND_ENV_SECRET'});
    assert.equal(f.git('rev-parse','HEAD'),before);
    requested=await api.run('test-command.request',{workId:id,phaseId:'implementation',command,reason});
    assert.equal(requested.phase,'implementation');assert.equal(requested.currentPhase,'specification');
    assert.equal(requested.authorityGroup,null);assert.equal(requested.record.id,'TCD-001');
    assert.deepEqual(requested.record.command,command);
    assert.equal(f.git('rev-parse','HEAD'),requested.revision);
    await assert.rejects(api.run('test-command.decide',{workId:id,accept:requested.record.id}),{code:'TEST_COMMAND_SELF_ACCEPTANCE'});
    assert.equal(f.git('rev-parse','HEAD'),requested.revision);
  });
  await asActor('Unrelated Requester',async()=>{
    const reused=await api.run('test-command.request',{workId:id,phaseId:'implementation',command,reason});
    assert.equal(reused.status,'retained');assert.equal(reused.revision,null);
    assert.deepEqual(reused.effects,{committed:false,pushed:false});
    assert.deepEqual(reused.record,requested.record);
    assert.equal(f.git('rev-parse','HEAD'),requested.revision);
    await assert.rejects(api.run('test-command.decide',{workId:id,accept:requested.record.id}),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});
  });
  const accepted=await capturedCli(f,'acceptance',['decision','test-command',id,'--accept',requested.record.id]);
  assert.equal(accepted.receipt.operation,'test-command.decide');
  assert.equal(accepted.receipt.authorityGroup,'engineering-reviewers');
  assert.equal(accepted.receipt.record.accepts,requested.record.id);
  await asActor('Command Reviewer',async()=>{
    const revoked=await api.run('test-command.decide',{workId:id,revoke:requested.record.id,
      reason:'The repository now provides a replacement runner for this same approved behavior.'});
    assert.equal(revoked.record.revokes,requested.record.id);
    assert.equal(revoked.phase,'implementation');assert.equal(revoked.currentPhase,'specification');
    assert.equal(f.git('rev-parse','HEAD'),revoked.revision);
  });
  const after=await loadAcceptedStoryExecution(f.root,id);
  assert.equal(after.workflow.currentPhase,'specification');
  assert.equal(after.workflow.phases.implementation.status,'not_started');
  assert.equal(after.workflow.testCommandDecisions.length,3);
  assert.deepEqual(after.workflow.phases.implementation.storyTestCommands??[],[]);
  await assert.rejects(readFile(path.join(f.root,'.sflow/results/checks.json')),{code:'ENOENT'});
});

test('SDK visual decisions and CLI revocations use the original target phase, keeping one profile required',async t=>{
  const id='SDK-VISUAL-PROFILE';
  const f=await startedSpecificationStory(t,id,{configure(config){
    const workType=config.workTypes['spec-driven-standard'];
    workType.phases.splice(-1,0,'visual-verification');
    workType.phaseOverrides['visual-verification']={approval:{rejectTo:['specification','visual-verification']}};
    workType.verification={coverage:'warn',profiles:[
      {id:'phone',label:'Phone',width:390,height:844,deviceScaleFactor:1},
      {id:'tablet',label:'Tablet',width:834,height:1194,deviceScaleFactor:1}]};
  }});
  const api=createSflow({root:f.root});
  let receipt;
  await asActor('Command Reviewer',async()=>{
    receipt=await api.run('decision.visual-profile',{workId:id,phaseId:'visual-verification',profileId:'tablet',notApplicable:true,
      reason:'This application ships to phones; the tablet profile does not apply to this Story.'});
    assert.equal(receipt.record.profileId,'tablet');assert.equal(receipt.record.disposition,'not-applicable');
    assert.equal(receipt.phase,'visual-verification');assert.equal(receipt.currentPhase,'specification');
    const before=f.git('rev-parse','HEAD');
    await assert.rejects(api.run('decision.visual-profile',{workId:id,phaseId:'visual-verification',profileId:'phone',notApplicable:true,
      reason:'Trying to exclude the last remaining profile is not permitted.'}),{code:'VISUAL_PROFILE_LAST_REQUIRED'});
    assert.equal(f.git('rev-parse','HEAD'),before);
  });
  const revoked=await capturedCli(f,'visual-revocation',['decision','visual-profile',id,'--revoke',receipt.record.id,
    '--reason','The tablet application is now included in this same release.']);
  assert.equal(revoked.receipt.phase,'visual-verification');
  assert.equal(revoked.receipt.record.revokes,receipt.record.id);
  const after=await loadAcceptedStoryExecution(f.root,id);
  assert.equal(after.workflow.visualProfileDecisions.length,2);
  assert.equal(after.workflow.currentPhase,'specification');
});
