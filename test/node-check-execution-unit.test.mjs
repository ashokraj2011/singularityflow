import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,access,symlink,realpath} from 'node:fs/promises';
import {platform,arch} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {createNodeCheckExecutionUnit,createEnvironmentQualifiedNodeCheckExecutionUnit,NODE_CHECK_EXECUTION_PROFILE,NODE_QUALIFIED_CHECK_EXECUTION_PROFILE} from '../src/sgos/node-check-execution-unit.mjs';
import {createAgentTaskContract,createExecutionUnitAdapter,executionUnitSha256 as digest,executePinnedProcess} from '../src/sgos/node-execution-unit.mjs';
import {createDurableExecutionUnit} from '../src/sgos/durable-execution-unit.mjs';
import {createNamespaceSgosOperationalStore} from '../src/sgos/namespace-operational-store.mjs';
import {createNodeExecutionOwner} from '../src/sgos/node-execution-owner.mjs';
import {namespaceProjectFixture} from './helpers/namespace-project-fixture.mjs';
const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
const suite="import test from 'node:test';import assert from 'node:assert/strict';test('real local check',()=>assert.equal(2+2,4));";
const junit='<testsuite tests="1" failures="0" skipped="0"><testcase name="a real fixture observation"/></testsuite>';
async function fixture(t,{backend='filesystem',script=null,report={adapter:'node-tap',files:[]},files={},extra={},configure=()=>{}}={}) {
  const f=await namespaceProjectFixture(t,{backend}),root=path.join(f.directory,'checkout');await mkdir(root);
  await writeFile(path.join(root,'case.test.mjs'),suite);
  for(const [name,value] of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),value);}
  const options={id:'node-phase-check',root,projectId:f.scope.projectId,repositoryId:'application',content:f.content,
    command:{executable:process.execPath,executableSha256,arguments:script===null?['--test','--test-reporter=tap','case.test.mjs']:['-e',script],environment:{}},
    report,source:{excludePaths:['runs.log','child.pid']},authorizeCommand:manifest=>manifest.manifestSha256,...extra};configure(options);
  const unit=await createNodeCheckExecutionUnit(options);
  const task=overrides=>createAgentTaskContract({taskId:'check-one',processId:'PROC-check',instructionId:'test',objective:'Execute the pinned local test.',
    acceptanceClauses:[],policySnapshotSha256:digest('policy'),programSha256:digest('program'),inputs:[],readScope:['repository:application'],
    writeScope:['repository:application'],forbiddenScope:['.git'],allowedDevices:[],environmentManifestSha256:digest('environment'),
    candidatePolicy:'immutable-snapshot',outputSchema:{type:'object'},requiredEvidence:[],budgets:{activeMinutes:1,modelInvocations:0,touchedResources:100},
    stopConditions:[],executionUnitManifestSha256:unit.descriptor().manifestSha256,...overrides});
  const bytes=async reference=>Buffer.from((await f.content.read(f.scope,reference,{maximumBytes:reference.bytes})).data);
  return {...f,root,options,unit,task,contract:task(),bytes};
}
async function output(f){const handle=await f.unit.start(f.contract);return (await f.unit.collect(handle)).output;}

test('environment-qualified bindings reject inherited or accessor options before evaluating command data',async()=>{
  let reads=0;const poison=()=>{reads++;throw Error('Options cannot run a getter.');},
    inherited=Object.create(Object.defineProperty({},'hostId',{get:poison})),own=Object.defineProperty({},'hostId',{enumerable:true,get:poison}),
    command=Object.defineProperty({},'executable',{enumerable:true,get:poison});
  for(const options of [inherited,own,{hostId:'actual-check-owner',command},{hostId:'actual-check-owner'},{hostId:'actual-check-owner',environmentQualification:{platform:'claimed'}}])
    await assert.rejects(createEnvironmentQualifiedNodeCheckExecutionUnit(options),{code:'SGOS_CHECK_INPUT_INVALID'});
  assert.equal(reads,0);
});
test('an environment-qualified native execution retains real runtime and reporter identity while the original profile stays unchanged',async t=>{
  const f=await fixture(t,{backend:'sqlite'}),original=f.unit.descriptor();
  f.unit=await createEnvironmentQualifiedNodeCheckExecutionUnit({...f.options,hostId:'actual-check-owner'});
  f.contract=f.task({executionUnitManifestSha256:f.unit.descriptor().manifestSha256});
  const qualification=f.unit.descriptor().toolPolicy.environmentQualification,result=await output(f);
  assert.equal(result.format,NODE_QUALIFIED_CHECK_EXECUTION_PROFILE);assert.equal(result.process.status,0);assert.equal(result.reports.parsed.tests.passed,1);
  assert.equal(qualification.platform,platform());assert.equal(qualification.arch,arch());assert.equal(qualification.hostId,'actual-check-owner');
  assert.equal(qualification.runtimeSha256,executableSha256);assert.equal(qualification.environmentSha256,digest({}));
  assert.equal(qualification.reportRoot.absolute,await realpath(f.root));assert.equal(qualification.reportRoot.grammar,path.sep==='\\'?'win32':'posix');
  assert.equal(original.toolPolicy.profile,NODE_CHECK_EXECUTION_PROFILE);assert.equal(original.toolPolicy.environmentQualification,undefined);
});
test('qualified runtime selection refuses a substitute executable and preserves a missing executable error',async t=>{
  const f=await fixture(t,{backend:'sqlite'}),substitute=path.join(f.root,'substitute-node'),missing=path.join(f.root,'missing-node');
  await writeFile(substitute,'Not the running Node executable.');
  const options=executable=>({...f.options,hostId:'actual-check-owner',command:{...f.options.command,executable}});
  await assert.rejects(createEnvironmentQualifiedNodeCheckExecutionUnit(options(substitute)),{code:'SGOS_CHECK_INPUT_INVALID'});
  await assert.rejects(createEnvironmentQualifiedNodeCheckExecutionUnit(options(missing)),error=>error.code==='ENOENT'&&error.path===missing);
});

test('a genuine pinned Node check retains actual output, source observations and candidate-only counts',async t=>{
  const f=await fixture(t),result=await output(f);
  assert.equal(result.format,NODE_CHECK_EXECUTION_PROFILE);assert.equal(result.process.status,0);assert.equal(result.process.closed,true);
  assert.equal(result.source.unchanged,true);assert.deepEqual(result.reports.parsed.tests,{discovered:1,passed:1,failed:0,skipped:0});
  assert.equal(result.reports.parsed.testcaseObservation,null);assert.deepEqual(result.diagnostics,[]);
  assert.match((await f.bytes(result.stdout)).toString(),/real local check/);assert.equal((await f.bytes(result.stderr)).length,0);
  const before=JSON.parse((await f.bytes(result.source.before.content)).toString());assert.equal(before.entries[0].path,'case.test.mjs');
  assert.equal(result.reports.raw[0].content.sha256,result.stdout.sha256);
  assert.equal(Object.hasOwn(result,'verification'),false);assert.equal(Object.hasOwn(result,'approved'),false);
  assert.equal(f.unit.descriptor().sandbox.enforcement,'none');assert.equal(f.unit.descriptor().network.mode,'host-unrestricted');
  for(const namespace of ['state','config','evidence'])assert.deepEqual((await f.records.list(f.scope,namespace,{limit:100})).entries,[]);
});
test('the check uses the captured environment and argv without leaking ambient host variables',async t=>{
  const key='SFLOW_CHECK_CANARY',prior=process.env[key];process.env[key]='host-only';t.after(()=>{if(prior===undefined)delete process.env[key];else process.env[key]=prior;});
  const f=await fixture(t,{files:{'case.test.mjs':"import test from 'node:test';import assert from 'node:assert/strict';test('explicit environment',()=>{for(const key of ['SFLOW_CHECK_CANARY','PATH','HOME','NODE_OPTIONS'])assert.equal(Object.hasOwn(process.env,key),false);assert.equal(process.env.CHECK_VALUE,'bound');});"},
    configure:options=>{options.command.environment={CHECK_VALUE:'bound'};}});
  f.options.command.environment.CHECK_VALUE='changed after binding';f.options.command.arguments[0]='wrong';
  const result=await output(f);assert.equal(result.process.status,0);assert.equal(result.reports.parsed.tests.passed,1);
  assert.equal(JSON.stringify(f.unit.descriptor()).includes('bound'),false);
});
test('a genuine failing Node check retains its nonzero result and failing test observation',async t=>{
  const f=await fixture(t,{files:{'case.test.mjs':suite.replace('2+2,4','2+2,5')}}),result=await output(f);
  assert.notEqual(result.process.status,0);assert.equal(result.reports.parsed.tests.failed,1);
  assert.match((await f.bytes(result.stdout)).toString(),/AssertionError/);assert.equal(result.source.unchanged,true);
});
test('a test-side source edit remains visible rather than earning unchanged-source evidence',async t=>{
  const f=await fixture(t,{files:{'case.test.mjs':suite+"import {writeFileSync} from 'node:fs';writeFileSync('application.js','changed by test');",'application.js':'original'} }),result=await output(f);
  assert.equal(result.process.status,0);assert.equal(result.source.unchanged,false);assert.notEqual(result.source.before.revision,result.source.after.revision);
});
test('authorization and declared repository scope are checked before the command can launch',async t=>{
  const f=await fixture(t,{script:"require('node:fs').writeFileSync('launched','bad')",extra:{authorizeCommand:()=>false}});
  await assert.rejects(f.unit.collect(await f.unit.start(f.contract)),{code:'SGOS_CHECK_AUTHORITY_REQUIRED'});
  await assert.rejects(access(path.join(f.root,'launched')),{code:'ENOENT'});
  const task=f.task({readScope:['repository:other']});await assert.rejects(f.unit.collect(await f.unit.start(task)),{code:'SGOS_CHECK_SCOPE_INVALID'});
});
test('changed pinned executable bytes cannot become a test run',async t=>{
  const f=await fixture(t,{configure:options=>{options.command.executableSha256='sha256:'+'0'.repeat(64);}});
  await assert.rejects(f.unit.collect(await f.unit.start(f.contract)),{code:'SGOS_GEU_EXECUTABLE_CHANGED'});
});
test('fresh on-disk JUnit is retained and parsed, with generated report bytes excluded from source drift',async t=>{
  const script="require('node:fs').writeFileSync('report.xml',"+JSON.stringify(junit)+")";
  const f=await fixture(t,{script,report:{adapter:'junit-xml',files:['report.xml']}}),result=await output(f);
  assert.equal(result.reports.parsed.tests.passed,1);assert.equal(result.source.unchanged,true);assert.deepEqual(result.diagnostics,[]);
  assert.equal((await f.bytes(result.reports.raw[0].content)).toString(),junit);
});
test('an unchanged old report is preserved for diagnosis and never parsed as this execution',async t=>{
  const f=await fixture(t,{script:'process.exit(0)',files:{'report.xml':junit},report:{adapter:'junit-xml',files:['report.xml']}}),result=await output(f);
  assert.equal(result.process.status,0);assert.equal(result.reports.parsed,null);assert.equal(result.diagnostics[0].code,'SGOS_CHECK_REPORT_STALE');
  assert.equal((await f.bytes(result.reports.raw[0].content)).toString(),junit);
});
test('missing and invalid reports retain their real diagnostics rather than inventing passing tests',async t=>{
  const absent=await fixture(t,{script:'process.exit(0)',report:{adapter:'junit-xml',files:['missing.xml']}}),missing=await output(absent);
  assert.equal(missing.reports.parsed,null);assert.equal(missing.diagnostics[0].code,'ENOENT');assert.equal(missing.diagnostics[0].path,'missing.xml');
  const invalid=await fixture(t,{script:"process.stdout.write('<broken>')",report:{adapter:'junit-xml',files:[]}}),broken=await output(invalid);
  assert.equal(broken.reports.parsed,null);assert.equal(broken.diagnostics[0].code,'CODE_TEST_RESULT_REQUIRED');
  assert.equal((await invalid.bytes(broken.stdout)).toString(),'<broken>');
});
test('an escaped report path is refused before command execution',async t=>{
  await assert.rejects(fixture(t,{report:{adapter:'junit-xml',files:['../outside.xml']}}),{code:'SGOS_SOURCE_CONTRACT_INVALID'});
});
test('a shared generated directory supports hundreds of reports without excluding unrelated source',async t=>{
  const report={adapter:'junit-xml',files:Array.from({length:300},(_,index)=>'reports/test-'+index+'.xml')};
  const f=await fixture(t,{report,extra:{source:{excludePaths:['reports']}}});
  assert.deepEqual(f.unit.descriptor().toolPolicy.repository.selection.excludePaths,['.git','.singularity-flow','reports']);
  assert.equal(f.unit.descriptor().toolPolicy.report.files.length,300);
  await assert.rejects(fixture(t,{report}),{code:'SGOS_SOURCE_CONTRACT_INVALID'});
});
test('Git and SFlow metadata cannot be offered as report files',async t=>{
  for(const file of ['.git/config','.singularity-flow/private'])await assert.rejects(fixture(t,{report:{adapter:'junit-xml',files:[file]}}),{code:'SGOS_CHECK_SCOPE_INVALID'});
});
test('a symbolic report cannot read outside the selected checkout',async t=>{
  const f=await fixture(t,{script:'process.exit(0)',report:{adapter:'junit-xml',files:['report.xml']}});
  await writeFile(path.join(f.directory,'outside.xml'),junit);await symlink(path.join(f.directory,'outside.xml'),path.join(f.root,'report.xml'));
  await assert.rejects(f.unit.collect(await f.unit.start(f.contract)),{code:'SGOS_CHECK_REPORT_LINK_DENIED'});
});
test('a report-content outage preserves the actual error after the process closes',async t=>{
  const failure=Object.assign(new Error('Retained report storage unavailable.'),{code:'EACCES'});
  const f=await fixture(t,{configure:options=>{options.content={...options.content,put(){throw failure;}};}});
  const handle=await f.unit.start(f.contract);await assert.rejects(f.unit.collect(handle),error=>error===failure);
  assert.equal((await f.unit.quiesce(handle)).quiescent,true);
});
test('a bounded check timeout retains the real terminated-process outcome and captured output',async t=>{
  const f=await fixture(t,{script:"process.stdout.write('before timeout');setInterval(()=>{},1000)",extra:{timeoutMs:250}}),result=await output(f);
  assert.equal(result.process.timedOut,true);assert.equal(result.process.closed,true);assert.notEqual(result.process.status,0);
  assert.match((await f.bytes(result.stdout)).toString(),/before timeout/);
});
test('a stuck content operation has an explicit bounded I/O failure after process closure',async t=>{
  const f=await fixture(t,{extra:{timeoutMs:1000},configure:options=>{options.content={...options.content,put(){return new Promise(()=>{});}};}});
  const handle=await f.unit.start(f.contract);
  await assert.rejects(f.unit.collect(handle),cause=>cause.code==='SGOS_CHECK_IO_TIMEOUT'&&cause.details.stage==='retain-put'&&cause.details.timeoutMs===1000);
  assert.equal((await f.unit.quiesce(handle)).quiescent,true);
});
test('authorization expiry cannot launch a late callback result',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{script:"require('node:fs').writeFileSync('launched','bad')",extra:{timeoutMs:100,authorizeCommand:()=>gate}});
  const handle=await f.unit.start(f.contract);
  await assert.rejects(f.unit.collect(handle),cause=>cause.code==='SGOS_CHECK_IO_TIMEOUT'&&cause.details.stage==='authorization');
  release(true);await f.unit.quiesce(handle);await assert.rejects(access(path.join(f.root,'launched')),{code:'ENOENT'});
});
test('a mismatched immutable content reference cannot authenticate raw process output',async t=>{
  const f=await fixture(t,{configure:options=>{const original=options.content;
    options.content={...original,async put(...args){const saved=await original.put(...args);return {...saved,reference:{...saved.reference,sha256:'0'.repeat(64)}};}};}});
  await assert.rejects(f.unit.collect(await f.unit.start(f.contract)),{code:'SGOS_CHECK_CONTENT_INVALID'});
});
test('a stop interrupts pending authorization and cannot launch later',async t=>{
  let entered,release;const pending=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{script:"require('node:fs').writeFileSync('launched','bad')",extra:{authorizeCommand:async()=>{entered();await gate;return true;}}});
  const handle=await f.unit.start(f.contract);await pending;await f.unit.requestStop(handle,{reason:'Cancel this check before it launches.'});
  await f.unit.quiesce(handle);release();await assert.rejects(f.unit.collect(handle),{code:'SGOS_GEU_STOP_REQUESTED'});
  await assert.rejects(access(path.join(f.root,'launched')),{code:'ENOENT'});
});
test('an active check stops its owned process before quiescence is acknowledged',async t=>{
  const f=await fixture(t,{script:"require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)"});
  let pid;const handle=await f.unit.start(f.contract),deadline=Date.now()+10_000;
  t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}});
  while(!pid&&Date.now()<deadline){try{pid=Number(await readFile(path.join(f.root,'child.pid'),'utf8'));}catch(cause){if(cause.code!=='ENOENT')throw cause;await pause(10);}}
  assert.ok(pid);await f.unit.requestStop(handle,{reason:'Stop this actual local test process.'});
  assert.equal((await f.unit.quiesce(handle)).quiescent,true);await assert.rejects(f.unit.collect(handle),{code:'SGOS_GEU_STOP_REQUESTED'});
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});pid=null;
});
for(const backend of ['filesystem','sqlite','application'])test(backend+': durable execution reopens real check evidence without launching again',async t=>{
  const f=await fixture(t,{backend}),store=createNamespaceSgosOperationalStore({records:f.records,content:f.content,scope:f.scope,storeId:'real-check-history'});
  let launches=0;const raw={...f.unit,start(contract){launches++;return f.unit.start(contract);}};
  const bindings={unit:raw,store,content:f.content,scope:f.scope,clock:f.clock};
  const runtime=createDurableExecutionUnit({...bindings,owner:createNodeExecutionOwner({hostId:'check-owner'})});
  const handle=await runtime.start(f.contract),candidate=await runtime.collect(handle);assert.equal(candidate.output.reports.parsed.tests.passed,1);
  const later=createDurableExecutionUnit({...bindings,unit:{...f.unit,start(){throw Error('Do not repeat the test.');}},owner:createNodeExecutionOwner({hostId:'later-check-owner'})});
  assert.deepEqual(await later.start(f.contract),handle);assert.deepEqual(await later.collect(handle),candidate);assert.equal(launches,1);
  assert.match((await f.bytes(candidate.output.stdout)).toString(),/real local check/);
});

test('the shared supervisor preserves launch errors after actual close',async()=>{
  const result=await executePinnedProcess({command:{executable:path.join(path.sep,'unavailable-sflow-executor'),arguments:[]},
    root:path.resolve('.'),environment:{},timeoutMs:1000});
  assert.equal(result.error.code,'ENOENT');assert.notEqual(result.status,0);
});
test('the shared supervisor terminates a descendant that holds pipes after its leader exits',async t=>{
  const f=await fixture(t),script="require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:['ignore',process.stdout,process.stderr]});process.exit(0)";
  const start=Date.now();const result=await executePinnedProcess({command:{executable:process.execPath,arguments:['-e',script]},root:f.root,environment:{},timeoutMs:250});
  assert.equal(result.timedOut,true);assert.ok(Date.now()-start<6000);
});
test('a broken child input pipe is not reported until the still-running process has closed',async t=>{
  const f=await fixture(t);let pid;
  t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}});
  const script="const fs=require('node:fs');fs.writeFileSync('child.pid',String(process.pid));fs.closeSync(0);setInterval(()=>{},1000)";
  const result=await executePinnedProcess({command:{executable:process.execPath,arguments:['-e',script]},root:f.root,environment:{},input:'x'.repeat(4*1024*1024),timeoutMs:5000});
  assert.equal(result.error.code,'EPIPE');pid=Number(await readFile(path.join(f.root,'child.pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});pid=null;
});
test('a descendant with closed pipes cannot survive successful leader completion on this host',async t=>{
  const f=await fixture(t);let pid;t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}});
  const script="const child=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});require('node:fs').writeFileSync('child.pid',String(child.pid));setTimeout(()=>process.exit(0),150)";
  const result=await executePinnedProcess({command:{executable:process.execPath,arguments:['-e',script]},root:f.root,environment:{},timeoutMs:5000});
  assert.equal(result.error,null);assert.equal(result.status,0);pid=Number(await readFile(path.join(f.root,'child.pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});pid=null;
});
test('unconfirmed termination preserves the original stream error and cannot mint positive quiescence',async t=>{
  const f=await fixture(t),original=process.kill;
  t.after(()=>{process.kill=original;});
  // Simulate a host that cannot establish group disappearance, while still killing the real child.
  process.kill=function(pid,signal){if(pid<0&&signal===0)return true;return original.call(process,pid,signal);};
  const script="require('node:fs').closeSync(0);setInterval(()=>{},1000)";
  const unit=createExecutionUnitAdapter(f.unit.descriptor(),async()=>{
    const result=await executePinnedProcess({command:{executable:process.execPath,arguments:['-e',script]},root:f.root,
      environment:{},input:'x'.repeat(4*1024*1024),timeoutMs:5000});
    if(result.error)throw result.error;throw Error('A terminal result was not expected.');
  });
  const handle=await unit.start(f.contract);
  await assert.rejects(unit.collect(handle),cause=>cause.code==='SGOS_GEU_QUIESCENCE_UNCONFIRMED'
    &&cause.cause.code==='EPIPE'&&cause.details.processError.code==='EPIPE');
  assert.equal((await unit.quiesce(handle)).quiescent,false);
});
