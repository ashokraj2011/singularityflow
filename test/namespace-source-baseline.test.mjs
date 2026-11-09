import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {namespaceSourceBaselineFixture} from './helpers/namespace-source-baseline-fixture.mjs';
import {createNamespaceSourceBaselineReader} from '../src/engine-storage/namespace-source-baseline-reader.mjs';
import {canonicalJson} from '../src/foundation/record-schema.mjs';
import {createNamespaceLifecycleCommitter} from '../src/engine-storage/namespace-lifecycle-commit.mjs';
import {lifecycleRecord} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
import {createNamespaceSourceEngine} from '../src/engine-storage/namespace-source.mjs';
import {createFilesystemSourceUnit,createFilesystemSourceContentReader} from '../src/sgos/filesystem-source-unit.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {LIFECYCLE_AUTHORITY_KEY} from '../src/engine-storage/namespace-lifecycle-contract.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
const json=async(f,ref)=>JSON.parse(Buffer.from((await f.content.read(f.scope,ref)).data));
async function archived(f,result){const body=await json(f,result.record.content);return {body,repository:await json(f,body.repositories[0].manifest)};}
async function bytes(f,chunks){const values=[];for(const ref of chunks)values.push(Buffer.from((await f.content.read(f.scope,ref)).data));return Buffer.concat(values);}
for(const backend of ['filesystem','sqlite','application'])test(`${backend}: actual baseline bytes are retained without moving the Story or copying local uploads`,async t=>{
  const f=await namespaceSourceBaselineFixture(t,{backend}),head=await f.head(),copied=[];
  const content={...f.content,descriptor:{...f.content.descriptor,maximumBytes:32768},put(...args){assert.ok(args[2].byteLength<=32768);copied.push(Buffer.from(args[2]));return f.content.put(...args);}};
  const result=await f.make({content}).run('source.baseline.retain',f.input),{repository}=await archived(f,result);
  assert.equal(result.baselineContentsRetained,true);assert.equal(result.effects.canonicalStateChanged,false);assert.equal(result.effects.phasePublished,false);
  assert.equal(result.publicationReadinessInspected,false);assert.deepEqual(await f.head(),head);
  assert.deepEqual(repository.entries.map(row=>row.path),['app.js','binary.bin','empty.js','gone.js','package.json']);
  assert.equal(repository.entries.find(row=>row.path==='package.json').role,'build-configuration');
  assert.ok(result.totals.chunks>20);assert.equal(result.totals.files,5);
  for(const entry of repository.entries){const actual=await bytes(f,entry.chunks);assert.equal(hash(actual),entry.sha256);assert.deepEqual(actual,await readFile(path.join(f.sourceRoot,entry.path)));}
  assert.equal(copied.some(value=>value.includes(f.localDocument)),false);
  const clockCalls=f.control.clockCalls;await rm(f.sourceRoot,{recursive:true});
  f.control.permissions=[];f.control.agentId=null;
  const records={...f.records,descriptor:{...f.records.descriptor,id:'another-baseline-proof-client'}};
  const repeated=await f.make({records,sources:[],sourceReaders:[],clock:{now(){throw Error('Do not restamp accepted baseline evidence.');}}}).run('source.baseline.retain',f.input);
  assert.equal(repeated.replayed,true);assert.deepEqual(repeated.record,result.record);assert.equal(f.control.clockCalls,clockCalls);
});
test('the one namespace Engine archives original bytes before code and preserves deleted/unchanged files beside the later delta',async t=>{
  const f=await namespaceSourceBaselineFixture(t),engine=createNamespaceEngine({...f.options,working:{records:f.localRecords,content:f.localContent}});
  const result=await engine.run('source.baseline.retain',f.input),{repository}=await archived(f,result);
  await engine.run('phase.prepare',{phaseId:'intake'});await writeFile(path.join(f.sourceRoot,'app.js'),'export const answer = 43;');await rm(path.join(f.sourceRoot,'gone.js'));
  const current=await engine.run('phase.source.retain',{operationId:'retain-after-baseline',workId:f.inputs.workId,phaseId:'intake'});
  const deltaBody=await json(f,current.record.content),delta=await json(f,deltaBody.repositories[0].manifest),restored=new Map();
  for(const entry of repository.entries)restored.set(entry.path,await bytes(f,entry.chunks));
  assert.equal(restored.get('gone.js').toString(),'export const gone = true;');
  for(const entry of delta.entries){if(entry.after===null)restored.delete(entry.oldPath);else restored.set(entry.newPath,await bytes(f,entry.chunks));}
  assert.deepEqual(restored.get('binary.bin'),f.binary);assert.equal(restored.get('app.js').toString(),'export const answer = 43;');assert.equal(restored.has('gone.js'),false);
  assert.equal(current.baselineContentsRetained,false,'the historical delta contract does not itself claim to retain a baseline');
  assert.equal((await engine.run('source.baseline.retain',f.input)).replayed,true);
});
test('source changes are explicit refusals while managed upload changes stay outside the archived application inventory',async t=>{
  const f=await namespaceSourceBaselineFixture(t);await writeFile(f.uploadPath,f.localDocument+' changed locally');
  const first=await f.engine.run('source.baseline.retain',f.input);assert.equal(first.totals.files,5);
  await writeFile(path.join(f.sourceRoot,'app.js'),'export const answer = 99;');
  await assert.rejects(f.engine.run('source.baseline.retain',{...f.input,operationId:'after-source-drift'}),error=>error.code==='ENGINE_SOURCE_CHANGED'&&error.details.sourceBindingId===f.input.sourceBindingId);
  assert.equal((await f.engine.run('source.baseline.retain',f.input)).replayed,true);
});
test('a real content failure preserves the prepared intent and restoring the reader resumes its original timestamp',async t=>{
  const f=await namespaceSourceBaselineFixture(t),failure=Object.assign(new Error('Source read was denied.'),{code:'EACCES',path:'binary.bin'});
  const sourceReader={...f.sourceReader,read(){throw failure;}};
  await assert.rejects(f.make({sourceReaders:[sourceReader]}).run('source.baseline.retain',f.input),error=>error===failure);
  const proof=await createNamespaceSourceBaselineReader(f.options).intent(f.input);
  const result=await f.engine.run('source.baseline.retain',f.input);assert.equal(result.recordedAt,proof.plan.recordedAt);
  assert.equal(result.effects.canonicalStateChanged,false);
});
test('revocation and a changed principal cannot accept a prepared archive, while restored permission resumes it',async t=>{
  const f=await namespaceSourceBaselineFixture(t),permissions=[...f.control.permissions];let revoked=false;
  const sourceReader={...f.sourceReader,async read(...args){const result=await f.sourceReader.read(...args);if(!revoked){revoked=true;f.control.permissions=[];}return result;}};
  await assert.rejects(f.make({sourceReaders:[sourceReader]}).run('source.baseline.retain',f.input),{code:'ENGINE_AUTHORITY_REQUIRED'});
  f.control.permissions=permissions;const person=f.control.principalId;f.control.principalId='another-person';
  await assert.rejects(f.engine.run('source.baseline.retain',f.input),{code:'ENGINE_ACTOR_CHANGED'});
  f.control.principalId=person;assert.equal((await f.engine.run('source.baseline.retain',f.input)).status,'recorded');
});
test('a lost final acknowledgement preserves its real timeout and the shared-only retry recovers the receipt',async t=>{
  const f=await namespaceSourceBaselineFixture(t),failure=Object.assign(new Error('Final baseline acknowledgement timed out.'),{code:'ETIMEDOUT',timedOut:true,details:{deadlineMs:8765}});let lost=false;
  const records={...f.records,async transact(scope,tx,options){const accepted=await f.records.transact(scope,tx,options);
    if(!lost&&tx.operationId.startsWith('baseline-retain-')){lost=true;throw failure;}return accepted;}};
  await assert.rejects(f.make({records}).run('source.baseline.retain',f.input),error=>error===failure);
  const result=await f.make({sources:[],sourceReaders:[]}).run('source.baseline.retain',f.input);assert.equal(result.replayed,true);
});
test('fencing and malformed or missing retained bytes never create fresh source authority',async t=>{
  const f=await namespaceSourceBaselineFixture(t),result=await f.engine.run('source.baseline.retain',f.input),{repository}=await archived(f,result);
  const a=await f.readAuthority();await f.records.transact(f.scope,{operationId:'fence-baseline',preconditions:[{namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:a.record.version}],
    changes:[{op:'put',namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,immutable:false,value:{...a.record.value,status:'fenced'}}],events:[]});
  assert.equal((await f.engine.run('source.baseline.retain',f.input)).replayed,true);
  await assert.rejects(f.engine.run('source.baseline.retain',{...f.input,operationId:'fresh-after-fence'}),{code:'ENGINE_AUTHORITY_FENCED'});
  const chunk=repository.entries.find(row=>row.chunks.length).chunks[0];
  const missing={...f.content,read(scope,reference,options){return reference.sha256===chunk.sha256?{status:'missing',data:null}:f.content.read(scope,reference,options);}};
  await assert.rejects(f.make({content:missing,sources:[],sourceReaders:[]}).run('source.baseline.retain',f.input),{code:'ENGINE_STORAGE_CONTENT_MISSING'});
});
test('concurrent requests converge, arbitrary file selections are rejected, and unavailable capabilities have real recovery errors',async t=>{
  const f=await namespaceSourceBaselineFixture(t);
  await assert.rejects(f.make({sourceReaders:[]}).run('source.baseline.retain',f.input),{code:'ENGINE_SOURCE_CONTENT_READER_UNAVAILABLE'});
  await assert.rejects(f.engine.run('source.baseline.retain',{...f.input,paths:['private.txt']}),{code:'ENGINE_INPUT_INVALID'});
  let tick=0;const clock={now:()=>new Date(Date.UTC(2026,10,9,0,0,0,tick++)).toISOString()},engine=f.make({clock});
  const [a,b]=await Promise.all([engine.run('source.baseline.retain',f.input),engine.run('source.baseline.retain',f.input)]);
  assert.deepEqual(a.record,b.record);assert.equal(a.recordedAt,b.recordedAt);
  const reader=createNamespaceSourceBaselineReader(f.options),proof=await reader.accepted(f.input);assert.equal(proof.body.totals.files,5);
  await assert.rejects(f.engine.run('source.baseline.retain',{...f.input,sourceBindingId:'another-baseline'}),{code:'ENGINE_OPERATION_ID_REUSED'});
});
test('multiple repository baselines retain separate bindings even for identical relative paths',async t=>{
  const f=await namespaceSourceBaselineFixture(t),root=path.join(f.directory,'second-baseline-source');await mkdir(root);await writeFile(path.join(root,'app.js'),'export const other = true;');
  const unit=await createFilesystemSourceUnit({root,id:'second-baseline',projectId:f.scope.projectId,repositoryId:'service'}),
    sourceReader=await createFilesystemSourceContentReader({root,id:'second-baseline-reader',source:unit.descriptor});
  const options={...f.options,sources:[f.unit,unit],sourceReaders:[f.sourceReader,sourceReader]},sourceBindingId='baseline-two-repositories';
  await createNamespaceSourceEngine(options).run('source.bind',{operationId:sourceBindingId,workId:f.inputs.workId,expectedRevision:(await f.head()).record.version,
    repositories:['app','service'],reason:'Retain both actual source selections.'});
  const result=await f.make(options).run('source.baseline.retain',{...f.input,sourceBindingId});assert.deepEqual(result.repositories.map(row=>row.id),['app','service']);
  const body=await json(f,result.record.content),service=await json(f,body.repositories[1].manifest);
  assert.equal((await bytes(f,service.entries[0].chunks)).toString(),'export const other = true;');
});
test('an empty application inventory needs no content reader and cancellation never records acceptance',async t=>{
  const f=await namespaceSourceBaselineFixture(t);for(const name of ['app.js','binary.bin','empty.js','gone.js','package.json'])await rm(path.join(f.sourceRoot,name));
  const sourceBindingId='empty-application-baseline';await createNamespaceSourceEngine(f.options).run('source.bind',{operationId:sourceBindingId,workId:f.inputs.workId,
    expectedRevision:(await f.head()).record.version,repositories:['app'],reason:'Retain an actual empty application selection.'});
  const controller=new AbortController();controller.abort();const input={...f.input,sourceBindingId};
  await assert.rejects(f.engine.run('source.baseline.retain',input,{signal:controller.signal}),{code:'ENGINE_OPERATION_CANCELLED'});
  const result=await f.make({sourceReaders:[]}).run('source.baseline.retain',input);assert.deepEqual(result.totals,{files:0,bytes:0,chunks:0});
});
test('accepted metadata and valid individual chunk hashes cannot substitute incorrect original file contents',async t=>{
  const f=await namespaceSourceBaselineFixture(t),result=await f.engine.run('source.baseline.retain',f.input),reader=createNamespaceSourceBaselineReader(f.options);
  const original=await reader.accepted(f.input),input={...f.input,operationId:'forged-original-bytes'},plan=structuredClone(original.plan);
  plan.input=input;plan.parametersSha256=hash(canonicalJson({input,binding:reader.codec.binding}));
  const put=async(namespace,value)=>(await f.content.put(f.scope,namespace,Buffer.isBuffer(value)?value:Buffer.from(canonicalJson(value)))).reference;
  const reference=await put('runtime',plan);await f.records.transact(f.scope,reader.codec.transaction(plan,reference,{intent:true}));
  const {body,repository}=await archived(f,result);repository.plan=reference;const member=repository.entries.find(row=>row.path==='app.js');
  for(let index=0;index<member.chunks.length;index++)member.chunks[index]=await put('evidence',Buffer.alloc(member.chunks[index].bytes));
  body.plan=reference;body.repositories[0].manifest=await put('evidence',repository);const bodyReference=await put('evidence',body);
  await f.records.transact(f.scope,reader.codec.transaction(plan,bodyReference,{previousIndexVersion:original.indexVersion}));
  await assert.rejects(reader.accepted(input),error=>error.code==='ENGINE_STORAGE_CORRUPT'&&/reconstruct the observed file/u.test(error.message));
});
test('future metadata remains unsupported, malformed plan bases are diagnosed, and actual content errors keep their identity',async t=>{
  const f=await namespaceSourceBaselineFixture(t),result=await f.engine.run('source.baseline.retain',f.input),{repository}=await archived(f,result);
  const records={...f.records,async read(scope,namespace,key,options){const found=await f.records.read(scope,namespace,key,options);
    return key===result.record.key?{...found,record:{...found.record,value:{...found.record.value,schemaVersion:99}}}:found;}};
  await assert.rejects(f.make({records,sources:[],sourceReaders:[]}).run('source.baseline.retain',f.input),{code:'ENGINE_STORAGE_UNSUPPORTED'});
  const chunk=repository.entries.find(row=>row.chunks.length).chunks[0],failure=Object.assign(new Error('Retained file access denied.'),{code:'EACCES',path:chunk.sha256});
  const content={...f.content,read(scope,reference,options){if(reference.sha256===chunk.sha256)throw failure;return f.content.read(scope,reference,options);}};
  await assert.rejects(f.make({content,sources:[],sourceReaders:[]}).run('source.baseline.retain',f.input),error=>error===failure);
  const reader=createNamespaceSourceBaselineReader(f.options),original=await reader.accepted(f.input),plan=structuredClone(original.plan),input={...f.input,operationId:'malformed-baseline-basis'};
  plan.input=input;plan.parametersSha256=hash(canonicalJson({input,binding:reader.codec.binding}));plan.basis.head=null;
  const reference=(await f.content.put(f.scope,'runtime',Buffer.from(canonicalJson(plan)))).reference;
  await f.records.transact(f.scope,reader.codec.transaction(plan,reference,{intent:true}));
  await assert.rejects(reader.intent(input),error=>error.code==='ENGINE_STORAGE_CORRUPT'&&!(error instanceof TypeError));
});
test('baseline, generation inspection and changed-source archival require an actual source-binding operation',async t=>{
  const f=await namespaceSourceBaselineFixture(t),committer=createNamespaceLifecycleCommitter(f.options),snapshot=await committer.capture(),operationId='not-a-source-binding';
  // Deliberately accept corrupt lifecycle data through SDA; this never grants business authority.
  snapshot.workflow.sourceBindings.current.operationId=operationId;
  const body=lifecycleRecord('state',{projectId:f.scope.projectId,workId:f.inputs.workId,authorityId:f.authority.id,epoch:f.authority.epoch,
    configuration:snapshot.configuration.content,workflow:snapshot.workflow});
  await committer.prepare(snapshot,{operationId,operation:'phase.publish',inputsSha256:'0'.repeat(64),state:Buffer.from(canonicalJson(body)),evidence:[]});
  await committer.commit(operationId);
  await assert.rejects(f.engine.run('source.baseline.retain',{...f.input,sourceBindingId:operationId}),{code:'ENGINE_STORAGE_CORRUPT'});
  f.control.permissions.push('phase.source.inspect');const engine=createNamespaceEngine({...f.options,working:{records:f.localRecords,content:f.localContent}});
  await engine.run('phase.prepare',{phaseId:'intake'});
  await assert.rejects(engine.run('phase.source.inspect',{phaseId:'intake'}),{code:'ENGINE_STORAGE_CORRUPT'});
  await assert.rejects(engine.run('phase.source.retain',{operationId:'retain-false-binding',workId:f.inputs.workId,phaseId:'intake'}),{code:'ENGINE_STORAGE_CORRUPT'});
});
