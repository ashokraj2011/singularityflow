import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {namespaceSourceRetentionFixture} from './helpers/namespace-source-retention-fixture.mjs';
import {namespacePreparationFixture} from './helpers/namespace-preparation-fixture.mjs';
import {createNamespaceSourceRetentionEngine} from '../src/engine-storage/namespace-source-retention.mjs';
import {createNamespaceSourceRetentionReader} from '../src/engine-storage/namespace-source-retention-reader.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceSourceEngine} from '../src/engine-storage/namespace-source.mjs';
import {createNamespacePublicationEngine} from '../src/engine-storage/namespace-publication.mjs';
import {createFilesystemSourceUnit,createFilesystemSourceContentReader} from '../src/sgos/filesystem-source-unit.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import {SingularityFlowError} from '../src/foundation/failures.mjs';
import {ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const json=async(f,ref)=>JSON.parse(Buffer.from((await f.content.read(f.scope,ref,{maximumBytes:ref.bytes})).data));
async function files(f,result) {
  const body=await json(f,result.record.content),repository=await json(f,body.repositories[0].manifest);
  return {body,repository};
}
for(const backend of ['filesystem','sqlite','application'])test(`${backend}: real changed source is chunked, replayable and separate from code publication`,async t=>{
  const f=await namespaceSourceRetentionFixture(t,{backend}),before=await f.head(),writes=[];
  const content={...f.content,descriptor:{...f.content.descriptor,maximumBytes:32768},put(...args){
    assert.ok(args[2].byteLength<=32768,'files larger than the store blob limit must use chunks');writes.push(Buffer.from(args[2]));return f.content.put(...args);}};
  const result=await f.make({content}).run('phase.source.retain',f.input),{body,repository}=await files(f,result);
  assert.equal(result.status,'recorded');assert.equal(result.generation,1);assert.equal(result.sourceContentsRetained,true);
  assert.equal(result.baselineContentsRetained,false);assert.equal(result.effects.canonicalStateChanged,false);assert.equal(result.effects.phasePublished,false);
  assert.equal(result.effects.sourceFilesChanged,false);assert.equal(result.publicationReadinessInspected,false);
  assert.equal(body.totals.added,2);assert.equal(body.totals.modified,1);assert.equal(body.totals.removed,1);assert.equal(body.totals.files,3);
  assert.equal(body.totals.bytes,200000+Buffer.byteLength('export const answer = 43;'));assert.ok(body.totals.chunks>20);
  assert.deepEqual(repository.entries.map(entry=>entry.newPath??entry.oldPath),['app.js','binary.bin','empty.js','gone.js']);
  for(const entry of repository.entries){
    const chunks=[];for(const ref of entry.chunks)chunks.push(Buffer.from((await f.content.read(f.scope,ref)).data));
    const bytes=Buffer.concat(chunks);
    if(entry.after){assert.equal(digest(bytes),entry.after.sha256);assert.deepEqual(bytes,await readFile(path.join(f.sourceRoot,entry.newPath)));}
    else assert.equal(bytes.byteLength,0);
  }
  assert.equal(writes.some(bytes=>bytes.includes(f.localDocument)),false,'local attachments are not copied into source evidence');
  assert.deepEqual(await f.head(),before);
  await rm(f.sourceRoot,{recursive:true});f.control.agentId=null;f.control.permissions=[];
  const replay=await createNamespaceSourceRetentionEngine({...f.options,sourceReaders:[],sources:[],localRecords:null,localContent:null,
    clock:{now(){assert.fail('An accepted source archive cannot be restamped.');}}}).run('phase.source.retain',f.input);
  assert.deepEqual(replay,{...result,status:'retained',replayed:true,effects:{...result.effects,committed:false,evidenceRecorded:false}});
});

test('the one namespace Engine exposes retention through the shared operation registry',async t=>{
  const f=await namespaceSourceRetentionFixture(t);
  const {localRecords,localContent,...options}=f.options;
  const result=await createNamespaceEngine({...options,working:{records:localRecords,content:localContent}}).run('phase.source.retain',f.input);
  assert.equal(result.status,'recorded');assert.equal(ENGINE_OPERATIONS.find(item=>item.id==='phase.source.retain').effect,'source-retention');
});

test('a qualified author handoff preserves the generation creator without borrowing approval authority',async t=>{
  const f=await namespaceSourceRetentionFixture(t);f.control.principalId='qualified-next-author';
  f.control.creator={name:'Next author',email:'next-author@example.test',login:null};
  const result=await f.engine.run('phase.source.retain',f.input),prepared=await createNamespaceSourceRetentionReader(f.options).intent(f.input);
  const generation=await json(f,prepared.plan.generationIntent.reference);
  assert.equal(result.principalId,'qualified-next-author');assert.notEqual(generation.actor.principalId,result.principalId);
  assert.equal(result.effects.approvalRecorded,false);
  f.control.permissions.push('phase.publish');
  await assert.rejects(createNamespacePublicationEngine(f.options).run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),
    failure=>failure.code==='ENGINE_PORT_UNAVAILABLE'&&failure.details.required.includes('code-delivery'));
});

test('a read-only reviewer cannot retain source as the phase author',async t=>{
  const f=await namespaceSourceRetentionFixture(t,{configure:source=>{source.agents.push({...source.agents[0],id:'independent-review',
    label:'Independent reviewer',defaultFor:[],mode:'read-only-review'});}});
  f.control.agentId='independent-review';
  await assert.rejects(f.engine.run('phase.source.retain',f.input),{code:'SOURCE_REVIEW_REVIEWER_CANNOT_PREPARE'});
  assert.equal(await createNamespaceSourceRetentionReader(f.options).accepted(f.input),null);
});

test('multiple selected repositories retain distinct file bindings even when their paths are identical',async t=>{
  const f=await namespacePreparationFixture(t,{code:true});f.control.permissions.push('phase.source.retain');
  const root=path.join(f.directory,'second-repository');await mkdir(root);
  await writeFile(path.join(root,'app.js'),'export const backend = 1;');
  const backend=await createFilesystemSourceUnit({root,id:'backend-source',projectId:f.scope.projectId,repositoryId:'backend'}),sources=[f.unit,backend];
  const options={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock,
    localRecords:f.localRecords,localContent:f.localContent,sources};
  await createNamespaceSourceEngine(options).run('source.bind',{operationId:'bind-two-sources',workId:f.inputs.workId,expectedRevision:(await f.head()).record.version,
    repositories:['backend','app'],reason:'Retain the two real selected repository baselines.'});
  await f.make({sources}).run('phase.prepare');await writeFile(path.join(root,'app.js'),'export const backend = 2;');await writeFile(path.join(f.sourceRoot,'app.js'),'export const frontend = 2;');
  const sourceReaders=await Promise.all([createFilesystemSourceContentReader({root,id:'backend-content',source:backend.descriptor}),
    createFilesystemSourceContentReader({root:f.sourceRoot,id:'frontend-content',source:f.unit.descriptor})]);
  const result=await createNamespaceSourceRetentionEngine({...options,sourceReaders}).run('phase.source.retain',{operationId:'retain-two',workId:f.inputs.workId,phaseId:'intake'});
  const body=await json(f,result.record.content),repositories=await Promise.all(body.repositories.map(item=>json(f,item.manifest)));
  assert.deepEqual(repositories.map(item=>[item.id,item.entries[0].newPath]),[['app','app.js'],['backend','app.js']]);
  assert.notEqual(repositories[0].entries[0].after.sha256,repositories[1].entries[0].after.sha256);assert.equal(result.totals.files,2);
});

test('a content-reader error or wrong bytes cannot become retained delivery facts',async t=>{
  const f=await namespaceSourceRetentionFixture(t),failure=new SingularityFlowError('The source device timed out.',{code:'SGOS_SOURCE_TIMEOUT',details:{stage:'read-content',timeoutMs:300000}});
  const broken={descriptor:f.contentReader.descriptor,read(){throw failure;}};
  await assert.rejects(f.make({sourceReaders:[broken]}).run('phase.source.retain',f.input),error=>error===failure);
  const corrupt={descriptor:f.contentReader.descriptor,async read(...args){const result=await f.contentReader.read(...args),data=Uint8Array.from(result.data);if(data.length)data[0]^=1;return {...result,data};}};
  await assert.rejects(f.make({sourceReaders:[corrupt]}).run('phase.source.retain',f.input),{code:'ENGINE_SOURCE_CHANGED'});
  const reader=createNamespaceSourceRetentionReader(f.options);assert.equal(await reader.accepted(f.input),null);
  assert.equal((await f.engine.run('phase.source.retain',f.input)).status,'recorded','repair resumes the preserved intent in the same phase');
});

test('permission revocation preserves a prepared intent and restoring permission can finish it',async t=>{
  const f=await namespaceSourceRetentionFixture(t),permissions=[...f.control.permissions];let revoke=true;
  const source={descriptor:f.contentReader.descriptor,async read(...args){const value=await f.contentReader.read(...args);if(revoke)f.control.permissions=[];return value;}};
  await assert.rejects(f.make({sourceReaders:[source]}).run('phase.source.retain',f.input),{code:'ENGINE_AUTHORITY_REQUIRED'});
  assert.equal(await createNamespaceSourceRetentionReader(f.options).accepted(f.input),null);
  revoke=false;f.control.permissions=permissions;assert.equal((await f.engine.run('phase.source.retain',f.input)).status,'recorded');
});

test('source and private draft drift cannot reuse an earlier retention plan',async t=>{
  const f=await namespaceSourceRetentionFixture(t);let changed=false;
  const source={descriptor:f.contentReader.descriptor,async read(...args){const value=await f.contentReader.read(...args);
    if(!changed){changed=true;await writeFile(path.join(f.sourceRoot,'untouched.js'),'a concurrent source change');}return value;}};
  await assert.rejects(f.make({sourceReaders:[source]}).run('phase.source.retain',f.input),{code:'ENGINE_SOURCE_CHANGED'});
  await writeFile(path.join(f.sourceRoot,'untouched.js'),'export const untouched = true;');
  const draft=await f.read(f.engine);
  const authored=await f.upload('# Updated artifact');
  await f.engine.run('phase.draft.write',{operationId:'new-draft-after-retention',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:authored,reason:'Repair the actual authored artifact in the same phase.'});
  await assert.rejects(f.engine.run('phase.source.retain',f.input),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.equal((await f.engine.run('phase.source.retain',{...f.input,operationId:'retain-repaired-source'})).status,'recorded');
});

test('a lost final acknowledgement keeps its real error and reopens the accepted receipt without a checkout',async t=>{
  const f=await namespaceSourceRetentionFixture(t),failure=new SingularityFlowError('Source acceptance acknowledgement was lost.',{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN',outcomeClass:'OUTCOME_UNKNOWN',details:{stage:'commit-response'}});let once=false;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    if(!once&&tx.changes.some(change=>change.key.startsWith('source-retention/results/'))){once=true;throw failure;}return result;}};
  await assert.rejects(f.make({records}).run('phase.source.retain',f.input),error=>error===failure);
  const result=await createNamespaceSourceRetentionEngine({...f.options,sources:[],sourceReaders:[],localRecords:null,localContent:null,
    clock:{now(){assert.fail('An accepted archive must retain its original timestamp.');}}}).run('phase.source.retain',f.input);
  assert.equal(result.replayed,true);assert.equal(result.status,'retained');
});

test('fencing stops new acceptance but preserves the acknowledgement of an already accepted archive',async t=>{
  const f=await namespaceSourceRetentionFixture(t),result=await f.engine.run('phase.source.retain',f.input);
  const active=await f.records.read(f.scope,'state',LIFECYCLE_AUTHORITY_KEY);
  await f.records.transact(f.scope,{operationId:'fence-retained-sources',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:active.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...active.record.value,status:'fenced'}}],events:[]});
  const archived=await f.make({sources:[],sourceReaders:[],localRecords:null,localContent:null}).run('phase.source.retain',f.input);
  assert.deepEqual(archived.record,result.record);assert.equal(archived.replayed,true);
  await assert.rejects(f.engine.run('phase.source.retain',{...f.input,operationId:'retain-after-fence'}),{code:'ENGINE_AUTHORITY_FENCED'});
});

test('concurrent retention keeps one accepted result and replay rejects another authenticated person',async t=>{
  const f=await namespaceSourceRetentionFixture(t);
  const [first,second]=await Promise.all([f.engine.run('phase.source.retain',f.input),f.make().run('phase.source.retain',f.input)]);
  assert.deepEqual(first.record,second.record);assert.deepEqual(first.totals,second.totals);assert.equal(first.recordedAt,second.recordedAt);
  const records=await f.records.list(f.scope,'evidence',{prefix:'source-retention/results/',limit:100});assert.equal(records.entries.length,1);
  f.control.principalId='another-person';await assert.rejects(f.engine.run('phase.source.retain',f.input),{code:'ENGINE_ACTOR_CHANGED'});
});

test('accepted source content cannot hide a missing blob or a storage permission error',async t=>{
  const f=await namespaceSourceRetentionFixture(t),result=await f.engine.run('phase.source.retain',f.input),{repository}=await files(f,result);
  const chunk=repository.entries.find(entry=>entry.chunks.length).chunks[0],failure=new SingularityFlowError('Evidence access denied.',{code:'EACCES',details:{stage:'read-blob'}});
  let missing=true;
  const content={...f.content,read(scope,ref,options){if(ref.namespace===chunk.namespace&&ref.sha256===chunk.sha256){if(missing)return {status:'missing',data:null};throw failure;}return f.content.read(scope,ref,options);}};
  await assert.rejects(f.make({content,sources:[],sourceReaders:[],localRecords:null,localContent:null}).run('phase.source.retain',f.input),{code:'ENGINE_STORAGE_CONTENT_MISSING'});
  missing=false;await assert.rejects(f.make({content,sources:[],sourceReaders:[],localRecords:null,localContent:null}).run('phase.source.retain',f.input),error=>error===failure);
});

test('actual accepted metadata and valid blob hashes cannot disguise incorrect reconstructed source bytes',async t=>{
  const f=await namespaceSourceRetentionFixture(t),result=await f.engine.run('phase.source.retain',f.input),{body,repository}=await files(f,result);
  const reader=createNamespaceSourceRetentionReader(f.options),prepared=await reader.intent(f.input),input={...f.input,operationId:'forged-source-retention'};
  const plan={...prepared.plan,input,parametersSha256:digest(canonicalJson({input,binding:reader.codec.binding}))};
  const store=async(namespace,value)=>(await f.content.put(f.scope,namespace,Buffer.isBuffer(value)?value:Buffer.from(canonicalJson(value)))).reference;
  const planRef=await store('runtime',plan);await f.records.transact(f.scope,reader.codec.transaction(plan,planRef,{intent:true}));
  const forged=structuredClone(repository);forged.plan=planRef;
  const target=forged.entries.find(entry=>entry.newPath==='app.js');target.chunks=[await store('evidence',Buffer.alloc(target.after.bytes,120))];
  const repoRef=await store('evidence',forged),bodyRef=await store('evidence',{...body,plan:planRef,repositories:[{id:'app',manifest:repoRef}]});
  const original=await reader.accepted(f.input);
  await f.records.transact(f.scope,reader.codec.transaction(plan,bodyRef,{previousIndexVersion:original.binding.index.version}));
  await assert.rejects(reader.accepted(input),failure=>failure.code==='ENGINE_STORAGE_CORRUPT'&&/reconstruct the observed file/u.test(failure.message));
});

for(const operation of ['delete','empty'])test(`a pure ${operation} observation needs no invented content reader`,async t=>{
  const f=await namespacePreparationFixture(t,{code:true});f.control.permissions.push('phase.source.retain');await f.engine.run('phase.prepare');
  if(operation==='delete')await rm(path.join(f.sourceRoot,'app.js'));else await writeFile(path.join(f.sourceRoot,'empty.js'),'');
  const engine=createNamespaceSourceRetentionEngine({records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock,
    localRecords:f.localRecords,localContent:f.localContent,sources:[f.unit]});
  const result=await engine.run('phase.source.retain',{operationId:'retain-'+operation,workId:f.inputs.workId,phaseId:'intake'});
  assert.equal(result.totals.chunks,0);assert.equal(result.totals.bytes,0);assert.equal(result.totals[operation==='delete'?'removed':'added'],1);
});

test('receipt identity follows the namespace and authority rather than a client adapter ID',async t=>{
  const f=await namespaceSourceRetentionFixture(t),recorded=await f.engine.run('phase.source.retain',f.input);
  const records={...f.records,descriptor:{...f.records.descriptor,id:'another-qualified-client'}},content={...f.content,descriptor:{...f.content.descriptor,id:'another-content-client'}};
  const result=await f.make({records,content,sources:[],sourceReaders:[],localRecords:null,localContent:null}).run('phase.source.retain',f.input);
  assert.deepEqual(result.record,recorded.record);assert.equal(result.replayed,true);
  await assert.rejects(f.make({records,content}).run('phase.source.retain',{...f.input,operationId:'new-write-via-alias'}),{code:'ENGINE_AUTHORITY_FENCED'});
});

test('a smaller client read capability preserves its real limit error instead of marking valid evidence corrupt',async t=>{
  const f=await namespaceSourceRetentionFixture(t),sourceReader=await createFilesystemSourceContentReader({root:f.sourceRoot,id:'larger-content',source:f.unit.descriptor,maximumChunkBytes:65536});
  await f.make({sourceReaders:[sourceReader]}).run('phase.source.retain',f.input);
  const failure=new SingularityFlowError('This reader cannot fetch a blob larger than its negotiated limit.',{code:'SDA_CONTENT_INPUT_INVALID',details:{maximumBytes:32768}});
  const content={...f.content,descriptor:{...f.content.descriptor,maximumBytes:32768},read(scope,ref,options){if(ref.bytes>32768)throw failure;return f.content.read(scope,ref,options);}};
  await assert.rejects(f.make({content,sources:[],sourceReaders:[],localRecords:null,localContent:null}).run('phase.source.retain',f.input),error=>error===failure);
});

test('retention refuses missing capabilities and caller-supplied readiness while preserving the draft',async t=>{
  const f=await namespaceSourceRetentionFixture(t);
  await assert.rejects(f.make({sourceReaders:[]}).run('phase.source.retain',f.input),{code:'ENGINE_SOURCE_CONTENT_READER_UNAVAILABLE'});
  await assert.rejects(f.engine.run('phase.source.retain',{...f.input,ready:true}),{code:'ENGINE_INPUT_INVALID'});
  const controller=new AbortController();controller.abort();await assert.rejects(f.engine.run('phase.source.retain',f.input,{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  const ordinary=await namespacePreparationFixture(t);ordinary.control.permissions.push('phase.source.retain');await ordinary.engine.run('phase.prepare');
  await assert.rejects(createNamespaceSourceRetentionEngine({records:ordinary.records,content:ordinary.content,localRecords:ordinary.localRecords,localContent:ordinary.localContent,
    scope:ordinary.scope,workId:ordinary.inputs.workId,authority:ordinary.authority,access:ordinary.access,clock:ordinary.clock}).run('phase.source.retain',
      {...f.input,workId:ordinary.inputs.workId}),{code:'ENGINE_SOURCE_GENERATION_REQUIRED'});
});
