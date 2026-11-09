/** Recompute concrete policy evidence from original bytes, policy and accepted history. Read only. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,SPECIFICATION_ANALYSIS_REPORT_SCHEMA} from '../foundation/record-schema.mjs';
import {specificationAnalysisPublicationPolicy} from '../kernel/specification-analysis.mjs';
import {specificationGateValue,evaluateApprovalChecklist} from '../engine-compatibility/node-specification-policy.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {namespaceAnalysisManifest,namespacePolicyEvidenceBinding,SPECIFICATION_ANALYSIS_EVIDENCE} from './namespace-policy-contract.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});

export function createNamespacePublicationPolicyReader({observer,scope,workId,checks=null}) {
  const verified=new WeakMap();
  async function json(reference,signal) {
    const bytes=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch(cause){throw error('The policy evidence is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}
  }
  async function previous(snapshot,phaseId,generation,signal) {
    const phase=snapshot.workflow.phases[phaseId];
    if(phase.generation===0)return {binding:null,markers:[]};
    const binding=phase.publicationBindings?.find(item=>item.generation===phase.generation);
    if(!binding||binding.generation>=generation)throw error('Analysis needs its exact earlier publication history.','ENGINE_STORAGE_CORRUPT');
    const published=await createNamespacePublicationReader({observer,scope,workId,checks}).accepted(binding,phaseId,{signal});
    const evidence=published.policyEvidence?.find(item=>item.kind===SPECIFICATION_ANALYSIS_EVIDENCE);
    if(!evidence)throw error('The preceding generation needs its original specification-analysis proof.','ENGINE_PORT_UNAVAILABLE',{
      phase:phaseId,generation:binding.generation,required:['retained-specification-analysis']});
    const manifest=namespaceAnalysisManifest(await json(evidence.record,signal),{scope,workId,phaseId}),report=await json(manifest.report,signal);
    return {binding,markers:report.markers.open};
  }
  async function candidate(publication,snapshot,{signal}={}) {
    const approved=await observer.approved(snapshot,{signal}),phase=snapshot.workflow.phases[publication.phase],
      selected=specificationAnalysisPublicationPolicy(approved.compiled.definition,snapshot.workflow,phase);
    if(!selected)throw error('This phase does not declare specification analysis.','ENGINE_INPUT_INVALID');
    const prior=await previous(snapshot,publication.phase,publication.generation,signal),data=await observer.bytes(publication.artifact.content,publication.artifact.content.bytes,signal);
    let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}
    catch(cause){throw error('Specification analysis requires actual UTF-8 artifact bytes.','ARTIFACT_AUTHORING_INCOMPLETE',null,cause);}
    const gate=specificationGateValue(text,{artifactPath:publication.artifact.sourceKey,phase:publication.phase,generation:publication.generation,
      policy:selected.quality,markerMode:selected.markerMode,namespace:snapshot.workflow.resolution.spec?.namespace??null,previousMarkers:prior.markers,answers:[]});
    return {gate,previous:prior.binding,selected,definition:approved.compiled.definition,workflow:snapshot.workflow};
  }
  async function verify(publication,{signal}={}) {
    if(!publication.policyEvidence)return;
    const identity=canonicalJson(publication);
    const values=[];
    for(const binding of publication.policyEvidence) {
      namespacePolicyEvidenceBinding(binding);
      if(binding.kind!==SPECIFICATION_ANALYSIS_EVIDENCE)throw error('This policy-evidence contract needs its matching reader.','ENGINE_STORAGE_UNSUPPORTED',{kind:binding.kind});
      const manifest=namespaceAnalysisManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase});
      if(!same(namespaceSpecificationIdentity(publication),Object.fromEntries(Object.keys(namespaceSpecificationIdentity(publication)).map(key=>[key,manifest[key]])))
        ||manifest.recordedAt!==publication.publishedAt||!same(manifest.configuration,manifest.basis.head.configuration)
        ||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content}))throw error(
        'The analysis differs from its original artifact, actor or publication binding.','ENGINE_STORAGE_CORRUPT');
      const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
        snapshot={revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow};
      const expected=await candidate(publication,snapshot,{signal}),report=await json(manifest.report,signal);
      try{admitRecordSchemaVersion(SPECIFICATION_ANALYSIS_REPORT_SCHEMA,report);}
      catch(cause){throw error('The specification analysis report has an unsupported or invalid version.',
        ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
      if(!same(manifest.previous,expected.previous)||!same(report,expected.gate.report)||expected.gate.errors.length)throw error(
        'The retained analysis does not replay as a publishable result from the pinned evidence.','ENGINE_STORAGE_CORRUPT');
      values.push({binding,manifest,...expected});
    }
    if(identity!==canonicalJson(publication))throw error('The publication changed during policy verification. Read its exact retained binding again.','ENGINE_CONTEXT_CHANGED');
    verified.set(publication,{identity,values});
  }
  function proofs(publication) {const found=verified.get(publication);return found&&found.identity===canonicalJson(publication)?found.values:[];}
  function owners(publication) {return proofs(publication).length?['specification-analysis']:[];}
  function evidence(publication) {return proofs(publication).flatMap(value=>[value.binding.record,value.manifest.report,...(value.manifest.previous?[value.manifest.previous.record]:[])]).map(value=>({...value}));}
  function resources(publication) {return proofs(publication).map(value=>({kind:'specification-analysis',reference:{...value.manifest.report}}));}
  function verifyPlan(publication,plan) {
    if(!publication.policyEvidence)return;
    const values=proofs(publication);
    if(values.length!==publication.policyEvidence.length||values.some(value=>value.manifest.basis.revision!==plan.basis.headVersion
      ||!same(value.manifest.basis.head,plan.basis.head))||!evidence(publication).every(ref=>plan.evidence.some(item=>same(item,ref))))throw error(
      'Policy evidence was not conditionally accepted against its original lifecycle basis.','ENGINE_STORAGE_CORRUPT');
  }
  function checklist(publication,actor,decisions=[]) {
    const value=proofs(publication).find(item=>item.binding.kind===SPECIFICATION_ANALYSIS_EVIDENCE);if(!value)return null;
    return {evidence:structuredClone(value.binding),result:evaluateApprovalChecklist({policy:value.selected.quality,decisions,
      authorities:value.definition.approvalAuthorities,actor:actor.identity})};
  }
  return Object.freeze({candidate,verify,owners,evidence,resources,verifyPlan,checklist});
}
