/** Recompute concrete policy evidence from original bytes, policy and accepted history. Read only. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,SPECIFICATION_ANALYSIS_REPORT_SCHEMA,namespaceCodePolicyProfile} from '../foundation/record-schema.mjs';
import {specificationAnalysisPublicationPolicy} from '../kernel/specification-analysis.mjs';
import {specificationGateValue,evaluateApprovalChecklist} from '../engine-compatibility/node-specification-policy.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {namespaceAnalysisManifest,namespacePolicyEvidenceBinding,SPECIFICATION_ANALYSIS_EVIDENCE,CODE_INPUT_EVIDENCE,isConformanceEvidence,isCodePolicyEvidence} from './namespace-policy-contract.mjs';
import {createNamespaceConformanceReader} from './namespace-conformance.mjs';
import {createNamespaceCodePolicyReader,withCodePolicyTraversal,verifyCodePolicyInTraversal} from './namespace-code-policy.mjs';
import {createNamespaceCodeInputReader} from './namespace-code-inputs.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceClarificationReader,CLARIFICATION_EVIDENCE} from './namespace-clarification-reader.mjs';
import {answeredMarkerHashes,resolvedClarificationPolicy} from '../kernel/clarification-responses.mjs';
import {namespaceCandidateContent} from './namespace-candidate-content.mjs';
import {createNamespaceArtifactSetReader,ARTIFACT_SET_EVIDENCE} from './namespace-artifact-set-reader.mjs';
import {createNamespaceWitnessOwners} from './namespace-witness-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const hashContext=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});

export function createNamespacePublicationPolicyReader({observer,scope,workId,checks=null}) {
  const verified=new WeakMap();
  let code=null;const codeReader=()=>code??=createNamespaceCodePolicyReader({observer,scope,workId,checks});
  let inputs=null;const inputReader=()=>inputs??=createNamespaceCodeInputReader({observer,scope,workId});
  let conformance=null;const conformanceReader=()=>conformance??=createNamespaceConformanceReader({observer,scope,workId});
  const clarifications=createNamespaceClarificationReader({observer,scope,workId,checks});
  const artifactSets=createNamespaceArtifactSetReader({observer,scope,workId});
  let witnesses=null;const witnessReader=()=>witnesses??=createNamespaceWitnessOwners({observer,scope,workId});
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
  async function candidate(publication,snapshot,{signal,artifactBytes,inspectClarification=false}={}) {
    const approved=await observer.approved(snapshot,{signal}),phase=snapshot.workflow.phases[publication.phase],
      selected=specificationAnalysisPublicationPolicy(approved.compiled.definition,snapshot.workflow,phase);
    if(!selected)throw error('This phase does not declare specification analysis.','ENGINE_INPUT_INVALID');
    const prior=await previous(snapshot,publication.phase,publication.generation,signal),data=await namespaceCandidateContent(observer,publication.artifact.content,{signal,artifactBytes});
    let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}
    catch(cause){throw error('Specification analysis requires actual UTF-8 artifact bytes.','ARTIFACT_AUTHORING_INCOMPLETE',null,cause);}
    const clarification=publication.policyEvidence?.find(item=>item.kind===CLARIFICATION_EVIDENCE);
    const replies=clarification?await verifyClarification(publication,clarification,signal)
      :inspectClarification&&resolvedClarificationPolicy(approved.compiled.definition,snapshot.workflow,phase).mode!=='off'
        ?{response:(await clarificationCandidate(publication,snapshot,{signal})).checkpoint.accepted}:null;
    if(resolvedClarificationPolicy(approved.compiled.definition,snapshot.workflow,phase).mode!=='off'&&!clarification&&!inspectClarification)throw error(
      'Specification analysis needs its actual clarification checkpoint proof.','ENGINE_PORT_UNAVAILABLE',{required:['clarification-record']});
    const gate=specificationGateValue(text,{artifactPath:publication.artifact.sourceKey,phase:publication.phase,generation:publication.generation,
      policy:selected.quality,markerMode:selected.markerMode,namespace:snapshot.workflow.resolution.spec?.namespace??null,previousMarkers:prior.markers,
      answers:answeredMarkerHashes(replies?.response?.value).map(questionHash=>({questionHash}))});
    return {gate,previous:prior.binding,selected,definition:approved.compiled.definition,workflow:snapshot.workflow};
  }
  async function clarificationCandidate(publication,snapshot,{signal}={}) {
    const context=await clarifications.context({snapshot},publication.phase,{signal,agentId:publication.agentId,validateLocal:false});
    if(!same(context.value.resources,publication.inputs))throw error('Publication differs from its exact clarification read manifest.','ENGINE_CONTEXT_CHANGED');
    const checkpoint=await clarifications.checkpoint(context.value,{signal}),state=clarifications.readiness(context.value,checkpoint.accepted?.value??null,publication.authorship.producer);
    if(!state.ready)throw error('Record the human clarification checkpoint before publishing this generation.','CLARIFICATION_REQUIRED',{
      phase:publication.phase,generation:publication.generation,contextSha256:context.sha256,errors:state.errors,maxQuestions:context.value.policy.maxQuestions,
      operation:'clarification.record'});
    return {context,checkpoint,state};
  }
  async function verifyClarification(publication,binding,signal) {
    namespacePolicyEvidenceBinding(binding);const manifest=clarifications.schema('publication',await json(binding.record,signal));
    const identity=namespaceSpecificationIdentity(publication),fields=['schemaVersion','format',...Object.keys(identity),'recordedAt','basis','context','contextSha256','observed','response'];
    if(Object.keys(manifest).length!==fields.length||Object.keys(manifest).some(key=>!fields.includes(key))
      ||!same(identity,Object.fromEntries(Object.keys(identity).map(key=>[key,manifest[key]])))
      ||manifest.recordedAt!==publication.publishedAt||manifest.contextSha256!==hashContext(manifest.context)
      ||manifest.basis.revision!==publication.baseRevision||!same(manifest.basis.head.configuration,publication.configuration)
      ||manifest.observed.namespace!=='evidence'||manifest.observed.key!==clarifications.key(publication.phase,publication.generation))throw error('The clarification publication has another binding.','ENGINE_STORAGE_CORRUPT');
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      snapshot={revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow},
      context=await clarifications.context({snapshot},publication.phase,{signal,agentId:publication.agentId,validateLocal:false});
    if(context.sha256!==manifest.contextSha256||!same(context.value,manifest.context)||!same(publication.inputs,context.value.resources))throw error(
      'The clarification context does not replay from its original inputs.','ENGINE_STORAGE_CORRUPT');
    const response=manifest.response?await clarifications.accepted(manifest.response.operationId,{signal}):null;
    if(manifest.response?(!response||!same(response.reference,manifest.response.record)
      ||response.receipt.records.find(item=>item.namespace==='evidence'&&item.key===manifest.observed.key)?.version!==manifest.observed.version)
      :manifest.observed.version!==null)throw error('The clarification record was not the observed accepted checkpoint.','ENGINE_STORAGE_CORRUPT');
    const readiness=clarifications.readiness(context.value,response?.value??null,publication.authorship.producer);
    if(!readiness.ready)throw error('The retained publication has an incomplete clarification checkpoint.','ENGINE_STORAGE_CORRUPT');
    return {binding,manifest,response};
  }
  async function verify(publication,{signal,policyTraversal}={}) {
    if(!publication.policyEvidence)return;
    return withCodePolicyTraversal(policyTraversal,async token=>{
    const identity=canonicalJson(publication);
    const values=[];
    for(const binding of publication.policyEvidence) {
      namespacePolicyEvidenceBinding(binding);
      if(binding.kind===ARTIFACT_SET_EVIDENCE){values.push(await artifactSets.verify(publication,binding,{signal}));continue;}
      if(isConformanceEvidence(binding.kind)){values.push(await conformanceReader().verify(publication,binding,{signal,policyTraversal:token}));continue;}
      if(isCodePolicyEvidence(binding.kind)){values.push(await verifyCodePolicyInTraversal(codeReader(),observer,publication,binding,{signal,policyTraversal:token}));continue;}
      if(binding.kind===CODE_INPUT_EVIDENCE){values.push(await inputReader().verify(publication,binding,{signal,policyTraversal:token}));continue;}
      if(binding.kind===CLARIFICATION_EVIDENCE){values.push(await verifyClarification(publication,binding,signal));continue;}
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
    });
  }
  function proofs(publication) {const found=verified.get(publication);return found&&found.identity===canonicalJson(publication)
    &&found.values.every(value=>isCodePolicyEvidence(value.binding.kind)?codeReader().proof(publication)===value
      :isConformanceEvidence(value.binding.kind)?conformanceReader().proof(publication)===value:value.binding.kind!==CODE_INPUT_EVIDENCE||inputReader().proof(publication)===value)?found.values:[];}
  function owners(publication) {return proofs(publication).flatMap(value=>(isCodePolicyEvidence(value.binding.kind)||value.binding.kind===CODE_INPUT_EVIDENCE||value.binding.kind===ARTIFACT_SET_EVIDENCE||isConformanceEvidence(value.binding.kind))?value.policy.owners:[value.binding.kind===CLARIFICATION_EVIDENCE?'clarification-record':'specification-analysis']);}
  function evidence(publication) {return proofs(publication).flatMap(value=>value.binding.kind===ARTIFACT_SET_EVIDENCE?artifactSets.evidence(value):isConformanceEvidence(value.binding.kind)?conformanceReader().evidence(value):isCodePolicyEvidence(value.binding.kind)?codeReader().evidence(value):value.binding.kind===CODE_INPUT_EVIDENCE?inputReader().evidence(value):value.binding.kind===CLARIFICATION_EVIDENCE
    ?[value.binding.record,...(value.response?[value.response.reference]:[])]:[value.binding.record,value.manifest.report,...(value.manifest.previous?[value.manifest.previous.record]:[])]).map(value=>({...value}));}
  function resources(publication) {return proofs(publication).flatMap(value=>value.binding.kind===ARTIFACT_SET_EVIDENCE?artifactSets.resources(value):[{kind:isConformanceEvidence(value.binding.kind)?'conformance':isCodePolicyEvidence(value.binding.kind)?'code-delivery':value.binding.kind===CODE_INPUT_EVIDENCE?'code-inputs':value.binding.kind===CLARIFICATION_EVIDENCE?'clarification-record':'specification-analysis',
    reference:{...(value.binding.kind===CLARIFICATION_EVIDENCE?value.response?.reference??value.binding.record:value.manifest.report)}}]);}
  function readBindings(publication) {return proofs(publication).flatMap(value=>isCodePolicyEvidence(value.binding.kind)?codeReader().readBindings(value):value.binding.kind===CLARIFICATION_EVIDENCE?[{...value.manifest.observed}]:[]);}
  function codeEvidence(publication){const value=proofs(publication).find(row=>isCodePolicyEvidence(row.binding.kind));
    return value?structuredClone({binding:value.binding,manifest:value.manifest,report:value.report,sources:value.source.plan.sources}):null;}
  function conformanceEvidence(publication){const value=proofs(publication).find(row=>isConformanceEvidence(row.binding.kind));return value?structuredClone(value):null;}
  function artifactSetEvidence(publication){const value=proofs(publication).find(row=>row.binding.kind===ARTIFACT_SET_EVIDENCE);return value?structuredClone(value):null;}
  function manualAcceptance(publication){return proofs(publication).find(row=>isCodePolicyEvidence(row.binding.kind)&&namespaceCodePolicyProfile('codeReport',row.report).humanAcceptance===true);}
  function verifyPlan(publication,plan) {
    if(!publication.policyEvidence)return;
    const values=proofs(publication);
    if(values.length!==publication.policyEvidence.length||values.some(value=>value.manifest.basis.revision!==plan.basis.headVersion
      ||!same(value.manifest.basis.head,plan.basis.head))||!evidence(publication).every(ref=>plan.evidence.some(item=>same(item,ref)))
      ||!readBindings(publication).every(row=>plan.readBindings?.some(item=>same(item,row))))throw error(
      'Policy evidence was not conditionally accepted against its original lifecycle basis.','ENGINE_STORAGE_CORRUPT');
  }
  function checklist(publication,actor,decisions=[]) {
    const value=proofs(publication).find(item=>item.binding.kind===SPECIFICATION_ANALYSIS_EVIDENCE);if(!value)return null;
    return {evidence:structuredClone(value.binding),result:evaluateApprovalChecklist({policy:value.selected.quality,decisions,
      authorities:value.definition.approvalAuthorities,actor:actor.identity})};
  }
  return Object.freeze({candidate,artifactSetCandidate:artifactSets.candidate,clarificationCandidate,codeSourceBinding:(...args)=>codeReader().sourceBinding(...args),codeCandidate:(...args)=>codeReader().candidate(...args),
    codeInputCandidate:(...args)=>inputReader().candidate(...args),conformanceCandidate:(...args)=>conformanceReader().candidate(...args),
    freshCodeCandidate:(...args)=>codeReader().freshCandidate(...args),freshInputCandidate:(...args)=>inputReader().freshEvidence(...args),
    freshConformanceCandidate:(...args)=>conformanceReader().freshCandidate(...args),
    freshInputSources:(publication,...args)=>proofs(publication).some(value=>isConformanceEvidence(value.binding.kind))
      ?conformanceReader().freshSources(publication,...args):inputReader().freshSources(publication,...args),
    requiresDisposition:(publication,options)=>Boolean(manualAcceptance(publication)&&options?.reached!==false&&!options?.reworkTarget)
      ||publication.policyEvidence?.some(value=>isConformanceEvidence(value.kind))===true&&proofs(publication).some(value=>isConformanceEvidence(value.binding.kind))&&conformanceReader().requiresDisposition(publication,options),
    assertApproval:async(publication,options)=>{const result=proofs(publication).some(value=>isConformanceEvidence(value.binding.kind))?await conformanceReader().assertApproval(publication,options):[];
      const manual=manualAcceptance(publication);if(manual)result.push(...await witnessReader().assertAcceptance(options.snapshot,publication,manual,options));return result;},
    freshCodeSources:(...args)=>codeReader().freshSources(...args),codeEvidence,conformanceEvidence,artifactSetEvidence,verify,owners,evidence,resources,readBindings,verifyPlan,checklist});
}
