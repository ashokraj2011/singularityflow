/** Frozen human routing records and receipt links. No actor discovery, storage or inferred answers. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_ROUTING_CHOICE_SCHEMAS,admitRecordSchemaVersion,canonicalJson} from '../foundation/record-schema.mjs';
import {exactObject,namespaceIdentifier,namespaceKey,namespaceRevision,namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
export const NAMESPACE_ROUTING_CHOICE_PROFILE='sflow-human-routing-choice/v1';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const key=value=>typeof value==='string'&&/^[a-f0-9]{16}$/u.test(value);
const text=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\u0000-\u001f\u007f]/u.test(value);
function checked(validate) {
  try{return validate();}catch(cause){throw new SingularityFlowError('The namespace routing choice is invalid.',{cause,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED','ENGINE_STORAGE_UNSUPPORTED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
}
function evidence(value) {
  if(contentReference(value,4_194_304).namespace!=='evidence'||value.bytes<1)throw Error('A choice needs shared immutable evidence.');
}
export function namespaceRoutingChoiceValue(value,{projectId,workId}={}) {return checked(()=>{
  admitRecordSchemaVersion(NAMESPACE_ROUTING_CHOICE_SCHEMAS.record,value);
  exactObject(value,['schemaVersion','format','profile','projectId','workId','phase','generation','operationId','requestSha256',
    'baseRevision','configuration','question','request','actor','agentId','authorityGroup','recordedAt','outcome','currentPhase']);
  if(value.format!=='sflow-namespace-routing-choice/v1'||value.profile!==NAMESPACE_ROUTING_CHOICE_PROFILE
    ||value.projectId!==projectId||value.workId!==workId||!Number.isSafeInteger(value.generation)||value.generation<1
    ||!digest(value.requestSha256)||namespaceRevision(value.baseRevision)===null)throw Error('Another routing choice binding.');
  for(const field of ['projectId','workId','phase','operationId','authorityGroup'])namespaceIdentifier(value[field]);
  exactObject(value.configuration,['key','content']);namespaceKey(value.configuration.key);
  if(contentReference(value.configuration.content).namespace!=='config')throw Error('Another configuration namespace.');
  exactObject(value.question,['key','approval']);if(!key(value.question.key))throw Error('Invalid question key.');evidence(value.question.approval);
  const request=value.request;exactObject(request,['option','to','expected','reason']);
  if(Boolean(request.option)===Boolean(request.to)||request.option!==null&&!text(request.option)||request.to!==null&&!text(request.to)
    ||request.expected!==value.question.key||typeof request.reason!=='string'||!request.reason.length||request.reason.length>2048
    ||/[\u0000\u007f]/u.test(request.reason)||request.reason!==request.reason.trim())throw Error('Invalid human choice request.');
  exactObject(value.actor,['principalId','actorKind','identity']);
  if(!same(storyActorValue(value.actor),value.actor)||value.actor.actorKind!=='human')throw Error('A route choice requires a human.');
  if(value.agentId!==null)namespaceIdentifier(value.agentId);projectEnrollmentTimestamp(value.recordedAt);
  const outcome=value.outcome;
  exactObject(outcome,['decision','label','after','kind','route','routeLabel','target','skipped','values','maxRounds','by',
    ...(outcome?.kind==='loop'?['round']:[])]);
  if(outcome.after!==value.phase||outcome.by!=='person'||!['next','forward','end','loop'].includes(outcome.kind)
    ||!text(outcome.label)||!text(outcome.routeLabel)||!Array.isArray(outcome.skipped)||new Set(outcome.skipped).size!==outcome.skipped.length
    ||outcome.maxRounds!==null&&(!Number.isSafeInteger(outcome.maxRounds)||outcome.maxRounds<1)
    ||outcome.kind==='loop'&&(!Number.isSafeInteger(outcome.round)||outcome.round<1))throw Error('Invalid human routing outcome.');
  namespaceIdentifier(outcome.decision);namespaceIdentifier(outcome.route);outcome.skipped.forEach(id=>namespaceIdentifier(id));
  if(outcome.kind==='end'?outcome.target!==null||value.currentPhase!==null:!text(outcome.target)
    ||value.currentPhase!==null&&!text(value.currentPhase))throw Error('Invalid target.');
  if(['forward','loop'].includes(outcome.kind)&&outcome.target!==value.currentPhase)throw Error('Another current phase.');
  if(value.currentPhase!==null)namespaceIdentifier(value.currentPhase);
  if(outcome.target!==null)namespaceIdentifier(outcome.target);
  namespaceJson(value);return value;
});}
export function namespaceRoutingChoiceRecord(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||['schemaVersion','format','profile'].some(field=>Object.hasOwn(value,field))) {
    throw new SingularityFlowError('Choice wire metadata belongs to its registered profile.',{code:'ENGINE_INPUT_INVALID'});
  }
  return {schemaVersion:NAMESPACE_ROUTING_CHOICE_SCHEMAS.record.currentVersion,format:'sflow-namespace-routing-choice/v1',
    profile:NAMESPACE_ROUTING_CHOICE_PROFILE,...value};
}
export function namespaceRoutingChoiceReceiptValue(value,{projectId,workId}={}) {return checked(()=>{
  admitRecordSchemaVersion(NAMESPACE_ROUTING_CHOICE_SCHEMAS.receipt,value);
  exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','pendingKey','principalId','operationId','requestSha256','record']);
  if(value.format!=='sflow-namespace-routing-choice-receipt/v1'||value.projectId!==projectId||value.workId!==workId
    ||!Number.isSafeInteger(value.generation)||value.generation<1||!key(value.pendingKey)||!digest(value.requestSha256)
    ||typeof value.principalId!=='string'||!value.principalId.length||value.principalId.length>512||/[\u0000-\u0020\u007f]/u.test(value.principalId))throw Error('Another choice receipt.');
  for(const field of ['projectId','workId','phase','operationId'])namespaceIdentifier(value[field]);evidence(value.record);return value;
});}
export function namespaceRoutingChoiceReceipt(value,record) {
  return namespaceRoutingChoiceReceiptValue({schemaVersion:NAMESPACE_ROUTING_CHOICE_SCHEMAS.receipt.currentVersion,
    format:'sflow-namespace-routing-choice-receipt/v1',projectId:value.projectId,workId:value.workId,phase:value.phase,generation:value.generation,
    pendingKey:value.question.key,principalId:value.actor.principalId,operationId:value.operationId,requestSha256:value.requestSha256,record},
  {projectId:value.projectId,workId:value.workId});
}
export function namespaceRoutingChoiceReceipts(workflow,{projectId,workId}) {return checked(()=>{
  const values=Object.hasOwn(workflow,'namespaceRoutingChoiceReceipts')?workflow.namespaceRoutingChoiceReceipts:[];
  if(!Array.isArray(values))throw Error('Invalid choice receipt inventory.');
  const operations=new Set(),questions=new Set();
  for(const value of values) {
    namespaceRoutingChoiceReceiptValue(value,{projectId,workId});
    if(operations.has(value.operationId)||questions.has(value.pendingKey))throw Error('Duplicate choice receipt.');
    operations.add(value.operationId);questions.add(value.pendingKey);
  }
  return values;
});}
