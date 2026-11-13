import {createNamespaceSourceReviewPorts} from './namespace-source-review.mjs';
import {createNamespaceConvergencePorts} from './namespace-convergence.mjs';
import {createNamespaceConvergenceAdvancementPort} from './namespace-convergence-advancement.mjs';
import {createNamespaceEvidencePort} from './namespace-evidence.mjs';
/** One explicit headless composition. Operations still enter the SDK registry exactly once. */
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {validateSourceUnit,validateSourceContentReader} from '../foundation/source-snapshot.mjs';
import {validateSourceControlReader} from '../foundation/source-control.mjs';
import {validateNamespaceStore,NAMESPACE_STORE_METHODS} from '../sda/namespace/contract.mjs';
import {namespaceScope,namespaceIdentifier,exactObject} from '../sda/namespace/values.mjs';
import {validateContentStore,CONTENT_STORE_METHODS} from '../sda/content/contract.mjs';
import {createNamespaceReadPorts} from './namespace-reader.mjs';
import {createNamespaceProjectPorts} from './namespace-project.mjs';
import {createNamespaceConfigurationPorts} from './namespace-configuration.mjs';
import {createNamespaceStoryPorts} from './namespace-story.mjs';
import {createNamespaceSourceBindingPort} from './namespace-source.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespacePublicationPort} from './namespace-publication.mjs';
import {createNamespaceSubmissionPorts} from './namespace-submission.mjs';
import {createNamespaceApprovalPorts} from './namespace-approval.mjs';
import {createNamespaceRejectionPorts} from './namespace-rejection.mjs';
import {createNamespaceConformanceDecisionPorts} from './namespace-conformance-decisions.mjs';
import {createNamespaceReadSession} from './namespace-read-session.mjs';
import {createNamespaceScopeDecisionPorts,NAMESPACE_SCOPE_DECISION_OPERATIONS} from './namespace-scope-decisions.mjs';
import {createNamespacePlanDecisionPorts} from './namespace-plan-decisions.mjs';
import {createNamespaceUpstreamPort} from './namespace-upstream.mjs';
import {createNamespaceInputDocumentPort} from './namespace-input-documents.mjs';
import {createNamespaceRoutingChoicePorts} from './namespace-routing-choice.mjs';
import {createNamespacePhaseChecksPort} from './namespace-phase-checks.mjs';
import {createNamespaceSourceInspectionPort} from './namespace-source-inspection.mjs';
import {createNamespaceSourceRetentionPort} from './namespace-source-retention.mjs';
import {createNamespaceOutputRetentionPort} from './namespace-output-retention.mjs';
import {createNamespaceSourceBaselinePort} from './namespace-source-baseline.mjs';
import {createNamespaceDeliveryInspectionPort} from './namespace-delivery-inspection.mjs';
import {createNamespaceTestWitnessInspectionPort} from './namespace-test-witnesses.mjs';
import {createNamespaceSourceControlPort} from './namespace-source-control.mjs';
import {createNamespaceClarificationPorts} from './namespace-clarifications.mjs';
import {createNamespacePhaseEntryPorts} from './namespace-phase-entry.mjs';
import {createNamespacePhaseInspectionPorts} from './namespace-phase-inspection.mjs';
import {createNamespaceStoryQueryPorts} from './namespace-story-queries.mjs';
import {createNamespaceWorkflowAssetsPort} from './namespace-workflow-assets.mjs';
import {createNamespaceWitnessPorts} from './namespace-witness-decisions.mjs';
import {createNamespaceWitnessRenewalPorts} from './namespace-witness-renewals.mjs';
import {createNamespaceTestCommandPorts} from './namespace-test-commands.mjs';
import {createNamespaceEvidenceReusePorts} from './namespace-evidence-reuse.mjs';
import {createNamespaceTestRiskPorts} from './namespace-test-risks.mjs';
import {createNamespaceObligationRiskPort} from './namespace-obligation-risks.mjs';
import {createNamespaceTestRecoveryPorts} from './namespace-test-recovery.mjs';
import {createNamespaceTestRepairPort} from './namespace-test-repair.mjs';
import {createNamespaceDecisionListPorts} from './namespace-decision-list.mjs';
import {createNamespaceDecisionBatchPort} from './namespace-decision-batch.mjs';
import {createNamespaceAssignmentPort} from './namespace-assignment.mjs';
import {createNamespaceConstitutionExceptionPorts} from './namespace-constitution-exceptions.mjs';
import {bindNamespaceReadBatch} from '../sda/namespace/read-batch.mjs';
const invalid=message=>{throw new SingularityFlowError(message,{code:'ENGINE_INPUT_INVALID'});};
function captured(port,validate,methods) {
  validate(port);
  const result=Object.freeze({descriptor:structuredClone(port.descriptor),...Object.fromEntries(methods.map(name=>[name,port[name].bind(port)]))});
  return methods===NAMESPACE_STORE_METHODS?bindNamespaceReadBatch(port,result):result;
}
/** Unused operation families do not construct additional readers or conditional writers. */
function lazyPorts(factory,contracts){
  let owned;
  return Object.fromEntries(Object.entries(contracts).map(([name,stages])=>[name,Object.fromEntries(stages.map(stage=>
    [stage,(...parameters)=>{owned??=factory();return owned[name][stage](...parameters);}]))]));
}

export function createNamespaceEngine(options={}) {
  const fields=['records','content','scope','workId','authority','access','clock','working','localContent','sources','modelEnabled','notice','checks','repairs','sourceReaders','sourceControlReaders'];
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!fields.includes(key)))invalid('Use explicit namespace Engine bindings and capabilities.');
  options=Object.fromEntries(fields.map(key=>[key,options[key]]));
  const scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId,'Story ID');
  exactObject(options.authority,['id','epoch']);
  const authority=Object.freeze({id:namespaceIdentifier(options.authority.id,'Authority ID'),epoch:options.authority.epoch});
  if(!Number.isSafeInteger(authority.epoch)||authority.epoch<1||typeof options.access?.current!=='function'
    ||typeof options.clock?.now!=='function'||options.modelEnabled!==undefined&&typeof options.modelEnabled!=='boolean'
    ||options.notice!==undefined&&typeof options.notice!=='function')invalid('An Engine needs an explicit authority, access, clock and optional execution capabilities.');
  const readSession=createNamespaceReadSession({records:captured(options.records,validateNamespaceStore,NAMESPACE_STORE_METHODS),
    content:captured(options.content,validateContentStore,CONTENT_STORE_METHODS)}),{records,content}=readSession;
  const access=Object.freeze({current:options.access.current.bind(options.access)}),clock=Object.freeze({now:options.clock.now.bind(options.clock)});
  let working=null;
  if(options.working!=null) {
    exactObject(options.working,['records','content']);
    working={records:captured(options.working.records,validateNamespaceStore,NAMESPACE_STORE_METHODS),
      content:captured(options.working.content,validateContentStore,CONTENT_STORE_METHODS)};
  }
  const localContent=options.localContent==null?working?.content??null:captured(options.localContent,validateContentStore,CONTENT_STORE_METHODS);
  if(!Array.isArray(options.sources??[])||(options.sources??[]).length>32)invalid('Source units must be an explicit bounded list.');
  const sources=Object.freeze((options.sources??[]).map(unit=>{
    const descriptor=structuredClone(validateSourceUnit(unit));
    return Object.freeze({descriptor,capture:unit.capture.bind(unit)});
  }));
  if(!Array.isArray(options.sourceReaders??[])||(options.sourceReaders??[]).length>32)invalid('Source content readers must be an explicit bounded list.');
  const sourceReaders=Object.freeze((options.sourceReaders??[]).map(reader=>Object.freeze({descriptor:validateSourceContentReader(reader),read:reader.read.bind(reader)})));
  if(!Array.isArray(options.sourceControlReaders??[])||(options.sourceControlReaders??[]).length>32)invalid('Source-control readers must be an explicit bounded list.');
  const sourceControlReaders=Object.freeze((options.sourceControlReaders??[]).map(reader=>Object.freeze({descriptor:validateSourceControlReader(reader),capture:reader.capture.bind(reader)})));
  const common={records,content,scope,workId,authority,access,clock,localContent,sources,
    modelEnabled:options.modelEnabled??true,notice:options.notice??(()=>{}),checks:options.checks,repairs:options.repairs,sourceReaders,sourceControlReaders};
  const runtime=working?createNamespacePreparationRuntime({...common,inputContent:localContent,localRecords:working.records,localContent:working.content}):null;
  const routing=createNamespaceRoutingChoicePorts(common);let scopeDecisions,planPorts,witnessPorts,assignmentPort,sourceReviewPorts,constitutionExceptionPorts,convergencePorts;
  const convergence=()=>convergencePorts??=createNamespaceConvergencePorts(common,runtime);
  const constitutionExceptions=()=>constitutionExceptionPorts??=createNamespaceConstitutionExceptionPorts(common);
  const sourceReviews=()=>sourceReviewPorts??=createNamespaceSourceReviewPorts(common);
  const witnesses=()=>witnessPorts??=createNamespaceWitnessPorts(common),plans=()=>planPorts??=createNamespacePlanDecisionPorts(common);
  let renewalPorts;const renewals=()=>renewalPorts??=createNamespaceWitnessRenewalPorts(common);
  let commandPorts,reusePorts;const reuse=()=>reusePorts??=createNamespaceEvidenceReusePorts(common);
  let recoveryPorts;const recovery=()=>recoveryPorts??=createNamespaceTestRecoveryPorts(common);
  let obligationRiskPort;
  const decisionOperations=Object.freeze(['decision.witness-exception','decision.risk','test-recovery.confirm','convergence.adjudicate','decision.constitution-exception','phase.assign','source-review.record','source-review.decide','decision.choose','decision.plan','plan.correction.record','decision.witness',...NAMESPACE_SCOPE_DECISION_OPERATIONS]);
  const scoped=()=>scopeDecisions??=createNamespaceScopeDecisionPorts(common,runtime),decisionRecord={operations:decisionOperations,...Object.fromEntries(['load','prepare','commit','finish'].map(stage=>[stage,(...parameters)=>{
    const operation=parameters.at(-1)?.operation?.id;
    if(!decisionOperations.includes(operation))throw new SingularityFlowError(
      'This decision needs its declared namespace evidence and authority owner.',{code:'ENGINE_PORT_UNAVAILABLE',details:{operation,port:'decisionRecord',required:[operation]}});
    const port=operation==='decision.witness-exception'?renewals().decision:operation==='decision.risk'?(obligationRiskPort??=createNamespaceObligationRiskPort(common)):operation==='test-recovery.confirm'?recovery().decision:operation==='convergence.adjudicate'?convergence().decision:operation==='decision.constitution-exception'?constitutionExceptions().decision:operation==='source-review.record'?sourceReviews().record:operation==='source-review.decide'?sourceReviews().decide:operation==='phase.assign'?(assignmentPort??=createNamespaceAssignmentPort(common)):operation==='decision.witness'?witnesses().decision:operation==='decision.plan'?plans().decision:operation==='plan.correction.record'?plans().correctionRecord
      :NAMESPACE_SCOPE_DECISION_OPERATIONS.includes(operation)?scoped().ports.get(operation):routing.decisionRecord;
    return port[stage](...parameters);
  }]))};
  let engine,executeOperation;
  let riskPorts;const risks=()=>riskPorts??=createNamespaceTestRiskPorts(common);
  const ports={...lazyPorts(()=>sourceReviews(),{sourceReviewContext:['load','read']}),...createNamespaceReadPorts(common,{authority}),
    ...lazyPorts(()=>createNamespaceDecisionListPorts(common,runtime),{decisionList:['load','read']}),
    ...lazyPorts(()=>({decisions:createNamespaceDecisionBatchPort(common,runtime,executeOperation)}),{decisions:['load','prepare','apply','finish']}),
    convergenceContext:Object.fromEntries(['load','read'].map(stage=>[stage,(...args)=>convergence().convergenceContext[stage](...args)])),
    ...lazyPorts(()=>({advancement:createNamespaceConvergenceAdvancementPort(common)}),{advancement:['withReview']}),
    constitutionExceptionContext:Object.fromEntries(['load','read'].map(stage=>[stage,(...args)=>constitutionExceptions().context[stage](...args)])),
    planCorrectionContext:Object.fromEntries(['load','read'].map(stage=>[stage,(...args)=>plans().correctionContext[stage](...args)])),
    witnessContext:Object.fromEntries(['load','read'].map(stage=>[stage,(...args)=>witnesses().witnessContext[stage](...args)])),
    ...lazyPorts(()=>createNamespaceStoryQueryPorts(common,runtime),{storyStatus:['load','read'],storyGuide:['load'],storyNext:['load']}),
    testRiskContext:Object.fromEntries(['load','read'].map(stage=>[stage,(...args)=>risks().context[stage](...args)])),
    testWitnessContext:Object.fromEntries(['load','read'].map(stage=>[stage,(...args)=>renewals().context[stage](...args)])),
    evidenceReuseContext:Object.fromEntries(['load','read'].map(stage=>[stage,(...args)=>reuse().context[stage](...args)])),
    testRecoveryContext:Object.fromEntries(['load','read'].map(stage=>[stage,(...args)=>recovery().context[stage](...args)])),
    ...lazyPorts(()=>({workflowAssets:createNamespaceWorkflowAssetsPort(common)}),{workflowAssets:['load','read']}),
    ...lazyPorts(()=>createNamespacePhaseInspectionPorts(common,runtime),{phasePrepublish:['load','inspect'],phaseDraftCheck:['load','inspect']}),
    ...(authority.epoch===1?createNamespaceProjectPorts(common):{}),
    ...createNamespaceConfigurationPorts(common),...createNamespaceStoryPorts(common),
    sourceBinding:createNamespaceSourceBindingPort(common),...(runtime?.ports??{}),...createNamespaceClarificationPorts(common),...createNamespacePhaseEntryPorts(common,runtime),
    phaseSourceInspection:createNamespaceSourceInspectionPort(common,runtime),
    phaseSourceRetention:createNamespaceSourceRetentionPort(common,runtime),
    phaseOutputRetention:createNamespaceOutputRetentionPort(common,runtime),
    phaseSourceControlRetention:createNamespaceSourceControlPort(common,runtime),
    sourceBaselineRetention:createNamespaceSourceBaselinePort(common),
    phaseDeliveryInspection:createNamespaceDeliveryInspectionPort(common,runtime),
    phaseTestWitnessInspection:createNamespaceTestWitnessInspectionPort(common,runtime),
    ...lazyPorts(()=>createNamespaceTestCommandPorts(common),{testCommandContext:['load','read']}),testDecisionRecord:{operations:['decision.test-risk','decision.evidence-reuse','test-command.request','test-command.decide'],...Object.fromEntries(['load','prepare','resolve','commit','finish'].map(stage=>[stage,(...args)=>{const operation=args.at(-1)?.operation?.id;return (operation==='decision.test-risk'?risks().decision:operation==='decision.evidence-reuse'?reuse().decision:(commandPorts??=createNamespaceTestCommandPorts(common)).testDecisionRecord)[stage](...args);}]))},publication:createNamespacePublicationPort(common,runtime),...createNamespaceSubmissionPorts(common),
    ...createNamespaceApprovalPorts(common),...routing,decisionRecord,
    ...lazyPorts(()=>scoped(),{scopeContext:['load','read']}),
    ...Object.fromEntries(Object.entries(lazyPorts(()=>({upstream:createNamespaceUpstreamPort(common,runtime)}),{upstream:['load','resolve','commit','finish']})).map(([name,port])=>[name,{...port,operations:['upstream.list','upstream.raise','upstream.decide','forward-amendment.propose','forward-amendment.decide','forward-amendment.revalidate']}])),
    ...lazyPorts(()=>({storyDocument:createNamespaceInputDocumentPort(common)}),{storyDocument:['load','prepare','commit','finish']}),
    ...lazyPorts(()=>createNamespaceConformanceDecisionPorts(common),{conformanceDecision:['load','prepare','commit','finish'],conformanceContext:['load','read']}),
    ...lazyPorts(()=>createNamespaceRejectionPorts(common),{rejection:['load','prepare','commit','finish']}),
    ...(options.repairs?lazyPorts(()=>({phaseRepair:createNamespaceTestRepairPort(common,runtime,executeOperation)}),{phaseRepair:['load','retained','prepare','execute','commit','finish']}):{}),
    ...(options.checks?{phaseChecks:createNamespacePhaseChecksPort(common,runtime)}:{})};
  engine=createEngine({ports:{...ports,...lazyPorts(()=>({storyEvidence:createNamespaceEvidencePort(common)}),{storyEvidence:['load','read']}),invocation:{run:readSession.run}}});executeOperation=engine.run.bind(engine);return engine;
}
