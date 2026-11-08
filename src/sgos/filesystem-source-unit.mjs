/** Read-only filesystem source observations. No Git, models, configuration discovery or writes. */
import { constants } from 'node:fs';
import { lstat,readdir,realpath,open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { canonicalJson,SOURCE_SNAPSHOT_SCHEMA } from '../foundation/record-schema.mjs';
import { SOURCE_UNIT_CONTRACT,SOURCE_SNAPSHOT_FORMAT,SOURCE_LIMITS,sourceRelativePath,sourceUnitDescriptor,sourceSnapshot } from '../foundation/source-snapshot.mjs';

const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
const fingerprint=stat=>[stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(':');
const compare=(a,b)=>a<b?-1:a>b?1:0;
function cancelled(signal){if(signal?.aborted)throw signal.reason?.code==='SGOS_SOURCE_TIMEOUT'?signal.reason:error('Source capture was cancelled.','SGOS_SOURCE_CANCELLED');}
async function withinDeadline(work,signal,duration,progress) {
  const controller=new AbortController();let timer,rejectStop;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});
  const stop=reason=>{if(controller.signal.aborted)return;controller.abort(reason);rejectStop(reason);};
  const abort=()=>stop(error('Source capture was cancelled.','SGOS_SOURCE_CANCELLED'));
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>{const failure=error('Source observation exceeded its deadline; the local I/O cause is not established.','SGOS_SOURCE_TIMEOUT',{
    ...progress,timeoutMs:duration});failure.timedOut=true;failure.timeoutMs=duration;stop(failure);},duration);
  try {return await Promise.race([Promise.resolve().then(()=>{cancelled(controller.signal);return work(controller.signal);}),stopped]);}
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

/** The application supplies a physical checkout; no default root or source location is inferred. */
export async function createFilesystemSourceUnit({root,id,projectId,repositoryId,excludePaths=[],limits={}}={}) {
  if(typeof root!=='string'||!path.isAbsolute(root))throw error('Source capture needs an explicit absolute root.','SGOS_SOURCE_INPUT_INVALID');
  if(!Array.isArray(excludePaths)||!limits||typeof limits!=='object'||Array.isArray(limits))throw error('Source selection and limits must be explicit bounded data.','SGOS_SOURCE_INPUT_INVALID');
  const exclusions=[...new Set(['.git','.singularity-flow',...excludePaths.map(sourceRelativePath)])].sort(compare);
  const descriptor=sourceUnitDescriptor({contract:SOURCE_UNIT_CONTRACT,id,projectId,repositoryId,provider:'filesystem',
    selection:{excludePaths:exclusions},limits:{...SOURCE_LIMITS,...limits}});
  Object.freeze(descriptor.selection.excludePaths);Object.freeze(descriptor.selection);Object.freeze(descriptor.limits);Object.freeze(descriptor);
  const {physical,rootStat}=await withinDeadline(async signal=>{
    const physical=await realpath(root);cancelled(signal);const rootStat=await lstat(physical,{bigint:true});cancelled(signal);
    if(!rootStat.isDirectory())throw error('The source root must be a directory.','SGOS_SOURCE_INPUT_INVALID');
    return {physical,rootStat};
  },null,descriptor.limits.maximumDurationMs,{unitId:id,repositoryId,stage:'bind-root',relativePath:null});
  const selected=relative=>!exclusions.some(exclude=>relative===exclude||relative.startsWith(exclude+'/'));
  async function scan(signal,progress) {
    progress.stage='scan';progress.relativePath='';
    cancelled(signal);const current=await lstat(physical,{bigint:true});
    if(!current.isDirectory()||current.dev!==rootStat.dev||current.ino!==rootStat.ino)throw error('The bound source directory was replaced.','SGOS_SOURCE_CHANGED');
    const observations=[],files=[];
    async function visit(relative) {
      cancelled(signal);const absolute=relative?path.join(physical,...relative.split('/')):physical;
      progress.relativePath=relative;
      const stat=await lstat(absolute,{bigint:true});
      if(stat.isSymbolicLink())throw error('Source capture cannot follow symbolic links.','SGOS_SOURCE_LINK_DENIED',{path:relative});
      if(await realpath(absolute)!==absolute)throw error('Source capture cannot follow symbolic links.','SGOS_SOURCE_LINK_DENIED',{path:relative});
      if(observations.length>=descriptor.limits.maximumVisitedEntries)throw error('The source traversal exceeds its entry bound.','SGOS_SOURCE_LIMIT');
      observations.push([relative,fingerprint(stat)]);
      if(stat.isDirectory()) {
        for(const name of (await readdir(absolute)).sort(compare)) {
          const child=relative?relative+'/'+name:name;if(selected(child)){sourceRelativePath(child);await visit(child);}
        }
      }else if(stat.isFile()) {
        if(files.length>=descriptor.limits.maximumFiles||stat.size>BigInt(descriptor.limits.maximumFileBytes))throw error('The selected source exceeds its file bound.','SGOS_SOURCE_LIMIT',{path:relative});
        files.push({relative,absolute,stat});
      }else throw error('Source capture supports ordinary files and directories only.','SGOS_SOURCE_TYPE_UNSUPPORTED',{path:relative});
    }
    await visit('');return {observations,files};
  }
  return Object.freeze({descriptor:Object.freeze(descriptor),async capture({signal:requestedSignal}={}) {
    const progress={unitId:id,repositoryId,stage:'scan',relativePath:''};
    return withinDeadline(async signal=>{
    const before=await scan(signal,progress),entries=[],chunk=Buffer.alloc(65536);let total=0;
    for(const file of before.files.sort((a,b)=>compare(a.relative,b.relative))) {
      cancelled(signal);total+=Number(file.stat.size);
      progress.stage='read';progress.relativePath=file.relative;
      if(total>descriptor.limits.maximumTotalBytes)throw error('The selected source exceeds its total byte bound.','SGOS_SOURCE_LIMIT');
      const handle=await open(file.absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
      try {
        const initial=await handle.stat({bigint:true});
        if(!initial.isFile()||fingerprint(initial)!==fingerprint(file.stat))throw error('A source member changed before it could be read.','SGOS_SOURCE_CHANGED',{path:file.relative});
        const hash=createHash('sha256');let offset=0;
        for(;;) {
          cancelled(signal);const result=await handle.read(chunk,0,chunk.length,offset);if(!result.bytesRead)break;
          offset+=result.bytesRead;if(offset>descriptor.limits.maximumFileBytes||offset>Number(initial.size))throw error('A source member grew during capture.','SGOS_SOURCE_CHANGED',{path:file.relative});
          hash.update(chunk.subarray(0,result.bytesRead));
        }
        if(offset!==Number(initial.size)||fingerprint(await handle.stat({bigint:true}))!==fingerprint(initial)
          ||await realpath(file.absolute)!==file.absolute)throw error('A source member changed during capture.','SGOS_SOURCE_CHANGED',{path:file.relative});
        entries.push({path:file.relative,sha256:hash.digest('hex'),bytes:offset,executable:Boolean(initial.mode&0o111n)});
      }finally{await handle.close();}
    }
    const after=await scan(signal,progress);
    if(canonicalJson(before.observations)!==canonicalJson(after.observations))throw error('The source tree changed during capture.','SGOS_SOURCE_CHANGED');
    const snapshot=sourceSnapshot({schemaVersion:SOURCE_SNAPSHOT_SCHEMA.currentVersion,format:SOURCE_SNAPSHOT_FORMAT,unitId:id,
      projectId,repositoryId,provider:'filesystem',selection:descriptor.selection,entries},descriptor);
    const data=Buffer.from(canonicalJson(snapshot));
    if(data.byteLength>descriptor.limits.maximumManifestBytes)throw error('The source manifest exceeds its byte bound.','SGOS_SOURCE_LIMIT');
    cancelled(signal);return {snapshot,revision:'sha256:'+createHash('sha256').update(data).digest('hex')};
    },requestedSignal,descriptor.limits.maximumDurationMs,progress);
  }});
}
