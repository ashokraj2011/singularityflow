/** Read-only typed output proofs, recomputed from original policy and retained member bytes. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,NAMESPACE_ARTIFACT_SET_SCHEMAS,namespaceArtifactSetRecordProfile} from '../foundation/record-schema.mjs';
import {namespaceArtifactSetPolicies,NAMESPACE_ARTIFACT_SET_LIMITS} from '../kernel/namespace-artifact-sets.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {exactObject,namespaceRevision} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {lifecycleHead} from './namespace-lifecycle-contract.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {namespaceCandidateContent} from './namespace-candidate-content.mjs';
import {createNamespaceArtifactRepairReader} from './namespace-artifact-repair-reader.mjs';
export const ARTIFACT_SET_EVIDENCE='artifact-set/v1';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),digest=data=>createHash('sha256').update(data).digest('hex');
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
export function namespaceArtifactSetManifest(value,{scope,workId,phaseId}){
  try{const profile=namespaceArtifactSetRecordProfile('manifest',value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','baseRevision','configuration','draft','actor','agentId','recordedAt','artifact','basis','report']);
    if(value.format!==profile.format||value.projectId!==scope.projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another artifact set identity.');
    exactObject(value.basis,['revision','head']);lifecycleHead(value.basis.head,scope,workId);
    if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.basis.revision)!==value.baseRevision)throw Error('Another output bundle basis.');
    exactObject(value.artifact,['key','content']);
    for(const ref of [value.artifact.content,value.report])if(contentReference(ref).namespace!=='evidence')throw Error('Private output proof.');
  }catch(cause){throw error('The retained typed output manifest is invalid.',
    ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
  return value;
}
export function createNamespaceArtifactSetReader({observer,scope,workId}){
  const policies=namespaceArtifactSetPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
  let repairs;const repairReader=()=>repairs??=createNamespaceArtifactRepairReader({observer,scope,workId});
  async function json(reference,signal){const data=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch(cause){throw error('The output bundle proof is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}}
  async function candidate(publication,snapshot,{signal,artifactBytes,members=[],policyTraversal}={}){
    const approved=await observer.approved(snapshot,{signal}),definition=approved.compiled.definition,phase=snapshot.workflow.phases[publication.phase];
    const declared=policies.declaration(definition,snapshot.workflow,phase);
    if(!declared)throw error('This phase has no typed output declaration.','ENGINE_INPUT_INVALID');
    if(publication.artifact.key!==phase.requiredArtifact.path||publication.artifact.sourceKey!==(definition.workItemRoot??'singularity/work-items')+'/'+workId+'/'+phase.requiredArtifact.path)throw error('The typed primary has another declared location.');
    if(!Array.isArray(members)||members.length>NAMESPACE_ARTIFACT_SET_LIMITS.files)throw error('The output bundle exceeds its file limit.','ENGINE_STORAGE_LIMIT');
    await namespaceCandidateContent(observer,publication.artifact.content,{signal,artifactBytes});
    const files=[];
    for(const member of members){policies.selection(definition,snapshot.workflow,phase,member.path);
      if(!(member.data instanceof Uint8Array))throw error('Read actual attached output bytes before cataloging them.','ENGINE_INPUT_INVALID');
      if(member.data.byteLength>NAMESPACE_ARTIFACT_SET_LIMITS.fileBytes)throw error('The output member exceeds its byte limit.','ENGINE_STORAGE_LIMIT');
      const data=Buffer.from(member.data),content={namespace:'evidence',sha256:digest(data),bytes:data.byteLength};files.push({path:member.path,content,data});}
    const report=policies.catalog(definition,snapshot.workflow,phase,{primary:publication.artifact.content,files:files.map(({path,content})=>({path,content}))}),
      repair=await repairReader().active(snapshot,phase.id,{signal,policyTraversal});
    if(!repair)return {report,files,references:[]};
    if(publication.generation!==repair.identity.generation+1)throw error('The repaired bundle belongs to another successor generation.');
    return {report:{...report,schemaVersion:2,format:'sflow-namespace-artifact-set-report/v2',repair:{
      ...repairReader().description(repair),comparison:policies.repairComparison(repair.bundle.report,report,repair.identity.members)}},files,references:repair.references};
  }
  async function verify(publication,binding,{signal,policyTraversal}={}){
    const manifest=namespaceArtifactSetManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase});
    if(!same(namespaceSpecificationIdentity(publication),Object.fromEntries(Object.keys(namespaceSpecificationIdentity(publication)).map(key=>[key,manifest[key]])))
      ||manifest.recordedAt!==publication.publishedAt||!same(manifest.configuration,manifest.basis.head.configuration)
      ||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content}))throw error('The output bundle differs from its original publication.');
    const report=await json(manifest.report,signal);
    try{if(namespaceArtifactSetRecordProfile('report',report).version!==namespaceArtifactSetRecordProfile('manifest',manifest).version)
      throw Error('The report differs from its manifest profile.');}
    catch(cause){throw error('The output bundle report has an unsupported or invalid version.',
      ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
    if(!Array.isArray(report.members)||report.members.length>1024)throw error('The output bundle report has invalid members.');
    const members=new Map();
    for(const row of report.members){if(!Array.isArray(row?.entries)||row.entries.length>1024)throw error('The output bundle report has invalid entries.');
      for(const entry of row.entries){if(typeof entry?.path!=='string'||contentReference(entry.content).namespace!=='evidence')throw error('The output bundle entry is invalid.');
        if(entry.path===report.primary){if(!same(entry.content,publication.artifact.content))throw error('The primary output differs from its publication.');continue;}
        if(entry.content.bytes>NAMESPACE_ARTIFACT_SET_LIMITS.fileBytes)throw error('The retained output exceeds its byte limit.');
        const prior=members.get(entry.path);if(prior&&!same(prior,entry.content))throw error('Two declarations claim different bytes for one output.');members.set(entry.path,entry.content);
        if(members.size>NAMESPACE_ARTIFACT_SET_LIMITS.files)throw error('The retained output bundle exceeds its file limit.');}}
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      snapshot={revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow};
    const actual=[];for(const [path,reference] of members)actual.push({path,data:await observer.bytes(reference,reference.bytes,signal)});
    const expected=await candidate(publication,snapshot,{signal,members:actual,policyTraversal});
    if(!same(report,expected.report))throw error('The typed output bundle does not replay from its exact declaration and bytes.');
    return {binding,manifest,report,files:expected.files.map(({path,content})=>({path,content})),references:expected.references,policy:{owners:['artifact-set']}};
  }
  const resources=value=>[{kind:'artifact-set',reference:{...value.manifest.report}},...value.files.map(row=>({kind:'artifact-set-member',
    sourceKey:value.manifest.artifact.key.slice(0,-value.report.primary.length)+row.path,reference:{...row.content}}))];
  const evidence=value=>[value.binding.record,value.manifest.report,...value.files.map(row=>row.content),...(value.references??[])];
  return Object.freeze({candidate,verify,resources,evidence});
}
