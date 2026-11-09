/** Explicit, local-only Git observations. Reuse the pinned SGOS process owner; never publish. */
import {createHash} from 'node:crypto';
import {devNull} from 'node:os';
import path from 'node:path';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceUnitDescriptor,sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {SOURCE_CONTROL_READER_CONTRACT,SOURCE_CONTROL_OBSERVATION_FORMAT,SOURCE_CONTROL_READER_CONTRACT_V2,SOURCE_CONTROL_OBSERVATION_FORMAT_V2,SOURCE_CONTROL_LIMITS,
  sourceControlReaderDescriptor,sourceControlCaptureRequest,sourceControlObservation} from '../foundation/source-control.mjs';
import {repositoryChangeEntryOrder,withRepositoryChangeEntryIdentity,repositoryChangeSetDigest} from '../engine-compatibility/node-source-policy.mjs';
import {createGitRawDiffParser,gitPatchCoordinates} from '../git-status-detail.mjs';
import {bindFilesystemSource} from './filesystem-source-unit.mjs';
import {assertPinnedExecutionExecutable,executePinnedProcess,untilExecutionStopped} from './node-execution-unit.mjs';
export const NODE_GIT_SOURCE_CONTROL_PROFILE='git-selected-worktree-change-set/v1';
export const NODE_GIT_SOURCE_CONTROL_PROFILE_V2='git-selected-worktree-line-origins/v2';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const objectId=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
const error=(message,code='SGOS_SOURCE_CONTROL_INPUT_INVALID',details=null)=>new SingularityFlowError(message,{code,details});
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
function fields(value,keys){if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).some(key=>!keys.includes(key)))throw error('Use only the declared source-control capability fields.');
  for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw error('Source-control capability options must be ordinary data fields.');}}
function decode(data){try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}catch(cause){throw error('Git returned paths that cannot be represented by the selected source contract.','SGOS_SOURCE_CONTROL_PATH_INVALID',{causeCode:cause.code??null});}}
function nul(data){const text=decode(data);if(text&&text.at(-1)!=='\0')throw error('Git returned incomplete NUL framing.','SGOS_SOURCE_CONTROL_PROTOCOL_INVALID');return text.split('\0').filter(Boolean);}
export async function createNodeGitSourceControlReader(options={}) {
  fields(options,['id','root','source','baselineCommit','originCommit','git','timeoutMs','authorizeCapture','notice']);
  const {id,root,baselineCommit,originCommit,authorizeCapture,notice=()=>{},timeoutMs=300_000}=options,source=sourceUnitDescriptor(options.source);
  fields(options.git,['executable','executableSha256','environment']);
  if(typeof root!=='string'||!path.isAbsolute(root)||/[\u0000-\u001f\u007f]/u.test(root)||source.provider!=='filesystem'
    ||!objectId(baselineCommit)||originCommit!==undefined&&!objectId(originCommit)||typeof authorizeCapture!=='function'||typeof notice!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300_000
    ||typeof options.git.executable!=='string'||!path.isAbsolute(options.git.executable)||!/^sha256:[a-f0-9]{64}$/u.test(options.git.executableSha256??''))throw error('Git source control needs an explicit root, exact baseline, pinned binary and authorization.');
  const supplied=options.git.environment??{};fields(supplied,Object.keys(supplied));
  for(const [key,value]of Object.entries(supplied))if(!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)||typeof value!=='string'||value.length>32768||value.includes('\0')||/^GIT_/iu.test(key))throw error('Git selector/configuration variables are managed by the local reader.');
  const environment=freeze({...supplied,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:devNull,GIT_CONFIG_GLOBAL:devNull,
    GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',GIT_PROTOCOL_FROM_USER:'0'});
  const git=freeze({executable:options.git.executable,executableSha256:options.git.executableSha256});
  const {unit,physical}=await bindFilesystemSource({root,id:source.id,projectId:source.projectId,repositoryId:source.repositoryId,
    excludePaths:source.selection.excludePaths,limits:source.limits});
  if(!same(unit.descriptor,source))throw error('The Git reader has another source selection.');
  const v2=originCommit!==undefined,profile=v2?NODE_GIT_SOURCE_CONTROL_PROFILE_V2:NODE_GIT_SOURCE_CONTROL_PROFILE;
  const descriptor=freeze(sourceControlReaderDescriptor({contract:v2?SOURCE_CONTROL_READER_CONTRACT_V2:SOURCE_CONTROL_READER_CONTRACT,id,source,profile,
    ...(v2?{originRevision:originCommit}:{}),
    baselineRevision:baselineCommit,executableSha256:git.executableSha256,environmentSha256:'sha256:'+hash(canonicalJson(environment)),
    limits:{...SOURCE_CONTROL_LIMITS,maximumDurationMs:timeoutMs}}));
  const selected=relative=>!source.selection.excludePaths.some(excluded=>relative===excluded||relative.startsWith(excluded+'/'));
  const normalizePath=value=>{try{return sourceRelativePath(value);}catch{throw error('Git returned a path outside the portable source contract.','SGOS_SOURCE_CONTROL_PATH_INVALID');}};
  const parseRawDiff=createGitRawDiffParser(normalizePath);const caches=new Map();
  return Object.freeze({descriptor,async capture(input,{signal:parentSignal}={}){
    const subject=freeze(sourceControlCaptureRequest(input)),controller=new AbortController(),started=Date.now(),deadline=started+timeoutMs;
    let stage='authorization',gitCalls=0,baselineCacheReused=caches.has(baselineCommit);
    const timeout=()=>{const cause=error('Local Git observation exceeded its deadline; no network cause is inferred.','SGOS_SOURCE_CONTROL_TIMEOUT',{stage,timeoutMs});cause.timedOut=true;cause.timeoutMs=timeoutMs;return cause;};
    const abort=()=>controller.abort(error('Local Git observation was cancelled.','SGOS_SOURCE_CONTROL_CANCELLED'));
    parentSignal?.addEventListener('abort',abort,{once:true});if(parentSignal?.aborted)abort();
    const timer=setTimeout(()=>controller.abort(timeout()),timeoutMs),signal=controller.signal;
    const stopped=()=>{if(Date.now()>=deadline&&!signal.aborted)controller.abort(timeout());signal.throwIfAborted();};
    const emit=()=>notice({stage,gitCalls,baselineCacheReused});
    async function runGit(args,{input=null,allowAbsent=false,maximumBytes=33_554_432}={}){
      stopped();stage=args[0];gitCalls++;emit();
      const result=await executePinnedProcess({command:{...git,arguments:['-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','gc.auto=0','-c','maintenance.auto=false',...args]},
        root:physical,environment,input,signal,timeoutMs:Math.max(1,deadline-Date.now()),maximumOutputBytes:maximumBytes});
      if(result.error)throw result.error;
      if(signal.aborted){const cause=signal.reason;if(cause?.timedOut)cause.details={...cause.details,status:result.status,signal:result.signal,stderr:result.stderr.toString('utf8'),stderrSha256:result.stderrSha256};throw cause;}
      stopped();
      if(result.status!==0&&!(allowAbsent&&result.status===1&&result.stderr.byteLength===0)||result.overflow||result.timedOut){const cause=error('The pinned local Git read did not complete.','SGOS_SOURCE_CONTROL_GIT_FAILED',{
        stage,status:result.status,signal:result.signal,timedOut:result.timedOut,outputOverflow:result.overflow,timeoutMs,stderr:result.stderr.toString('utf8'),stderrSha256:result.stderrSha256});
        if(result.timedOut){cause.code='SGOS_SOURCE_CONTROL_TIMEOUT';cause.timedOut=true;cause.timeoutMs=timeoutMs;}throw cause;}
      return result;
    }
    async function original(tree,revision=baselineCommit){
      const baselineCache=caches.get(revision);if(baselineCache){if(baselineCache.tree!==tree)throw error('An exact Git baseline changed its tree identity.','SGOS_SOURCE_CONTROL_BASELINE_CHANGED');return baselineCache.entries;}
      const entries=[];for(const row of nul((await runGit(['ls-tree','-r','--long','-z',revision])).stdout)){
        const tab=row.indexOf('\t'),header=row.slice(0,tab),match=/^(\d{6}) ([a-z]+) ([a-f0-9]{40}|[a-f0-9]{64})\s+(\d+|-|BAD)$/u.exec(header);
        const relative=normalizePath(row.slice(tab+1));if(!selected(relative))continue;
        if(!match)throw error('Git returned an invalid baseline tree record.','SGOS_SOURCE_CONTROL_PROTOCOL_INVALID',{path:relative,gitAnswer:header});
        if(!['100644','100755'].includes(match[1])||match[2]!=='blob')throw error('The selected baseline contains a non-regular Git object.','SGOS_SOURCE_CONTROL_TYPE_UNSUPPORTED',{path:relative});
        if(['-','BAD'].includes(match[4]))throw error('Git could not read the exact baseline blob.','SGOS_SOURCE_CONTROL_OBJECT_UNAVAILABLE',{
          stage:'ls-tree',objectId:match[3],path:relative,gitAnswer:header});
        const bytes=Number(match[4]);if(!Number.isSafeInteger(bytes)||bytes>source.limits.maximumFileBytes||entries.length>=source.limits.maximumFiles)throw error('The selected Git baseline exceeds its file bound.','SGOS_SOURCE_CONTROL_LIMIT');
        entries.push({path:relative,object:match[3],bytes,executable:match[1]==='100755'});}
      if(entries.reduce((sum,row)=>sum+row.bytes,0)>source.limits.maximumTotalBytes)throw error('The Git baseline exceeds its byte bound.','SGOS_SOURCE_CONTROL_LIMIT');
      const observed=[];let at=0;
      while(at<entries.length){const group=[];let bytes=0;do{const row=entries[at];if(group.length&&bytes+row.bytes>16_777_216)break;group.push(row);bytes+=row.bytes;at++;}while(at<entries.length&&group.length<512);
        const raw=(await runGit(['cat-file','--batch'],{input:group.map(row=>row.object+'\n').join(''),maximumBytes:bytes+group.length*256})).stdout;let offset=0;
        for(const row of group){const end=raw.indexOf(10,offset),header=end<0?'':raw.subarray(offset,end).toString('ascii');
          if(header===row.object+' missing')throw error('The exact Git baseline blob is unavailable.','SGOS_SOURCE_CONTROL_OBJECT_MISSING',{
            objectId:row.object,path:row.path,gitAnswer:header});
          if(header!==row.object+' blob '+row.bytes||raw[end+1+row.bytes]!==10)throw error('Git returned another or truncated baseline blob.','SGOS_SOURCE_CONTROL_PROTOCOL_INVALID');
          const body=raw.subarray(end+1,end+1+row.bytes),algorithm=row.object.length===40?'sha1':'sha256';
          if(createHash(algorithm).update('blob '+row.bytes+'\0').update(body).digest('hex')!==row.object)throw error('Git baseline bytes do not match their object identity.','SGOS_SOURCE_CONTROL_OBJECT_CORRUPT');
          observed.push({path:row.path,sha256:hash(body),bytes:row.bytes,executable:row.executable});offset=end+row.bytes+2;}
        if(offset!==raw.length)throw error('Git returned extra baseline object bytes.','SGOS_SOURCE_CONTROL_PROTOCOL_INVALID');}
      observed.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);const value=freeze({tree,entries:observed});caches.set(revision,value);return value.entries;
    }
    try{
      stopped();const allowed=await untilExecutionStopped(Promise.resolve().then(()=>authorizeCapture(descriptor,subject)),signal);stopped();
      if(allowed!==true&&allowed!==descriptor.executableSha256)throw error('The selected Git capture was not authorized.','SGOS_SOURCE_CONTROL_AUTHORITY_REQUIRED');
      await assertPinnedExecutionExecutable(git,signal);stage='source-before';emit();const before=await unit.capture({signal});stopped();
      const rootAnswer=decode((await runGit(['rev-parse','--show-toplevel'])).stdout).replace(/\r?\n$/u,'');
      if(path.resolve(rootAnswer)!==physical)throw error('Git resolved another worktree for the selected source.','SGOS_SOURCE_CONTROL_ROOT_CHANGED');
      const resolved=decode((await runGit(['rev-parse','--verify',baselineCommit+'^{commit}'])).stdout).trim();
      if(resolved!==baselineCommit)throw error('Git resolved another baseline commit.','SGOS_SOURCE_CONTROL_BASELINE_CHANGED');
      const ids=decode((await runGit(['rev-parse',baselineCommit+'^{tree}','HEAD'])).stdout).trim().split(/\r?\n/u);
      if(ids.length!==2||!ids.every(objectId))throw error('Git returned incomplete object identities.','SGOS_SOURCE_CONTROL_PROTOCOL_INVALID');
      if((await runGit(['ls-files','--unmerged','-z'])).stdout.byteLength)throw error('The repository index contains unresolved merge entries.','CHANGE_SET_UNMERGED');
      if(nul((await runGit(['ls-files','-v','-z'])).stdout).some(row=>/^[a-zS]/u.test(row)))throw error('Hidden index flags prevent a complete source observation.','SGOS_SOURCE_CONTROL_HIDDEN_CHANGES');
      const caseAnswer=await runGit(['config','--bool','--get','core.ignorecase'],{allowAbsent:true}),caseInsensitivePaths=caseAnswer.status===0&&decode(caseAnswer.stdout).trim()==='true';
      const diffArgs=['diff','--raw','-z','--no-abbrev','--find-renames','--find-copies','--no-ext-diff','--no-textconv',baselineCommit,'--'],untrackedArgs=['ls-files','--others','--exclude-standard','-z'];
      const patchArgs=v2?['-c','core.quotePath=false','diff','--no-color','--no-ext-diff','--no-textconv','--unified=0','--find-renames','--src-prefix=a/','--dst-prefix=b/',originCommit,'--']:null;
      const originIds=v2?decode((await runGit(['rev-parse','--verify',originCommit+'^{commit}'])).stdout).trim():null;
      if(v2&&originIds!==originCommit)throw error('Git resolved another Story origin.','SGOS_SOURCE_CONTROL_BASELINE_CHANGED');
      const originTree=v2?decode((await runGit(['rev-parse',originCommit+'^{tree}'])).stdout).trim():null;
      const originRawArgs=v2?['diff','--raw','-z','--no-abbrev','--find-renames','--no-ext-diff','--no-textconv',originCommit,'--']:null;
      async function originPositions(){
        const patch=gitPatchCoordinates(decode((await runGit(patchArgs)).stdout)),hunks=new Map(patch.map(row=>[canonicalJson([row.oldPath,row.newPath]),row.hunks])),changes=parseRawDiff(decode((await runGit(originRawArgs)).stdout));
        return changes.filter(row=>{
          const endpoints=[row.oldPath,row.newPath].filter(Boolean),inside=endpoints.filter(selected);
          if(inside.length&&inside.length!==endpoints.length)throw error('An origin change crosses the source selection.','SGOS_SOURCE_CONTROL_BOUNDARY');return inside.length;
        }).map(row=>({oldPath:row.oldPath,newPath:row.newPath,hunks:hunks.get(canonicalJson([row.oldPath,row.newPath]))??[]}));
      }
      const originPatch=v2?await originPositions():null;
      const tracked=v2?nul((await runGit(['ls-files','-z'])).stdout).map(normalizePath).filter(selected).sort():null;
      const rawChanges=parseRawDiff(decode((await runGit(diffArgs)).stdout)),untracked=nul((await runGit(untrackedArgs)).stdout).map(normalizePath).filter(selected);
      const changes=[...rawChanges];
      for(const relative of untracked)changes.push({status:'added',similarity:null,oldPath:null,newPath:relative,oldMode:'000000',newMode:null,oldObject:null,newObject:null,untracked:true});
      const files=new Map(before.snapshot.entries.map(row=>[row.path,row])),entries=[];
      for(const row of changes){const endpoints=[row.oldPath,row.newPath].filter(Boolean),inside=endpoints.filter(selected);if(!inside.length)continue;
        if(inside.length!==endpoints.length)throw error('A Git change crosses the selected source boundary.','SGOS_SOURCE_CONTROL_BOUNDARY',{paths:endpoints});
        const file=row.newPath?files.get(row.newPath):null;if(row.newPath&&!file)throw error('A changed Git path has no matching selected regular file.','SGOS_SOURCE_CONTROL_SOURCE_CHANGED',{path:row.newPath});
        if(entries.length>=descriptor.limits.maximumChanges)throw error('Git changes exceed their declared bound.','SGOS_SOURCE_CONTROL_LIMIT');
        entries.push(withRepositoryChangeEntryIdentity({...row,...(row.untracked?{newMode:file.executable?'100755':'100644'}:{}),
          newContent:file?{kind:'regular-file',sha256:'sha256:'+file.sha256,bytes:file.bytes}:null}));}
      entries.sort(repositoryChangeEntryOrder);const baselineEntries=await original(ids[0]);
      const core={schemaVersion:1,kind:'repository-change-set',subject,base:{commit:baselineCommit,tree:ids[0]},
        target:{head:ids[1],includesIndex:true,includesWorktree:true,includesUntracked:true,caseInsensitivePaths},entries};
      stage='source-after';emit();const after=await unit.capture({signal});stopped();await assertPinnedExecutionExecutable(git,signal);
      if(before.revision!==after.revision)throw error('Source changed during its Git observation.','SGOS_SOURCE_CONTROL_SOURCE_CHANGED');
      const origin=v2?{revision:originCommit,entries:structuredClone(await original(originTree,originCommit)),patch:originPatch,trackedPaths:tracked}:null;
      const observation=sourceControlObservation({schemaVersion:v2?2:1,format:v2?SOURCE_CONTROL_OBSERVATION_FORMAT_V2:SOURCE_CONTROL_OBSERVATION_FORMAT,readerId:id,profile,subject,
        ...(v2?{origin}:{}),
        current:after,baseline:{revision:baselineCommit,entries:structuredClone(baselineEntries)},control:{...core,digest:repositoryChangeSetDigest(core)}},descriptor,subject);
      const finalIds=decode((await runGit(['rev-parse',baselineCommit+'^{tree}','HEAD'])).stdout).trim().split(/\r?\n/u);
      if(!same(finalIds,ids))throw error('Git object bindings changed during source observation.','SGOS_SOURCE_CONTROL_SOURCE_CHANGED');
      if(v2&&(!same(await originPositions(),originPatch)
        ||!same(nul((await runGit(['ls-files','-z'])).stdout).map(normalizePath).filter(selected).sort(),tracked)
        ||decode((await runGit(['rev-parse',originCommit+'^{tree}'])).stdout).trim()!==originTree))throw error('Story line origins changed during capture.','SGOS_SOURCE_CONTROL_SOURCE_CHANGED');
      const selectedRows=rows=>rows.filter(row=>[row.oldPath,row.newPath].filter(Boolean).some(selected));
      if(!same(selectedRows(parseRawDiff(decode((await runGit(diffArgs)).stdout))),selectedRows(rawChanges))
        ||!same(nul((await runGit(untrackedArgs)).stdout).map(normalizePath).filter(selected),untracked))throw error('Git tracking changed during source observation.','SGOS_SOURCE_CONTROL_SOURCE_CHANGED');
      if((await runGit(['ls-files','--unmerged','-z'])).stdout.byteLength)throw error('The repository index became unmerged during observation.','CHANGE_SET_UNMERGED');
      if(nul((await runGit(['ls-files','-v','-z'])).stdout).some(row=>/^[a-zS]/u.test(row)))throw error('Index flags changed during source observation.','SGOS_SOURCE_CONTROL_HIDDEN_CHANGES');
      const finalCase=await runGit(['config','--bool','--get','core.ignorecase'],{allowAbsent:true});
      if((finalCase.status===0&&decode(finalCase.stdout).trim()==='true')!==caseInsensitivePaths)throw error('Git path comparison changed during observation.','SGOS_SOURCE_CONTROL_SOURCE_CHANGED');
      if(v2&&(await unit.capture({signal})).revision!==after.revision)throw error('Source bytes changed after observing their origin positions.','SGOS_SOURCE_CONTROL_SOURCE_CHANGED');
      stopped();return {observation,revision:'sha256:'+hash(canonicalJson(observation)),metrics:{gitCalls,baselineCacheReused,elapsedMs:Date.now()-started}};
    }catch(cause){
      if(signal.aborted&&['SGOS_SOURCE_CANCELLED','SGOS_SOURCE_TIMEOUT','ABORT_ERR'].includes(cause?.code))throw signal.reason;
      throw cause;
    }finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',abort);}
  }});
}
