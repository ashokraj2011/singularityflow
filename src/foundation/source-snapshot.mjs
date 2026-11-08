/** Source observations are portable data. Physical roots, traversal and hashing belong to SGOS. */
import { SingularityFlowError } from './failures.mjs';
import { SOURCE_SNAPSHOT_SCHEMA,admitRecordSchemaVersion } from './record-schema.mjs';

export const SOURCE_UNIT_CONTRACT='sflow-source-unit/v1';
export const SOURCE_SNAPSHOT_FORMAT='sflow-source-snapshot/v1';
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
