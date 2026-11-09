/** Optional source-control observations. Existing source-unit/snapshot v1 shapes stay unchanged. */
import {SingularityFlowError} from './failures.mjs';
import {canonicalJson,sourceControlObservationRecordProfile,jsonValueContract} from './record-schema.mjs';
import {sourceUnitDescriptor,sourceSnapshot} from './source-snapshot.mjs';
export const SOURCE_CONTROL_READER_CONTRACT='sflow-source-control-reader/v1';
export const SOURCE_CONTROL_OBSERVATION_FORMAT='sflow-source-control-observation/v1';
export const SOURCE_CONTROL_READER_CONTRACT_V2='sflow-source-control-reader/v2';
export const SOURCE_CONTROL_OBSERVATION_FORMAT_V2='sflow-source-control-observation/v2';
export const SOURCE_CONTROL_LIMITS=Object.freeze({maximumChanges:100_000,maximumManifestBytes:33_554_432,maximumDurationMs:300_000});
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(v);
const opaque=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\u0000-\u0020\u007f]/u.test(v);
const sha=v=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/u.test(v);
const invalid=message=>{throw new SingularityFlowError(message,{code:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});};
function exact(v,keys){if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v))||Reflect.ownKeys(v).length!==keys.length)invalid('Source-control facts must contain their exact declared fields.');
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(v,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))invalid('Source-control facts must be ordinary data properties.');}}
export function sourceControlReaderDescriptor(v){
  const v2=v?.contract===SOURCE_CONTROL_READER_CONTRACT_V2;
  exact(v,['contract','id','source','profile','baselineRevision','executableSha256','environmentSha256','limits',...(v2?['originRevision']:[])]);
  if(![SOURCE_CONTROL_READER_CONTRACT,SOURCE_CONTROL_READER_CONTRACT_V2].includes(v.contract)||!id(v.id)||!opaque(v.profile)||!opaque(v.baselineRevision)||v2&&!opaque(v.originRevision)||!sha(v.executableSha256)||!sha(v.environmentSha256))invalid('Source control needs an explicit identity, baseline and execution binding.');
  const source=sourceUnitDescriptor(v.source);exact(v.limits,Object.keys(SOURCE_CONTROL_LIMITS));
  for(const [key,max]of Object.entries(SOURCE_CONTROL_LIMITS))if(!Number.isSafeInteger(v.limits[key])||v.limits[key]<1||v.limits[key]>max)invalid('Source-control limits exceed the supported bounds.');
  return {...v,source,limits:{...v.limits}};
}
export function validateSourceControlReader(v){if(typeof v?.capture!=='function')invalid('Bind an explicit source-control reader capability.');return sourceControlReaderDescriptor(v.descriptor);}
export function sourceControlCaptureRequest(v){
  exact(v,['workId','phase','generation','generationIntentId']);
  if(!id(v.workId)||!id(v.phase)||!Number.isSafeInteger(v.generation)||v.generation<1||v.generationIntentId!==null&&!opaque(v.generationIntentId))invalid('Source control needs an exact Story, phase, generation and generation-intent binding.');
  return {...v};
}
export function sourceControlObservation(v,descriptor,subject){
  descriptor=sourceControlReaderDescriptor(descriptor);subject=sourceControlCaptureRequest(subject);
  v=jsonValueContract({maximumBytes:descriptor.limits.maximumManifestBytes,maximumDepth:32,maximumNodes:250_000,
    inputCode:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID',limitCode:'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'}).namespaceJson(v);
  const v2=descriptor.contract===SOURCE_CONTROL_READER_CONTRACT_V2;
  try{sourceControlObservationRecordProfile(descriptor.contract,v);}catch(cause){throw new SingularityFlowError(cause.message,{cause,details:cause.details,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'SGOS_SOURCE_CONTROL_UNSUPPORTED':'SGOS_SOURCE_CONTROL_CONTRACT_INVALID'});}
  exact(v,['schemaVersion','format','readerId','profile','subject','current','baseline','control',...(v2?['origin']:[])]);
  if(v.format!==(v2?SOURCE_CONTROL_OBSERVATION_FORMAT_V2:SOURCE_CONTROL_OBSERVATION_FORMAT)||v.readerId!==descriptor.id||v.profile!==descriptor.profile||canonicalJson(v.subject)!==canonicalJson(subject))invalid('The source-control observation belongs to another request.');
  exact(v.current,['snapshot','revision']);sourceSnapshot(v.current.snapshot,descriptor.source);
  if(!sha(v.current.revision))invalid('Source-control observations need the selected current-source revision.');
  exact(v.baseline,['revision','entries']);if(v.baseline.revision!==descriptor.baselineRevision)invalid('The source-control baseline changed.');
  // Reuse member/selection bounds without claiming a new filesystem capture of the old baseline.
  sourceSnapshot({...v.current.snapshot,entries:v.baseline.entries},descriptor.source);
  if(v2){
    exact(v.origin,['revision','entries','patch','trackedPaths']);
    if(v.origin.revision!==descriptor.originRevision||!Array.isArray(v.origin.patch)||v.origin.patch.length>descriptor.limits.maximumChanges
      ||!Array.isArray(v.origin.trackedPaths)||v.origin.trackedPaths.length>descriptor.source.limits.maximumFiles)invalid('Source-line origins need their exact revision and bounded positions.');
    sourceSnapshot({...v.current.snapshot,entries:v.origin.entries},descriptor.source);
  }
  if(!v.control||typeof v.control!=='object'||Array.isArray(v.control)||Array.isArray(v.control.entries)&&v.control.entries.length>descriptor.limits.maximumChanges
    ||new TextEncoder().encode(canonicalJson(v)).byteLength>descriptor.limits.maximumManifestBytes)invalid('Source-control observations exceed their declared data bound.');
  return v;
}
