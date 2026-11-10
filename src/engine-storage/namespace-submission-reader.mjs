import {createNamespaceSourceReviewOwners} from './namespace-source-review-reader.mjs';
/** One read-only owner for namespace submission proof across every explicit host. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {namespaceSubmissionValue,namespaceSubmissionBindingValue} from './namespace-submission-contract.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceApprovalReader} from './namespace-approval-reader.mjs';
import {assertSubmittedRoutingSelection} from '../kernel/submission-routing.mjs';
import {namespaceAcceptedEvidence} from './namespace-lifecycle-receipt-reader.mjs';
import {withCodePolicyTraversal} from './namespace-code-policy.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,cause=undefined)=>new SingularityFlowError(message,{code,cause});

export function createNamespaceSubmissionReader({observer,scope,workId,checks=null}) {
  const bytes=observer.bytes.bind(observer),publications=createNamespacePublicationReader({observer,scope,workId,checks}),
    votes=createNamespaceApprovalReader({observer,scope,workId,checks});
  let reviewOwners;const sourceReviews=()=>reviewOwners??=createNamespaceSourceReviewOwners({observer,scope,workId});
  async function decode(binding,phaseId,{signal}={}) {
    namespaceSubmissionBindingValue(binding);let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(binding.record,binding.record.bytes,signal)));}
    catch(cause){if(cause.code)throw cause;throw error('The review packet is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',cause);}
    return namespaceSubmissionValue(value,{projectId:scope.projectId,workId,phaseId});
  }
  async function publication(value,options={}) {
    const published=await publications.accepted(value.publication,value.phase,options);
    if(!same(published.configuration,value.configuration))throw error('The review packet has another configuration pin.','ENGINE_STORAGE_CORRUPT');
    if(!same(published.checks??null,value.checks??null))throw error('The review packet differs from its published check evidence.','ENGINE_STORAGE_CORRUPT');
    return published;
  }
  async function inspectOne(snapshot,phaseId,signal,cache) {
    if(!snapshot?.workflow.phases?.[phaseId])return null;
    const phase=snapshot.workflow.phases[phaseId],binding=phase.namespaceSubmission;
    if(!binding)return null;
    namespaceSubmissionBindingValue(binding);
    // A successor can retain old submission history without becoming submitted itself.
    if(binding.generation!==phase.generation)return null;
    if(['in_progress','not_started'].includes(phase.status)&&phase.reworkRevalidation?.generation===phase.generation)return null;
    const value=await decode(binding,phaseId,{signal}),bindings=phase.publicationBindings,submissions=snapshot.workflow.lineage?.submissions;
    if(!Array.isArray(bindings)||!Array.isArray(submissions))throw error('The submitted publication or lineage inventory is invalid.','ENGINE_STORAGE_CORRUPT');
    const current=bindings.find(item=>item?.generation===phase.generation),lineage=submissions.findLast(item=>item?.phase===phaseId&&item.generation===phase.generation);
    if(value.generation!==phase.generation||!current||!same(value.publication,current)||!same(value.configuration,snapshot.configuration)
      ||phase.submittedAt!==value.submittedAt||lineage?.packetSha256!==binding.record.sha256||!same(lineage.packetReference,binding.record)) {
      throw error('The current review is not the exact retained submission.','ENGINE_STORAGE_CORRUPT');
    }
    const accepted=await namespaceAcceptedEvidence(observer,binding,value,'phase.submit',{signal,snapshot,cache:cache.receipts});
    const submitted=accepted.state.workflow.phases[phaseId];
    if(submitted?.generation!==value.generation||submitted.status!=='awaiting_approval'||!same(submitted.namespaceSubmission,binding)
      ||submitted.submittedAt!==value.submittedAt)throw error('The accepted submission lost its exact review binding.','ENGINE_STORAGE_CORRUPT');
    const published=await publication(value,{signal,snapshot,cache:cache.receipts,specificationTraversal:cache.specificationTraversal,policyTraversal:cache.policyTraversal});
    if(value.checks&&(!checks.readBindings(value.checks).every(row=>accepted.plan.readBindings?.some(item=>same(item,row)))
      ||!accepted.plan.evidence.some(ref=>same(ref,value.checks.result.content))))throw error(
      'The submission did not conditionally retain its checked publication.','ENGINE_STORAGE_CORRUPT');
    if(value.sourceReview){
      const head=accepted.plan.basis.head,original=await observer.state(await bytes(head.state,head.state.bytes,signal),head,{signal}),
        review=await sourceReviews().acceptance({revision:accepted.plan.basis.headVersion,configuration:head.configuration,workflow:original.workflow},phaseId,{signal,policyTraversal:cache.policyTraversal});
      if(!review||!same(review.binding,value.sourceReview)||!review.references.every(ref=>accepted.plan.evidence.some(row=>same(row,ref))))throw error('The submitted review differs from its actual accepted review and human dispositions.','ENGINE_STORAGE_CORRUPT');
    }
    publications.assertArtifacts(published,phase);
    if(publications.policies.owners(published).includes('artifact-set')&&!publications.policies.evidence(published).every(ref=>accepted.plan.evidence.some(row=>same(row,ref))))throw error(
      'The typed output bundle was not retained by its exact submission.','ENGINE_STORAGE_CORRUPT');
    await routingProof(snapshot,phaseId,value,signal,cache);
    return {binding,value,published,review:{workId,phase:phaseId,generation:phase.generation,packetSha256:binding.record.sha256,
      sourceRevision:value.baseRevision,observedRevision:snapshot.revision}};
  }
  async function routingProof(snapshot,phaseId,value,signal,cache) {
    if(value.routing!==undefined&&value.routing!==null) {
      try{assertSubmittedRoutingSelection(snapshot.workflow,snapshot.workflow.phases[phaseId],value.routing);}
      catch(cause){throw error('The retained routing values differ from their pinned decision inputs.','ENGINE_STORAGE_CORRUPT',cause);}
      for(const source of value.routing.reused) {
        const earlier=await approved(snapshot,source.phase,signal,cache),record=earlier?.value.routing?.record;
        if(!earlier||!same(earlier.binding.record,source.packet)||!record||record.decision!==source.decision
          ||earlier.value.generation!==source.generation||Object.entries(source.values).some(([name,item])=>!Object.hasOwn(record.values,name)||!same(record.values[name],item))) {
          throw error('A reused decision input has no matching retained source packet.','ENGINE_STORAGE_CORRUPT');
        }
      }
    }
  }
  function inspectCached(snapshot,phaseId,signal,cache) {
    if(!cache.packets.has(phaseId))cache.packets.set(phaseId,inspectOne(snapshot,phaseId,signal,cache));
    return cache.packets.get(phaseId);
  }
  async function approved(snapshot,phaseId,signal,cache) {
    const proof=await inspectCached(snapshot,phaseId,signal,cache);if(!proof)return null;
    if(!cache.approvals.has(phaseId))cache.approvals.set(phaseId,votes.activeAccepted(snapshot,phaseId,proof,{signal,cache:cache.receipts,policyTraversal:cache.policyTraversal}));
    const active=await cache.approvals.get(phaseId);
    if(snapshot.workflow.phases[phaseId].status!=='approved'||active.votes.at(-1)?.value.thresholdReached!==true) {
      throw error('A reused decision input has no retained human approval threshold.','ENGINE_STORAGE_CORRUPT');
    }
    return proof;
  }
  const traversal=(specificationTraversal,policyTraversal)=>({packets:new Map(),approvals:new Map(),receipts:{},specificationTraversal,policyTraversal});
  async function inspect(snapshot,phaseId,{signal,policyTraversal}={}) {return withCodePolicyTraversal(policyTraversal,token=>inspectCached(snapshot,phaseId,signal,traversal(undefined,token)));}
  async function context(snapshot,phaseId,{signal,policyTraversal}={}) {
    return withCodePolicyTraversal(policyTraversal,async token=>{const cache=traversal(undefined,token),proof=await inspectCached(snapshot,phaseId,signal,cache);
      return {proof,sources:proof?(await Promise.all([...cache.packets.values()])).filter(item=>item&&item!==proof):[]};});
  }
  async function inspectApprovedMany(snapshot,phaseIds,{signal,specificationTraversal,policyTraversal}={}) {
    return withCodePolicyTraversal(policyTraversal,async token=>{const cache=traversal(specificationTraversal,token),result=[];
      for(const phaseId of phaseIds)result.push(await approved(snapshot,phaseId,signal,cache));return result;});
  }
  async function verifyRouting(snapshot,phaseId,value,{signal}={}) {
    namespaceSubmissionValue(value,{projectId:scope.projectId,workId,phaseId});
    await routingProof(snapshot,phaseId,value,signal,traversal());
  }
  async function review(snapshot,phaseId,options) {
    if(!snapshot||snapshot.workflow.currentPhase!==phaseId||snapshot.workflow.phases[phaseId]?.status!=='awaiting_approval')return null;
    return (await inspect(snapshot,phaseId,options))?.review??null;
  }
  return Object.freeze({decode,publication,inspect,context,inspectApprovedMany,verifyRouting,review,
    publicationOwners:value=>[...publications.specifications.owners(value),...publications.policies.owners(value)],
    publicationChecklist:publications.policies.checklist,publicationPolicyEvidence:publications.policies.evidence,
    publicationApproval:publications.policies.assertApproval,publicationRequiresDisposition:publications.policies.requiresDisposition,
    publicationResources:publications.policies.resources,publicationClarification:publications.policies.clarificationEvidence,publicationCodeEvidence:publications.policies.codeEvidence});
}
