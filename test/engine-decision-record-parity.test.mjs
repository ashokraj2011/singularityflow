import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {STARTER_CHECKLIST} from '../src/specification-quality.mjs';
import {startedSpecificationStory,approvedSpecificationStory,CLI} from './helpers/submitted-planning-story.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
const reason='The human source owner reviewed this statement as informative implementation context.';
const description='The request must mention the reviewed audit note.';

async function reviewer(name,operation) {
  const previous={mode:process.env.NODE_ENV,identity:process.env.SINGULARITY_FLOW_TEST_IDENTITY};
  process.env.NODE_ENV='test';process.env.SINGULARITY_FLOW_TEST_IDENTITY=name;
  try{return await operation();}finally{
    if(previous.mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.mode;
    if(previous.identity===undefined)delete process.env.SINGULARITY_FLOW_TEST_IDENTITY;else process.env.SINGULARITY_FLOW_TEST_IDENTITY=previous.identity;
  }
}

const inventory=f=>JSON.parse(f.cli('evidence','scope','--json').stdout).data.scope;
const clause=scope=>{
  const item=scope.items.find(entry=>entry.text===description);
  assert.ok(item,'the original requirement remains in the native scope inventory');
  return item.id;
};

function capturedCli(f,file,args) {
  return run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,
    CLI,'--no-model',...args,'--json'],{cwd:f.root,allowFailure:true,env:{...process.env,NODE_ENV:'test',
      SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'off',SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:file}});
}

test('headless scope and CLI completeness share exact native records without approving a generation',async t=>{
  const id='DIRECT-SCOPE';const f=await startedSpecificationStory(t,id,{description});
  await reviewer('History Tester',async()=>{
    const initial=inventory(f),item=clause(initial),api=createSflow({root:f.root});
    const receipt=await api.run('decision.scope',{workId:id,item,disposition:'informative',reason});
    assert.equal(receipt.recordKind,'scope-disposition');
    assert.equal(receipt.authorityGroup,'product-approvers');
    assert.equal(receipt.record.item,item);
    assert.equal(receipt.record.disposition,'informative');
    assert.equal(f.git('rev-parse','HEAD'),receipt.revision);
    const reviewed=inventory(f);
    assert.equal(reviewed.structurallyComplete,true);
    const checklist=STARTER_CHECKLIST.articles.map(article=>({article:article.id,decision:'satisfied'}));
    await assert.rejects(api.run('decision.completeness',{workId:id,confirm:initial.inventorySha256,
      checklist,reason}),{code:'SCOPE_INVENTORY_CHANGED'});
    const file=path.join(f.directory,'sdk-completeness.json');
    const response=capturedCli(f,file,['decision','completeness',id,'--confirm',reviewed.inventorySha256,
      ...checklist.flatMap(entry=>['--article',`${entry.article}=satisfied`]),'--reason',reason]);
    assert.equal(response.status,0,response.stdout+'\n'+response.stderr);
    const actual=JSON.parse(response.stdout),captured=JSON.parse(await readFile(file,'utf8'));
    assert.equal(captured.operation,'decision.completeness');
    assert.deepEqual(actual.subject,captured.result.subject);
    assert.deepEqual(actual.data.review,captured.result.record);
    assert.equal(actual.data.commit,captured.result.revision);
    assert.equal(actual.data.pushed,captured.result.effects.pushed);
    assert.equal(captured.result.authorityGroup,'product-approvers');
    const after=await loadAcceptedStoryExecution(f.root,id);
    assert.equal(after.workflow.currentPhase,'specification');
    assert.equal(after.workflow.phases.specification.generation,0);
    assert.equal(after.workflow.scopeDispositions.length,1);
    assert.equal(after.workflow.completenessReviews.length,1);
  });
});

test('a standalone CLI scope decision projects the actual SDK outcome and leaves authority unchanged',async t=>{
  const id='DIRECT-CLI-SCOPE';const f=await startedSpecificationStory(t,id,{description});
  const file=path.join(f.directory,'sdk-scope.json');
  const response=capturedCli(f,file,['decision','scope',id,'--item',clause(inventory(f)),
    '--as','informative','--reason',reason]);
  assert.equal(response.status,0,response.stdout+'\n'+response.stderr);
  const actual=JSON.parse(response.stdout),captured=JSON.parse(await readFile(file,'utf8'));
  assert.equal(captured.operation,'decision.scope');
  assert.deepEqual(actual.data.decision,captured.result.record);
  assert.equal(actual.data.commit,captured.result.revision);
  assert.equal(actual.data.pushed,captured.result.effects.pushed);
  assert.equal(actual.data.decision.authorityGroup,'product-approvers');
});

test('the default SDK cannot take authority from an unrelated caller or an input field',async t=>{
  const id='DIRECT-DENIED';const f=await startedSpecificationStory(t,id,{description,configure(config){
    config.approvalAuthorities['product-approvers']={label:'Source owners',allowAnyGitIdentity:false,
      members:[{email:'history.tester@example.com'}]};
  }});
  const item=clause(inventory(f)),before=f.git('rev-parse','HEAD');
  await reviewer('Unrelated Guest',async()=>{
    const api=createSflow({root:f.root});
    await assert.rejects(api.run('decision.scope',{workId:id,item,disposition:'informative',reason,actor:'History Tester'}),
      {code:'ENGINE_INPUT_INVALID'});
    let denied;
    await assert.rejects(api.run('decision.scope',{workId:id,item,disposition:'informative',reason}),error=>{
      denied=error;return Boolean(error.code&&/authorit|identity|approv/iu.test(error.message));
    });
    const response=run(process.execPath,[CLI,'--no-model','decision','scope',id,'--item',item,
      '--as','informative','--reason',reason,'--json'],{cwd:f.root,allowFailure:true,env:{...process.env,SINGULARITY_FLOW_BUNDLE:'off'}});
    assert.notEqual(response.status,0);
    assert.equal(JSON.parse(response.stdout).error.code,denied.code);
    assert.equal(f.git('rev-parse','HEAD'),before);
  });
});

test('a different seeded workflow uses the same SDK omission decision without inventing verification',async t=>{
  const id='DIRECT-APPLICABILITY';const f=await startedSpecificationStory(t,id,{configure(config){
    config.workTypes['spec-driven-standard']=structuredClone(config.workTypes['poc-lite']);
  }});
  await reviewer('History Tester',async()=>{
    const api=createSflow({root:f.root});
    const receipt=await api.run('decision.applicability',{workId:id,responsibility:'scope',
      reason:'This lifecycle demonstration intentionally defines no requirement clauses.'});
    assert.equal(receipt.record.responsibility,'scope');
    assert.equal(receipt.authorityGroup,'quality-reviewers');
    assert.equal(receipt.currentPhase,'poc-lite-plan');
    const before=f.git('rev-parse','HEAD');
    await assert.rejects(api.run('decision.applicability',{workId:id,responsibility:'verify',
      reason:'Verification remains part of this configured workflow.'}),{code:'APPLICABILITY_NOT_OMITTED'});
    assert.equal(f.git('rev-parse','HEAD'),before);
    const after=await loadAcceptedStoryExecution(f.root,id);
    assert.equal(after.workflow.applicability.length,1);
    assert.equal(after.workflow.phases['poc-lite-plan'].generation,0);
  });
});

test('standalone SDK routing checks the pending key and records the real native successor',async t=>{
  const id='DIRECT-ROUTE';const f=await approvedSpecificationStory(t,id,{configure(config){
    config.workTypes['spec-driven-standard'].decisions=[{id:'direction',after:'specification',kind:'ask',
      label:'Continue with the approved specification?',routes:[
        {id:'continue',label:'Continue to planning',to:'next'},
        {id:'again',label:'Revise the specification',to:'specification'}]}];
  }});
  await reviewer('History Tester',async()=>{
    const accepted=await loadAcceptedStoryExecution(f.root,id),api=createSflow({root:f.root});
    const before=f.git('rev-parse','HEAD');
    await assert.rejects(api.run('decision.choose',{workId:id,option:'continue',expected:'old-pending-key',reason}),
      {code:'DECISION_STALE'});
    assert.equal(f.git('rev-parse','HEAD'),before);
    const receipt=await api.run('decision.choose',{workId:id,option:'continue',expected:accepted.workflow.pendingDecision.key,reason});
    assert.equal(receipt.record.route,'continue');
    assert.equal(receipt.phase,'specification');
    assert.equal(receipt.currentPhase,'planning');
    assert.equal(f.git('rev-parse','HEAD'),receipt.revision);
    const after=await loadAcceptedStoryExecution(f.root,id);
    assert.equal(after.workflow.currentPhase,'planning');
    assert.equal(after.workflow.phases.specification.status,'approved');
    assert.equal(after.workflow.pendingDecision,undefined);
    const committed=f.git('rev-parse','HEAD');
    await assert.rejects(api.run('decision.choose',{workId:id,option:'continue',reason}),{code:'DECISION_NOT_PENDING'});
    assert.equal(f.git('rev-parse','HEAD'),committed);
  });
});
