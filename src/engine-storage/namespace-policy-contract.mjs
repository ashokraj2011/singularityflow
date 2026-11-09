/** Typed immutable policy evidence. A binding is an identity, never proof of acceptance. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {admitRecordSchemaVersion,NAMESPACE_PHASE_POLICY_SCHEMAS,phasePublicationBindingValue} from '../foundation/record-schema.mjs';
import {exactObject,namespaceRevision} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {lifecycleHead} from './namespace-lifecycle-contract.mjs';
export const NAMESPACE_POLICY_PUBLICATION_PROFILE='sflow-policy-publication/v1';
export const SPECIFICATION_ANALYSIS_EVIDENCE='specification-analysis/v1';
const evidence=value=>{if(contentReference(value).namespace!=='evidence')throw Error('Policy evidence requires shared immutable content.');};
function invalid(cause) {return new SingularityFlowError('The retained phase-policy evidence is invalid.',{cause,
  code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED','ENGINE_STORAGE_UNSUPPORTED'].includes(cause?.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
export function namespacePolicyEvidenceBinding(value) {
  try {
    admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS.binding,value);exactObject(value,['schemaVersion','format','kind','record']);
    if(value.format!=='sflow-namespace-phase-policy-evidence-binding/v1'||typeof value.kind!=='string'||!/^[a-z][a-z0-9-]{0,63}\/v[1-9][0-9]{0,3}$/u.test(value.kind))throw Error('Invalid policy contract identity.');
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
