import {createNamespaceConvergencePolicyReader} from './namespace-convergence-policy.mjs';
import {CONVERGENCE_POLICY_EVIDENCE} from './namespace-convergence-contract.mjs';
/** Recompute concrete policy evidence from original bytes, policy and accepted history. Read only. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,NAMESPACE_PHASE_POLICY_SCHEMAS,SPECIFICATION_ANALYSIS_REPORT_SCHEMA,namespaceCodePolicyProfile} from '../foundation/record-schema.mjs';
import {phaseAssignmentRequired} from '../kernel/phase-policy.mjs';
import {specificationAnalysisPublicationPolicy} from '../kernel/specification-analysis.mjs';
import {specificationGateValue,evaluateApprovalChecklist} from '../engine-compatibility/node-specification-policy.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {namespaceAnalysisManifest,namespaceAssignmentManifest,PHASE_ASSIGNMENT_EVIDENCE,namespacePolicyEvidenceBinding,SPECIFICATION_ANALYSIS_EVIDENCE,CODE_INPUT_EVIDENCE,isConformanceEvidence,isCodePolicyEvidence} from './namespace-policy-contract.mjs';
import {createNamespaceConformanceReader} from './namespace-conformance.mjs';
import {createNamespaceCodePolicyReader,withCodePolicyTraversal,verifyCodePolicyInTraversal} from './namespace-code-policy.mjs';
import {createNamespaceCodeInputReader} from './namespace-code-inputs.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceClarificationReader,CLARIFICATION_EVIDENCE} from './namespace-clarification-reader.mjs';
import {answeredMarkerHashes,resolvedClarificationPolicy} from '../kernel/clarification-responses.mjs';
import {namespaceCandidateContent} from './namespace-candidate-content.mjs';
import {createNamespaceArtifactSetReader,ARTIFACT_SET_EVIDENCE} from './namespace-artifact-set-reader.mjs';
import {createNamespaceWitnessOwners} from './namespace-witness-reader.mjs';
import {createNamespaceConstitutionReader,CONSTITUTION_POLICY_EVIDENCE} from './namespace-constitution-reader.mjs';
import {createNamespaceAssignmentOwners} from './namespace-assignment-reader.mjs';
import {createNamespaceConstitutionExceptionOwners} from './namespace-constitution-exception-reader.mjs';
import {createNamespaceDocumentReviewReader,isDocumentReviewEvidence} from './namespace-document-review.mjs';
import {createNamespaceEvidenceReuseOwner,EVIDENCE_REUSE_POLICY,namespaceEvidenceReuseManifest} from './namespace-evidence-reuse-reader.mjs';
import {createNamespaceTestRiskOwner,TEST_RISK_POLICY,namespaceTestRiskManifest} from './namespace-test-risk-reader.mjs';
import {createNamespaceTestRecoveryOwner,TEST_RECOVERY_EVIDENCE,namespaceTestRecoveryManifest} from './namespace-test-recovery-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const hashContext=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});

export function createNamespacePublicationPolicyReader({observer,scope,workId,checks=null}) {
  const verified=new WeakMap();
  let risk;const riskReader=()=>risk??=createNamespaceTestRiskOwner({observer,scope,workId});
  const testRiskCandidate=(publication,snapshot,options={})=>riskReader().draftCandidate(publication,snapshot,options);
  async function verifyTestRisk(publication,binding,{signal}={}){
    const manifest=namespaceTestRiskManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase});
    if(!same(namespaceSpecificationIdentity(publication),Object.fromEntries(Object.keys(namespaceSpecificationIdentity(publication)).map(key=>[key,manifest[key]])))
      ||manifest.recordedAt!==publication.publishedAt||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content})||publication.checks)
      throw error('Accepted environment failures cannot claim a passing publication or another identity.','ENGINE_STORAGE_CORRUPT');
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      snapshot={revision:manifest.basis.revision,configuration:manifest.basis.head.configuration,workflow:state.workflow},report=await json(manifest.report,signal),
      expected=await riskReader().publication({...publication,riskChecks:report.checks},snapshot,{signal,at:publication.publishedAt});
    if(!same(report,expected.report))throw error('Accepted environment failures differ from their actual execution and human receipt.','ENGINE_STORAGE_CORRUPT');
    return {...expected,binding,manifest,report};
  }
  async function freshTestRisk(publication,snapshot,units,{signal,at}={}){
    const retained=proofs(publication).find(row=>row.binding.kind===TEST_RISK_POLICY);if(!retained)return;
    const current=await riskReader().fresh({...publication,riskChecks:retained.report.checks},snapshot,units,{signal,at,bound:retained.report});
    if(!same(current.report,retained.report))throw error('The accepted environment risk or command changed after publication.','TEST_RUN_RISK_NOT_COVERED',{
      actions:[{operation:'test-risk.context',inputs:{workId,phaseId:publication.phase}},{operation:'phase.checks.run',inputs:{workId,phaseId:publication.phase},requiredInputs:['operationId']}]});
  }
  let reuse;const reuseReader=()=>reuse??=createNamespaceEvidenceReuseOwner({observer,scope,workId});
  const reuseCandidate=(publication,snapshot,options={})=>reuseReader().publication(snapshot,publication.phase,options);
  async function verifyReuse(publication,binding,{signal,policyTraversal}={}){
    const manifest=namespaceEvidenceReuseManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase});
    if(!same(namespaceSpecificationIdentity(publication),Object.fromEntries(Object.keys(namespaceSpecificationIdentity(publication)).map(key=>[key,manifest[key]])))
      ||manifest.recordedAt!==publication.publishedAt||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content})||publication.checks)
      throw error('Reused tests have another publication identity or falsely claim a receiving execution.','ENGINE_STORAGE_CORRUPT');
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      snapshot={revision:manifest.basis.revision,configuration:manifest.basis.head.configuration,workflow:state.workflow},report=await json(manifest.report,signal),
      expected=await reuseCandidate(publication,snapshot,{signal,policyTraversal,at:publication.publishedAt,bound:report});
    if(!expected||!same(report,expected.report))throw error('The reuse report differs from its original execution, human receipt or source.','ENGINE_STORAGE_CORRUPT');
    return {...expected,binding,manifest,report};
  }
  async function freshReuseSources(publication,snapshot,units,{signal,at}={}){
    const retained=proofs(publication).find(row=>row.binding.kind===EVIDENCE_REUSE_POLICY);if(!retained)return;
    const expected=await reuseCandidate(publication,snapshot,{signal,at,units});
    const identity=report=>({commands:report.commands,reused:report.reused,sources:report.sources.map(row=>({id:row.id,inventorySha256:row.inventorySha256}))});
    if(!expected||!same(identity(expected.report),identity(retained.report)))throw error(
      'Reused tests no longer match the current source, command or human decision. Reinspect this phase.','ENGINE_EVIDENCE_REUSE_INCOMPLETE',{
        actions:[{operation:'evidence-reuse.context',inputs:{workId,phaseId:publication.phase}},{operation:'phase.checks.run',inputs:{workId,phaseId:publication.phase},requiredInputs:['operationId']}]});
  }
  let recovery;const recoveryReader=()=>recovery??=createNamespaceTestRecoveryOwner({observer,scope,workId});
  const recoveryCandidate=(publication,snapshot,options={})=>recoveryReader().publication(snapshot,publication.phase,options);
  async function verifyRecovery(publication,binding,{signal,policyTraversal}={}){
    const manifest=namespaceTestRecoveryManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase});
    if(!same(namespaceSpecificationIdentity(publication),Object.fromEntries(Object.keys(namespaceSpecificationIdentity(publication)).map(key=>[key,manifest[key]])))
      ||manifest.recordedAt!==publication.publishedAt||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content}))
      throw error('Test recovery evidence has another publication identity.','ENGINE_STORAGE_CORRUPT');
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      snapshot={revision:manifest.basis.revision,configuration:manifest.basis.head.configuration,workflow:state.workflow},
      expected=await recoveryCandidate(publication,snapshot,{signal,policyTraversal}),report=await json(manifest.report,signal);
    if(!same(report,expected.report))throw error('The recovery report differs from its original agreement and commands.','ENGINE_STORAGE_CORRUPT');
    return {...expected,binding,manifest,report};
  }
  let documentReview;const documentReader=()=>documentReview??=createNamespaceDocumentReviewReader({observer,scope,workId});
  let convergence=null;const convergenceReader=()=>convergence??=createNamespaceConvergencePolicyReader({observer,scope,workId});
  let constitution=null;const constitutionReader=()=>constitution??=createNamespaceConstitutionReader({observer,scope,workId});
  let code=null;const codeReader=()=>code??=createNamespaceCodePolicyReader({observer,scope,workId,checks});
  let inputs=null;const inputReader=()=>inputs??=createNamespaceCodeInputReader({observer,scope,workId});
  let conformance=null;const conformanceReader=()=>conformance??=createNamespaceConformanceReader({observer,scope,workId});
  const clarifications=createNamespaceClarificationReader({observer,scope,workId,checks});
  const artifactSets=createNamespaceArtifactSetReader({observer,scope,workId});
  let witnesses=null;const witnessReader=()=>witnesses??=createNamespaceWitnessOwners({observer,scope,workId});
  let assignments=null;const assignmentReader=()=>assignments??=createNamespaceAssignmentOwners({observer,scope,workId});
  let articleExceptions=null;const articleExceptionReader=()=>articleExceptions??=createNamespaceConstitutionExceptionOwners({observer,scope,workId});
  async function json(reference,signal) {
    const bytes=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
    catch(cause){throw error('The policy evidence is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}
  }
  async function assignmentCandidate(publication,snapshot,options={}){
    const approved=await observer.approved(snapshot,options);
    if(!phaseAssignmentRequired(snapshot.workflow,approved.compiled.definition))throw error('This phase does not require assignment evidence.','ENGINE_INPUT_INVALID');
    return assignmentReader().publication(snapshot,publication.phase,options);
  }
  async function verifyAssignment(publication,binding,{signal,policyTraversal}={}){
    const manifest=namespaceAssignmentManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase});
    if(!same(namespaceSpecificationIdentity(publication),Object.fromEntries(Object.keys(namespaceSpecificationIdentity(publication)).map(key=>[key,manifest[key]])))
      ||manifest.recordedAt!==publication.publishedAt||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content}))throw error('Assignment evidence has another publication identity.','ENGINE_STORAGE_CORRUPT');
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      snapshot={revision:manifest.basis.revision,configuration:manifest.basis.head.configuration,workflow:state.workflow},expected=await assignmentCandidate(publication,snapshot,{signal,policyTraversal}),report=await json(manifest.report,signal);
    try{admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS.assignmentReport,report);}catch(cause){throw error('The assignment report has an unsupported or invalid schema.',
      ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
    if(!same(report,expected.report))throw error('The assignment report differs from its exact accepted coordination records.','ENGINE_STORAGE_CORRUPT');
    return {binding,manifest,report,references:expected.references,policy:{owners:['assignment-record']}};
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
      if(binding.kind===TEST_RISK_POLICY){values.push(await verifyTestRisk(publication,binding,{signal}));continue;}
      if(binding.kind===EVIDENCE_REUSE_POLICY){values.push(await verifyReuse(publication,binding,{signal,policyTraversal:token}));continue;}
      if(binding.kind===TEST_RECOVERY_EVIDENCE){values.push(await verifyRecovery(publication,binding,{signal,policyTraversal:token}));continue;}
      if(isDocumentReviewEvidence(binding.kind)){values.push(await documentReader().verify(publication,binding,{signal,policyTraversal:token}));continue;}
      if(binding.kind===CONVERGENCE_POLICY_EVIDENCE){values.push(await convergenceReader().verify(publication,binding,{signal,policyTraversal:token}));continue;}
      if(binding.kind===CONSTITUTION_POLICY_EVIDENCE){values.push(await constitutionReader().verify(publication,binding,{signal}));continue;}
      if(binding.kind===PHASE_ASSIGNMENT_EVIDENCE){values.push(await verifyAssignment(publication,binding,{signal,policyTraversal:token}));continue;}
      if(binding.kind===ARTIFACT_SET_EVIDENCE){values.push(await artifactSets.verify(publication,binding,{signal,policyTraversal:token}));continue;}
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
  function owners(publication) {return proofs(publication).flatMap(value=>(value.binding.kind===TEST_RISK_POLICY||value.binding.kind===EVIDENCE_REUSE_POLICY||value.binding.kind===TEST_RECOVERY_EVIDENCE||isDocumentReviewEvidence(value.binding.kind)||value.binding.kind===CONVERGENCE_POLICY_EVIDENCE||value.binding.kind===CONSTITUTION_POLICY_EVIDENCE||value.binding.kind===PHASE_ASSIGNMENT_EVIDENCE||isCodePolicyEvidence(value.binding.kind)||value.binding.kind===CODE_INPUT_EVIDENCE||value.binding.kind===ARTIFACT_SET_EVIDENCE||isConformanceEvidence(value.binding.kind))?value.policy.owners:[value.binding.kind===CLARIFICATION_EVIDENCE?'clarification-record':'specification-analysis']);}
  function evidence(publication) {return proofs(publication).flatMap(value=>isDocumentReviewEvidence(value.binding.kind)?documentReader().evidence(value):value.binding.kind===CONVERGENCE_POLICY_EVIDENCE?convergenceReader().evidence(value):[TEST_RISK_POLICY,EVIDENCE_REUSE_POLICY,TEST_RECOVERY_EVIDENCE,PHASE_ASSIGNMENT_EVIDENCE].includes(value.binding.kind)?[value.binding.record,value.manifest.report,...value.references]:value.binding.kind===ARTIFACT_SET_EVIDENCE?artifactSets.evidence(value):isConformanceEvidence(value.binding.kind)?conformanceReader().evidence(value):isCodePolicyEvidence(value.binding.kind)?codeReader().evidence(value):value.binding.kind===CODE_INPUT_EVIDENCE?inputReader().evidence(value):value.binding.kind===CLARIFICATION_EVIDENCE
    ?[value.binding.record,...(value.response?[value.response.reference]:[])]:[value.binding.record,value.manifest.report,...(value.manifest.previous?[value.manifest.previous.record]:[])]).map(value=>({...value}));}
  function resources(publication) {return proofs(publication).flatMap(value=>value.binding.kind===ARTIFACT_SET_EVIDENCE?artifactSets.resources(value):[{kind:value.binding.kind===TEST_RISK_POLICY?'test-run-risk':value.binding.kind===EVIDENCE_REUSE_POLICY?'evidence-reuse':value.binding.kind===TEST_RECOVERY_EVIDENCE?'test-recovery':isDocumentReviewEvidence(value.binding.kind)?'document-review':value.binding.kind===CONVERGENCE_POLICY_EVIDENCE?'convergence-projection':value.binding.kind===CONSTITUTION_POLICY_EVIDENCE?'constitution-policy':value.binding.kind===PHASE_ASSIGNMENT_EVIDENCE?'phase-assignment':isConformanceEvidence(value.binding.kind)?'conformance':isCodePolicyEvidence(value.binding.kind)?'code-delivery':value.binding.kind===CODE_INPUT_EVIDENCE?'code-inputs':value.binding.kind===CLARIFICATION_EVIDENCE?'clarification-record':'specification-analysis',
    reference:{...(value.binding.kind===CLARIFICATION_EVIDENCE?value.response?.reference??value.binding.record:value.manifest.report)}},
    ...(isCodePolicyEvidence(value.binding.kind)?(value.report.preflight.outputs?.files??[]).map(row=>({kind:'retained-output',sourceKey:row.path,reference:row.content})):[])]);}
  function readBindings(publication) {return proofs(publication).flatMap(value=>value.binding.kind===TEST_RISK_POLICY?riskReader().readBindings(value.report.checks):isCodePolicyEvidence(value.binding.kind)?codeReader().readBindings(value):value.binding.kind===CLARIFICATION_EVIDENCE?[{...value.manifest.observed}]:[]);}
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
  return Object.freeze({candidate,testRiskCandidate,freshTestRisk,reuseCandidate,freshReuseSources,recoveryCandidate,documentReviewCandidate:(...args)=>documentReader().candidate(...args),convergenceCandidate:(...args)=>convergenceReader().candidate(...args),freshConvergenceCandidate:(...args)=>convergenceReader().freshCandidate(...args),convergenceReview:(...args)=>convergenceReader().review(...args),freshConvergenceSources:(...args)=>convergenceReader().freshSources(...args),assignmentCandidate,constitutionCandidate:(...args)=>constitutionReader().candidate(...args),clarificationEvidence:publication=>proofs(publication).find(row=>row.binding.kind===CLARIFICATION_EVIDENCE)??null,artifactSetCandidate:artifactSets.candidate,clarificationCandidate,codeSourceBinding:(...args)=>codeReader().sourceBinding(...args),codeCandidate:(...args)=>codeReader().candidate(...args),
    codeInputCandidate:(...args)=>inputReader().candidate(...args),conformanceCandidate:(...args)=>conformanceReader().candidate(...args),
    freshCodeCandidate:(...args)=>codeReader().freshCandidate(...args),freshInputCandidate:(...args)=>inputReader().freshEvidence(...args),
    freshConformanceCandidate:(...args)=>conformanceReader().freshCandidate(...args),
    freshInputSources:(publication,...args)=>proofs(publication).some(value=>value.binding.kind===CONVERGENCE_POLICY_EVIDENCE)?convergenceReader().freshSources(publication,...args):proofs(publication).some(value=>isConformanceEvidence(value.binding.kind))
      ?conformanceReader().freshSources(publication,...args):inputReader().freshSources(publication,...args),
    requiresDisposition:(publication,options)=>proofs(publication).some(value=>[TEST_RISK_POLICY,EVIDENCE_REUSE_POLICY].includes(value.binding.kind))&&options?.reached!==false&&!options?.reworkTarget
      ||Boolean(manualAcceptance(publication)&&options?.reached!==false&&!options?.reworkTarget)
      ||proofs(publication).some(value=>value.binding.kind===CONSTITUTION_POLICY_EVIDENCE)&&options?.reached!==false&&!options?.reworkTarget
      ||publication.policyEvidence?.some(value=>isConformanceEvidence(value.kind))===true&&proofs(publication).some(value=>isConformanceEvidence(value.binding.kind))&&conformanceReader().requiresDisposition(publication,options),
    assertApproval:async(publication,options)=>{const result=proofs(publication).some(value=>isConformanceEvidence(value.binding.kind))?await conformanceReader().assertApproval(publication,options):[];
      const risk=proofs(publication).find(row=>row.binding.kind===TEST_RISK_POLICY);
      if(risk&&options.reached!==false&&!options.reworkTarget){
        const current=await riskReader().publication({...publication,riskChecks:risk.report.checks},options.snapshot,{signal:options.signal,at:options.at,bound:risk.report});
        if(!same(current.report,risk.report))throw error('The exact environment risk was revoked, expired or changed.','TEST_RUN_RISK_NOT_COVERED');
        result.push(...current.references);
      }
      const reused=proofs(publication).find(row=>row.binding.kind===EVIDENCE_REUSE_POLICY);
      if(reused&&options.reached!==false&&!options.reworkTarget){
        const current=await reuseCandidate(publication,options.snapshot,{signal:options.signal,at:options.at,bound:reused.report});
        if(!current||!same(current.report,reused.report))throw error('Reuse was revoked, expired or changed before this approval.','ENGINE_EVIDENCE_REUSE_INCOMPLETE');
        result.push(...current.references);
      }
      const manual=manualAcceptance(publication);if(manual)result.push(...await witnessReader().assertAcceptance(options.snapshot,publication,manual,options));
      if(proofs(publication).some(value=>value.binding.kind===CONSTITUTION_POLICY_EVIDENCE)&&options.reached!==false&&!options.reworkTarget)
        result.push(...await articleExceptionReader().assertPublication(options.snapshot,publication,options));return result;},
    freshCodeSources:(...args)=>codeReader().freshSources(...args),codeEvidence,conformanceEvidence,artifactSetEvidence,verify,owners,evidence,resources,readBindings,verifyPlan,checklist});
}
