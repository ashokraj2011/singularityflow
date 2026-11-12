/** Typed output bundles over exact content identities. No discovery, bytes, writes or presentation. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,textDigestCapability} from '../foundation/record-schema.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {artifactSetPolicies,configurationPathSyntaxV2} from './configuration-path-policies.mjs';
const fail=(message,code='PHASE_ARTIFACT_SET_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export const NAMESPACE_ARTIFACT_SET_LIMITS=Object.freeze({files:1024,fileBytes:16*1024*1024,totalBytes:64*1024*1024});
/** A body-free device-local inventory; content existence is checked when a member is read. */
export function phaseArtifactInspectionManifest(workId,phase,facts,maximumEntries=256){
  const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),
    digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value),text=value=>typeof value==='string'&&value.length>0,
    bad=()=>fail('The artifact inspector returned another or malformed bundle.','ENGINE_PORT_RESULT_INVALID');
  if(!Number.isSafeInteger(maximumEntries)||maximumEntries<0||maximumEntries>NAMESPACE_ARTIFACT_SET_LIMITS.files
    ||!exact(facts,['workId','phase','revision','status','draft','set','members'])||facts.workId!==workId||facts.phase!==phase||!text(facts.revision)
    ||!['missing-draft','stale-draft','not-declared','observed'].includes(facts.status)||!Array.isArray(facts.members)||facts.members.length>NAMESPACE_ARTIFACT_SET_LIMITS.files)bad();
  if(facts.draft!==null&&(!exact(facts.draft,['generation','revision','bodySha256'])||!Number.isSafeInteger(facts.draft.generation)||facts.draft.generation<1
    ||!text(facts.draft.revision)||!digest(facts.draft.bodySha256)))bad();
  if(facts.set!==null){if(!exact(facts.set,['id','primary','members'])||!text(facts.set.id)||!text(facts.set.primary)||!Array.isArray(facts.set.members)
      ||!facts.set.members.length||facts.set.members.length>NAMESPACE_ARTIFACT_SET_LIMITS.files)bad();
    const paths=new Set();
    for(const row of facts.set.members){if(!exact(row,['path','role','required','authority'])||!text(row.path)||!text(row.role)||typeof row.required!=='boolean'
        ||!['governed','advisory'].includes(row.authority)||row.authority==='advisory'&&row.required||paths.has(row.path))bad();
      try{sourceRelativePath(row.path.replace(/\/$/u,''));}catch{bad();}paths.add(row.path);}
    if(!paths.has(facts.set.primary))bad();}
  if((facts.status==='missing-draft')!==(facts.draft===null)||facts.status==='not-declared'&&facts.set!==null||facts.status==='observed'&&facts.set===null)bad();
  let bytes=0;const paths=new Set();
  for(const row of facts.members){
    if(!exact(row,['path','reference','generation','recordedAt','principalId'])||!exact(row.reference,['namespace','sha256','bytes'])||row.reference.namespace!=='local'
      ||!digest(row.reference.sha256)||!Number.isSafeInteger(row.reference.bytes)||row.reference.bytes<0||row.reference.bytes>NAMESPACE_ARTIFACT_SET_LIMITS.fileBytes
      ||!facts.draft||row.generation!==facts.draft.generation||!text(row.principalId)||!text(row.recordedAt)||!Number.isFinite(Date.parse(row.recordedAt)))bad();
    try{sourceRelativePath(row.path);}catch{bad();}if(paths.has(row.path))bad();paths.add(row.path);bytes+=row.reference.bytes;
  }
  if(bytes>NAMESPACE_ARTIFACT_SET_LIMITS.totalBytes)bad();
  return {schemaVersion:1,contract:'sflow-phase-artifact-inventory/v1',...facts,members:facts.members.slice(0,maximumEntries),
    totals:{files:facts.members.length,bytes},truncated:facts.members.length>maximumEntries,publicationRecorded:false,acceptanceRecorded:false};
}
export function namespaceArtifactSetPolicies(pathSyntax,digests){
  const {path}=configurationPathSyntaxV2(pathSyntax),{normalizeArtifactSet,artifactSetDiffValues}=artifactSetPolicies(pathSyntax),{sha256Utf8}=textDigestCapability(digests),
    hash=value=>sha256Utf8(canonicalJson(value));
  function declaration(definition,workflow,phase){
    const pinned=workflow.resolution?.phases?.find(row=>row.id===phase.id),id=pinned?.artifactSet??phase.artifactSet??definition.phases?.[phase.id]?.artifactSet;
    if(!id)return null;
    const value=(workflow.resolution?.artifactSets??definition.artifactSets??{})[id];
    if(!value)fail('The pinned artifact set is missing.','WFA_DEPENDENCY_UNAVAILABLE',{id});
    const set=normalizeArtifactSet(value,id),primary=sourceRelativePath(set.primary),root=path.posix.dirname(sourceRelativePath(phase.requiredArtifact.path));
    if(set.members.length>NAMESPACE_ARTIFACT_SET_LIMITS.files)fail('The typed declaration exceeds its member limit.','ENGINE_STORAGE_LIMIT');
    if(primary!==path.posix.basename(phase.requiredArtifact.path))fail('The typed primary must match the phase primary artifact.',undefined,{setId:id,primary});
    for(const member of set.members)sourceRelativePath(member.path.replace(/\/$/u,''));
    return {set,root:root==='.'?'':root};
  }
  function selection(definition,workflow,phase,memberPath){
    const declared=declaration(definition,workflow,phase);if(!declared)fail('Declare a typed output set before attaching phase members.');
    const exact=sourceRelativePath(memberPath);
    if(exact===declared.set.primary)fail('Save the primary document with phase.draft.write.');
    const members=declared.set.members.filter(row=>row.path===exact||row.path.endsWith('/')&&exact.startsWith(row.path)).sort((a,b)=>b.path.length-a.path.length);
    if(!members.length)fail('Name one exact declared member or file in a declared collection.',undefined,{memberPath,declared:declared.set.members.map(row=>row.path)});
    return {...declared,member:members[0],memberPath:exact,artifactKey:declared.root?declared.root+'/'+exact:exact};
  }
  /** A return selects declarations of its target, never declarations of the reviewing phase. */
  function repairSelection(definition,workflow,phase,members){
    const declared=declaration(definition,workflow,phase);
    if(!Array.isArray(members)||!members.length||members.length>NAMESPACE_ARTIFACT_SET_LIMITS.files||members.some(row=>typeof row!=='string'||!row.trim()))
      fail('Name one or more exact target output members.','REJECT_MEMBER_UNKNOWN');
    const prefix=(definition.workItemRoot??'singularity/work-items')+'/'+workflow.workItem.id+'/'+(declared?.root?declared.root+'/':''),
      known=new Map((declared?.set.members??[]).flatMap(row=>[[row.path,row.path],[prefix+row.path,row.path]])),selected=[];
    for(const member of members){const name=member.trim();sourceRelativePath(name.replace(/\/$/u,''));
      if(!known.has(name))fail('The rejection target does not declare this output member.','REJECT_MEMBER_UNKNOWN',{
        targetPhase:phase.id,member:name,known:declared?.set.members.map(row=>row.path)??[]});selected.push(known.get(name));}
    return {...declared,members:[...new Set(selected)].sort()};
  }
  function repairComparison(previous,current,members){
    if(previous.setId!==current.setId||previous.primary!==current.primary||previous.root!==current.root)
      fail('Compare a repaired bundle against its exact original declaration.','ENGINE_STORAGE_CORRUPT');
    const diff=artifactSetDiffValues(previous,current,{declared:members}),project=rows=>[...new Map(rows.map(row=>[row.path,{path:row.path,
      sha256:row.sha256,exists:row.exists,...(row.reason?{reason:row.reason}:{})}])).values()];
    const entries=report=>new Map(report.members.flatMap(row=>row.entries.map(entry=>[entry.path,entry.content]))),before=entries(previous),after=entries(current),
      includes=(member,file)=>member.endsWith('/')?file.startsWith(member):member===file,
      files=[...new Set([...before.keys(),...after.keys()])].sort().flatMap(path=>canonicalJson(before.get(path)??null)===canonicalJson(after.get(path)??null)?[]
        :[{path,before:before.get(path)??null,after:after.get(path)??null,requested:members.some(member=>includes(member,path))}]);
    return {profile:'sflow-namespace-artifact-repair-comparison/v1',declared:[...diff.declared],changed:project(diff.changed),preserved:project(diff.preserved),
      files,incidental:project(diff.changed.filter(row=>files.some(file=>includes(row.path,file.path)&&!file.requested))),
      unchangedRequested:members.filter(name=>!files.some(row=>includes(name,row.path)))};
  }
  function repairEntry(repair){return {profile:'sflow-namespace-artifact-repair-entry/v1',phase:repair.identity.phase,generation:repair.identity.generation+1,
    changeRequestId:repair.changeRequestId,sourceRecord:repair.receipt.record,predecessor:repair.identity.publication,
    bundle:repair.identity.bundle,members:[...repair.identity.members],references:repair.references};}
  function catalog(definition,workflow,phase,{primary,files}){
    const declared=declaration(definition,workflow,phase);if(!declared)fail('This phase has no typed artifact set.');
    if(!Array.isArray(files)||files.length>NAMESPACE_ARTIFACT_SET_LIMITS.files)fail('The output bundle exceeds its file limit.','ENGINE_STORAGE_LIMIT');
    const values=[{path:declared.set.primary,content:primary},...files],seen=new Set();let total=0;
    for(const value of values){
      if(value.path!==declared.set.primary)selection(definition,workflow,phase,value.path);
      if(seen.has(value.path))fail('An output member was supplied twice.',undefined,{memberPath:value.path});seen.add(value.path);
      const ref=value.content;
      if(!ref||Object.keys(ref).length!==3||ref.namespace!=='evidence'||!/^[a-f0-9]{64}$/u.test(ref.sha256??'')||!Number.isSafeInteger(ref.bytes)||ref.bytes<0
        ||ref.bytes>NAMESPACE_ARTIFACT_SET_LIMITS.fileBytes)fail('Each output needs its exact bounded shared content reference.');
      total+=ref.bytes;
    }
    if(total>NAMESPACE_ARTIFACT_SET_LIMITS.totalBytes)fail('The output bundle exceeds its byte limit.','ENGINE_STORAGE_LIMIT');
    const members=declared.set.members.map(member=>{
      const directory=member.path.endsWith('/'),selected=values.filter(row=>directory?row.path.startsWith(member.path):row.path===member.path).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),
        sha256=directory?selected.length?sha256Utf8(selected.map(row=>row.path.slice(member.path.length)+'\0'+row.content.sha256+'\n').join('')):null:selected[0]?.content.sha256??null;
      return {...member,directory,exists:selected.length>0,sha256,bytes:directory?null:selected[0]?.content.bytes??null,
        files:directory?selected.length:null,entries:selected.map(row=>({path:row.path,content:{...row.content}}))};
    }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const report={schemaVersion:1,format:'sflow-namespace-artifact-set-report/v1',setId:declared.set.id,primary:declared.set.primary,root:declared.root,members,
      bundleSha256:hash({setId:declared.set.id,members:members.map(({path,role,sha256})=>({path,role,sha256}))})};
    const missing=members.filter(row=>row.required&&!row.exists).map(row=>row.path);
    if(missing.length)fail('Complete every required output member before publication.','PHASE_ARTIFACT_SET_INCOMPLETE',{
      phaseId:phase.id,missing,actions:missing.map(memberPath=>({operation:'phase.artifact.attach',inputs:{workId:workflow.workItem.id,phaseId:phase.id,
        ...(memberPath.endsWith('/')?{}:{memberPath})},requiredInputs:['operationId','expectedRevision','content','reason',...(memberPath.endsWith('/')?['memberPath']:[])]}))});
    return report;
  }
  return Object.freeze({declaration,selection,repairSelection,repairComparison,repairEntry,catalog});
}
