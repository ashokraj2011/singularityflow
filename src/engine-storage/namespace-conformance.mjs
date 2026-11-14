/** Conformance is recomputed from approved definitions, actual Code proof and authored rows. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,namespaceConformancePolicyProfile} from '../foundation/record-schema.mjs';
import {exactObject} from '../sda/namespace/values.mjs';
import {evaluateConformanceEvidence} from '../kernel/conformance-report.mjs';
import {linkedConformanceEvidence} from '../engine-compatibility/node-specification-policy.mjs';
import {specificationPublicationSources} from '../kernel/specification-publication.mjs';
import {createNamespaceCodeInputReader} from './namespace-code-inputs.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {namespaceSpecificationManifest,namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {createNamespaceConformanceDecisionOwner} from './namespace-conformance-decision-reader.mjs';
import {createNamespaceUpstreamOwners} from './namespace-upstream-reader.mjs';
import {namespaceConformanceManifest} from './namespace-policy-contract.mjs';
import {namespaceCandidateContent} from './namespace-candidate-content.mjs';
import {createNamespaceObligationRiskOwner} from './namespace-obligation-risk-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null,cause)=>new SingularityFlowError(message,{code,details,cause});
export function createNamespaceConformanceReader({observer,scope,workId}){
  const inputs=createNamespaceCodeInputReader({observer,scope,workId}),verified=new WeakMap(),candidates=new WeakMap();
  async function json(reference,signal){const bytes=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(cause){throw error('Conformance evidence is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}}
  async function candidate(publication,snapshot,{signal,policyTraversal,version=null,artifactBytes}={}){
    const code=await inputs.candidate(publication,snapshot,{signal,policyTraversal,conformance:true});
    return observer.withReadScope(async scoped=>{
      const checks=createNamespacePhaseCheckReader({...scoped.evidenceReads,observer:scoped}),packets=createNamespaceSubmissionReader({observer:scoped,scope,workId,checks}),
        ids=specificationPublicationSources(snapshot.workflow,publication.phase),proofs=await packets.inspectApprovedMany(snapshot,ids,{signal,policyTraversal}),definitions=[],clauseIds=[];
      for(const [position,id]of ids.entries()){
        const proof=proofs[position];if(!proof?.published.specifications)throw error('Conformance needs every original approved definition.','ENGINE_PORT_UNAVAILABLE',{phase:id,required:['approved-specification-evidence']});
        const manifest=namespaceSpecificationManifest(await json(proof.published.specifications.record,signal),{scope,workId,phaseId:id});
        if(!manifest.index)throw error('The conformance definition has no retained clause index.');
        const index=await json(manifest.index,signal);clauseIds.push(...index.clauses.map(row=>row.id));
        definitions.push({phase:id,generation:proof.value.generation,publication:proof.value.publication,submission:proof.binding,index:manifest.index});
      }
      const observations=code.report.inputs.flatMap(input=>input.repositories.flatMap(repository=>Object.entries(repository.observed.claims).map(([clauseId,claim])=>({
        clauseId,phase:input.phase,generation:input.generation,repositoryId:repository.id,verdict:claim.verdict,sourceRevision:repository.sourceRevision,
        checks:input.executionRisk?.checks??input.checks,witnesses:repository.witnesses.filter(row=>row.witness.clauseId===clauseId).map(row=>({id:row.witness.logicalTestId??null,status:row.result.status}))})))),
        data=await namespaceCandidateContent(observer,publication.artifact.content,{signal,artifactBytes});
      let markdown;try{markdown=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch(cause){throw error('Conformance requires UTF-8 report content.','ARTIFACT_AUTHORING_INCOMPLETE',null,cause);}
      const originalProfile=version===null?null:namespaceConformancePolicyProfile('conformanceReport',{schemaVersion:version}),
        linked=originalProfile?.issueLinks||version===null&&((snapshot.workflow.upstreamIssues??[]).length>0||/\bUPI-\d{3,}\b/u.test(markdown)),
        selected={workflow:snapshot.workflow,phaseId:publication.phase,clauseIds:[...new Set(clauseIds)],observations},
        result=linked?linkedConformanceEvidence(markdown,selected)
          :evaluateConformanceEvidence(markdown,selected),issueIds=[...new Set(result.gaps.flatMap(row=>row.issueRefs??[]))],
        v2=originalProfile?.issueLinks||version===null&&issueIds.length>0,
        upstream=v2?(snapshot.workflow.upstreamIssues??[]).filter(row=>issueIds.includes(row.id)):[],
        issueEvidence=v2?await createNamespaceUpstreamOwners({observer:scoped,scope,workId}).admitted(snapshot,{signal,policyTraversal}):[];
      for(const issue of upstream)if(snapshot.workflow.phases[issue.phase]?.generation!==issue.producerGeneration)result.findings.push({
        code:'conformance.upstream-producer-stale',clauseId:null,line:null,message:issue.id+' names another producer generation.'});
      if(result.findings.length)throw error('Repair the conformance rows against their exact approved evidence.','ARTIFACT_AUTHORING_INCOMPLETE',{
        phase:publication.phase,findings:result.findings,operation:'phase.draft.write'});
      const known=code.report.inputs.filter(row=>row.executionRisk),environment=known.some(row=>row.executionRisk.profile==='sflow-environment-failure-code-input/v1'),
        profile=namespaceConformancePolicyProfile('conformanceReport',{schemaVersion:environment?(v2?6:5):known.length?(v2?4:3):(v2?2:1)});
      const value={code,policy:code.policy,report:{schemaVersion:profile.version,format:profile.format,inputs:code.report,definitions,rows:result.rows,gaps:result.gaps,...(v2?{upstream,issueEvidence}:{}),
        ...(profile.knownFailureInputs||profile.environmentFailureInputs?{executionExceptions:known.map(row=>({phase:row.phase,generation:row.generation,checks:row.executionRisk.checks,
          policy:row.executionRisk.policy,testsPassed:false,failedAcceptanceWaived:false,receiverExecuted:false,...(profile.environmentFailureInputs?{
            kind:row.executionRisk.profile==='sflow-environment-failure-code-input/v1'?'environment':'known-failure',causeClasses:row.executionRisk.causeClasses??[]}: {})}))}:{})}};
      candidates.set(value,hash(value));return value;
    });
  }
  async function verify(publication,binding,{signal,policyTraversal}={}){
    const manifest=namespaceConformanceManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase}),identity=namespaceSpecificationIdentity(publication);
    if(!same(identity,Object.fromEntries(Object.keys(identity).map(key=>[key,manifest[key]])))||manifest.recordedAt!==publication.publishedAt
      ||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content})||!same(manifest.configuration,manifest.basis.head.configuration))throw error('Conformance differs from its original publication identity.');
    const report=await json(manifest.report,signal),profile=namespaceConformancePolicyProfile('conformance',manifest);let reportProfile;
    try{reportProfile=namespaceConformancePolicyProfile('conformanceReport',report);
      if(reportProfile.version!==profile.version)throw error('Conformance manifest and report need the same supported version.','ENGINE_STORAGE_UNSUPPORTED');
      exactObject(report,['schemaVersion','format','inputs','definitions','rows','gaps',...(profile.issueLinks?['upstream','issueEvidence']:[]),...(profile.knownFailureInputs||profile.environmentFailureInputs?['executionExceptions']:[])]);
      if(report.format!==reportProfile.format||binding.kind!==profile.kind)throw Error('Another conformance format.');
    }catch(cause){throw error('The conformance report has an invalid or unsupported contract.',
      ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED','ENGINE_STORAGE_UNSUPPORTED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      actual=await candidate(publication,{revision:manifest.basis.revision,configuration:manifest.configuration,workflow:state.workflow},{signal,policyTraversal,version:profile.version});
    if(!same(actual.report,report))throw error('Conformance does not replay from its approved definitions and original execution records.');
    const value={binding,manifest,...actual};verified.set(publication,{identity:canonicalJson(publication),value,sha256:hash(value)});return value;
  }
  function proof(publication){const found=verified.get(publication);return found?.identity===canonicalJson(publication)&&found.sha256===hash(found.value)?found.value:null;}
  function evidence(value){return [value.binding.record,value.manifest.report,...inputs.sourceEvidence(value.code),
    ...value.report.definitions.flatMap(row=>[row.publication.record,row.submission.record,row.index]),...(value.report.issueEvidence??[])];}
  async function freshSources(publication,units,options){const value=proof(publication);if(!value)throw error('Verify the exact conformance before source admission.','ENGINE_INPUT_INVALID');return inputs.freshEvidence(value.code,units,options);}
  async function freshCandidate(value,units,options){if(candidates.get(value)!==hash(value))throw error('Use the unchanged conformance candidate before source admission.','ENGINE_INPUT_INVALID');
    return inputs.freshEvidence(value.code,units,options);}
  function dispositionRequirement(publication,{reached=true,reworkTarget=null}={}){
    const value=proof(publication);if(!value)throw error('Read the exact conformance before its human disposition.','ENGINE_INPUT_INVALID');
    return {value,required:reached&&value.report.gaps.length>0&&(!reworkTarget||value.report.gaps.some(row=>!row.owners.includes(reworkTarget)))};
  }
  function requiresDisposition(publication,options){return dispositionRequirement(publication,options).required;}
  async function assertApproval(publication,{reached=true,reworkTarget=null,snapshot=null,at=null,signal,policyTraversal}={}){
    const {value,required}=dispositionRequirement(publication,{reached,reworkTarget});if(!required)return [];
    if(!snapshot||!at)throw error('A conformance approval needs its original human decision basis.','ENGINE_INPUT_INVALID');
    const owned=createNamespaceConformanceDecisionOwner({observer,scope,workId}),source=await owned.owner.read(snapshot,{phaseId:publication.phase},{signal,policyTraversal}),
      decisions=await owned.retained(snapshot,source,{signal,at,policyTraversal}),linked=await owned.linked(snapshot,source,{signal,at,policyTraversal}),
      risks=(snapshot.workflow.namespaceObligationRisks??[]).length?await createNamespaceObligationRiskOwner({observer,scope,workId}).conformance(snapshot,value.report.gaps,{signal,at,policyTraversal}):{covered:[],references:[]},
      open=value.report.gaps.filter(gap=>!gap.owners.length||gap.owners.some(owner=>{
        const issues=(gap.issueRefs??[]).filter(id=>value.report.upstream?.some(row=>row.id===id&&row.phase===owner));
        if(issues.length)return issues.some(id=>!linked.some(row=>row.issueId===id&&row.clauseId===gap.clauseId&&row.ownerPhase===owner&&row.active));
        return !decisions.some(row=>row.active&&row.value.request.clauseId===gap.clauseId&&row.value.request.ownerPhase===owner)
          &&!risks.covered.some(row=>row.clauseId===gap.clauseId&&row.ownerPhase===owner);
      }));
    if(open.length)throw error('Keep the honest verdict. Its upstream owners need an explicit decision or a reviewed return for repair.','ENGINE_CONFORMANCE_DECISION_REQUIRED',{
      phase:publication.phase,gaps:open,required:['upstream-gap-human-disposition'],actions:[{operation:'conformance.context',inputs:{workId,phaseId:publication.phase}},
        {operation:'phase.review',inputs:{workId,phaseId:publication.phase}}]});
    return [...decisions.filter(row=>row.active).flatMap(row=>[row.reference,...row.source.references]),...linked.filter(row=>row.active).flatMap(row=>row.references),...risks.references];
  }
  return Object.freeze({candidate,verify,proof,evidence,freshSources,freshCandidate,assertApproval,requiresDisposition});
}
