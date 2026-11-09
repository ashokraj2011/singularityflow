/** Immutable-content writer, selected only by the explicit namespace publication host. */
import {createHash} from 'node:crypto';
import {canonicalJson,NAMESPACE_SPECIFICATION_SCHEMAS,namespaceSpecificationWriterProfile} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceSpecificationManifest,namespaceSpecificationBinding,namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=data=>createHash('sha256').update(data).digest('hex');

export function createNamespaceSpecificationWriter({observer,scope,workId,content,reader}) {
  const put=content.put.bind(content);
  async function save(value,signal) {
    const data=Buffer.from(canonicalJson(value)),expected={namespace:'evidence',sha256:hash(data),bytes:data.byteLength},saved=await put(scope,'evidence',data,{signal});
    if(!same(contentReference(saved?.reference),expected)||typeof saved.reused!=='boolean')throw new SingularityFlowError(
      'The content store returned another specification record.',{code:'ENGINE_PORT_RESULT_INVALID'});
    await observer.bytes(expected,expected.bytes,signal);return expected;
  }
  async function retain(publication,{snapshot,head,signal}={}) {
    const {values,inputs}=await reader.derive(publication,snapshot,{signal}),index=values.index?await save(values.index,signal):null,
      planned=values.planned?await save(values.planned,signal):null,repositoryPlan=values.repositoryPlan?await save(values.repositoryPlan,signal):null,
      profile=namespaceSpecificationWriterProfile({repositoryPlan:repositoryPlan!==null});
    const manifest={schemaVersion:profile.version,format:profile.format,...(profile.repositoryPlan?{repositoryPlan}:{}),
      ...namespaceSpecificationIdentity(publication),recordedAt:publication.publishedAt,artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},
      basis:{revision:snapshot.revision,head},index,planned,capabilities:values.capabilities,inputs};
    namespaceSpecificationManifest(manifest,{scope,workId,phaseId:publication.phase});
    return namespaceSpecificationBinding({schemaVersion:NAMESPACE_SPECIFICATION_SCHEMAS.binding.currentVersion,
      format:'sflow-namespace-specification-evidence-binding/v1',record:await save(manifest,signal)});
  }
  return Object.freeze({retain});
}
