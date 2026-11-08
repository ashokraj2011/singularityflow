/** Compare persisted v1 policy projections, without recompiling or restamping old rules. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,NAMESPACE_STORY_SCHEMAS,admitRecordSchemaVersion} from '../foundation/record-schema.mjs';
export const STORY_POLICY_PROFILE='sflow-namespace-story-policy/v1';
const phaseFields=Object.freeze(['id','label','order','kind','skillBinding','defaultAgent','requiredArtifact','template',
  'worldModel','writeScope','sourceBoundary','comparison','mcp','repairBudget','inputs','generationPolicy','approvalPolicy','qualityCommands']);
const workFields=Object.freeze(['id','workType','createdAt','createdBy','source']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const selected=(value,fields)=>Object.fromEntries(fields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
function fail(workId,path) {throw new SingularityFlowError('The Story policy differs from its retained creation contract.',{
  code:'ENGINE_STORAGE_CORRUPT',details:{workId,profile:STORY_POLICY_PROFILE,path}});}

export function assertStoryPolicy(workflow,original) {
  const workId=original?.workItem?.id??null;
  for(const value of [original,workflow]) {
    try {admitRecordSchemaVersion(NAMESPACE_STORY_SCHEMAS.workflow,value);}
    catch(cause){throw new SingularityFlowError(cause.message,{cause,details:cause.details,
      code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
    if(value.format!=='sflow-namespace-story-workflow/v1'||!plain(value.workItem)||!plain(value.resolution)
      ||!plain(value.phases)||!Array.isArray(value.phaseOrder))fail(workId,'workflow');
  }
  if(!same(selected(workflow.workItem,workFields),selected(original.workItem,workFields)))fail(workId,'workItem');
  if(!same(workflow.resolution,original.resolution))fail(workId,'resolution');
  if(!same(workflow.phaseOrder,original.phaseOrder)||!same(Object.keys(workflow.phases).sort(),Object.keys(original.phases).sort()))fail(workId,'phaseOrder');
  for(const id of original.phaseOrder) {
    if(!Object.hasOwn(original.phases,id)||!plain(workflow.phases[id])||!plain(original.phases[id])
      ||!same(selected(workflow.phases[id],phaseFields),selected(original.phases[id],phaseFields)))fail(workId,'phases.'+id);
  }
}
