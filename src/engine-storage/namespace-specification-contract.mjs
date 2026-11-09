/** Versioned references to deterministic specification records, never an approval claim. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {admitRecordSchemaVersion,NAMESPACE_SPECIFICATION_SCHEMAS,phasePublicationBindingValue} from '../foundation/record-schema.mjs';
import {exactObject,namespaceIdentifier,namespaceRevision} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {lifecycleHead} from './namespace-lifecycle-contract.mjs';

export const NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE='sflow-specification-publication/v1';
export const namespaceSpecificationIdentity=publication=>Object.fromEntries(['projectId','workId','phase','generation','operationId','baseRevision','configuration','draft','actor','agentId']
  .map(key=>[key,publication[key]]));
const evidence=value=>{if(contentReference(value).namespace!=='evidence')throw Error('Specification records require shared evidence content.');};
const corrupt=cause=>new SingularityFlowError('The retained specification evidence is invalid.',{cause,
  code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED','ENGINE_STORAGE_UNSUPPORTED'].includes(cause?.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});

export function namespaceSpecificationBinding(value) {
  try {
    admitRecordSchemaVersion(NAMESPACE_SPECIFICATION_SCHEMAS.binding,value);
    exactObject(value,['schemaVersion','format','record']);
    if(value.format!=='sflow-namespace-specification-evidence-binding/v1')throw Error('Unknown specification binding format.');
    evidence(value.record);
  }catch(cause){throw corrupt(cause);}
  return value;
}

export function namespaceSpecificationManifest(value,{scope,workId,phaseId}) {
  try {
    admitRecordSchemaVersion(NAMESPACE_SPECIFICATION_SCHEMAS.manifest,value);
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','baseRevision','configuration',
      'draft','actor','agentId','recordedAt','artifact','basis','index','planned','capabilities','inputs']);
    if(value.format!=='sflow-namespace-specification-evidence/v1'||value.projectId!==scope.projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another specification evidence identity.');
    for(const key of ['projectId','workId','phase','operationId'])namespaceIdentifier(value[key],key);
    exactObject(value.basis,['revision','head']);
    if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.basis.revision)!==value.baseRevision)throw Error('Another specification basis revision.');
    lifecycleHead(value.basis.head,scope,workId);
    exactObject(value.artifact,['key','content']);evidence(value.artifact.content);
    if(value.index!==null)evidence(value.index);
    if(value.planned!==null)evidence(value.planned);
    if(!Array.isArray(value.inputs)||value.inputs.length>4096)throw Error('Invalid specification source bound.');
    const phases=new Set();
    for(const input of value.inputs) {
      exactObject(input,['phase','generation','publication']);namespaceIdentifier(input.phase,'Specification source phase');
      phasePublicationBindingValue(input.publication);
      if(input.generation!==input.publication.generation||phases.has(input.phase))throw Error('Duplicate or mismatched specification source.');
      phases.add(input.phase);
    }
    if(value.capabilities!==null&&(!value.capabilities||typeof value.capabilities!=='object'||Array.isArray(value.capabilities)))throw Error('Invalid planned capability observation.');
  }catch(cause){throw corrupt(cause);}
  return value;
}
