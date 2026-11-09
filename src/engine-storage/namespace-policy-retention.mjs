/** Concrete immutable-content retention. Lifecycle acceptance remains the publication writer's duty. */
import {createHash} from 'node:crypto';
import {canonicalJson,NAMESPACE_PHASE_POLICY_SCHEMAS} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {namespaceAnalysisManifest,namespacePolicyEvidenceBinding,SPECIFICATION_ANALYSIS_EVIDENCE} from './namespace-policy-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
export function createNamespacePublicationPolicyWriter({observer,content,scope,workId,reader}) {
  const put=content.put.bind(content);
  async function save(value,signal) {
    const data=Buffer.from(canonicalJson(value)),expected={namespace:'evidence',sha256:createHash('sha256').update(data).digest('hex'),bytes:data.byteLength},saved=await put(scope,'evidence',data,{signal});
    if(!same(contentReference(saved?.reference),expected)||typeof saved.reused!=='boolean')throw new SingularityFlowError('The content store returned another analysis record.',{code:'ENGINE_PORT_RESULT_INVALID'});
    await observer.bytes(expected,expected.bytes,signal);return expected;
  }
  async function retain(publication,{snapshot,head,signal}={}) {
    const value=await reader.candidate(publication,snapshot,{signal});
    if(value.gate.errors.length)throw new SingularityFlowError('Repair the current artifact from the specification analysis before publication.',{
      code:'ARTIFACT_AUTHORING_INCOMPLETE',details:{phase:publication.phase,path:publication.artifact.sourceKey,errors:value.gate.errors,
        findings:value.gate.report.findings,operation:'phase.draft.write'}});
    const report=await save(value.gate.report,signal),manifest={schemaVersion:NAMESPACE_PHASE_POLICY_SCHEMAS.analysis.currentVersion,
      format:'sflow-namespace-specification-analysis/v1',...namespaceSpecificationIdentity(publication),recordedAt:publication.publishedAt,
      artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},basis:{revision:snapshot.revision,head},previous:value.previous,report};
    namespaceAnalysisManifest(manifest,{scope,workId,phaseId:publication.phase});
    const binding=namespacePolicyEvidenceBinding({schemaVersion:NAMESPACE_PHASE_POLICY_SCHEMAS.binding.currentVersion,
      format:'sflow-namespace-phase-policy-evidence-binding/v1',kind:SPECIFICATION_ANALYSIS_EVIDENCE,record:await save(manifest,signal)});
    return {binding,report};
  }
  return Object.freeze({retain});
}
