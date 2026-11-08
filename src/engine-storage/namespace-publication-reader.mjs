/** Verify immutable publication records and their actual shared bytes; never authorize a write. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phasePublicationBindingValue} from '../foundation/record-schema.mjs';
import {artifactBytesAreText,artifactContentObservation} from '../kernel/artifact-content.mjs';
import {namespacePublicationValue} from './namespace-publication-contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const error=(message,code,cause=undefined)=>new SingularityFlowError(message,{code,cause});

export function createNamespacePublicationReader({observer,scope,workId}) {
  const bytes=observer.bytes.bind(observer);
  async function read(binding,phaseId,{signal}={}) {
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
    return publication;
  }
  return Object.freeze({read});
}
