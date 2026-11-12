/** Authenticate a document review's actual upstream definitions and plans without inventing Code acceptance. */
import {canonicalJson,admitRecordSchemaVersion,NAMESPACE_PHASE_POLICY_SCHEMAS} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {documentReviewPublicationPolicy,documentReviewSources} from '../kernel/document-review.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {namespaceEvidencePolicyManifest} from './namespace-policy-contract.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),fail=(message,code='ENGINE_STORAGE_CORRUPT')=>{throw new SingularityFlowError(message,{code});};
export const DOCUMENT_REVIEW_EVIDENCE='document-review/v1';
export function namespaceDocumentReviewManifest(value,bindings){
  return namespaceEvidencePolicyManifest(value,{...bindings,family:NAMESPACE_PHASE_POLICY_SCHEMAS.documentReview,format:'sflow-namespace-document-review/v1'});
}
export function createNamespaceDocumentReviewReader({observer,scope,workId}){
  async function json(ref,signal){const bytes=await observer.bytes(ref,ref.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(cause){throw new SingularityFlowError(
      'The retained document review is not UTF-8 JSON.',{code:'ENGINE_STORAGE_CORRUPT',cause});}}
  async function candidate(publication,snapshot,{signal,policyTraversal}={}){
    const policy=documentReviewPublicationPolicy(snapshot.workflow,snapshot.workflow.phases[publication.phase]);
    if(!policy)fail('This phase does not own a document-review context.','ENGINE_INPUT_INVALID');
    const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),
      ids=documentReviewSources(snapshot.workflow,snapshot.workflow.phases[publication.phase]),proofs=await packets.inspectApprovedMany(snapshot,ids,{signal,policyTraversal}),sources=[];
    for(const [index,id]of ids.entries()){
      const proof=proofs[index];if(!proof?.published.specifications)fail('The review needs its actual retained definition or plan.','ENGINE_PORT_UNAVAILABLE');
      sources.push({phase:id,generation:proof.value.generation,publication:proof.value.publication,submission:proof.binding,specifications:proof.published.specifications});
    }
    const source=snapshot.workflow.workItem.source.content;await observer.bytes(source,source.bytes,signal);
    return {policy,report:{schemaVersion:1,format:'sflow-namespace-document-review-report/v1',profile:policy.profile,
      responsibility:'review',definitionsAndPlans:sources,source}};
  }
  async function verify(publication,binding,{signal,policyTraversal}={}){
    const manifest=namespaceDocumentReviewManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase}),identity=namespaceSpecificationIdentity(publication);
    if(!same(identity,Object.fromEntries(Object.keys(identity).map(key=>[key,manifest[key]])))||manifest.recordedAt!==publication.publishedAt
      ||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content})||!same(manifest.configuration,manifest.basis.head.configuration))fail('The review context has another publication identity.');
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      actual=await candidate(publication,{revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow},{signal,policyTraversal}),report=await json(manifest.report,signal);
    admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS.documentReviewReport,report);
    if(!same(report,actual.report))fail('The document review differs from its actual approved intent context.');
    return {binding,manifest,...actual};
  }
  function evidence(value){return [value.binding.record,value.manifest.report,...value.report.definitionsAndPlans.flatMap(row=>[row.publication.record,row.submission.record,row.specifications.record])];}
  return Object.freeze({candidate,verify,evidence});
}
