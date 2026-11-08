/** Machine-private working records. Shared lifecycle authority is never written by this codec. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { NAMESPACE_DRAFT_SCHEMAS,admitRecordSchemaVersion } from '../foundation/record-schema.mjs';
import { exactObject,namespaceIdentifier,namespaceRevision } from '../sda/namespace/values.mjs';
import { contentReference } from '../sda/content/contract.mjs';

const fail=message=>{throw new SingularityFlowError(message,{code:'ENGINE_STORAGE_CORRUPT'});};
export function namespaceDraftRecord(kind,value) {
  if(!Object.hasOwn(NAMESPACE_DRAFT_SCHEMAS,kind)||!value||Object.hasOwn(value,'schemaVersion')||Object.hasOwn(value,'format'))fail('Invalid local draft record metadata.');
  return {schemaVersion:NAMESPACE_DRAFT_SCHEMAS[kind].currentVersion,format:`sflow-namespace-phase-draft-${kind}/v1`,...value};
}
export function namespaceDraftValue(kind,value,binding) {
  if(!Object.hasOwn(NAMESPACE_DRAFT_SCHEMAS,kind))fail('Unknown local draft record family.');
  try {admitRecordSchemaVersion(NAMESPACE_DRAFT_SCHEMAS[kind],value);}
  catch(cause){throw new SingularityFlowError(cause.message,{cause,details:cause.details,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
  const common=['schemaVersion','format','projectId','deviceId','workId','phaseId'];
  if(value.format!==`sflow-namespace-phase-draft-${kind}/v1`||['projectId','deviceId','workId','phaseId'].some(key=>value[key]!==binding[key]))fail('The local draft belongs to another project, device, Story or phase.');
  if(kind==='body') {
    exactObject(value,[...common,'payload']);
    if(!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload))fail('A local draft body needs an explicit payload.');
  }else if(kind==='head') {
    exactObject(value,[...common,'body','operationId']);
    if(contentReference(value.body).namespace!=='local')fail('A private draft needs machine-local content.');
    namespaceIdentifier(value.operationId,'Draft operation ID');
  }else {
    exactObject(value,[...common,'operationId','parametersSha256','expectedRevision','body']);
    namespaceIdentifier(value.operationId,'Draft operation ID');namespaceRevision(value.expectedRevision);
    if(typeof value.parametersSha256!=='string'||!/^([a-f0-9]{64})$/u.test(value.parametersSha256)
      ||contentReference(value.body).namespace!=='local')fail('Invalid local draft operation identity.');
  }
  return value;
}
