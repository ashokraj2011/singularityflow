/** Read-only syntax observations from original accepted source bytes; no checkout, cache or process. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {commandCovering,isExecutableTestSourceCandidate} from '../engine-compatibility/node-source-policy.mjs';
import {profileForCommand,testAdapterProfile} from '../engine-compatibility/node-specification-policy.mjs';
import {scanJavaScriptDeclarations,scanSourceClauseTags} from '../engine-compatibility/node-source-analysis.mjs';
import {verifySourceFileChunks} from './namespace-source-content-reader.mjs';
import {SOURCE_ANALYSIS_PROFILE} from '../kernel/source-changes.mjs';
const maximumSourceBytes=16*1024*1024;
const cancelled=signal=>{if(signal?.aborted)throw new SingularityFlowError('Source analysis was cancelled.',{code:'ENGINE_OPERATION_CANCELLED'});};
const error=message=>new SingularityFlowError(message,{code:'ENGINE_INPUT_INVALID'});
const diagnostics=file=>[...file.diagnostics,...(file.tests?[...file.tests.result.fileGaps,...file.tests.result.unattachedTags,
  ...file.tests.result.declarations.flatMap(declaration=>declaration.gaps.map(gap=>({...gap,line:gap.line??declaration.line})))]:[])];
export function createNamespaceSourceAnalysisReader({observer,retention}) {
  async function analyze(found,{signal}={}) {
    cancelled(signal);
    if(!retention.isAccepted(found))throw error('Analyze the original accepted source-retention proof from this reader.');
    const phase=found.workflow.phases[found.plan.input.phaseId],commands=phase.qualityCommands??[],sourceExtensions=[...new Set(commands.flatMap(command=>command.result?.sourceExtensions??[]))],files=[];
    const totals={files:0,tags:0,declarations:0,gaps:0};
    for(const [index,source] of found.plan.sources.entries()) {
      cancelled(signal);
      const {value}=await retention.verifyRepository(found,source,found.body.repositories[index].manifest,signal);
      for(const entry of value.entries) {
        cancelled(signal);const path=entry.newPath??entry.oldPath,file={repositoryId:source.repository.id,path,change:entry.status,role:entry.role,
          source:entry.after,kind:entry.after?'text':'removed',tags:[],tests:null,diagnostics:[]};
        if(entry.after?.bytes>=maximumSourceBytes){file.kind='too-large';file.diagnostics.push({code:'CODE_DELIVERY_SOURCE_BINDING_TOO_LARGE',
          message:'The retained member exceeds the bounded source-analysis limit.',line:null});}
        else if(entry.after) {
          const chunks=[];
          await verifySourceFileChunks(entry.after,entry.chunks,{signal,maximumChunkBytes:source.reader?.maximumChunkBytes,
            read:async(...args)=>{cancelled(signal);const data=await observer.bytes(...args);chunks.push(data);return data;}});
          const bytes=Buffer.concat(chunks);let text=null;
          try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(text.includes('\0'))text=null;}catch{}
          if(text===null)file.kind='binary';
          else {
            file.tags=scanSourceClauseTags(text,{sourcePath:path});
            if(isExecutableTestSourceCandidate(path,{sourceExtensions})) {
              const command=commandCovering(commands.filter(command=>command.kind==='test'),path),profile=profileForCommand(command),selected=testAdapterProfile(profile);
              if(selected.language==='javascript')file.tests={profile,framework:selected.framework,result:scanJavaScriptDeclarations(text,{sourcePath:path,framework:selected.framework})};
              else file.diagnostics.push({code:'SOURCE_ANALYSIS_ADAPTER_REQUIRED',message:'The pinned declaration profile requires its language-specific analysis owner.',line:null});
            }
          }
        }
        totals.files++;totals.tags+=file.tags.length;totals.declarations+=file.tests?.result.declarations.length??0;totals.gaps+=diagnostics(file).length;files.push(file);
      }
    }
    cancelled(signal);if(!retention.isAccepted(found))throw error('The source proof changed during its analysis.');
    return {profile:SOURCE_ANALYSIS_PROFILE,retention:found.binding,totals,files};
  }
  function preview(analysis,{maximumEntries=200,maximumBytes=65536}={}) {
    if(analysis.profile!==SOURCE_ANALYSIS_PROFILE)throw error('Use the matching retained-source analysis profile.');
    const files=[];let bytes=0,truncated=false;
    for(const file of analysis.files) {
      const gaps=diagnostics(file),declarations=file.tests?.result.declarations??[],row={repositoryId:file.repositoryId,path:file.path,
        change:file.change,role:file.role,source:file.source,kind:file.kind,counts:{tags:file.tags.length,declarations:declarations.length,gaps:gaps.length},
        tags:file.tags.slice(0,100),declarations:declarations.slice(0,100).map(value=>({logicalTestId:value.logicalTestId,declarationSha256:value.declarationSha256,
          line:value.line,clauseIds:value.clauseIds,skipped:value.skipped,focused:value.focused})),
        gaps:gaps.slice(0,100).map(value=>({code:value.code,line:value.line??null,messagePreview:value.message.slice(0,512)})),
        truncated:file.tags.length>100||declarations.length>100||gaps.length>100};
      const size=Buffer.byteLength(canonicalJson(row));
      if(files.length<maximumEntries&&bytes+size<=maximumBytes){files.push(row);bytes+=size;truncated||=row.truncated;}else truncated=true;
    }
    return {profile:analysis.profile,retentionRecord:analysis.retention.result.content,totals:analysis.totals,files,truncated};
  }
  return Object.freeze({analyze,preview});
}
