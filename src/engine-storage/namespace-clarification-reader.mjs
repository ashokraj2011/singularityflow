/** Actual human clarification receipts and read manifests. No questions, prompts or writes. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,admitRecordSchemaVersion,NAMESPACE_CLARIFICATION_SCHEMAS} from '../foundation/record-schema.mjs';
import {phaseBeginSelection} from '../kernel/phase-policy.mjs';
import {phaseCatalogAuthorAdmission} from '../kernel/phase-admission.mjs';
import {resolvedClarificationPolicy,clarificationPublicationState,clarificationResponseSet} from '../kernel/clarification-responses.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {exactObject,namespaceRevision,namespaceIdentifier} from '../sda/namespace/values.mjs';
import {namespaceTransaction,namespaceTransactionIdentity} from '../sda/namespace/transaction.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespacePhaseResources} from './namespace-phase-resources.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {LIFECYCLE_AUTHORITY_KEY,lifecycleHead} from './namespace-lifecycle-contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
export const CLARIFICATION_EVIDENCE='clarification-checkpoint/v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
export function clarificationRecord(kind,value) {return {schemaVersion:1,format:`sflow-namespace-clarification-${kind}/v1`,...value};}

export function createNamespaceClarificationReader({observer,scope,workId,limits:givenLimits,localRead=null,checks=null}) {
  const limits=namespaceLimits(givenLimits),headKey=namespaceLifecycleStoryKey(workId);
  const key=(phase,generation)=>'clarifications/checkpoints/'+hash(canonicalJson({projectId:scope.projectId,workId,phase,generation}));
  const keys=operationId=>{const token=hash(canonicalJson({projectId:scope.projectId,workId,operationId}));
    return {operation:'clarification-'+token,manifest:'clarifications/operations/'+token};};
  function schema(kind,value) {
    try {admitRecordSchemaVersion(NAMESPACE_CLARIFICATION_SCHEMAS[kind],value);
      if(value.format!==`sflow-namespace-clarification-${kind}/v1`)throw Error('Wrong clarification format.');}
    catch(cause){throw error('The clarification record has an unsupported or invalid format.',
      ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
    return value;
  }
  async function json(reference,signal) {
    contentReference(reference);const data=await observer.bytes(reference,reference.bytes,signal);
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
    catch(cause){throw error('The clarification content is not UTF-8 JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}
  }
  function authorizeHuman(definition,workflow,phase,actor) {
    storyActorValue(actor);
    if(actor.actorKind!=='human')throw error('Clarification replies require the authenticated human responder.','CLARIFICATION_AUTHORITY_REQUIRED');
    const policy=phase.approvalPolicy;
    if((policy?.mode??'required')!=='none'&&policy?.authorities?.length) {
      requireApprovalAuthority(workflow.resolution.approvalAuthorities??definition.approvalAuthorities,policy,actor.identity);
    }
  }
  async function context(captured,phaseId,{signal,agentId,validateLocal=true}={}) {
    const {snapshot}=captured,workflow=snapshot.workflow,phase=workflow.phases[phaseId];
    if(!phase)throw error('The phase is unavailable in this Story.','ENGINE_PHASE_UNAVAILABLE',{phaseId});
    const approved=await observer.approved(snapshot,{signal}),definition=approved.compiled.definition;
    const selection=phaseBeginSelection(workflow,{phaseId});
    agentId=agentId===undefined?phase.defaultAgent??null:agentId;
    const admission=phaseCatalogAuthorAdmission(definition,workflow,phase,agentId);
    if(!admission.allowed)throw error('Select the pinned phase author for the clarification context.',admission.code,admission.facts);
    const configured=approved.compiled.workflows[workflow.workItem.workType]?.phases.find(item=>item.id===phaseId);
    if(!configured)throw error('The phase has no approved workflow definition.');
    const templateKey=String(configured.template).startsWith('agent:')?configured.template:`${definition.templatesRoot}/${configured.template}`,
      template=approved.compiled.templates.find(item=>item.path===templateKey);
    if(!template)throw error('The approved artifact template is unavailable.','WFA_DEPENDENCY_UNAVAILABLE',{key:templateKey});
    await observer.bytes(template.body,template.body.bytes,signal);
    const resources=await createNamespacePhaseResources({observer,workId,
      packets:createNamespaceSubmissionReader({observer,scope,workId,checks}),
      localRead:async(reference,options)=>{
        if(!validateLocal)return;
        if(!localRead)throw error('The uploaded document must be supplied on this device.','ENGINE_STORAGE_CONTENT_MISSING');
        return localRead(reference,options);
      }}).read({...captured,phase},approved.compiled,{agentId},signal);
    const value={schemaVersion:1,contract:'sflow-clarification-read-manifest/v1',projectId:scope.projectId,workId,phase:phaseId,
      generation:selection.generation,baseRevision:snapshot.revision,configuration:snapshot.configuration,agentId,
      policy:resolvedClarificationPolicy(definition,workflow,phase),template:{key:templateKey,reference:template.body},resources,
      sources:structuredClone(workflow.sourceBindings?.current?.repositories??[])};
    return {value,sha256:hash(canonicalJson(value)),definition,phase};
  }
  function transaction(value,reference) {
    const k=keys(value.operationId),b=value.basis;
    return namespaceTransaction({operationId:k.operation,preconditions:[
      {namespace:'state',key:LIFECYCLE_AUTHORITY_KEY,version:b.authorityVersion},
      {namespace:'state',key:headKey,version:b.headVersion},
      {namespace:'config',key:b.head.configuration.key,version:b.configurationVersion},
      {namespace:'evidence',key:k.manifest,version:null},value.observed],changes:[
      {op:'put',namespace:'evidence',key:k.manifest,immutable:true,value:clarificationRecord('manifest',{projectId:scope.projectId,workId,operationId:value.operationId,record:reference})},
      {op:'put',namespace:'evidence',key:value.observed.key,immutable:false,value:clarificationRecord('index',{projectId:scope.projectId,workId,phase:value.phase,generation:value.generation,operationId:value.operationId})}],
      events:[]},limits);
  }
  function receipt(result,tx) {
    const r=result?.receipt,expected=tx.changes;
    if(result?.status!=='committed'||!r||r.operationId!==tx.operationId||!same(r.scope,scope)||namespaceRevision(r.revision)===null
      ||r.requestDigest!==hash(namespaceTransactionIdentity(scope,tx,limits))||!Array.isArray(r.records)||r.records.length!==expected.length
      ||new Set(r.records.map(item=>item.namespace+':'+item.key)).size!==expected.length||!same(r.eventIds,[])
      ||!r.records.every(item=>namespaceRevision(item.version)!==null&&expected.some(change=>change.namespace===item.namespace&&change.key===item.key)))throw error(
      'The namespace store returned a different clarification receipt.','ENGINE_PORT_RESULT_INVALID');
    return r;
  }
  async function accepted(operationId,{signal,depth=0}={}) {
    if(depth>=128)throw error('Clarification history exceeds its bounded replay depth.','ENGINE_STORAGE_LIMIT');
    const k=keys(operationId),metadata=await observer.record('evidence',k.manifest,true,signal,true);
    if(!metadata) {
      const operation=await observer.inspectOperation(k.operation,{signal});
      if(operation?.status!=='missing'||operation.receipt!==null)throw error('The clarification receipt lost its immutable manifest.');
      return null;
    }
    const manifest=schema('manifest',metadata.value);exactObject(manifest,['schemaVersion','format','projectId','workId','operationId','record']);
    if(manifest.projectId!==scope.projectId||manifest.workId!==workId||manifest.operationId!==operationId||contentReference(manifest.record).namespace!=='evidence')throw error('The clarification manifest has another binding.');
    const value=schema('response',await json(manifest.record,signal));
    exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','operationId','parametersSha256','input','context','contextSha256','actor','recordedAt','responses','completed','previous','observed','basis']);
    namespaceIdentifier(value.phase,'Phase ID');namespaceIdentifier(value.operationId,'Operation ID');projectEnrollmentTimestamp(value.recordedAt);
    lifecycleHead(value.basis.head,scope,workId);
    if(value.projectId!==scope.projectId||value.workId!==workId||value.operationId!==operationId
      ||value.phase!==value.input.phaseId||value.generation!==value.context.generation||value.contextSha256!==hash(canonicalJson(value.context))
      ||value.contextSha256!==value.input.contextSha256||value.parametersSha256!==hash(canonicalJson({input:value.input,actor:value.actor}))
      ||value.observed.namespace!=='evidence'||value.observed.key!==key(value.phase,value.generation)||value.basis.headVersion!==value.context.baseRevision
      ||value.context.phase!==value.phase||value.context.workId!==workId||value.context.projectId!==scope.projectId
      ||value.input.agentId!==undefined&&value.input.agentId!==value.context.agentId
      ||!same(value.context.configuration,value.basis.head.configuration))throw error('The clarification response has another context or original request.');
    const state=await observer.state(await observer.bytes(value.basis.head.state,value.basis.head.state.bytes,signal),value.basis.head,{signal}),
      captured={snapshot:{revision:value.basis.headVersion,workflow:state.workflow,configuration:value.basis.head.configuration},basis:value.basis};
    const original=await context(captured,value.phase,{signal,agentId:value.context.agentId,validateLocal:false});
    if(original.sha256!==value.contextSha256)throw error('The clarification manifest differs from its original approved inputs.');
    authorizeHuman(original.definition,state.workflow,state.workflow.phases[value.phase],value.actor);
    const previous=value.previous?await accepted(value.previous.operationId,{signal,depth:depth+1}):null;
    if(value.previous&&(!previous||!same(previous.reference,value.previous.record)
      ||previous.receipt.records.find(item=>item.key===value.observed.key)?.version!==value.observed.version
      ||!same(previous.value.context,value.context)&&!value.input.replace)
      ||!value.previous&&value.observed.version!==null)throw error('The clarification response lost its original answer history.');
    const folded=clarificationResponseSet({phaseId:value.phase,policy:original.value.policy,previous:previous?.value.responses??null,
      responses:value.input.responses,replace:value.input.replace});
    if(!same(folded.responses,value.responses)||folded.completed!==value.completed)throw error('The clarification answers differ from their original request.');
    const tx=transaction(value,manifest.record),r=receipt(await observer.inspectOperation(k.operation,{signal}),tx);
    if(r.records.find(item=>item.key===k.manifest)?.version!==metadata.version)throw error('The clarification manifest has a different acceptance revision.');
    return {value,reference:manifest.record,receipt:r};
  }
  async function checkpoint(contextValue,{signal}={}) {
    const address=key(contextValue.phase,contextValue.generation),pointer=await observer.record('evidence',address,false,signal,true),
      observed={namespace:'evidence',key:address,version:pointer?.version??null};
    if(!pointer)return {observed,accepted:null};
    const index=schema('index',pointer.value);exactObject(index,['schemaVersion','format','projectId','workId','phase','generation','operationId']);
    if(index.projectId!==scope.projectId||index.workId!==workId||index.phase!==contextValue.phase||index.generation!==contextValue.generation)throw error('The clarification index belongs to another checkpoint.');
    const found=await accepted(index.operationId,{signal});
    if(!found||found.receipt.records.find(item=>item.namespace==='evidence'&&item.key===address)?.version!==pointer.version)throw error('The clarification index is not its accepted original receipt.');
    return {observed,accepted:found};
  }
  function readiness(contextValue,record,producer) {
    if(record&&!same(record.context,contextValue))throw error('Review the changed clarification input binding before replacing its answers.','CLARIFICATION_RECORD_BINDING_MISMATCH',{
      operation:'clarification.record',phase:contextValue.phase,contextSha256:hash(canonicalJson(contextValue)),replace:true});
    return clarificationPublicationState(contextValue.policy,record,producer);
  }
  return Object.freeze({keys,key,json,schema,context,accepted,checkpoint,transaction,receipt,authorizeHuman,readiness});
}
