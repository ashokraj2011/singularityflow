/** Replay original Code opening and explicit same-generation continuation without private I/O. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,namespaceGenerationProfile} from '../foundation/record-schema.mjs';
import {namespaceRevision,exactObject} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {namespaceDraftValue} from './namespace-draft-contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {createNamespaceLifecycleCodec} from './namespace-lifecycle-codec.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {createNamespaceCodePredecessorReader} from './namespace-code-predecessors.mjs';
import {createNamespaceSourceOpeningReader} from './namespace-source-opening-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),
  corrupt=message=>{throw new SingularityFlowError(message,{code:'ENGINE_STORAGE_CORRUPT'});};
const fields=['schemaVersion','format','workId','phase','generation','baseRevision','configuration','actor','agentId','createdAt','sources','inputContext'];
/** Frozen v1 remains the ordinary opening. V2 carries the exact previous private metadata. */
export function namespaceGenerationValue(value,{workId,phaseId},depth=0){
  let profile;try{profile=namespaceGenerationProfile(value);}catch(cause){throw new SingularityFlowError('The Code opening has an unsupported or invalid record version.',{cause,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
  exactObject(value,[...fields,...(profile.continuation?['continuation']:[]),...((profile.predecessors||profile.optionalPredecessors&&value.predecessors)?['predecessors']:[]),...(profile.reviewedOpening?['opening']:[])]);
  if(depth>32||value.format!==profile.format||value.workId!==workId||value.phase!==phaseId||!Number.isSafeInteger(value.generation)||value.generation<1
    ||namespaceRevision(value.baseRevision)===null||!Array.isArray(value.sources)||!value.sources.length||contentReference(value.inputContext).namespace!=='local')corrupt('The Code generation has another opening contract.');
  if(profile.continuation){const c=value.continuation;exactObject(c,['basis','draft','intent']);exactObject(c.basis,['head','revision']);
    for(const part of [c.draft,c.intent]){exactObject(part,['reference','value']);const bytes=Buffer.from(canonicalJson(part.value));
      if(contentReference(part.reference).namespace!=='local'||part.reference.bytes!==bytes.byteLength||part.reference.sha256!==hash(bytes))corrupt('The Code continuation changed its original private metadata.');}
    const old=c.draft.value,binding={projectId:old.projectId,deviceId:old.deviceId,workId,phaseId};namespaceDraftValue('body',old,binding);
    if(old.projectId!==c.basis.head?.projectId)corrupt('The original private draft belongs to another project.');
    const p=old.payload,prior=namespaceGenerationValue(c.intent.value,{workId,phaseId},depth+1);
    if(c.basis.revision!==p.baseRevision||c.basis.revision!==prior.baseRevision||p.generation!==value.generation||prior.generation!==value.generation
      ||!same(p.sources,value.sources)||!same(prior.sources,value.sources)||!same(p.configuration,value.configuration)||!same(prior.configuration,value.configuration)
      ||p.generationIntent?.id!=='generation-'+c.intent.reference.sha256||!same(p.generationIntent.record,c.intent.reference)
      ||['actor','agentId','createdAt','inputContext'].some(key=>!same(p[key],prior[key])))corrupt('Continuation cannot open another generation or change its source selection.');
  }
  if(profile.reviewedOpening){const c=value.opening?.context;
    if(value.opening?.profile!=='sflow-namespace-reviewed-source-opening/v1'||c?.workId!==workId||c.phase!==phaseId||c.generation!==value.generation
      ||c.basis?.revision!==value.baseRevision||!same(c.basis.configuration,value.configuration)||!same(c.sourceBinding?.repositories,value.sources))corrupt('The source adoption has another opening identity.');}
  if(profile.predecessors||profile.optionalPredecessors&&value.predecessors){const p=value.predecessors;exactObject(p,['basis','proof']);exactObject(p.basis,['head','revision']);
    if(p.basis.revision!==value.baseRevision||p.proof?.profile!=='sflow-namespace-code-predecessors/v1'||!Array.isArray(p.proof.phases)
      ||!p.proof.phases.length||p.proof.phases.length>32)corrupt('A Code opening needs its actual bounded predecessor proof.');}
  return value;
}
export async function verifyNamespaceGenerationContinuation(value,{observer,workId,phaseId,signal}={}){
  namespaceGenerationValue(value,{workId,phaseId});
  const b=observer.evidenceReads,codec=createNamespaceLifecycleCodec({...b,limits:b.records.descriptor.limits,textDigests:NODE_TEXT_DIGESTS});
  let current=value;
  for(let count=0;namespaceGenerationProfile(current).continuation;count++){
    if(count>32)corrupt('Code continuation history exceeds its bounded replay.');
    const {basis,intent}=current.continuation,proof=await observer.accepted(basis.head.operationId,{signal}),head=codec.head(proof.plan);
    if(!same(head,basis.head)||proof.receipt.records.find(row=>row.namespace==='state'&&row.key===namespaceLifecycleStoryKey(workId))?.version!==basis.revision
      ||proof.state.workflow.currentPhase!==phaseId||proof.state.workflow.phases[phaseId]?.generation!==current.generation-1
      ||!same(proof.state.workflow.sourceBindings?.current?.repositories,current.sources)
      ||!same(basis.head.configuration,current.configuration))corrupt('The continued Code opening has no exact accepted earlier lifecycle basis.');
    current=intent.value;
  }
  if(namespaceGenerationProfile(current).reviewedOpening)await createNamespaceSourceOpeningReader({observer,scope:b.scope,workId}).verify(current.opening,{signal});
  if(namespaceGenerationProfile(current).predecessors||namespaceGenerationProfile(current).optionalPredecessors&&current.predecessors){const {basis,proof:expected}=current.predecessors,
    accepted=await observer.accepted(basis.head.operationId,{signal}),head=codec.head(accepted.plan);
    if(!same(head,basis.head)||accepted.receipt.records.find(row=>row.namespace==='state'&&row.key===namespaceLifecycleStoryKey(workId))?.version!==basis.revision
      ||accepted.state.workflow.currentPhase!==phaseId||accepted.state.workflow.phases[phaseId]?.generation!==current.generation-1
      ||!same(accepted.state.workflow.sourceBindings?.current?.repositories,current.sources)||!same(head.configuration,current.configuration))corrupt('The Code opening has no actual accepted predecessor basis.');
    const actual=await createNamespaceCodePredecessorReader({observer,scope:b.scope,workId}).opening({revision:basis.revision,configuration:head.configuration,
      workflow:accepted.state.workflow},phaseId,{signal});
    if(!actual||!same(actual.proof,expected))corrupt('The Code opening lost its original approved predecessors.');
  }
}
/** Original opening facts survive an exact same-generation rebase without authorizing a new vote. */
export function namespaceReviewedSourceOpening(value){
  for(let count=0;value&&count<=32;count++){
    const profile=namespaceGenerationProfile(value);if(profile.reviewedOpening)return value.opening;
    if(!profile.continuation)return null;value=value.continuation.intent.value;
  }
  corrupt('The reviewed opening exceeds its bounded continuation history.');
}
/** Follow the exact accepted predecessor chain, never an index scan or application Git history. */
export async function namespaceGenerationOriginalBasis(captured,previous,{observer,workId,signal}={}){
  let head=captured.basis.head,revision=captured.snapshot.revision;
  for(let count=0;count<128;count++){
    if(revision===previous.baseRevision)return {head,revision};
    const proof=await observer.accepted(head.operationId,{signal});
    if(!same(head.state,proof.plan.state)||proof.receipt.records.find(row=>row.namespace==='state'&&row.key===namespaceLifecycleStoryKey(workId))?.version!==revision)corrupt('The continuation lost its accepted predecessor chain.');
    head=proof.plan.basis.head;revision=proof.plan.basis.headVersion;
  }
  throw new SingularityFlowError('The draft basis is outside the bounded continuation history. Preserve it and inspect its original operation.',{code:'ENGINE_STORAGE_LIMIT'});
}
