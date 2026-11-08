/** Preparation selection and observations. No host locations, model wording, I/O or approval decisions. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseBeginSelection,effectivePhasePublicationProducer,isConvergencePhase,
  phaseKernelOwned,phaseRequiresCodeDelivery} from './phase-policy.mjs';
import {storyActorValue} from './story-creation.mjs';
import {projectEnrollmentTimestamp} from './project-enrollment.mjs';
import {utf8Bytes} from './artifact-content.mjs';

const text=value=>typeof value==='string'&&value.length>0&&value.length<=4096;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>typeof value==='string'&&/^(?:sha256:)?[a-f0-9]{64}$/u.test(value);
const nullable=(check,value)=>value===null||check(value);
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===fields.length&&Object.keys(value).every(key=>fields.includes(key));
function bad(){throw new SingularityFlowError('The preparation port returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});}

export function phasePreparationSelection(workflow,inputs,modelEnabled) {
  if(typeof modelEnabled!=='boolean')bad();
  const {workId,phase,generation}=phaseBeginSelection(workflow,inputs),selected=workflow.phases[phase];
  const producer=effectivePhasePublicationProducer(selected,{modelEnabled});
  return {workId,phase,generation,producer,
    mode:isConvergencePhase(selected)&&producer==='deterministic'?'deterministic-convergence':'phase-draft',
    artifactKey:selected.requiredArtifact?.path??null,
    authoringRequired:producer!=='deterministic'||!phaseKernelOwned(selected),
    codeDeliveryRequired:phaseRequiresCodeDelivery(selected)};
}

export function phasePreparationManifest(binding,facts) {
  if(!exact(facts,['workId','phase','generation','producer','artifactKey','inputContext','generationIntent','convergence','generationOpened'])
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||facts.generation!==binding.generation
    ||facts.producer!==binding.producer||facts.artifactKey!==binding.artifactKey
    ||!nullable(text,facts.artifactKey)||typeof facts.generationOpened!=='boolean')bad();
  const input=facts.inputContext,intent=facts.generationIntent,convergence=facts.convergence;
  if(input!==null&&(!exact(input,['generation','sha256','renderedSha256'])
    ||!nullable(count,input.generation)||!nullable(digest,input.sha256)||!nullable(digest,input.renderedSha256)))bad();
  if(intent!==null&&(!exact(intent,['id','generation','sha256'])
    ||!nullable(text,intent.id)||!nullable(count,intent.generation)||!nullable(digest,intent.sha256)))bad();
  if(facts.generationOpened&&(!binding.codeDeliveryRequired||!intent?.id||intent.generation!==binding.generation||!intent.sha256))bad();
  if(binding.mode==='deterministic-convergence'?convergence===null:convergence!==null)bad();
  if(convergence!==null&&(!exact(convergence,['iteration','sha256','factCount','settledCount','findingCount','undisposedItemIds','unresolvedBlockerCount'])
    ||!count(convergence.iteration)||convergence.iteration<1||!digest(convergence.sha256)
    ||['factCount','settledCount','findingCount','unresolvedBlockerCount'].some(key=>!count(convergence[key]))
    ||!Array.isArray(convergence.undisposedItemIds)||!convergence.undisposedItemIds.every(text)
    ||new Set(convergence.undisposedItemIds).size!==convergence.undisposedItemIds.length))bad();
  return {schemaVersion:1,contract:'sflow-phase-preparation-manifest/v1',workId:binding.workId,phase:binding.phase,
    generation:binding.generation,producer:binding.producer,mode:binding.mode,
    artifact:facts.artifactKey===null?null:{key:facts.artifactKey,contentVerified:false},
    authoringRequired:binding.authoringRequired,codeDeliveryRequired:binding.codeDeliveryRequired,
    inputContext:input?{...input,forPreparedGeneration:input.generation===binding.generation,integrityVerified:false}:null,
    generationIntent:intent?{...intent,forPreparedGeneration:intent.generation===binding.generation,integrityVerified:false}:null,
    convergence,publicationReadinessInspected:false,finalBindingChecked:false,testsRun:false,
    approvalRecorded:false,humanReviewRecorded:false};
}

/** Native projection summary shared with legacy hosts; it records no human disposition. */
export function convergencePreparationState(projection) {
  if (!projection) return null;
  const disposed = new Set((projection.findings ?? []).map((finding) => finding.itemId));
  const undisposedItemIds = [...(projection.facts ?? []), ...(projection.candidateSnapshot ?? [])]
    .map((item) => item.id)
    .filter((id) => !disposed.has(id));
  return {
    iteration: projection.iteration,
    sha256: projection.convergenceSha256,
    factCount: projection.facts?.length ?? 0,
    settledCount: projection.settledByPlan?.length ?? 0,
    findingCount: projection.findings?.length ?? 0,
    undisposedItemIds,
    unresolvedBlockers: projection.unresolvedBlockers ?? [],
    allowedNext: projection.allowedNext ?? []
  };
}

const draftId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const draftRevision=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u0020\u007f]/u.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const draftInvalid=message=>{throw new SingularityFlowError(message,{code:'ENGINE_INPUT_INVALID'});};
export function localDraftReference(value) {
  if(!exact(value,['namespace','sha256','bytes'])||value.namespace!=='local'||!sha(value.sha256)
    ||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>134_217_728)draftInvalid('An authored draft needs an exact machine-local content reference.');
  return {...value};
}
export function phaseDraftReadInput(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['workId','phaseId','maximumBytes'].includes(key))
    ||['workId','phaseId'].some(key=>input[key]!==undefined&&!draftId(input[key]))
    ||input.maximumBytes!==undefined&&(!Number.isSafeInteger(input.maximumBytes)||input.maximumBytes<0||input.maximumBytes>1_048_576))draftInvalid('Invalid local draft selection or read budget.');
  return {...input,maximumBytes:input.maximumBytes??65_536};
}
export function phaseDraftMutationInput(input,operation) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==operation.requiredFields.length
    ||!operation.requiredFields.every(key=>Object.hasOwn(input,key))
    ||['operationId','workId','phaseId'].some(key=>!draftId(input[key]))||!draftRevision(input.expectedRevision)
    ||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>4096||/[\u0000\u007f]/u.test(input.reason))draftInvalid('A local draft update needs an exact revision, operation ID, phase and reason.');
  if(operation.id==='phase.draft.write')return {...input,content:localDraftReference(input.content)};
  if(!sha(input.confirm))draftInvalid('Rebinding a local draft requires its exact reviewed body digest.');
  return {...input};
}
/** Authenticate a principal without authorizing a new effect (also used to select original receipts). */
export function phaseAccessIdentity(facts,projectId) {
  if(!facts||facts.projectId!==projectId||!Array.isArray(facts.permissions)||facts.permissions.length>128
    ||facts.permissions.some(value=>typeof value!=='string'||value.length>128)
    ||facts.agentId!==null&&!draftId(facts.agentId))bad();
  return {actor:storyActorValue(facts),agentId:facts.agentId};
}
function phaseAccess(facts,projectId,permission,expected,missing,changed) {
  const {actor,agentId}=phaseAccessIdentity(facts,projectId);
  if(!facts.permissions.includes(permission))throw new SingularityFlowError(missing,{code:'ENGINE_AUTHORITY_REQUIRED',details:{permission}});
  if(expected!==null&&(JSON.stringify(expected.actor)!==JSON.stringify(actor)||expected.agentId!==facts.agentId))throw new SingularityFlowError(changed,{code:'ENGINE_ACTOR_CHANGED'});
  return {actor,agentId};
}
export function phaseDraftAccess(facts,projectId,permission,{expected=null}={}) {
  return phaseAccess(facts,projectId,permission,expected,'The current principal cannot perform this private draft operation.',
    'Resume this draft operation under its original authenticated actor and phase agent.');
}
/** Shared lifecycle operations authenticate the same facts without claiming a private draft. */
export function phaseTransitionAccess(facts,projectId,permission,{expected=null}={}) {
  return phaseAccess(facts,projectId,permission,expected,'The current principal cannot perform this phase operation.',
    'Resume this phase operation under its original authenticated actor and phase agent.');
}
export function phaseDraftReadManifest(workId,phaseId,facts,maximumBytes=65_536) {
  if(!facts||facts.workId!==workId||facts.phase!==phaseId||!['missing','open','stale'].includes(facts.status))bad();
  if(facts.status==='missing') {
    if(Object.keys(facts).length!==3)bad();
    return {schemaVersion:1,contract:'sflow-phase-working-draft-manifest/v1',workId,phase:phaseId,status:'missing',draft:null,artifact:null};
  }
  const d=facts.draft,a=facts.artifact;
  if(!exact(facts,['workId','phase','status','draft','artifact'])||!d||!exact(d,['generation','revision','bodySha256','baseRevision','currentRevision','createdAt','actor','agentId'])
    ||!Number.isSafeInteger(d.generation)||d.generation<1||!draftRevision(d.revision)||!sha(d.bodySha256)
    ||!draftRevision(d.baseRevision)||!draftRevision(d.currentRevision)||d.agentId!==null&&!draftId(d.agentId)
    ||facts.status!==(d.baseRevision===d.currentRevision?'open':'stale')
    ||!a||!exact(a,['key','reference','content'])||!text(a.key)||a.key.startsWith('/')||/^[a-zA-Z]:/u.test(a.key)
    ||a.key.includes('\\')||a.key.split('/').some(part=>!part||part==='.'||part==='..'))bad();
  projectEnrollmentTimestamp(d.createdAt);storyActorValue(d.actor);localDraftReference(a.reference);
  const content=a.content;
  if(content?.kind==='text') {
    if(!exact(content,['kind','text','bytes','truncated'])||typeof content.text!=='string'||!count(content.bytes)
      ||typeof content.truncated!=='boolean'||utf8Bytes(content.text)!==content.bytes||content.bytes>a.reference.bytes||content.bytes>maximumBytes
      ||content.truncated!==(content.bytes<a.reference.bytes))bad();
  }else if(!exact(content,['kind','bytes'])||content.kind!=='binary'||content.bytes!==a.reference.bytes)bad();
  return {schemaVersion:1,contract:'sflow-phase-working-draft-manifest/v1',...facts};
}
export function phaseDraftMutationResult(input,facts,operation) {
  if(!facts||!exact(facts,['workId','phase','operationId','generation','revision','bodySha256','artifact','recordedAt','principalId','replayed'])
    ||facts.workId!==input.workId||facts.phase!==input.phaseId||facts.operationId!==input.operationId
    ||!Number.isSafeInteger(facts.generation)||facts.generation<1||!draftRevision(facts.revision)||!sha(facts.bodySha256)
    ||!draftRevision(facts.principalId)||typeof facts.replayed!=='boolean')bad();
  localDraftReference(facts.artifact);projectEnrollmentTimestamp(facts.recordedAt);
  return {status:operation.id==='phase.draft.write'?'saved':'rebound',subject:{kind:'story',id:input.workId},phase:input.phaseId,
    operationId:input.operationId,generation:facts.generation,revision:facts.revision,bodySha256:facts.bodySha256,
    artifact:facts.artifact,recordedAt:facts.recordedAt,principalId:facts.principalId,replayed:facts.replayed,
    effects:{localDraftSaved:true,committed:false,pushed:false,sourceFilesChanged:false,testsRun:false,
      humanReviewRecorded:false,approvalRecorded:false,storyAdvanced:false}};
}
