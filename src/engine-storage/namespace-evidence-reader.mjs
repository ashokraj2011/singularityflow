import {namespaceTerminalEvaluationRequired} from '../kernel/approval-policy.mjs';
/** Reconstruct an evidence view from actual accepted publications, checks and human receipts. No effects. */
import {isNamespaceTestRiskPolicy,canonicalJson} from '../foundation/record-schema.mjs';
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX} from '../records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {evidenceEvaluationPolicies} from '../kernel/evidence-evaluation.mjs';
import {phaseNeedsGeneration,phaseRequiresCodeDelivery,stepResponsibilities} from '../kernel/phase-policy.mjs';
import {planCorrectionPolicies} from '../kernel/plan-corrections.mjs';
import {namespaceSpecificationManifest} from './namespace-specification-contract.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespaceScopeDecisionOwners} from './namespace-scope-reader.mjs';
import {createNamespacePlanDecisionOwners} from './namespace-plan-decisions-reader.mjs';
import {createNamespaceWitnessOwners} from './namespace-witness-reader.mjs';
import {namespaceWitnessAttempt} from './namespace-check-witnesses.mjs';
import {createNamespaceObligationRiskOwner} from './namespace-obligation-risk-reader.mjs';
import {createNamespaceWitnessRenewalOwner} from './namespace-witness-renewals.mjs';
import {namespaceWitnessMappingInput} from './namespace-witness-mapping-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),rules=evidenceEvaluationPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS),
  corrections=planCorrectionPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS),fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{
    throw new SingularityFlowError(message,{code,details});};
export function createNamespaceEvidenceReader({observer,scope,workId}){
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),
    publications=packets.publicationReader,scopes=createNamespaceScopeDecisionOwners({observer,scope,workId}),
    plans=createNamespacePlanDecisionOwners({observer,scope,workId}),witnesses=createNamespaceWitnessOwners({observer,scope,workId});
  async function json(reference,signal){const bytes=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(cause){throw new SingularityFlowError(
      'The accepted evidence observation is not UTF-8 JSON.',{code:'ENGINE_STORAGE_CORRUPT',cause});}}
  async function unexcepted(snapshot,{signal,at}={}){
    const workflow=snapshot.workflow,required=[];let terminal=null;
    // These old collections need their actual ceremony owners. No raw array can become an exception.
    for(const key of ['riskDecisions','qualityRiskDecisions','documentRiskDecisions','documentRisks'])if(workflow[key]!=null&&(!Array.isArray(workflow[key])||workflow[key].length))required.push(key);
    if(workflow.resolution.presence)required.push('person-presence');
    if(required.length)fail('This evidence view needs the original decision and identity proof owners.','ENGINE_PORT_UNAVAILABLE',{required});
    if(workflow.phaseOrder.length>256)fail('The evidence view exceeds its bounded phase inventory.','ENGINE_STORAGE_LIMIT');
    const source=await scopes.inventory(snapshot,'decision.completeness',{signal}),amendments=await plans.projection(snapshot,{signal}),
      records={indexes:[],planned:[],observed:[],acceptance:[]},deliveries=[],inspections=[],witnessRecords=[],executionPolicies=[],references=[workflow.workItem.source.content,snapshot.configuration.content,...source.references,...amendments.references],excluded=[];
    const approved=workflow.phaseOrder.filter(id=>workflow.phases[id].status==='approved'&&!phaseNeedsGeneration(workflow,workflow.phases[id]));
    const votes=await packets.inspectApprovedMany(snapshot,approved,{signal}),acceptedPublications=new Map(approved.map((id,index)=>[id,votes[index]?.published]));
    for(const [index,id]of approved.entries()){
      const proof=votes[index];if(!proof)fail('An approved phase has no actual submitted and approved delivery.');
      references.push(proof.binding.record,...(workflow.phases[id].approvals??[]).filter(row=>row.namespaceVote).map(row=>row.namespaceVote.record));
      if(workflow.status==='closed'&&workflow.currentPhase===null&&namespaceTerminalEvaluationRequired(workflow)){
        for(const row of workflow.phases[id].approvals.filter(row=>row.namespaceVote&&!row.invalidatedAt)){
          const vote=await json(row.namespaceVote.record,signal);if(!vote.terminalEvidence)continue;
          // inspectApprovedMany already authenticated this vote and recomputed its original terminal proposal.
          const retained=await json(vote.terminalEvidence,signal);terminal=retained.report;references.push(vote.terminalEvidence);
        }
      }
    }
    for(const id of workflow.phaseOrder){
      if(signal?.aborted)fail('Evidence reading was cancelled.','ENGINE_OPERATION_CANCELLED');
      const phase=workflow.phases[id];if(phase.status==='skipped')continue;
      if(phaseNeedsGeneration(workflow,phase)){excluded.push({phase:id,generation:phase.generation,reason:'generation-required'});continue;}
      const binding=phase.publicationBindings?.find(row=>row.generation===phase.generation);
      if(!binding){if(phase.generation>0)fail('A current generation has no retained publication.',undefined,{phase:id});continue;}
      const publication=acceptedPublications.get(id)??await publications.accepted(binding,id,{signal});
      references.push(binding.record,publication.artifact.content,...publications.policies.evidence(publication),...publications.specifications.evidence(publication));
      const execution=await publications.policies.executionDispositions(publication,snapshot,{signal,at});
      executionPolicies.push(...execution);references.push(...execution.flatMap(row=>row.references));
      if(publication.policyEvidence?.some(row=>isNamespaceTestRiskPolicy(row.kind)))excluded.push({phase:id,generation:phase.generation,reason:publication.policyEvidence.some(row=>row.kind==='known-test-risk/v1')?'known-baseline-failures-remain-failed':'failed-tests-with-accepted-environment-risk-are-not-passing-evidence'});
      if(publication.policyEvidence?.some(row=>row.kind==='test-recovery/v2'))excluded.push({phase:id,generation:phase.generation,reason:'reviewed-unselected-baseline-cases-are-not-executed'});
      if(publication.specifications){
        const manifest=namespaceSpecificationManifest(await json(publication.specifications.record,signal),{scope,workId,phaseId:id});
        if(manifest.index)records.indexes.push(await json(manifest.index,signal));
        if(manifest.planned){const planned=await json(manifest.planned,signal);
          records.planned.push(corrections.applyNamespacePlanCorrections(planned,workflow,amendments.rows,{originalMapSha256:manifest.planned.sha256}));}
      }
      if(!phaseRequiresCodeDelivery(phase)){
        if(stepResponsibilities(workflow,id).includes('verify')){
          if(publication.artifact.encoding!=='utf8')fail('This verification artifact needs its explicit text extraction owner.','ENGINE_PORT_UNAVAILABLE',{required:['verification-document-text'],phase:id});
          const bytes=await observer.bytes(publication.artifact.content,publication.artifact.content.bytes,signal);let text;
          try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(cause){throw new SingularityFlowError('The published verification text is not UTF-8.',{code:'ENGINE_STORAGE_CORRUPT',cause});}
          inspections.push({phaseId:id,text});
        }
        continue;
      }
      const code=publications.policies.codeEvidence(publication);if(!code)fail('A Code phase needs its actual accepted source and execution evidence.','ENGINE_PORT_UNAVAILABLE',{required:['retained-code-policy'],phase:id});
      const plan=await publications.specifications.sourcePlan(snapshot,id,{signal}),risk=code.report.executionException,
        tested=publication.checks?await checks.publication(publication,{signal}):risk?await checks.publicationObservation({...publication,checks:risk.checks},{signal}):null,
        acceptedCriteria=new Set(code.report.acceptance.map(row=>row.clauseId)),
        delivered={phaseId:id,generation:phase.generation,status:'ready',testRecovery:null,acceptanceCriteria:{bindings:[],witnesses:[],unattachedTags:[]},
          receipt:{status:'ready'},executions:[],preflight:[],testsOnly:true,testPaths:[]};
      const qualify=(repositoryId,path)=>{if(!plan.repositoryPlan)return path;
        const root=plan.repositoryPlan.roots.find(row=>row.repositoryId===repositoryId);if(!root)fail('The observed repository is absent from its actual approved plan.');
        return root.pathPrefix==='.'?path:root.pathPrefix+'/'+path;};
      for(const repository of code.report.repositories){
        const delivery=code.report.preflight.repositories.find(row=>row.id===repository.id)?.delivery;if(!delivery)fail('The Code view lost a repository delivery.');
        const observed=structuredClone(repository.observed);for(const claim of Object.values(observed.claims)){
          claim.observedPaths=claim.observedPaths.map(path=>qualify(repository.id,path));claim.testResults=claim.testResults.map(path=>qualify(repository.id,path));}
        records.observed.push(observed);
        delivered.testPaths.push(...delivery.testPaths.map(path=>qualify(repository.id,path)));
        delivered.testsOnly&&=delivery.paths.every(row=>delivery.testPaths.includes(row.path));
        const command=id=>repository.id+'::'+id;
        for(const witness of delivery.acceptanceCriteria.witnesses){
          if(!acceptedCriteria.has(witness.clauseId))continue;
          delivered.acceptanceCriteria.witnesses.push({...witness,commandId:command(witness.commandId),testSource:qualify(repository.id,witness.testSource)});
          delivered.acceptanceCriteria.bindings.push({clauseId:witness.clauseId,testSource:qualify(repository.id,witness.testSource)});
        }
        for(const tag of delivery.acceptanceCriteria.unattachedTags??[]){const clauseIds=(tag.clauseIds??[]).filter(id=>acceptedCriteria.has(id));
          if(clauseIds.length)delivered.acceptanceCriteria.unattachedTags.push({...tag,clauseIds,testSource:qualify(repository.id,tag.testSource)});}
        if(tested)for(const step of tested.plan.steps.filter(row=>row.repositoryId===repository.id)){
          const record=namespaceWitnessAttempt({commandId:step.command.id},tested,repository.id);
          if(!record)fail('The Code view lost an original executed command.');
          record.occurrences=record.occurrences.map(row=>delivery.testPaths.includes(row.file)?{...row,file:qualify(repository.id,row.file)}:row);
          delivered.executions.push({commandId:command(step.command.id),kind:'test-execution',status:record.status,record});
        }
      }
      if(risk&&execution.some(row=>row.kind==='test-run-risk'&&row.disposition==='active'))delivered.testRecovery={disposition:'accepted-risk',source:'test-run-risk',commandIds:delivered.executions.filter(row=>(row.record.tests?.passed??0)+(row.record.tests?.failed??0)===0).map(row=>row.commandId)};
      delivered.receipt.traceability={...delivered.acceptanceCriteria};deliveries.push(delivered);
      for(const criterion of code.report.acceptance.filter(row=>row.contract))for(const slot of criterion.contract.slots.filter(row=>row.method!=='test')){
        const observed=await witnesses.candidates(snapshot,{clauseId:criterion.clauseId,slotName:slot.slot},{signal});references.push(...observed.references);
        const actual=observed.rows.map(row=>row.result).find(row=>row.status==='met')??observed.rows[0]?.result;
        if(actual)witnessRecords.push({...actual,method:slot.method});
      }
    }
    const review=(workflow.completenessReviews??[]).findLast(row=>!row.withdrawnAt&&row.inventorySha256===source.inventory.inventorySha256)??null,
      rawGraph=rules.evidenceGraph({workflow,records,deliveries,inspections,witnessRecords,scope:source.inventory,terminal,
        ...(executionPolicies.length?{executionPolicies}: {})},{completenessReview:review}),
      mappingReviews=Object.values(workflow.phases).some(phase=>(phase.approvals??[]).some(row=>row.witnessMappings?.length)),
      reviewed=mappingReviews||(workflow.namespaceWitnessExceptionRenewals??[]).length?await createNamespaceWitnessRenewalOwner({observer,scope,workId}).effective(snapshot,{signal}):null,
      admission=reviewed?{witnessMappings:reviewed.decisions}:{},graph=reviewed?namespaceWitnessMappingInput(rawGraph,reviewed.decisions,reviewed.references):rawGraph,
      report=rules.evaluateEvidence(graph,{at,boundary:'view',mode:'projection',admission});
    if(reviewed)references.push(...reviewed.references);
    if(!same(graph.workflow,workflow))fail('The evidence projection changed its source workflow.');
    return {report,graph,admission,witnessRenewals:reviewed?.references??[],excluded,source:source.identity,readBindings:source.readBindings,references:[...new Map(references.map(ref=>[canonicalJson(ref),ref])).values()],fresh:async()=>{await source.fresh();for(const binding of source.readBindings){
        const current=await observer.record(binding.namespace,binding.key,false,signal,true);
        if((current?.version??null)!==binding.version)fail('The clarification evidence changed while the view was being read.','ENGINE_CONTEXT_CHANGED');
      }}};
  }
  async function inspect(snapshot,options={}){
    const value=await unexcepted(snapshot,options);
    if(!(snapshot.workflow.namespaceObligationRisks??[]).length)return value;
    const owned=createNamespaceObligationRiskOwner({observer,scope,workId}),proofs=await owned.admitted(snapshot,options);
    value.graph={...value.graph,inputSha256:'sha256:'+createHash('sha256').update(canonicalJson({profile:'sflow-namespace-evidence-input/v2',
      source:value.graph.inputSha256,risks:proofs.map(row=>row.reference)})).digest('hex')};
    value.report=rules.evaluateEvidence(value.graph,{at:options.at,boundary:'view',mode:'projection',admission:{...value.admission,riskDecisions:proofs.map(row=>row.value.outcome.record),
      riskBindings:owned.bindings(snapshot,value.report,proofs)}});
    for(const row of value.report.rows)for(const action of row.actions??[])if(action.operation==='decision.risk')
      action.requiredInputs=[...new Set(['operationId',...(action.requiredInputs??[])])];
    value.references=[...new Map([...value.references,...proofs.map(row=>row.reference)].map(ref=>[canonicalJson(ref),ref])).values()];return value;
  }
  return Object.freeze({inspect,unexcepted});
}
