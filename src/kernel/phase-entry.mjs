/** Authoring entry vocabulary and context manifest. Integrations own all prompt/command wording. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {currentEntryPhase,phaseCompositionAdmission} from './phase-admission.mjs';
import {nextPhaseGeneration,phaseReviewSelection} from './phase-policy.mjs';
import {approvedInputPhases,resolvedPhaseInputs,clarificationCheckpointState,normalizeClarificationPolicy} from './phase-inputs.mjs';
import {validDocumentReference} from './document-read.mjs';

const text=value=>typeof value==='string'&&value.length>0&&value.length<=4096;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const nullableText=value=>value===null||text(value);
const strings=value=>Array.isArray(value)&&value.every(text);
function bad(){throw new SingularityFlowError('The phase entry port returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});}

export function phaseEntrySelection(context,inputs) {
  const workflow=context?.workflow;
  if(context?.subject?.kind!=='story'||!text(workflow?.workItem?.id)||context.subject.id!==workflow.workItem.id)bad();
  if(inputs.workId!=null&&inputs.workId!==workflow.workItem.id)throw new SingularityFlowError(
    'Requested Story does not match the entry checkout.',{code:'ACTIVE_SUBJECT_MISMATCH',
      details:{expectedWorkId:inputs.workId,actualWorkId:workflow.workItem.id}});
  const phase=currentEntryPhase(workflow,inputs.phaseId),generation=Number(phase.generation??0),nextGeneration=nextPhaseGeneration(phase);
  if(typeof context.ready!=='boolean'||!count(generation)||!text(phase.status)||!text(context.revision)
    ||!count(context.inspectionGeneration)||![generation,nextGeneration].includes(context.inspectionGeneration)
    ||typeof context.generatesCode!=='boolean'||typeof context.codeGenerationReady!=='boolean'||typeof context.deterministic!=='boolean'
    ||!nullableText(context.agentId))bad();
  const declarations=resolvedPhaseInputs(workflow,phase);
  return {workId:workflow.workItem.id,phase:phase.id,generation,status:phase.status,nextGeneration,
    inspectionGeneration:context.inspectionGeneration,revision:context.revision,ready:context.ready,
    generatesCode:context.generatesCode,codeGenerationReady:context.codeGenerationReady,deterministic:context.deterministic,agentId:context.agentId,
    inputs:approvedInputPhases(workflow,phase).map(id=>({phase:id,
      required:declarations.some(entry=>(typeof entry==='string'?entry:entry?.phase)===id&&(typeof entry==='string'||entry.required!==false)),
      ...(Object.hasOwn(workflow.phases,id)?phaseReviewSelection(workflow,id):{generation:null,retained:[]})}))};
}

function admissionFactsValid(facts) {
  const {authoring,recovery,references,documents}=facts;
  if(!keys(authoring,['entry','policyVerified','policyReason','hasAuthoringRoute','targetGeneration'])
    ||!keys(authoring.entry,['status','reason'])||!nullableText(authoring.entry.status)||!nullableText(authoring.entry.reason)
    ||typeof authoring.policyVerified!=='boolean'||!nullableText(authoring.policyReason)||typeof authoring.hasAuthoringRoute!=='boolean'
    ||authoring.targetGeneration!==null&&!count(authoring.targetGeneration)
    ||!keys(recovery,['requiresRecovery','actions','blockers'])||typeof recovery.requiresRecovery!=='boolean'
    ||!Array.isArray(recovery.actions)||!Array.isArray(recovery.blockers)
    ||!keys(references,['status'])||!text(references.status)
    ||!keys(documents,['status','localDocumentCount','documentCount','missing'])||!text(documents.status)
    ||!count(documents.localDocumentCount)||!count(documents.documentCount)||!Array.isArray(documents.missing))return false;
  for(const action of recovery.actions)if(!keys(action,['id','automatic','mode','confirmation','paths','unexpectedPaths','authoringContinuation'])
    ||!text(action.id)||typeof action.automatic!=='boolean'||!nullableText(action.mode)||!nullableText(action.confirmation)
    ||!strings(action.paths)||!strings(action.unexpectedPaths)||action.authoringContinuation!==null
      &&(!keys(action.authoringContinuation,['allowed','status'])||typeof action.authoringContinuation.allowed!=='boolean'
        ||!nullableText(action.authoringContinuation.status)))return false;
  for(const blocker of recovery.blockers)if(!keys(blocker,['category','path','details'])||blocker.category!=='inputs'
    ||!nullableText(blocker.path)||!keys(blocker.details,['upstreamPhase','status','restorable'])
    ||!nullableText(blocker.details.upstreamPhase)||!nullableText(blocker.details.status)||typeof blocker.details.restorable!=='boolean')return false;
  for(const document of documents.missing)if(!keys(document,['id','name','sha256'])||!text(document.id)||!text(document.name)||!digest(document.sha256))return false;
  return documents.localDocumentCount<=documents.documentCount&&documents.missing.length<=documents.localDocumentCount;
}

export function phaseEntryInspection(binding,facts) {
  if(!keys(facts,['workId','phase','generation','inspectionGeneration','authoring','recovery','references','deterministic','documents','resources','budgets'])
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||facts.generation!==binding.generation
    ||facts.inspectionGeneration!==binding.inspectionGeneration||!admissionFactsValid(facts)||facts.deterministic!==binding.deterministic
    ||!keys(facts.budgets,['documentPreviewBytes','supportingTotalBytes'])||!count(facts.budgets.documentPreviewBytes)
    ||facts.budgets.documentPreviewBytes>1_048_576||!count(facts.budgets.supportingTotalBytes)||!Array.isArray(facts.resources))bad();
  if(facts.authoring.entry.status==='successor-preparation-required'&&facts.authoring.targetGeneration!==binding.nextGeneration)bad();
  const seen=new Set(),inputs=new Set(),sources=new Set();let supporting=0,local=0;
  for(const resource of facts.resources) {
    if(!keys(resource,['id','role','reference','producer','sourceKey','required','expected','locality','availability'])
      ||!text(resource.id)||seen.has(resource.id)||!['approved-input','story-source','supporting-document'].includes(resource.role)
      ||typeof resource.required!=='boolean'||!nullableText(resource.producer)||!nullableText(resource.sourceKey)
      ||!['project','machine-local','external'].includes(resource.locality)
      ||!['verify-on-read','verified-local','reupload-required','unavailable','reference-only'].includes(resource.availability)
      ||resource.expected!==null&&(!keys(resource.expected,['sha256','bytes'])||Object.keys(resource.expected).length!==2
        ||!digest(resource.expected.sha256)||resource.expected.bytes!==null&&!count(resource.expected.bytes)))bad();
    seen.add(resource.id);
    if(resource.reference===null) {if(resource.availability!=='unavailable')bad();}
    else if(!validDocumentReference(resource.reference)||typeof resource.reference==='string'||resource.reference.workId!==binding.workId)bad();
    if(resource.role==='approved-input') {
      const input=binding.inputs.find(input=>input.phase===resource.producer);
      if(!input||inputs.has(input.phase)||resource.required!==input.required||resource.locality!=='project')bad();
      inputs.add(input.phase);
      if(resource.reference!==null&&(resource.reference.kind!=='phase-document'||resource.reference.phase!==input.phase
        ||resource.reference.generation!==input.generation))bad();
      const retained=input.retained.find(item=>item.role==='artifact'&&item.sourceKey===resource.sourceKey);
      if(retained?.sha256?resource.expected?.sha256!==retained.sha256||resource.expected?.bytes!==retained.bytes:resource.expected!==null)bad();
    } else {
      if(resource.producer!==null||resource.sourceKey!==null||resource.reference?.kind!=='story-document'
        ||resource.reference.id!==resource.id)bad();
      if(resource.role==='story-source') {
        if(!['SYS-STORY','SYS-SOURCE'].includes(resource.id)||!resource.required||resource.locality!=='project'||resource.expected!==null)bad();
        sources.add(resource.id);
      } else {supporting+=1;if(resource.locality==='machine-local')local+=1;}
    }
  }
  if(inputs.size!==binding.inputs.length||sources.size!==2||supporting!==facts.documents.documentCount||local!==facts.documents.localDocumentCount)bad();
  return {facts,admission:phaseCompositionAdmission(facts)};
}

export function phaseEntryComposition(binding,facts) {
  if(!keys(facts,['workId','phase','generation','deliveredSha256','renderedSha256','bytes','fileAvailable'])
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||facts.generation!==binding.nextGeneration
    ||!digest(facts.deliveredSha256)||facts.renderedSha256!==null&&!digest(facts.renderedSha256)
    ||!count(facts.bytes)||typeof facts.fileAvailable!=='boolean')bad();
  return facts;
}

export function phaseEntryClarification(binding,facts) {
  if(!keys(facts,['workId','phase','generation','mode','recordState','errorCount','maxQuestions','recordedQuestions','recordPromptSha256','staleOnly','stagingIssued'])
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||facts.generation!==binding.inspectionGeneration
    ||!['off','when-needed','required'].includes(facts.mode)||!['not-applicable','missing','invalid','stale-or-incomplete','complete'].includes(facts.recordState)
    ||!count(facts.errorCount)||!count(facts.maxQuestions)||!count(facts.recordedQuestions)
    ||facts.recordPromptSha256!==null&&!(facts.errorCount?text(facts.recordPromptSha256):digest(facts.recordPromptSha256))||typeof facts.staleOnly!=='boolean'
    ||typeof facts.stagingIssued!=='boolean'||facts.stagingIssued!==(facts.mode!=='off'))bad();
  if(facts.recordState==='missing'&&(facts.mode==='required'?facts.errorCount<1:facts.errorCount!==0)
    ||facts.recordState==='complete'&&facts.errorCount!==0
    ||['invalid','stale-or-incomplete'].includes(facts.recordState)&&facts.errorCount<1
    ||facts.mode==='off'&&(facts.recordState!=='not-applicable'||facts.errorCount!==0)
    ||facts.mode!=='off'&&facts.recordState==='not-applicable')bad();
  try{normalizeClarificationPolicy({mode:facts.mode,maxQuestions:facts.maxQuestions});}catch{bad();}
  if(facts.recordState==='complete'&&(facts.recordedQuestions<1||facts.recordedQuestions>facts.maxQuestions||!digest(facts.recordPromptSha256)))bad();
  return {...facts,...clarificationCheckpointState(facts.mode,facts.recordState,facts.errorCount)};
}

export function phaseEntryPlan(binding,inspection,composition,clarification,{compose=false}={}) {
  const {facts,admission}=inspection,canCompose=admission.allowed;
  const authoringAllowed=Boolean(canCompose&&clarification.errorCount===0);
  const requiresDecision=facts.recovery.actions.some(action=>action.id==='working-tree'&&action.confirmation!=='none');
  const preparationAdmitted=facts.authoring.policyVerified&&facts.authoring.entry.status==='successor-preparation-required'
    &&!facts.recovery.requiresRecovery&&!requiresDecision&&facts.references.status!=='blocked';
  const questioningAllowed=clarification.questioningAllowed&&canCompose;
  const status=facts.documents.status!=='ready'?'documents-required'
    :facts.authoring.entry.status==='retained-generation'?'retained-generation'
    :preparationAdmitted?'successor-preparation-required':authoringAllowed?'authoring-entry'
      :canCompose&&facts.authoring.entry.status==='authoring-entry'&&questioningAllowed?'clarification-required':'attention-required';
  const checkpoint={questioningAllowed,contextRequired:questioningAllowed&&!composition,contextDelivered:Boolean(composition),
    artifactAuthoringAllowed:authoringAllowed,
    answerBinding:{workId:binding.workId,phase:binding.phase,generation:binding.inspectionGeneration,
      promptSha256:(composition?.generation===binding.inspectionGeneration?composition.renderedSha256:null)??clarification.recordPromptSha256??null},
    remainingQuestions:clarification.stage==='complete'?Math.max(0,clarification.maxQuestions-clarification.recordedQuestions):null};
  return {status,authoringAllowed,codeAuthoringReady:Boolean(binding.generatesCode&&authoringAllowed&&binding.codeGenerationReady),
    preparationAdmitted,compositionRequested:compose,contextComposition:!compose?'not-requested':composition?'delivered':'not-admitted',checkpoint,
    recordingAllowed:Boolean(questioningAllowed&&composition),
    newQuestionAllowed:clarification.stage==='complete'&&canCompose&&checkpoint.remainingQuestions>0,
    rebindAllowed:clarification.stage==='inspect-binding'&&clarification.staleOnly&&canCompose};
}

export function phaseEntryManifest(binding,inspection,composition,clarification,plan,finished) {
  if(!keys(finished,['workId','phase','generation','task'])||finished.workId!==binding.workId||finished.phase!==binding.phase
    ||finished.generation!==binding.inspectionGeneration||finished.task!==null&&(!keys(finished.task,['operationId','state','continuationBudget'])
      ||!text(finished.task.operationId)||!text(finished.task.state)||!keys(finished.task.continuationBudget,['consumed','maximum'])
      ||!count(finished.task.continuationBudget.consumed)||!count(finished.task.continuationBudget.maximum)))bad();
  if(!binding.ready)return null;
  const inputOrder=new Map(binding.inputs.map((input,index)=>[input.phase,index]));
  const rank=resource=>resource.role==='approved-input'?0:resource.role==='story-source'?1:2;
  const resources=[...inspection.facts.resources].sort((a,b)=>rank(a)-rank(b)
    ||(rank(a)===0?inputOrder.get(a.producer)-inputOrder.get(b.producer):a.id<b.id?-1:a.id>b.id?1:0))
    .map(({sourceKey:_,...resource},index)=>({order:index+1,...resource,budgetBytes:inspection.facts.budgets.documentPreviewBytes}));
  return {schemaVersion:1,contract:'sflow-phase-entry-manifest/v1',purpose:'phase-authoring',workId:binding.workId,phase:binding.phase,
    publishedGeneration:binding.generation,inspectionGeneration:binding.inspectionGeneration,prospectiveGeneration:binding.nextGeneration,
    agentId:binding.agentId,budgets:inspection.facts.budgets,resources,readsVerified:false,
    context:composition?{generation:composition.generation,deliveredSha256:composition.deliveredSha256,
      renderedSha256:composition.renderedSha256,bytes:composition.bytes,fileAvailable:composition.fileAvailable}:null,
    clarification:{mode:clarification.mode,recordState:clarification.recordState,stage:clarification.stage,
      requiresHumanResponse:clarification.requiresHumanResponse,errorCount:clarification.errorCount,maxQuestions:clarification.maxQuestions,
      recordedQuestions:clarification.recordedQuestions,staleOnly:clarification.staleOnly,...plan.checkpoint},task:finished.task,
    humanReviewRecorded:false,approvalRecorded:false};
}
