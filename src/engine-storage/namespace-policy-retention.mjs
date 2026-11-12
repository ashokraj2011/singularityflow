/** Concrete immutable-content retention. Lifecycle acceptance remains the publication writer's duty. */
import {createHash} from 'node:crypto';
import {canonicalJson,NAMESPACE_PHASE_POLICY_SCHEMAS,namespaceCodePolicyProfile,namespaceConformancePolicyProfile,namespaceArtifactSetRecordProfile} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
import {namespaceAnalysisManifest,namespaceConstitutionManifest,namespaceAssignmentManifest,PHASE_ASSIGNMENT_EVIDENCE,namespaceCodeManifest,namespaceCodeInputManifest,namespaceConformanceManifest,namespacePolicyEvidenceBinding,SPECIFICATION_ANALYSIS_EVIDENCE,CODE_INPUT_EVIDENCE} from './namespace-policy-contract.mjs';
import {clarificationRecord,CLARIFICATION_EVIDENCE} from './namespace-clarification-reader.mjs';
import {namespaceArtifactSetManifest,ARTIFACT_SET_EVIDENCE} from './namespace-artifact-set-reader.mjs';
import {CONSTITUTION_POLICY_EVIDENCE} from './namespace-constitution-reader.mjs';
import {artifactBytesAreText} from '../kernel/artifact-content.mjs';
import {NAMESPACE_CONVERGENCE_SCHEMAS} from '../foundation/record-schema.mjs';
import {namespaceConvergenceManifest} from './namespace-convergence-policy.mjs';
import {CONVERGENCE_POLICY_EVIDENCE} from './namespace-convergence-contract.mjs';
import {DOCUMENT_REVIEW_EVIDENCE,namespaceDocumentReviewManifest} from './namespace-document-review.mjs';
import {TEST_RECOVERY_EVIDENCE,namespaceTestRecoveryManifest} from './namespace-test-recovery-reader.mjs';
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
  async function retainDocumentReview(publication,{snapshot,head,signal}={}){
    const value=await reader.documentReviewCandidate(publication,snapshot,{signal}),report=await save(value.report,signal),manifest={schemaVersion:1,
      format:'sflow-namespace-document-review/v1',...namespaceSpecificationIdentity(publication),recordedAt:publication.publishedAt,
      artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},basis:{revision:snapshot.revision,head},report};
    namespaceDocumentReviewManifest(manifest,{scope,workId,phaseId:publication.phase});
    return {binding:namespacePolicyEvidenceBinding({schemaVersion:1,format:'sflow-namespace-phase-policy-evidence-binding/v1',kind:DOCUMENT_REVIEW_EVIDENCE,record:await save(manifest,signal)}),report};
  }
  async function retainRecovery(publication,{snapshot,head,signal}={}){
    const value=await reader.recoveryCandidate(publication,snapshot,{signal}),report=await save(value.report,signal),manifest={schemaVersion:1,
      format:'sflow-namespace-test-recovery-policy-manifest/v1',...namespaceSpecificationIdentity(publication),recordedAt:publication.publishedAt,
      artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},basis:{revision:snapshot.revision,head},report};
    namespaceTestRecoveryManifest(manifest,{scope,workId,phaseId:publication.phase});
    return {binding:namespacePolicyEvidenceBinding({schemaVersion:1,format:'sflow-namespace-phase-policy-evidence-binding/v1',
      kind:TEST_RECOVERY_EVIDENCE,record:await save(manifest,signal)}),report};
  }
  async function retainClarification(publication,{snapshot,head,signal}={}) {
    const value=await reader.clarificationCandidate(publication,snapshot,{signal}),found=value.checkpoint.accepted;
    const manifest=clarificationRecord('publication',{...namespaceSpecificationIdentity(publication),recordedAt:publication.publishedAt,
      basis:{revision:snapshot.revision,head},context:value.context.value,contextSha256:value.context.sha256,observed:value.checkpoint.observed,
      response:found?{operationId:found.value.operationId,record:found.reference}:null});
    return namespacePolicyEvidenceBinding({schemaVersion:1,format:'sflow-namespace-phase-policy-evidence-binding/v1',kind:CLARIFICATION_EVIDENCE,record:await save(manifest,signal)});
  }
  async function retainCode(publication,{snapshot,head,signal}={}){
    const value=await reader.codeCandidate(publication,snapshot,{signal}),report=await save(value.report,signal),profile=namespaceCodePolicyProfile('codeReport',value.report),
      manifest={schemaVersion:profile.version,format:namespaceCodePolicyProfile('code',{schemaVersion:profile.version}).format,...namespaceSpecificationIdentity(publication),recordedAt:publication.publishedAt,
        artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},basis:{revision:snapshot.revision,head},report};
    namespaceCodeManifest(manifest,{scope,workId,phaseId:publication.phase});
    return {binding:namespacePolicyEvidenceBinding({schemaVersion:1,format:'sflow-namespace-phase-policy-evidence-binding/v1',kind:profile.kind,record:await save(manifest,signal)}),report,
      sourceBinding:{source:value.report.preflight.source,baseline:value.report.preflight.baseline,...(value.report.preflight.outputs?{outputs:value.report.preflight.outputs}:{})}};
  }
  async function retainCodeInputs(publication,{snapshot,head,signal}={}){
    const value=await reader.codeInputCandidate(publication,snapshot,{signal}),report=await save(value.report,signal),
      manifest={schemaVersion:1,format:'sflow-namespace-code-input-policy/v1',...namespaceSpecificationIdentity(publication),recordedAt:publication.publishedAt,
        artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},basis:{revision:snapshot.revision,head},report};
    namespaceCodeInputManifest(manifest,{scope,workId,phaseId:publication.phase});
    return {binding:namespacePolicyEvidenceBinding({schemaVersion:1,format:'sflow-namespace-phase-policy-evidence-binding/v1',kind:CODE_INPUT_EVIDENCE,record:await save(manifest,signal)}),report};
  }
  async function retainConformance(publication,{snapshot,head,signal}={}){
    const value=await reader.conformanceCandidate(publication,snapshot,{signal}),report=await save(value.report,signal),
      profile=namespaceConformancePolicyProfile('conformance',value.report),manifest={schemaVersion:profile.version,format:profile.format,...namespaceSpecificationIdentity(publication),recordedAt:publication.publishedAt,
        artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},basis:{revision:snapshot.revision,head},report};
    namespaceConformanceManifest(manifest,{scope,workId,phaseId:publication.phase});
    return {binding:namespacePolicyEvidenceBinding({schemaVersion:1,format:'sflow-namespace-phase-policy-evidence-binding/v1',kind:profile.kind,record:await save(manifest,signal)}),report};
  }
  async function retainArtifactSet(publication,{snapshot,head,signal,members}={}){
    const value=await reader.artifactSetCandidate(publication,snapshot,{signal,members});
    for(const file of value.files){const saved=await put(scope,'evidence',file.data,{signal});
      if(!same(contentReference(saved?.reference),file.content)||typeof saved.reused!=='boolean')throw new SingularityFlowError('The content store returned another output member.',{code:'ENGINE_PORT_RESULT_INVALID'});
      await observer.bytes(file.content,file.content.bytes,signal);}
    const report=await save(value.report,signal),profile=namespaceArtifactSetRecordProfile('manifest',value.report),
      manifest={schemaVersion:profile.version,format:profile.format,...namespaceSpecificationIdentity(publication),
      recordedAt:publication.publishedAt,artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},basis:{revision:snapshot.revision,head},report};
    namespaceArtifactSetManifest(manifest,{scope,workId,phaseId:publication.phase});
    return {binding:namespacePolicyEvidenceBinding({schemaVersion:1,format:'sflow-namespace-phase-policy-evidence-binding/v1',kind:ARTIFACT_SET_EVIDENCE,record:await save(manifest,signal)}),
      report,members:value.files.map(({path,content,data})=>({path,content,encoding:artifactBytesAreText(data)?'utf8':'binary'}))};
  }
  async function retainAssignment(publication,{snapshot,head,signal}={}){
    const value=await reader.assignmentCandidate(publication,snapshot,{signal}),report=await save(value.report,signal),manifest={
      schemaVersion:NAMESPACE_PHASE_POLICY_SCHEMAS.assignment.currentVersion,format:'sflow-namespace-phase-assignment-policy/v1',...namespaceSpecificationIdentity(publication),
      recordedAt:publication.publishedAt,artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},basis:{revision:snapshot.revision,head},report};
    namespaceAssignmentManifest(manifest,{scope,workId,phaseId:publication.phase});
    return {binding:namespacePolicyEvidenceBinding({schemaVersion:1,format:'sflow-namespace-phase-policy-evidence-binding/v1',kind:PHASE_ASSIGNMENT_EVIDENCE,record:await save(manifest,signal)}),report};
  }
  async function retainConstitution(publication,{snapshot,head,signal}={}){
    const value=await reader.constitutionCandidate(publication,snapshot,{signal}),report=await save(value.report,signal),manifest={
      schemaVersion:NAMESPACE_PHASE_POLICY_SCHEMAS.constitution.currentVersion,format:'sflow-namespace-constitution-policy/v1',...namespaceSpecificationIdentity(publication),
      recordedAt:publication.publishedAt,artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},basis:{revision:snapshot.revision,head},report};
    namespaceConstitutionManifest(manifest,{scope,workId,phaseId:publication.phase});
    return {binding:namespacePolicyEvidenceBinding({schemaVersion:1,format:'sflow-namespace-phase-policy-evidence-binding/v1',kind:CONSTITUTION_POLICY_EVIDENCE,record:await save(manifest,signal)}),report};
  }
  async function retainConvergence(publication,{snapshot,head,signal}={}){
    const value=await reader.convergenceCandidate(publication,snapshot,{signal});
    for(const item of value.pendingEvidence){const saved=await put(scope,'evidence',item.bytes,{signal});
      if(!same(contentReference(saved?.reference),item.reference)||typeof saved.reused!=='boolean')throw new SingularityFlowError('The content store returned another convergence projection.',{code:'ENGINE_PORT_RESULT_INVALID'});
      await observer.bytes(item.reference,item.reference.bytes,signal);}
    const report=await save(value.report,signal),manifest={schemaVersion:NAMESPACE_CONVERGENCE_SCHEMAS.policy.currentVersion,
      format:'sflow-namespace-convergence-policy/v1',...namespaceSpecificationIdentity(publication),recordedAt:publication.publishedAt,
      artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content},basis:{revision:snapshot.revision,head},report};
    namespaceConvergenceManifest(manifest,{scope,workId,phaseId:publication.phase});
    return {binding:namespacePolicyEvidenceBinding({schemaVersion:1,format:'sflow-namespace-phase-policy-evidence-binding/v1',kind:CONVERGENCE_POLICY_EVIDENCE,record:await save(manifest,signal)}),report};
  }
  return Object.freeze({retain,retainRecovery,retainDocumentReview,retainClarification,retainCode,retainCodeInputs,retainConformance,retainArtifactSet,retainAssignment,retainConstitution,retainConvergence});
}
