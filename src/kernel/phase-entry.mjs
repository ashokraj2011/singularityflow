/** Authoring entry vocabulary and context manifest. Integrations own all prompt/command wording. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {currentEntryPhase,phaseCompositionAdmission} from './phase-admission.mjs';
import {nextPhaseGeneration,phaseReviewSelection} from './phase-policy.mjs';
import {approvedInputPhases,resolvedPhaseInputs,clarificationCheckpointState,normalizeClarificationPolicy} from './phase-inputs.mjs';
import {validDocumentReference} from './document-read.mjs';
import {clarificationPublicationState,resolvedClarificationPolicy} from './clarification-responses.mjs';
import {effectivePhasePublicationProducer} from './phase-policy.mjs';
import {utf8Bytes} from './artifact-content.mjs';

const text=value=>typeof value==='string'&&value.length>0&&value.length<=4096;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const nullableText=value=>value===null||text(value);
const strings=value=>Array.isArray(value)&&value.every(text);
function bad(){throw new SingularityFlowError('The phase entry port returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});}

export const CONTENT_PHASE_ENTRY_PROFILE='sflow-phase-entry-manifest/v2';
const exact=(value,fields)=>keys(value,fields)&&Object.keys(value).length===fields.length;
const contentRef=value=>exact(value,['namespace','sha256','bytes'])&&['config','state','evidence','runtime','local'].includes(value.namespace)
  &&digest(value.sha256)&&count(value.bytes)&&value.bytes<=134217728;
/** Explicit protocol dispatch keeps the existing checkout manifest and callbacks unchanged. */
export function phaseEntryProtocol(context) {
  if(context.manifestProfile===undefined)return {selection:phaseEntrySelection,inspection:phaseEntryInspection,
    composition:phaseEntryComposition,clarification:phaseEntryClarification,plan:phaseEntryPlan,manifest:phaseEntryManifest};
  if(context.manifestProfile!==CONTENT_PHASE_ENTRY_PROFILE)throw new SingularityFlowError(
    'This phase-entry manifest requires its matching protocol.',{code:'ENGINE_STORAGE_UNSUPPORTED',details:{profile:context.manifestProfile}});
  return {selection:contentEntrySelection,inspection:contentEntryInspection,composition:contentEntryComposition,
    clarification:contentEntryClarification,plan:contentEntryPlan,manifest:contentEntryManifest};
}
function contentEntrySelection(context,inputs) {
  const binding=phaseEntrySelection(context,inputs);
  if(!text(context.projectId)||typeof context.modelEnabled!=='boolean')bad();
  const phase=context.workflow.phases[binding.phase],producer=effectivePhasePublicationProducer(phase,{modelEnabled:context.modelEnabled});
  return {...binding,projectId:context.projectId,producer,authorAgentId:phase.defaultAgent??binding.agentId,
    clarificationPolicy:resolvedClarificationPolicy({},context.workflow,phase)};
}
export function phaseContextResources(value,{maximumBytes=65536}={}) {
  if(!Array.isArray(value)||value.length>4096||!count(maximumBytes)||maximumBytes>1048576)bad();
  const roles=['constitution','agent','skill','instruction','story-source','approved-input','supporting-document','human-clarifications','artifact-template','generation-intent','current-draft'];
  const rank=kind=>kind==='constitution'?0:['agent','skill','instruction'].includes(kind)?1:roles.indexOf(kind);
  const ids=new Set();
  for(const resource of value) {
    if(!exact(resource,['id','kind','reference','locality','availability','phase','generation'])||!text(resource.id)||ids.has(resource.id)
      ||!roles.includes(resource.kind)||!contentRef(resource.reference)||!['project','machine-local'].includes(resource.locality)
      ||!['verified','verify-on-read','reupload-required'].includes(resource.availability)||!nullableText(resource.phase)
      ||resource.generation!==null&&(!count(resource.generation)||resource.generation<1)
      ||(resource.reference.namespace==='local')!==(resource.locality==='machine-local')
      ||resource.availability!=='verified'&&resource.locality!=='machine-local')bad();
    ids.add(resource.id);
  }
  return [...value].sort((a,b)=>rank(a.kind)-rank(b.kind)).map((resource,index)=>({...resource,order:index+1,budgetBytes:Math.min(resource.reference.bytes,maximumBytes)}));
}
function contentEntryInspection(binding,facts) {
  if(!exact(facts,['workId','phase','generation','inspectionGeneration','projectId','authoring','recovery','references','deterministic','documents','budgets','resources',
    'contextIdentity','permissions','draft','blockers','configuration'])||facts.workId!==binding.workId||facts.phase!==binding.phase
    ||facts.generation!==binding.generation||facts.inspectionGeneration!==binding.inspectionGeneration||facts.projectId!==binding.projectId
    ||!admissionFactsValid(facts)||facts.deterministic!==binding.deterministic
    ||!exact(facts.budgets,['documentPreviewBytes','supportingTotalBytes'])||!count(facts.budgets.documentPreviewBytes)||facts.budgets.documentPreviewBytes>1048576
    ||!count(facts.budgets.supportingTotalBytes)||!strings(facts.permissions)||!Array.isArray(facts.blockers)
    ||!exact(facts.contextIdentity,['sha256','bytes'])||!digest(facts.contextIdentity.sha256)||!count(facts.contextIdentity.bytes)
    ||!exact(facts.configuration,['key','content'])||!text(facts.configuration.key)||!contentRef(facts.configuration.content)||facts.configuration.content.namespace!=='config')bad();
  if(facts.blockers.some(item=>!exact(item,['code','message','details'])||!text(item.code)||!text(item.message)))bad();
  const draft=facts.draft;
  if(draft!==null&&(!exact(draft,['generation','revision','bodySha256','baseRevision','artifact','intent'])
    ||!count(draft.generation)||draft.generation<1||!text(draft.revision)||!digest(draft.bodySha256)||!text(draft.baseRevision)
    ||!contentRef(draft.artifact)||draft.artifact.namespace!=='local'
    ||draft.intent!==null&&(!exact(draft.intent,['id','reference'])||!text(draft.intent.id)||!contentRef(draft.intent.reference)||draft.intent.reference.namespace!=='local')))bad();
  const resources=phaseContextResources(facts.resources,{maximumBytes:facts.budgets.documentPreviewBytes}),admission=phaseCompositionAdmission(facts);
  const ofKind=kind=>resources.filter(item=>item.kind===kind),sameReference=(a,b)=>a.namespace===b.namespace&&a.sha256===b.sha256&&a.bytes===b.bytes;
  if(ofKind('story-source').length!==1||ofKind('artifact-template').length!==1||ofKind('agent').length!==(binding.authorAgentId===null?0:1)
    ||ofKind('constitution').length>1||ofKind('human-clarifications').length>1
    ||ofKind('supporting-document').length!==facts.documents.documentCount
    ||ofKind('supporting-document').filter(item=>item.locality==='machine-local').length!==facts.documents.localDocumentCount)bad();
  for(const input of binding.inputs) {
    const matches=ofKind('approved-input').filter(item=>item.phase===input.phase);
    if(input.status!=='approved'){if(matches.length||input.required)bad();continue;}
    if(matches.length!==1||matches[0].generation!==input.generation||!input.retained.some(item=>item.role==='artifact'
      &&item.sha256===matches[0].reference.sha256&&(item.bytes===null||item.bytes===matches[0].reference.bytes)))bad();
  }
  if(ofKind('approved-input').some(item=>!binding.inputs.some(input=>input.phase===item.phase)))bad();
  const current=ofKind('current-draft'),intent=ofKind('generation-intent');
  if(current.length!==(draft===null?0:1)||draft!==null&&(!sameReference(current[0].reference,draft.artifact)||current[0].phase!==binding.phase||current[0].generation!==draft.generation)
    ||intent.length!==(draft?.intent?1:0)||draft?.intent&&(!sameReference(intent[0].reference,draft.intent.reference)||intent[0].phase!==binding.phase||intent[0].generation!==draft.generation))bad();
  for(const blocker of facts.blockers)admission.blockers.push({code:blocker.code,details:blocker.details});
  admission.allowed=admission.blockers.length===0;
  return {facts:{...facts,resources},admission};
}
function contentEntryComposition(binding,facts) {
  if(!exact(facts,['workId','phase','generation','sha256','bytes'])||facts.workId!==binding.workId||facts.phase!==binding.phase
    ||facts.generation!==binding.inspectionGeneration||!digest(facts.sha256)||!count(facts.bytes))bad();
  return facts;
}
function contentEntryClarification(binding,facts) {
  if(!exact(facts,['workId','phase','generation','contextSha256','record'])||facts.workId!==binding.workId||facts.phase!==binding.phase
    ||facts.generation!==binding.inspectionGeneration||!digest(facts.contextSha256))bad();
  const record=facts.record,policy=binding.clarificationPolicy;
  if(record!==null&&(!exact(record,['reference','contextSha256','responses','completed'])||!contentRef(record.reference)||record.reference.namespace!=='evidence'
    ||!digest(record.contextSha256)||!Array.isArray(record.responses)||typeof record.completed!=='boolean'))bad();
  let state;try{state=clarificationPublicationState(policy,record?{...record,phase:binding.phase}:null,binding.producer);}catch{bad();}
  const stale=record!==null&&record.contextSha256!==facts.contextSha256;
  const errors=[...state.errors,...(stale?['record-binding-changed']:[])];
  return {...facts,mode:policy.mode,errorCount:errors.length,errors,recordState:policy.mode==='off'?'not-applicable':record===null?'missing':errors.length?'stale-or-incomplete':'complete',
    maxQuestions:policy.maxQuestions,recordedQuestions:record?.responses.length??0,staleOnly:stale&&state.ready,
    ...clarificationCheckpointState(policy.mode,record===null?'missing':'recorded',errors.length),stagingIssued:false};
}
function contentEntryPlan(binding,inspection,composition,clarification,{compose=false}={}) {
  const {facts,admission}=inspection,retained=facts.authoring.entry.status==='retained-generation',draft=facts.draft,
    current=draft!==null&&draft.baseRevision===binding.revision&&draft.generation===binding.inspectionGeneration;
  const human=facts.resources.filter(item=>item.kind==='human-clarifications');
  if(human.length!==(clarification.record===null?0:1)||clarification.record&&(human[0].reference.sha256!==clarification.record.reference.sha256
    ||human[0].reference.bytes!==clarification.record.reference.bytes||human[0].reference.namespace!=='evidence'))bad();
  const authoringAllowed=admission.allowed&&!retained&&clarification.errorCount===0&&current&&facts.permissions.includes('phase.draft.write');
  const status=retained?'retained-generation':facts.documents.status!=='ready'?'documents-required':!admission.allowed?'attention-required'
    :clarification.errorCount?'clarification-required':!current?draft?'draft-rebind-required':'preparation-required'
      :!facts.permissions.includes('phase.draft.write')?'author-permission-required':'authoring-entry';
  return {status,authoringAllowed,codeAuthoringReady:Boolean(binding.generatesCode&&authoringAllowed&&binding.codeGenerationReady&&draft?.intent),
    compositionRequested:compose,contextComposition:!compose?'not-requested':composition?'delivered':'not-admitted',
    questioningAllowed:!retained&&admission.allowed&&clarification.questioningAllowed,
    recordingAllowed:!retained&&admission.allowed&&clarification.mode!=='off'&&(clarification.questioningAllowed||clarification.errorCount>0),
    rebindAllowed:!retained&&admission.allowed&&clarification.staleOnly};
}
function contentEntryManifest(binding,inspection,composition,clarification,plan,finished) {
  if(!exact(finished,['workId','phase','generation','revision','task'])||finished.workId!==binding.workId||finished.phase!==binding.phase
    ||finished.generation!==binding.inspectionGeneration||finished.revision!==binding.revision||finished.task!==null)bad();
  if(!binding.ready)return null;
  if(composition&&(composition.sha256!==inspection.facts.contextIdentity.sha256||composition.bytes!==inspection.facts.contextIdentity.bytes))bad();
  const {facts}=inspection;
  const inputs={workId:binding.workId,phaseId:binding.phase};
  const action=plan.status==='retained-generation'?{operation:'phase.review',inputs}
    :plan.status==='clarification-required'?{operation:'clarification.record',inputs:{...inputs,contextSha256:clarification.contextSha256,agentId:binding.authorAgentId,
      ...(clarification.record?{replace:true}:{})},prerequisites:['human-responses','authenticated-phase-authority',...(clarification.record?['review-existing-answers','reason']:[])]}
    :plan.status==='preparation-required'?{operation:'phase.prepare',inputs,prerequisites:['machine-local-working-store','phase.prepare-permission']}
    :plan.status==='draft-rebind-required'?{operation:'phase.draft.rebase',inputs:{...inputs,expectedRevision:facts.draft.revision,confirm:facts.draft.bodySha256},prerequisites:['human-draft-review','operation-id','reason']}
    :plan.status==='authoring-entry'?{operation:'phase.draft.write',inputs:{...inputs,expectedRevision:facts.draft.revision},prerequisites:['authored-content-reference','operation-id','reason']}
    :plan.status==='author-permission-required'?{operation:'phase.enter',inputs,prerequisites:['phase.draft.write-permission']}
    :{operation:'phase.enter',inputs,prerequisites:inspection.admission.blockers.map(item=>item.code)};
  return {schemaVersion:2,contract:CONTENT_PHASE_ENTRY_PROFILE,purpose:'phase-authoring',projectId:binding.projectId,workId:binding.workId,phase:binding.phase,
    publishedGeneration:binding.generation,inspectionGeneration:binding.inspectionGeneration,prospectiveGeneration:binding.nextGeneration,
    agentId:binding.agentId,authorAgentId:binding.authorAgentId,configuration:facts.configuration,revision:binding.revision,budgets:facts.budgets,resources:facts.resources,
    context:{...facts.contextIdentity,representation:'resource-manifest',delivered:Boolean(composition)},readsVerified:false,
    draft:facts.draft,clarification:{mode:clarification.mode,recordState:clarification.recordState,stage:clarification.stage,
      contextSha256:clarification.contextSha256,record:clarification.record?{reference:clarification.record.reference,contextSha256:clarification.record.contextSha256}:null,
      errorCount:clarification.errorCount,recordedQuestions:clarification.recordedQuestions,maxQuestions:clarification.maxQuestions,
      questioningAllowed:plan.questioningAllowed,recordingAllowed:plan.recordingAllowed,rebindAllowed:plan.rebindAllowed},
    blockers:[...inspection.admission.blockers],actions:[action],execution:{inspected:false},humanReviewRecorded:false,approvalRecorded:false};
}

export function phaseContextReadInput(value) {
  const fields=['workId','phaseId','contextSha256','resourceId','maximumBytes','representation','offset'];
  if(!keys(value,fields)||['workId','phaseId','resourceId'].some(key=>!text(value[key]))||!digest(value.contextSha256)
    ||value.maximumBytes!==undefined&&(!count(value.maximumBytes)||value.maximumBytes>1048576)
    ||value.offset!==undefined&&!count(value.offset)||value.representation!==undefined&&!['text','base64','metadata'].includes(value.representation)
    ||(value.offset??0)>0&&(value.representation??'text')!=='base64')throw new SingularityFlowError(
    'Read an exact issued phase resource under a bounded representation.',{code:'ENGINE_INPUT_INVALID'});
  return {...value,maximumBytes:value.maximumBytes??65536,representation:value.representation??'text',offset:value.offset??0};
}
export function phaseContextReadResult(input,facts) {
  if(!exact(facts,['workId','phase','generation','contextSha256','resourceId','reference','representation','offset','encoding','content'])
    ||facts.workId!==input.workId||facts.phase!==input.phaseId||facts.contextSha256!==input.contextSha256||facts.resourceId!==input.resourceId
    ||!count(facts.generation)||facts.generation<1||!contentRef(facts.reference)||facts.offset!==input.offset||facts.representation!==input.representation
    ||!['utf8','binary'].includes(facts.encoding)||input.offset>facts.reference.bytes)bad();
  const body=facts.content;
  if(body!==null) {
    if(input.representation==='text') {
      if(facts.encoding!=='utf8'||!exact(body,['kind','text','bytes','truncated'])||body.kind!=='text'||typeof body.text!=='string'||!count(body.bytes)
        ||utf8Bytes(body.text)!==body.bytes||body.bytes>input.maximumBytes||body.bytes>facts.reference.bytes
        ||body.truncated!==(body.bytes<facts.reference.bytes))bad();
    }else if(input.representation==='base64') {
      if(!exact(body,['kind','base64','bytes','truncated'])||body.kind!=='bytes'||typeof body.base64!=='string'
        ||!count(body.bytes)||body.bytes>input.maximumBytes||input.offset+body.bytes>facts.reference.bytes
        ||body.truncated!==(input.offset+body.bytes<facts.reference.bytes)||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(body.base64)
        ||body.base64.length/4*3-(body.base64.endsWith('==')?2:body.base64.endsWith('=')?1:0)!==body.bytes)bad();
    }else bad();
  }else if(input.representation!=='metadata'&&(input.representation!=='text'||facts.encoding!=='binary'))bad();
  return {status:'read',subject:{kind:'story',id:input.workId},...facts,
    effects:{committed:false,pushed:false,testsRun:false,approvalRecorded:false,storyAdvanced:false}};
}

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
