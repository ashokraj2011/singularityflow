import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import {createExecutionUnitManifest,createAgentTaskContract,createGenericProcessExecutionUnit,createDeterministicTranslatorExecutionUnit,
  executionUnitSha256} from '../src/sgos/node-execution-unit.mjs';
import {captureExecutionUnit,EXECUTION_UNIT_METHODS} from '../packages/engine-sdk/src/execution.mjs';
const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
const digest=executionUnitSha256;
async function fixture(t,script,overrides={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'sflow-node-execution-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const input={id:'node-fixture',version:'1.0.0',publisher:'fixture',provider:'local',models:[],capabilities:{shell:false},
    sandbox:{kind:'process',enforcement:'external-attested',attestationSha256:digest('fixture-sandbox')},network:{mode:'deny'},
    toolPolicy:{mode:'none'},risk:{class:'low'},tests:{conformanceReceiptSha256:digest('conformance')},
    command:{executable:process.execPath,executableSha256,arguments:['-e',script],environmentAllowlist:[]},...overrides};
  const manifest=createExecutionUnitManifest(input),make=extra=>createGenericProcessExecutionUnit(manifest,{root,authorizeManifest:value=>value.manifestSha256,...extra});
  const contract=createAgentTaskContract({taskId:'task-1',processId:'PROC-123456',instructionId:'check-1',objective:'Execute the bounded fixture.',
    acceptanceClauses:[],policySnapshotSha256:digest('policy'),programSha256:digest('program'),inputs:[],readScope:[],writeScope:[],forbiddenScope:['.git'],
    allowedDevices:[],environmentManifestSha256:digest('environment'),candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:[],
    budgets:{activeMinutes:1,modelInvocations:0,touchedResources:0},stopConditions:[],executionUnitManifestSha256:manifest.manifestSha256});
  return {root,manifest,contract,make,unit:make()};
}
test('the standalone Node unit uses exact argv, filtered environment and JSON contract bytes without a repository',async t=>{
  const key='SFLOW_EXECUTION_TEST_CANARY',original=process.env[key];process.env[key]='private fixture value';
  t.after(()=>{if(original===undefined)delete process.env[key];else process.env[key]=original;});
  const f=await fixture(t,"let s='';process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({task:JSON.parse(s).taskId,args:process.argv.slice(1),leaked:['SFLOW_EXECUTION_TEST_CANARY','PATH','HOME','NODE_OPTIONS'].filter(name=>Object.hasOwn(process.env,name))})))");
  const unit=captureExecutionUnit(f.unit),handle=await unit.start(f.contract),events=[];for await(const event of unit.observe(handle))events.push(event);
  const result=await unit.collect(handle);assert.deepEqual(result.output,{task:'task-1',args:[],leaked:[]});
  assert.deepEqual(events.map(event=>event.type),['started','completed']);assert.equal(events[1].priorEventSha256,events[0].eventSha256);
  assert.equal((await unit.quiesce(handle)).quiescent,true);assert.equal(result.candidate,null);assert.equal(result.usage,null);
  assert.equal(Object.hasOwn(result,'verification'),false);assert.deepEqual(await unit.collect(handle),result);
});
test('an active standalone process stops and reaches terminal quiescence before collection returns',async t=>{
  const f=await fixture(t,"require('node:fs').writeFileSync('running.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)");
  const handle=await f.unit.start(f.contract);let pid=null;
  t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}});
  const deadline=Date.now()+10_000;
  while(pid===null&&Date.now()<deadline){try{pid=JSON.parse(await readFile(path.join(f.root,'running.json'),'utf8')).pid;}
    catch(error){if(error.code!=='ENOENT')throw error;await pause(10);}}
  assert.ok(Number.isSafeInteger(pid));const stopped=await f.unit.requestStop(handle,{reason:'Stop this exact fixture process.'});assert.equal(stopped.acknowledged,true);
  assert.equal((await f.unit.quiesce(handle)).quiescent,true);await assert.rejects(f.unit.collect(handle),{code:'SGOS_GEU_PROCESS_FAILED'});
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});pid=null;
});
test('execution-port capture does not invoke a method or an accessor and retains the original function bindings',async()=>{
  let calls=0;const port=Object.fromEntries(EXECUTION_UNIT_METHODS.map(name=>[name,function(){calls++;return name;}]));
  const captured=captureExecutionUnit(port);assert.equal(calls,0);port.collect=()=>{throw Error('replaced');};assert.equal(captured.collect(),'collect');
  Object.defineProperty(port,'start',{get(){throw Error('getter must not run');}});
  assert.throws(()=>captureExecutionUnit(port),error=>error.code==='ENGINE_EXECUTION_UNIT_PORT_INVALID'&&error.details.method==='start');
  class Unit {constructor(){this.marker='original';}}
  for(const name of EXECUTION_UNIT_METHODS)Object.defineProperty(Unit.prototype,name,{value(){return this.marker;},writable:true,configurable:true});
  const instance=new Unit(),bound=captureExecutionUnit(instance);Unit.prototype.collect=()=>{throw Error('replacement');};
  assert.equal(bound.collect(),'original');
  Object.defineProperty(Unit.prototype,'start',{get(){throw Error('prototype getter must not run');}});
  assert.throws(()=>captureExecutionUnit(instance),error=>error.code==='ENGINE_EXECUTION_UNIT_PORT_INVALID'&&error.details.method==='start');
});
test('a delayed manifest authorization cannot launch a process after a stop was acknowledged',async t=>{
  const f=await fixture(t,"require('node:fs').writeFileSync('launched','bad');process.stdout.write('{}')");
  let entered,release;const pending=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const unit=f.make({async authorizeManifest(value){entered();await gate;return value.manifestSha256;}}),handle=await unit.start(f.contract);
  await pending;const stopped=await unit.requestStop(handle,{reason:'Stop before external execution.'});assert.equal(stopped.acknowledged,true);release();
  await unit.quiesce(handle);await assert.rejects(unit.collect(handle),{code:'SGOS_GEU_STOP_REQUESTED'});
  await assert.rejects(access(path.join(f.root,'launched')),{code:'ENOENT'});
});
test('an acknowledged stop quiesces without waiting for an authorization callback that never resolves',async t=>{
  const f=await fixture(t,"require('node:fs').writeFileSync('launched','bad');process.stdout.write('{}')");let entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const unit=f.make({authorizeManifest(){entered();return new Promise(()=>{});}}),handle=await unit.start(f.contract);
  await waiting;const stopped=await unit.requestStop(handle,{reason:'Cancel the pending host authorization.'});assert.equal(stopped.acknowledged,true);
  let timer;
  try{const quiescence=await Promise.race([unit.quiesce(handle),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Stopped preflight did not quiesce.')),2000);})]);
    assert.equal(quiescence.quiescent,true);}finally{clearTimeout(timer);}
  await assert.rejects(unit.collect(handle),{code:'SGOS_GEU_STOP_REQUESTED'});await assert.rejects(access(path.join(f.root,'launched')),{code:'ENOENT'});
});
test('registry and executable failures remain distinct and do not launch the configured command',async t=>{
  const f=await fixture(t,"require('node:fs').writeFileSync('launched','bad');process.stdout.write('{}')");
  const denied=f.make({authorizeManifest:()=>false});await assert.rejects(denied.collect(await denied.start(f.contract)),{code:'SGOS_GEU_AUTHORITY_REQUIRED'});
  const changed=createExecutionUnitManifest({...Object.fromEntries(Object.entries(f.manifest).filter(([key])=>!['schemaVersion','kind','manifestSha256'].includes(key))),
    command:{...f.manifest.command,executableSha256:'sha256:'+'0'.repeat(64)}});
  const unit=createGenericProcessExecutionUnit(changed,{root:f.root,authorizeManifest:()=>true});
  const rebound=createAgentTaskContract({...Object.fromEntries(Object.entries(f.contract).filter(([key])=>!['schemaVersion','kind','contractSha256'].includes(key))),
    executionUnitManifestSha256:changed.manifestSha256});
  await assert.rejects(unit.collect(await unit.start(rebound)),{code:'SGOS_GEU_EXECUTABLE_CHANGED'});
  assert.equal((await unit.doctor()).diagnosticCode,'SGOS_GEU_EXECUTABLE_CHANGED');await assert.rejects(access(path.join(f.root,'launched')),{code:'ENOENT'});
});
for(const [label,script,code] of [
  ['nonzero exit',"process.exit(9)",'SGOS_GEU_PROCESS_FAILED'],
  ['invalid JSON',"process.stdout.write('invalid')",'SGOS_GEU_RESULT_INVALID'],
  ['bounded output',"process.stdout.write('x'.repeat(16*1024*1024+1))",'SGOS_GEU_OUTPUT_LIMIT']
])test('standalone execution preserves '+label,async t=>{
  const f=await fixture(t,script);await assert.rejects(f.unit.collect(await f.unit.start(f.contract)),{code});
});
test('the deterministic unit shares the exact candidate-only execution protocol',async()=>{
  const unit=createDeterministicTranslatorExecutionUnit();assert.equal(unit.descriptor().provider,'local-kernel');
  assert.equal((await unit.planCapability({requiredCapabilities:['shell']})).capable,false);
  assert.equal((await unit.doctor()).status,'ready');
});
