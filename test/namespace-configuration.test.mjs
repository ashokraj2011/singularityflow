import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createEngine,ENGINE_OPERATIONS } from '../src/engine-sdk/index.mjs';
import { SingularityFlowError } from '../src/foundation/failures.mjs';
import { agentMappingProblems } from '../src/agents.mjs';
import { agentMappingProblems as coreMapping } from '../src/kernel/configuration-declarations.mjs';
import { namespaceConfigurationFixture } from './helpers/namespace-configuration-fixture.mjs';
import { NAMESPACE_CONFIGURATION_HEAD_KEY } from '../src/engine-storage/namespace-configuration-contract.mjs';
import { LIFECYCLE_AUTHORITY_KEY } from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import { namespaceJson,namespaceIdentityJson } from '../src/sda/namespace/values.mjs';
import { jsonValueContract } from '../src/foundation/record-schema.mjs';
import { namespaceConfigurationJsonValues } from '../src/kernel/namespace-configuration.mjs';
import { resolveWorkType } from '../src/config.mjs';
import { seededNamespaceConfiguration } from './helpers/namespace-seeded-configuration.mjs';

const operation='configuration.approve';
const changed=async(f,mutate,options={})=>{const source=structuredClone(f.source);mutate(source);const ref=await f.store(source);
  return {...f.inputs,source:ref,confirm:ref.sha256,...options};};
const readJson=async(f,ref)=>JSON.parse(Buffer.from((await f.content.read(f.scope,ref)).data).toString('utf8'));

test('configuration approval is one registered explicit human operation and rejects authority in inputs',async t=>{
  const f=await namespaceConfigurationFixture(t),d=ENGINE_OPERATIONS.find(x=>x.id===operation);
  assert.equal(d.subject,'configuration');assert.equal(d.humanDecision,true);assert.equal(d.authority,'configuration.approve');
  for(const input of [{},{...f.inputs,principalId:'administrator'},{...f.inputs,permissions:['configuration.approve']},
    {...f.inputs,expectedRevision:undefined},{...f.inputs,source:{...f.inputs.source,namespace:'local'}},
    {...f.inputs,confirm:'0'.repeat(64)},{...f.inputs,reason:' '}])await assert.rejects(f.engine.run(operation,input),e=>['ENGINE_INPUT_INVALID','ENGINE_CONFIRMATION_REQUIRED'].includes(e.code));
  assert.equal(f.control.reviewCalls,0);assert.equal((await f.head()).status,'missing');
  const unavailable=createEngine({ports:{projectEnrollment:Object.fromEntries(['load','retained','prepare','commit','finish'].map(stage=>[stage,()=>{}]))}});
  await assert.rejects(unavailable.run(operation,f.inputs),{code:'ENGINE_PORT_UNAVAILABLE'});
});

test('agent selection uses the unchanged native rule and captured pre-edit outcomes',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/engine-configuration-approval/agent-mapping-v1.json',import.meta.url),'utf8'));
  assert.equal(agentMappingProblems,coreMapping);
  for(const c of fixture.cases)assert.deepEqual(coreMapping(c.agents,new Set(c.phases)),c.problems);
  const text=await readFile(new URL('../src/kernel/configuration-declarations.mjs',import.meta.url),'utf8');
  const ast=ts.createSourceFile('core',text,ts.ScriptTarget.Latest,true),fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='agentMappingProblems');
  assert.equal(createHash('sha256').update(fn.getText(ast)).digest('hex'),fixture.sha256);
  const mapped=ast.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations]).find(d=>d.name.getText(ast)==='mappedAgent');
  assert.equal(createHash('sha256').update(mapped.initializer.getText(ast)).digest('hex'),fixture.mappedAgentSha256);
});

test('retained agent-backed artifact templates use the same token rule without remote discovery',async t=>{
  const f=await namespaceConfigurationFixture(t),source=structuredClone(f.source),key='agent:analyst/artifact';
  source.definition.phases.intake.defaultTemplate=key;
  source.templates=[{path:key,body:await f.putText('# Intake\n\n{{not-supported}}\n')}];
  const ref=await f.store(source);
  await assert.rejects(f.engine.run(operation,{...f.inputs,source:ref,confirm:ref.sha256}),failure=>
    failure.code==='ENGINE_CONFIGURATION_INVALID'&&failure.details.key===key&&failure.details.phase==='intake'
    &&failure.cause?.message.includes('{{not-supported}}'));
  assert.equal((await f.head()).status,'missing');
});

for(const backend of ['filesystem','sqlite','application']) {
  test(`${backend}: unsupported template tokens are refused before configuration approval or preparation`,async t=>{
    const f=await namespaceConfigurationFixture(t,{backend});
    const source=structuredClone(f.source);source.templates[0].body=await f.putText('# Intake\n\n{{not-supported}}\n');
    const ref=await f.store(source);
    await assert.rejects(f.engine.run(operation,{...f.inputs,source:ref,confirm:ref.sha256}),failure=>
      failure.code==='ENGINE_CONFIGURATION_INVALID'&&failure.details.key==='singularity/templates/intake.md'
      &&failure.details.phase==='intake'&&failure.cause?.message.includes('{{not-supported}}'));
    assert.equal((await f.head()).status,'missing');
    assert.equal((await f.list('evidence')).entries.filter(entry=>entry.key.startsWith('configuration/approvals/')).length,0);
  });
  test(`${backend}: real enrollment and approval retain the complete explicit content closure`,async t=>{
    const f=await namespaceConfigurationFixture(t,{backend}),result=await f.engine.run(operation,f.inputs);
    assert.equal(result.status,'approved');assert.equal(result.principalId,'application-owner');assert.equal(result.replayed,false);
    assert.deepEqual(result.effects,{committed:true,pushed:false,storyCreated:false,configurationApproved:true,humanReviewRecorded:true,approvalRecorded:true});
    const head=await f.head();assert.equal(head.record.version,result.revision);
    assert.deepEqual(head.record.value.configuration.content,result.configuration);
    const compiled=await readJson(f,result.configuration);
    assert.equal(compiled.definition.agentCatalog[0].id,'analyst');assert.deepEqual(compiled.skills[0].instructions,['coding','testing']);
    assert.deepEqual(compiled.source,f.inputs.source);assert.deepEqual(compiled.workTypeIds,['simple']);
    for(const entry of [...compiled.agents,...compiled.skills,...compiled.instructions,...compiled.templates])assert.equal((await f.content.read(f.scope,entry.body)).status,'present');
    assert.equal((await f.records.read(f.scope,'state',LIFECYCLE_AUTHORITY_KEY)).status,'present');
    const state=await f.list('state');assert.equal(state.entries.length,1,'configuration approval creates no Story or seeded lifecycle head');
  });
  test(`${backend}: durable replay acknowledges one decision without reauthorizing or changing its timestamp`,async t=>{
    const f=await namespaceConfigurationFixture(t,{backend}),first=await f.engine.run(operation,f.inputs),calls=f.control.reviewCalls;
    f.control.permissions=[];f.control.now='2027-01-01T00:00:00.000Z';f.control.reviewHook=()=>{throw new Error('must not reapprove');};
    assert.deepEqual(await f.make().run(operation,f.inputs),{...first,replayed:true});assert.equal(f.control.reviewCalls,calls);
    const evidence=await f.list('evidence');assert.equal(evidence.entries.filter(x=>x.key.startsWith('configuration/approvals/')).length,1);
  });
  test(`${backend}: concurrent same-intent approvals share one accepted receipt`,async t=>{
    const f=await namespaceConfigurationFixture(t,{backend});
    const results=await Promise.all([f.make().run(operation,f.inputs),f.make().run(operation,f.inputs)]);
    assert.equal(results[0].revision,results[1].revision);assert.equal(results.filter(x=>x.replayed===false).length,1);
  });
  test(`${backend}: only one competing initial configuration can win its absent-head precondition`,async t=>{
    const f=await namespaceConfigurationFixture(t,{backend});
    const outcomes=await Promise.allSettled([f.make().run(operation,f.inputs),f.make().run(operation,{...f.inputs,operationId:'competing-review'})]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    const failure=outcomes.find(x=>x.status==='rejected').reason;assert.ok(['ENGINE_CONTEXT_CHANGED','SDA_NAMESPACE_REVISION_CONFLICT'].includes(failure.code),failure.code);
  });
  test(`${backend}: revoked human authority preserves a resumable intent and never accepts the decision`,async t=>{
    const f=await namespaceConfigurationFixture(t,{backend});f.control.reviewHook=count=>{if(count===2)f.control.permissions=[];};
    await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_AUTHORITY_REQUIRED'});assert.equal((await f.head()).status,'missing');
    f.control.reviewHook=()=>{};f.control.permissions=['configuration.approve'];f.control.now='2027-01-01T00:00:00.000Z';
    const result=await f.make().run(operation,f.inputs);assert.equal(result.recordedAt,'2026-11-08T00:00:00.000Z');
  });
  test(`${backend}: unknown acceptance is inspected using the same operation ID`,async t=>{
    const f=await namespaceConfigurationFixture(t,{backend});let thrown=false;
    const cause=new SingularityFlowError('Lost acknowledgement.',{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN',outcomeClass:'OUTCOME_UNKNOWN'});
    const records={...f.records,async transact(scope,tx,options){const r=await f.records.transact(scope,tx,options);
      if(tx.operationId.startsWith('config-approve-')&&!thrown){thrown=true;throw cause;}return r;}};
    await assert.rejects(f.make({records}).run(operation,f.inputs),e=>e===cause);
    const head=await f.head(),result=await f.make().run(operation,f.inputs);assert.equal(result.replayed,true);assert.equal(result.revision,head.record.version);
  });
}

test('a project must be genuinely enrolled before configuration approval',async t=>{
  const f=await namespaceConfigurationFixture(t,{enroll:false});await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_PROJECT_NOT_ENROLLED'});
});

test('service identity and changed reviewers cannot claim a human decision',async t=>{
  const f=await namespaceConfigurationFixture(t);f.control.actorKind='service';
  await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_AUTHORITY_REQUIRED'});
  f.control.actorKind='human';f.control.reviewHook=count=>{if(count===3)f.control.principalId='other-reviewer';};
  await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_ACTOR_CHANGED'});
  assert.equal((await f.head()).status,'missing');
});

test('every definition, role and dependency gap is refused before an approval intent is written',async t=>{
  const f=await namespaceConfigurationFixture(t);
  const mutations=[s=>{s.definition.version=1;},s=>{s.definition.agentCatalog=[];},s=>{s.agents[0].mode='read-only-review';},
    s=>{s.agents[0].defaultFor=[];},s=>{s.agents[0].phases=['unknown'];},s=>{s.skills[0].instructions.push('missing');},
    s=>{s.agents[0].skills.push('absent');},s=>{s.skills[0].skills=['framework'];},s=>{s.templates=[];},
    s=>{s.definition.planning={enabled:true,promptSource:'singularity/prompts/missing.md'};},
    s=>{s.agents[0].tools=['read','read'];},
    s=>{s.templates[0].path='src/application.js';},s=>{s.files=[{...s.templates[0],path:'singularity/templates/INTAKE.md'}];},
    s=>{s.templates[0].path='singularity/work-items/secret.md';},s=>{s.definition.workTypes.simple.constitution={mode:'enforce',path:'singularity/constitution.md'};}];
  for(const [i,mutate]of mutations.entries()) {
    const input=await changed(f,mutate,{operationId:`invalid-${i}`});await assert.rejects(f.engine.run(operation,input));assert.equal((await f.head()).status,'missing');
  }
  assert.equal((await f.list('runtime')).entries.filter(x=>x.key.startsWith('configuration/')).length,0);
});

test('missing and corrupted resource bytes preserve their exact binding and never publish',async t=>{
  const f=await namespaceConfigurationFixture(t),input=await changed(f,s=>{s.instructions[0].body.sha256='a'.repeat(64);});
  await assert.rejects(f.engine.run(operation,input),e=>e.code==='ENGINE_STORAGE_CONTENT_MISSING'&&e.details.reference.sha256==='a'.repeat(64));
  const target=f.source.skills[0].body;
  const content={...f.content,async read(scope,ref,options){const r=await f.content.read(scope,ref,options);
    return ref.sha256===target.sha256?{...r,data:new Uint8Array(ref.bytes)}:r;}};
  await assert.rejects(f.make({content}).run(operation,f.inputs),{code:'ENGINE_STORAGE_CORRUPT'});assert.equal((await f.head()).status,'missing');
});

test('binary configuration files are retained while malformed instruction text is refused',async t=>{
  const f=await namespaceConfigurationFixture(t),bytes=Buffer.from([0,255,1,128]);
  const binary=(await f.content.put(f.scope,'config',bytes)).reference;
  const empty=(await f.content.put(f.scope,'config',Buffer.alloc(0))).reference;
  const accepted=await changed(f,s=>{s.files=[{path:'singularity/assets/reference.bin',body:binary},{path:'singularity/assets/empty.dat',body:empty}];});
  const result=await f.engine.run(operation,accepted),compiled=await readJson(f,result.configuration);
  assert.deepEqual(Buffer.from((await f.content.read(f.scope,compiled.files[0].body)).data),bytes);
  assert.equal((await f.content.read(f.scope,compiled.files[1].body)).data.byteLength,0);
  const bad=await changed(f,s=>{s.instructions[0].body=binary;},{operationId:'invalid-text',expectedRevision:result.revision});
  await assert.rejects(f.make().run(operation,bad),{code:'ENGINE_CONFIGURATION_INVALID'});
  assert.equal((await f.head()).record.version,result.revision);
});

test('later configuration uses the reviewed base and does not rewrite earlier approvals',async t=>{
  const f=await namespaceConfigurationFixture(t),first=await f.engine.run(operation,f.inputs);
  const secondInputs=await changed(f,s=>{s.agents[0].label='Updated analyst';},{operationId:'configuration-2',expectedRevision:first.revision});
  const second=await f.make().run(operation,secondInputs);assert.notEqual(second.configuration.sha256,first.configuration.sha256);
  assert.equal((await f.head()).record.version,second.revision);
  assert.deepEqual(await f.make().run(operation,f.inputs),{...first,replayed:true});
  await assert.rejects(f.make().run(operation,{...f.inputs,reason:'A different decision.'}),{code:'ENGINE_OPERATION_ID_REUSED'});
  await assert.rejects(f.make().run(operation,{...secondInputs,operationId:'stale-base'}),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.equal((await f.content.read(f.scope,first.configuration)).status,'present');
});

test('authority fencing between preparation and conditional acceptance prevents the write',async t=>{
  const f=await namespaceConfigurationFixture(t);f.control.reviewHook=async count=>{
    if(count!==2)return;const a=await f.readAuthority();
    await f.records.transact(f.scope,{operationId:'fence-authority',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:a.record.version}],
      changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...a.record.value,status:'fenced'}}],events:[]});
  };
  await assert.rejects(f.engine.run(operation,f.inputs),{code:'ENGINE_AUTHORITY_FENCED'});assert.equal((await f.head()).status,'missing');
});

test('the final transaction also checks authority changed after the last read',async t=>{
  const f=await namespaceConfigurationFixture(t);let fenced=false;
  const records={...f.records,async transact(scope,tx,options){
    if(tx.operationId.startsWith('config-approve-')&&!fenced){fenced=true;const a=await f.readAuthority();
      await f.records.transact(scope,{operationId:'fence-at-write',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:a.record.version}],
        changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...a.record.value,status:'fenced'}}],events:[]});}
    return f.records.transact(scope,tx,options);
  }};
  await assert.rejects(f.make({records}).run(operation,f.inputs),{code:'SDA_NAMESPACE_REVISION_CONFLICT'});assert.equal((await f.head()).status,'missing');
});

test('cancellation before acceptance is preserved, and cancellation after acceptance acknowledges the receipt',async t=>{
  const f=await namespaceConfigurationFixture(t),before=new AbortController();before.abort();
  await assert.rejects(f.engine.run(operation,f.inputs,{signal:before.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  const after=new AbortController(),records={...f.records,async transact(scope,tx,options){const r=await f.records.transact(scope,tx,options);
    if(tx.operationId.startsWith('config-approve-'))after.abort();return r;}};
  const result=await f.make({records}).run(operation,f.inputs,{signal:after.signal});assert.equal(result.status,'approved');
});

test('actual identity-port failures and future retained schemas keep their causes',async t=>{
  const f=await namespaceConfigurationFixture(t),unavailable=new Error('Identity service unavailable.');
  await assert.rejects(f.make({access:{current(){throw unavailable;}}}).run(operation,f.inputs),e=>e===unavailable);
  const records={...f.records,async read(scope,namespace,key,options){const r=await f.records.read(scope,namespace,key,options);
    return key===LIFECYCLE_AUTHORITY_KEY?{...r,record:{...r.record,value:{...r.record.value,schemaVersion:2}}}:r;}};
  await assert.rejects(f.make({records}).run(operation,f.inputs),e=>e.code==='ENGINE_STORAGE_UNSUPPORTED'&&e.cause.code==='SCHEMA_VERSION_FUTURE');
});

test('bounded JSON grammar preserves captured namespace values, errors, identities and rule bodies',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/engine-configuration-approval/json-values-v1.json',import.meta.url),'utf8'));
  const cases=[['normal',()=>({b:[1,true,null,'é'],a:{n:-0}})],['dangerous-key',()=>JSON.parse('{"__proto__":{"x":1},"10":10,"2":2}')],
    ['undefined',()=>({x:undefined})],['nan',()=>({x:NaN})],['sparse',()=>new Array(2)],['extended-array',()=>Object.assign([],{x:1})],
    ['cycle',()=>{const a={};a.self=a;return a;}],['getter',()=>Object.defineProperty({},'x',{enumerable:true,get(){throw Error('getter must not run');}})],
    ['utf8-budget',()=>({x:'é'.repeat(20)}),{maxBytes:30}],['depth',()=>({a:{b:1}}),{maxDepth:1}],['null-prototype',()=>Object.assign(Object.create(null),{x:1})]];
  const results=cases.map(([name,build,options])=>{try{const value=namespaceJson(build(),options);return{name,value,identity:namespaceIdentityJson(value)};}
    catch(e){return{name,error:{name:e.name,constructor:e.constructor.name,message:e.message,code:e.code,details:e.details,exitCode:e.exitCode}};}});
  assert.deepEqual(JSON.parse(JSON.stringify(results)),fixture.results);
  const text=await readFile(new URL('../src/foundation/record-schema.mjs',import.meta.url),'utf8'),ast=ts.createSourceFile('foundation',text,ts.ScriptTarget.Latest,true);
  const found=new Map();const visit=node=>{if(ts.isFunctionDeclaration(node)&&Object.hasOwn(fixture.functions,node.name?.text??''))found.set(node.name.text,node);ts.forEachChild(node,visit);};visit(ast);
  const printer=ts.createPrinter({removeComments:true});
  for(const [name,expected]of Object.entries(fixture.functions)) {
    const normalized=printer.printNode(ts.EmitHint.Unspecified,found.get(name).body,ast).replaceAll('limitCode',"'SDA_NAMESPACE_LIMIT_INVALID'");
    assert.equal(createHash('sha256').update(normalized).digest('hex'),expected,name);
  }
  assert.equal(namespaceConfigurationJsonValues().namespaceJson('x'.repeat(300_000)).length,300_000);
  assert.throws(()=>namespaceJson('x'.repeat(300_000)),{code:'SDA_NAMESPACE_LIMIT_INVALID'});
  let reads=0;const malformed={maximumBytes:1,maximumDepth:1,maximumNodes:1,inputCode:'INPUT',get limitCode(){reads++;return 'LIMIT';}};
  assert.throws(()=>jsonValueContract(malformed),{code:'ENGINE_JSON_CONTRACT_INVALID'});assert.equal(reads,0);
});

test('all shipped workflows retain their native resolved meaning with actual packaged resources',async t=>{
  const f=await namespaceConfigurationFixture(t),{source,expected}=await seededNamespaceConfiguration(f);
  const ref=await f.store(source),result=await f.engine.run(operation,{...f.inputs,source:ref,confirm:ref.sha256});
  const compiled=await readJson(f,result.configuration);
  assert.deepEqual(compiled.workTypeIds,Object.keys(expected));
  assert.ok(compiled.workTypeIds.includes('spec-driven-standard'));assert.ok(compiled.skills.length>0);assert.ok(compiled.instructions.length>0);
  assert.ok(result.advisories.count>0);assert.equal(result.advisories.count,compiled.warnings.length);
  for(const [id,resolution]of Object.entries(expected)) {
    assert.deepEqual(compiled.workflows[id],resolution,id+' must retain the original effective contract');
    assert.deepEqual(JSON.parse(JSON.stringify(resolveWorkType(compiled.definition,id))),resolution,id);
  }
  for(const agent of source.agents)assert.deepEqual(compiled.agents.find(x=>x.id===agent.id).skillBindings,agent.skillBindings);
});

test('a concurrent completed approval is acknowledged when the original invocation observes a changed head',async t=>{
  const f=await namespaceConfigurationFixture(t);let concurrent;
  f.control.reviewHook=async count=>{if(count===2)concurrent=await f.make().run(operation,f.inputs);};
  const result=await f.engine.run(operation,f.inputs);assert.deepEqual(result,{...concurrent,replayed:true});
});

test('reapproving identical content uses its immutable version and returns the actual new head revision',async t=>{
  const f=await namespaceConfigurationFixture(t),first=await f.engine.run(operation,f.inputs);
  const result=await f.make().run(operation,{...f.inputs,operationId:'review-again',expectedRevision:first.revision,reason:'Reviewed this same content again.'});
  assert.deepEqual(result.configuration,first.configuration);assert.equal((await f.head()).record.version,result.revision);
  assert.equal((await f.list('config')).entries.length,2);
});

test('final resource verification preserves a draft when an issued body cannot be read correctly',async t=>{
  const f=await namespaceConfigurationFixture(t),target=f.source.instructions[0].body;let prepared=false;
  const records={...f.records,async transact(scope,tx,options){const r=await f.records.transact(scope,tx,options);
    if(tx.operationId.startsWith('config-prepare-'))prepared=true;return r;}};
  const content={...f.content,async read(scope,ref,options){const r=await f.content.read(scope,ref,options);
    return prepared&&ref.sha256===target.sha256?{...r,data:new Uint8Array(ref.bytes)}:r;}};
  await assert.rejects(f.make({records,content}).run(operation,f.inputs),{code:'ENGINE_STORAGE_CORRUPT'});
  assert.equal((await f.head()).status,'missing');const result=await f.make().run(operation,f.inputs);assert.equal(result.recordedAt,'2026-11-08T00:00:00.000Z');
});

test('a malformed acceptance receipt never hides the durable original outcome',async t=>{
  const f=await namespaceConfigurationFixture(t),records={...f.records,async transact(scope,tx,options){const r=await f.records.transact(scope,tx,options);
    return tx.operationId.startsWith('config-approve-')?{...r,receipt:{...r.receipt,records:r.receipt.records.filter(x=>x.key!==NAMESPACE_CONFIGURATION_HEAD_KEY)}}:r;}};
  await assert.rejects(f.make({records}).run(operation,f.inputs),{code:'ENGINE_PORT_RESULT_INVALID'});
  const result=await f.make().run(operation,f.inputs);assert.equal(result.replayed,true);assert.equal(result.revision,(await f.head()).record.version);
});

for(const backend of ['filesystem','sqlite','application'])test(`${backend}: lost preparation acknowledgement resumes the retained intent`,async t=>{
  const f=await namespaceConfigurationFixture(t,{backend});let failed=false;
  const cause=new SingularityFlowError('Preparation acknowledgement unavailable.',{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN'});
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(tx.operationId.startsWith('config-prepare-')&&!failed){failed=true;throw cause;}return result;}};
  await assert.rejects(f.make({records}).run(operation,f.inputs),e=>e===cause);assert.equal((await f.head()).status,'missing');
  f.control.now='2027-01-01T00:00:00.000Z';const result=await f.make().run(operation,f.inputs);assert.equal(result.recordedAt,'2026-11-08T00:00:00.000Z');
});
