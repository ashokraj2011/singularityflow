import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {namespaceSourceControlFixture} from './helpers/namespace-source-control-fixture.mjs';
import {createNamespaceSourceControlEngine} from '../src/engine-storage/namespace-source-control.mjs';
import {createNamespaceSourceControlReader} from '../src/engine-storage/namespace-source-control-reader.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespacePublicationEngine} from '../src/engine-storage/namespace-publication.mjs';
import {createNamespaceSourceRetentionEngine} from '../src/engine-storage/namespace-source-retention.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';
import {repositoryChangeSetDigest,withRepositoryChangeEntryIdentity} from '../src/engine-compatibility/node-source-policy.mjs';
import {ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=async(f,ref)=>JSON.parse(Buffer.from((await f.content.read(f.scope,ref,{maximumBytes:ref.bytes})).data));
const absent=async f=>assert.equal(await createNamespaceSourceControlReader(f.options).accepted(f.input),null);
for(const backend of ['filesystem','sqlite','application'])test(`${backend}: actual Git observations have accepted source/generation receipts and survive checkout-free takeover`,async t=>{
  const f=await namespaceSourceControlFixture(t,{backend}),head=await f.head(),writes=[];
  const content={...f.content,async put(...args){writes.push(Buffer.from(args[2]));return f.content.put(...args);}};
  const result=await f.make({content}).run('phase.source-control.retain',f.input),body=await json(f,result.record.content),observation=await json(f,body.repositories[0].observation);
  assert.equal(result.status,'recorded');assert.equal(result.sourceControlEvidenceRetained,true);assert.equal(result.sourceContentsRetained,false);
  assert.equal(result.publicationReadinessInspected,false);assert.equal(result.effects.canonicalStateChanged,false);assert.equal(result.effects.phasePublished,false);
  assert.deepEqual(await f.head(),head);assert.equal(writes.some(value=>value.includes(f.localDocument)),false);
  assert.equal(observation.control.base.commit,f.baselineCommit);assert.ok(observation.control.entries.some(row=>row.status==='renamed'&&row.oldPath==='old.txt'&&row.newPath==='renamed.txt'));
  assert.equal(observation.current.snapshot.entries.find(row=>row.path==='app.js').sha256,hash('export const answer = 43;'));
  const accepted=await createNamespaceSourceControlReader(f.options).accepted(f.input);
  assert.deepEqual(accepted.plan.source.result,f.source.record);assert.equal(accepted.plan.generation,1);assert.equal(accepted.source.plan.generationIntent.id,observation.subject.generationIntentId);
  assert.equal(body.totals.changes,observation.control.entries.length);assert.equal(JSON.stringify(result).includes(f.sourceRoot),false);
  const captures=f.captureControl.captures;await rm(f.sourceRoot,{recursive:true});f.control.agentId=null;f.control.permissions=[];
  const replay=await createNamespaceSourceControlEngine({...f.options,sources:[],sourceReaders:[],sourceControlReaders:[],localRecords:null,localContent:null,
    clock:{now(){assert.fail('Accepted evidence cannot be restamped.');}}}).run('phase.source-control.retain',f.input);
  assert.deepEqual(replay.record,result.record);assert.deepEqual(replay.repositories,result.repositories);assert.equal(replay.recordedAt,result.recordedAt);
  assert.equal(replay.status,'retained');assert.equal(replay.effects.committed,false);assert.equal(f.captureControl.captures,captures);
});
test('one namespace Engine exposes the operation and captures the explicit control capabilities',async t=>{
  const f=await namespaceSourceControlFixture(t),{localRecords,localContent,...options}=f.options;
  const engine=createNamespaceEngine({...options,working:{records:localRecords,content:localContent}});
  const result=await engine.run('phase.source-control.retain',f.input);assert.equal(result.status,'recorded');
  assert.equal(ENGINE_OPERATIONS.find(row=>row.id==='phase.source-control.retain').authority,'phase.source.retain');
  f.control.permissions.push('phase.publish');
  await assert.rejects(createNamespacePublicationEngine(f.options).run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),
    failure=>failure.code==='ENGINE_PORT_UNAVAILABLE'&&failure.details.required.includes('code-delivery'));
});
test('two selected repositories keep separate source, Git baseline and observation bindings',async t=>{
  const f=await namespaceSourceControlFixture(t,{extraRepository:true}),result=await f.engine.run('phase.source-control.retain',f.input),body=await json(f,result.record.content);
  assert.deepEqual(body.repositories.map(row=>row.id),['app','backend']);assert.equal(result.totals.repositories,2);
  const one=await json(f,body.repositories[0].observation),two=await json(f,body.repositories[1].observation);
  assert.equal(one.control.base.commit,f.baselineCommit);assert.equal(two.control.base.commit,f.additional.baselineCommit);
  assert.notEqual(one.current.snapshot.entries.find(row=>row.path==='app.js').sha256,two.current.snapshot.entries.find(row=>row.path==='app.js').sha256);
  assert.equal(two.current.snapshot.repositoryId,'backend');assert.equal(one.current.snapshot.repositoryId,'app');
});
test('a missing accepted source archive returns the exact in-phase retention prerequisite',async t=>{
  const f=await namespaceSourceControlFixture(t,{retain:false});
  await assert.rejects(f.engine.run('phase.source-control.retain',f.input),failure=>{
    assert.equal(failure.code,'ENGINE_SOURCE_RETENTION_REQUIRED');assert.equal(failure.details.operation,'phase.source.retain');
    assert.deepEqual(failure.details.inputs,{workId:f.inputs.workId,phaseId:'intake'});return true;});
  assert.equal(f.captureControl.captures,0);await absent(f);
  await createNamespaceSourceRetentionEngine(f.options).run('phase.source.retain',f.sourceInput);
  assert.equal((await f.engine.run('phase.source-control.retain',f.input)).status,'recorded');
});
test('a read-only reviewer cannot create control evidence as the phase author',async t=>{
  const f=await namespaceSourceControlFixture(t,{configure:source=>source.agents.push({...source.agents[0],id:'independent-review',label:'Independent review',defaultFor:[],mode:'read-only-review'})});
  f.control.agentId='independent-review';
  await assert.rejects(f.engine.run('phase.source-control.retain',f.input),{code:'SOURCE_REVIEW_REVIEWER_CANNOT_PREPARE'});
  assert.equal(f.captureControl.captures,0);await absent(f);
});
test('missing controls and caller-supplied readiness cannot authorize evidence',async t=>{
  const f=await namespaceSourceControlFixture(t);
  await assert.rejects(f.make({sourceControlReaders:[]}).run('phase.source-control.retain',f.input),{code:'ENGINE_SOURCE_CONTROL_READER_UNAVAILABLE'});
  await assert.rejects(f.engine.run('phase.source-control.retain',{...f.input,ready:true}),{code:'ENGINE_INPUT_INVALID'});
  assert.equal(f.captureControl.captures,0);await absent(f);
});
test('self-consistent hashes cannot disguise wrong source bytes, omitted changes or another baseline',async t=>{
  const f=await namespaceSourceControlFixture(t);
  for(const change of [
    value=>{value.control.entries=value.control.entries.map(row=>row.newPath==='app.js'?withRepositoryChangeEntryIdentity({...row,newContent:{...row.newContent,sha256:'sha256:'+'0'.repeat(64)}}):row);},
    value=>{value.control.entries=[];},
    value=>{value.control.entries=[null];},
    value=>{value.baseline.entries.find(row=>row.path==='app.js').sha256='0'.repeat(64);}
  ]){
    const port={descriptor:f.controlReader.descriptor,async capture(...args){const answer=await f.actualReader.capture(...args),value=structuredClone(answer.observation);change(value);
      if(value.control.entries.every(Boolean))value.control.digest=repositoryChangeSetDigest(value.control);return {...answer,observation:value,revision:'sha256:'+hash(canonicalJson(value))};}};
    await assert.rejects(f.make({sourceControlReaders:[port]}).run('phase.source-control.retain',f.input),{code:'ENGINE_SOURCE_CONTROL_BINDING_INVALID'});await absent(f);
  }
  assert.equal((await f.engine.run('phase.source-control.retain',f.input)).status,'recorded');
});
test('a wrong reader subject or observation digest cannot become accepted origin evidence',async t=>{
  const f=await namespaceSourceControlFixture(t);
  for(const capture of [async(...args)=>({...await f.actualReader.capture(...args),revision:'sha256:'+'0'.repeat(64)}),
    async(subject,options)=>f.actualReader.capture({...subject,generation:subject.generation+1},options)]){
    await assert.rejects(f.make({sourceControlReaders:[{descriptor:f.controlReader.descriptor,capture}]}).run('phase.source-control.retain',f.input),
      failure=>['ENGINE_PORT_RESULT_INVALID','SGOS_SOURCE_CONTROL_CONTRACT_INVALID'].includes(failure.code));await absent(f);
  }
});
test('a real reader failure after preparation preserves its identity and resumes the same accepted intent',async t=>{
  const f=await namespaceSourceControlFixture(t),failure=new SingularityFlowError('The selected local Git observation timed out.',{
    code:'SGOS_SOURCE_CONTROL_TIMEOUT',details:{stage:'diff',timeoutMs:300000}});
  f.captureControl.hook=async calls=>{if(calls===3)throw failure;};
  await assert.rejects(f.engine.run('phase.source-control.retain',f.input),value=>value===failure);await absent(f);
  const prepared=await createNamespaceSourceControlReader(f.options).intent(f.input);assert.ok(prepared);
  f.captureControl.hook=async()=>{};const result=await f.engine.run('phase.source-control.retain',f.input);
  assert.equal(result.status,'recorded');assert.deepEqual((await createNamespaceSourceControlReader(f.options).intent(f.input)).reference,prepared.reference);
});
test('source drift during collection requires refreshed source evidence and preserves the original control intent',async t=>{
  const f=await namespaceSourceControlFixture(t);let changed=false;
  const content={...f.content,async put(...args){const result=await f.content.put(...args);
    if(!changed&&args[1]==='evidence'&&Buffer.from(args[2]).includes('sflow-source-control-observation/v1')){changed=true;await writeFile(path.join(f.sourceRoot,'app.js'),'concurrent source bytes');}return result;}};
  await assert.rejects(f.make({content}).run('phase.source-control.retain',f.input),failure=>failure.code==='ENGINE_SOURCE_CHANGED'&&failure.details.operation==='phase.source.retain');
  await absent(f);assert.ok(await createNamespaceSourceControlReader(f.options).intent(f.input));
  await writeFile(path.join(f.sourceRoot,'app.js'),'export const answer = 43;');
  assert.equal((await f.engine.run('phase.source-control.retain',f.input)).status,'recorded');
});
test('Git metadata movement after preparation cannot reuse the earlier observation',async t=>{
  const f=await namespaceSourceControlFixture(t);f.captureControl.hook=async calls=>{if(calls===2)f.git('commit','--allow-empty','-qm','concurrent metadata');};
  await assert.rejects(f.engine.run('phase.source-control.retain',f.input),{code:'ENGINE_SOURCE_CHANGED'});await absent(f);
  f.captureControl.hook=async()=>{};assert.equal((await f.engine.run('phase.source-control.retain',{...f.input,operationId:'retain-current-controls'})).status,'recorded');
});
test('permission revocation at the last capture prevents acceptance and restoration resumes the same phase',async t=>{
  const f=await namespaceSourceControlFixture(t),permissions=[...f.control.permissions];
  f.captureControl.hook=async calls=>{if(calls===3)f.control.permissions=[];};
  await assert.rejects(f.engine.run('phase.source-control.retain',f.input),{code:'ENGINE_AUTHORITY_REQUIRED'});await absent(f);
  f.control.permissions=permissions;f.captureControl.hook=async()=>{};
  assert.equal((await f.engine.run('phase.source-control.retain',f.input)).status,'recorded');
});
test('lost final acknowledgement reopens its accepted receipt without recapture or a new timestamp',async t=>{
  const f=await namespaceSourceControlFixture(t),failure=new SingularityFlowError('Control acceptance response was lost.',{
    code:'SDA_NAMESPACE_OUTCOME_UNKNOWN',outcomeClass:'OUTCOME_UNKNOWN'});let once=false;
  const records={...f.records,async transact(scope,tx,options){const answer=await f.records.transact(scope,tx,options);
    if(!once&&tx.changes.some(row=>row.key.startsWith('source-control/results/'))){once=true;throw failure;}return answer;}};
  await assert.rejects(f.make({records}).run('phase.source-control.retain',f.input),value=>value===failure);const captures=f.captureControl.captures;
  const result=await f.make({sources:[],sourceReaders:[],sourceControlReaders:[],localRecords:null,localContent:null,
    clock:{now(){assert.fail('An accepted result retains its original clock value.');}}}).run('phase.source-control.retain',f.input);
  assert.equal(result.status,'retained');assert.equal(f.captureControl.captures,captures);
});
test('authority fencing preserves receipt acknowledgement while refusing new control acceptance',async t=>{
  const f=await namespaceSourceControlFixture(t),result=await f.engine.run('phase.source-control.retain',f.input),active=await f.records.read(f.scope,'state',LIFECYCLE_AUTHORITY_KEY);
  await f.records.transact(f.scope,{operationId:'fence-control-writes',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:active.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...active.record.value,status:'fenced'}}],events:[]});
  const archived=await f.make({sources:[],sourceReaders:[],sourceControlReaders:[],localRecords:null,localContent:null}).run('phase.source-control.retain',f.input);
  assert.deepEqual(archived.record,result.record);
  await assert.rejects(f.engine.run('phase.source-control.retain',{...f.input,operationId:'control-after-fence'}),{code:'ENGINE_AUTHORITY_FENCED'});
});
test('concurrent control retention has one accepted result and another person cannot acknowledge it',async t=>{
  const f=await namespaceSourceControlFixture(t),[one,two]=await Promise.all([f.engine.run('phase.source-control.retain',f.input),f.make().run('phase.source-control.retain',f.input)]);
  assert.deepEqual(one.record,two.record);assert.equal(one.recordedAt,two.recordedAt);
  assert.equal((await f.records.list(f.scope,'evidence',{prefix:'source-control/results/',limit:100})).entries.length,1);
  f.control.principalId='another-person';await assert.rejects(f.engine.run('phase.source-control.retain',f.input),{code:'ENGINE_ACTOR_CHANGED'});
});
test('an accepted control proof cannot hide an actual shared-content permission error',async t=>{
  const f=await namespaceSourceControlFixture(t),result=await f.engine.run('phase.source-control.retain',f.input),body=await json(f,result.record.content),
    failure=new SingularityFlowError('Evidence storage permission denied.',{code:'SDA_CONTENT_UNAVAILABLE'});
  const content={...f.content,async read(scope,reference,options){if(reference.sha256===body.repositories[0].observation.sha256&&reference.namespace==='evidence')throw failure;return f.content.read(scope,reference,options);}};
  await assert.rejects(createNamespaceSourceControlReader({...f.options,content}).accepted(f.input),value=>value===failure);
});
