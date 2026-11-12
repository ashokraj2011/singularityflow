/** Read-only deterministic convergence proof from original Code approvals and human receipts. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,NAMESPACE_CONVERGENCE_SCHEMAS} from '../foundation/record-schema.mjs';
import {exactObject,namespaceRevision} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {lifecycleHead} from './namespace-lifecycle-contract.mjs';
import {namespaceCandidateContent} from './namespace-candidate-content.mjs';
import {CONVERGENCE_PUBLICATION_OWNERS} from '../kernel/publication-intent.mjs';
import {createNamespaceConvergenceDecisionOwner} from './namespace-convergence-decisions-reader.mjs';
import {CONVERGENCE_POLICY_EVIDENCE} from './namespace-convergence-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),error=(message,code='ENGINE_STORAGE_CORRUPT',cause=undefined)=>new SingularityFlowError(message,{code,cause});
export function namespaceConvergenceManifest(value,{scope,workId,phaseId}){
  try{admitRecordSchemaVersion(NAMESPACE_CONVERGENCE_SCHEMAS.policy,value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','baseRevision','configuration','draft','actor','agentId','recordedAt','artifact','basis','report']);
    if(value.format!=='sflow-namespace-convergence-policy/v1'||value.projectId!==scope.projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another convergence publication identity.');
    exactObject(value.basis,['revision','head']);lifecycleHead(value.basis.head,scope,workId);
    if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.basis.revision)!==value.baseRevision)throw Error('Another convergence lifecycle basis.');
    exactObject(value.artifact,['key','content']);
    for(const reference of [value.artifact.content,value.report])if(contentReference(reference).namespace!=='evidence')throw Error('Convergence needs shared immutable bytes.');
    return value;
  }catch(cause){throw error('The retained convergence policy is invalid.',['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause);}
}
export function createNamespaceConvergencePolicyReader({observer,scope,workId}){
  const owner=createNamespaceConvergenceDecisionOwner({observer,scope,workId}),verified=new WeakMap();
  async function json(reference,signal){const bytes=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(cause){throw error('Convergence proof must be retained UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',cause);}}
  async function candidate(publication,snapshot,{signal,artifactBytes,policyTraversal}={}){
    const source=await owner.context(snapshot,publication.phase,{signal,policyTraversal});
    if(source.generation!==publication.generation||!same(publication.configuration,snapshot.configuration))throw error('Convergence has another retained generation.');
    const bytes=await namespaceCandidateContent(observer,publication.artifact.content,{signal,artifactBytes});let body;
    try{body=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch(cause){throw error('Convergence needs its actual UTF-8 projection.','CONVERGENCE_ARTIFACT_MISMATCH',cause);}
    owner.inputs.values.publishable(source.projection,body);
    return {source,report:{schemaVersion:1,format:'sflow-namespace-convergence-policy-report/v1',workId,phase:publication.phase,generation:publication.generation,
      projection:source.identity.projection,sourceSha256:source.projection.sourceSha256,contextBinding:source.expectedContext,
      decisions:source.rows.map(row=>row.reference)},pendingEvidence:source.pendingEvidence,references:source.references};
  }
  async function verify(publication,binding,{signal,policyTraversal}={}){
    const manifest=namespaceConvergenceManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase}),identity=namespaceSpecificationIdentity(publication);
    if(binding.kind!==CONVERGENCE_POLICY_EVIDENCE||!same(identity,Object.fromEntries(Object.keys(identity).map(key=>[key,manifest[key]])))
      ||manifest.recordedAt!==publication.publishedAt||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content})
      ||!same(manifest.configuration,manifest.basis.head.configuration))throw error('The convergence policy differs from its exact published artifact.');
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      snapshot={revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow},
      expected=await candidate(publication,snapshot,{signal,policyTraversal}),report=await json(manifest.report,signal);
    try{admitRecordSchemaVersion(NAMESPACE_CONVERGENCE_SCHEMAS.report,report);}catch(cause){throw error('The convergence report has an unsupported or invalid version.',
      ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause);}
    const projectionBytes=await observer.bytes(report.projection,report.projection.bytes,signal);
    if(!same(expected.report,report)||!Buffer.from(projectionBytes).equals(expected.pendingEvidence[0].bytes))throw error('The convergence report differs from its original accepted inputs or human answers.');
    const result={binding,manifest,report,source:expected.source,references:expected.references,policy:{owners:CONVERGENCE_PUBLICATION_OWNERS}};
    verified.set(publication,{identity:canonicalJson(publication),result});return result;
  }
  function proof(publication){const found=verified.get(publication);return found?.identity===canonicalJson(publication)?found.result:null;}
  function evidence(value){return [value.binding.record,value.manifest.report,...value.references];}
  async function freshSources(publication,units,options={}){const value=proof(publication);if(!value)throw error('Read the exact retained convergence policy before its freshness check.');
    await owner.inputs.fresh(value.source,units,options);}
  function review(publication,binding){const value=proof(publication);if(!value)throw error('Read the original convergence proof before its human advancement.');
    return {confirmation:owner.inputs.values.advancement(value.source.projection,binding),projection:value.source.projection,
      reference:value.report.projection,contextBinding:value.report.contextBinding};}
  return Object.freeze({candidate,verify,proof,evidence,freshSources,review,freshCandidate:(value,units,options)=>owner.inputs.fresh(value.source,units,options)});
}
