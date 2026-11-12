/** Read-only candidate inspection. It neither stages publication nor runs or invents checks. */
import {createHash} from 'node:crypto';
import {documentReviewPublicationPolicy,DOCUMENT_REVIEW_OWNERS} from '../kernel/document-review.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {phaseNeedsGeneration,effectivePhasePublicationProducer,phaseAssignmentRequired} from '../kernel/phase-policy.mjs';
import {artifactBytesAreText,artifactContentObservation,inspectRequiredArtifactObservation,inspectBinaryArtifactSize} from '../kernel/artifact-content.mjs';
import {primaryDocumentPublicationRequirements,publicationAuthorshipIntent,codePublicationPolicy,CODE_PUBLICATION_OWNERS,
  codeInputPublicationPolicy,CODE_INPUT_PUBLICATION_OWNERS,conformancePublicationPolicy,CONFORMANCE_PUBLICATION_OWNERS,convergencePublicationPolicy,CONVERGENCE_PUBLICATION_OWNERS} from '../kernel/publication-intent.mjs';
import {specificationPublicationPolicy,SPECIFICATION_PUBLICATION_OWNERS} from '../kernel/specification-publication.mjs';
import {specificationAnalysisPublicationPolicy} from '../kernel/specification-analysis.mjs';
import {resolvedClarificationPolicy} from '../kernel/clarification-responses.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {namespaceArtifactSetPolicies} from '../kernel/namespace-artifact-sets.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null)=>new SingularityFlowError(message,{code,details});
const repairable=new Set(['TEST_RECOVERY_AGREEMENT_REQUIRED','ARTIFACT_AUTHORING_INCOMPLETE','CLARIFICATION_REQUIRED','ENGINE_CHECK_EVIDENCE_REQUIRED',
  'ENGINE_SOURCE_EVIDENCE_REQUIRED','ENGINE_SOURCE_BASELINE_REQUIRED','CODE_DELIVERY_TEST_COVERAGE_INCOMPLETE',
  'CODE_TEST_WITNESS_INCOMPLETE','SPEC_PLANNED_TEST_BINDING_REQUIRED','SPEC_PLANNED_ALLOCATION_INVALID',
  'SPEC_PLANNED_CLAIM_MAP_REQUIRED','SPEC_COVERAGE_INCOMPLETE','PLAN_AMENDMENT_CONTENT_CHANGED','TEST_CAPABILITY_UNSUPPORTED','PHASE_ARTIFACT_SET_INCOMPLETE','ENGINE_ASSIGNMENT_REQUIRED','CONSTITUTION_POLICY_REQUIRED',
  'CONVERGENCE_REVIEW_REQUIRED','CONVERGENCE_ARTIFACT_MISMATCH']);
const finding=(row,phase)=>({code:row.code??'artifact.authoring.incomplete',sourceCode:row.sourceCode??null,category:row.category??null,
  message:row.message??'',phaseId:row.phaseId??phase,path:row.path??null,line:row.line??null,clauseId:row.clauseId??null,
  upstreamDecisionComplete:false,coverageReviewRequired:false,riskEligible:false});

export function createNamespacePhaseInspectionPorts(options,runtime=null){
  const {scope,workId,access,sources=[],modelEnabled=true}=options,observer=createNamespaceStoryObserver(options),contexts=new WeakMap();
  const checks=createNamespacePhaseCheckReader({...options,observer}),publications=createNamespacePublicationReader({observer,scope,workId,checks});
  const artifactSets=namespaceArtifactSetPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
  async function authorize(operation,signal,expected=null){return phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),
    scope.projectId,operation,{expected});}
  async function load(input,operation,{signal}={}){
    if(input.workId!=null&&input.workId!==workId)throw error('Inspect the bound Story.','ACTIVE_SUBJECT_MISMATCH');
    const principal=await authorize(operation,signal),snapshot=(await observer.inspect({signal})).snapshot,
      context={subject:{kind:'story',id:workId},workflow:snapshot.workflow};
    contexts.set(context,{snapshot,principal,operation});return context;
  }
  async function inspect(context,binding,{signal}={}){
    const selected=contexts.get(context);if(!selected)throw error('Use the issued phase inspection.','ENGINE_INPUT_INVALID');
    const {snapshot,principal,operation}=selected,workflow=snapshot.workflow,phase=workflow.phases[binding.phase],
      approved=await observer.approved(snapshot,{signal}),definition=approved.compiled.definition,prepublish=operation==='phase.prepublish',
      commandProof=await createNamespaceTestCommandOwners({observer,scope,workId}).commands(snapshot,phase.id,{signal});
    let token=null,producer=effectivePhasePublicationProducer(phase,{modelEnabled}),fingerprint=null,inspectionStage='authoring',known=true,
      requiredTests=commandProof.commands.length?'not-inspected':'not-required';
    const findings=[],advisories=[],fresh=[];
    async function attempt(readCandidate){try{return await readCandidate();}catch(cause){
      if(!repairable.has(cause.code))throw cause;
      if(cause.code==='PHASE_ARTIFACT_SET_INCOMPLETE'){
        findings.push(...cause.details.missing.map(path=>finding({code:cause.code,category:'artifact-set',path,
          message:'Attach the required output '+path+' using phase.artifact.attach, then inspect this phase again.'},phase.id)));return null;}
      const rows=cause.details?.findings;
      findings.push(...(Array.isArray(rows)&&rows.length?rows.map(row=>finding(row,phase.id))
        :[finding({code:cause.code,message:cause.message,path:cause.details?.path??null,clauseId:cause.details?.clauseId??null},phase.id)]));
      return null;
    }}
    if(!phaseNeedsGeneration(workflow,phase)){
      inspectionStage='published';const bound=phase.publicationBindings?.find(row=>row.generation===binding.generation);
      if(!bound)throw error('The retained phase has no original publication binding.','ENGINE_STORAGE_CORRUPT');
      const published=await publications.accepted(bound,phase.id,{signal});fingerprint=published.artifact.fingerprint;producer=published.authorship.producer;
      if(published.checks)requiredTests='retained-passing';
      if(prepublish){
        if(published.checks)fresh.push(()=>checks.freshSources(published.checks,phase.id,sources,{signal}));
        if(codePublicationPolicy(workflow,phase))fresh.push(()=>publications.policies.freshCodeSources(published,sources,{signal}));
        if(convergencePublicationPolicy(workflow,phase)||codeInputPublicationPolicy(workflow,phase)||conformancePublicationPolicy(workflow,phase))fresh.push(()=>publications.policies.freshInputSources(published,sources,{signal}));
      }
    }else{
      if(!runtime)throw error('Bind the private working store before inspecting the authored draft.','ENGINE_PORT_UNAVAILABLE',{
        operation,phase:phase.id,required:['machine-local-working-store']});
      token=await runtime.captureInspectionDraft(phase.id,operation,{signal});const facts=runtime.inspectionDraftFacts(token),draft=facts.draft;
      if(facts.revision!==snapshot.revision)throw error('Draft inspection captured a different Story revision.','ENGINE_CONTEXT_CHANGED');
      if(!draft)findings.push(finding({code:'artifact.required.missing',message:'Prepare and complete the required phase artifact.'},phase.id));
      else if(facts.stale){known=false;findings.push(finding({code:'ENGINE_DRAFT_BASIS_CHANGED',message:'Review and rebind the preserved draft to the current Story basis.'},phase.id));}
      else{
        const p=draft.payload,data=runtime.inspectionArtifactBytes(token),initial=runtime.inspectionArtifactBytes(token,{initial:true}),text=artifactBytesAreText(data),
          observation=text?artifactContentObservation(data.toString('utf8')):null,original=artifactContentObservation(initial.toString('utf8'));
        fingerprint=observation?'sha256:'+hash(observation.fingerprintText):null;
        const configured={...phase,authoringBaseline:{generation:p.generation,fingerprint:'sha256:'+hash(original.fingerprintText)}};
        findings.push(...(observation?inspectRequiredArtifactObservation(observation,configured,{path:p.artifact.key,generation:p.generation,fingerprint})
          :inspectBinaryArtifactSize(data.byteLength,configured,{path:p.artifact.key})).map(row=>finding(row,phase.id)));
        const documentReview=documentReviewPublicationPolicy(workflow,phase),spec=specificationPublicationPolicy(workflow,phase),analysis=specificationAnalysisPublicationPolicy(definition,workflow,phase),
          clarification=resolvedClarificationPolicy(definition,workflow,phase),code=codePublicationPolicy(workflow,phase),
          convergence=convergencePublicationPolicy(workflow,phase),inputs=convergence?null:codeInputPublicationPolicy(workflow,phase),conformance=conformancePublicationPolicy(workflow,phase),bundle=artifactSets.declaration(definition,workflow,phase),assignment=phaseAssignmentRequired(workflow,definition),
          available=[...(workflow.resolution.testRecovery?.enabled?['test-recovery']:[]),...(documentReview?DOCUMENT_REVIEW_OWNERS:[]),...(spec?SPECIFICATION_PUBLICATION_OWNERS:[]),...(analysis?['specification-analysis']:[]),
            ...(clarification.mode!=='off'?['clarification-record']:[]),...(code?CODE_PUBLICATION_OWNERS:[]),
            ...(convergence?CONVERGENCE_PUBLICATION_OWNERS:[]),...(inputs?CODE_INPUT_PUBLICATION_OWNERS:[]),...(conformance?CONFORMANCE_PUBLICATION_OWNERS:[]),...(bundle?['artifact-set']:[]),...(assignment?['assignment-record']:[]),...(workflow.resolution.constitution?.mode!=='off'?['constitution-policy']:[]),'check-execution'];
        if(prepublish){const pending=primaryDocumentPublicationRequirements(workflow,phase,{definition}).filter(owner=>!available.includes(owner));
          if(pending.length)throw error('Bind the actual required policy/execution owners before publication inspection.','ENGINE_PORT_UNAVAILABLE',{
            operation,phase:phase.id,required:pending});}
        const content={namespace:'evidence',sha256:hash(data),bytes:data.byteLength},authorship=publicationAuthorshipIntent(phase,{authored:producer},{modelEnabled}).authorship,
          candidate={projectId:scope.projectId,workId,phase:phase.id,generation:p.generation,baseRevision:snapshot.revision,configuration:snapshot.configuration,
            draft:{revision:draft.revision,sha256:draft.bodySha256},actor:p.actor,agentId:p.agentId,publishedAt:p.updatedAt,authorship,
            artifact:{key:p.artifact.key,sourceKey:(definition.workItemRoot??'singularity/work-items')+'/'+workId+'/'+p.artifact.key,
              kind:phase.requiredArtifact.kind??'document',encoding:text?'utf8':'binary',content,fingerprint},inputs:facts.resources};
        if(workflow.resolution.testRecovery?.enabled)await attempt(()=>publications.policies.recoveryCandidate(candidate,snapshot,{signal}));
        if(spec)await attempt(()=>publications.specifications.derive(candidate,snapshot,{signal,artifactBytes:data}));
        if(documentReview)await attempt(()=>publications.policies.documentReviewCandidate(candidate,snapshot,{signal}));
        if(convergence){const result=await attempt(()=>publications.policies.convergenceCandidate(candidate,snapshot,{signal,artifactBytes:data}));
          if(prepublish&&result)fresh.push(()=>publications.policies.freshConvergenceCandidate(result,sources,{signal}));}
        if(workflow.resolution.constitution?.mode!=='off'){const observed=await attempt(()=>publications.policies.constitutionCandidate(candidate,snapshot,{signal,artifactBytes:data}));
          for(const message of observed?.report.warnings??[])advisories.push({code:'constitution.policy.advisory',category:'constitution-policy',message,requiredBefore:null,ownerPhase:phase.id,clauseId:null,issueRefs:[],status:'advisory'});}
        if(assignment)await attempt(()=>publications.policies.assignmentCandidate(candidate,snapshot,{signal}));
        if(bundle){const members=[];for(const member of p.members??[])members.push({path:member.path,data:await runtime.inspectionMemberBytes(token,member.path,{signal})});
          await attempt(()=>publications.policies.artifactSetCandidate(candidate,snapshot,{signal,artifactBytes:data,members}));}
        if(clarification.mode!=='off')await attempt(()=>publications.policies.clarificationCandidate(candidate,snapshot,{signal}));
        if(analysis){const result=await attempt(()=>publications.policies.candidate(candidate,snapshot,{signal,artifactBytes:data,inspectClarification:true}));
          if(result?.gate.errors?.length)findings.push(...result.gate.errors.map(row=>finding(typeof row==='string'?{code:'specification.analysis.invalid',message:row}:row,phase.id)));
          if(result?.gate.warnings?.length)advisories.push(...result.gate.warnings.map(row=>({code:typeof row==='string'?'specification.analysis.advisory':row.code??row.kind??'specification.analysis.advisory',
            category:'specification-analysis',message:typeof row==='string'?row:row.message??'',requiredBefore:null,ownerPhase:phase.id,clauseId:null,issueRefs:[],status:'advisory'})));}
        if(prepublish){
          let tested=null;
          if(commandProof.commands.length)tested=await attempt(()=>checks.forDraft({phaseId:phase.id,generation:p.generation,baseRevision:snapshot.revision,
            draft:{workId,phase:phase.id,revision:draft.revision,bodySha256:draft.bodySha256},artifact:p.artifact.current,configuration:snapshot.configuration},{signal}));
          candidate.checks=tested;
          if(tested){requiredTests='retained-passing';fresh.push(()=>checks.freshSources(tested,phase.id,sources,{signal}));}
          else if(commandProof.commands.length)requiredTests='evidence-required';
          if(code){const result=await attempt(()=>publications.policies.codeCandidate(candidate,snapshot,{signal}));
            if(result)fresh.push(()=>publications.policies.freshCodeCandidate(result,candidate,sources,{signal}));}
          if(inputs){const result=await attempt(()=>publications.policies.codeInputCandidate(candidate,snapshot,{signal}));
            if(result)fresh.push(()=>publications.policies.freshInputCandidate(result,sources,{signal}));}
          if(conformance){const result=await attempt(()=>publications.policies.conformanceCandidate(candidate,snapshot,{signal,artifactBytes:data}));
            if(result){fresh.push(()=>publications.policies.freshConformanceCandidate(result,sources,{signal}));
              advisories.push(...result.report.gaps.map(row=>({code:'conformance.verdict.incomplete',category:'upstream-decision',message:'The report retains an incomplete verdict. Approval evaluates its linked upstream decision against the current binding.',
                requiredBefore:'approval',ownerPhase:row.owners.length===1?row.owners[0]:null,clauseId:row.clauseId,issueRefs:row.issueRefs??[],status:'observed'})));}}
        }
      }
    }
    for(const check of fresh)await check();
    if(token)await runtime.revalidateInspectionDraft(token,{signal});
    await authorize(operation,signal,principal);
    const final=(await observer.inspect({signal})).snapshot;if(final.revision!==snapshot.revision)throw error('The Story changed during phase inspection.','ENGINE_CONTEXT_CHANGED');
    const humanConvergence=findings.some(row=>row.code==='CONVERGENCE_REVIEW_REQUIRED');
    const correction=findings.length?{class:humanConvergence?'human-convergence-review':'author-correction',sameTurn:!humanConvergence,requiresNewGeneration:false}:{class:null,sameTurn:false,requiresNewGeneration:false};
    return {workId,phase:phase.id,generation:binding.generation,phaseStatus:binding.phaseStatus,inspectionStage,producer,
      qualityDisposition:findings.length?'correction-required':'ready',draftFingerprint:fingerprint,findings,advisories,warningCount:advisories.length,correction,task:null,
      ...(prepublish?{readiness:{lifecycle:binding.current&&binding.phaseStatus==='in_progress',authoring:findings.length===0,
        knownRecoveryBlockers:known,requiredTests,
        publicationTransaction:inspectionStage==='published'?'already-published':'not-run'}}:{})};
  }
  const port=operation=>({load:(input,options)=>load(input,operation,options),inspect});
  return Object.freeze({phasePrepublish:port('phase.prepublish'),phaseDraftCheck:port('phase.draft-check')});
}
