/** Typed immutable policy evidence. A binding is an identity, never proof of acceptance. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {admitRecordSchemaVersion,NAMESPACE_PHASE_POLICY_SCHEMAS,phasePublicationBindingValue,namespaceCodePolicyProfile,namespaceCodeInputPolicyProfile,namespaceConformancePolicyProfile,namespacePhasePolicyBindingProfile} from '../foundation/record-schema.mjs';
import {exactObject,namespaceRevision} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {lifecycleHead} from './namespace-lifecycle-contract.mjs';
export const NAMESPACE_POLICY_PUBLICATION_PROFILE='sflow-policy-publication/v1';
export const SPECIFICATION_ANALYSIS_EVIDENCE='specification-analysis/v1';
export const PHASE_ASSIGNMENT_EVIDENCE='phase-assignment/v1';
export const CODE_DELIVERY_EVIDENCE='code-delivery/v1';
export const CODE_REWORK_EVIDENCE='code-delivery/v2';
const codeEvidenceKinds=Object.freeze(Array.from({length:NAMESPACE_PHASE_POLICY_SCHEMAS.code.maximumReadableVersion},(_,index)=>'code-delivery/v'+(index+1)));
export const isCodePolicyEvidence=kind=>codeEvidenceKinds.includes(kind);
export const CODE_INPUT_EVIDENCE='approved-code-inputs/v1';
export const isCodeInputEvidence=kind=>[CODE_INPUT_EVIDENCE,'approved-code-inputs/v2','approved-code-inputs/v3','approved-code-inputs/v4'].includes(kind);
export const CONFORMANCE_EVIDENCE='conformance/v1';
export const isConformanceEvidence=kind=>[CONFORMANCE_EVIDENCE,'conformance/v2','conformance/v3','conformance/v4'].includes(kind);
const evidence=value=>{if(contentReference(value).namespace!=='evidence')throw Error('Policy evidence requires shared immutable content.');};
function invalid(cause) {return new SingularityFlowError('The retained phase-policy evidence is invalid.',{cause,
  code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED','ENGINE_STORAGE_UNSUPPORTED'].includes(cause?.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
/** Common envelope for newly versioned single-report owners. Original record readers stay unchanged. */
export function namespaceEvidencePolicyManifest(value,{scope,workId,phaseId,family,format}){
  try{admitRecordSchemaVersion(family,value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','baseRevision','configuration',
      'draft','actor','agentId','recordedAt','artifact','basis','report']);
    if(value.format!==format||value.projectId!==scope.projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another policy identity.');
    exactObject(value.basis,['revision','head']);lifecycleHead(value.basis.head,scope,workId);
    if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.basis.revision)!==value.baseRevision)throw Error('Another policy basis.');
    exactObject(value.artifact,['key','content']);evidence(value.artifact.content);evidence(value.report);
  }catch(cause){throw invalid(cause);}return value;
}
export function namespacePolicyEvidenceBinding(value) {
  try {
    const profile=namespacePhasePolicyBindingProfile(value);exactObject(value,['schemaVersion','format','kind','record']);
    if(value.format!==profile.format||typeof value.kind!=='string'||!/^[a-z][a-z0-9-]{0,63}\/v[1-9][0-9]{0,3}$/u.test(value.kind))throw Error('Invalid policy contract identity.');
    evidence(value.record);
  }catch(cause){throw invalid(cause);}return value;
}
export function namespaceAnalysisManifest(value,{scope,workId,phaseId}) {
  try {
    admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS.analysis,value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','baseRevision','configuration',
      'draft','actor','agentId','recordedAt','artifact','basis','previous','report']);
    if(value.format!=='sflow-namespace-specification-analysis/v1'||value.projectId!==scope.projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another analysis identity.');
    exactObject(value.basis,['revision','head']);lifecycleHead(value.basis.head,scope,workId);
    if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.basis.revision)!==value.baseRevision)throw Error('Another analysis basis.');
    exactObject(value.artifact,['key','content']);evidence(value.artifact.content);evidence(value.report);
    if(value.previous!==null){phasePublicationBindingValue(value.previous);if(value.previous.generation>=value.generation)throw Error('Analysis history must precede this generation.');}
  }catch(cause){throw invalid(cause);}return value;
}
export function namespaceCodeManifest(value,{scope,workId,phaseId}){
  try{const profile=namespaceCodePolicyProfile('code',value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','baseRevision','configuration','draft','actor','agentId','recordedAt','artifact','basis','report']);
    if(value.format!==profile.format||value.projectId!==scope.projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another Code evidence identity.');
    exactObject(value.basis,['revision','head']);lifecycleHead(value.basis.head,scope,workId);
    if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.basis.revision)!==value.baseRevision)throw Error('Another Code evidence basis.');
    exactObject(value.artifact,['key','content']);evidence(value.artifact.content);evidence(value.report);
  }catch(cause){throw invalid(cause);}return value;
}
export function namespaceCodeInputManifest(value,{scope,workId,phaseId}){
  try{const profile=namespaceCodeInputPolicyProfile('codeInputs',value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','baseRevision','configuration','draft','actor','agentId','recordedAt','artifact','basis','report']);
    if(value.format!==profile.format||value.projectId!==scope.projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another Code input identity.');
    exactObject(value.basis,['revision','head']);lifecycleHead(value.basis.head,scope,workId);
    if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.basis.revision)!==value.baseRevision)throw Error('Another Code input basis.');
    exactObject(value.artifact,['key','content']);evidence(value.artifact.content);evidence(value.report);
  }catch(cause){throw invalid(cause);}return value;
}
export function namespaceAssignmentManifest(value,{scope,workId,phaseId}){
  try{admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS.assignment,value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','baseRevision','configuration','draft','actor','agentId','recordedAt','artifact','basis','report']);
    if(value.format!=='sflow-namespace-phase-assignment-policy/v1'||value.projectId!==scope.projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another assignment identity.');
    exactObject(value.basis,['revision','head']);lifecycleHead(value.basis.head,scope,workId);
    if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.basis.revision)!==value.baseRevision)throw Error('Another assignment basis.');
    exactObject(value.artifact,['key','content']);evidence(value.artifact.content);evidence(value.report);
  }catch(cause){throw invalid(cause);}return value;
}
export function namespaceConstitutionManifest(value,{scope,workId,phaseId}){
  try{admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS.constitution,value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','baseRevision','configuration','draft','actor','agentId','recordedAt','artifact','basis','report']);
    if(value.format!=='sflow-namespace-constitution-policy/v1'||value.projectId!==scope.projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another constitution identity.');
    exactObject(value.basis,['revision','head']);lifecycleHead(value.basis.head,scope,workId);
    if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.basis.revision)!==value.baseRevision)throw Error('Another constitution basis.');
    exactObject(value.artifact,['key','content']);evidence(value.artifact.content);evidence(value.report);
  }catch(cause){throw invalid(cause);}return value;
}
export function namespaceConformanceManifest(value,{scope,workId,phaseId}){
  try{const profile=namespaceConformancePolicyProfile('conformance',value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','baseRevision','configuration','draft','actor','agentId','recordedAt','artifact','basis','report']);
    if(value.format!==profile.format||value.projectId!==scope.projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another conformance identity.');
    exactObject(value.basis,['revision','head']);lifecycleHead(value.basis.head,scope,workId);
    if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.basis.revision)!==value.baseRevision)throw Error('Another conformance basis.');
    exactObject(value.artifact,['key','content']);evidence(value.artifact.content);evidence(value.report);
  }catch(cause){throw invalid(cause);}return value;
}
