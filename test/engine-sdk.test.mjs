import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, ENGINE_CONTRACT, ENGINE_OPERATIONS, ENGINE_HELPERS } from '../src/engine-sdk/index.mjs';
import { SingularityFlowError } from '../src/foundation/failures.mjs';

test('conformance context cannot replace registry metadata or bind another phase generation',async()=>{
  const reference={namespace:'evidence',sha256:'b'.repeat(64),bytes:1},source={phase:'release',generation:1,expected:'a'.repeat(64),
    publication:{schemaVersion:1,format:'sflow-phase-publication-binding/v1',generation:1,record:reference},report:reference,gaps:[],actions:[]};
  const make=value=>createEngine({ports:{conformanceContext:{load:()=>({subject:{kind:'story',id:'S'},workflow:{workItem:{id:'S'},phases:{release:{generation:1}}}}),read:()=>value}}});
  for(const value of [{...source,operation:'phase.approve'},{...source,generation:2},{...source,expected:'unbound'},
    {...source,report:{...reference,bytes:4_194_305}},()=>{}])await assert.rejects(
    make(value).run('conformance.context',{workId:'S',phaseId:'release'}),{code:'ENGINE_PORT_RESULT_INVALID'});
  assert.equal((await make(source).run('conformance.context',{workId:'S',phaseId:'release'})).operation,'conformance.context');
});

test('conformance context checks its binding before reading and preserves real read errors',async()=>{
  const valid={subject:{kind:'story',id:'S'},workflow:{workItem:{id:'S'},currentPhase:'release',phases:{release:{generation:1}}}};
  for(const context of [null,{subject:{kind:'story'}},{...valid,workflow:{workItem:{id:'S'}}},
    {...valid,subject:{kind:'story',id:'OTHER'}},{...valid,workflow:{...valid.workflow,phases:{release:{generation:-1}}}}]){
    let reads=0;
    const engine=createEngine({ports:{conformanceContext:{load:()=>context,read:()=>{reads++;throw new Error('unexpected read');}}}});
    await assert.rejects(engine.run('conformance.context',{workId:'S',phaseId:'release'}),{code:'ENGINE_PORT_RESULT_INVALID'});
    assert.equal(reads,0);
  }
  const denied=Object.assign(new Error('report is unreadable'),{code:'EACCES',path:'/retained/report.json'});
  const engine=createEngine({ports:{conformanceContext:{load:()=>valid,read:()=>{throw denied;}}}});
  await assert.rejects(engine.run('conformance.context',{workId:'S'}),actual=>actual===denied&&actual.path==='/retained/report.json');
  const unpublished={...valid,workflow:{...valid.workflow,phases:{release:{generation:0}}}},
    missing=Object.assign(new Error('Publish the generation before deciding its gaps.'),{code:'PHASE_PUBLICATION_REQUIRED'}),
    draft=createEngine({ports:{conformanceContext:{load:()=>unpublished,read:()=>{throw missing;}}}});
  await assert.rejects(draft.run('conformance.context',{workId:'S'}),actual=>actual===missing);
});

function fixture({ retained = null, phase = null, hook = () => {} } = {}) {
  const calls = [];
  const facts = Object.freeze({workId:'STORY-1',phase:phase?.id??'team-spec',generation:1,revision:'a'.repeat(40),pushed:true,artifact:'document.md'});
  const published = Object.freeze({schemaVersion:1,contract: ENGINE_CONTRACT, operation: 'phase.publish', status: 'published',
    subject:{kind:'story',id:'STORY-1'},phase:facts.phase,generation:1,revision:facts.revision,effects:{committed:true,pushed:true},artifact:facts.artifact});
  const publication = Object.fromEntries(ENGINE_OPERATIONS[0].stages.map(name => [name, async (...args) => {
    calls.push(name);
    await hook(name, args);
    if (name === 'load') return {subject:{kind:'story',id:'STORY-1'}, phase: phase ?? { id: 'team-spec', requiredArtifact: {kind:'requirements'},
      generationPolicy: {defaultProducer:'governed-agent', allowedProducers:['governed-agent','human']} } };
    if (name === 'retained') return retained;
    if (name === 'prepare') return args[2].authorship;
    if (name === 'commit') return {sha:'a'.repeat(40),pushed:true};
    return facts;
  }]));
  publication.notice = event => { calls.push(event.code); };
  return {engine:createEngine({ports:{publication}}), publication, calls, published};
}

test('every convenience helper enters the same registered port as run', async () => {
  assert.equal(Object.isFrozen(ENGINE_HELPERS), true);
  for (const [helper, id] of Object.entries(ENGINE_HELPERS)) {
    const definition = ENGINE_OPERATIONS.find(operation => operation.id === id);
    assert.ok(definition, `${helper} names a registered operation`);
    const seen = [], sentinel = new Error(id);
    const port = Object.fromEntries(definition.stages.map(stage => [stage, async () => { seen.push(stage); throw sentinel; }]));
    const engine = createEngine({ ports: { [definition.port]: port } });
    assert.equal(engine[helper].name, helper, 'helper names retain their existing diagnostic identity');
    await assert.rejects(engine[helper]({}), error => error === sentinel);
    await assert.rejects(engine.run(id, {}), error => error === sentinel);
    assert.deepEqual(seen, [definition.stages[0], definition.stages[0]], `${helper} has no second coordinator`);
  }
});

test('the versioned registry and typed helper execute exactly one publication stage sequence', async () => {
  const a=fixture(), b=fixture();
  assert.equal(a.engine.contract, 'sflow-engine/v1');
  assert.equal(Object.isFrozen(a.engine.operations[0].stages), true);
  const inputs={phaseId:'team-spec',authored:'governed-agent'};
  assert.deepEqual(await a.engine.run('phase.publish',inputs), a.published);
  assert.deepEqual(await b.engine.publishPhase(inputs), b.published);
  assert.deepEqual(a.calls, ['load','retained','prepare','commit','finish']);
  assert.deepEqual(a.calls,b.calls);
  a.publication.commit=()=>{throw new Error('redirected');};
  assert.deepEqual(await a.engine.publishPhase(inputs), a.published, 'port function bindings are captured at construction');
});

test('unsupported operations and malformed input cannot execute any port or caller getter', async () => {
  const {engine,calls}=fixture();
  for(const operation of ['constructor','__proto__','phase.publish.v2']) {
    await assert.rejects(engine.run(operation,{}), {code:'ENGINE_OPERATION_UNSUPPORTED'});
  }
  const accessor={};Object.defineProperty(accessor,'phaseId',{enumerable:true,get(){throw new Error('getter executed');}});
  const cyclic={};cyclic.usage=cyclic;
  for(const input of [null,[],accessor,cyclic,{phaseId:()=>{}},{root:'/other'},
    {usage:new Date()}, {usage:{x:NaN}}, {changeOrigins:'human'}, {usage:{},usageFile:'file.json'},
    {usage:{['x'.repeat(4_194_305)]:{}}}]) {
    await assert.rejects(engine.run('phase.publish',input), {code:'ENGINE_INPUT_INVALID'});
  }
  assert.deepEqual(calls,[]);
  assert.throws(()=>createEngine({ports:{publication:{}}}), {code:'ENGINE_INPUT_INVALID'});
});

test('inputs are copied before asynchronous work and a retained publication does not prepare or commit', async () => {
  let seen;
  const retained=Object.freeze({workId:'STORY-1',phase:'team-spec',generation:1,revision:'a'.repeat(40),pushed:false,
    artifact:'document.md',retentionReason:'unchanged-document'});
  const f=fixture({retained,hook(name,args){if(name==='load')seen=args[0];}});
  const input={phaseId:'team-spec',usage:{totalTokens:10}};
  const running=f.engine.run('phase.publish',input);
  input.phaseId='other';input.usage.totalTokens=999;
  assert.equal((await running).status,'retained');
  assert.deepEqual(f.calls,['load','retained']);
  assert.equal(seen.phaseId,'team-spec');
  assert.equal(seen.usage.totalTokens,10);
  assert.equal(Object.isFrozen(seen.usage),true);
});

test('cancellation before the next effect stops safely and cancellation after commit cannot undo publication', async () => {
  for(const cancelAt of ['before-start','load','retained','prepare','commit']) {
    const controller=new AbortController();
    const f=fixture({hook(name){if(name===cancelAt)controller.abort();}});
    if(cancelAt==='before-start')controller.abort();
    const running=f.engine.publishPhase({authored:'human'},{signal:controller.signal});
    if(cancelAt==='commit') {
      assert.deepEqual(await running,f.published);
      assert.equal(f.calls.at(-1),'finish');
    } else {
      await assert.rejects(running,{code:'ENGINE_OPERATION_CANCELLED'});
      assert.equal(f.calls.includes('commit'),false);
    }
  }
});

test('native conflict, unknown and pending errors preserve identity, causes and retained recovery fields', async () => {
  for(const code of ['BRANCH_REVISION_CONFLICT','PUBLICATION_PENDING','TRANSPORT_INDETERMINATE']) {
    const cause=new Error('transport detail');
    const error=new SingularityFlowError('actual native refusal',{code,cause});
    error.publicationCommit='b'.repeat(40);error.details={nextAction:'exact recovery'};
    const f=fixture({hook(name){if(name==='commit')throw error;}});
    await assert.rejects(f.engine.publishPhase({authored:'human'}), actual=>actual===error
      && actual.cause===cause && actual.publicationCommit==='b'.repeat(40));
    assert.equal(f.calls.includes('finish'),false);
  }
});

test('authorship rules apply to custom phases and cannot be bypassed by choosing another host', async () => {
  const deterministic={id:'team-reconcile',requiredArtifact:{kind:'convergence-report'},
    generationPolicy:{defaultProducer:'deterministic',allowedProducers:['deterministic']}};
  const f=fixture({phase:deterministic});
  await assert.rejects(f.engine.run('phase.publish',{authored:'human'}), {code:'CONVERGENCE_AUTHORSHIP_INVALID'});
  await assert.rejects(f.engine.run('phase.publish',{from:'draft.md',authored:'deterministic'}),
    {code:'CONVERGENCE_ARTIFACT_KERNEL_OWNED'});
  assert.equal(f.calls.includes('prepare'),false);
  const legacy=fixture();await legacy.engine.publishPhase({});
  assert.deepEqual(legacy.calls,['load','retained','publication.legacy-authorship','prepare','commit','finish']);
});

test('a malformed port result cannot become a successful SDK receipt and keeps the committed revision inspectable',async()=>{
  // A retained response cannot claim another Story or a new push.
  for(const retained of [
    {workId:'OTHER',phase:'team-spec',generation:1,revision:'a'.repeat(40),pushed:false,artifact:'document.md',retentionReason:'unchanged-document'},
    {workId:'STORY-1',phase:'team-spec',generation:1,revision:'a'.repeat(40),pushed:true,artifact:'document.md',retentionReason:'unchanged-document'}
  ]) {
    await assert.rejects(fixture({retained}).engine.run('phase.publish',{}),{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const error=new Error('receipt projection failed');
  const failed=fixture({hook(name){if(name==='finish')throw error;}});
  await assert.rejects(failed.engine.publishPhase({authored:'human'}),actual=>actual===error
    && actual.enginePublication.sha==='a'.repeat(40));
  assert.equal(failed.calls.includes('commit'),true);
});
