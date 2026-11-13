/** Reviewed namespace source boundaries. No source discovery, persistence, prompting or human votes. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,textDigestCapability,namespaceSourceOpeningContextProfile} from '../foundation/record-schema.mjs';
import {sourceSnapshot} from '../foundation/source-snapshot.mjs';
import {sourceSnapshotChanges} from './source-changes.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),fail=(message,code,details)=>{throw new SingularityFlowError(message,{code,details});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const reference=(value,namespace)=>exact(value,['namespace','sha256','bytes'])&&value.namespace===namespace&&/^[a-f0-9]{64}$/u.test(value.sha256)
  &&Number.isSafeInteger(value.bytes)&&value.bytes>=0;
const digest=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/u.test(value);
export function namespaceSourceOpeningPolicies(port){
  const digests=textDigestCapability(port),hash=value=>'sha256:'+digests.sha256Utf8(canonicalJson(value));
  function restore(before,changes,descriptor){
    sourceSnapshot(before,descriptor);const files=new Map(before.entries.map(row=>[row.path,row]));
    for(const row of changes.entries){
      if(row.oldPath){const old=files.get(row.oldPath),expected=old?{sha256:old.sha256,bytes:old.bytes,executable:old.executable}:null;
        if(!same(expected,row.before))fail('The reviewed source delta changed its original file.','ENGINE_STORAGE_CORRUPT');files.delete(row.oldPath);}
      if(row.newPath){if(files.has(row.newPath)||!row.after)fail('The reviewed source delta has a conflicting destination.','ENGINE_STORAGE_CORRUPT');
        files.set(row.newPath,{path:row.newPath,...row.after});}
    }
    const after={...before,entries:[...files.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
    sourceSnapshot(after,descriptor);if(!same(sourceSnapshotChanges(before,after,descriptor),changes))fail('The source delta is not its exact canonical comparison.','ENGINE_STORAGE_CORRUPT');return after;
  }
  function restored(before,changes,descriptor){try{return restore(before,changes,descriptor);}catch(cause){
    if(cause.code==='ENGINE_STORAGE_CORRUPT')throw cause;
    throw new SingularityFlowError('The archived source-opening delta is malformed.',{code:'ENGINE_STORAGE_CORRUPT',cause});
  }}
  function summary(context){
    const changed=context.repositories.flatMap(row=>row.classification.entries
      .map(row2=>({repositoryId:row.repository.id,...row2}))),
      shown=changed.slice(0,200),blocked=context.repositories.flatMap(row=>row.classification.entries.filter(item=>item.protected||!item.sourceBoundaryAllowed).map(item=>({repositoryId:row.repository.id,...item})));
    return {profile:'sflow-namespace-source-opening-preview/v1',kind:context.kind,sourceBindingId:context.sourceBinding.operationId,
      previousPublication:context.predecessor?.publication??null,draft:context.previousDraft,artifact:context.artifact,
      repositories:context.repositories.map(row=>({id:row.repository.id,baselineRevision:row.baseline.revision,observedRevision:row.observedRevision,
        totals:row.classification.totals,snapshotTotals:row.changes.totals,roles:row.classification.roles})),changedPaths:shown,changedPathCount:changed.length,
      truncated:shown.length<changed.length,violations:blocked.slice(0,200),violationCount:blocked.length,dirtyStartPolicy:context.dirtyStartPolicy};
  }
  function plan(context,{retained=false}={}){
    const sha=hash(context),review=summary(context);
    return {profile:'sflow-namespace-reviewed-rollover/v1',workId:context.workId,phase:context.phase,
      fromGeneration:context.fromGeneration,toGeneration:context.generation,confirmation:sha,
      changeSetDigest:review.changedPathCount?sha:null,currentResultDigest:sha,retained,review};
  }
  function admit(context,{adoptExisting=false,confirm=null,rollover=false}={}){
    const preview=plan(context),details={...preview,actions:[]};
    if(preview.review.violationCount)fail('Preserve the draft and restore protected or out-of-boundary source before opening this generation.','GENERATION_DIRTY_START',details);
    const initial=context.predecessor===null,dirty=preview.review.changedPathCount>0;
    if(initial&&(dirty||adoptExisting)&&context.dirtyStartPolicy!=='allow-explicit-adoption')fail(
      'The pinned Story policy blocks source changes made before its first generation. Preserve the changes, restore the bound source, then begin before applying them.','GENERATION_DIRTY_START',details);
    const needsConfirmation=rollover||adoptExisting||dirty;
    if(!rollover&&dirty&&!adoptExisting||needsConfirmation&&confirm!==preview.confirmation){
      details.actions.push({operation:initial?'phase.begin':'phase.rollover',inputs:{workId:context.workId,phaseId:context.phase,
        ...(initial?{adoptExisting:true}:{}),confirm:preview.confirmation},prerequisites:['review-exact-source-and-artifact-digests']});
      fail('Review and confirm the exact source and artifact boundary before adopting these changes.',rollover?'GENERATION_ROLLOVER_STALE':'GENERATION_DIRTY_START',details);
    }
    return {profile:'sflow-namespace-reviewed-source-opening/v1',context,confirmation:needsConfirmation?preview.confirmation:null};
  }
  function assert(value){
    try{namespaceSourceOpeningContextProfile(value?.context);}catch(cause){throw new SingularityFlowError('The reviewed source-opening context is unsupported or corrupt.',{
      code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause});}
    const c=value.context;
    if(!exact(value,['profile','context','confirmation'])||!exact(c,['schemaVersion','profile','kind','workId','phase','generation','fromGeneration','basis','sourceBinding','predecessor',
      'repair','priorCode','previousDraft','artifact','repositories','dirtyStartPolicy'])||!exact(c.basis,['head','revision','configuration'])
      ||!c.basis.head||typeof c.basis.head!=='object'||Array.isArray(c.basis.head)||typeof c.basis.head.operationId!=='string'||!c.basis.head.operationId
      ||typeof c.basis.revision!=='string'||!c.basis.revision
      ||!Array.isArray(c.repositories)||!c.repositories.length||c.repositories.length>32
      ||c.repositories.some(row=>!exact(row,['repository','baseline','observedRevision','changes','classification'])||!exact(row.baseline,['content','revision'])
        ||!['evidence','runtime'].some(namespace=>reference(row.baseline.content,namespace))||!digest(row.baseline.revision)||!digest(row.observedRevision)
        ||!Array.isArray(row.changes?.entries)||!Array.isArray(row.classification?.entries))
      ||value.profile!=='sflow-namespace-reviewed-source-opening/v1'||c.profile!=='sflow-namespace-source-opening-context/v1'
      ||!['initial','successor','returned-successor'].includes(c.kind)||typeof c.workId!=='string'||!c.workId||typeof c.phase!=='string'||!c.phase
      ||!Number.isSafeInteger(c.generation)||c.generation<1||!Number.isSafeInteger(c.fromGeneration)||c.fromGeneration<0||c.generation<=c.fromGeneration
      ||(c.kind==='initial')!==(c.predecessor===null)||!['block','allow-explicit-adoption'].includes(c.dirtyStartPolicy)
      ||c.previousDraft!==null&&(!exact(c.previousDraft,['revision','reference'])||typeof c.previousDraft.revision!=='string'||!c.previousDraft.revision||!reference(c.previousDraft.reference,'local'))
      ||c.artifact!==null&&(!exact(c.artifact,['key','content'])||typeof c.artifact.key!=='string'||!c.artifact.key
        ||!['local','evidence'].some(namespace=>reference(c.artifact.content,namespace))))fail('The reviewed opening has another contract.','ENGINE_STORAGE_CORRUPT');
    let actual;try{actual=admit(value.context,{adoptExisting:value.confirmation!==null,confirm:value.confirmation,rollover:false});}
    catch(cause){throw new SingularityFlowError('The retained source opening has no valid original confirmation.',{code:'ENGINE_STORAGE_CORRUPT',cause});}
    if(!same(actual,value))fail('The reviewed opening changed its exact confirmation.','ENGINE_STORAGE_CORRUPT');return value;
  }
  return Object.freeze({hash,restored,summary,plan,admit,assert});
}
