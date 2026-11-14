/** Explicit authorized local checks. No Git, providers, installed configuration or lifecycle writes. */
import {constants} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {platform,arch} from 'node:os';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,EXECUTION_UNIT_LIMITS,cloneSgosRecordValue} from '../foundation/record-schema.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {namespaceScope} from '../sda/namespace/values.mjs';
import {validateContentStore,contentReference} from '../sda/content/contract.mjs';
import {createNodeTestReportCodec} from '../verification/test-report-reader.mjs';
import {createFilesystemSourceUnit} from './filesystem-source-unit.mjs';
import {createExecutionUnitManifest,createExecutionUnitAdapter,executionUnitSha256,
  assertPinnedExecutionExecutable,executePinnedProcess,untilExecutionStopped} from './node-execution-unit.mjs';

import {NODE_CHECK_EXECUTION_PROFILE,NODE_QUALIFIED_CHECK_EXECUTION_PROFILE,NODE_SELECTIVE_CHECK_EXECUTION_PROFILE,NODE_COMMAND_EXECUTION_PROFILE,localCheckExecutionProfile} from '../foundation/execution-unit-port.mjs';
export {NODE_CHECK_EXECUTION_PROFILE,NODE_QUALIFIED_CHECK_EXECUTION_PROFILE,NODE_SELECTIVE_CHECK_EXECUTION_PROFILE,NODE_COMMAND_EXECUTION_PROFILE} from '../foundation/execution-unit-port.mjs';
const MAXIMUM_BYTES=EXECUTION_UNIT_LIMITS.maximumOutputBytes;
const hash=value=>createHash('sha256').update(value).digest('hex');
const fingerprint=info=>[info.dev,info.ino,info.mode,info.size,info.mtimeNs,info.ctimeNs].map(String).join(':');
const error=(message,code='SGOS_CHECK_INPUT_INVALID',details=null)=>new SingularityFlowError(message,{code,details});
const diagnostic=cause=>({name:cause.name??'Error',code:cause.code??null,message:cause.message??String(cause),
  details:cause.details??null});
function data(value,fields,label) {
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))
    ||Reflect.ownKeys(value).some(key=>!fields.includes(key)))throw error(label+' must contain only its declared data fields.');
  for(const key of Reflect.ownKeys(value))if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))throw error(label+' cannot contain accessors.');
  return cloneSgosRecordValue(value);
}

async function boundedIO(work,signal,timeoutMs,stage) {
  const controller=new AbortController(),stop=()=>controller.abort(signal.reason);
  signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  const timer=setTimeout(()=>controller.abort(error('Check observation I/O exceeded its deadline; the underlying cause is not established.',
    'SGOS_CHECK_IO_TIMEOUT',{stage,timeoutMs})),timeoutMs);
  try{return await untilExecutionStopped(Promise.resolve().then(()=>{controller.signal.throwIfAborted();return work(controller.signal);}),controller.signal);}
  finally{clearTimeout(timer);signal.removeEventListener('abort',stop);}
}

/** The host selects actual command, checkout, environment and report destinations before task admission. */
export async function createNodeCheckExecutionUnit(options={}) {
  return localCheckExecutionUnit(options,{profile:NODE_CHECK_EXECUTION_PROFILE});
}
/** Opt-in environment evidence is captured by SGOS, never asserted by a lifecycle request. */
export async function createEnvironmentQualifiedNodeCheckExecutionUnit(options={}){
  if(!options||typeof options!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(options))||Reflect.ownKeys(options).some(key=>typeof key!=='string'
    ||!Object.hasOwn(Object.getOwnPropertyDescriptor(options,key),'value')))throw error('Supply a plain explicit environment-qualified check binding.');
  const {hostId,...binding}=options;
  if(typeof hostId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(hostId))throw error('Supply the authenticated executor host identity.');
  return localCheckExecutionUnit(binding,{profile:NODE_QUALIFIED_CHECK_EXECUTION_PROFILE,hostId});
}
/** Compile/lint/security observations retain exit, output and source facts; they never parse tests. */
export async function createNodeCommandExecutionUnit(options={}){
  if(!options||typeof options!=='object'||Object.hasOwn(options,'report'))throw error('Command checks do not accept a test report selection.');
  const {commandKind,...binding}=options,selected=localCheckExecutionProfile({profile:NODE_COMMAND_EXECUTION_PROFILE,commandKind});
  return localCheckExecutionUnit({...binding,report:{adapter:null,files:[]}},{profile:selected.format,commandKind});
}
async function localCheckExecutionUnit(options,execution){
  const selected=localCheckExecutionProfile(execution);
  const allowed=['id','version','projectId','repositoryId','root','command','report','source','timeoutMs','content','authorizeCommand'];
  if(!options||typeof options!=='object'||Object.keys(options).some(key=>!allowed.includes(key)))throw error('The check binding contains unknown fields.');
  const {id,version='1.0.0',projectId,repositoryId,root,content,authorizeCommand}=options;
  const command=data(options.command,['executable','executableSha256','arguments','environment'],'Check command');
  const report=data(options.report,['adapter','files'],'Report selection');
  const selection=data(options.source??{},['excludePaths','limits'],'Source selection');
  const timeoutMs=options.timeoutMs??300_000;
  if(typeof authorizeCommand!=='function'||typeof root!=='string'||!path.isAbsolute(root)
    ||typeof command.executable!=='string'||!path.isAbsolute(command.executable)
    ||!/^sha256:[a-f0-9]{64}$/u.test(command.executableSha256??'')
    ||!Array.isArray(command.arguments)||command.arguments.some(value=>typeof value!=='string'||value.includes('\0'))
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>86_400_000)throw error('An authorized pinned executable, argv, absolute checkout and bounded deadline are required.');
  command.environment=data(command.environment??{},Object.keys(command.environment??{}),'Check environment');
  if(Object.entries(command.environment).some(([key,value])=>!key||key.includes('=')||key.includes('\0')||typeof value!=='string'||value.includes('\0')))
    throw error('The exact check environment must contain string values and valid names.');
  if((selected.testReport?typeof report.adapter!=='string'||!report.adapter:report.adapter!==null||report.files?.length!==0)
    ||!Array.isArray(report.files)||report.files.length>1000)
    throw error('Select an explicit report adapter and bounded files, or an empty list for stdout.');
  report.files=report.files.map(sourceRelativePath);
  if(new Set(report.files).size!==report.files.length)throw error('Report paths must be distinct.');
  if(report.files.some(file=>['.git','.singularity-flow'].some(prefix=>file===prefix||file.startsWith(prefix+'/'))))
    throw error('Repository and SFlow metadata cannot be selected as test reports.','SGOS_CHECK_SCOPE_INVALID');
  if(selected.qualifiedEnvironment&&await realpath(command.executable)!==await realpath(process.execPath))throw error(
    'Environment-qualified Node checks must use this executor\'s actual native Node runtime.');
  const scope=namespaceScope({projectId}),blobs=validateContentStore(content);
  if(blobs.descriptor.binding.kind!=='shared'||blobs.descriptor.maximumBytes<MAXIMUM_BYTES)
    throw error('Check observations require an explicit shared content store with sufficient byte capacity.');
  const put=blobs.put.bind(blobs),read=blobs.read.bind(blobs),physical=await realpath(root);
  const exclusions=[...new Set([...(selection.excludePaths??[]),...report.files])].map(sourceRelativePath);
  const excludePaths=exclusions.filter(file=>!exclusions.some(parent=>parent!==file&&file.startsWith(parent+'/')));
  const source=await createFilesystemSourceUnit({root:physical,id:id+'-source',projectId,repositoryId,excludePaths,limits:selection.limits??{}});
  const policy={...execution,repository:source.descriptor,timeoutMs,
    command:{executableSha256:command.executableSha256,argumentsSha256:executionUnitSha256(command.arguments),
      environmentSha256:executionUnitSha256(command.environment),environmentNames:Object.keys(command.environment).sort()},report};
  if(selected.qualifiedEnvironment){
    delete policy.hostId;
    policy.environmentQualification={profile:'sflow-node-check-environment/v1',hostId:execution.hostId,platform:platform(),arch:arch(),
      runtimeSha256:command.executableSha256,environmentSha256:policy.command.environmentSha256,
      reportRoot:{grammar:path.sep==='\\'?'win32':'posix',absolute:physical}};
  }
  const manifest=createExecutionUnitManifest({id,version,publisher:'singularity-flow',provider:'authorized-local-check',models:[],
    capabilities:{readFiles:true,writeFiles:true,process:true},sandbox:{kind:'host-local',enforcement:'none'},
    network:{mode:'host-unrestricted'},toolPolicy:policy,risk:{class:'host-authorized-process'},
    tests:{conformanceReceiptSha256:executionUnitSha256(execution.profile)}});
  const codec=createNodeTestReportCodec();
  async function retain(bytes,signal,deadline) {
    signal.throwIfAborted();const expected={namespace:'runtime',sha256:hash(bytes),bytes:bytes.byteLength};
    const saved=await boundedIO(selected=>put(scope,'runtime',bytes,{signal:selected}),signal,deadline,'retain-put');
    if(canonicalJson(contentReference(saved?.reference))!==canonicalJson(expected))throw error('The content port returned another observation.','SGOS_CHECK_CONTENT_INVALID');
    const observed=await boundedIO(selected=>read(scope,expected,{maximumBytes:expected.bytes,signal:selected}),signal,deadline,'retain-read');
    if(observed?.status!=='present'||observed.truncated!==false||!(observed.data instanceof Uint8Array)
      ||observed.data.byteLength!==expected.bytes||hash(observed.data)!==expected.sha256)
      throw error('The retained observation could not be verified.','SGOS_CHECK_CONTENT_INVALID');
    signal.throwIfAborted();return expected;
  }
  async function reportFile(relative,signal) {
    signal.throwIfAborted();const absolute=path.join(physical,...relative.split('/'));
    if(await realpath(path.dirname(absolute))!==path.dirname(absolute))throw error('A report parent is a symbolic link.','SGOS_CHECK_REPORT_LINK_DENIED',{path:relative});
    const initial=await lstat(absolute,{bigint:true});
    if(!initial.isFile()||initial.isSymbolicLink())throw error('Reports must be regular files.','SGOS_CHECK_REPORT_LINK_DENIED',{path:relative});
    if(initial.size>BigInt(MAXIMUM_BYTES))throw error('The report exceeds its byte bound.','SGOS_CHECK_REPORT_LIMIT',{path:relative});
    const handle=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try{
      if(fingerprint(await handle.stat({bigint:true}))!==fingerprint(initial))throw error('The report changed before reading.','SGOS_CHECK_REPORT_CHANGED',{path:relative});
      const chunks=[],chunk=Buffer.alloc(65536);let offset=0;
      for(;;){signal.throwIfAborted();const next=await handle.read(chunk,0,chunk.length,offset);if(!next.bytesRead)break;
        offset+=next.bytesRead;if(offset>MAXIMUM_BYTES||offset>Number(initial.size))throw error('The report grew during reading.','SGOS_CHECK_REPORT_CHANGED',{path:relative});
        chunks.push(Buffer.from(chunk.subarray(0,next.bytesRead)));}
      if(offset!==Number(initial.size)||fingerprint(await handle.stat({bigint:true}))!==fingerprint(initial)
        ||await realpath(absolute)!==absolute||fingerprint(await lstat(absolute,{bigint:true}))!==fingerprint(initial))
        throw error('The report changed during reading.','SGOS_CHECK_REPORT_CHANGED',{path:relative});
      return {bytes:Buffer.concat(chunks),fingerprint:fingerprint(initial)};
    }finally{await handle.close();}
  }
  const adapter=createExecutionUnitAdapter(manifest,async(contract,runtime)=>{
    const signal=runtime.signal,repositoryScope='repository:'+repositoryId,deadline=Math.min(timeoutMs,contract.budgets.activeMinutes*60_000);
    signal.throwIfAborted();
    if(contract.allowedDevices.length||contract.readScope.length!==1||contract.readScope[0]!==repositoryScope
      ||contract.writeScope.some(value=>value!==repositoryScope))throw error('The local check contract must name its one selected repository.','SGOS_CHECK_SCOPE_INVALID');
    const authorized=await boundedIO(()=>authorizeCommand(manifest,contract),signal,deadline,'authorization');
    signal.throwIfAborted();if(authorized!==true&&authorized!==manifest.manifestSha256)throw error('The pinned check was not authorized.','SGOS_CHECK_AUTHORITY_REQUIRED');
    await boundedIO(selected=>assertPinnedExecutionExecutable(command,selected),signal,deadline,'executable');
    const before=await boundedIO(selected=>source.capture({signal:selected}),signal,deadline,'source-before'),oldReports=[];
    for(const file of report.files){try{oldReports.push(await boundedIO(selected=>reportFile(file,selected),signal,deadline,'report-before'));}
      catch(cause){if(cause.code!=='ENOENT')throw cause;oldReports.push(null);}}
    signal.throwIfAborted();
    const processResult=await executePinnedProcess({command,root:physical,environment:command.environment,signal,
      timeoutMs:deadline});
    if(processResult.error?.quiescenceUnknown)throw processResult.error;
    signal.throwIfAborted();
    const stdout=await retain(processResult.stdout,signal,deadline),stderr=await retain(processResult.stderr,signal,deadline);
    const diagnostics=[],raw=[];let total=0,parsed=null,after=null;
    if(processResult.error)diagnostics.push({stage:'process',...diagnostic(processResult.error)});
    try{after=await boundedIO(selected=>source.capture({signal:selected}),signal,deadline,'source-after');}
    catch(cause){signal.throwIfAborted();diagnostics.push({stage:'source-after',...diagnostic(cause)});}
    const reports=[];
    if(!report.files.length){reports.push({contents:processResult.stdout});raw.push({path:null,content:stdout});}
    else for(let index=0;index<report.files.length;index++){
      const file=report.files[index];
      try{const result=await boundedIO(selected=>reportFile(file,selected),signal,deadline,'report-after');total+=result.bytes.byteLength;
        if(total>MAXIMUM_BYTES)throw error('The combined reports exceed their byte bound.','SGOS_CHECK_REPORT_LIMIT');
        raw.push({path:file,content:await retain(result.bytes,signal,deadline)});
        if(result.fingerprint===oldReports[index]?.fingerprint)throw error('This report predates the check execution.','SGOS_CHECK_REPORT_STALE',{path:file});
        reports.push({contents:result.bytes});
      }catch(cause){signal.throwIfAborted();diagnostics.push({stage:'report',path:file,...diagnostic(cause)});}
    }
    if(selected.testReport&&!diagnostics.some(value=>value.stage==='report'))try{
      await codec.prepareTestReportReader(report.adapter);parsed=codec.replayTestReports(report.adapter,reports);
    }catch(cause){diagnostics.push({stage:'report-parse',...diagnostic(cause)});}
    const beforeContent=await retain(Buffer.from(canonicalJson(before.snapshot)),signal,deadline);
    const afterContent=after?await retain(Buffer.from(canonicalJson(after.snapshot)),signal,deadline):null;
    return {output:{schemaVersion:1,format:execution.profile,assurance:'authorized-local-process',
      manifestSha256:manifest.manifestSha256,contractSha256:contract.contractSha256,command:policy.command,
      process:{status:processResult.status,signal:processResult.signal,timedOut:processResult.timedOut,overflow:processResult.overflow,closed:true},
      stdout,stderr,source:{before:{revision:before.revision,content:beforeContent},
        after:after?{revision:after.revision,content:afterContent}:null,unchanged:after?before.revision===after.revision:false},
      reports:{adapter:report.adapter,raw,parsed},diagnostics},usage:{modelInvocations:0,assurance:'authorized-local-process'}};
  },async()=>{try{await assertPinnedExecutionExecutable(command);return {status:'ready'};}
    catch(cause){return {status:'unavailable',diagnosticCode:cause.code??'SGOS_CHECK_EXECUTABLE_UNAVAILABLE'};}});
  if(!selected.qualifiedEnvironment)return adapter;
  // A read-only observation rechecks the actual executable and checkout. A manifest or a
  // successful doctor result alone cannot attest to the environment of a later operation.
  return Object.freeze({...adapter,...(!selected.selective?{async selectTestFiles(input){
    const request=data(input,['files','selectionSha256','originalArgumentsSha256'],'Reviewed test selection'),args=command.arguments,
      offset=args[2]==='--'?3:2,full=args.slice(offset);
    if(args[0]!=='--test'||args[1]!=='--test-reporter=junit'||report.adapter!=='junit-xml'||report.files.length
      ||Object.keys(command.environment).length||request.originalArgumentsSha256!==policy.command.argumentsSha256
      ||!/^sha256:[a-f0-9]{64}$/u.test(request.selectionSha256??'')||!Array.isArray(request.files)||!request.files.length
      ||request.files.length>256||new Set(request.files).size!==request.files.length||request.files.some(file=>!full.includes(file)
        ||sourceRelativePath(file)!==file||file.startsWith('-'))||full.some(file=>file.startsWith('-')))
      throw error('Select only explicit complete files of this pinned native Node JUnit command.','SGOS_CHECK_SELECTION_INVALID');
    return localCheckExecutionUnit({...options,id:id+'-selected-'+request.selectionSha256.slice(7,23),
      command:{...command,arguments:[...args.slice(0,offset),...request.files]}},{profile:NODE_SELECTIVE_CHECK_EXECUTION_PROFILE,
        hostId:execution.hostId,selection:{profile:'sflow-node-check-file-selection/v1',sha256:request.selectionSha256,
          originalArgumentsSha256:request.originalArgumentsSha256,files:request.files}});
  }}:{}),async observeEnvironment({signal}={}){
    const active=signal??new AbortController().signal;
    active.throwIfAborted();
    await boundedIO(next=>assertPinnedExecutionExecutable(command,next),active,timeoutMs,'environment-executable');
    if(await realpath(command.executable)!==await realpath(process.execPath))throw error('The native Node runtime changed.','SGOS_CHECK_ENVIRONMENT_CHANGED');
    const current=await boundedIO(next=>source.capture({signal:next}),active,timeoutMs,'environment-source');
    return {schemaVersion:1,profile:'sflow-node-check-environment-observation/v1',
      qualification:structuredClone(policy.environmentQualification),command:structuredClone(policy.command),
      repository:structuredClone(source.descriptor),source:current};
  }});
}
