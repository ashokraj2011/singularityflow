import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {decisionPolicyPacket,parseDecisionAnswers} from '../src/kernel/decision-plan.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';

const digest='sha256:'+'a'.repeat(64);
const packet=()=>({workId:'W-1',phase:'custom-review',packetSha256:digest,offered:[],items:[{
  id:'d1',kind:'scope',title:'Account for the request',options:[{
    id:'included',label:'Include it',recordable:true,needs:{},effects:[{kind:'scope-disposition',item:'SRI-1'}],
    decidedBy:{allowed:true,groups:['owners']}
  }]
}]});
const input=()=>({workId:'W-1',phaseId:'custom-review',confirmation:digest,answers:{choose:{d1:'included'}}});

function fixture(change={}) {
  const calls=[];
  const context={subject:{id:'W-1'},policy:packet(),at:'2026-11-07T00:00:00.000Z'};
  const port={
    load(){calls.push('load');return context;},
    prepare(context,input){calls.push('prepare');return {answers:parseDecisionAnswers(input.answers),confirmation:input.confirmation};},
    apply(context,effect,step){calls.push(`apply:${step.item}`);return {id:`REC-${step.item}`,kind:effect.kind};},
    finish(context,plan,outcome){
      calls.push('finish');
      if(outcome.failed)throw outcome.failed.error;
      return {workId:'W-1',phase:'custom-review',recorded:outcome.recorded.map(entry=>({item:entry.item,kind:entry.kind,record:entry.record.id,value:entry.record})),
        refused:plan.refused,remaining:[],packetSha256:digest};
    },...change
  };
  return {port,context,calls,engine:createEngine({ports:{decisions:port}})};
}

test('decision recording has one registry path and snapshots the plan before host preparation',async()=>{
  const f=fixture();
  f.port.apply=()=>{throw new Error('a later replacement must not execute');};
  const result=await f.engine.recordDecisions(input());
  assert.equal(result.operation,'decisions.record');
  assert.equal(result.phase,'custom-review');
  assert.equal(result.effects.recordedEntries,1);
  assert.deepEqual(f.calls,['load','prepare','apply:d1','finish']);
  assert.equal(Object.isFrozen(result.recorded[0].value),true);
  const metadata=ENGINE_OPERATIONS.find(operation=>operation.id==='decisions.record');
  assert.deepEqual(metadata.stages,['load','prepare','apply','finish']);
  assert.equal('execute' in metadata,false);
  const changed=fixture({prepare(context,input){
    context.policy.items[0].options[0].effects[0].kind='injected-after-load';
    return {answers:parseDecisionAnswers(input.answers),confirmation:input.confirmation};
  }});
  const preserved=await changed.engine.run('decisions.record',input());
  assert.equal(preserved.recorded[0].kind,'scope-disposition');
});

test('missing, malformed and stale list consent cannot start an effect',async()=>{
  for(const [confirmation,code] of [[undefined,'DECISIONS_CONFIRMATION_REQUIRED'],['wrong','DECISIONS_OPTIONS_INVALID'],['sha256:'+'b'.repeat(64),'DECISIONS_PACKET_CHANGED']]) {
    const f=fixture();
    const value=input();if(confirmation===undefined)delete value.confirmation;else value.confirmation=confirmation;
    await assert.rejects(f.engine.recordDecisions(value),{code});
    assert.equal(f.calls.some(call=>call.startsWith('apply')),false);
  }
});

test('caller packets, authority, executable plans and accessor answers are refused before I/O',async()=>{
  const f=fixture();
  for(const field of ['actor','agent','authority','packet','plan','effects','selectionReceipt']) {
    await assert.rejects(f.engine.recordDecisions({...input(),[field]:{allowed:true}}),{code:'ENGINE_INPUT_INVALID'});
  }
  let accessed=false;
  const value=input();Object.defineProperty(value.answers,'choose',{enumerable:true,get(){accessed=true;throw new Error('getter');}});
  await assert.rejects(f.engine.recordDecisions(value),{code:'ENGINE_INPUT_INVALID'});
  assert.equal(accessed,false);
  assert.deepEqual(f.calls,[]);
});

test('a denied item cannot become an effect, and host action commands never enter policy data',async()=>{
  const f=fixture();f.context.policy.items[0].options[0].decidedBy.allowed=false;
  await assert.rejects(f.engine.recordDecisions(input()),{code:'DECISIONS_NOT_YOURS'});
  assert.equal(f.calls.some(call=>call.startsWith('apply')),false);
  const full=packet();full.items[0].options[0].action={command:'private host command'};
  full.items[0].options[0].decidedBy.share='/private-host-route';
  const policy=decisionPolicyPacket(full);
  assert.doesNotMatch(JSON.stringify(policy),/private host command|private-host-route/u);
});

test('a partial native failure retains the original error and exact confirmed/stopped effects',async()=>{
  const native=new SingularityFlowError('publication response unknown',{code:'NATIVE_UNKNOWN',cause:new Error('transport')});
  const f=fixture({apply(context,effect,step){if(step.item==='d2')throw native;return {id:'REC-1'};}});
  const second=structuredClone(f.context.policy.items[0]);second.id='d2';f.context.policy.items.push(second);
  const value=input();value.answers.choose.d2='included';
  await assert.rejects(f.engine.recordDecisions(value),error=>{
    assert.equal(error,native);
    assert.equal(error.engineDecisionEffects.recorded.length,1);
    assert.equal(error.engineDecisionEffects.failed.error,native);
    assert.equal(error.engineDecisionEffects.remaining[0].item,'d2');
    return true;
  });
});

test('cancellation stops before effects, while an accepted plan and a declined review keep their real outcomes',async()=>{
  const controller=new AbortController();controller.abort();const before=fixture();
  await assert.rejects(before.engine.recordDecisions(input(),{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  assert.deepEqual(before.calls,[]);
  const during=new AbortController();const accepted=fixture({apply(){during.abort();return {id:'REC-1'};}});
  assert.equal((await accepted.engine.recordDecisions(input(),{signal:during.signal})).status,'recorded');
  const declined=fixture({prepare(){return {cancelled:true};}});
  assert.equal((await declined.engine.recordDecisions(input())).status,'not-recorded');
  assert.deepEqual(declined.calls,['load']);
});

test('a differently bound post-effect projection is refused with the already recorded effect retained',async()=>{
  const f=fixture({finish(){return {workId:'another-story',phase:'custom-review',recorded:[],refused:[],remaining:[],packetSha256:digest};}});
  await assert.rejects(f.engine.recordDecisions(input()),error=>{
    assert.equal(error.code,'ENGINE_PORT_RESULT_INVALID');
    assert.equal(error.engineDecisionEffects.recorded.length,1);
    return true;
  });
});

test('malformed records and invented refusals cannot become a successful receipt after an effect',async()=>{
  const changes=[
    facts=>{facts.recorded=[null];},
    facts=>{delete facts.recorded[0].value;},
    facts=>{facts.recorded[0].value='unbound record';},
    facts=>{facts.recorded[0].record={id:'REC-1'};},
    facts=>{facts.refused=[{item:'d2',title:'Invented denial',option:'included',groups:[]}];},
    facts=>{facts.remaining=[{id:'d2',kind:'scope'}];}
  ];
  for(const change of changes) {
    const f=fixture({finish(context,plan,outcome){
      const facts={workId:'W-1',phase:'custom-review',recorded:outcome.recorded.map(entry=>({
        item:entry.item,kind:entry.kind,record:entry.record.id,value:entry.record})),
        refused:plan.refused,remaining:[],packetSha256:digest};
      change(facts);return facts;
    }});
    await assert.rejects(f.engine.recordDecisions(input()),error=>{
      assert.equal(error.code,'ENGINE_PORT_RESULT_INVALID');
      assert.equal(error.engineDecisionEffects.recorded.length,1);
      return true;
    });
  }
});

test('a finish projection cannot conceal a failed native effect',async()=>{
  const native=new SingularityFlowError('acknowledgement unavailable',{code:'NATIVE_UNKNOWN'});
  const f=fixture({apply(){throw native;},finish(){return {
    workId:'W-1',phase:'custom-review',recorded:[],refused:[],remaining:[],packetSha256:digest
  };}});
  await assert.rejects(f.engine.recordDecisions(input()),error=>{
    assert.equal(error,native);
    assert.equal(error.engineDecisionEffects.failed.error,native);
    assert.equal(error.engineDecisionEffects.remaining[0].item,'d1');
    return true;
  });
});

test('host preparation cannot change the decision date captured with the reviewed packet',async()=>{
  const f=fixture({prepare(context,input){
    context.at='2026-11-09T00:00:00.000Z';
    return {answers:parseDecisionAnswers(input.answers),confirmation:input.confirmation};
  }});
  f.context.policy.items[0].options[0].needs.expires={default:'2026-11-08',latest:'2026-11-10'};
  assert.equal((await f.engine.recordDecisions(input())).effects.recordedEntries,1);
});
