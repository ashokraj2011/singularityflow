import {createNamespaceKnownTestRiskOwner} from './namespace-known-test-risk-reader.mjs';
import {createNamespaceSelectiveTestRecoveryOwner} from './namespace-selective-test-recovery-reader.mjs';
import {createNamespaceTestCohortOwner} from './namespace-test-cohort-reader.mjs';
/** Actual decision observations only. No transactions, command rendering or execution. */
import {canonicalJson,namespaceTestRiskRecordProfile} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceDecisionListPolicy,namespaceDecisionListActions} from '../kernel/decision-plan.mjs';
import {matchApprovalAuthority} from '../kernel/approval-policy.mjs';
import {scopeAuthorities} from '../kernel/scope-decisions.mjs';
import {CLAUSE_LINKED_DISPOSITIONS} from '../kernel/scope-statements.mjs';
import {endpointTaken,omissionAuthorities} from '../kernel/applicability.mjs';
import {upstreamIssueAuthorities,upstreamIssueStates} from '../kernel/upstream-issues.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {storyTestCommandPolicies,namespaceTestCohortReviewInput} from '../kernel/test-recovery.mjs';
import {selectiveTestRecoveryReviewInput} from '../kernel/evidence-reuse.mjs';
import {phaseNeedsGeneration} from '../kernel/phase-policy.mjs';
import {routingChoiceSelection} from '../kernel/routed-approval.mjs';
import {createNamespaceScopeDecisionOwners} from './namespace-scope-reader.mjs';
import {createNamespaceUpstreamOwners} from './namespace-upstream-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {createNamespaceTestRiskOwner} from './namespace-test-risk-reader.mjs';
import {createNamespaceWitnessRenewalOwner} from './namespace-witness-renewals.mjs';
import {createNamespaceObligationRiskOwner} from './namespace-obligation-risk-reader.mjs';
import {qualifiedClauseIds} from '../foundation/traceability-ids.mjs';
import {namespaceTestRiskState} from '../kernel/test-recovery.mjs';
import {createNamespaceConformanceDecisionOwner} from './namespace-conformance-decision-reader.mjs';
import {createNamespaceRoutingReceiptReader} from './namespace-routing-receipt-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceWitnessOwners} from './namespace-witness-reader.mjs';
import {createNamespaceForwardAmendmentOwners} from './namespace-forward-reader.mjs';
import {pendingForwardAmendments,pendingAmendmentRevalidations} from '../kernel/upstream-issues.mjs';
import {STARTER_CHECKLIST} from '../engine-compatibility/node-specification-policy.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),commandsRules=storyTestCommandPolicies(NODE_TEXT_DIGESTS),
  reason={reason:{minimum:20,maximum:1000,default:''}};
export function createNamespaceDecisionListReader({observer,scope,workId,runtime=null}){
  const scopes=createNamespaceScopeDecisionOwners({observer,scope,workId,runtime}),upstream=createNamespaceUpstreamOwners({observer,scope,workId}),
    commands=createNamespaceTestCommandOwners({observer,scope,workId}),gaps=createNamespaceConformanceDecisionOwner({observer,scope,workId}),
    routes=createNamespaceRoutingReceiptReader({observer,scope,workId}),checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),
    publications=createNamespacePublicationReader({observer,scope,workId,checks}),witnesses=createNamespaceWitnessOwners({observer,scope,workId});
  async function read(snapshot,{principal,permissions,at,phaseId=snapshot.workflow.currentPhase,bound=null,signal}={}){
    const workflow=snapshot.workflow,observations=[],references=[],source={},pendingEvidence=[],fresh=[];let obligationRisks=null;
    const allowed=(operation,groups)=>workflow.status==='in_progress'&&phaseId===workflow.currentPhase&&principal.actor.actorKind==='human'&&permissions.includes(operation)&&groups.length>0
      &&matchApprovalAuthority(workflow.resolution.approvalAuthorities,{mode:'required',authorities:groups,requiredAuthorities:[],minimum:1},principal.actor.identity).authorized;
    const option=(id,operation,inputs,groups,needs=reason,recordable=true)=>({id,operation,inputs,groups,needs,recordable,allowed:allowed(operation,groups)});
    const selectedScope=await scopes.inventory(snapshot,'decision.completeness',{signal,bound:bound?.scope});
    source.scope=selectedScope.identity;references.push(...selectedScope.references);pendingEvidence.push(...selectedScope.pendingEvidence);fresh.push(selectedScope.fresh);
    const groups=scopeAuthorities(workflow);
    for(const item of selectedScope.inventory.items.filter(row=>row.disposition==='unresolved'))observations.push({kind:'scope-disposition',key:item.id,
      options:['included','existing','excluded','deferred','informative','duplicate','superseded'].map(disposition=>option('scope-'+disposition,'decision.scope',
        {item:item.id,disposition},groups,{...reason,...(CLAUSE_LINKED_DISPOSITIONS.includes(disposition)?{clause:{known:selectedScope.knownClauseIds}}:{})}))});
    if(selectedScope.inventory.structurallyComplete&&!(workflow.completenessReviews??[]).some(row=>!row.withdrawnAt&&row.inventorySha256===selectedScope.inventory.inventorySha256))
      observations.push({kind:'completeness-review',key:'completeness:'+selectedScope.inventory.inventorySha256,offered:true,
        options:[option('completeness-review','decision.completeness',{confirm:selectedScope.inventory.inventorySha256},groups,
          {...reason,article:{articles:STARTER_CHECKLIST.articles.map(({id})=>({id})),decisions:['satisfied','exception','not-applicable']}})]});
    for(const responsibility of [...new Set((endpointTaken(workflow)?.omits??[]).map(row=>row.responsibility))].sort()){
      if((workflow.applicability??[]).some(row=>row.responsibility===responsibility&&!row.withdrawnAt))continue;
      observations.push({kind:'applicability',key:'applicability:'+responsibility,options:[option('does-not-apply','decision.applicability',
        {responsibility},omissionAuthorities(workflow,responsibility))]});
    }
    references.push(...await upstream.admitted(snapshot,{signal}));
    source.upstream={issues:workflow.upstreamIssues??[],decisions:workflow.upstreamIssueDecisions??[]};
    if((workflow.forwardAmendments??[]).length){
      references.push(...await createNamespaceForwardAmendmentOwners({observer,scope,workId}).admitted(snapshot,{signal}));
      source.amendments={proposals:workflow.forwardAmendments,decisions:workflow.forwardAmendmentDecisions??[],revalidations:workflow.amendmentRevalidations??[]};
      for(const row of pendingForwardAmendments(workflow)){
        const choice=option('review-amendment','forward-amendment.decide',{amendmentId:row.id},workflow.phases[row.phase].approvalPolicy.authorities??[],{},false);
        choice.action={operation:'forward-amendment.decide',inputs:{workId,amendmentId:row.id,confirmation:row.id},
          requiredInputs:['operationId','decision','reason'],prerequisites:['authorized-human-reviews-exact-replacement']};
        observations.push({kind:'forward-amendment',key:row.id,options:[choice]});
      }
      for(const row of pendingAmendmentRevalidations(workflow)){
        const choice=option('review-amended-input','forward-amendment.revalidate',{phaseId:row.phase,amendmentId:row.amendment},workflow.phases[row.phase].approvalPolicy.authorities??[],{},false);
        choice.action={operation:'forward-amendment.revalidate',inputs:{workId,phaseId:row.phase,amendmentId:row.amendment},requiredInputs:['operationId','outcome','reason'],
          prerequisites:['authorized-human-reviews-amended-input-and-original-delivery']};
        observations.push({kind:'amendment-revalidation',key:row.amendment+':'+row.phase,options:[choice]});
      }
    }
    const latest=new Date(Date.parse(at)+90*86400000).toISOString().slice(0,10),defaultExpiry=new Date(Date.parse(at)+30*86400000).toISOString().slice(0,10),
      riskNeeds={...reason,expires:{default:defaultExpiry,latest}};
    if(Object.values(workflow.phases).some(phase=>(phase.approvals??[]).some(row=>row.witnessMappings?.length))){
      const actual=await createNamespaceWitnessRenewalOwner({observer,scope,workId}).effective(snapshot,{signal});
      source.witnessRenewals={decisions:actual.decisions,references:actual.references};references.push(...actual.references);
      for(const mapping of actual.decisions.filter(row=>row.decision==='exception'&&Date.parse(row.expiresAt)<=Date.parse(at))){
        const phase=workflow.phases[actual.owners[mapping.mappingSha256]];if(!phase)continue;
        if(observations.some(row=>row.key==='witness-exception:'+mapping.mappingSha256))continue;
        const choice=option('renew-original-exception','decision.witness-exception',{phaseId:phase.id,mappingSha256:mapping.mappingSha256},phase.approvalPolicy.authorities,{},false);
        choice.action={operation:'decision.witness-exception',inputs:{workId,phaseId:phase.id,mappingSha256:mapping.mappingSha256},requiredInputs:['expires','reason'],
          prerequisites:['original-phase-authorized-human-reviews-exact-test-exception']};
        observations.push({kind:'witness-exception-renewal',key:'witness-exception:'+mapping.mappingSha256,options:[choice]});
      }
    }
    if((permissions.includes('decision.risk')||(workflow.namespaceObligationRisks??[]).length)&&workflow.resolution.spec?.mode==='enforce'){
      const owner=createNamespaceObligationRiskOwner({observer,scope,workId});obligationRisks={...await owner.observations(snapshot,{signal,at}),rules:owner.rules};
      const {observed,proofs,bindings}=obligationRisks,records=proofs.map(row=>row.value.outcome.record);
      source.obligationRisks={profile:'sflow-namespace-obligation-risk-list/v1',input:observed.graph.inputSha256,receipts:proofs.map(row=>row.reference),bindings};
      references.push(...observed.references.filter(row=>row.namespace==='evidence'),...proofs.map(row=>row.reference));fresh.push(observed.fresh);
      for(const obligation of observed.report.rows.flatMap(row=>row.obligations)){
        if(obligation.subject==='story'||!owner.rules.riskEligibility(obligation).eligible)continue;
        const groups=owner.rules.riskAuthorities(workflow,obligation),state=owner.rules.riskDecisionState(workflow,obligation,{at},records),
          owners=obligation.owningSteps.length?obligation.owningSteps:(workflow.resolution.obligationGraph?.nodes??[]).filter(row=>row.responsibilities.includes(obligation.responsibility)).map(row=>row.id);
        if((workflow.upstreamIssues??[]).some(row=>owners.includes(row.phase)&&qualifiedClauseIds(row.about).has(obligation.subject)))continue;
        if(state?.state==='active'&&bindings[state.decision.id]==='current'){
          observations.push({kind:'obligation-risk',key:state.decision.id,offered:true,options:[option('revoke-risk','decision.risk',{revoke:state.decision.id},groups)]});continue;
        }
        observations.push({kind:'obligation-risk',key:obligation.id,offered:true,options:owner.rules.RISK_CATEGORIES.map(category=>option('accept-'+category,'decision.risk',
          {obligationId:obligation.id,category},groups,riskNeeds))});
      }
    }
    for(const row of upstreamIssueStates(workflow,at).filter(row=>['open','expired'].includes(row.status))){const issue=row.issue,groups=upstreamIssueAuthorities(workflow,issue.phase);
      observations.push({kind:'upstream-issue',key:issue.id,options:['accept-risk','dismiss'].map(outcome=>option(outcome,'upstream.decide',
        {issueId:issue.id,outcome},groups,outcome==='accept-risk'?riskNeeds:reason))});}
    const identities=[];
    for(const id of workflow.phaseOrder){
      if(phaseId!==null&&id!==phaseId)continue;
      if(!(workflow.testCommandDecisions??[]).some(row=>row.id&&row.phase===id))continue;
      const proof=await commands.commands(snapshot,id,{signal});references.push(...proof.references);identities.push(proof.identity);
      for(const request of (workflow.testCommandDecisions??[]).filter(row=>row.id&&row.phase===id)){
        if(commandsRules.storyTestCommandState(workflow,request.id)?.state!=='requested')continue;
        const phase=workflow.phases[id],recordable=!['awaiting_approval','approved','skipped'].includes(phase.status),groups=testRunRiskAuthorities(workflow,id),
          selfProhibited=phase.approvalPolicy?.allowSelfApproval===false&&request.requestedBy===principal.actor.principalId;
        const choice=option('accept-test-command','test-command.decide',{accept:request.id},groups,{reason:{minimum:0,maximum:1000,default:''}},recordable);
        if(selfProhibited)choice.allowed=false;
        observations.push({kind:'test-command',key:request.id,options:[choice]});
      }
    }
    source.commands=identities;
    if((workflow.namespaceTestRunRisks??[]).length){
      const risks=await createNamespaceTestRiskOwner({observer,scope,workId}).admitted(snapshot,{signal});
      source.testRunRisks=risks.map(row=>row.reference);references.push(...source.testRunRisks);
      for(const proof of risks){const row=proof.value.outcome.record;if(!row.id)continue;
        const state=namespaceTestRiskState(workflow,row,{at});if(phaseId!==null&&row.phase!==phaseId&&(!namespaceTestRiskRecordProfile('record',row).executionRisk||state==='active'))continue;
        const groups=testRunRiskAuthorities(workflow,row.phase),
          choice=state==='active'?option('revoke-test-risk','decision.test-risk',{revoke:row.id},groups):option('review-test-risk','test-risk.context',{phaseId:row.phase},groups,{},false);
        if(state!=='active')choice.action={operation:'test-risk.context',inputs:{workId,phaseId:row.phase},requiredInputs:[],prerequisites:['inspect-original-command-and-current-risk']};
        observations.push({kind:'test-run-risk',key:row.id+':'+state,offered:true,options:[choice]});
      }
    }
    if((workflow.namespaceKnownTestRisks??[]).length){
      const owner=createNamespaceKnownTestRiskOwner({observer,scope,workId}),proofs=await owner.admitted(snapshot,{signal}),rows=proofs.map(row=>row.value.outcome.record),latest=new Map();
      source.knownTestRisks=proofs.map(row=>row.reference);references.push(...source.knownTestRisks);
      for(const row of rows)if(row.id)latest.set(row.scopeSha256,row);
      for(const row of latest.values()){
        const state=owner.rules.state(rows,row,at);if(phaseId!==null&&phaseId!==row.phase&&state==='active')continue;
        const inputs={workId,phaseId:row.phase,baselineOperationId:row.context.baseline.operationId,observedOperationId:row.context.observed.operationId},
          choice=option('review-known-test-risk','test-risk.known-context',inputs,testRunRiskAuthorities(workflow,row.phase),{},false);
        choice.action={operation:'test-risk.known-context',inputs,requiredInputs:[],prerequisites:['review-original-baseline-independent-inventory-and-current-execution']};
        observations.push({kind:'test-run-risk',key:row.id+':'+state,offered:state==='active',options:[choice]});
      }
    }
    if((workflow.namespaceSelectiveTestRecoveries??[]).length){
      const owner=createNamespaceSelectiveTestRecoveryOwner({observer,scope,workId}),proofs=await owner.admitted(snapshot,{signal}),rows=proofs.map(row=>row.value.outcome.record),latest=new Map();
      source.selectiveTestRecoveries=proofs.map(row=>row.reference);references.push(...source.selectiveTestRecoveries);
      for(const row of rows)if(row.id)latest.set(row.contextSha256,row);
      for(const row of latest.values()){
        const state=owner.rules.state(rows,row,at);if(phaseId!==null&&phaseId!==row.phase&&state==='active')continue;
        const inputs={workId,...selectiveTestRecoveryReviewInput({record:row,rows:row.context.rows})},
          choice=option('review-selective-recovery','test-recovery.select-context',inputs,testRunRiskAuthorities(workflow,row.phase),{},false);
        choice.action={operation:'test-recovery.select-context',inputs,requiredInputs:[],prerequisites:['review-original-independent-inventory-selected-files-and-current-environment']};
        observations.push({kind:'test-cohort',key:row.id+':'+state,offered:state==='active',options:[choice]});
      }
    }
    if((workflow.namespaceTestCohorts??[]).length){
      const owner=createNamespaceTestCohortOwner({observer,scope,workId}),proofs=await owner.admitted(snapshot,{signal}),rows=proofs.map(row=>row.value.outcome.record),latest=new Map();
      source.testCohorts=proofs.map(row=>row.reference);references.push(...source.testCohorts);
      for(const row of rows)if(row.id)latest.set(row.selectionSha256,row);
      for(const row of latest.values()){
        const state=owner.rules.state(rows,row,at);if(phaseId!==null&&phaseId!==row.phase&&state==='active')continue;
        const input={workId,...namespaceTestCohortReviewInput(row)},
          choice=option('review-observed-cohort','test-cohort.context',input,testRunRiskAuthorities(workflow,row.phase),{},false);
        choice.action={operation:'test-cohort.context',inputs:input,requiredInputs:[],prerequisites:['review-original-baseline-and-observed-execution']};
        observations.push({kind:'test-cohort',key:row.id+':'+state,offered:state==='active',options:[choice]});
      }
    }
    const phase=workflow.phases[phaseId],binding=phase?.publicationBindings?.find(row=>row.generation===phase.generation);
    if(binding&&!phaseNeedsGeneration(workflow,phase)){
      const publication=await publications.accepted(binding,phaseId,{signal});references.push(binding.record,...publications.policies.evidence(publication));
      source.currentPublication=binding;
      const code=publications.policies.codeEvidence(publication),witnessContexts=[];
      if(code){
        for(const criterion of code.report.acceptance??[])for(const slot of criterion.contract?.slots??[]){
          if(!['visual','inspection'].includes(slot.method))continue;
          const query={clauseId:criterion.clauseId,slotName:slot.slot},current=await witnesses.candidates(snapshot,query,{signal}),choices=[],
            groups=current.eligible.flatMap(id=>workflow.phases[id].approvalPolicy.authorities??[]);
          references.push(...current.references);witnessContexts.push(...current.rows);
          if(current.rows.some(row=>row.result.status==='met'))continue;
          for(const row of current.rows){const inputs={...query,file:row.identity.file.path},choice=option('review-'+choices.length,'witness.context',inputs,groups,{},false);
            choice.action={operation:'witness.context',inputs:{workId,...inputs},prerequisites:['human-inspects-exact-retained-output']};choices.push(choice);
          }
          if(!choices.length){const choice=option('select-published-output','witness.context',query,groups,{},false);
            choice.action={operation:'witness.context',inputs:{workId,...query},requiredInputs:['file'],prerequisites:['retain-and-publish-real-output','human-inspects-exact-retained-output']};choices.push(choice);}
          observations.push({kind:'human-witness',key:'witness:'+criterion.clauseId+':'+slot.slot,options:choices});
        }
      }
      source.witnesses=witnessContexts;
      if(phase.status==='awaiting_approval'){
        const choice=option('review-submission','phase.review',{workId,phaseId},phase.approvalPolicy.authorities??[],{},false);
        choice.action={operation:'phase.review',inputs:{workId,phaseId},prerequisites:['human-reviews-submitted-documents-before-approval']};
        observations.push({kind:'phase-approval',key:'approval:'+phaseId+':'+phase.generation,options:[choice]});
      }
      if(publications.policies.conformanceEvidence(publication)){
        const original=await gaps.owner.read(snapshot,{phaseId},{signal}),retained=await gaps.retained(snapshot,original,{signal,at}),linked=await gaps.linked(snapshot,original,{signal,at});
        source.conformance=original.identity;references.push(...original.references,...retained.flatMap(row=>[row.reference,...row.source.references]),...linked.flatMap(row=>row.references));
        for(const gap of original.gaps)for(const owner of gap.owners){
          if((gap.issueRefs??[]).some(id=>original.proof.report.upstream?.some(issue=>issue.id===id&&issue.phase===owner)))continue;
          if(retained.some(row=>row.active&&row.value.request.clauseId===gap.clauseId&&row.value.request.ownerPhase===owner))continue;
          if(obligationRisks&&obligationRisks.proofs.some(proof=>{const record=proof.value.outcome.record;
            return record.id&&obligationRisks.bindings[record.id]==='current'&&proof.value.source.owners.some(row=>row.phase===owner)
              &&obligationRisks.observed.report.rows.find(row=>row.id===gap.clauseId)?.obligations.some(obligation=>{
                const state=obligationRisks.rules.riskDecisionState(workflow,obligation,{at},obligationRisks.proofs.map(row=>row.value.outcome.record));
                return state?.state==='active'&&state.decision.id===record.id;});}))continue;
          observations.push({kind:'conformance-gap',key:'conformance:'+gap.clauseId+':'+owner,
            options:['accept-risk','dismiss'].map(outcome=>option(outcome,'conformance.decide',
              {phaseId,expected:original.expected,clauseId:gap.clauseId,ownerPhase:owner,outcome},[...(workflow.phases[owner]?.approvalPolicy.authorities??[])],outcome==='accept-risk'?riskNeeds:reason))});
        }
      }
    }
    if(workflow.pendingDecision){
      const question=await routes.question(snapshot,{signal});source.routing={question:question.selected.question,approval:question.approved.binding};
      references.push(question.approved.binding.record,question.proof.value.publication.record);
      const pending=question.selected.question,choices=pending.options??[];
      observations.push({kind:'routing-decision',key:'routing:'+pending.key,options:await Promise.all(choices.map(async row=>{
        const inputs={option:row.id,expected:pending.key},selection=routingChoiceSelection(workflow,{...inputs,reason:'Review the pinned route.'});
        const qualification=await routes.requirements(snapshot,question,{phase:selection.phase,outcome:selection.outcome},{signal});references.push(...qualification.references);
        return option(row.id,'decision.choose',inputs,pending.by??[],reason,qualification.required.length===0);
      }))});
    }
    if(bound&&!same(source,bound))throw new SingularityFlowError('The original decision observations changed.',{code:'ENGINE_STORAGE_CORRUPT'});
    const policy=namespaceDecisionListPolicy({workId,phase:phaseId,revision:snapshot.revision,actor:principal,source,observations},NODE_TEXT_DIGESTS);
    return {policy,actions:namespaceDecisionListActions(observations),source,pendingEvidence,readBindings:selectedScope.readBindings,references:[...new Map(references.map(ref=>[canonicalJson(ref),ref])).values()],
      fresh:async()=>{for(const check of fresh)await check();}};
  }
  async function freshScope(snapshot,source,{signal}={}){
    const actual=await scopes.inventory(snapshot,'decision.completeness',{signal}),stable=({inventorySha256,...value})=>value;
    if(!same(stable(actual.identity),stable(source.scope)))throw new SingularityFlowError(
      'The reviewed source or authored scope changed during this batch. Review the current list.',{code:'ENGINE_CONTEXT_CHANGED'});
    await actual.fresh();
  }
  return Object.freeze({read,freshScope});
}
