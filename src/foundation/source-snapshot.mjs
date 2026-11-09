/** Source observations are portable data. Physical roots, traversal and hashing belong to SGOS. */
import { SingularityFlowError } from './failures.mjs';
import { SOURCE_SNAPSHOT_SCHEMA,admitRecordSchemaVersion } from './record-schema.mjs';

export const SOURCE_UNIT_CONTRACT='sflow-source-unit/v1';
export const SOURCE_SNAPSHOT_FORMAT='sflow-source-snapshot/v1';
// A separate optional capability. Existing source units and snapshots keep their v1 shape.
export const SOURCE_CONTENT_READER_CONTRACT='sflow-source-content-reader/v1';
export const SOURCE_CONTENT_MAXIMUM_CHUNK_BYTES=8_388_608;
export const SOURCE_LIMITS=Object.freeze({maximumFiles:50_000,maximumVisitedEntries:100_000,maximumFileBytes:536_870_912,
  maximumTotalBytes:2_147_483_648,maximumManifestBytes:16_777_216,maximumDurationMs:300_000});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const logical=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const bounded=value=>Number.isSafeInteger(value)&&value>=0;
const fail=message=>{throw new SingularityFlowError(message,{code:'SGOS_SOURCE_CONTRACT_INVALID'});};
function exact(value,fields) {
  if(!plain(value)||Reflect.ownKeys(value).length!==fields.length||!fields.every(key=>Object.hasOwn(value,key)))fail('Source facts have unknown or missing fields.');
  for(const key of fields) {const property=Object.getOwnPropertyDescriptor(value,key);
    if(!property?.enumerable||!Object.hasOwn(property,'value'))fail('Source facts must be ordinary JSON data properties.');}
}
export function sourceRelativePath(value) {
  if(typeof value!=='string'||!value||value.length>4096||value.startsWith('/')||/^[A-Za-z]:/u.test(value)
    ||/[\\\u0000-\u001f\u007f]/u.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))fail('A source path must be a bounded relative logical path.');
  return value;
}
export function sourceUnitDescriptor(value) {
  exact(value,['contract','id','projectId','repositoryId','provider','selection','limits']);
  if(value.contract!==SOURCE_UNIT_CONTRACT||![value.id,value.projectId,value.repositoryId,value.provider].every(logical))fail('Source units need an explicit project, repository, provider and identity.');
  exact(value.selection,['excludePaths']);
  if(!Array.isArray(value.selection.excludePaths)||value.selection.excludePaths.length>256)fail('Source selection exceeds its bound.');
  const seen=new Set();
  for(const path of value.selection.excludePaths){sourceRelativePath(path);if(seen.has(path))fail('Source exclusions must be distinct.');seen.add(path);}
  exact(value.limits,Object.keys(SOURCE_LIMITS));
  for(const [key,maximum] of Object.entries(SOURCE_LIMITS))if(!bounded(value.limits[key])||value.limits[key]<1||value.limits[key]>maximum)fail('Source limits must be positive and within the supported bounds.');
  return structuredClone(value);
}
export function validateSourceUnit(unit) {
  if(!unit||typeof unit.capture!=='function')fail('An explicit source unit must implement capture.');
  return sourceUnitDescriptor(unit.descriptor);
}
export function sourceSnapshot(value,descriptor) {
  descriptor=sourceUnitDescriptor(descriptor);
  try {admitRecordSchemaVersion(SOURCE_SNAPSHOT_SCHEMA,value);}
  catch(cause){throw new SingularityFlowError(cause.message,{cause,details:cause.details,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'SGOS_SOURCE_UNSUPPORTED':'SGOS_SOURCE_CONTRACT_INVALID'});}
  exact(value,['schemaVersion','format','unitId','projectId','repositoryId','provider','selection','entries']);
  if(value.format!==SOURCE_SNAPSHOT_FORMAT||value.unitId!==descriptor.id||value.projectId!==descriptor.projectId
    ||value.repositoryId!==descriptor.repositoryId||value.provider!==descriptor.provider
    ||JSON.stringify(value.selection)!==JSON.stringify(descriptor.selection)||!Array.isArray(value.entries)
    ||value.entries.length>descriptor.limits.maximumFiles)fail('The source snapshot has another identity or selection.');
  let previous=null,total=0;
  for(const entry of value.entries) {
    exact(entry,['path','sha256','bytes','executable']);sourceRelativePath(entry.path);
    if(previous!==null&&previous>=entry.path||typeof entry.sha256!=='string'||!/^([a-f0-9]{64})$/u.test(entry.sha256)||!bounded(entry.bytes)
      ||entry.bytes>descriptor.limits.maximumFileBytes||typeof entry.executable!=='boolean')fail('Source members must be ordered, distinct and bounded.');
    if(descriptor.selection.excludePaths.some(path=>entry.path===path||entry.path.startsWith(path+'/')))fail('A source snapshot contradicts its retained selection.');
    previous=entry.path;total+=entry.bytes;
    if(total>descriptor.limits.maximumTotalBytes)fail('Source bytes exceed their retained limit.');
  }
  return value;
}

export function sourceContentReaderDescriptor(value) {
  exact(value,['contract','id','source','maximumChunkBytes']);
  if(value.contract!==SOURCE_CONTENT_READER_CONTRACT||!logical(value.id)||!bounded(value.maximumChunkBytes)
    ||value.maximumChunkBytes<1||value.maximumChunkBytes>SOURCE_CONTENT_MAXIMUM_CHUNK_BYTES)fail('Source content needs an explicit bounded reader capability.');
  return {contract:value.contract,id:value.id,source:sourceUnitDescriptor(value.source),maximumChunkBytes:value.maximumChunkBytes};
}
export function validateSourceContentReader(reader) {
  if(!reader||typeof reader.read!=='function')fail('An explicit source content reader must implement read.');
  return sourceContentReaderDescriptor(reader.descriptor);
}
export function sourceContentReadRequest(value,reader) {
  reader=sourceContentReaderDescriptor(reader);exact(value,['entry','offset','maximumBytes']);
  const e=value.entry;exact(e,['path','sha256','bytes','executable']);sourceRelativePath(e.path);
  if(typeof e.sha256!=='string'||!/^([a-f0-9]{64})$/u.test(e.sha256)||!bounded(e.bytes)
    ||e.bytes>reader.source.limits.maximumFileBytes||typeof e.executable!=='boolean'
    ||!bounded(value.offset)||value.offset>e.bytes||!bounded(value.maximumBytes)||value.maximumBytes<1
    ||value.maximumBytes>reader.maximumChunkBytes)fail('A source content read needs an exact member and bounded byte range.');
  const path=e.path.toLocaleLowerCase('en-US');
  if(reader.source.selection.excludePaths.some(value=>{const excluded=value.toLocaleLowerCase('en-US');return path===excluded||path.startsWith(excluded+'/');})) {
    fail('A source content read cannot escape its selected source boundary.');
  }
  return {entry:{...e},offset:value.offset,maximumBytes:value.maximumBytes};
}
export function sourceContentReadResult(value,request,reader) {
  const selected=sourceContentReadRequest(request,reader);exact(value,['entry','offset','data']);
  exact(value.entry,['path','sha256','bytes','executable']);
  if(Object.keys(selected.entry).some(key=>value.entry[key]!==selected.entry[key])||value.offset!==selected.offset
    ||!(value.data instanceof Uint8Array)||value.data.byteLength!==Math.min(selected.maximumBytes,selected.entry.bytes-selected.offset)) {
    fail('The source content reader returned another member or an incomplete range.');
  }
  return value;
}
