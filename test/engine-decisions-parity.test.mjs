import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSflow} from '../src/api.mjs';
import {loadAcceptedStoryExecution} from '../src/accepted-story-execution.mjs';
import {readPendingList} from '../src/decision-list-reads.mjs';
import {startedSpecificationStory,CLI} from './helpers/submitted-planning-story.mjs';
import {run} from '../src/util.mjs';

const capture=fileURLToPath(new URL('./helpers/capture-engine-operation.mjs',import.meta.url));
const reason='The fixture owner reviewed this request as informative context for the implementation.';
const description='The request must mention the fixture audit note.';
const lastJson=text=>{const starts=[...String(text).matchAll(/^\{$/gmu)];return JSON.parse(starts.length?String(text).slice(starts.at(-1).index):text);};

async function asReviewer(name,operation) {
  const previous={mode:process.env.NODE_ENV,identity:process.env.SINGULARITY_FLOW_TEST_IDENTITY};
  process.env.NODE_ENV='test';process.env.SINGULARITY_FLOW_TEST_IDENTITY=name;
  try{return await operation();}finally{
    if(previous.mode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.mode;
    if(previous.identity===undefined)delete process.env.SINGULARITY_FLOW_TEST_IDENTITY;else process.env.SINGULARITY_FLOW_TEST_IDENTITY=previous.identity;
  }
}

function scopeAnswer(packet) {
  const item=packet.items.find(item=>item.options.some(option=>option.id==='scope-informative'));
  assert.ok(item,'a started specification retains the source statement for its owner to classify');
  return {choose:{[item.id]:'scope-informative'},reason:{[item.id]:reason}};
}

async function packetFor(root,id) {
  const accepted=await loadAcceptedStoryExecution(root,id);
  return readPendingList(root,accepted.definition,accepted.workflow);
}

test('the SDK records an exact source-scope decision in its current phase and refuses stale replay',async t=>{
  const id='ENGINE-SCOPE';const f=await startedSpecificationStory(t,id,{description});
  await asReviewer('History Tester',async()=>{
    const packet=await packetFor(f.root,id),api=createSflow({root:f.root});
    const input={workId:id,confirmation:packet.packetSha256,answers:scopeAnswer(packet)};
    const before=f.git('rev-parse','HEAD');
    await assert.rejects(api.recordDecisions({...input,confirmation:'sha256:'+'0'.repeat(64)}),{code:'DECISIONS_PACKET_CHANGED'});
    assert.equal(f.git('rev-parse','HEAD'),before);
    const receipt=await api.recordDecisions(input);
    assert.equal(receipt.status,'recorded');assert.equal(receipt.phase,'specification');
    assert.equal(receipt.effects.recordedEntries,1);
    assert.equal(receipt.recorded[0].kind,'scope-disposition');
    assert.equal(receipt.recorded[0].value.reason,reason);
    assert.equal(receipt.recorded[0].value.disposition,'informative');
    assert.notEqual(f.git('rev-parse','HEAD'),before);
    assert.equal('committed' in receipt.effects,false,'the SDK does not invent one commit for a multi-record protocol');
    const committed=f.git('rev-parse','HEAD');
    await assert.rejects(api.recordDecisions(input),{code:'DECISIONS_PACKET_CHANGED'});
    assert.equal(f.git('rev-parse','HEAD'),committed);
    const accepted=await loadAcceptedStoryExecution(f.root,id);
    assert.equal(accepted.workflow.currentPhase,'specification');
    assert.equal(accepted.workflow.phases.specification.generation,0,'recording a human scope decision authors and approves no artifact');
  });
});

test('the real CLI decision JSON projects its actual SDK receipt and keeps the answers-file route',async t=>{
  const id='ENGINE-CLI-SCOPE';const f=await startedSpecificationStory(t,id,{description});
  const packet=JSON.parse(f.cli('decisions',id,'--json').stdout).data;
  const answers={...scopeAnswer(packet),confirm:packet.packetSha256};
  const file=path.join(f.directory,'answers.json'),receiptFile=path.join(f.directory,'sdk-receipt.json');
  await writeFile(file,JSON.stringify(answers));
  const response=run(process.execPath,['--experimental-test-module-mocks','--no-warnings','--import',capture,
    CLI,'--no-model','decisions','record',id,'--answers',file,'--json'],{cwd:f.root,
    env:{...process.env,NODE_ENV:'test',SINGULARITY_FLOW_TEST_IDENTITY:'History Tester',SINGULARITY_FLOW_BUNDLE:'off',
      SINGULARITY_FLOW_TEST_ENGINE_CAPTURE:receiptFile},allowFailure:true});
  assert.equal(response.status,0,response.stdout+'\n'+response.stderr);
  const actual=lastJson(response.stdout),captured=JSON.parse(await readFile(receiptFile,'utf8'));
  assert.equal(captured.operation,'decisions.record');
  assert.deepEqual(actual.subject,captured.result.subject);
  assert.deepEqual(actual.data.recorded,captured.result.recorded);
  assert.deepEqual(actual.data.remaining,captured.result.remaining);
  assert.equal(actual.data.packetSha256,captured.result.packetSha256);
  assert.equal(actual.outcome.slots.records,String(captured.result.effects.recordedEntries));
  assert.equal(actual.data.decided.length,1);
});

test('a caller outside the native source owner group cannot record a decision through the SDK',async t=>{
  const id='ENGINE-DENIED-SCOPE';const f=await startedSpecificationStory(t,id,{description,configure(config){
    config.approvalAuthorities['product-approvers']={label:'Source owners',allowAnyGitIdentity:false,
      members:[{email:'history.tester@example.com'}]};
  }});
  await asReviewer('Unrelated Guest',async()=>{
    const packet=await packetFor(f.root,id),answers=scopeAnswer(packet);
    const before=f.git('rev-parse','HEAD');
    await assert.rejects(createSflow({root:f.root}).recordDecisions({workId:id,confirmation:packet.packetSha256,answers}),
      {code:'DECISIONS_NOT_YOURS'});
    assert.equal(f.git('rev-parse','HEAD'),before);
  });
});
