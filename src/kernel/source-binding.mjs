/** Source baseline admission and state updates. Captures and locations are SGOS-owned facts. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { SOURCE_BINDING_SCHEMA,admitRecordSchemaVersion } from '../foundation/record-schema.mjs';
import { sequenceAdmission } from './lifecycle-transitions.mjs';
import { storyActorValue } from './story-creation.mjs';
import { projectConfigurationBinding,projectEnrollmentTimestamp } from './project-enrollment.mjs';

const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const opaque=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u0020\u007f]/u.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const fail=(message,code='ENGINE_INPUT_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};

export function sourceBindingInput(input) {
  const fields=['operationId','workId','expectedRevision','repositories','reason'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==fields.length||!fields.every(key=>Object.hasOwn(input,key))
    ||!id(input.operationId)||!id(input.workId)||!opaque(input.expectedRevision)||!Array.isArray(input.repositories)
    ||input.repositories.length<1||input.repositories.length>32||input.repositories.some(value=>!id(value))
    ||new Set(input.repositories).size!==input.repositories.length||typeof input.reason!=='string'||!input.reason.trim()
    ||input.reason.length>4096||/[\u0000\u007f]/u.test(input.reason))fail('Source binding needs an exact Story revision, repository selection, operation ID and reason.');
  return {...input,repositories:[...input.repositories].sort()};
}
export function sourceBindingScope(binding,input) {
  const selected=projectConfigurationBinding(binding);
  if(binding.workId!==input.workId)fail('Source binding belongs to another Story.','ACTIVE_SUBJECT_MISMATCH');
  return {...selected,workId:input.workId};
}
export function sourceBindingAccess(facts,projectId,expected=null) {
  if(!facts||facts.projectId!==projectId||!Array.isArray(facts.permissions)||facts.permissions.length>128
    ||facts.permissions.some(value=>typeof value!=='string'||value.length>128))fail('The source access port returned invalid project or permission facts.','ENGINE_PORT_RESULT_INVALID');
  const actor=storyActorValue(facts);
  if(!facts.permissions.includes('source.bind'))fail('The current principal cannot bind sources.','ENGINE_AUTHORITY_REQUIRED');
  if(expected!==null&&JSON.stringify(actor)!==JSON.stringify(expected))fail('Resume the source binding under its original authenticated creator.','ENGINE_ACTOR_CHANGED');
  return actor;
}
export function sourceBindingAdmission(workflow,input) {
  if(workflow?.workItem?.id!==input.workId)fail('Source binding belongs to another Story.','ACTIVE_SUBJECT_MISMATCH');
  if(!Array.isArray(workflow.history))fail('The Story has no valid retained history.','ENGINE_STORAGE_CORRUPT');
  const sequence=sequenceAdmission(workflow);
  if(!sequence.allowed)fail('Source binding requires the current in-progress phase.','ENGINE_PHASE_UNAVAILABLE',{sequence});
  return {phase:sequence.phaseId};
}
export function applySourceBinding(workflow,input,{repositories,actor,recordedAt}) {
  const {phase}=sourceBindingAdmission(workflow,input);projectEnrollmentTimestamp(recordedAt);storyActorValue(actor);
  const origins=structuredClone(workflow.sourceBindings?.origins??[]);
  for(const repository of repositories)if(!origins.some(origin=>origin.id===repository.id))origins.push({
    ...structuredClone(repository),operationId:input.operationId,recordedAt});
  workflow.sourceBindings={origins,current:{schemaVersion:SOURCE_BINDING_SCHEMA.currentVersion,format:'sflow-source-binding/v1',operationId:input.operationId,
    baseRevision:input.expectedRevision,recordedAt,actor:structuredClone(actor),reason:input.reason,repositories:structuredClone(repositories)}};
  workflow.history.push({at:recordedAt,actor:actor.principalId,agent:null,event:'sources_bound',phase,detail:input.reason});
  return workflow.sourceBindings.current;
}
export function storedSourceBinding(value,operationId) {
  try {admitRecordSchemaVersion(SOURCE_BINDING_SCHEMA,value);}
  catch(cause){throw new SingularityFlowError(cause.message,{cause,details:cause.details,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
  if(value.format!=='sflow-source-binding/v1'||value.operationId!==operationId||!opaque(value.baseRevision)
    ||!Array.isArray(value.repositories)||value.repositories.length<1||value.repositories.length>32||typeof value.reason!=='string') {
    fail('The retained source binding has another shape.','ENGINE_STORAGE_CORRUPT');
  }
  projectEnrollmentTimestamp(value.recordedAt);storyActorValue(value.actor);
  return value;
}
export function sourceBindingResult(binding,input,facts) {
  if(!facts||facts.projectId!==binding.projectId||facts.workId!==input.workId||facts.operationId!==input.operationId
    ||facts.authorityId!==binding.authority.id||facts.epoch!==binding.authority.epoch||!opaque(facts.revision)||!opaque(facts.transactionRevision)
    ||!sha(facts.requestDigest)||typeof facts.replayed!=='boolean'||!opaque(facts.principalId)||!Array.isArray(facts.repositories)
    ||facts.repositories.length!==input.repositories.length)fail('The source writer returned another binding.','ENGINE_PORT_RESULT_INVALID');
  projectEnrollmentTimestamp(facts.recordedAt);
  for(const [index,repository] of facts.repositories.entries()) {
    if(!repository||repository.id!==input.repositories[index]||!id(repository.unitId)||!id(repository.provider)
      ||!/^sha256:[a-f0-9]{64}$/u.test(repository.revision??'')||repository.snapshot?.namespace!=='evidence'
      ||!sha(repository.snapshot.sha256)||!Number.isSafeInteger(repository.snapshot.bytes)||repository.snapshot.bytes<1)fail('The source writer returned another repository or snapshot.','ENGINE_PORT_RESULT_INVALID');
  }
  return {status:'bound',subject:{kind:'story',id:input.workId},operationId:input.operationId,authority:binding.authority,
    recordedAt:facts.recordedAt,principalId:facts.principalId,repositories:facts.repositories,revision:facts.revision,
    transactionRevision:facts.transactionRevision,requestDigest:facts.requestDigest,replayed:facts.replayed,
    effects:{committed:true,pushed:false,sourceFilesChanged:false,testsRun:false,generationOpened:false,
      approvalRecorded:false,humanReviewRecorded:false,storyAdvanced:false}};
}
