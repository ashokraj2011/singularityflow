import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {createDurableExecutionUnit} from '../src/sgos/durable-execution-unit.mjs';
import {createNodeExecutionOwner} from '../src/sgos/node-execution-owner.mjs';
import {createNamespaceSgosOperationalStore} from '../src/sgos/namespace-operational-store.mjs';
import {createAgentTaskContract,createExecutionUnitManifest,createDeterministicTranslatorExecutionUnit,
  createGenericProcessExecutionUnit,executionUnitSha256 as digest} from '../src/sgos/node-execution-unit.mjs';
import {namespaceProjectFixture} from './helpers/namespace-project-fixture.mjs';
import {readRecord,currentSchemaVersion} from '../src/schema-migrations.mjs';
const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
const key=contract=>'execution/'+contract.contractSha256.slice(7);
async function fixture(t,{backend='filesystem',script=null}={}) {
  const f=await namespaceProjectFixture(t,{backend});
  const manifest=script===null?null:createExecutionUnitManifest({id:'durable-fixture',version:'1.0.0',publisher:'fixture',provider:'local',models:[],
    capabilities:{shell:false},sandbox:{kind:'process',enforcement:'external-attested',attestationSha256:digest('isolated-fixture')},network:{mode:'deny'},
    toolPolicy:{mode:'none'},risk:{class:'low'},tests:{conformanceReceiptSha256:digest('fixture')},
    command:{executable:process.execPath,executableSha256,arguments:['-e',script],environmentAllowlist:[]}});
  const raw=script===null?createDeterministicTranslatorExecutionUnit():createGenericProcessExecutionUnit(manifest,{root:f.directory,authorizeManifest:value=>value.manifestSha256});
  const contract=createAgentTaskContract({taskId:'task-one',processId:'PROC-durable',instructionId:'execute',objective:'Retain actual isolated execution.',
    acceptanceClauses:[],policySnapshotSha256:digest('policy'),programSha256:digest('program'),inputs:[],readScope:[],writeScope:[],forbiddenScope:[],allowedDevices:[],
    environmentManifestSha256:digest('environment'),candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:[],
    budgets:{activeMinutes:1,modelInvocations:0,touchedResources:0},stopConditions:[],executionUnitManifestSha256:raw.descriptor().manifestSha256});
  const store=createNamespaceSgosOperationalStore({records:f.records,content:f.content,scope:f.scope,storeId:'execution-fixture'});
  const control={starts:0},unit={...raw,async start(value){control.starts++;return raw.start(value);}},owner=createNodeExecutionOwner({hostId:'fixture-host'});
  const options={unit,store,content:f.content,scope:f.scope,owner,clock:f.clock},make=extra=>createDurableExecutionUnit({...options,...extra});
  return {...f,raw,unit,contract,store,control,owner,make,runtime:make(),options};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': real execution is retained once and reopened by a separate owner',async t=>{
  const f=await fixture(t,{backend}),handle=await f.runtime.start(f.contract),candidate=await f.runtime.collect(handle),events=[];
  for await(const event of f.runtime.observe(handle))events.push(event);
  assert.deepEqual(events.map(value=>value.type),['started','completed']);assert.equal(candidate.eventHeadSha256,events.at(-1).eventSha256);
  assert.equal((await f.runtime.quiesce(handle)).quiescent,true);assert.equal(f.control.starts,1);
  const later=f.make({owner:createNodeExecutionOwner({hostId:'another-host'}),unit:{...f.raw,start(){throw Error('Must not reexecute.');}}});
  assert.deepEqual(await later.start(f.contract),handle);assert.deepEqual(await later.collect(handle),candidate);
  assert.equal((await later.quiesce(handle)).eventHeadSha256,candidate.eventHeadSha256);
  const retained=(await f.store.read()).entries[key(f.contract)];assert.equal(retained.status,'complete');assert.equal(retained.profile,'sgos-durable-execution/v1');
  assert.equal(Object.hasOwn(candidate,'verification'),false);
  for(const namespace of ['state','config','evidence'])assert.deepEqual((await f.records.list(f.scope,namespace,{limit:100})).entries,[]);
});
test('concurrent hosts cannot launch the same contract twice',async t=>{
  const f=await fixture(t),other=f.make({owner:createNodeExecutionOwner({hostId:'racing-host'})});
  const race=await Promise.allSettled([f.runtime.start(f.contract),other.start(f.contract)]);
  assert.equal(race.filter(value=>value.status==='fulfilled').length,1);assert.equal(f.control.starts,1);
  assert.equal(race.find(value=>value.status==='rejected').reason.code,'SGOS_EXECUTION_RECOVERY_REQUIRED');
  const winner=race[0].status==='fulfilled'?f.runtime:other,handle=race.find(value=>value.status==='fulfilled').value;
  await winner.collect(handle);assert.equal(f.control.starts,1);
});
for(const change of ['rollback','delete'])test('removing the current attempt through '+change+' cannot authorize a duplicate launch',async t=>{
  const f=await fixture(t),handle=await f.runtime.start(f.contract);await f.runtime.collect(handle);
  if(change==='rollback') {
    const plan=await f.store.planRollback(0);await f.store.rollback({revision:0,confirmationSha256:plan.confirmationSha256});
  }else{const before=await f.store.read();await f.store.transact({expectedRevision:before.revision,expectedStateSha256:before.stateSha256,
    changes:[{op:'delete',key:key(f.contract)}]});}
  assert.equal(Object.hasOwn((await f.store.read()).entries,key(f.contract)),false);
  await assert.rejects(f.make({owner:createNodeExecutionOwner({hostId:'later-owner'})}).start(f.contract),error=>
    error.code==='SGOS_EXECUTION_RECOVERY_REQUIRED'&&error.details.historyRestored===true&&error.details.priorStatus==='complete'&&error.details.automaticRetry===false);
  assert.equal(f.control.starts,1);
  const nextInput={...f.contract,taskId:'explicit-next-task'};delete nextInput.schemaVersion;delete nextInput.kind;delete nextInput.contractSha256;
  const next=createAgentTaskContract(nextInput),runtime=f.make({owner:createNodeExecutionOwner({hostId:'explicit-next-owner'})});
  assert.equal((await runtime.collect(await runtime.start(next))).kind,'candidate-result');assert.equal(f.control.starts,2);
});
test('unavailable retained history never becomes permission to launch from an empty snapshot',async t=>{
  const f=await fixture(t),original=Object.assign(new Error('History access denied.'),{code:'EACCES'});
  const runtime=f.make({store:{...f.store,exportBackup(){throw original;}}});
  await assert.rejects(runtime.start(f.contract),error=>error===original);assert.equal(f.control.starts,0);
});
test('an uncertain launch remains explicit and cannot be relaunched by another host',async t=>{
  const f=await fixture(t),original=Object.assign(new Error('Provider acknowledgement lost.'),{code:'PROVIDER_TRANSPORT_LOST'});
  const runtime=f.make({unit:{...f.raw,start(){f.control.starts++;throw original;}}});
  await assert.rejects(runtime.start(f.contract),error=>error.code==='SGOS_EXECUTION_RECOVERY_REQUIRED'&&error.cause===original&&error.details.automaticRetry===false);
  f.control.now='2099-01-01T00:00:00.000Z';
  await assert.rejects(f.make({owner:createNodeExecutionOwner({hostId:'takeover-host'})}).start(f.contract),error=>
    error.code==='SGOS_EXECUTION_RECOVERY_REQUIRED'&&error.cause?.code===original.code&&error.cause?.message===original.message);
  assert.equal(f.control.starts,1);assert.equal((await f.store.read()).entries[key(f.contract)].status,'uncertain');
});
test('a lost post-launch write resumes with the original live handle and never starts twice',async t=>{
  const f=await fixture(t),original=Object.assign(new Error('Launch handle persistence interrupted.'),{code:'EACCES'});let failHandle=true;
  const runtime=f.make({store:{...f.store,transact(input){const value=input.changes[0].value;
    if(failHandle&&value.status==='running'){failHandle=false;throw original;}return f.store.transact(input);}}});
  let handle;
  await assert.rejects(runtime.start(f.contract),error=>{handle=error.details?.handle;return error.code==='SGOS_EXECUTION_RECOVERY_REQUIRED'&&error.cause===original&&handle?.kind==='execution-handle';});
  await assert.rejects(f.make({owner:createNodeExecutionOwner({hostId:'foreign'})}).start(f.contract),{code:'SGOS_EXECUTION_RECOVERY_REQUIRED'});
  assert.equal((await runtime.collect(handle)).kind,'candidate-result');assert.equal(f.control.starts,1);
});
test('a failed ownership claim or history write cannot launch an executor',async t=>{
  const f=await fixture(t),original=Object.assign(new Error('Disk unavailable.'),{code:'EACCES'});
  const runtime=f.make({store:{...f.store,transact(){throw original;}}});
  await assert.rejects(runtime.start(f.contract),error=>error===original);assert.equal(f.control.starts,0);
  assert.deepEqual((await f.store.read()).entries,{});
});
test('the shared ABI schema preserves current wire bytes and refuses missing or future versions before launch',async t=>{
  const f=await fixture(t);
  assert.equal(currentSchemaVersion('sgos-execution-unit-abi'),1);
  const goldens=JSON.parse(await readFile(new URL('./fixtures/schema-migrations/goldens.json',import.meta.url),'utf8'));
  const original=JSON.parse(await readFile(new URL('./fixtures/sgos-execution-unit-packets/native-v1.json',import.meta.url),'utf8'));
  assert.deepEqual(goldens['sgos-execution-unit-abi'],[original.manifests[0]],'the registry retains an actual captured native ABI packet');
  assert.deepEqual(readRecord('sgos-execution-unit-abi',goldens['sgos-execution-unit-abi'][0]).record,f.raw.descriptor());
  assert.deepEqual(readRecord('sgos-execution-unit-abi',f.contract).record,f.contract);
  for(const [version,code] of [[undefined,'SCHEMA_VERSION_MISSING'],[2,'SCHEMA_VERSION_FUTURE']]) {
    const core={...f.contract};delete core.contractSha256;
    if(version===undefined)delete core.schemaVersion;else core.schemaVersion=version;
    const value={...core,contractSha256:digest(core)};
    await assert.rejects(f.runtime.start(value),{code});
  }
  assert.equal(f.control.starts,0);assert.deepEqual((await f.store.read()).entries,{});
});
test('live-owner loss cannot become terminal success',async t=>{
  const f=await fixture(t);let lost=false;
  const runtime=f.make({owner:{...f.owner,assert(token){if(lost)throw Object.assign(new Error('Owner changed.'),{code:'SGOS_EXECUTION_LEASE_LOST'});return f.owner.assert(token);}}});
  const handle=await runtime.start(f.contract);lost=true;
  await assert.rejects(runtime.collect(handle),{code:'SGOS_EXECUTION_LEASE_LOST'});
  assert.equal((await f.store.read()).entries[key(f.contract)].status,'running');assert.equal(f.control.starts,1);
});
test('a storage error after genuine execution stays a storage error and collection can resume without relaunch',async t=>{
  const f=await fixture(t),original=Object.assign(new Error('Result store denied.'),{code:'EACCES'});let denied=true;
  const runtime=f.make({content:{...f.content,put(scope,namespace,data){
    if(denied&&JSON.parse(data.toString()).kind==='candidate-result')throw original;return f.content.put(scope,namespace,data);}}});
  const handle=await runtime.start(f.contract);await assert.rejects(runtime.collect(handle),error=>error===original);
  assert.equal((await f.store.read()).entries[key(f.contract)].status,'running');denied=false;
  const candidate=await runtime.collect(handle);assert.equal(candidate.kind,'candidate-result');assert.equal(f.control.starts,1);
});
test('a lost terminal write acknowledgement reopens the accepted result without collecting or launching twice',async t=>{
  const f=await fixture(t),original=Object.assign(new Error('Terminal acknowledgement lost.'),{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN'});
  let lose=true,collections=0,releases=0;
  const runtime=f.make({unit:{...f.unit,collect(handle){collections++;return f.raw.collect(handle);}},
    owner:{...f.owner,release(token){releases++;return f.owner.release(token);}},
    store:{...f.store,async transact(input){const result=await f.store.transact(input);
      if(lose&&input.changes[0].value.status==='complete'){lose=false;throw original;}return result;}}});
  const handle=await runtime.start(f.contract);await assert.rejects(runtime.collect(handle),error=>error===original);
  assert.equal((await runtime.collect(handle)).kind,'candidate-result');assert.equal(f.control.starts,1);assert.equal(collections,1);assert.equal(releases,1);
});
test('changed candidate bindings are refused rather than converted to an executor failure',async t=>{
  const f=await fixture(t),runtime=f.make({unit:{...f.raw,async collect(handle){return {...await f.raw.collect(handle),contractSha256:digest('another-task')};}}});
  const handle=await runtime.start(f.contract);await assert.rejects(runtime.collect(handle),{code:'SGOS_EXECUTION_RECORD_INVALID'});
  assert.equal((await f.store.read()).entries[key(f.contract)].status,'running');
});
test('a collection transport failure after a completed stream is not a proven terminal executor failure',async t=>{
  const f=await fixture(t),original=Object.assign(new Error('Transport unavailable.'),{code:'EACCES'}),runtime=f.make({unit:{...f.unit,collect(){throw original;}}});
  const handle=await runtime.start(f.contract);await assert.rejects(runtime.collect(handle),error=>error.code==='SGOS_EXECUTION_RECOVERY_REQUIRED'&&error.cause===original);
  assert.equal((await f.store.read()).entries[key(f.contract)].status,'running');assert.equal(f.control.starts,1);
});
test('reopened outcomes verify all immutable bytes and cannot silently use missing content',async t=>{
  const f=await fixture(t),handle=await f.runtime.start(f.contract);await f.runtime.collect(handle);
  const attempt=(await f.store.read()).entries[key(f.contract)],later=f.make({content:{...f.content,read(scope,reference,options){
    if(reference.sha256===attempt.result.sha256)return {status:'missing',reference};return f.content.read(scope,reference,options);}}});
  await assert.rejects(later.collect(handle),{code:'SGOS_EXECUTION_CONTENT_CORRUPT'});
  await assert.rejects(later.start(f.contract),{code:'SGOS_EXECUTION_CONTENT_CORRUPT'});assert.equal(f.control.starts,1);
});
test('retained stop decisions keep their exact reason across hosts',async t=>{
  const f=await fixture(t),handle=await f.runtime.start(f.contract),request={reason:'Stop this exact execution.'};
  const stop=await f.runtime.requestStop(handle,request);await f.runtime.quiesce(handle);
  assert.deepEqual(await f.runtime.requestStop(handle,request),stop,'the original host can acknowledge the same completed stop');
  const later=f.make({owner:createNodeExecutionOwner({hostId:'next-host'})});
  assert.deepEqual(await later.requestStop(handle,request),stop);
  await assert.rejects(later.requestStop(handle,{reason:'Another reason.'}),{code:'SGOS_GEU_STOP_CONFLICT'});
});
test('an already completed execution gives a collection route instead of a false live-owner recovery requirement',async t=>{
  const f=await fixture(t),handle=await f.runtime.start(f.contract),candidate=await f.runtime.collect(handle);
  for(const runtime of [f.runtime,f.make({owner:createNodeExecutionOwner({hostId:'next-host'})})]) {
    await assert.rejects(runtime.requestStop(handle,{reason:'Stop after completion.'}),error=>
      error.code==='SGOS_EXECUTION_ALREADY_SETTLED'&&error.details.nextMethod==='collect');
    assert.deepEqual(await runtime.collect(handle),candidate);
  }
});
test('a self-hashed terminal record cannot substitute another quiescence handle',async t=>{
  const f=await fixture(t),handle=await f.runtime.start(f.contract);await f.runtime.collect(handle);
  const before=await f.store.read(),value=structuredClone(before.entries[key(f.contract)]);
  const quiet={...value.quiescence,handleSha256:digest('another-handle')};delete quiet.quiescenceReceiptSha256;
  value.quiescence={...quiet,quiescenceReceiptSha256:digest(quiet)};delete value.recordSha256;
  value.recordSha256=digest(value);
  await f.store.transact({expectedRevision:before.revision,expectedStateSha256:before.stateSha256,changes:[{op:'put',key:key(f.contract),value}]});
  await assert.rejects(f.make().collect(handle),{code:'SGOS_EXECUTION_RECORD_INVALID'});
});
test('native process failure keeps its code after reopening and proves quiescence',async t=>{
  const f=await fixture(t,{script:'process.exit(7)'}),handle=await f.runtime.start(f.contract);
  await assert.rejects(f.runtime.collect(handle),{code:'SGOS_GEU_PROCESS_FAILED'});
  assert.equal((await f.runtime.quiesce(handle)).quiescent,true);
  await assert.rejects(f.make({owner:createNodeExecutionOwner({hostId:'later'})}).collect(handle),{code:'SGOS_GEU_PROCESS_FAILED'});
  assert.equal(f.control.starts,1);
});
test('the actual process can stop during a retained-store outage and then retain its quiescence',async t=>{
  const f=await fixture(t,{script:"require('node:fs').writeFileSync('live.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)"});
  const original=Object.assign(new Error('Stop receipt write unavailable.'),{code:'EACCES'});let down=false,pid=null;
  const runtime=f.make({store:{...f.store,read(){if(down)throw original;return f.store.read();}}}),handle=await runtime.start(f.contract);
  t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}});
  const deadline=Date.now()+10_000;
  while(pid===null&&Date.now()<deadline){try{pid=JSON.parse(await readFile(path.join(f.directory,'live.json'),'utf8')).pid;}
    catch(cause){if(cause.code!=='ENOENT')throw cause;await pause(10);}}
  assert.ok(Number.isSafeInteger(pid));down=true;
  await assert.rejects(runtime.requestStop(handle,{reason:'Stop the isolated application.'}),error=>error===original);
  await f.raw.quiesce(handle);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});pid=null;down=false;
  await assert.rejects(runtime.collect(handle),{code:'SGOS_GEU_PROCESS_FAILED'});assert.equal((await runtime.quiesce(handle)).quiescent,true);
});
test('a held source command is not launched merely by constructing or importing runtime bindings',async t=>{
  const f=await fixture(t,{script:"require('node:fs').writeFileSync('launched','bad');process.stdout.write('{}')"});
  assert.equal(f.control.starts,0);await assert.rejects(access(path.join(f.directory,'launched')),{code:'ENOENT'});
  assert.deepEqual((await f.store.read()).entries,{});
  assert.throws(()=>createDurableExecutionUnit({...f.options,owner:{get acquire(){throw Error('Accessor was invoked.');}}}),{code:'SGOS_EXECUTION_BINDING_INVALID'});
});
