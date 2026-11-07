import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedSpecificationStory,startedSpecificationStory,CLI} from './helpers/submitted-planning-story.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {run} from '../src/util.mjs';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const lastJson=text=>JSON.parse(String(text).trimEnd().split('\n').at(-1));

test('existing command helper exports use the exact extracted native decision functions',async()=>{
  for(const [oldFile,newFile,names] of [
    ['decision-story-records','native-story-decisions',['commitApplicabilityDecision','commitScopeDecision','commitCompletenessReview']],
    ['decision-plan-amendment','native-plan-decisions',['amendmentContentHashes','commitPlanAmendment','commitNodePin']],
    ['decision-obligation-risk','native-obligation-risk',['commitRiskDecision']],
    ['decision-evidence-reuse','native-evidence-decisions',['evidenceReuseAuthorities','evidenceReuseDecisionPart','recordEvidenceReuseDecision']],
    ['decision-visual-profile','native-visual-decisions',['visualProfileAuthorities','visualProfileDecisionPart','recordVisualProfileDecisionFor']],
    ['decision-test-command','native-test-command-decisions',['recordStoryTestCommand']],
    ['decision-test-narrowing','native-test-narrowing-decisions',['recordTestNarrowingDecision']],
    ['decision-test-risk','native-test-risk-decisions',['testRunRiskDecisionPart','recordTestRunRiskDecision']],
    ['upstream-issue','native-upstream-decisions',['commitUpstreamIssue','upstreamIssuePart','decideUpstreamIssueRecord','upstreamIssueDecisionPart']]
  ]) {
    const previous=await import(`../src/commands/${oldFile}.mjs`);
    const native=await import(`../src/engine-compatibility/${newFile}.mjs`);
    for(const name of names)assert.equal(previous[name],native[name]);
  }
});

test('the packaged CLI accepts an exact Story test command through its native writer chunk',async t=>{
  const id='BUNDLED-DECISION';
  const f=await startedSpecificationStory(t,id,{async beforeStart({root,git}){
    await writeFile(path.join(root,'fixture-checks.mjs'),[
      "import assert from 'node:assert/strict';",
      "import {mkdirSync,writeFileSync} from 'node:fs';",
      'assert.equal(1+1,2);',
      "mkdirSync('.sflow/results',{recursive:true});",
      "writeFileSync('.sflow/results/native-checks.json',JSON.stringify({tests:{discovered:1,passed:1,failed:0,skipped:0}}));"
    ].join('\n'));
    git('add','fixture-checks.mjs');git('commit','-qm','Add the fixture test command');git('push','-q','origin','main');
  }});
  const requested=JSON.parse(f.cli('decision','test-command',id,'--phase','implementation','--id','native-fixture-checks',
    '--argv',JSON.stringify([process.execPath,'fixture-checks.mjs']),'--working-directory','.',
    '--affected-root','.','--adapter','sflow-test-result-v1','--report','.sflow/results/native-checks.json',
    '--reason','This exact repository command produces the structured check result.','--json').stdout).data.record;
  const reviewerEnv={...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'Command Reviewer'};
  const listed=run(process.execPath,[CLI,'--no-model','decisions',id,'--phase','implementation','--json'],
    {cwd:f.root,env:{...reviewerEnv,SINGULARITY_FLOW_BUNDLE:'off'},allowFailure:true});
  assert.equal(listed.status,0,listed.stdout+'\n'+listed.stderr);
  const packet=JSON.parse(listed.stdout).data;
  const item=packet.items.find(item=>item.options.some(option=>option.id==='accept-test-command'));
  assert.ok(item,'the exact request is available for its step reviewer to decide');
  const packageRoot=fileURLToPath(new URL('..',import.meta.url));
  const outdir=await mkdtemp(path.join(packageRoot,'.bundle-test-native-decision-'));
  t.after(()=>rm(outdir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const {buildCliBundle}=await import('../scripts/build-cli-bundle.mjs');
  await buildCliBundle({outdir});
  const before=f.git('rev-parse','HEAD');
  const duplicate=run(process.execPath,[CLI,'--no-model','decision','test-command',id,
    '--phase','implementation','--id','native-fixture-checks','--argv',JSON.stringify([process.execPath,'fixture-checks.mjs']),
    '--working-directory','.','--affected-root','.','--adapter','sflow-test-result-v1',
    '--report','.sflow/results/native-checks.json','--reason','The same exact command still needs the configured human review.','--json'],
    {cwd:f.root,allowFailure:true,env:{...reviewerEnv,SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
  assert.equal(duplicate.status,0,duplicate.stdout+'\n'+duplicate.stderr);
  const retained=JSON.parse(duplicate.stdout);
  assert.deepEqual(retained.data.record,requested);
  assert.equal(retained.data.reused,true);assert.equal(retained.data.commit,null);
  assert.equal(f.git('rev-parse','HEAD'),before,'the bundled request resolver does not duplicate a retained request');
  const response=run(process.execPath,[CLI,'--no-model','decisions','record',id,
    '--phase','implementation','--choose',`${item.id}=accept-test-command`,
    '--confirm',packet.packetSha256,'--json'],{cwd:f.root,allowFailure:true,env:{...reviewerEnv,
      SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
  assert.equal(response.status,0,response.stdout+'\n'+response.stderr);
  const result=JSON.parse(response.stdout);
  assert.equal(result.operation.id,'decisions.record');
  assert.equal(result.data.recorded.length,1);
  assert.equal(result.data.recorded[0].kind,'test-command');
  assert.equal(result.data.recorded[0].value.accepts,requested.id);
  assert.notEqual(f.git('rev-parse','HEAD'),before);
  const after=await loadAcceptedStoryExecution(f.root,id);
  assert.equal(after.workflow.testCommandDecisions.length,2);
  assert.equal(after.workflow.testCommandDecisions.at(-1).authorityGroup,'engineering-reviewers');
  assert.equal(after.workflow.phases.specification.generation,0);
  assert.equal(after.workflow.phases.implementation.status,'not_started');
  await assert.rejects(readFile(path.join(f.root,'.sflow/results/native-checks.json')),{code:'ENOENT'},
    'accepting a test command does not claim or execute its tests');
  const revoked=run(process.execPath,[CLI,'--no-model','decision','test-command',id,'--revoke',requested.id,
    '--reason','The repository now provides a replacement runner for the approved behavior.','--json'],
    {cwd:f.root,allowFailure:true,env:{...reviewerEnv,SINGULARITY_FLOW_BUNDLE:'auto',SINGULARITY_FLOW_BUNDLE_DIR:outdir}});
  assert.equal(revoked.status,0,revoked.stdout+'\n'+revoked.stderr);
  assert.equal(JSON.parse(revoked.stdout).data.record.revokes,requested.id);
  const revokedState=await loadAcceptedStoryExecution(f.root,id);
  assert.equal(revokedState.workflow.testCommandDecisions.length,3);
  assert.equal(revokedState.workflow.currentPhase,'specification');
  assert.deepEqual(revokedState.workflow.phases.implementation.storyTestCommands??[],[]);
});

for(const mode of ['sdk','standalone','legacy'])test(`${mode} routing keeps the committed decision when local session activation fails`,async t=>{
  const id=mode==='sdk'?'SDK-ROUTE-TAIL':mode==='standalone'?'DIRECT-ROUTE-TAIL':'LEGACY-ROUTE-TAIL';
  const f=await approvedSpecificationStory(t,id,{configure(config){
    config.workTypes['spec-driven-standard'].decisions=[{
      id:'direction',after:'specification',kind:'ask',label:'Continue with the approved specification?',
      routes:[{id:'continue',label:'Continue to planning',to:'next'},
        {id:'again',label:'Revise the specification',to:'specification'}]
    }];
  }});
  const accepted=await loadAcceptedStoryExecution(f.root,id);
  assert.equal(accepted.workflow.pendingDecision.decision,'direction');
  const url=name=>new URL(`../src/${name}.mjs`,import.meta.url).href;
  const script=`import{mock}from'node:test';
    const session=await import(${JSON.stringify(url('session'))});
    mock.module(${JSON.stringify(url('session'))},{namedExports:{...session,
      activateWorkItemSession:async()=>{throw Object.assign(new Error('session projection fixture'),{code:'LOCAL_SESSION_FIXTURE'});}}});
    const{loadAcceptedStoryExecution}=await import(${JSON.stringify(url('accepted-story-execution'))});
    const root=${JSON.stringify(f.root)},id=${JSON.stringify(id)},mode=${JSON.stringify(mode)};
    const accepted=await loadAcceptedStoryExecution(root,id);
    const reason='The reviewed specification is ready to proceed to planning.';
    const warnings=[],warn=console.warn;
    console.warn=(...parts)=>warnings.push(parts.join(' '));
    try {
      let result,notices=[];
      if(mode==='sdk'||mode==='standalone') {
        const{createSflow}=await import(${JSON.stringify(url('api'))});
        const api=createSflow({root,notice:()=>{throw new Error('observer fixture');}});
        if(mode==='sdk') {
          const{readPendingList}=await import(${JSON.stringify(url('decision-list-reads'))});
          const packet=await readPendingList(root,accepted.definition,accepted.workflow);
          const item=packet.items.find(item=>item.kind==='routing-decision');
          const option=item.options.find(option=>option.effects.some(effect=>effect.kind==='routing'&&effect.option==='continue'));
          result=await api.recordDecisions({workId:id,confirmation:packet.packetSha256,
            answers:{choose:{[item.id]:option.id},reason:{[item.id]:reason}}});
        } else result=await api.run('decision.choose',{workId:id,option:'continue',reason,expected:accepted.workflow.pendingDecision.key});
        notices=(await api.notifications()).map(event=>({code:event.code,workId:event.workId,errorCode:event.error?.code}));
      } else {
        const{commitRoutingChoice}=await import(${JSON.stringify(url('commands/decision-story-records'))});
        const{actionActor}=await import(${JSON.stringify(url('git'))});
        result=await commitRoutingChoice(root,accepted.definition,accepted.workflow,
          {option:'continue',to:null,reason,expected:accepted.workflow.pendingDecision.key},
          {actor:actionActor(root),agent:null});
      }
      console.log(JSON.stringify({result,notices,warnings}));
    }finally{console.warn=warn;}`;
  const response=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--input-type=module','-e',script],
    {cwd:f.root,env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester'},allowFailure:true});
  assert.equal(response.status,0,response.stdout+'\n'+response.stderr);
  const result=lastJson(response.stdout);
  if(mode==='sdk'||mode==='standalone') {
    assert.equal(result.result.status,'recorded');
    if(mode==='sdk') {
      assert.equal(result.result.recorded[0].kind,'routing');
      assert.equal(result.result.recorded[0].value.route,'continue');
    } else {
      assert.equal(result.result.recordKind,'routing');
      assert.equal(result.result.record.route,'continue');
      assert.equal(f.git('rev-parse','HEAD'),result.result.revision);
    }
    assert.deepEqual(result.notices,[{code:'transition.tail-failed',workId:id,errorCode:'LOCAL_SESSION_FIXTURE'}]);
    assert.deepEqual(result.warnings,[],'the SDK returns local diagnostics without CLI warnings');
  } else {
    assert.deepEqual(Object.keys(result.result).sort(),['authority','publication','result']);
    assert.equal(f.git('rev-parse','HEAD'),result.result.publication.sha);
    assert.equal(result.warnings[0],
      'Warning: publication succeeded, but the next-phase session activation could not be completed: session projection fixture');
  }
  const after=await loadAcceptedStoryExecution(f.root,id);
  assert.equal(after.workflow.currentPhase,'planning');
  assert.equal(after.workflow.phases.specification.status,'approved');
  assert.equal(after.workflow.pendingDecision,undefined);
  assert.equal(after.workflow.decisionLog.at(-1).route,'continue');
});
