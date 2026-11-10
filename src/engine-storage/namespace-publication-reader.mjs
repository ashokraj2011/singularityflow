/** Verify immutable publication records and their actual shared bytes; never authorize a write. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phasePublicationBindingValue,canonicalJson} from '../foundation/record-schema.mjs';
import {artifactBytesAreText,artifactContentObservation} from '../kernel/artifact-content.mjs';
import {namespacePublicationValue} from './namespace-publication-contract.mjs';
import {namespaceAcceptedEvidence} from './namespace-lifecycle-receipt-reader.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {createNamespacePublicationPolicyReader} from './namespace-policy-reader.mjs';
const same=(a,b)=>a===undefined||b===undefined?a===b:canonicalJson(a)===canonicalJson(b);
const hash=value=>createHash('sha256').update(value).digest('hex');
const error=(message,code,cause=undefined)=>new SingularityFlowError(message,{code,cause});

export function createNamespacePublicationReader({observer,scope,workId,checks=null}) {
  const bytes=observer.bytes.bind(observer);
  const specifications=createNamespaceSpecificationReader({observer,scope,workId,checks});
  const policies=createNamespacePublicationPolicyReader({observer,scope,workId,checks});
  function artifacts(publication){return [{path:publication.artifact.sourceKey,sha256:publication.artifact.content.sha256,size:publication.artifact.content.bytes},
    ...policies.resources(publication).filter(row=>['artifact-set-member','retained-output'].includes(row.kind)).map(row=>({path:row.sourceKey,sha256:row.reference.sha256,size:row.reference.bytes}))];}
  function assertArtifacts(publication,phase){const expected=artifacts(publication),observed=phase?.artifacts;
    if(!Array.isArray(observed)||observed.length!==expected.length||!expected.every(row=>observed.filter(item=>item?.path===row.path&&item.sha256===row.sha256&&item.size===row.size).length===1))throw error(
      'The phase output inventory differs from its exact retained publication.','ENGINE_STORAGE_CORRUPT');}
  async function read(binding,phaseId,{signal,specificationTraversal,policyTraversal}={}) {
    phasePublicationBindingValue(binding);
    let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(binding.record,binding.record.bytes,signal)));}
    catch(cause){if(cause.code)throw cause;throw error('The publication record is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',cause);}
    const publication=namespacePublicationValue(value,{projectId:scope.projectId,workId,phaseId});
    if(publication.generation!==binding.generation)throw error('The publication reference has another generation.','ENGINE_STORAGE_CORRUPT');
    const data=await bytes(publication.artifact.content,publication.artifact.content.bytes,signal),text=artifactBytesAreText(data);
    if(publication.artifact.encoding!==(text?'utf8':'binary')||publication.artifact.fingerprint!==(text?'sha256:'+hash(artifactContentObservation(data.toString('utf8')).fingerprintText):null)) {
      throw error('The retained publication encoding or authored fingerprint differs from its actual bytes.','ENGINE_STORAGE_CORRUPT');
    }
    for(const resource of publication.inputs)if(resource.reference.namespace!=='local')await bytes(resource.reference,resource.reference.bytes,signal);
    if(publication.checks){
      if(typeof checks?.publication!=='function')throw error('This publication requires its retained check-proof reader.','ENGINE_PORT_UNAVAILABLE');
      await checks.publication(publication,{signal});
    }
    await specifications.verify(publication,{signal,specificationTraversal});
    await policies.verify(publication,{signal,policyTraversal});
    return publication;
  }
  async function accepted(binding,phaseId,options={}) {
    const value=await read(binding,phaseId,options),proof=await namespaceAcceptedEvidence(observer,binding,value,'phase.publish',options);
    const phase=proof.state.workflow.phases[phaseId];
    if(phase?.generation!==value.generation||!phase.publicationBindings?.some(item=>same(item,binding))
      ||!phase.artifacts?.some(item=>item.path===value.artifact.sourceKey&&item.sha256===value.artifact.content.sha256&&item.size===value.artifact.content.bytes)
      ||!proof.plan.evidence.some(ref=>same(ref,value.artifact.content)))throw error(
      'The accepted publication lost its exact artifact or generation binding.','ENGINE_STORAGE_CORRUPT');
    verifyPlan(value,proof.plan);
    assertArtifacts(value,phase);
    return value;
  }
  function verifyPlan(value,plan) {
    specifications.verifyPlan(value,plan);
    policies.verifyPlan(value,plan);
    if(value.checks&&(!checks.readBindings(value.checks).every(row=>plan.readBindings?.some(item=>same(item,row)))
      ||!plan.evidence.some(ref=>same(ref,value.checks.result.content))))throw error(
      'The publication did not conditionally accept its retained check evidence.','ENGINE_STORAGE_CORRUPT');
  }
  return Object.freeze({read,accepted,verifyPlan,artifacts,assertArtifacts,specifications,policies});
}
