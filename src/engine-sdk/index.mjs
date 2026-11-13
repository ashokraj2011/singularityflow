/**
 * Engine operation vocabulary v1. Only trusted ports perform I/O. Host flags, command strings,
 * model prose, repository discovery and provider selection never enter this dispatcher.
 */
import { SingularityFlowError } from '../foundation/failures.mjs';
import {phasePublicationBindingValue,namespaceSourceReviewRecordProfile,namespaceWitnessContextProfile,namespacePlanCorrectionRecordProfile,namespaceConstitutionExceptionContextProfile,namespaceStoryCommandRecordProfile,namespaceConvergenceContextProfile,namespaceTestRecoveryRecordProfile,namespaceEvidenceContextProfile,namespaceEvidenceReuseRecordProfile,namespaceTestRiskRecordProfile,namespaceObligationRiskRecordProfile,namespaceWitnessMappingProfile} from '../foundation/record-schema.mjs';
import { publicationAuthorshipIntent, assertPublicationAuthorshipIntent } from '../kernel/publication-intent.mjs';
import { submissionDecisionIntent, assertSubmissionIntent, assertConvergenceAdvanceConfirmation } from '../kernel/submission-intent.mjs';
import { assertApprovalReviewConfirmation, phaseRejectionSelection, phaseRejectionResult } from '../kernel/approval-policy.mjs';
import {decisionRecordPlan,assertDecisionConfirmation,standaloneDecisionAdmission,standaloneDecisionRequest,planCorrectionOwner,
  upstreamOperationAdmission,upstreamOperationRequest,decisionContextSelection,decisionContextManifest,decisionListManifest} from '../kernel/decision-plan.mjs';
import {runDecisionPlan} from './decision-execution.mjs';
import {phaseReviewSelection,phaseReviewManifest,phaseReviewResourcesManifest,phaseBeginSelection,phaseBeginResult,
  phaseRolloverSelection,phaseRolloverPlan,assertPhaseRolloverConfirmation,
  storyStatusSelection,storyStatusManifest,workflowGuidePlan,phaseInspectionGeneration,phaseExplicitlyReopened,nextPhaseGeneration} from '../kernel/phase-policy.mjs';
import {MAXIMUM_DOCUMENT_READ_BYTES,validDocumentReference,documentReadSelection,
  documentReadBinding,documentReadResult} from '../kernel/document-read.mjs';
import {phaseCompositionAdmission} from '../kernel/phase-admission.mjs';
import {phaseEntryProtocol,phaseContextReadInput,phaseContextReadResult} from '../kernel/phase-entry.mjs';
import {phasePrepublishSelection,phasePrepublishManifest,phaseDraftCheckSelection,phaseDraftCheckManifest} from '../kernel/phase-prepublish.mjs';
import {phasePreparationSelection,phasePreparationManifest} from '../kernel/phase-preparation.mjs';
import {workflowAssetSelection,workflowAssetManifest} from '../kernel/workflow-assets.mjs';
import {phaseInputsAuditRequired,phaseInputsManifest} from '../kernel/phase-inputs.mjs';
import {workflowNextManifest} from '../kernel/next-plan.mjs';
import {projectEnrollmentInput,projectEnrollmentBinding,projectEnrollmentResult,
  projectConfigurationInput,projectConfigurationBinding,projectConfigurationResult} from '../kernel/project-enrollment.mjs';
import {storyCreationInput,storyCreationBinding,storyCreationResult} from '../kernel/story-creation.mjs';
import {sourceBindingInput,sourceBindingScope,sourceBindingResult} from '../kernel/source-binding.mjs';
import {phaseDraftReadInput,phaseDraftMutationInput,phaseDraftReadManifest,phaseDraftMutationResult} from '../kernel/phase-preparation.mjs';
import {phaseChecksInput as checkedPhaseChecksInput,phaseChecksResult} from '../kernel/phase-checks.mjs';
import {phaseSourceInspectionInput,phaseDeliveryInspectionInput,phaseSourceInspectionManifest,phaseSourceRetentionInput,phaseSourceRetentionResult,phaseOutputRetentionInput,phaseOutputRetentionResult,phaseDeliveryInspectionManifest,DELIVERY_INSPECTION_PROFILE_V5} from '../kernel/source-changes.mjs';
import {sourceBaselineRetentionInput,sourceBaselineRetentionResult,phaseSourceControlRetentionResult} from '../kernel/source-changes.mjs';
import {testWitnessInspectionManifest} from '../kernel/verification-witnesses.mjs';
import {clarificationOperationInput} from '../kernel/clarification-responses.mjs';
import {storyDocumentRequest} from '../kernel/story-documents.mjs';
import {phaseArtifactInspectionManifest} from '../kernel/namespace-artifact-sets.mjs';

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
  'checklist','witnessMappings','witnessReviewContext','bindingDecisions','decisions','confirmEvidence','evidenceReason']);
const DECISION_FIELDS = Object.freeze(['workId','phaseId','fetch','answers','confirmation']);
const CORRECTION_FIELDS=Object.freeze(['ownerPhase','operations','reason','upstreamIssue']);
const SINGLE_DECISIONS = Object.freeze([
  ['test-recovery.confirm','test-recovery-agreement',['phaseId','expectedContext','reason'],
    {phaseBinding:'requested-target',keepsCurrentPhase:true,requiredFields:Object.freeze(['operationId','phaseId','expectedContext','reason'])}],
  ['convergence.adjudicate','convergence-adjudication',['phaseId','itemId','disposition','clauseIds','reason','expectedContext'],
    {phaseBinding:'requested-target',keepsCurrentPhase:true,requiredFields:Object.freeze(['operationId','phaseId','itemId','disposition','expectedContext'])}],
  ['source-review.record','source-review',['phaseId','report','expectedContext'],{humanDecision:false,authority:'requester',phaseBinding:'requested-target',keepsCurrentPhase:true,requiredFields:Object.freeze(['operationId','phaseId','report','expectedContext'])}],
  ['source-review.decide','source-review-disposition',['phaseId','findingId','reason','expectedContext'],{phaseBinding:'requested-target',keepsCurrentPhase:true,requiredFields:Object.freeze(['operationId','phaseId','findingId','reason','expectedContext'])}],
  ['phase.assign','phase-assignment',['phaseId','assignee'],{authority:'requester',humanDecision:false,phaseBinding:'requested-target',keepsCurrentPhase:true,requiredFields:Object.freeze(['operationId','phaseId','assignee'])}],
  ['decision.constitution-exception','constitution-exception',['phaseId','articleId','scope','reason','expires','expectedContext'],
    {phaseBinding:'requested-target',keepsCurrentPhase:true,requiredFields:Object.freeze(['operationId','phaseId','articleId','scope','reason','expectedContext'])}],
  ['decision.scope','scope-disposition',['item','disposition','clauseIds','reason']],
  ['decision.completeness','completeness-review',['confirm','checklist','reason']],
  ['decision.applicability','applicability',['responsibility','reason']],
  ['decision.risk','obligation-risk',['obligationId','revoke','category','transitions','expires','reason']],
  ['decision.plan','plan-amendment',['changes','reason'],{keepsCurrentPhase:true}],
  ['plan.correction.record','plan-row-correction',['ownerPhase','operations','reason','upstreamIssue','expectedPreview'],{keepsCurrentPhase:true,requiredFields:Object.freeze(['operationId','operations','reason','expectedPreview'])}],
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
  ['forward-amendment.propose',['phaseId','reason','file','content','upstreamIssue'],'amendment-proposal',false],
  ['forward-amendment.decide',['amendmentId','decision','reason','confirmation'],'amendment-decision',true],
  ['forward-amendment.revalidate',['phaseId','amendmentId','outcome','reason'],'amendment-revalidation',true]
].map(([id,fields,effect,humanDecision])=>({id,version:1,effect,humanDecision,requestFields:Object.freeze(fields),
  inputFields:Object.freeze(['workId',...(id==='upstream.list'?[]:['operationId']),...fields]),port:'upstream',stages:Object.freeze(['load','resolve','commit','finish']),
  ...(id==='forward-amendment.decide'?{confirmation:'exact-amendment-id'}:{}),validate:'singleDecisionInput',execute:'upstreamOperation'})));
const definitions = [
  { id: 'phase.publish', version: 1, effect: 'publication',
    inputFields: PUBLISH_FIELDS, port: 'publication',
    stages: WRITE_STAGES, validate:'publicationInput', execute:'publish' },
  { id: 'phase.submit', version: 1, effect: 'submission', inputFields: SUBMIT_FIELDS,
    port: 'submission', stages: WRITE_STAGES, validate:'submissionInput', execute:'submit' },
  { id: 'convergence.submit', version: 1, effect: 'submission', inputFields: CONVERGENCE_FIELDS,
    confirmation: 'exact-reviewed-convergence-digest', port: 'submission', stages: WRITE_STAGES,
    validate:'submissionInput', execute:'submit' },
  { id:'phase.approve',version:1,effect:'approval',inputFields:APPROVAL_FIELDS,port:'approval',
    humanDecision:true,stages:Object.freeze(['load','prepare','commit','finish']),
    validate:'approvalInput',execute:'approve' },
  { id:'phase.reject',version:1,effect:'rejection',humanDecision:true,port:'rejection',
    inputFields:Object.freeze(['workId','phaseId','target','reason','clauseIds','members','repair','confirm','selectionReceipt','fetch','agent']),
    stages:Object.freeze(['load','prepare','commit','finish']),validate:'rejectionInput',execute:'reject' },
  {id:'decisions.record',version:1,effect:'decision-records',inputFields:DECISION_FIELDS,port:'decisions',
    authority:'per-effect',humanDecision:true,stages:Object.freeze(['load','prepare','apply','finish']),
    validate:'decisionInput',execute:'recordDecisions'},
  {id:'convergence.advance',version:1,effect:'submission',inputFields:ADVANCE_FIELDS,port:'advancement',
    humanDecision:true,confirmation:'exact-reviewed-convergence-digest',delegatesTo:'convergence.submit',
    stages:Object.freeze(['withReview']),validate:'submissionInput',execute:'advanceConvergence'},
  ...['plan.correction.preview','plan.correct'].map(id=>({id,version:1,effect:id==='plan.correct'?'plan-correction':'read',
    humanDecision:id==='plan.correct',confirmation:id==='plan.correct'?'live-terminal-exact-plan-review':null,
    requestFields:CORRECTION_FIELDS,inputFields:Object.freeze(['workId','fetch',...CORRECTION_FIELDS]),port:'planCorrection',
    stages:Object.freeze(['load','prepare','review','authorize','commit','finish']),validate:'singleDecisionInput',execute:'correctPlan'})),
  ...SINGLE_DECISIONS.map(operation=>({...operation,version:1,effect:'decision-record',humanDecision:operation.humanDecision!==false,
    inputFields:Object.freeze(['workId','fetch',...(operation.id==='decision.choose'?[]:['operationId']),...operation.requestFields]),port:'decisionRecord',
    stages:Object.freeze(['load','prepare','commit','finish']),validate:'singleDecisionInput',execute:'recordSingleDecision'})),
  ...TEST_DECISIONS.map(operation=>({...operation,version:1,effect:'decision-record',
    humanDecision:operation.id!=='test-command.request',authority:operation.id==='test-command.request'?'requester':'reviewer',
    allowRetained:operation.id==='test-command.request',phaseBinding:'resolved-target',
    inputFields:Object.freeze(['workId','fetch',...operation.requestFields]),port:'testDecisionRecord',
    stages:Object.freeze(['load','prepare','resolve','commit','finish']),validate:'singleDecisionInput',execute:'recordSingleDecision'})),
  ...UPSTREAM_OPERATIONS,
  {id:'conformance.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'conformanceContext',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectConformanceContext'},
  {id:'convergence.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'convergenceContext',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectConvergenceContext'},
  {id:'conformance.decide',version:1,effect:'decision-record',humanDecision:true,recordKind:'conformance-gap',phaseBinding:'requested-target',keepsCurrentPhase:true,
    requestFields:Object.freeze(['phaseId','expected','clauseId','ownerPhase','outcome','expires','reason']),
    inputFields:Object.freeze(['workId','phaseId','expected','clauseId','ownerPhase','outcome','expires','reason']),port:'conformanceDecision',
    stages:Object.freeze(['load','prepare','commit','finish']),validate:'singleDecisionInput',execute:'recordSingleDecision'},
  {id:'decision.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId']),port:'decisionContext',
    stages:Object.freeze(['load','read']),validate:'storyGuideInput',execute:'inspectDecisionContext'},
  {id:'decisions.list',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'decisionList',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectDecisionList'},
  {id:'scope.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId']),port:'scopeContext',
    stages:Object.freeze(['load','read']),validate:'storyGuideInput',execute:'inspectScopeContext'},
  {id:'test-command.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'testCommandContext',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectTestCommandContext'},
  {id:'evidence-reuse.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'evidenceReuseContext',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectEvidenceReuseContext'},
  {id:'test-risk.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'testRiskContext',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectTestRiskContext'},
  {id:'test-witness.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'testWitnessContext',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectTestWitnessContext'},
  {id:'test-recovery.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'testRecoveryContext',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectTestRecoveryContext'},
  {id:'source-review.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'sourceReviewContext',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectSourceReviewContext'},
  {id:'witness.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','clauseId','slotName','file']),
    requiredFields:Object.freeze(['clauseId','slotName','file']),port:'witnessContext',stages:Object.freeze(['load','read']),validate:'witnessContextInput',execute:'inspectWitnessContext'},
  {id:'plan.correction.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','ownerPhase','operations','reason','upstreamIssue']),
    requiredFields:Object.freeze(['operations','reason']),port:'planCorrectionContext',stages:Object.freeze(['load','read']),validate:'planCorrectionContextInput',execute:'inspectPlanCorrectionContext'},
  {id:'constitution.exception.context',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId','articleId']),
    requiredFields:Object.freeze(['articleId']),port:'constitutionExceptionContext',stages:Object.freeze(['load','read']),validate:'constitutionExceptionContextInput',execute:'inspectConstitutionExceptionContext'},
  ...['story.document.attach','story.document.detach'].map(id=>({id,version:1,effect:'input-document',humanDecision:false,port:'storyDocument',
    inputFields:Object.freeze(['operationId','workId','documentId','reason',...(id.endsWith('attach')?['name','mimeType','encoding','content']:[])]),
    requiredFields:Object.freeze(['operationId','workId','documentId','reason',...(id.endsWith('attach')?['name','mimeType','encoding','content']:[])]),
    stages:Object.freeze(['load','prepare','commit','finish']),validate:'storyDocumentInput',execute:'recordStoryDocument'})),
  {id:'story.guide',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId']),port:'storyGuide',
    stages:Object.freeze(['load']),validate:'storyGuideInput',execute:'inspectStoryGuide'},
  {id:'story.next',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId']),port:'storyNext',
    stages:Object.freeze(['load']),validate:'storyGuideInput',execute:'inspectStoryNext'},
  {id:'story.status',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId']),port:'storyStatus',
    stages:Object.freeze(['load','read']),validate:'storyStatusInput',execute:'inspectStoryStatus'},
  {id:'story.evidence',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId']),port:'storyEvidence',
    stages:Object.freeze(['load','read']),validate:'storyStatusInput',execute:'inspectStoryEvidence'},
  {id:'workflow.assets',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workflowIds']),port:'workflowAssets',
    stages:Object.freeze(['load','read']),validate:'workflowAssetsInput',execute:'inspectWorkflowAssets'},
  {id:'phase.review',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'phaseReview',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectPhaseReview'},
  {id:'phase.review.resources',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId']),port:'phaseReviewResources',
    stages:Object.freeze(['load','read']),validate:'phaseReviewInput',execute:'inspectPhaseReviewResources'},
  {id:'document.read',version:1,effect:'read',humanDecision:false,
    inputFields:Object.freeze(['workId','reference','includeDetached','maximumBytes']),port:'documentRead',
    stages:Object.freeze(['load','resolve','read']),validate:'documentReadInput',execute:'readDocument'},
  {id:'phase.enter',version:1,effect:'context-entry',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId','compose']),port:'phaseEntry',
    stages:Object.freeze(['load','inspect','compose','clarify','finish']),validate:'phaseEntryInput',execute:'enterPhase'},
  {id:'phase.context.read',version:1,effect:'read',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId','contextSha256','resourceId','maximumBytes','representation','offset']),
    requiredFields:Object.freeze(['workId','phaseId','contextSha256','resourceId']),port:'phaseContextRead',
    stages:Object.freeze(['load','read']),validate:'contextReadInput',execute:'readPhaseContext'},
  {id:'phase.begin',version:1,effect:'local-draft',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId','adoptExisting','confirm']),port:'phaseBegin',
    stages:Object.freeze(['load','verify','begin']),validate:'phaseBeginInput',execute:'beginPhase'},
  {id:'phase.prepare',version:1,effect:'preparation',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId']),port:'phasePreparation',
    stages:Object.freeze(['load','prepare','inspect']),validate:'phaseReviewInput',execute:'preparePhase'},
  {id:'phase.inputs',version:1,effect:'input-preparation',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId','dryRun']),port:'phaseInputs',
    stages:Object.freeze(['load','prepare','inspect']),validate:'phaseInputsInput',execute:'preparePhaseInputs'},
  {id:'phase.rollover',version:1,effect:'local-draft',humanDecision:false,
    confirmation:'exact-current-draft-digest',inputFields:Object.freeze(['workId','phaseId','confirm']),port:'phaseRollover',
    stages:Object.freeze(['load','inspect','begin']),validate:'phaseBeginInput',execute:'rolloverPhase'},
  {id:'phase.prepublish',version:1,effect:'inspection',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId']),port:'phasePrepublish',
    stages:Object.freeze(['load','inspect']),validate:'phaseReviewInput',execute:'inspectPhaseCheck'},
  {id:'phase.draft-check',version:1,effect:'inspection',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId']),port:'phaseDraftCheck',
    stages:Object.freeze(['load','inspect']),validate:'phaseReviewInput',execute:'inspectPhaseCheck'},
  { id:'project.enroll',version:1,subject:'project',effect:'project-enrollment',humanDecision:false,
    inputFields:Object.freeze(['operationId']),requiredFields:Object.freeze(['operationId']),port:'projectEnrollment',
    stages:WRITE_STAGES,validate:'enrollmentInput',execute:'enrollProject' },
  { id:'configuration.approve',version:1,subject:'configuration',effect:'configuration-approval',humanDecision:true,
    authority:'configuration.approve',confirmation:'exact-source-sha256',
    inputFields:Object.freeze(['operationId','source','expectedRevision','confirm','reason']),
    requiredFields:Object.freeze(['operationId','source','expectedRevision','confirm','reason']),port:'configurationApproval',
    stages:WRITE_STAGES,validate:'configurationApprovalInput',execute:'approveConfiguration' },
  { id:'story.create',version:1,subject:'story',effect:'story-creation',humanDecision:false,
    authority:'story.create',inputFields:Object.freeze(['operationId','workId','title','workTypeId','configurationId','source']),
    requiredFields:Object.freeze(['operationId','workId','title','workTypeId','configurationId','source']),port:'storyCreation',
    stages:WRITE_STAGES,validate:'storyCreationInput',execute:'createStory' },
  { id:'source.bind',version:1,subject:'story',effect:'source-binding',humanDecision:false,authority:'source.bind',
    inputFields:Object.freeze(['operationId','workId','expectedRevision','repositories','reason']),
    requiredFields:Object.freeze(['operationId','workId','expectedRevision','repositories','reason']),port:'sourceBinding',
    stages:WRITE_STAGES,validate:'sourceBindingInput',execute:'bindSources' },
  {id:'phase.draft.read',version:1,effect:'read',humanDecision:false,
    inputFields:Object.freeze(['workId','phaseId','maximumBytes']),port:'phaseDraftRead',
    stages:Object.freeze(['load','read']),validate:'draftReadInput',execute:'readPhaseDraft'},
  {id:'phase.source.inspect',version:1,effect:'read',humanDecision:false,authority:'phase.source.inspect',
    inputFields:Object.freeze(['workId','phaseId','maximumEntries']),port:'phaseSourceInspection',
    stages:Object.freeze(['load','inspect']),validate:'sourceInspectionInput',execute:'inspectPhaseSources'},
  {id:'phase.delivery.inspect',version:1,effect:'read',humanDecision:false,authority:'phase.source.inspect',
    inputFields:Object.freeze(['workId','phaseId','maximumEntries','includeImplementation']),port:'phaseDeliveryInspection',
    stages:Object.freeze(['load','inspect']),validate:'deliveryInspectionInput',execute:'inspectPhaseSources'},
  {id:'phase.test-witnesses.inspect',version:1,effect:'read',humanDecision:false,authority:'phase.source.inspect',
    inputFields:Object.freeze(['workId','phaseId','maximumEntries']),port:'phaseTestWitnessInspection',
    stages:Object.freeze(['load','inspect']),validate:'sourceInspectionInput',execute:'inspectPhaseSources'},
  {id:'phase.source.retain',version:1,effect:'source-retention',humanDecision:false,authority:'phase.source.retain',
    inputFields:Object.freeze(['operationId','workId','phaseId']),requiredFields:Object.freeze(['operationId','workId','phaseId']),port:'phaseSourceRetention',
    stages:Object.freeze(['load','retained','prepare','collect','commit','finish']),validate:'sourceRetentionInput',execute:'retainPhaseSources'},
  {id:'phase.output.retain',version:1,effect:'output-retention',humanDecision:false,authority:'phase.output.retain',
    inputFields:Object.freeze(['operationId','workId','phaseId','path','content']),requiredFields:Object.freeze(['operationId','workId','phaseId','path','content']),port:'phaseOutputRetention',
    stages:Object.freeze(['load','retained','prepare','collect','commit','finish']),validate:'outputRetentionInput',execute:'retainPhaseSources'},
  {id:'phase.source-control.retain',version:1,effect:'source-control-retention',humanDecision:false,authority:'phase.source.retain',
    inputFields:Object.freeze(['operationId','workId','phaseId']),requiredFields:Object.freeze(['operationId','workId','phaseId']),port:'phaseSourceControlRetention',
    stages:Object.freeze(['load','retained','prepare','collect','commit','finish']),validate:'sourceRetentionInput',execute:'retainPhaseSources'},
  {id:'source.baseline.retain',version:1,effect:'source-retention',humanDecision:false,authority:'source.baseline.retain',
    inputFields:Object.freeze(['operationId','workId','sourceBindingId']),requiredFields:Object.freeze(['operationId','workId','sourceBindingId']),port:'sourceBaselineRetention',
    stages:Object.freeze(['load','retained','prepare','collect','commit','finish']),validate:'baselineRetentionInput',execute:'retainPhaseSources'},
  {id:'phase.draft.write',version:1,effect:'local-draft',humanDecision:false,authority:'phase.draft.write',
    inputFields:Object.freeze(['operationId','workId','phaseId','expectedRevision','content','reason']),
    requiredFields:Object.freeze(['operationId','workId','phaseId','expectedRevision','content','reason']),port:'phaseDraftWrite',
    stages:WRITE_STAGES,validate:'draftMutationInput',execute:'mutatePhaseDraft'},
  {id:'phase.draft.rebase',version:1,effect:'local-draft',humanDecision:false,authority:'phase.draft.rebase',
    confirmation:'exact-current-draft-body-digest',inputFields:Object.freeze(['operationId','workId','phaseId','expectedRevision','confirm','reason']),
    requiredFields:Object.freeze(['operationId','workId','phaseId','expectedRevision','confirm','reason']),port:'phaseDraftRebase',
    stages:WRITE_STAGES,validate:'draftMutationInput',execute:'mutatePhaseDraft'},
  ...['attach','remove'].map(kind=>({id:'phase.artifact.'+kind,version:1,effect:'local-draft',humanDecision:false,
    authority:'phase.artifact.'+kind,artifactMember:true,inputFields:Object.freeze(['operationId','workId','phaseId','expectedRevision','memberPath',...(kind==='attach'?['content']:[]),'reason']),
    requiredFields:Object.freeze(['operationId','workId','phaseId','expectedRevision','memberPath',...(kind==='attach'?['content']:[]),'reason']),
    port:kind==='attach'?'phaseArtifactAttach':'phaseArtifactRemove',stages:WRITE_STAGES,validate:'draftMutationInput',execute:'mutatePhaseDraft'})),
  {id:'phase.artifact.inspect',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId','maximumEntries']),
    port:'phaseArtifactInspection',stages:Object.freeze(['load','inspect']),validate:'sourceInspectionInput',execute:'inspectPhaseSources'},
  {id:'phase.checks.run',version:1,effect:'phase-check-execution',humanDecision:false,authority:'phase.checks.run',
    inputFields:Object.freeze(['operationId','workId','phaseId']),requiredFields:Object.freeze(['operationId','workId','phaseId']),
    port:'phaseChecks',stages:Object.freeze(['load','retained','prepare','execute','commit','finish']),
    validate:'phaseChecksInput',execute:'runPhaseChecks'},
  {id:'phase.repair.run',version:1,effect:'test-repair-execution',humanDecision:false,authority:'phase.repair.run',
    inputFields:Object.freeze(['operationId','workId','phaseId','failedOperationId']),requiredFields:Object.freeze(['operationId','workId','phaseId','failedOperationId']),
    port:'phaseRepair',stages:Object.freeze(['load','retained','prepare','execute','commit','finish']),validate:'phaseRepairInput',execute:'runPhaseRepair'},
  {id:'clarification.status',version:1,effect:'read',humanDecision:false,inputFields:Object.freeze(['workId','phaseId','agentId']),
    requiredFields:Object.freeze([]),port:'clarificationStatus',stages:Object.freeze(['load','inspect']),validate:'clarificationInput',execute:'inspectClarification'},
  {id:'clarification.record',version:1,effect:'clarification-record',humanDecision:true,authority:'clarification.record',
    confirmation:'exact-reviewed-clarification-context',
    inputFields:Object.freeze(['operationId','workId','phaseId','agentId','contextSha256','responses','replace','reason']),
    requiredFields:Object.freeze(['operationId','workId','phaseId','contextSha256','responses']),port:'clarificationRecord',
    stages:WRITE_STAGES,validate:'clarificationInput',execute:'recordClarification'}
];
export const ENGINE_OPERATIONS = Object.freeze(definitions.map(({validate,execute,...descriptor})=>Object.freeze(descriptor)));
const registry = new Map(definitions.map(operation => [operation.id, Object.freeze(operation)]));

function enrollmentInput(value) { return projectEnrollmentInput(data(value)); }
function clarificationInput(value,operation){return clarificationOperationInput(data(value),operation);}
function clarificationResult(input,result) {
  const facts=data(result);
  if(facts?.subject?.kind!=='story'||typeof facts.subject.id!=='string'||typeof facts.phase!=='string'
    ||input.workId!==undefined&&input.workId!==facts.subject.id||input.phaseId!==undefined&&input.phaseId!==facts.phase
    ||!Number.isSafeInteger(facts.generation)||facts.generation<1)throw new SingularityFlowError(
    'The clarification port returned another Story, phase or generation.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return facts;
}
async function inspectClarification(port,input,signal) {
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  const facts=clarificationResult(input,await port.inspect(context,input,{signal}));notCancelled(signal);
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'clarification.status',...facts});
}
async function recordClarification(port,input,signal) {
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  let accepted=await port.retained(context,input,{signal});notCancelled(signal);
  if(accepted===null){const prepared=await port.prepare(context,input,{signal});notCancelled(signal);accepted=await port.commit(context,prepared,{signal});}
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'clarification.record',
    ...clarificationResult(input,await port.finish(context,accepted,{signal:null}))});
}
function configurationApprovalInput(value) { return projectConfigurationInput(data(value)); }
function draftReadInput(value){return phaseDraftReadInput(data(value));}
function draftMutationInput(value,operation){return phaseDraftMutationInput(data(value),operation);}
function phaseChecksInput(value){return checkedPhaseChecksInput(data(value));}
function sourceInspectionInput(value){return phaseSourceInspectionInput(data(value));}
function deliveryInspectionInput(value){return phaseDeliveryInspectionInput(data(value));}
function sourceRetentionInput(value){return phaseSourceRetentionInput(data(value));}
function outputRetentionInput(value){return phaseOutputRetentionInput(data(value));}
function baselineRetentionInput(value){return sourceBaselineRetentionInput(data(value));}
async function retainPhaseSources(port,input,signal,operation) {
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  let accepted=await port.retained(context,input,{signal});notCancelled(signal);
  if(accepted===null){const prepared=await port.prepare(context,input,{signal});notCancelled(signal);
    const collected=await port.collect(context,prepared,{signal});notCancelled(signal);accepted=await port.commit(context,collected,{signal});}
  const result=operation.id==='phase.output.retain'?phaseOutputRetentionResult:operation.id==='source.baseline.retain'?sourceBaselineRetentionResult:operation.id==='phase.source-control.retain'?phaseSourceControlRetentionResult:phaseSourceRetentionResult;
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,
    ...result(input,data(await port.finish(context,accepted,{signal:null})))});
}
async function inspectPhaseSources(port,input,signal,operation) {
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  if(context?.subject?.kind!=='story'||typeof context.subject.id!=='string'||typeof context.phase!=='string'
    ||input.workId!==undefined&&input.workId!==context.subject.id||input.phaseId!==undefined&&input.phaseId!==context.phase) {
    throw new SingularityFlowError('The source inspector returned another Story or phase.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const facts=data(await port.inspect(context,input,{signal}));notCancelled(signal);
  if(operation.id==='phase.delivery.inspect'&&input.includeImplementation===true&&facts.profile!==DELIVERY_INSPECTION_PROFILE_V5)throw new SingularityFlowError(
    'This delivery reader does not provide exact implementation-region observations.',{code:'ENGINE_PORT_UNAVAILABLE',details:{required:['implementation-region-reader']}});
  const manifest=operation.id==='phase.delivery.inspect'?phaseDeliveryInspectionManifest:operation.id==='phase.test-witnesses.inspect'?testWitnessInspectionManifest
    :operation.id==='phase.artifact.inspect'?phaseArtifactInspectionManifest:phaseSourceInspectionManifest;
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,subject:context.subject,phase:context.phase,
    manifest:manifest(context.subject.id,context.phase,facts,input.maximumEntries),
    effects:{committed:false,pushed:false,localDraftSaved:false,sourceFilesChanged:false,testsRun:false,approvalRecorded:false}});
}
function phaseRepairInput(value){const input=data(value),{failedOperationId,...source}=input;
  if(typeof failedOperationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(failedOperationId))throw new SingularityFlowError(
    'Name the exact failed check operation.',{code:'ENGINE_INPUT_INVALID'});
  return {...phaseSourceRetentionInput(source),failedOperationId};}
async function runPhaseRepair(port,input,signal){
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  let accepted=await port.retained(context,input,{signal});notCancelled(signal);
  if(accepted===null){const prepared=await port.prepare(context,input,{signal});notCancelled(signal);
    const completed=await port.execute(context,prepared,{signal});notCancelled(signal);accepted=await port.commit(context,completed,{signal});}
  const facts=data(await port.finish(context,accepted,{signal:null}));
  if(facts?.profile!=='sflow-namespace-test-repair-outcome/v1'||facts.workId!==input.workId||facts.phase!==input.phaseId
    ||facts.operationId!==input.operationId||!Number.isSafeInteger(facts.attempt)||facts.attempt<1||facts.attempt>3
    ||!['repaired','repair-required','scope-review-required'].includes(facts.verdict)||typeof facts.replayed!=='boolean'||typeof facts.sourceFilesChanged!=='boolean'
    ||!Array.isArray(facts.actions)||facts.verdict==='repaired'&&(!facts.checks||facts.failure||facts.scopeViolation))throw new SingularityFlowError(
    'The repair owner returned another task or an unsupported success claim.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.repair.run',manifest:facts,
    effects:{committed:!facts.replayed,testsRun:!facts.replayed&&facts.checks!==null,sourceFilesChanged:!facts.replayed&&facts.sourceFilesChanged,approvalRecorded:false,storyAdvanced:false}});
}
async function runPhaseChecks(port,input,signal) {
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  let accepted=await port.retained(context,input,{signal});notCancelled(signal);
  if(accepted===null){const prepared=await port.prepare(context,input,{signal});notCancelled(signal);
    const completed=await port.execute(context,prepared,{signal});notCancelled(signal);
    accepted=await port.commit(context,completed,{signal});}
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.checks.run',
    ...phaseChecksResult(input,data(await port.finish(context,accepted,{signal:null})))});
}
async function readPhaseDraft(port,input,signal) {
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  if(context?.subject?.kind!=='story'||typeof context.subject.id!=='string'||typeof context.phase!=='string'
    ||input.workId!==undefined&&input.workId!==context.subject.id||input.phaseId!==undefined&&input.phaseId!==context.phase) {
    throw new SingularityFlowError('The private draft reader returned another subject.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  const facts=data(await port.read(context,input,{signal}));notCancelled(signal);
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.draft.read',subject:context.subject,phase:context.phase,
    manifest:phaseDraftReadManifest(context.subject.id,context.phase,facts,input.maximumBytes),effects:{committed:false,pushed:false,localDraftSaved:false,approvalRecorded:false}});
}
async function mutatePhaseDraft(port,input,signal,operation) {
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  let accepted=await port.retained(context,input,{signal});notCancelled(signal);
  if(accepted===null){const prepared=await port.prepare(context,input,{signal});notCancelled(signal);accepted=await port.commit(context,prepared,{signal});}
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,
    ...phaseDraftMutationResult(input,data(await port.finish(context,accepted,{signal:null})),operation)});
}

async function bindSources(port,inputs,signal) {
  notCancelled(signal);const context=await port.load(inputs,{signal});notCancelled(signal);
  const binding=data(sourceBindingScope(data(context?.binding),inputs));
  let accepted=await port.retained(context,inputs,{signal});notCancelled(signal);
  if(accepted===null) {
    try {const prepared=await port.prepare(context,inputs,{signal});notCancelled(signal);accepted=await port.commit(context,prepared,{signal});}
    catch(cause) {
      if(!['ENGINE_CONTEXT_CHANGED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
      accepted=await port.retained(context,inputs,{signal});if(accepted===null)throw cause;
    }
  }
  const facts=data(await port.finish(context,accepted,{signal:null}));
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'source.bind',...sourceBindingResult(binding,inputs,facts)});
}

async function createStory(port, inputs, signal) {
  notCancelled(signal);
  const context=await port.load(inputs,{signal});notCancelled(signal);
  const binding=data(storyCreationBinding(data(context?.binding),inputs));
  let committed=await port.retained(context,inputs,{signal});notCancelled(signal);
  if(committed===null) {
    try {const prepared=await port.prepare(context,inputs,{signal});notCancelled(signal);committed=await port.commit(context,prepared,{signal});}
    catch(cause) {
      if(!['ENGINE_STORY_EXISTS','ENGINE_CONTEXT_CHANGED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
      committed=await port.retained(context,inputs,{signal});if(committed===null)throw cause;
    }
  }
  const facts=data(await port.finish(context,committed,{signal:null}));
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'story.create',...storyCreationResult(binding,inputs,facts)});
}

async function approveConfiguration(port, inputs, signal) {
  notCancelled(signal);
  const context = await port.load(inputs, { signal }); notCancelled(signal);
  const binding = data(projectConfigurationBinding(data(context?.binding)));
  let committed = await port.retained(context, inputs, { signal }); notCancelled(signal);
  if (committed === null) {
    try {
      const prepared = await port.prepare(context, inputs, { signal }); notCancelled(signal);
      committed = await port.commit(context, prepared, { signal });
    } catch (cause) {
      if (!['ENGINE_CONTEXT_CHANGED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code)) throw cause;
      // A concurrent invocation may have accepted this exact intent. Inspect its immutable
      // receipt once; never retry a mutation or substitute a newly selected base revision.
      committed = await port.retained(context, inputs, { signal });
      if (committed === null) throw cause;
    }
  }
  const facts = data(await port.finish(context, committed, { signal: null }));
  return data({ schemaVersion: 1, contract: ENGINE_CONTRACT, operation: 'configuration.approve',
    ...projectConfigurationResult(binding, inputs, facts) });
}

async function enrollProject(port, inputs, signal) {
  notCancelled(signal);
  const context = await port.load(inputs, { signal }); notCancelled(signal);
  const binding = data(projectEnrollmentBinding(data(context?.binding)));
  const retained = await port.retained(context, inputs, { signal }); notCancelled(signal);
  let committed = retained;
  if (retained === null) {
    try {
      const prepared = await port.prepare(context, inputs, { signal }); notCancelled(signal);
      committed = await port.commit(context, prepared, { signal });
    } catch(cause) {
      if(!['ENGINE_PROJECT_ALREADY_ENROLLED','ENGINE_CONTEXT_CHANGED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
      committed=await port.retained(context,inputs,{signal});if(committed===null)throw cause;
    }
  }
  // A known durable receipt must still be acknowledged if cancellation arrives after commit.
  const facts = data(await port.finish(context, committed, { signal: null }));
  return data({ schemaVersion: 1, contract: ENGINE_CONTRACT, operation: 'project.enroll',
    ...projectEnrollmentResult(binding, inputs, facts) });
}

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

function storyStatusInput(value, operation) {
  const input = phaseReviewInput(value, operation);
  if (input.workId != null && (!input.workId.trim() || input.workId.length > 512)) invalid('Invalid Story status identifier.');
  return input;
}

function storyGuideInput(value, operation) {
  const input = phaseReviewInput(value, operation);
  if (input.workId != null && (!input.workId.trim() || input.workId.length > 512)) invalid('Invalid Story guide identifier.');
  return input;
}

async function inspectStoryGuide(port, inputs, signal) {
  notCancelled(signal);
  const context = await port.load(inputs, {signal}); notCancelled(signal);
  const id = context?.workflow?.workItem?.id;
  if (context?.subject?.kind !== 'story' || typeof id !== 'string' || !id || context.subject.id !== id
    || !Array.isArray(context.workflow.phaseOrder) || !context.workflow.phases || typeof context.workflow.phases !== 'object'
    || Array.isArray(context.workflow.phases)) {
    throw new SingularityFlowError('The guide port did not bind a Story.', {code:'ENGINE_PORT_RESULT_INVALID'});
  }
  if (inputs.workId != null && inputs.workId !== id) throw new SingularityFlowError(
    'Requested Story does not match the guide record.', {code:'ACTIVE_SUBJECT_MISMATCH',
      details:{expectedWorkId:inputs.workId,actualWorkId:id}});
  let manifest;
  try {
    if(context.observations!==undefined)workflowNextManifest(context.workflow,data(context.observations));
    const plan = workflowGuidePlan(context.workflow,{sourceReviewEvidence:context.observations?.sourceReviewEvidence??null,
      amendmentHold:context.observations?.amendmentHold??false});
    manifest = data({...plan,actions:plan.actions.map(action=>({...action,operation:continuationOperation(action)}))});
  } catch (cause) {
    if (cause?.code !== 'ENGINE_INPUT_INVALID') throw cause;
    throw new SingularityFlowError('The guide port returned invalid continuation facts.', {code:'ENGINE_PORT_RESULT_INVALID',cause});
  }
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'story.guide',status:'inspected',
    subject:{kind:'story',id},manifest,
    effects:{committed:false,pushed:false,testsRun:false,modelInvocations:0,humanReviewRecorded:false,approvalRecorded:false,storyAdvanced:false}});
}

async function inspectStoryNext(port, inputs, signal) {
  notCancelled(signal);
  const context = await port.load(inputs, {signal}); notCancelled(signal);
  const id = context?.workflow?.workItem?.id;
  if (context?.subject?.kind !== 'story' || typeof id !== 'string' || !id || context.subject.id !== id
      || !Array.isArray(context.workflow.phaseOrder) || !context.workflow.phases
      || typeof context.workflow.phases !== 'object' || Array.isArray(context.workflow.phases)) {
    throw new SingularityFlowError('The next-step port did not bind a Story.', {code:'ENGINE_PORT_RESULT_INVALID'});
  }
  if (inputs.workId != null && inputs.workId !== id) throw new SingularityFlowError(
    'Requested Story does not match the next-step record.', {code:'ACTIVE_SUBJECT_MISMATCH',
      details:{expectedWorkId:inputs.workId,actualWorkId:id}});
  let manifest;
  try {
    const plan = workflowNextManifest(context.workflow, context.observations);
    manifest = data({...plan, actions:plan.actions.map(action=>({...action, operation:continuationOperation(action)}))});
  } catch (cause) {
    if (cause?.code !== 'ENGINE_INPUT_INVALID') throw cause;
    throw new SingularityFlowError('The next-step port returned invalid observations.', {code:'ENGINE_PORT_RESULT_INVALID',cause});
  }
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'story.next',status:'inspected',subject:{kind:'story',id},manifest,
    effects:{committed:false,pushed:false,testsRun:false,modelInvocations:0,humanReviewRecorded:false,approvalRecorded:false,storyAdvanced:false}});
}

/** The registry owns operation names; kernel action kinds do not embed a host command language. */
function continuationOperation(action) {
  const inputs={workId:action.workId,...action.phaseId==null?{}:{phaseId:action.phaseId}};
  let id;
  switch(action.kind) {
    case 'prepare-phase': case 'prepare-convergence': case 'prepare-deterministic-convergence': id='phase.prepare';break;
    case 'return-phase': id='phase.reject';inputs.target=action.targetPhase;break;
    case 'review-code-successor': id='phase.rollover';break;
    case 'review-published-source': case 'check-source-review-status': id='source-review.context';break;
    case 'decide-source-review-finding': id='source-review.context';break;
    case 'submit-phase': id='phase.submit';break;
    case 'advance-convergence': id='convergence.advance';delete inputs.phaseId;break;
    case 'inspect-convergence-context': id='convergence.context';break;
    case 'approve-phase': id='phase.approve';break;
    case 'pending-decisions': case 'inspect-owner-decisions': id='decisions.list';break;
    case 'view-phase-documents': id='phase.review';break;
    case 'publish-phase': id='phase.publish';break;
    case 'prepare-following-phase': id='phase.prepare';inputs.phaseId=action.targetPhase;break;
    case 'resolve-phase-inputs': id='phase.inputs';break;
    case 'recalculate-next': id='story.next';delete inputs.phaseId;break;
    case 'reopen-routing-phase': id='decision.choose';delete inputs.phaseId;inputs.to=action.targetPhase;inputs.expected=action.expected;break;
    case 'choose-workflow-route': id='decision.choose';delete inputs.phaseId;inputs.option=action.optionId;inputs.expected=action.expected;break;
    case 'resume-phase-authoring':
      if(action.stage==='open-code-generation')id='phase.begin';
      else if(action.stage==='validate-existing-draft')id='phase.prepublish';
      else if(action.stage==='review-convergence')id='convergence.context';
      else if(['complete-draft','create-missing-draft','resume-draft'].includes(action.stage))id='phase.prepare';
      else return null;
      break;
    default:return null;
  }
  const descriptor=registry.get(id);
  if(!descriptor||Object.keys(inputs).some(key=>!descriptor.inputFields.includes(key)))throw new SingularityFlowError(
    'The continuation refers to an unavailable registry operation.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return {id,inputs,port:descriptor.port};
}

async function inspectStoryStatus(port, inputs, signal) {
  notCancelled(signal);
  const context = await port.load(inputs, { signal }); notCancelled(signal);
  let binding;
  try { binding = data(storyStatusSelection(context, inputs)); } catch (cause) {
    if (cause?.code !== 'ENGINE_INPUT_INVALID') throw cause;
    throw new SingularityFlowError('The status port returned an invalid record binding.', { code: 'ENGINE_PORT_RESULT_INVALID', cause });
  }
  const observed = await port.read(context, binding, { signal }); notCancelled(signal);
  let facts;
  try { facts = data(observed); } catch (cause) {
    throw new SingularityFlowError('The status port returned non-JSON facts.', { code: 'ENGINE_PORT_RESULT_INVALID', cause });
  }
  return data({ schemaVersion: 1, contract: ENGINE_CONTRACT, operation: 'story.status', status: 'inspected',
    subject: { kind: 'story', id: binding.workId }, manifest: storyStatusManifest(binding, facts),
    effects: { committed: false, pushed: false, testsRun: false, modelInvocations: 0, approvalRecorded: false, storyAdvanced: false } });
}

async function inspectStoryEvidence(port,input,signal){
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  const subject=data(context?.subject),facts=data(await port.read(context,{signal}));notCancelled(signal);
  const evidenceProfile=namespaceEvidenceContextProfile(facts);
  if(subject?.kind!=='story'||subject.id!==facts.workId||input.workId!=null&&input.workId!==facts.workId
    ||facts.profile!==evidenceProfile.profile||typeof facts.revision!=='string'||!facts.revision
    ||facts.report?.profile!==('sflow-evidence-evaluation/v'+evidenceProfile.version)||facts.report.workId!==facts.workId||facts.report.mode!=='projection'||facts.report.boundary!=='view'
    ||facts.localSourceChecked!==false||facts.terminalDecision!==false||facts.approvalRecorded!==false||!Array.isArray(facts.references))
    throw new SingularityFlowError('The evidence reader returned another Story or an unsupported authority claim.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'story.evidence',subject,manifest:facts,
    effects:{committed:false,pushed:false,testsRun:false,modelInvocations:0,approvalRecorded:false,storyAdvanced:false}});
}

function phaseInputsInput(value, operation) {
  const input = data(value);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !operation.inputFields.includes(key))
    || ['workId','phaseId'].some(key => input[key] != null && typeof input[key] !== 'string')
    || input.dryRun != null && typeof input.dryRun !== 'boolean') invalid('Invalid phase-input selection or preview mode.');
  return input;
}

async function preparePhaseInputs(port, inputs, signal) {
  let binding = null, pendingStage = 'load'; const completedStages = [];
  try {
    notCancelled(signal);
    const context = await port.load(inputs, { signal }); completedStages.push('load'); notCancelled(signal);
    const selected = phaseBeginSelection(context?.workflow, inputs);
    binding = data({ workId: selected.workId, phase: selected.phase, generation: selected.generation,
      dryRun: inputs.dryRun === true, artifactKey: context.workflow.phases[selected.phase].requiredArtifact?.path ?? null,
      auditRequired: phaseInputsAuditRequired(context.workflow, context.workflow.phases[selected.phase]) });
    pendingStage = 'prepare'; await port.prepare(context, binding, { signal }); completedStages.push('prepare'); notCancelled(signal);
    pendingStage = 'inspect'; const observed = await port.inspect(context, binding, { signal }); completedStages.push('inspect'); notCancelled(signal);
    let facts, manifest;
    try { facts = data(observed); manifest = data(phaseInputsManifest(binding, facts)); }
    catch (cause) {
      if (cause?.code === 'ENGINE_INPUT_INVALID') throw new SingularityFlowError('The phase-input port returned non-JSON facts.', { code: 'ENGINE_PORT_RESULT_INVALID', cause });
      throw cause;
    }
    return data({ schemaVersion: 1, contract: ENGINE_CONTRACT, operation: 'phase.inputs', status: binding.dryRun ? 'inspected' : 'prepared',
      subject: { kind: 'story', id: binding.workId }, phase: binding.phase, generation: binding.generation, manifest,
      effects: { artifactPrepared: !binding.dryRun, inputAuditRecorded: facts.auditRecorded, generationOpened: facts.generationOpened,
        localProgressMayBeWritten: true, testsRun: false, modelInvocations: 0, committed: false, pushed: false,
        humanReviewRecorded: false, approvalRecorded: false, storyAdvanced: false } });
  } catch (error) {
    attachDiagnostic(error, 'enginePhaseInputs', { operation: 'phase.inputs', subject: binding ? { kind: 'story', id: binding.workId } : null,
      phase: binding?.phase ?? null, generation: binding?.generation ?? null, completedStages, pendingStage,
      localEffectsMayExist: pendingStage === 'prepare' || completedStages.includes('prepare'), committed: false, pushed: false, approvalRecorded: false });
    throw error;
  }
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

async function inspectConformanceContext(port,inputs,signal) {
  const record=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
  notCancelled(signal);const context=await port.load(inputs,{signal});notCancelled(signal);
  const workId=context?.workflow?.workItem?.id,phaseId=inputs.phaseId??context?.phase?.id??context?.workflow?.currentPhase,
    phase=context?.workflow?.phases?.[phaseId];
  if(typeof workId!=='string'||!workId.trim()||context?.subject?.kind!=='story'||context.subject.id!==workId
    ||inputs.workId!=null&&inputs.workId!==workId||typeof phaseId!=='string'||!phaseId.trim()||!phase
    ||!Number.isSafeInteger(phase.generation)||phase.generation<0)throw new SingularityFlowError(
      'The conformance port returned an invalid Story or phase binding.',{code:'ENGINE_PORT_RESULT_INVALID'});
  const observed=await port.read(context,{signal});notCancelled(signal);let result;
  try{result=data(observed);}catch(cause){throw new SingularityFlowError('The conformance port returned non-JSON facts.',{code:'ENGINE_PORT_RESULT_INVALID',cause});}
  let publicationValid=false;try{publicationValid=phasePublicationBindingValue(result.publication).generation===result.generation;}catch{ /* The port response is checked below. */ }
  if(!record(result,['phase','generation','expected','publication','report','gaps','actions'])
    ||result.phase!==phaseId||result.generation!==phase.generation||!/^([a-f0-9]{64})$/u.test(result.expected??'')
    ||!publicationValid||!record(result.report,['namespace','sha256','bytes'])||result.report.namespace!=='evidence'||!/^([a-f0-9]{64})$/u.test(result.report.sha256??'')
    ||!Number.isSafeInteger(result.report.bytes)||result.report.bytes<1||result.report.bytes>MAXIMUM_DOCUMENT_READ_BYTES
    ||!Array.isArray(result.gaps)||!Array.isArray(result.actions))throw new SingularityFlowError('The conformance context has another Story or generation.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'conformance.context',status:'ready',subject:context.subject,...result,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});
}

async function inspectScopeContext(port,inputs,signal) {
  notCancelled(signal);const context=await port.load(inputs,{signal});notCancelled(signal);
  const id=context?.workflow?.workItem?.id;
  if(typeof id!=='string'||!id||context?.subject?.kind!=='story'||context.subject.id!==id||inputs.workId!=null&&inputs.workId!==id)throw new SingularityFlowError(
    'The scope port returned another bound Story.',{code:'ENGINE_PORT_RESULT_INVALID'});
  const observed=await port.read(context,{signal});notCancelled(signal);let facts;
  try{facts=data(observed);}catch(cause){throw new SingularityFlowError('The scope port returned non-JSON facts.',{code:'ENGINE_PORT_RESULT_INVALID',cause});}
  const fields=['workId','revision','inventory','knownClauseIds','authorities','completenessReview'],inventory=facts?.inventory;
  if(!facts||Object.keys(facts).length!==fields.length||!fields.every(key=>Object.hasOwn(facts,key))||facts.workId!==id
    ||typeof facts.revision!=='string'||!facts.revision||inventory?.schema!=='scope-inventory/v1'||inventory.workId!==id
    ||!/^sha256:[a-f0-9]{64}$/u.test(inventory.inventorySha256??'')||!/^sha256:[a-f0-9]{64}$/u.test(inventory.sourceSetSha256??'')
    ||!Array.isArray(inventory.items)||!Array.isArray(inventory.sources)||!Number.isSafeInteger(inventory.summary?.unresolved)||inventory.summary.unresolved<0
    ||inventory.structurallyComplete!==(inventory.summary.unresolved===0)||!Array.isArray(facts.knownClauseIds)||facts.knownClauseIds.some(value=>typeof value!=='string')
    ||!Array.isArray(facts.authorities)||facts.authorities.some(value=>typeof value!=='string')
    ||facts.completenessReview!==null&&(typeof facts.completenessReview!=='object'||Array.isArray(facts.completenessReview)))throw new SingularityFlowError(
      'The scope context has an invalid inventory or Story binding.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'scope.context',status:'ready',subject:{kind:'story',id},manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});
}
async function inspectSourceReviewContext(port,input,signal){notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  const bound=data({subject:context.subject,phase:context.phase?.id,generation:context.phase?.generation}),facts=data(await port.read(context,{signal}));notCancelled(signal);
  let profile=null;try{profile=namespaceSourceReviewRecordProfile('context',facts);}catch{ /* Reject another wire contract below. */ }
  if(!profile||bound.subject?.kind!=='story'||facts?.profile!==profile.profile
    ||facts.workId!==bound.subject.id||input.workId!=null&&input.workId!==facts.workId||facts.phase!==bound.phase||facts.generation!==bound.generation
    ||facts.binding?.workId!==facts.workId||facts.binding.phase!==facts.phase||facts.binding.generation!==facts.generation
    ||!/^sha256:[a-f0-9]{64}$/u.test(facts.contextBinding??'')||!Array.isArray(facts.resources)||!['missing','ready','stale','correction-required'].includes(facts.status?.status))throw new SingularityFlowError(
      'The source-review context returned another published binding.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'source-review.context',subject:bound.subject,manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});}
async function inspectConvergenceContext(port,input,signal){notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  if(context?.subject?.kind!=='story'||typeof context.subject.id!=='string'||!context.phase||context.workflow?.workItem?.id!==context.subject.id
    ||!Number.isSafeInteger(context.phase.generation)||context.phase.generation<0
    ||!equalJson(context.workflow.phases?.[context.phase.id],context.phase))throw new SingularityFlowError('The convergence port did not bind an actual Story phase.',{code:'ENGINE_PORT_RESULT_INVALID'});
  const phase=context.phase,expectedGeneration=phase?.generation>0&&!phaseExplicitlyReopened(context.workflow,phase)?phase.generation:nextPhaseGeneration(phase),
    bound=data({subject:context.subject,phase:phase?.id,generation:expectedGeneration}),facts=data(await port.read(context,{signal}));notCancelled(signal);
  let profile=null;try{profile=namespaceConvergenceContextProfile(facts);}catch{ /* A port cannot change the context ABI. */ }
  const fields=['schemaVersion','profile','workId','phase','generation','contextBinding','sourceSha256','projection','reads','decisions','actions'];
  if(!profile||Object.keys(facts).length!==fields.length||!fields.every(key=>Object.hasOwn(facts,key))||facts.profile!==profile.profile
    ||bound.subject?.kind!=='story'||facts.workId!==bound.subject.id||input.workId!=null&&input.workId!==facts.workId
    ||input.phaseId!=null&&facts.phase!==input.phaseId||facts.phase!==bound.phase||facts.generation!==bound.generation
    ||!/^sha256:[a-f0-9]{64}$/u.test(facts.contextBinding??'')||!/^[a-f0-9]{64}$/u.test(facts.sourceSha256??'')
    ||facts.projection?.workId!==facts.workId||facts.projection.phase!==facts.phase||facts.projection.generation!==facts.generation
    ||facts.projection.sourceSha256!==facts.sourceSha256||!Array.isArray(facts.reads)||!Array.isArray(facts.decisions)||!Array.isArray(facts.actions))throw new SingularityFlowError(
    'The convergence context returned another Story, generation or projection.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'convergence.context',subject:bound.subject,manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});}
function witnessContextInput(value){const input=data(value);if(typeof input.clauseId!=='string'||typeof input.slotName!=='string'||typeof input.file!=='string'
    ||!input.clauseId||!input.slotName||!input.file)throw new SingularityFlowError('Name one criterion, inspection slot and published evidence path.',{code:'ENGINE_INPUT_INVALID'});
  return {...input,clauseId:input.clauseId.toUpperCase()};}
async function inspectWitnessContext(port,input,signal){notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  const facts=data(await port.read(context,{signal}));notCancelled(signal);
  const fields=['schemaVersion','profile','workId','phase','revision','clauseId','slot','file','contextBinding','authorities','result'],file=facts?.file;
  let profile=null;try{profile=namespaceWitnessContextProfile(facts);}catch{ /* The facts are validated as this port's result below. */ }
  if(!facts||!profile||Object.keys(facts).length!==fields.length||!fields.every(key=>Object.hasOwn(facts,key))||facts.profile!==profile.profile
    ||context?.subject?.kind!=='story'||facts.workId!==context.subject.id||facts.phase!==context.workflow?.currentPhase||input.workId!=null&&facts.workId!==input.workId||facts.clauseId!==input.clauseId
    ||facts.slot?.slot!==input.slotName||!['inspection','visual'].includes(facts.slot?.method)||file?.path!==input.file||file?.content?.namespace!=='evidence'
    ||!/^[a-f0-9]{64}$/u.test(file?.content?.sha256??'')||!Number.isSafeInteger(file?.content?.bytes)||file.content.bytes<0
    ||!/^sha256:[a-f0-9]{64}$/u.test(facts.contextBinding??'')||typeof facts.revision!=='string'||!Array.isArray(facts.authorities)||facts.authorities.some(value=>typeof value!=='string'||!value)
    ||facts.result?.clauseId!==input.clauseId||facts.result?.slot!==input.slotName||!['missing','failed','met'].includes(facts.result?.status))throw new SingularityFlowError(
      'The witness context returned another criterion, slot or published file.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'witness.context',subject:context.subject,manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});}

function constitutionExceptionContextInput(value,operation){const input=phaseReviewInput(value,operation);
  if(!/^[A-Z][A-Z0-9]*-\d{3,}$/u.test(String(input.articleId??'').toUpperCase()))throw new SingularityFlowError('Name one exact pinned constitution article.',{code:'ENGINE_INPUT_INVALID'});
  return {...input,articleId:input.articleId.toUpperCase()};}
async function inspectConstitutionExceptionContext(port,input,signal){notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  const phase=input.phaseId??context.workflow?.currentPhase,
    bound=data({subject:context.subject,phase,active:context.workflow?.status==='in_progress'&&context.workflow.currentPhase===phase&&context.workflow.phases[phase]?.status==='awaiting_approval',
      generations:Object.fromEntries(Object.entries(context.workflow?.phases??{}).map(([id,row])=>[id,row.generation]))}),
    facts=data(await port.read(context,{signal}));notCancelled(signal);
  const fields=['schemaVersion','format','workId','phase','generation','revision','article','expectedContext','source','existing','authorities','recording','read','machinePoliciesWaived','phaseApproved'],
    ref=(value,namespace)=>value&&Object.keys(value).length===3&&Object.keys(value).every(key=>['namespace','sha256','bytes'].includes(key))
      &&(namespace?value.namespace===namespace:['state','config','evidence'].includes(value.namespace))&&/^[a-f0-9]{64}$/u.test(value.sha256??'')&&Number.isSafeInteger(value.bytes)&&value.bytes>=0,
    source=facts?.source;
  let profile=null;try{profile=namespaceConstitutionExceptionContextProfile(facts);}catch{ /* Another wire is an invalid port result. */ }
  if(!facts||Object.keys(facts).length!==fields.length||!fields.every(key=>Object.hasOwn(facts,key))||!profile
    ||facts.format!==profile.format||bound.subject?.kind!=='story'||facts.workId!==bound.subject.id
    ||input.workId!=null&&input.workId!==facts.workId||facts.phase!==bound.phase||facts.generation!==bound.generations[facts.phase]||facts.generation<1
    ||typeof facts.revision!=='string'||facts.article?.id!==input.articleId||!/^[a-f0-9]{64}$/u.test(facts.article?.articleSha256??'')
    ||!/^sha256:[a-f0-9]{64}$/u.test(facts.expectedContext??'')||source?.profile!=='sflow-namespace-constitution-exception-source/v1'
    ||source.constitution?.articleSha256!==facts.article.articleSha256||source.constitution?.articleId!==input.articleId
    ||source.publication?.generation!==facts.generation||!ref(source.publication?.record,'evidence')||!ref(source.reviewPacket,'evidence')
    ||typeof source.configuration?.key!=='string'||!ref(source.configuration?.content,'config')||!ref(source.storySource)
    ||!ref(source.constitution?.policy,'evidence')||!ref(source.constitution?.report,'evidence')||!ref(source.constitution?.source,'config')
    ||!Array.isArray(facts.existing)||!Array.isArray(facts.authorities)||!facts.authorities.length||facts.authorities.some(value=>typeof value!=='string'||!value)
    ||!equalJson(facts.read,{operation:'phase.review.resources',inputs:{workId:facts.workId,phaseId:facts.phase}})
    ||!facts.recording||!Array.isArray(facts.recording.requiredOwners)||facts.recording.requiredOwners.some(value=>value!=='person-presence')
    ||facts.recording.status!==(!bound.active?'read-only':facts.recording.requiredOwners.length?'owner-required':'requires-human-review')
    ||facts.machinePoliciesWaived!==false||facts.phaseApproved!==false)throw new SingularityFlowError('The article context returned another submitted publication or a false authority claim.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'constitution.exception.context',subject:bound.subject,manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});}
function planCorrectionContextInput(value,operation){const input=data(value);if(!input||typeof input!=='object'||Array.isArray(input)
  ||Object.keys(input).some(key=>!operation.inputFields.includes(key))||!Array.isArray(input.operations)||!input.operations.length||input.operations.length>20
  ||input.operations.some(row=>!row||typeof row!=='object'||Array.isArray(row))||typeof input.reason!=='string'
  ||['workId','ownerPhase','upstreamIssue'].some(key=>input[key]!=null&&typeof input[key]!=='string'))throw new SingularityFlowError(
  'Name a bounded correction and its review reason.',{code:'ENGINE_INPUT_INVALID'});return input;}
async function inspectTestRiskContext(port,input,signal){
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  const binding=data({subject:context?.subject,workId:context?.workflow?.workItem?.id,phase:context?.phase?.id}),facts=data(await port.read(context,{signal}));notCancelled(signal);
  let profile;try{profile=namespaceTestRiskRecordProfile('context',facts);}catch{ /* Another wire is refused. */ }
  if(!profile||facts.profile!==profile.profile||binding.subject?.kind!=='story'||binding.subject.id!==binding.workId
    ||input.workId!=null&&input.workId!==binding.workId||input.phaseId!=null&&input.phaseId!==binding.phase
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||typeof facts.revision!=='string'||!facts.revision
    ||facts.testsPassed!==false||facts.executionObserved!==false||!Array.isArray(facts.commands)||facts.commands.length>1024
    ||facts.commands.some(row=>!row.command?.id||!Array.isArray(row.command.argv)||!/^[a-f0-9]{64}$/u.test(row.argvSha256??'')
      ||!/^sha256:[a-f0-9]{64}$/u.test(row.commandSha256??''))||!Array.isArray(facts.decisions)||!Array.isArray(facts.authorities)||!Array.isArray(facts.environmentCauses))
    throw new SingularityFlowError('The risk context returned another Story, command or execution claim.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'test-risk.context',subject:binding.subject,manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});
}

async function inspectTestWitnessContext(port,input,signal){
  notCancelled(signal);const context=await port.load(input,{signal}),binding=data({subject:context?.subject,workId:context?.workflow?.workItem?.id,phase:context?.phase?.id}),
    facts=data(await port.read(context,{signal}));notCancelled(signal);
  let profile;try{profile=namespaceWitnessMappingProfile('context',facts);}catch{ /* Never reinterpret another context version. */ }
  if(!profile||binding.subject?.kind!=='story'||binding.subject.id!==binding.workId||facts.profile!==profile.profile
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||input.workId!=null&&input.workId!==binding.workId||input.phaseId!=null&&input.phaseId!==binding.phase
    ||!/^sha256:[a-f0-9]{64}$/u.test(facts.contextSha256??'')||!Array.isArray(facts.mappings)||facts.mappings.length>1000||facts.approvalRecorded!==false)
    throw new SingularityFlowError('The witness context returned another Story or an approval claim.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'test-witness.context',subject:binding.subject,manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});
}

async function inspectEvidenceReuseContext(port,input,signal){
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  const binding=data({subject:context?.subject,workId:context?.workflow?.workItem?.id,phase:context?.phase?.id}),
    facts=data(await port.read(context,{signal}));notCancelled(signal);
  let profile;try{profile=namespaceEvidenceReuseRecordProfile('context',facts);}catch{ /* Reject another transport/schema at the port boundary. */ }
  if(!profile||binding.subject?.kind!=='story'||binding.subject.id!==binding.workId||input.workId!=null&&input.workId!==binding.workId
    ||input.phaseId!=null&&input.phaseId!==binding.phase||facts.profile!==profile.profile
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||typeof facts.revision!=='string'||!facts.revision
    ||facts.testsExecutedByReceiver!==false||!Array.isArray(facts.candidates)||facts.candidates.length>1024||!Array.isArray(facts.decisions)
    ||!Array.isArray(facts.authorities)||!Array.isArray(facts.actions)||facts.candidates.some(row=>typeof row.taskId!=='string'||!row.taskId
      ||!row.publication?.record||!row.submission?.record||!row.checks?.result||!row.command?.id||typeof row.sourceMatches!=='boolean')
    ||facts.actions.some(row=>row.operation!=='decision.evidence-reuse'||row.inputs?.workId!==binding.workId||row.inputs?.phaseId!==binding.phase
      ||!facts.candidates.some(candidate=>candidate.sourceMatches&&candidate.taskId===row.inputs.attemptId)))throw new SingularityFlowError(
      'The reuse context returned another Story, task or execution claim.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'evidence-reuse.context',subject:binding.subject,manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});
}
async function inspectTestRecoveryContext(port,input,signal){
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  const binding=data({subject:context?.subject,workId:context?.workflow?.workItem?.id,phase:context?.phase?.id}),
    facts=data(await port.read(context,{signal}));notCancelled(signal);
  namespaceTestRecoveryRecordProfile('context',facts);
  if(binding.subject?.kind!=='story'||binding.subject.id!==binding.workId||input.workId!=null&&input.workId!==binding.workId
    ||input.phaseId!=null&&input.phaseId!==binding.phase||facts.profile!=='sflow-namespace-test-recovery-review/v1'
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||typeof facts.revision!=='string'||!facts.revision
    ||!/^sha256:[a-f0-9]{64}$/u.test(facts.expectedContext??'')||facts.agreement?.workId!==binding.workId
    ||facts.agreement.executionMode!=='all-configured'||facts.agreement.reuse!=='never'||!Array.isArray(facts.authorities)||!Array.isArray(facts.actions))
    throw new SingularityFlowError('The recovery context returned another Story, phase or command agreement.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'test-recovery.context',subject:binding.subject,manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});
}
async function inspectTestCommandContext(port,input,signal){
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  const binding=data({subject:context?.subject??null,workId:context?.workflow?.workItem?.id??null,phase:context?.phase?.id??null,declaredPhase:context?.workflow?.phases?.[context?.phase?.id]?.id??null});
  if(binding.subject?.kind!=='story'||typeof binding.workId!=='string'||binding.subject.id!==binding.workId||typeof binding.phase!=='string'||binding.declaredPhase!==binding.phase
    ||input.workId!=null&&input.workId!==binding.workId||input.phaseId!=null&&input.phaseId!==binding.phase)throw new SingularityFlowError(
      'The command context did not bind the requested Story and phase.',{code:'ENGINE_PORT_RESULT_INVALID'});
  const facts=data(await port.read(context,{signal}));notCancelled(signal);
  let profile;try{profile=namespaceStoryCommandRecordProfile('context',facts);}catch{ /* Reject another transport/profile. */ }
  const fields=['schemaVersion','format','workId','phase','revision','commands','requests','authorities'];
  if(!facts||!profile||Object.keys(facts).length!==fields.length||!fields.every(key=>Object.hasOwn(facts,key))
    ||facts.format!==profile.format||facts.workId!==binding.workId||facts.phase!==binding.phase
    ||typeof facts.revision!=='string'||!facts.revision||facts.revision.length>2048||!Array.isArray(facts.commands)||!Array.isArray(facts.requests)||!Array.isArray(facts.authorities)
    ||facts.commands.some(row=>!row||!row.command?.id||!/^sha256:[a-f0-9]{64}$/u.test(row.sha256??''))
    ||facts.requests.some(row=>!row||!/^TCD-\d{3,}$/u.test(row.id??'')||row.id!==row.request?.id||!['requested','accepted','revoked'].includes(row.state)||row.request?.phase!==binding.phase
      ||row.state!==(row.revoked?'revoked':row.accepted?'accepted':'requested')||row.accepted&&row.accepted.accepts!==row.id||row.revoked&&row.revoked.revokes!==row.id)
    ||facts.authorities.some(row=>typeof row!=='string'||!row))throw new SingularityFlowError('The command context has another Story, phase or exact command.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'test-command.context',subject:binding.subject,manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});
}
async function inspectPlanCorrectionContext(port,input,signal){notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  const current=context.workflow?.phases?.[context.workflow.currentPhase],
    bound=data({subject:context.subject,phase:context.workflow?.currentPhase,inspectionGeneration:current?phaseInspectionGeneration(context.workflow,current):null,
      phases:Object.fromEntries(Object.entries(context.workflow?.phases??{}).map(([id,row])=>[id,{generation:row.generation,status:row.status}]))});
  const facts=data(await port.read(context,{signal}));notCancelled(signal);let profile=null;
  try{profile=namespacePlanCorrectionRecordProfile('context',facts);}catch{ /* Reject another wire contract as a port result. */ }
  const fields=['schemaVersion','format','workId','phase','revision','request','preview','recording','owner','authorities'],preview=facts?.preview,owner=facts?.owner;
  if(!facts||!profile||facts.format!==profile.format||Object.keys(facts).length!==fields.length||!fields.every(key=>Object.hasOwn(facts,key))
    ||bound.subject?.kind!=='story'||facts.workId!==bound.subject.id||input.workId!=null&&facts.workId!==input.workId||facts.phase!==bound.phase
    ||typeof facts.revision!=='string'||!equalJson(facts.request,standaloneDecisionRequest('plan.correction.context',input))
    ||!owner||!bound.phases[owner.phase]||owner.generation!==bound.phases[owner.phase].generation||owner.generation<1||bound.phases[owner.phase].status!=='approved'
    ||input.ownerPhase!=null&&owner.phase!==input.ownerPhase
    ||preview?.ownerPhase!==owner.phase||preview.ownerGeneration!==owner.generation||preview.ownerMapSha256!==owner.mapSha256
    ||!/^[a-f0-9]{64}$/u.test(preview.previewSha256??'')||!Array.isArray(preview.operations)||preview.operations.length!==input.operations.length
    ||preview.reason!==input.reason.trim()||preview.upstreamIssue!==(input.upstreamIssue??null)
    ||preview.operations.some((row,index)=>row.op!==input.operations[index].op||row.clauseId!==String(input.operations[index].clauseId??'').toUpperCase())
    ||preview.operations.some((row,index)=>row.op==='reclassify-evidence'&&(row.path!==input.operations[index].path||row.method!==input.operations[index].method
      ||row.delivery?.phase!==bound.phase||row.delivery?.generation!==bound.inspectionGeneration
      ||!equalJson(row.content,input.operations[index].content)||preview.after?.[row.clauseId]?.fulfillment!=='evidence'
      ||!equalJson(preview.after[row.clauseId].expectedPaths,[row.path])||!equalJson(preview.after[row.clauseId].tests,preview.before?.[row.clauseId]?.tests)))
    ||!['requires-human-review','owner-required'].includes(facts.recording?.status)||!Array.isArray(facts.recording?.requiredOwners)||!Array.isArray(facts.recording?.affectedPhases)
    ||facts.recording.status!==(facts.recording.requiredOwners.length?'owner-required':'requires-human-review')
    ||facts.recording.requiredOwners.some(value=>typeof value!=='string'||!value)||facts.recording.affectedPhases.some(value=>!bound.phases[value])
    ||!Array.isArray(facts.authorities)||!facts.authorities.length||facts.authorities.some(value=>typeof value!=='string'||!value))throw new SingularityFlowError(
      'The correction context has another approved plan or request.',{code:'ENGINE_PORT_RESULT_INVALID'});
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'plan.correction.context',subject:bound.subject,manifest:facts,
    effects:{committed:false,pushed:false,approvalRecorded:false,storyAdvanced:false}});}

function storyDocumentInput(value,operation) {
  const input=data(value);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!operation.inputFields.includes(key))
    ||operation.requiredFields.some(key=>!Object.hasOwn(input,key))||typeof input.operationId!=='string'||!input.operationId
    ||typeof input.workId!=='string'||!input.workId)invalid('Use an exact input-document operation, Story and document identity.');
  storyDocumentRequest(operation.id,input);return input;
}
async function recordStoryDocument(port,inputs,signal,operation) {
  let pendingStage='load',committed=null;const completedStages=[];
  try {
    notCancelled(signal);const context=await port.load(inputs,{signal,operation});completedStages.push('load');notCancelled(signal);
    if(context?.subject?.kind!=='story'||context.subject.id!==inputs.workId||context.workflow?.workItem?.id!==inputs.workId)throw new SingularityFlowError(
      'The document owner returned another Story.',{code:'ENGINE_PORT_RESULT_INVALID'});
    pendingStage='prepare';const intent=await port.prepare(context,inputs,{signal,operation});completedStages.push('prepare');notCancelled(signal);
    pendingStage='commit';committed=await port.commit(context,intent,{signal,operation});completedStages.push('commit');pendingStage='finish';
    const result=data(await port.finish(context,intent,committed,{operation}));completedStages.push('finish');
    if(!result||Object.keys(result).length!==5||result.workId!==inputs.workId||result.document?.id!==inputs.documentId
      ||result.document.kind!=='input-document'||result.document.locality!=='machine-local'||result.document.content?.namespace!=='local'
      ||result.document.status!==(operation.id.endsWith('attach')?'active':'detached')||typeof result.revision!=='string'||!result.revision
      ||result.currentPhase!==context.workflow.currentPhase||result.pushed!==false)throw new SingularityFlowError(
        'The document mutation returned another local-input binding.',{code:'ENGINE_PORT_RESULT_INVALID'});
    return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,status:'recorded',subject:{kind:'story',id:inputs.workId},...result,
      effects:{committed:true,pushed:false,uploadedContent:false,applicationChanged:false,approvalRecorded:false,storyAdvanced:false}});
  }catch(error){
    attachDiagnostic(error,'engineStoryDocument',{operation:operation.id,operationId:inputs.operationId,workId:inputs.workId,documentId:inputs.documentId,
      completedStages,pendingStage,accepted:committed,metadataMayBeAccepted:completedStages.includes('commit')||pendingStage==='commit',
      uploadedContent:false,applicationChanged:false,approvalRecorded:false,storyAdvanced:false});throw error;
  }
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
    attachDiagnostic(error,'enginePublication',committed,{raw:true});
    throw error;
  }
}

function attachDiagnostic(error,key,value,{raw=false}={}) {
  try{if(error&&typeof error==='object'&&Object.isExtensible(error))error[key]=raw?value:data(value);}
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
function contextReadInput(value){return phaseContextReadInput(data(value));}
async function readPhaseContext(port,input,signal) {
  notCancelled(signal);const context=await port.load(input,{signal});notCancelled(signal);
  if(context?.subject?.kind!=='story'||context.subject.id!==input.workId||context.phase!==input.phaseId)throw new SingularityFlowError(
    'The context reader returned another Story or phase.',{code:'ENGINE_PORT_RESULT_INVALID'});
  const facts=data(await port.read(context,input,{signal}));notCancelled(signal);
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.context.read',...phaseContextReadResult(input,facts)});
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
      const protocol=phaseEntryProtocol(context);
      binding=data(protocol.selection(context,inputs));
      if(!binding.ready) {
        admission=data(phaseCompositionAdmission({ready:false}));plan={...plan,status:'binding-required'};
      } else {
        pendingStage='inspect';
        const inspected=await port.inspect(context,binding,{signal});completedStages.push('inspect');notCancelled(signal);
        inspection=data(protocol.inspection(binding,copy(inspected)));admission=inspection.admission;
        if(compose&&admission.allowed) {
          pendingStage='compose';
          const facts=await port.compose(context,binding,{signal});completedStages.push('compose');notCancelled(signal);
          composition=data(protocol.composition(binding,copy(facts)));
        }
        pendingStage='clarify';
        const facts=await port.clarify(context,binding,{signal});completedStages.push('clarify');notCancelled(signal);
        clarification=data(protocol.clarification(binding,copy(facts)));
        plan=data(protocol.plan(binding,inspection,composition,clarification,{compose}));
      }
      pendingStage='finish';
      const facts=await port.finish(context,binding,{admission,plan},{signal});completedStages.push('finish');notCancelled(signal);
      finished=copy(facts);manifest=data(protocol.manifest(binding,inspection,composition,clarification,plan,finished));
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

async function inspectPhaseReviewResources(port,inputs,signal) {
  notCancelled(signal);const context=await port.load(inputs,{signal});notCancelled(signal);
  if(context?.subject?.kind!=='story'||typeof context.subject.id!=='string'||!context.subject.id||context.subject.id!==context.workflow?.workItem?.id)throw new SingularityFlowError(
    'The review resources port did not bind a Story.',{code:'ENGINE_PORT_RESULT_INVALID'});
  if(inputs.workId!=null&&inputs.workId!==context.subject.id)throw new SingularityFlowError(
    'The requested Story does not match the retained review.',{code:'ACTIVE_SUBJECT_MISMATCH'});
  const binding=data(phaseReviewSelection(context.workflow,inputs.phaseId));
  const observed=await port.read(context,binding,{signal});notCancelled(signal);let facts;
  try{facts=data(observed);}catch(cause){throw new SingularityFlowError('The review resources port returned non-JSON facts.',{code:'ENGINE_PORT_RESULT_INVALID',cause});}
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.review.resources',status:'inspected',subject:{kind:'story',id:binding.workId},
    phase:binding.phase,generation:binding.generation,revision:facts.revision,
    effects:{committed:false,pushed:false,humanReviewRecorded:false,approvalRecorded:false},manifest:phaseReviewResourcesManifest(binding,facts)});
}

async function inspectDecisionContext(port,inputs,signal) {
  notCancelled(signal);const context=await port.load(inputs,{signal});notCancelled(signal);
  if(context?.subject?.kind!=='story'||typeof context.subject.id!=='string'||!context.subject.id||context.subject.id!==context.workflow?.workItem?.id)throw new SingularityFlowError(
    'The decision context port did not bind a Story.',{code:'ENGINE_PORT_RESULT_INVALID'});
  if(inputs.workId!=null&&inputs.workId!==context.subject.id)throw new SingularityFlowError('The requested Story does not match this question.',{code:'ACTIVE_SUBJECT_MISMATCH'});
  const binding=data(decisionContextSelection(context.workflow)),observed=await port.read(context,binding,{signal});notCancelled(signal);let facts;
  try{facts=data(observed);}catch(cause){throw new SingularityFlowError('The decision context port returned non-JSON facts.',{code:'ENGINE_PORT_RESULT_INVALID',cause});}
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'decision.context',status:'inspected',subject:{kind:'story',id:binding.workId},
    phase:binding.phase,revision:facts.revision,effects:{committed:false,pushed:false,humanDecisionRecorded:false},
    manifest:decisionContextManifest(binding,facts)});
}

async function inspectDecisionList(port,inputs,signal){
  notCancelled(signal);const context=await port.load(inputs,{signal});notCancelled(signal);
  if(context?.subject?.kind!=='story'||!context.subject.id||context.subject.id!==context.workflow?.workItem?.id)throw new SingularityFlowError(
    'The decision-list port did not bind a Story.',{code:'ENGINE_PORT_RESULT_INVALID'});
  if(inputs.workId!=null&&inputs.workId!==context.subject.id)throw new SingularityFlowError('Use the bound Story.',{code:'ACTIVE_SUBJECT_MISMATCH'});
  const binding={workId:context.subject.id,phase:inputs.phaseId??context.workflow.currentPhase??null},
    observed=await port.read(context,{...binding},{signal});notCancelled(signal);
  const manifest=decisionListManifest(binding,data(observed));
  for(const action of manifest.actions){const target=ENGINE_OPERATIONS.find(row=>row.id===action.operation);
    if(!target||Object.keys(action.inputs).some(key=>!target.inputFields.includes(key))||action.requiredInputs?.some(key=>!target.inputFields.includes(key)))throw new SingularityFlowError(
      'The decision list action is outside the registered vocabulary.',{code:'ENGINE_PORT_RESULT_INVALID'});}
  return data({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'decisions.list',status:'inspected',subject:{kind:'story',id:binding.workId},
    phase:binding.phase,revision:manifest.revision,effects:{committed:false,pushed:false,humanDecisionRecorded:false},manifest});
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
  for(const key of ['workId','phaseId','selectionReceipt','agent','evidenceReason','witnessReviewContext']) {
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
  if(!requestOnly&&!intent&&(operation.requiredFields??[]).some(key=>!Object.hasOwn(input,key)||input[key]==null))invalid('Supply every required field for this standalone operation.');
  for (const [key,value] of Object.entries(input)) {
    if (value==null) continue;
    if (['fetch','notApplicable','open','fromArtifact'].includes(key)) {if(typeof value!=='boolean')invalid(`Decision ${key} must be a boolean.`);}
    else if (['clauseIds','transitions','sourceRoots'].includes(key)) {
      if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))invalid(`Decision ${key} must be an array of strings.`);
    } else if (key==='checklist') {
      if(!Array.isArray(value))invalid('Decision checklist must be an array.');
    } else if (['changes','operations'].includes(key)) {
      if(!Array.isArray(value)||value.some(item=>!item||typeof item!=='object'||Array.isArray(item)))invalid(`Decision ${key} must be an array of JSON records.`);
    } else if (key==='content'&&operation.id==='forward-amendment.propose') {
      if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='bytes,namespace,sha256'
        ||typeof value.namespace!=='string'||!/^[a-f0-9]{64}$/u.test(value.sha256??'')||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>4_194_304)
        invalid('The amendment content requires an exact bounded content reference.');
    } else if (['command','repin','answers','report'].includes(key)) {
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
    attachDiagnostic(error,'enginePublication',committed,{raw:true});
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
    attachDiagnostic(error,'enginePublication',committed,{raw:true});
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
    attachDiagnostic(error,'enginePublication',committed,{raw:true});
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
    attachDiagnostic(error,'engineDecisionEffects',outcome,{raw:true});
    throw error;
  }
}

function singleDecisionResult(binding, facts, operation) {
  let result;
  try {result=data(facts);}
  catch(cause) {throw new SingularityFlowError('The decision writer returned non-JSON facts.',{code:'ENGINE_PORT_RESULT_INVALID',cause});}
  let namespaceRisk=false;
  if(operation.id==='decision.risk'&&result?.profile==='sflow-namespace-obligation-risk-outcome/v1'){
    try{namespaceRisk=result.record?.profile===namespaceObligationRiskRecordProfile(result.record).profile;}catch{ /* Refuse another port wire below. */ }
  }
  const namespaceRenewal=operation.id==='decision.witness-exception'&&result?.profile==='sflow-namespace-witness-renewal-outcome/v1',namespaceAcknowledgement=namespaceRisk||namespaceRenewal;
  const canAcknowledge=operation.allowRetained===true||namespaceAcknowledgement;
  const fields=['workId','phase','recordKind','record','revision','pushed','actorId','authorityGroup','currentPhase',
    ...(namespaceAcknowledgement?['profile']:[]),...(canAcknowledge?['retained']:[])];
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
  const retained=canAcknowledge&&result?.retained===true;
  if(!result || Object.keys(result).some(key=>!fields.includes(key))
    || result.workId!==binding.workId || result.phase!==binding.phase || result.recordKind!==operation.recordKind
    || !result.record || typeof result.record!=='object' || Array.isArray(result.record)
    || ['resolved-target','requested-target'].includes(operation.phaseBinding)&&result.record.phase!==binding.phase
    || (retained?result.revision!==null:!text(result.revision)) || typeof result.pushed!=='boolean'
    || retained&&result.pushed || canAcknowledge&&typeof result.retained!=='boolean'
    || !text(result.actorId) || (operation.authority==='requester' ? result.authorityGroup!==null : !text(result.authorityGroup))
    || result.currentPhase!==null && !text(result.currentPhase)
    || operation.phaseBinding==='resolved-target'&&result.currentPhase!==binding.currentPhase
    || operation.keepsCurrentPhase&&result.currentPhase!==(Object.hasOwn(binding,'currentPhase')?binding.currentPhase:binding.phase)) {
    throw new SingularityFlowError('The decision writer returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  return Object.freeze({schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,status:retained?'retained':'recorded',
    ...(namespaceAcknowledgement?{profile:result.profile}:{}),
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
    attachDiagnostic(error,'enginePublication',committed,{raw:true});
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
    attachDiagnostic(error,'engineUpstreamEffects',{operation:id,workId:binding.workId,accepted,pending,remaining:plan.requests.slice(index)},{raw:true});
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
    attachDiagnostic(error,'enginePublication',committed,{raw:true});
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
    if(review)attachDiagnostic(error,'engineAdvancement',Object.freeze({operation:operation.id,review,submission}),{raw:true});
    throw error;
  }
}

function createEngineRuntime({ ports } = {}, implementations) {
  if (!ports || typeof ports !== 'object') invalid('Engine construction requires explicit trusted ports.');
  const bound = new Map(),selections=new Map();
  for (const name of new Set(ENGINE_OPERATIONS.map(operation => operation.port))) {
    const supplied = ports[name];
    if (supplied === undefined) continue;
    const stages=ENGINE_OPERATIONS.find(operation=>operation.port===name).stages;
    if (!supplied || stages.some(stage => typeof supplied[stage] !== 'function')) {
      invalid(`The ${name} port must implement every declared operation stage.`);
    }
    if(supplied.operations!==undefined){const selected=data(supplied.operations);
      if(!Array.isArray(selected)||!selected.length||selected.length>ENGINE_OPERATIONS.length||new Set(selected).size!==selected.length
        ||selected.some(id=>typeof id!=='string'||registry.get(id)?.port!==name))invalid('A host operation selection must name distinct operations from its own port.');
      selections.set(name,new Set(selected));}
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
    if (!implementations[definition.validate] || !implementations[definition.execute]) throw new SingularityFlowError(
      'No port implements this engine operation in the current host.', { code:'ENGINE_PORT_UNAVAILABLE',details:{operation,port:definition.port} });
    const input = implementations[definition.validate](inputs, definition);
    const port = bound.get(definition.port);
    if (!port||selections.has(definition.port)&&!selections.get(definition.port).has(operation)) throw new SingularityFlowError('No port implements this engine operation in the current host.', {
      code:'ENGINE_PORT_UNAVAILABLE',details:{operation,port:definition.port,...(port?{required:[operation]}:{})}
    });
    return invoke(() => implementations[definition.execute](port, input, signal, definition, {executeOperation:execute}));
  };
  let capabilities;
  const wired=row=>{const definition=registry.get(row.id);return bound.has(row.port)&&implementations[definition.validate]&&implementations[definition.execute]
    &&(!selections.has(row.port)||selections.get(row.port).has(row.id));};
  const inspectCapabilities=()=>capabilities??=Object.freeze({schemaVersion:1,profile:'sflow-engine-host-capabilities/v1',contract:ENGINE_CONTRACT,
    boundOperations:Object.freeze(ENGINE_OPERATIONS.filter(wired).map(row=>Object.freeze({id:row.id,port:row.port}))),
    unboundOperations:Object.freeze(ENGINE_OPERATIONS.filter(row=>!wired(row)).map(row=>Object.freeze({id:row.id,port:row.port}))),
    authorityGranted:false,readinessEstablished:false});
  return Object.freeze({ contract: ENGINE_CONTRACT, operations: ENGINE_OPERATIONS, get capabilities(){return inspectCapabilities();},run: execute,
    ...Object.fromEntries(Object.entries(ENGINE_HELPERS).map(([helper, operation]) =>
      [helper, { [helper]: (inputs, options) => execute(operation, inputs, options) }[helper]])) });
}

/** Default SDK composition binds every coordinator to the one data-only registry. */
export function createEngine(options = {}) {
  return createEngineRuntime(options, {
    enrollmentInput, enrollProject, configurationApprovalInput, approveConfiguration,storyCreationInput,createStory,
    clarificationInput,inspectClarification,recordClarification,
    inspectTestRiskContext,inspectTestWitnessContext,inspectEvidenceReuseContext,inspectTestRecoveryContext,inspectTestCommandContext,inspectSourceReviewContext,inspectConvergenceContext,witnessContextInput,inspectWitnessContext,planCorrectionContextInput,inspectPlanCorrectionContext,constitutionExceptionContextInput,inspectConstitutionExceptionContext,sourceBindingInput,bindSources,phaseRepairInput,runPhaseRepair,phaseChecksInput,runPhaseChecks,sourceInspectionInput,deliveryInspectionInput,inspectPhaseSources,sourceRetentionInput,outputRetentionInput,baselineRetentionInput,retainPhaseSources,
    draftReadInput,draftMutationInput,readPhaseDraft,mutatePhaseDraft,
    advanceConvergence, approvalInput, approve, beginPhase, correctPlan, decisionInput,
    documentReadInput, contextReadInput,readPhaseContext,enterPhase, inspectPhaseCheck, inspectPhaseReview, inspectPhaseReviewResources, inspectDecisionContext, inspectDecisionList, inspectStoryGuide, inspectStoryNext,
    inspectStoryStatus, inspectStoryEvidence, inspectWorkflowAssets, phaseBeginInput, phaseEntryInput, phaseInputsInput, phaseReviewInput,
    preparePhase, preparePhaseInputs, publicationInput, publish, readDocument, recordDecisions,
    recordSingleDecision, recordStoryDocument, storyDocumentInput, inspectConformanceContext, inspectScopeContext, reject, rejectionInput, rolloverPhase, singleDecisionInput, storyGuideInput,
    storyStatusInput, submissionInput, submit, upstreamOperation, workflowAssetsInput
  });
}

/** Private narrow host composition; shares the registry, dispatcher and exact coordinator. */
export function createStoryNextEngine(options = {}) {
  return createEngineRuntime(options, { storyGuideInput, inspectStoryNext });
}
