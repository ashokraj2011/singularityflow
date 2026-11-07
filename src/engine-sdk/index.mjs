/**
 * Engine operation vocabulary v1. Only trusted ports perform I/O. Host flags, command strings,
 * model prose, repository discovery and provider selection never enter this dispatcher.
 */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { publicationAuthorshipIntent, assertPublicationAuthorshipIntent } from '../kernel/publication-intent.mjs';
import { submissionDecisionIntent, assertSubmissionIntent, assertConvergenceAdvanceConfirmation } from '../kernel/submission-intent.mjs';
import { assertApprovalReviewConfirmation, phaseRejectionSelection, phaseRejectionResult } from '../kernel/approval-policy.mjs';
import {decisionRecordPlan,assertDecisionConfirmation,standaloneDecisionAdmission,standaloneDecisionRequest,planCorrectionOwner,
  upstreamOperationAdmission,upstreamOperationRequest} from '../kernel/decision-plan.mjs';
import {runDecisionPlan} from './decision-execution.mjs';
import {phaseReviewSelection,phaseReviewManifest,phaseBeginSelection,phaseBeginResult,
  phaseRolloverSelection,phaseRolloverPlan,assertPhaseRolloverConfirmation} from '../kernel/phase-policy.mjs';
import {MAXIMUM_DOCUMENT_READ_BYTES,validDocumentReference,documentReadSelection,
  documentReadBinding,documentReadResult} from '../kernel/document-read.mjs';
import {phaseCompositionAdmission} from '../kernel/phase-admission.mjs';
import {phaseEntrySelection,phaseEntryInspection,phaseEntryComposition,phaseEntryClarification,
  phaseEntryPlan,phaseEntryManifest} from '../kernel/phase-entry.mjs';
import {phasePrepublishSelection,phasePrepublishManifest,phaseDraftCheckSelection,phaseDraftCheckManifest} from '../kernel/phase-prepublish.mjs';
import {phasePreparationSelection,phasePreparationManifest} from '../kernel/phase-preparation.mjs';
import {workflowAssetSelection,workflowAssetManifest} from '../kernel/workflow-assets.mjs';

export const ENGINE_CONTRACT = 'sflow-engine/v1';
/** Convenience names are aliases for the registry, never independent execution paths. */
export const ENGINE_HELPERS = Object.freeze({
  publishPhase: 'phase.publish', beginPhase: 'phase.begin', preparePhase: 'phase.prepare',
  rolloverPhase: 'phase.rollover', prepublishPhase: 'phase.prepublish', draftCheckPhase: 'phase.draft-check',
  submitPhase: 'phase.submit', submitConvergence: 'convergence.submit', approvePhase: 'phase.approve', rejectPhase: 'phase.reject',
  recordDecisions: 'decisions.record', advanceConvergence: 'convergence.advance'
});
const PUBLISH_FIELDS = Object.freeze([
  'workId', 'phaseId', 'authored', 'channel', 'from', 'usageFile', 'usage', 'externalAiUse', 'changeOrigins'
]);
const SUBMIT_FIELDS = Object.freeze(['workId', 'phaseId', 'runChecks', 'decisionValues']);
const CONVERGENCE_FIELDS = Object.freeze([...SUBMIT_FIELDS, 'confirmation']);
const ADVANCE_FIELDS = Object.freeze(['workId','confirmation','runChecks','decisionValues']);
const WRITE_STAGES = Object.freeze(['load', 'retained', 'prepare', 'commit', 'finish']);
const APPROVAL_FIELDS = Object.freeze(['workId','phaseId','confirmation','selectionReceipt','fetch','agent',
  'checklist','witnessMappings','bindingDecisions','decisions','confirmEvidence','evidenceReason']);
const DECISION_FIELDS = Object.freeze(['workId','phaseId','fetch','answers','confirmation']);
const CORRECTION_FIELDS=Object.freeze(['ownerPhase','operations','reason','upstreamIssue']);
const SINGLE_DECISIONS = Object.freeze([
  ['decision.scope','scope-disposition',['item','disposition','clauseIds','reason']],
  ['decision.completeness','completeness-review',['confirm','checklist','reason']],
  ['decision.applicability','applicability',['responsibility','reason']],
  ['decision.risk','obligation-risk',['obligationId','revoke','category','transitions','expires','reason']],
  ['decision.plan','plan-amendment',['changes','reason'],{keepsCurrentPhase:true}],
  ['decision.choose','routing',['option','to','expected','reason']],
  ['decision.witness','witness',['clauseId','slotName','file','answers','reason','expectedContext','expectedFile'],{keepsCurrentPhase:true}],
  ['decision.witness-exception','witness-exception-renewal',['phaseId','mappingSha256','expires','reason'],
    {phaseBinding:'requested-target',keepsCurrentPhase:true}]
].map(([id,recordKind,fields,options={}])=>Object.freeze({id,recordKind,requestFields:Object.freeze(fields),...options})));
const TEST_DECISIONS = Object.freeze([
  ['decision.evidence-reuse','evidence-reuse',['phaseId','attemptId','revoke','reason','expires'],['phaseId','attemptId','revoke','reason','expires']],
  ['decision.visual-profile','visual-profile',['phaseId','profileId','notApplicable','revoke','reason'],['phaseId','profileId','revoke','reason']],
  ['decision.test-narrowing','test-narrowing',['phaseId','commandId','revoke','reason','expires'],['phaseId','commandId','revoke','reason','expires']],
  ['decision.test-risk','test-run-risk',['phaseId','commandId','argvSha256','causeClass','cause','revoke','reason','expires'],['phaseId','commandId','argvSha256','causeClass','cause','revoke','reason','expires']],
  ['test-command.request','test-command-request',['phaseId','command','suggestionId','sourceRoots','repinId','reason'],['phaseId','command','repin','reason']],
  ['test-command.decide','test-command-decision',['accept','revoke','reason'],['phaseId','accept','revoke','reason']]
].map(([id,recordKind,fields,intentFields])=>Object.freeze({id,recordKind,
  requestFields:Object.freeze(fields),intentFields:Object.freeze(intentFields)})));
const UPSTREAM_OPERATIONS=Object.freeze([
  ['upstream.list',['open'],'read',false],
  ['upstream.raise',['phaseId','about','problem','assumption','impact','proposed','authored','fromArtifact','supersedes'],'upstream-issue',false],
  ['upstream.decide',['issueId','outcome','reason','link','expires'],'upstream-decision',true],
  ['forward-amendment.propose',['phaseId','reason','file','upstreamIssue'],'amendment-proposal',false],
  ['forward-amendment.decide',['amendmentId','decision','reason','confirmation'],'amendment-decision',true],
  ['forward-amendment.revalidate',['phaseId','amendmentId','outcome','reason'],'amendment-revalidation',true]
].map(([id,fields,effect,humanDecision])=>({id,version:1,effect,humanDecision,requestFields:Object.freeze(fields),
  inputFields:Object.freeze(['workId',...fields]),port:'upstream',stages:Object.freeze(['load','resolve','commit','finish']),
  ...(id==='forward-amendment.decide'?{confirmation:'exact-amendment-id'}:{}),validate:singleDecisionInput,execute:upstreamOperation})));
const definitions = [
  { id: 'phase.publish', version: 1, effect: 'publication',
    inputFields: PUBLISH_FIELDS, port: 'publication',
    stages: WRITE_STAGES, validate:publicationInput, execute:publish },
  { id: 'phase.submit', version: 1, effect: 'submission', inputFields: SUBMIT_FIELDS,
    port: 'submission', stages: WRITE_STAGES, validate:submissionInput, execute:submit },
  { id: 'convergence.submit', version: 1, effect: 'submission', inputFields: CONVERGENCE_FIELDS,
    confirmation: 'exact-reviewed-convergence-digest', port: 'submission', stages: WRITE_STAGES,
    validate:submissionInput, execute:submit },
  { id:'phase.approve',version:1,effect:'approval',inputFields:APPROVAL_FIELDS,port:'approval',
    humanDecision:true,stages:Object.freeze(['load','prepare','commit','finish']),
    validate:approvalInput,execute:approve },
  { id:'phase.reject',version:1,effect:'rejection',humanDecision:true,port:'rejection',
    inputFields:Object.freeze(['workId','phaseId','target','reason','clauseIds','members','repair','confirm','selectionReceipt','fetch','agent']),
    stages:Object.freeze(['load','prepare','commit','finish']),validate:rejectionInput,execute:reject },
  {id:'decisions.record',version:1,effect:'decision-records',inputFields:DECISION_FIELDS,port:'decisions',
    authority:'per-effect',humanDecision:true,stages:Object.freeze(['load','prepare','apply','finish']),
    validate:decisionInput,execute:recordDecisions},
  {id:'convergence.advance',version:1,effect:'submission',inputFields:ADVANCE_FIELDS,port:'advancement',
    humanDecision:true,confirmation:'exact-reviewed-convergence-digest',delegatesTo:'convergence.submit',
    stages:Object.freeze(['withReview']),validate:submissionInput,execute:advanceConvergence},
  ...['plan.correction.preview','plan.correct'].map(id=>({id,version:1,effect:id==='plan.correct'?'plan-correction':'read',
    humanDecision:id==='plan.correct',confirmation:id==='plan.correct'?'live-terminal-exact-plan-review':null,
    requestFields:CORRECTION_FIELDS,inputFields:Object.freeze(['workId','fetch',...CORRECTION_FIELDS]),port:'planCorrection',
    stages:Object.freeze(['load','prepare','review','authorize','commit','finish']),validate:singleDecisionInput,execute:correctPlan})),
  ...SINGLE_DECISIONS.map(operation=>({...operation,version:1,effect:'decision-record',humanDecision:true,
    inputFields:Object.freeze(['workId','fetch',...operation.requestFields]),port:'decisionRecord',
    stages:Object.freeze(['load','prepare','commit','finish']),validate:singleDecisionInput,execute:recordSingleDecision})),
  ...TEST_DECISIONS.map(operation=>({...operation,version:1,effect:'decision-record',
    humanDecision:operation.id!=='test-command.request',authority:operation.id==='test-command.request'?'requester':'reviewer',
    allowRetained:operation.id==='test-command.request',phaseBinding:'resolved-target',
    inputFields:Object.freeze(['workId','fetch',...operation.requestFields]),port:'testDecisionRecord',
    stages:Object.freeze(['load','prepare','resolve','commit','finish']),validate:singleDecisionInput,execute:recordSingleDecision})),
  ...UPSTREAM_OPERATIONS,
  {id:'workflow.assets',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workflowIds']),port:'workflowAssets',
    stages:Object.freeze(['load','read']),validate:workflowAssetsInput,execute:inspectWorkflowAssets},
  {id:'phase.review',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'phaseReview',
    stages:Object.freeze(['load','read']),validate:phaseReviewInput,execute:inspectPhaseReview},
  {id:'document.read',version:1,effect:'read',humanDecision:false,
    inputFields:Object.freeze(['workId','reference','includeDetached','maximumBytes']),port:'documentRead',
    stages:Object.freeze(['load','resolve','read']),validate:documentReadInput,execute:readDocument},
  {id:'phase.enter',version:1,effect:'context-entry',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId','compose']),port:'phaseEntry',
    stages:Object.freeze(['load','inspect','compose','clarify','finish']),validate:phaseEntryInput,execute:enterPhase},
  {id:'phase.begin',version:1,effect:'local-draft',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId','adoptExisting','confirm']),port:'phaseBegin',
    stages:Object.freeze(['load','verify','begin']),validate:phaseBeginInput,execute:beginPhase},
  {id:'phase.prepare',version:1,effect:'preparation',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId']),port:'phasePreparation',
    stages:Object.freeze(['load','prepare','inspect']),validate:phaseReviewInput,execute:preparePhase},
  {id:'phase.rollover',version:1,effect:'local-draft',humanDecision:false,
    confirmation:'exact-current-draft-digest',inputFields:Object.freeze(['workId','phaseId','confirm']),port:'phaseRollover',
    stages:Object.freeze(['load','inspect','begin']),validate:phaseBeginInput,execute:rolloverPhase},
  {id:'phase.prepublish',version:1,effect:'inspection',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId']),port:'phasePrepublish',
    stages:Object.freeze(['load','inspect']),validate:phaseReviewInput,execute:inspectPhaseCheck},
  {id:'phase.draft-check',version:1,effect:'inspection',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId']),port:'phaseDraftCheck',
    stages:Object.freeze(['load','inspect']),validate:phaseReviewInput,execute:inspectPhaseCheck}
];
export const ENGINE_OPERATIONS = Object.freeze(definitions.map(({validate,execute,...descriptor})=>Object.freeze(descriptor)));
const registry = new Map(definitions.map(operation => [operation.id, Object.freeze(operation)]));

function workflowAssetsInput(value) {
  const input = data(value);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'workflowIds')
    || !Array.isArray(input.workflowIds) || input.workflowIds.length > 8192
    || input.workflowIds.some(id => typeof id !== 'string')) invalid('Invalid workflow inventory selection.');
  return data({ workflowIds: [...new Set(input.workflowIds.map(id => id.trim()).filter(Boolean))] });
}

async function inspectWorkflowAssets(port, inputs, signal) {
  notCancelled(signal);
  const context = await port.load(inputs, { signal }); notCancelled(signal);
  const binding = data(workflowAssetSelection(context, inputs));
  const observed = await port.read(context, binding, { signal }); notCancelled(signal);
  let facts;
  try { facts = data(observed); } catch (cause) { throw new SingularityFlowError('The workflow asset port returned non-JSON facts.', { code: 'ENGINE_PORT_RESULT_INVALID', cause }); }
  const manifest = workflowAssetManifest(binding, facts);
  return data({ schemaVersion: 1, contract: ENGINE_CONTRACT, operation: 'workflow.assets', status: 'inspected',
    subject: { kind: 'configuration' }, effects: { committed: false, pushed: false, humanReviewRecorded: false, approvalRecorded: false }, manifest });
}

function invalid(message) {
  throw new SingularityFlowError(message, { code: 'ENGINE_INPUT_INVALID' });
}

function rejectionInput(value, operation) {
  const input = data(value);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !operation.inputFields.includes(key))
    || ['workId','phaseId','target','reason','confirm','selectionReceipt','agent'].some(key => input[key] != null && typeof input[key] !== 'string')
    || ['repair','fetch'].some(key => input[key] != null && typeof input[key] !== 'boolean')
    || ['clauseIds','members'].some(key => input[key] != null && (!Array.isArray(input[key]) || !input[key].every(value => typeof value === 'string')))) {
    invalid('Invalid rejection selection or change-request input.');
  }
  return input;
}

async function reject(port, inputs, signal) {
  notCancelled(signal);
  const context = await port.load(inputs, { signal }); notCancelled(signal);
  const binding = data(phaseRejectionSelection(context?.workflow, {
    ...inputs, phaseId: inputs.phaseId ?? context?.phase?.id ?? null
  }));
  if (context?.subject?.kind !== 'story' || context.subject.id !== binding.workId) {
    throw new SingularityFlowError('The rejection port returned another bound subject.', { code: 'ENGINE_PORT_RESULT_INVALID' });
  }
  const prepared = await port.prepare(context, inputs, { signal }); notCancelled(signal);
  const committed = await port.commit(context, prepared, { signal });
  try { return data(phaseRejectionResult(binding, data(await port.finish(context, prepared, committed)))); }
  catch (error) {
    if (error && typeof error === 'object' && Object.isExtensible(error)) error.enginePublication = committed;
    throw error;
  }
}

function attachDiagnostic(error,key,value) {
  try{if(error&&typeof error==='object'&&Object.isExtensible(error))error[key]=data(value);}
  catch{ /* Optional diagnostics cannot replace a native refusal. */ }
}

async function preparePhase(port,inputs,signal) {
  let binding=null,pendingStage='load';const completedStages=[];
  try {
    notCancelled(signal);
    const context=await port.load(inputs,{signal});completedStages.push('load');notCancelled(signal);
    binding=data(phasePreparationSelection(context?.workflow,inputs,context?.modelEnabled));pendingStage='prepare';
    await port.prepare(context,binding,{signal});completedStages.push('prepare');notCancelled(signal);pendingStage='inspect';
    const facts=await port.inspect(context,binding,{signal});completedStages.push('inspect');notCancelled(signal);
    let observed,manifest;
    try{observed=data(facts);manifest=data(phasePreparationManifest(binding,observed));}catch(error){
      if(error?.code==='ENGINE_INPUT_INVALID')throw new SingularityFlowError('The preparation port returned non-JSON facts.',{
        code:'ENGINE_PORT_RESULT_INVALID',cause:error});
      throw error;
    }
    return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.prepare',status:'prepared',
      subject:{kind:'story',id:binding.workId},phase:binding.phase,generation:binding.generation,manifest,
      effects:{prepared:true,localDraftSaved:true,generationOpened:observed.generationOpened,
        testsRun:false,modelInvocations:0,committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});
  }catch(error){
    attachDiagnostic(error,'enginePhasePreparation',{operation:'phase.prepare',
      subject:binding?{kind:'story',id:binding.workId}:null,phase:binding?.phase??null,generation:binding?.generation??null,
      completedStages,pendingStage,localEffectsMayExist:pendingStage==='prepare'||completedStages.includes('prepare'),
      committed:false,pushed:false,approvalRecorded:false});
    throw error;
  }
}

async function inspectPhaseCheck(port,inputs,signal,operation) {
  const prepublish=operation.id==='phase.prepublish';
  const selection=prepublish?phasePrepublishSelection:phaseDraftCheckSelection;
  const project=prepublish?phasePrepublishManifest:phaseDraftCheckManifest;
  let binding=null,pendingStage='load';const completedStages=[];
  try {
    notCancelled(signal);
    const context=await port.load(inputs,{signal});completedStages.push('load');notCancelled(signal);
    binding=data(selection(context?.workflow,inputs));pendingStage='inspect';
    const facts=await port.inspect(context,binding,{signal});completedStages.push('inspect');notCancelled(signal);
    let manifest;
    try{manifest=data(project(binding,data(facts)));}catch(error){
      if(error?.code==='ENGINE_INPUT_INVALID')throw new SingularityFlowError(`The ${prepublish?'prepublication':'draft-check'} port returned non-JSON facts.`,{
        code:'ENGINE_PORT_RESULT_INVALID',cause:error});
      throw error;
    }
    return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,
      status:(prepublish?manifest.admittedForAttempt:manifest.draftReady)?'ready':'correction-required',subject:{kind:'story',id:binding.workId},
      phase:binding.phase,generation:binding.generation,manifest,
      effects:{localProgressMayBeWritten:true,draftChanged:false,testsRun:false,modelInvocations:0,
        committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false,finalBindingChecked:false}});
  }catch(error){
    attachDiagnostic(error,prepublish?'enginePhasePrepublish':'enginePhaseDraftCheck',{operation:operation.id,
      subject:binding?{kind:'story',id:binding.workId}:null,phase:binding?.phase??null,generation:binding?.generation??null,
      completedStages,pendingStage,localProgressMayBeWritten:pendingStage==='inspect',committed:false,pushed:false,approvalRecorded:false});
    throw error;
  }
}

function phaseBeginInput(value,operation) {
  const input=data(value);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!operation.inputFields.includes(key))
    ||['workId','phaseId','confirm'].some(key=>input[key]!=null&&typeof input[key]!=='string')
    ||input.adoptExisting!=null&&typeof input.adoptExisting!=='boolean')invalid('Invalid generation selection or adoption request.');
  return input;
}

async function rolloverPhase(port,inputs,signal) {
  let binding=null,pendingStage='load';const completedStages=[];
  try {
    notCancelled(signal);
    const context=await port.load(inputs,{signal});completedStages.push('load');notCancelled(signal);
    binding=data(phaseRolloverSelection(context?.workflow,inputs));pendingStage='inspect';
    const facts=await port.inspect(context,binding,inputs,{signal});completedStages.push('inspect');notCancelled(signal);
    let plan;
    try{plan=data(phaseRolloverPlan(binding,data(facts)));}catch(error){
      if(error?.code==='ENGINE_INPUT_INVALID')throw new SingularityFlowError('The rollover port returned non-JSON facts.',{
        code:'ENGINE_PORT_RESULT_INVALID',cause:error});
      throw error;
    }
    pendingStage='confirmation';assertPhaseRolloverConfirmation(plan,inputs.confirm);
    let intent=null;
    if(inputs.confirm) {
      notCancelled(signal);pendingStage='begin';
      const opened=await port.begin(context,binding,plan,{signal});completedStages.push('begin');notCancelled(signal);
      try{intent=data(phaseBeginResult({...binding,retained:false},data(opened)));}catch(error){
        if(error?.code==='ENGINE_INPUT_INVALID')throw new SingularityFlowError('The rollover port returned non-JSON intent facts.',{
          code:'ENGINE_PORT_RESULT_INVALID',cause:error});
        throw error;
      }
    }
    return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.rollover',status:intent?'begun':'preview',
      subject:{kind:'story',id:binding.workId},phase:binding.phase,generation:binding.generation,plan,intent,
      effects:{localOnly:true,generationOpened:Boolean(intent),draftSaved:Boolean(intent),
        testsRun:false,modelInvocations:0,committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});
  }catch(error){
    attachDiagnostic(error,'enginePhaseRollover',{operation:'phase.rollover',
      subject:binding?{kind:'story',id:binding.workId}:null,phase:binding?.phase??null,generation:binding?.generation??null,
      completedStages,pendingStage,localEffectsMayExist:pendingStage==='begin',committed:false,pushed:false,approvalRecorded:false});
    throw error;
  }
}

async function beginPhase(port,inputs,signal) {
  let binding=null,pendingStage='load';const completedStages=[];
  try {
    notCancelled(signal);
    const context=await port.load(inputs,{signal});completedStages.push('load');notCancelled(signal);
    binding=data(phaseBeginSelection(context?.workflow,inputs));
    pendingStage=binding.retained?'verify':'begin';
    const facts=await port[pendingStage](context,binding,inputs,{signal});
    completedStages.push(pendingStage);notCancelled(signal);
    let intent;
    try{intent=data(phaseBeginResult(binding,data(facts)));}catch(error){
      if(error?.code==='ENGINE_INPUT_INVALID')throw new SingularityFlowError('The generation port returned non-JSON facts.',{
        code:'ENGINE_PORT_RESULT_INVALID',cause:error});
      throw error;
    }
    return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.begin',status:binding.retained?'retained':'begun',
      subject:{kind:'story',id:binding.workId},phase:binding.phase,generation:binding.generation,intent,
      effects:{localOnly:true,generationOpened:!binding.retained,draftSaved:!binding.retained,
        testsRun:false,modelInvocations:0,committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});
  } catch(error) {
    attachDiagnostic(error,'enginePhaseBegin',{operation:'phase.begin',
      subject:binding?{kind:'story',id:binding.workId}:null,phase:binding?.phase??null,generation:binding?.generation??null,
      completedStages,pendingStage,localEffectsMayExist:pendingStage==='begin',committed:false,pushed:false,approvalRecorded:false});
    throw error;
  }
}

function phaseEntryInput(value,operation) {
  const input=data(value);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!operation.inputFields.includes(key))
    ||['workId','phaseId'].some(key=>input[key]!=null&&typeof input[key]!=='string')
    ||input.compose!=null&&typeof input.compose!=='boolean')invalid('Invalid phase entry selection or composition request.');
  return input;
}

async function enterPhase(port,inputs,signal) {
  const compose=inputs.compose===true,completedStages=[];
  let binding=null,pendingStage='load',composition=null,clarification=null,finished=null;
  const copy=value=>{
    try{return data(value);}catch(cause){throw new SingularityFlowError('The phase entry port returned non-JSON facts.',{
      code:'ENGINE_PORT_RESULT_INVALID',cause});}
  };
  try {
    notCancelled(signal);
    const context=await port.load(inputs,{signal});completedStages.push('load');notCancelled(signal);
    if(typeof context?.paused!=='boolean')throw new SingularityFlowError('The phase entry port did not report its pause state.',{code:'ENGINE_PORT_RESULT_INVALID'});
    let inspection=null,admission=null,plan={status:'paused',authoringAllowed:false,codeAuthoringReady:false,
      contextComposition:compose?'not-admitted':'not-requested',compositionRequested:compose},manifest=null;
    if(!context.paused) {
      binding=data(phaseEntrySelection(context,inputs));
      if(!binding.ready) {
        admission=data(phaseCompositionAdmission({ready:false}));plan={...plan,status:'binding-required'};
      } else {
        pendingStage='inspect';
        const inspected=await port.inspect(context,binding,{signal});completedStages.push('inspect');notCancelled(signal);
        inspection=data(phaseEntryInspection(binding,copy(inspected)));admission=inspection.admission;
        if(compose&&admission.allowed) {
          pendingStage='compose';
          const facts=await port.compose(context,binding,{signal});completedStages.push('compose');notCancelled(signal);
          composition=data(phaseEntryComposition(binding,copy(facts)));
        }
        pendingStage='clarify';
        const facts=await port.clarify(context,binding,{signal});completedStages.push('clarify');notCancelled(signal);
        clarification=data(phaseEntryClarification(binding,copy(facts)));
        plan=data(phaseEntryPlan(binding,inspection,composition,clarification,{compose}));
      }
      pendingStage='finish';
      const facts=await port.finish(context,binding,{admission,plan},{signal});completedStages.push('finish');notCancelled(signal);
      finished=copy(facts);manifest=data(phaseEntryManifest(binding,inspection,composition,clarification,plan,finished));
    }
    const interrupted=finished?.task?.state==='inspect-interrupted-operation';
    return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.enter',status:interrupted?'attention-required':plan.status,
      subject:binding?{kind:'story',id:binding.workId}:null,phase:binding?.phase??null,
      generation:binding?.inspectionGeneration??null,revision:binding?.revision??null,admission,
      authoringAllowed:plan.authoringAllowed&&!interrupted,codeAuthoringReady:plan.codeAuthoringReady&&!interrupted,
      contextComposition:plan.contextComposition,manifest,
      effects:{contextCompositionRequested:compose,contextDelivered:Boolean(composition),clarificationStagingIssued:clarification?.stagingIssued??false,
        taskCheckpointUpdated:Boolean(finished?.task),testsRun:false,modelInvocations:0,storyAdvanced:false,
        committed:false,pushed:false,approvalRecorded:false}});
  } catch(error) {
    attachDiagnostic(error,'enginePhaseEntry',{operation:'phase.enter',
      subject:binding?{kind:'story',id:binding.workId}:null,phase:binding?.phase??null,generation:binding?.inspectionGeneration??null,
      completedStages,pendingStage,localEffectsMayExist:completedStages.some(stage=>['inspect','compose','clarify','finish'].includes(stage))
        ||pendingStage!=='load',committed:false,pushed:false,approvalRecorded:false});
    throw error;
  }
}

function documentReadInput(value,operation) {
  const input=data(value);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!operation.inputFields.includes(key))
    ||!validDocumentReference(input.reference)||input.workId!=null&&typeof input.workId!=='string'
    ||input.includeDetached!=null&&typeof input.includeDetached!=='boolean'
    ||input.maximumBytes!=null&&(!Number.isSafeInteger(input.maximumBytes)||input.maximumBytes<0
      ||input.maximumBytes>MAXIMUM_DOCUMENT_READ_BYTES))invalid('Invalid document read selection or byte budget.');
  return input;
}

async function readDocument(port,inputs,signal) {
  notCancelled(signal);
  const context=await port.load(inputs,{signal});
  notCancelled(signal);
  if(context?.subject?.kind!=='story'||typeof context.workflow?.workItem?.id!=='string'
    ||!context.workflow.workItem.id||context.subject.id!==context.workflow.workItem.id) {
    throw new SingularityFlowError('The document read port did not bind a Story.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const selection=data(documentReadSelection(context.workflow,inputs));
  const copy=value=>{
    try{return data(value);}catch(cause){throw new SingularityFlowError('The document read port returned non-JSON facts.',{
      code:'ENGINE_PORT_RESULT_INVALID',cause});}
  };
  const resolved=await port.resolve(context,selection,{signal});
  notCancelled(signal);
  const binding=data(documentReadBinding(selection,copy(resolved)));
  const observed=await port.read(context,binding,{signal});
  notCancelled(signal);
  const facts=copy(observed),document=documentReadResult(binding,facts);
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'document.read',status:'read',
    subject:{kind:'story',id:selection.workId},revision:facts.revision,
    effects:{committed:false,pushed:false,humanReviewRecorded:false,approvalRecorded:false},document});
}

function phaseReviewInput(value,operation) {
  const input=data(value);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!operation.inputFields.includes(key)))invalid('Unknown phase review input field.');
  for(const value of Object.values(input))if(value!=null&&typeof value!=='string')invalid('Phase review identifiers must be strings or null.');
  return input;
}

async function inspectPhaseReview(port,inputs,signal) {
  notCancelled(signal);
  const context=await port.load(inputs,{signal});
  notCancelled(signal);
  if(context?.subject?.kind!=='story'||typeof context.workflow?.workItem?.id!=='string'
    ||!context.workflow.workItem.id||context.subject.id!==context.workflow.workItem.id)throw new SingularityFlowError(
    'The phase review port did not bind a Story.',{code:'ENGINE_PORT_RESULT_INVALID'});
  if(inputs.workId!=null&&inputs.workId!==context.subject.id)throw new SingularityFlowError(
    'Requested Story does not match the review checkout.',{code:'ACTIVE_SUBJECT_MISMATCH',
      details:{expectedWorkId:inputs.workId,actualWorkId:context.subject.id}});
  const binding=data(phaseReviewSelection(context.workflow,inputs.phaseId));
  if(!Number.isSafeInteger(binding.generation)||binding.generation<0||typeof binding.phase!=='string'
    ||!binding.phase||typeof binding.status!=='string'||!binding.status)throw new SingularityFlowError(
    'The phase review port did not bind a phase.',{code:'ENGINE_PORT_RESULT_INVALID'});
  const observed=await port.read(context,binding,{signal});
  notCancelled(signal);
  let facts;
  try{facts=data(observed);}catch(cause){throw new SingularityFlowError('The phase review port returned non-JSON facts.',{code:'ENGINE_PORT_RESULT_INVALID',cause});}
  const manifest=phaseReviewManifest(binding,facts);
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.review',status:'inspected',
    subject:{kind:'story',id:binding.workId},phase:binding.phase,generation:binding.generation,
    revision:facts.revision,effects:{committed:false,pushed:false,humanReviewRecorded:false,approvalRecorded:false},manifest});
}

/** Copy JSON data without executing accessors/toJSON or retaining caller-owned mutable values. */
function data(value, state = { nodes: 0, bytes: 0, parents: new Set() }, depth = 0) {
  if (++state.nodes > 100_000 || depth > 32) invalid('Engine input exceeds its structural limit.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))) {
    state.bytes += typeof value === 'string' ? value.length : 16;
    if (state.bytes > 4_194_304) invalid('Engine input exceeds its size limit.');
    return value;
  }
  if (!value || typeof value !== 'object' || state.parents.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    invalid('Engine input must be finite, acyclic plain JSON data.');
  }
  state.parents.add(value);
  const result = Array.isArray(value) ? [] : {};
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && (keys.length !== value.length + 1
    || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
    invalid('Engine input arrays must not be sparse or extended.');
  }
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')) {
      invalid('Engine input must not contain accessors or hidden properties.');
    }
    state.bytes += key.length;
    if (state.bytes > 4_194_304) invalid('Engine input exceeds its size limit.');
    const copied = data(property.value, state, depth + 1);
    Object.defineProperty(result, key, { value: copied, enumerable: true });
  }
  state.parents.delete(value);
  return Object.freeze(result);
}

function publicationInput(value) {
  const input = data(value);
  if (!input || Array.isArray(input) || typeof input !== 'object'
    || Object.keys(input).some(key => !PUBLISH_FIELDS.includes(key))) invalid('Unknown publication input field.');
  for (const key of PUBLISH_FIELDS.filter(key => !['usage', 'changeOrigins'].includes(key))) {
    if (input[key] != null && typeof input[key] !== 'string') invalid(`Publication ${key} must be a string or null.`);
  }
  if (input.usage != null && (typeof input.usage !== 'object')) invalid('Publication usage must be JSON records.');
  if (input.usage != null && input.usageFile != null) invalid('Choose publication usage data or a usage file.');
  if (input.changeOrigins != null && (!Array.isArray(input.changeOrigins)
    || input.changeOrigins.some(value => typeof value !== 'string'))) invalid('Change origins must be an array of strings.');
  return input;
}

function submissionInput(value, operation) {
  const input = data(value);
  if (!input || Array.isArray(input) || typeof input !== 'object'
    || Object.keys(input).some(key => !operation.inputFields.includes(key))) invalid('Unknown submission input field.');
  for (const key of ['workId', 'phaseId', 'confirmation']) {
    if (input[key] != null && typeof input[key] !== 'string') invalid(`Submission ${key} must be a string or null.`);
  }
  if (input.runChecks != null && typeof input.runChecks !== 'boolean') invalid('Submission runChecks must be a boolean.');
  if (input.decisionValues != null && (typeof input.decisionValues !== 'object' || Array.isArray(input.decisionValues)
    || Object.values(input.decisionValues).some(value => value !== null && !['string','number','boolean'].includes(typeof value)))) {
    invalid('Submission decisionValues must map names to scalar values.');
  }
  return input;
}

function approvalInput(value) {
  const input=data(value);
  if(!input || Array.isArray(input) || typeof input!=='object'
    || Object.keys(input).some(key=>!APPROVAL_FIELDS.includes(key)))invalid('Unknown approval input field.');
  for(const key of ['workId','phaseId','selectionReceipt','agent','evidenceReason']) {
    if(input[key]!=null && typeof input[key]!=='string')invalid(`Approval ${key} must be a string or null.`);
  }
  for(const key of ['fetch','confirmEvidence'])if(input[key]!=null && typeof input[key]!=='boolean')invalid(`Approval ${key} must be a boolean.`);
  for(const key of ['checklist','witnessMappings','bindingDecisions'])if(input[key]!=null && !Array.isArray(input[key]))invalid(`Approval ${key} must be an array.`);
  for(const key of ['confirmation','decisions'])if(input[key]!=null && (typeof input[key]!=='object' || Array.isArray(input[key])))invalid(`Approval ${key} must be a record.`);
  if(input.confirmation!=null) {
    const binding=input.confirmation;
    if(Object.keys(binding).some(key=>!['workId','phase','generation','reviewPacketSha256'].includes(key))
      || !['workId','phase','reviewPacketSha256'].every(key=>typeof binding[key]==='string' && binding[key].length>0)
      || !Number.isSafeInteger(binding.generation) || binding.generation<1)invalid('Approval confirmation must name the exact submitted review.');
  }
  if(input.decisions!=null && (Object.keys(input.decisions).some(key=>!['answers','digest'].includes(key))
      || input.decisions.digest!=null && typeof input.decisions.digest!=='string'))invalid('Approval decisions require answers and a list digest.');
  return input;
}

function decisionInput(value) {
  const input = data(value);
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !DECISION_FIELDS.includes(key))) invalid('Unknown decision input field.');
  for (const key of ['workId','phaseId','confirmation']) {
    if (input[key] != null && typeof input[key] !== 'string') invalid(`Decision ${key} must be a string or null.`);
  }
  if (input.fetch != null && typeof input.fetch !== 'boolean') invalid('Decision fetch must be a boolean.');
  if (input.answers != null && (typeof input.answers !== 'object' || Array.isArray(input.answers)
      || Object.keys(input.answers).some(key => !['choose','reason','expires','cause','clause','article'].includes(key)))) {
    invalid('Decision answers must contain only choices and their declared values.');
  }
  return input;
}

function singleDecisionInput(value, operation, {requestOnly=false,intent=false}={}) {
  const input=data(value), fields=intent ? operation.intentFields : requestOnly ? operation.requestFields : operation.inputFields;
  if (!input || typeof input!=='object' || Array.isArray(input)
    || Object.keys(input).some(key=>!fields.includes(key))) invalid('Unknown standalone decision input field.');
  for (const [key,value] of Object.entries(input)) {
    if (value==null) continue;
    if (['fetch','notApplicable','open','fromArtifact'].includes(key)) {if(typeof value!=='boolean')invalid(`Decision ${key} must be a boolean.`);}
    else if (['clauseIds','transitions','sourceRoots'].includes(key)) {
      if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))invalid(`Decision ${key} must be an array of strings.`);
    } else if (key==='checklist') {
      if(!Array.isArray(value))invalid('Decision checklist must be an array.');
    } else if (['changes','operations'].includes(key)) {
      if(!Array.isArray(value)||value.some(item=>!item||typeof item!=='object'||Array.isArray(item)))invalid(`Decision ${key} must be an array of JSON records.`);
    } else if (['command','repin','answers'].includes(key)) {
      if(typeof value!=='object'||Array.isArray(value))invalid(`Decision ${key} must be a JSON record.`);
    } else if(typeof value!=='string')invalid(`Decision ${key} must be a string or null.`);
  }
  return input;
}

function notCancelled(signal) {
  if (signal?.aborted) throw new SingularityFlowError('The engine operation was cancelled before its next effect.', {
    code: 'ENGINE_OPERATION_CANCELLED'
  });
}

/** SDK-owned result contract; concrete stores return facts, never host presentation or SDK envelopes. */
function publicationResult(context, facts, status) {
  const allowed = ['workId', 'phase', 'generation', 'revision', 'pushed', 'artifact', 'retentionReason'];
  if (!facts || Object.keys(facts).some(key => !allowed.includes(key))
    || typeof facts.workId !== 'string' || facts.workId !== context.subject?.id
    || facts.phase !== context.phase?.id || !Number.isSafeInteger(facts.generation) || facts.generation < 1
    || typeof facts.revision !== 'string' || !facts.revision || facts.revision.length > 512
    || typeof facts.artifact !== 'string' || !facts.artifact || typeof facts.pushed !== 'boolean'
    || (status === 'retained' && (facts.pushed || !['consumed-intent','unchanged-document'].includes(facts.retentionReason)))) {
    throw new SingularityFlowError('The publication port returned an invalid or differently bound result.', {
      code: 'ENGINE_PORT_RESULT_INVALID'
    });
  }
  return Object.freeze({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.publish',status,
    subject:Object.freeze({kind:'story',id:facts.workId}),phase:facts.phase,generation:facts.generation,
    revision:facts.revision,effects:Object.freeze({committed:status==='published',pushed:facts.pushed}),
    artifact:facts.artifact,...(status==='retained'?{retentionReason:facts.retentionReason}:{})});
}

async function publish(port, inputs, signal) {
  notCancelled(signal);
  const context = await port.load(inputs, { signal });
  notCancelled(signal);
  const retained = await port.retained(context, inputs, { signal });
  if (retained) return publicationResult(context, retained, 'retained');
  const intent = publicationAuthorshipIntent(context.phase, inputs, { modelEnabled: context.modelEnabled });
  if (intent.legacyWarning) await port.notice?.({ code: 'publication.legacy-authorship' });
  assertPublicationAuthorshipIntent(context.phase, inputs, intent);
  notCancelled(signal);
  const prepared = await port.prepare(context, inputs, intent, { signal });
  notCancelled(signal);
  const committed = await port.commit(context, prepared, { signal });
  // Once the authority may have accepted the effect, cancellation cannot report it as undone.
  // Native unknown/conflict/pending errors pass through unchanged from commit.
  try {
    return publicationResult(context, await port.finish(context, prepared, committed), 'published');
  } catch (error) {
    // Preserve the actual error, while retaining the accepted commit for an inspecting host.
    if (error && typeof error === 'object' && Object.isExtensible(error)) error.enginePublication = committed;
    throw error;
  }
}

function submissionResult(context, facts, operation, retained) {
  const fields = ['workId','phase','generation','revision','pushed','phaseStatus','submittedAt','approvalMode','currentPhase','reviewPacket'];
  if (!facts || Object.keys(facts).some(key => !fields.includes(key))
    || typeof facts.workId !== 'string' || !facts.workId || facts.workId !== context.subject?.id
    || typeof facts.phase !== 'string' || !facts.phase || facts.phase !== context.phase?.id
    || !Number.isSafeInteger(facts.generation) || facts.generation < 1
    || !(retained && facts.revision === null || typeof facts.revision === 'string' && facts.revision.length > 0 && facts.revision.length <= 512)
    || typeof facts.pushed !== 'boolean' || retained && facts.pushed
    || !['approved','awaiting_approval'].includes(facts.phaseStatus)
    || retained && facts.phaseStatus !== 'awaiting_approval'
    || !['required','none','policy'].includes(facts.approvalMode)
    || facts.phaseStatus === 'approved' && facts.approvalMode === 'required'
    || facts.submittedAt !== null && typeof facts.submittedAt !== 'string'
    || facts.currentPhase !== null && typeof facts.currentPhase !== 'string'
    || facts.reviewPacket !== null && (typeof facts.reviewPacket !== 'string' || !facts.reviewPacket || facts.reviewPacket.length > 512)) {
    throw new SingularityFlowError('The submission port returned an invalid or differently bound result.', { code: 'ENGINE_PORT_RESULT_INVALID' });
  }
  return Object.freeze({schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,
    status:retained?'retained':facts.phaseStatus==='approved'?'completed':'awaiting-approval',
    subject:Object.freeze({kind:'story',id:facts.workId}),phase:facts.phase,generation:facts.generation,
    revision:facts.revision,effects:Object.freeze({committed:!retained,pushed:facts.pushed}),
    submission:Object.freeze({phaseStatus:facts.phaseStatus,submittedAt:facts.submittedAt,
      approvalMode:facts.approvalMode,currentPhase:facts.currentPhase,reviewPacket:facts.reviewPacket})});
}

async function submit(port, inputs, signal, operation) {
  notCancelled(signal);
  const context = await port.load(inputs, { signal });
  notCancelled(signal);
  const intent = submissionDecisionIntent(context.workflow, context.phase, inputs.decisionValues ?? {});
  if (intent.ignoredDecisionValues) await port.notice?.({code:'submission.decision-values-ignored',phase:context.phase.id});
  const retained = await port.retained(context, inputs, { signal });
  if (retained) return submissionResult(context, retained, operation, true);
  const confirmedConvergence = operation.id === 'convergence.submit';
  assertSubmissionIntent(context.workflow, context.phase, {confirmedConvergence,confirmation:inputs.confirmation});
  notCancelled(signal);
  const prepared = await port.prepare(context, inputs, {confirmedConvergence}, {signal});
  notCancelled(signal);
  const committed = await port.commit(context, prepared, {signal});
  try {
    return submissionResult(context, await port.finish(context, prepared, committed), operation, false);
  } catch (error) {
    if (error && typeof error === 'object' && Object.isExtensible(error)) error.enginePublication = committed;
    throw error;
  }
}

function approvalResult(context,facts,binding) {
  const fields=['workId','phase','generation','revision','pushed','reviewPacket','artifactSet','actorId',
    'authorityGroup','selfApproval','thresholdReached','currentPhase'];
  const text=value=>typeof value==='string' && value.length>0 && value.length<=512;
  if(!facts || Object.keys(facts).some(key=>!fields.includes(key))
    || !text(facts.workId) || facts.workId!==context.subject?.id || facts.workId!==binding.workId
    || facts.phase!==binding.phase || facts.generation!==binding.generation
    || !text(facts.revision) || typeof facts.pushed!=='boolean'
    || facts.reviewPacket!==binding.reviewPacketSha256 || !text(facts.artifactSet)
    || !text(facts.actorId) || !text(facts.authorityGroup)
    || typeof facts.selfApproval!=='boolean' || typeof facts.thresholdReached!=='boolean'
    || facts.currentPhase!==null && !text(facts.currentPhase)) {
    throw new SingularityFlowError('The approval port returned an invalid or differently bound decision.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  return Object.freeze({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.approve',status:'recorded',
    subject:Object.freeze({kind:'story',id:facts.workId}),phase:facts.phase,generation:facts.generation,
    revision:facts.revision,effects:Object.freeze({committed:true,pushed:facts.pushed}),
    approval:Object.freeze({actorId:facts.actorId,authorityGroup:facts.authorityGroup,selfApproval:facts.selfApproval,
      thresholdReached:facts.thresholdReached,reviewPacket:facts.reviewPacket,artifactSet:facts.artifactSet}),currentPhase:facts.currentPhase});
}

async function approve(port,inputs,signal) {
  notCancelled(signal);
  const context=await port.load(inputs,{signal});
  const binding=data(context.reviewBinding ?? null);
  notCancelled(signal);
  const prepared=await port.prepare(context,inputs,{signal});
  assertApprovalReviewConfirmation(binding,prepared?.confirmation);
  notCancelled(signal);
  const committed=await port.commit(context,prepared,{signal});
  try {
    return approvalResult(context,await port.finish(context,prepared,committed),binding);
  } catch(error) {
    if(error && typeof error==='object' && Object.isExtensible(error))error.enginePublication=committed;
    throw error;
  }
}

function decisionResult(binding, facts, accepted, refused) {
  const fields = ['workId','phase','recorded','refused','remaining','packetSha256'];
  const record = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
  const text = value => typeof value === 'string' && value.length > 0;
  let result;
  try { result = data(facts); }
  catch (cause) { throw new SingularityFlowError('The decision port returned non-JSON records.', {code:'ENGINE_PORT_RESULT_INVALID',cause}); }
  if (!result || Object.keys(result).some(key => !fields.includes(key))
      || result.workId !== binding.workId || result.phase !== binding.phase
      || !Array.isArray(result.recorded) || result.recorded.length !== accepted.length
      || result.recorded.some((entry,index) => !record(entry, ['item','kind','record','value'])
        || entry.item !== accepted[index].item || entry.kind !== accepted[index].kind
        || entry.record !== null && !text(entry.record)
        || entry.value === null || typeof entry.value !== 'object' || Array.isArray(entry.value))
      || !Array.isArray(result.refused) || result.refused.length !== refused.length
      || result.refused.some((entry,index) => !record(entry, ['item','title','option','groups'])
        || ['item','title','option'].some(key => entry[key] !== refused[index][key])
        || !Array.isArray(entry.groups) || entry.groups.length !== refused[index].groups.length
        || entry.groups.some((group,at) => group !== refused[index].groups[at]))
      || result.remaining !== null && (!Array.isArray(result.remaining) || result.remaining.some(entry =>
        !record(entry, ['id','kind','title']) || !['id','kind','title'].every(key => text(entry[key]))))
      || result.packetSha256 !== null && !/^sha256:[a-f0-9]{64}$/u.test(result.packetSha256)
      || (result.remaining === null) !== (result.packetSha256 === null)) {
    throw new SingularityFlowError('The decision port returned an invalid or differently bound outcome.', {code:'ENGINE_PORT_RESULT_INVALID'});
  }
  return Object.freeze({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'decisions.record',status:'recorded',
    subject:Object.freeze({kind:'story',id:binding.workId}),phase:binding.phase,
    effects:Object.freeze({recordedEntries:result.recorded.length}),recorded:result.recorded,refused:result.refused,
    remaining:result.remaining,packetSha256:result.packetSha256});
}

async function recordDecisions(port, inputs, signal) {
  notCancelled(signal);
  const context = await port.load(inputs, {signal});
  const packet = data(context.policy);
  const at = context.at;
  if (!packet || typeof packet.workId !== 'string' || packet.workId !== context.subject?.id
      || !/^sha256:[a-f0-9]{64}$/u.test(packet.packetSha256)
      || packet.phase !== null && typeof packet.phase !== 'string') {
    throw new SingularityFlowError('The decision port loaded an invalid list binding.', {code:'ENGINE_PORT_RESULT_INVALID'});
  }
  notCancelled(signal);
  const prepared = await port.prepare(context, inputs, {signal});
  if (prepared?.cancelled === true) return Object.freeze({schemaVersion:1,contract:ENGINE_CONTRACT,
    operation:'decisions.record',status:'not-recorded',subject:Object.freeze({kind:'story',id:packet.workId}),
    phase:packet.phase,effects:Object.freeze({recordedEntries:0})});
  if (!(prepared?.answers?.choose instanceof Map) || !prepared.answers.choose.size) {
    throw new SingularityFlowError('Choose at least one item from the current decision list.', {code:'DECISIONS_CHOICE_REQUIRED'});
  }
  assertDecisionConfirmation(packet.packetSha256, prepared.confirmation);
  const plan = data(decisionRecordPlan(packet, prepared.answers, {at}));
  if (!plan.steps.length) throw new SingularityFlowError('The chosen decisions are not authorized for this identity.', {
    code:'DECISIONS_NOT_YOURS',details:{refused:plan.refused}
  });
  notCancelled(signal);
  // Once the first native effect starts, preserve accepted/unknown outcomes instead of claiming
  // that a later cancellation unwound the plan. The coordinator reports its exact stopped suffix.
  const outcome = await runDecisionPlan(plan, (effect,step,produced) => port.apply(context,effect,step,produced));
  const accepted = outcome.recorded.map(({item,kind}) => ({item,kind}));
  try {
    const facts = await port.finish(context,plan,outcome);
    // Presentation or after-state inspection cannot turn a failed/unknown native effect into
    // successful recording. Keep the confirmed prefix and the original failure for recovery.
    if (outcome.failed) throw outcome.failed.error;
    return decisionResult(packet, facts, accepted, plan.refused);
  }
  catch (error) {
    if (error && typeof error === 'object' && Object.isExtensible(error)) error.engineDecisionEffects = outcome;
    throw error;
  }
}

function singleDecisionResult(binding, facts, operation) {
  let result;
  try {result=data(facts);}
  catch(cause) {throw new SingularityFlowError('The decision writer returned non-JSON facts.',{code:'ENGINE_PORT_RESULT_INVALID',cause});}
  const fields=['workId','phase','recordKind','record','revision','pushed','actorId','authorityGroup','currentPhase',
    ...(operation.allowRetained?['retained']:[])];
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
  const retained=operation.allowRetained===true&&result?.retained===true;
  if(!result || Object.keys(result).some(key=>!fields.includes(key))
    || result.workId!==binding.workId || result.phase!==binding.phase || result.recordKind!==operation.recordKind
    || !result.record || typeof result.record!=='object' || Array.isArray(result.record)
    || ['resolved-target','requested-target'].includes(operation.phaseBinding)&&result.record.phase!==binding.phase
    || (retained?result.revision!==null:!text(result.revision)) || typeof result.pushed!=='boolean'
    || retained&&result.pushed || operation.allowRetained&&typeof result.retained!=='boolean'
    || !text(result.actorId) || (operation.authority==='requester' ? result.authorityGroup!==null : !text(result.authorityGroup))
    || result.currentPhase!==null && !text(result.currentPhase)
    || operation.phaseBinding==='resolved-target'&&result.currentPhase!==binding.currentPhase
    || operation.keepsCurrentPhase&&result.currentPhase!==(Object.hasOwn(binding,'currentPhase')?binding.currentPhase:binding.phase)) {
    throw new SingularityFlowError('The decision writer returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  return Object.freeze({schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,status:retained?'retained':'recorded',
    subject:Object.freeze({kind:'story',id:binding.workId}),phase:binding.phase,revision:result.revision,
    effects:Object.freeze({committed:!retained,pushed:result.pushed}),recordKind:result.recordKind,record:result.record,
    actorId:result.actorId,authorityGroup:result.authorityGroup,currentPhase:result.currentPhase});
}

async function recordSingleDecision(port, inputs, signal, operation) {
  const descriptor=ENGINE_OPERATIONS.find(entry=>entry.id===operation.id);
  notCancelled(signal);
  const context=await port.load(inputs,{signal,operation:descriptor});
  notCancelled(signal);
  if(context?.subject?.kind!=='story' || typeof context?.workflow?.workItem?.id!=='string' || !context.workflow.workItem.id
    || context.workflow.workItem.id!==context.subject?.id)throw new SingularityFlowError(
      'The decision writer did not bind a Story.',{code:'ENGINE_PORT_RESULT_INVALID'});
  const binding=data(standaloneDecisionAdmission(operation.id,context.workflow));
  if(inputs.workId!=null&&inputs.workId!==binding.workId || binding.phase!==null&&typeof binding.phase!=='string') {
    throw new SingularityFlowError('The decision writer did not bind the requested Story phase.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const supplied=Object.freeze(Object.fromEntries(operation.requestFields
    .filter(key=>Object.hasOwn(inputs,key)).map(key=>[key,inputs[key]])));
  const prepared=await port.prepare(context,supplied,{signal,operation:descriptor});
  const request=data(standaloneDecisionRequest(operation.id,singleDecisionInput(prepared,operation,{requestOnly:true})));
  notCancelled(signal);
  let intent=request;
  let resultBinding=binding;
  if(operation.phaseBinding==='requested-target')resultBinding=data({...binding,phase:request.phaseId,currentPhase:binding.phase});
  if(port.resolve) {
    const resolved=await port.resolve(context,request,{signal,operation:descriptor});
    try {intent=singleDecisionInput(resolved,operation,{intent:true});}
    catch(cause) {throw new SingularityFlowError('The decision resolver returned an invalid intent.',{code:'ENGINE_PORT_RESULT_INVALID',cause});}
    if(operation.phaseBinding==='resolved-target') {
      if(typeof intent.phaseId!=='string'||!intent.phaseId||!context.workflow.phases?.[intent.phaseId]
        || request.phaseId!=null&&intent.phaseId!==request.phaseId)throw new SingularityFlowError(
        'The decision resolver did not bind the requested target phase.',{code:'ENGINE_PORT_RESULT_INVALID'});
      resultBinding=data({...binding,phase:intent.phaseId,currentPhase:binding.phase});
    }
    notCancelled(signal);
  }
  const committed=await port.commit(context,intent,{signal,operation:descriptor});
  try {
    return singleDecisionResult(resultBinding,await port.finish(context,intent,committed,{operation:descriptor}),operation);
  } catch(error) {
    if(error&&typeof error==='object'&&Object.isExtensible(error))error.enginePublication=committed;
    throw error;
  }
}

/** Ordered native issues keep their own transactions; a later failure never erases accepted work. */
async function upstreamOperation(port,inputs,signal,operation) {
  const descriptor=ENGINE_OPERATIONS.find(entry=>entry.id===operation.id),id=operation.id;
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
  const bad=()=>{throw new SingularityFlowError('The upstream port returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});};
  const facts=value=>{try{return data(value);}catch(cause){throw new SingularityFlowError(
    'The upstream port returned non-JSON facts.',{code:'ENGINE_PORT_RESULT_INVALID',cause});}};
  notCancelled(signal);
  const context=await port.load(inputs,{signal,operation:descriptor});
  notCancelled(signal);
  if(context?.subject?.kind!=='story'||!text(context.workflow?.workItem?.id)
    ||context.subject.id!==context.workflow.workItem.id)bad();
  const binding=facts(upstreamOperationAdmission(id,context.workflow));
  if(inputs.workId!=null&&inputs.workId!==binding.workId||binding.phase!==null&&!text(binding.phase))bad();
  const request=data(upstreamOperationRequest(id,inputs));
  // Capture the owner before an awaited resolver can mutate its native context.
  const target=id==='upstream.decide'?binding.issues.find(entry=>entry.id===request.issueId)?.phase
    :id==='forward-amendment.decide'?binding.amendments.find(entry=>entry.id===request.amendmentId)?.phase:request.phaseId;
  const amendment=binding.amendments.find(entry=>entry.id===request.amendmentId);
  const plan=facts(await port.resolve(context,request,{signal,operation:descriptor}));
  notCancelled(signal);
  const base={schemaVersion:1,contract:ENGINE_CONTRACT,operation:id,subject:{kind:'story',id:binding.workId},phase:binding.phase};
  if(id==='upstream.list') {
    if(!plan||Object.keys(plan).some(key=>key!=='issues')||!Array.isArray(plan.issues)
      ||new Set(plan.issues.map(issue=>issue.id)).size!==plan.issues.length
      ||!request.open&&plan.issues.length!==binding.issues.length
      ||plan.issues.some(issue=>!binding.issues.some(entry=>entry.id===issue.id&&entry.phase===issue.phase)
        ||!['open','expired','decided','superseded'].includes(issue.status)
        ||request.open&&!['open','expired'].includes(issue.status)))bad();
    return data({...base,status:'observed',currentPhase:binding.phase,revision:null,
      effects:{committed:false,pushed:false},issues:plan.issues});
  }
  if(!plan||Object.keys(plan).some(key=>!['requests','actorId','authored','agent','unowned'].includes(key))
    ||!Array.isArray(plan.requests)||!text(plan.actorId)||!Array.isArray(plan.unowned)
    ||plan.agent!==null&&!text(plan.agent)
    ||id==='upstream.raise'&&!['human','governed-agent'].includes(plan.authored)
    ||id!=='upstream.raise'&&(plan.authored!==null||plan.unowned.length||plan.requests.length!==1||!equalJson(plan.requests[0],request)))bad();
  if(id==='upstream.raise') {
    if(request.authored&&request.authored!==plan.authored)bad();
    const manual={phase:request.phaseId,about:request.about,problem:request.problem,assumption:request.assumption,
      impact:request.impact,proposed:request.proposed??'unknown',source:null,supersedes:request.supersedes};
    if(!request.fromArtifact&&(plan.requests.length!==1||!equalJson(plan.requests[0],manual)||plan.unowned.length))bad();
    for(const item of plan.requests)if(!item||Object.keys(item).some(key=>!Object.keys(manual).includes(key))
      ||!binding.phases[item.phase]||!text(item.about)||typeof item.problem!=='string'||!item.problem
      ||request.proposed&&item.proposed!==request.proposed)bad();
  }
  const accepted=[];
  let pending=null,index=0;
  try {
    for(const item of plan.requests) {
      notCancelled(signal);
      pending=await port.commit(context,item,{operation:descriptor,index,signal});
      const written=facts(pending);
      if(!written||Object.keys(written).some(key=>!['revision','pushed','record'].includes(key))
        ||!text(written.revision)||typeof written.pushed!=='boolean'||!written.record||typeof written.record!=='object'||Array.isArray(written.record))bad();
      const record=written.record,owner=id==='upstream.raise'?item.phase:target;
      if(!owner||!binding.phases[owner])bad();
      const decision=id==='forward-amendment.decide'?record.decision:record;
      if(id==='upstream.raise') {
        if(record.phase!==owner||record.raisedIn?.phase!==binding.phase||record.raisedBy!==plan.actorId
          ||record.authored!==plan.authored||record.agent!==plan.agent
          ||record.producerGeneration!==binding.phases[owner].generation
          ||record.about!==String(item.about??'').trim()||record.problem!==String(item.problem??'').trim()
          ||record.proposed!==item.proposed
          ||record.assumption!==(String(item.assumption??'').trim()||null)||record.impact!==(String(item.impact??'').trim()||null)
          ||!equalJson(record.source,item.source??null)||(record.supersedes??null)!==(item.supersedes??null))bad();
      } else if(id==='forward-amendment.propose') {
        if(record.phase!==owner||record.proposedBy!==plan.actorId||record.fromGeneration!==binding.phases[owner].generation
          ||record.reason!==String(request.reason??'').trim()||record.upstreamIssue!==request.upstreamIssue)bad();
      } else {
        if(!decision||decision.actor!==plan.actorId||!binding.phases[owner].groups.includes(decision.authorityGroup)
          ||decision.reason!==String(request.reason??'').trim())bad();
        if(id==='upstream.decide'&&(decision.issue!==request.issueId||decision.outcome!==request.outcome
          ||(request.outcome==='return'?(decision.changeRequest?.targetPhase!==owner||decision.link!==decision.changeRequest?.id):decision.link!==request.link)))bad();
        if(id==='forward-amendment.decide'&&(decision.amendment!==request.amendmentId||decision.phase!==owner
          ||decision.decision!==(request.decision==='approve'?'approved':'rejected')||record.applied!==(request.decision==='approve')
          ||record.proposal?.id!==request.amendmentId||record.proposal?.phase!==owner
          ||record.applied&&(record.approval?.phase!==owner||record.approval?.generation!==amendment.fromGeneration+1
            ||record.approval?.authorityGroup!==decision.authorityGroup)))bad();
        if(id==='forward-amendment.revalidate'&&(decision.amendment!==request.amendmentId||decision.phase!==owner
          ||decision.outcome!==request.outcome||decision.generation!==binding.phases[owner].generation))bad();
      }
      accepted.push(written);pending=null;index++;
    }
    // An accepted effect must be reported even if a cancellation arrived while it was publishing.
    const final=facts(await port.finish(context,request,{operation:descriptor}));
    const currentPhase=['upstream.decide','forward-amendment.revalidate'].includes(id)&&request.outcome==='return'?target:binding.phase;
    const amendmentResult=id==='forward-amendment.decide'?accepted[0]?.record:null;
    const owed=amendmentResult?.applied?(amendmentResult.decision.revalidate??[]).map(entry=>entry.phase):[];
    const refreshed=amendmentResult?.applied?amendmentResult.refreshed??null:null;
    if(!final||Object.keys(final).some(key=>!['workId','currentPhase','revalidate','refreshed'].includes(key))
      ||final.workId!==binding.workId||final.currentPhase!==currentPhase||!Array.isArray(final.revalidate)
      ||final.revalidate.some(phase=>!binding.phases[phase])||final.refreshed!==null&&!binding.phases[final.refreshed]
      ||!equalJson(final.revalidate,owed)||final.refreshed!==refreshed)bad();
    return data({...base,status:accepted.length?'recorded':'unchanged',currentPhase:final.currentPhase,
      revision:accepted.at(-1)?.revision??null,effects:{committed:accepted.length>0,pushed:accepted.some(entry=>entry.pushed)},
      publications:accepted.map(({revision,pushed})=>({revision,pushed})),records:accepted.map(({record})=>record),
      actorId:plan.actorId,unowned:plan.unowned,revalidate:final.revalidate,refreshed:final.refreshed});
  } catch(error) {
    if(error&&typeof error==='object'&&Object.isExtensible(error))error.engineUpstreamEffects={
      operation:id,workId:binding.workId,accepted,pending,remaining:plan.requests.slice(index)};
    throw error;
  }
}

function equalJson(left,right) {
  if(left===right)return true;
  if(!left||!right||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)!==Array.isArray(right))return false;
  const keys=Object.keys(left);
  return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&equalJson(left[key],right[key]));
}

function correctionData(value) {
  try{return data(value);}
  catch(cause){throw new SingularityFlowError('The correction port returned non-JSON facts.',{code:'ENGINE_PORT_RESULT_INVALID',cause});}
}

/** A preview is data. Only a trusted host can present a human ceremony; only the writer consumes it. */
async function correctPlan(port,inputs,signal,operation) {
  const descriptor=ENGINE_OPERATIONS.find(entry=>entry.id===operation.id);
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
  const bad=message=>{throw new SingularityFlowError(message,{code:'ENGINE_PORT_RESULT_INVALID'});};
  notCancelled(signal);
  const context=await port.load(inputs,{signal,operation:descriptor});
  notCancelled(signal);
  if(context?.subject?.kind!=='story'||!text(context.workflow?.workItem?.id)
    ||context.subject.id!==context.workflow.workItem.id)bad('The correction writer did not bind a Story.');
  const binding=data(standaloneDecisionAdmission(operation.id,context.workflow));
  if(inputs.workId!=null&&inputs.workId!==binding.workId||binding.phase!==null&&!text(binding.phase))bad('The correction writer bound a different Story.');
  const supplied=Object.fromEntries(operation.requestFields.filter(key=>Object.hasOwn(inputs,key)).map(key=>[key,inputs[key]]));
  const prepared=await port.prepare(context,data(supplied),{signal,operation:descriptor});
  const request=data(standaloneDecisionRequest(operation.id,singleDecisionInput(prepared,operation,{requestOnly:true})));
  const owner=planCorrectionOwner(context.workflow,request.ownerPhase);
  const ownerBinding=data({ownerPhase:owner.id,ownerGeneration:Number(owner.generation),ownerMapSha256:owner.claimMaps.planned.sha256});
  notCancelled(signal);
  const review=correctionData(await port.review(context,request,{signal,operation:descriptor}));
  const reviewFields=['workId','currentPhase','ownerPhase','ownerGeneration','ownerMapSha256','previewSha256','operations','authorityGroups','reason','upstreamIssue'];
  if(!review||Object.keys(review).some(key=>!reviewFields.includes(key))||review.workId!==binding.workId||review.currentPhase!==binding.phase
    ||review.ownerPhase!==ownerBinding.ownerPhase||review.ownerGeneration!==ownerBinding.ownerGeneration
    ||review.ownerMapSha256!==ownerBinding.ownerMapSha256||!text(review.ownerPhase)||!Number.isSafeInteger(review.ownerGeneration)||review.ownerGeneration<1
    ||!text(review.ownerMapSha256)||!(/^[a-f0-9]{64}$/u.test(review.previewSha256??''))
    ||!Array.isArray(review.operations)||!review.operations.length||review.operations.some(entry=>!entry||typeof entry!=='object'||Array.isArray(entry))
    ||!Array.isArray(review.authorityGroups)||!review.authorityGroups.length||review.authorityGroups.some(group=>!text(group))
    ||review.reason!==request.reason.trim()||review.upstreamIssue!==request.upstreamIssue)bad('The correction preview did not match its bound plan.');
  const base={schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,subject:Object.freeze({kind:'story',id:binding.workId}),
    phase:binding.phase,currentPhase:binding.phase,review};
  notCancelled(signal);
  if(operation.id==='plan.correction.preview')return Object.freeze({...base,status:'ready-to-review',revision:null,
    effects:Object.freeze({committed:false,pushed:false})});
  const authorization=correctionData(await port.authorize(context,request,{signal,operation:descriptor}));
  const authFields=['workId','ownerPhase','ownerGeneration','previewSha256','confirmed','actorId','authorityGroup'];
  if(!authorization||Object.keys(authorization).some(key=>!authFields.includes(key))||authorization.workId!==binding.workId
    ||authorization.ownerPhase!==review.ownerPhase||authorization.ownerGeneration!==review.ownerGeneration
    ||authorization.previewSha256!==review.previewSha256||typeof authorization.confirmed!=='boolean'||!text(authorization.actorId)
    ||!review.authorityGroups.includes(authorization.authorityGroup))bad('The correction authorization did not match the reviewed plan.');
  notCancelled(signal);
  if(!authorization.confirmed)return Object.freeze({...base,status:'cancelled',revision:null,effects:Object.freeze({committed:false,pushed:false})});
  const committed=await port.commit(context,request,{signal,operation:descriptor});
  try {
    const facts=correctionData(await port.finish(context,request,committed,{operation:descriptor}));
    const fields=['workId','currentPhase','record','revision','pushed','actorId','authorityGroup'];
    if(!facts||Object.keys(facts).some(key=>!fields.includes(key))||facts.workId!==binding.workId||facts.currentPhase!==binding.phase
      ||!text(facts.revision)||typeof facts.pushed!=='boolean'||facts.actorId!==authorization.actorId||facts.authorityGroup!==authorization.authorityGroup
      ||!facts.record||facts.record.kind!=='plan-row-correction'||!text(facts.record.id)||facts.record.ownerPhase!==review.ownerPhase
      ||facts.record.ownerGeneration!==review.ownerGeneration||facts.record.ownerMapSha256!==review.ownerMapSha256
      ||facts.record.actor!==authorization.actorId||facts.record.authorityGroup!==authorization.authorityGroup
      ||facts.record.reviewAssurance!=='live-terminal-exact-plan-review'||!equalJson(facts.record.operations,review.operations)
      ||facts.record.reason!==review.reason||facts.record.upstreamIssue!==review.upstreamIssue)bad('The correction result did not match the authorized plan.');
    return Object.freeze({...base,status:'recorded',revision:facts.revision,effects:Object.freeze({committed:true,pushed:facts.pushed}),
      recordKind:'plan-row-correction',record:facts.record,actorId:facts.actorId,authorityGroup:facts.authorityGroup});
  } catch(error) {
    if(error&&typeof error==='object'&&Object.isExtensible(error))error.enginePublication=committed;
    throw error;
  }
}

function advancementReview(context) {
  let review;
  try { review=data(context?.review); }
  catch(cause) { throw new SingularityFlowError('The advancement port returned non-JSON review facts.',{
    code:'ENGINE_PORT_RESULT_INVALID',cause
  }); }
  const fields=['workId','phase','generation','iteration','findings','reconciliation','confirmationDigest'];
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
  if(!review || Object.keys(review).some(key=>!fields.includes(key))
    || !text(review.workId) || review.workId!==context.subject?.id
    || !text(review.phase) || review.phase!==context.phase?.id
    || !Number.isSafeInteger(review.generation) || review.generation<0
    || review.generation!==(context.phase.generation ?? 0)
    || !Number.isSafeInteger(review.iteration) || review.iteration<1
    || !Number.isSafeInteger(review.findings) || review.findings<0
    || !text(review.reconciliation) || !/^sha256:[a-f0-9]{64}$/u.test(review.confirmationDigest)) {
    throw new SingularityFlowError('The advancement port returned an invalid or differently bound review.',{
      code:'ENGINE_PORT_RESULT_INVALID'
    });
  }
  return review;
}

/** Keep native review/locking in its port and exact consent/operation coordination in the SDK. */
async function advanceConvergence(port,inputs,signal,operation,{executeOperation}) {
  notCancelled(signal);
  let entered=false,open=true,review=null,submission=null,receipt=null;
  try {
    const result=await port.withReview(inputs,async context=>{
      if(!open || entered)throw new SingularityFlowError('The advancement review scope must be entered exactly once.',{
        code:'ENGINE_PORT_RESULT_INVALID'
      });
      entered=true;
      review=advancementReview(context);
      if(inputs.workId!=null && inputs.workId!==review.workId)throw new SingularityFlowError(
        'The advancement review does not match the requested Story.',{code:'ENGINE_PORT_RESULT_INVALID'});
      notCancelled(signal);
      const base={schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,
        subject:Object.freeze({kind:'story',id:review.workId}),phase:review.phase,
        generation:review.generation,iteration:review.iteration,findings:review.findings,
        reconciliation:review.reconciliation,confirmationDigest:review.confirmationDigest};
      if(!inputs.confirmation) {
        receipt=Object.freeze({...base,status:'ready-to-confirm',effects:Object.freeze({committed:false,pushed:false})});
        return receipt;
      }
      assertConvergenceAdvanceConfirmation(review.workId,inputs.confirmation,review.confirmationDigest);
      await port.notice?.({code:'advancement.confirmed',workId:review.workId,phase:review.phase,
        iteration:review.iteration,confirmationDigest:review.confirmationDigest});
      notCancelled(signal);
      submission=await executeOperation('convergence.submit',{workId:review.workId,phaseId:review.phase,
        confirmation:review.confirmationDigest,runChecks:inputs.runChecks!==false,
        decisionValues:inputs.decisionValues ?? {}},{signal});
      if(submission.subject.id!==review.workId || submission.phase!==review.phase
        || submission.generation!==review.generation
        || !['awaiting-approval','retained'].includes(submission.status)
        || submission.submission.approvalMode!=='required') {
        throw new SingularityFlowError('The submitted convergence no longer matches its reviewed binding.',{
          code:'ENGINE_PORT_RESULT_INVALID'
        });
      }
      receipt=Object.freeze({...base,status:submission.status,revision:submission.revision,
        effects:submission.effects,submission});
      return receipt;
    },{signal});
    open=false;
    if(!entered || !receipt || result!==receipt)throw new SingularityFlowError(
      'The advancement port did not return its scoped operation result.',{code:'ENGINE_PORT_RESULT_INVALID'});
    return receipt;
  } catch(error) {
    open=false;
    if(error&&typeof error==='object'&&Object.isExtensible(error)&&review) {
      error.engineAdvancement=Object.freeze({operation:operation.id,review,submission});
    }
    throw error;
  }
}

export function createEngine({ ports } = {}) {
  if (!ports || typeof ports !== 'object') invalid('Engine construction requires explicit trusted ports.');
  const bound = new Map();
  for (const name of new Set(ENGINE_OPERATIONS.map(operation => operation.port))) {
    const supplied = ports[name];
    if (supplied === undefined) continue;
    const stages=ENGINE_OPERATIONS.find(operation=>operation.port===name).stages;
    if (!supplied || stages.some(stage => typeof supplied[stage] !== 'function')) {
      invalid(`The ${name} port must implement every declared operation stage.`);
    }
    bound.set(name, Object.freeze(Object.fromEntries([
      ...stages.map(stage => [stage, supplied[stage].bind(supplied)]),
      ...(typeof supplied.notice === 'function' ? [['notice', supplied.notice.bind(supplied)]] : [])
    ])));
  }
  if (!bound.size) invalid('Engine construction requires at least one complete operation port.');
  const invoke = typeof ports.invocation?.run === 'function'
    ? ports.invocation.run.bind(ports.invocation) : callback => callback();
  const execute = async (operation, inputs = {}, { signal = null } = {}) => {
    if (typeof operation !== 'string' || !registry.has(operation)) throw new SingularityFlowError('The engine operation is unavailable in this contract.', {
      code: 'ENGINE_OPERATION_UNSUPPORTED', details: { operation: typeof operation === 'string' ? operation.slice(0, 128) : null, contract: ENGINE_CONTRACT }
    });
    const definition = registry.get(operation);
    const input = definition.validate(inputs, definition);
    const port = bound.get(definition.port);
    if (!port) throw new SingularityFlowError('No port implements this engine operation in the current host.', {
      code:'ENGINE_PORT_UNAVAILABLE',details:{operation,port:definition.port}
    });
    return invoke(() => definition.execute(port, input, signal, definition, {executeOperation:execute}));
  };
  return Object.freeze({ contract: ENGINE_CONTRACT, operations: ENGINE_OPERATIONS, run: execute,
    ...Object.fromEntries(Object.entries(ENGINE_HELPERS).map(([helper, operation]) =>
      [helper, { [helper]: (inputs, options) => execute(operation, inputs, options) }[helper]])) });
}
