/** One read-only owner for namespace submission proof across every explicit host. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {namespaceSubmissionValue,namespaceSubmissionBindingValue} from './namespace-submission-contract.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,cause=undefined)=>new SingularityFlowError(message,{code,cause});

export function createNamespaceSubmissionReader({observer,scope,workId}) {
  const bytes=observer.bytes.bind(observer),publications=createNamespacePublicationReader({observer,scope,workId});
  async function decode(binding,phaseId,{signal}={}) {
    namespaceSubmissionBindingValue(binding);let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(binding.record,binding.record.bytes,signal)));}
    catch(cause){if(cause.code)throw cause;throw error('The review packet is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',cause);}
    return namespaceSubmissionValue(value,{projectId:scope.projectId,workId,phaseId});
  }
  async function publication(value,{signal}={}) {
    const published=await publications.read(value.publication,value.phase,{signal});
    if(!same(published.configuration,value.configuration))throw error('The review packet has another configuration pin.','ENGINE_STORAGE_CORRUPT');
    return published;
  }
  async function review(snapshot,phaseId,{signal}={}) {
    if(!snapshot||snapshot.workflow.currentPhase!==phaseId||snapshot.workflow.phases[phaseId]?.status!=='awaiting_approval')return null;
    const phase=snapshot.workflow.phases[phaseId],binding=phase.namespaceSubmission;
    if(!binding)return null;
    const value=await decode(binding,phaseId,{signal}),bindings=phase.publicationBindings,submissions=snapshot.workflow.lineage?.submissions;
    if(!Array.isArray(bindings)||!Array.isArray(submissions))throw error('The submitted publication or lineage inventory is invalid.','ENGINE_STORAGE_CORRUPT');
    const current=bindings.find(item=>item?.generation===phase.generation),lineage=submissions.findLast(item=>item?.phase===phaseId&&item.generation===phase.generation);
    if(value.generation!==phase.generation||!current||!same(value.publication,current)||!same(value.configuration,snapshot.configuration)
      ||phase.submittedAt!==value.submittedAt||lineage?.packetSha256!==binding.record.sha256||!same(lineage.packetReference,binding.record)) {
      throw error('The current review is not the exact retained submission.','ENGINE_STORAGE_CORRUPT');
    }
    const published=await publication(value,{signal});
    if(!Array.isArray(phase.artifacts)||phase.artifacts.length!==1||!phase.artifacts.some(item=>item?.path===published.artifact.sourceKey&&item.sha256===published.artifact.content.sha256&&item.size===published.artifact.content.bytes)) {
      throw error('The submitted artifact metadata differs from its publication.','ENGINE_STORAGE_CORRUPT');
    }
    return {workId,phase:phaseId,generation:phase.generation,packetSha256:binding.record.sha256,sourceRevision:value.baseRevision,observedRevision:snapshot.revision};
  }
  return Object.freeze({decode,publication,review});
}
