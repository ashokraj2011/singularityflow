import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedSpecificationStory} from './helpers/submitted-planning-story.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {run} from '../src/util.mjs';

const lastJson=text=>JSON.parse(String(text).trimEnd().split('\n').at(-1));

test('existing command helper exports use the exact extracted native decision functions',async()=>{
  for(const [oldFile,newFile,names] of [
    ['decision-story-records','native-story-decisions',['commitApplicabilityDecision','commitScopeDecision','commitCompletenessReview']],
    ['decision-plan-amendment','native-plan-decisions',['amendmentContentHashes','commitPlanAmendment','commitNodePin']],
    ['decision-obligation-risk','native-obligation-risk',['commitRiskDecision']]
  ]) {
    const previous=await import(`../src/commands/${oldFile}.mjs`);
    const native=await import(`../src/engine-compatibility/${newFile}.mjs`);
    for(const name of names)assert.equal(previous[name],native[name]);
  }
});

for(const mode of ['sdk','legacy'])test(`${mode} routing keeps the committed decision when local session activation fails`,async t=>{
  const id=mode==='sdk'?'SDK-ROUTE-TAIL':'LEGACY-ROUTE-TAIL';
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
      if(mode==='sdk') {
        const{createSflow}=await import(${JSON.stringify(url('api'))});
        const{readPendingList}=await import(${JSON.stringify(url('decision-list-reads'))});
        const packet=await readPendingList(root,accepted.definition,accepted.workflow);
        const item=packet.items.find(item=>item.kind==='routing-decision');
        const option=item.options.find(option=>option.effects.some(effect=>effect.kind==='routing'&&effect.option==='continue'));
        const api=createSflow({root,notice:()=>{throw new Error('observer fixture');}});
        result=await api.recordDecisions({workId:id,confirmation:packet.packetSha256,
          answers:{choose:{[item.id]:option.id},reason:{[item.id]:reason}}});
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
  if(mode==='sdk') {
    assert.equal(result.result.status,'recorded');
    assert.equal(result.result.recorded[0].kind,'routing');
    assert.equal(result.result.recorded[0].value.route,'continue');
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
