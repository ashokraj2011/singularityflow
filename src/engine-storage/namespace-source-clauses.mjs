/** Replay source-clause rules over original approved plans and actual retained bytes. Read only. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {plannedSourceClauseBindingsReplay,deliveryPathCohorts} from '../engine-compatibility/node-source-policy.mjs';
import {scanSourceClauseTags} from '../engine-compatibility/node-source-analysis.mjs';
import {PLANNED_SOURCE_CLAUSES_PROFILE} from '../kernel/source-changes.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {verifySourceFileChunks} from './namespace-source-content-reader.mjs';
const maximumSourceBytes=16*1024*1024,same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const cancelled=signal=>{if(signal?.aborted)throw new SingularityFlowError('Source-clause inspection was cancelled.',{code:'ENGINE_OPERATION_CANCELLED'});};
const policyEnabled=(workflow,phase)=>workflow.resolution?.codeDelivery?.traceability?.sourceBindings==='enforce'
  &&phase.sourceBoundary!=='test-automation'&&workflow.resolution?.plannedClaims?.mode==='required';
const nativeEntries=value=>value.entries.map(entry=>({status:entry.status==='D'?'deleted':entry.status==='A'?'added':'modified',oldPath:entry.oldPath,newPath:entry.newPath,
  newContent:entry.after?{kind:'regular-file'}:null,newMode:entry.after?(entry.after.executable?'100755':'100644'):'000000'}));
export function createNamespaceSourceClauseReader({observer,scope,workId,retention,baseline,checks=null,controlReader=null}) {
  const specifications=createNamespaceSpecificationReader({observer,scope,workId,checks});
  async function inspect(snapshot,phaseId,found,original,{signal,control=null}={}) {
    cancelled(signal);const workflow=snapshot.workflow,phase=workflow.phases[phaseId],
      result={profile:PLANNED_SOURCE_CLAUSES_PROFILE,status:'off',plan:null,retentionRecord:null,repositories:[],requiredPolicyOwners:[]};
    if(!policyEnabled(workflow,phase))return result;
    const plan=await specifications.sourcePlan(snapshot,phaseId,{signal});result.plan=plan.proof;
    if(!found){result.status='missing-source-evidence';return result;}
    if(!retention.isAccepted(found)||!same(found.plan.basis.configuration,snapshot.configuration)||found.plan.basis.headVersion!==snapshot.revision) {
      throw new SingularityFlowError('Use the original accepted source evidence for this Story and configuration.',{code:'ENGINE_INPUT_INVALID'});
    }
    result.retentionRecord=found.record.content;
    if(control&&(!controlReader?.isAccepted(control)||!same(control.plan.source,found.binding)))throw new SingularityFlowError(
      'Use this draft\'s original accepted control evidence.',{code:'ENGINE_INPUT_INVALID'});
    // Legacy plans name paths within one repository. Never spread an unqualified claim across repositories.
    if(found.plan.sources.length!==1) {
      result.status='pending-owner';result.requiredPolicyOwners=['repository-qualified-claims'];return result;
    }
    result.status='observed';
    for(const [position,source]of found.plan.sources.entries()) {
      cancelled(signal);const {value}=await retention.verifyRepository(found,source,found.body.repositories[position].manifest,signal),
        current=await retention.snapshot(source.observed.content,source.repository.descriptor,source.observed.revision,signal),
        members=new Map(current.entries.map(entry=>[entry.path,entry])),changed=new Map(value.entries.filter(entry=>entry.after).map(entry=>[entry.newPath,entry])),
        cohort=deliveryPathCohorts(nativeEntries(value)),sourcePaths=cohort.changedSourcePaths,deletedSourcePaths=value.entries.filter(entry=>entry.status==='D').map(entry=>entry.oldPath),
        buffers=new Map(),pending=Object.freeze({}),row={id:source.repository.id,status:'observed',value:null,requiredPolicyOwners:[]};
      let originalMembers=null,originalSource=null,cachedBytes=0,origins=null;
      async function originFacts(){
        const proof=control?.plan.origins?.find(row=>row.id===source.repository.id);if(!proof)requires('source-tag-origin');
        if(!origins){
          const index=control.plan.observations.findIndex(row=>row.id===source.repository.id),row=control.plan.observations[index],
            verified=await controlReader.readObservation({...row,content:control.body.repositories[index].observation},control.source,signal,proof);
          origins=await controlReader.origins.replayFacts(proof,control.source,verified.value,source.repository.id,signal);
        }return origins;
      }
      async function bytes(entry,chunks,maximumChunkBytes) {
        const buffers=[];await verifySourceFileChunks(entry,chunks,{maximumChunkBytes,signal,
          read:async(...args)=>{cancelled(signal);const bytes=await observer.bytes(...args);buffers.push(bytes);return bytes;}});
        return Buffer.concat(buffers);
      }
      const requires=owner=>{row.requiredPolicyOwners=[owner];throw pending;};
      async function read(path) {
        if(buffers.has(path))return buffers.get(path);
        const edited=changed.get(path);let data;
        if(edited)data=await bytes(edited.after,edited.chunks,source.reader?.maximumChunkBytes);
        else {
          if(!original)requires('source-baseline-bytes');
          if(originalMembers===null) {
            const index=original.plan.sources.findIndex(item=>item.repository.id===source.repository.id);originalSource=original.plan.sources[index];
            if(!originalSource||!same(originalSource.repository,source.repository))throw new SingularityFlowError(
              'The original archive belongs to another repository selection.',{code:'ENGINE_STORAGE_CORRUPT'});
            const {body}=await baseline.verifyRepository(original,originalSource,original.body.repositories[index].manifest,signal);
            originalMembers=new Map(body.entries.map(entry=>[entry.path,entry]));
          }
          const earlier=originalMembers.get(path),current=members.get(path);
          if(!earlier||!current||['sha256','bytes','executable'].some(key=>earlier[key]!==current[key]))throw new SingularityFlowError(
            'The unchanged planned file has no matching retained original bytes.',{code:'ENGINE_STORAGE_CORRUPT',details:{path}});
          data=await bytes(earlier,earlier.chunks,originalSource.reader?.maximumChunkBytes);
        }
        // One invocation may inspect a large repository; retain at most one source limit in memory.
        while(cachedBytes+data.length>maximumSourceBytes&&buffers.size) {
          const [key,previous]=buffers.entries().next().value;buffers.delete(key);cachedBytes-=previous.length;
        }
        if(data.length<=maximumSourceBytes){buffers.set(path,data);cachedBytes+=data.length;}return data;
      }
      const run=plannedSourceClauseBindingsReplay({},workflow,phase,sourcePaths,{deletedSourcePaths});
      try {
        let step=run.next();while(!step.done) {
          cancelled(signal);const request=step.value;let reply;
          switch(request.kind) {
            case 'source-binding-records':reply=plan.active;break;
            case 'source-binding-plan':reply=plan.planned;break;
            case 'source-binding-path':{const member=members.get(request.path);reply={exists:Boolean(member),regular:Boolean(member),size:member?.bytes??0};break;}
            case 'source-binding-bytes':reply=await read(request.path);break;
            case 'source-binding-tags':reply=scanSourceClauseTags(request.source,{sourcePath:request.path});break;
            case 'carried-source-tags':reply=await (await originFacts()).carried(request.occurrences);break;
            case 'story-added-source-tags':reply=await (await originFacts()).added(request.occurrences,request.pathContext);break;
            case 'source-binding-unchanged-tags':{
              reply=[];for(const path of request.entry.expectedPaths.filter(path=>!request.available.includes(path))) {
                const member=members.get(path);if(!member||member.bytes>=maximumSourceBytes)continue;
                reply.push(...scanSourceClauseTags((await read(path)).toString('utf8'),{sourcePath:path})
                  .filter(tag=>tag.tag==='clause'&&tag.clauseId===request.entry.clauseId).map(tag=>({path,line:tag.line})));
              }break;
            }
            default:throw new SingularityFlowError('The source-clause rule needs its named fact owner.',{code:'ENGINE_PORT_UNAVAILABLE',details:{required:[request.kind]}});
          }
          step=run.next(reply);
        }
        row.value=step.value;
      }catch(error){if(error!==pending)throw error;row.status='pending-owner';result.status='pending-owner';
        result.requiredPolicyOwners.push(...row.requiredPolicyOwners);}
      result.repositories.push(row);
    }
    cancelled(signal);if(!retention.isAccepted(found)||control&&!controlReader.isAccepted(control))throw new SingularityFlowError('The source proof changed during clause inspection.',{code:'ENGINE_INPUT_INVALID'});
    result.requiredPolicyOwners=[...new Set(result.requiredPolicyOwners)];return result;
  }
  function preview(value,{maximumEntries=200,maximumBytes=65536}={}) {
    let shown=0,bytes=0;
    return {...value,repositories:value.repositories.map(row=>{
      const required=row.value?.required??[],bindings=row.value?.bindings??[],missing=row.value?.missing??[],obligations=[];
      for(const item of required) {
        const absent=missing.find(entry=>entry.clauseId===item.clauseId),record={...item,bindings:bindings.filter(binding=>binding.clauseId===item.clauseId)
          .map(({sourcePath,line,tag})=>({path:sourcePath,line,tag})),missing:Boolean(absent),unchangedTags:absent?.unchangedTags??[],otherStoryTags:absent?.otherStoryTags??[]},
          size=Buffer.byteLength(canonicalJson(record));
        if(shown<maximumEntries&&bytes+size<=maximumBytes){obligations.push(record);shown++;bytes+=size;}
      }
      return {id:row.id,status:row.status,totals:row.status==='observed'?{required:required.length,bindings:bindings.length,missing:missing.length}:null,
        obligations,truncated:obligations.length<required.length,requiredPolicyOwners:row.requiredPolicyOwners};
    })};
  }
  return Object.freeze({inspect,preview});
}
