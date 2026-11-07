/** Native entry composition. Host location/model preferences never enter operation inputs. */
import path from 'node:path';
import {createEngine,ENGINE_OPERATIONS} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseEntryContext} from '../phase-entry-context.mjs';
import {phaseContextAdmissionPresentation} from '../phase-entry-admission.mjs';
import {phaseKernelOwned} from '../code-delivery-policy.mjs';
import {recoveryActionGuidance} from '../recovery-action-guidance.mjs';
import {measureCommandSpan} from '../dx-timing-context.mjs';
import {withoutReadScope} from '../read-scope.mjs';
import {withoutConfigurationReadScope} from '../configuration-read-scope.mjs';
import {nextPhaseGeneration} from '../kernel/phase-policy.mjs';

export function createGitPhaseEntryPort({root=null,cwd=process.cwd(),modelEnabled=true,onContext=()=>{}}={}) {
  let owner;
  const native=()=>owner??=measureCommandSpan('phase-entry.authoring-load',()=>import('./native-phase-entry.mjs'))
    .catch(error=>{owner=undefined;throw error;});
  return {
    async load(inputs) {
      const entry=await measureCommandSpan('phase-entry.binding',()=>phaseEntryContext({cwd,root,
        phaseId:inputs.phaseId??null,workId:inputs.workId??null}));
      const base=entry.packet.paused?entry.packet:{...entry.packet,effects:{contextCompositionRequested:inputs.compose===true,
        testsRun:false,storyAdvanced:false,committed:false,pushed:false},modelInvocations:0};
      const context={entry,base,paused:entry.packet.paused===true};
      if(context.paused)context.result=entry.packet;
      else Object.assign(context,{workflow:entry.workflow,subject:{kind:'story',id:entry.workflow.workItem.id},ready:entry.packet.ready,
        revision:entry.packet.head,inspectionGeneration:entry.packet.inspectionGeneration,generatesCode:entry.packet.generatesCode,
        codeGenerationReady:entry.packet.mutationContract?.codeAuthoringReady===true,deterministic:phaseKernelOwned(entry.phase),
        agentId:entry.session.activeAgent??null});
      onContext(context);return context;
    },
    async inspect(context) {
      const module=await native();
      context.facts=await module.inspectNativePhaseEntry(context.entry,{modelEnabled});
      return module.phaseEntryInspectionFacts(context.entry,context.facts);
    },
    async compose(context,binding) {
      context.composition=await (await native()).composeNativePhaseEntry(context.entry,context.facts);
      const value=context.composition;
      return {workId:binding.workId,phase:binding.phase,generation:value.generation,deliveredSha256:value.deliveredSha256,
        renderedSha256:value.renderedSha256,bytes:Buffer.byteLength(value.text,'utf8'),fileAvailable:Boolean(value.file)};
    },
    async clarify(context,binding) {
      Object.assign(context,await (await native()).clarifyNativePhaseEntry(context.entry,context.base,context.facts));
      const value=context.clarification;
      return {workId:binding.workId,phase:binding.phase,generation:binding.inspectionGeneration,mode:value.mode,
        recordState:value.recordState,errorCount:value.errors.length,
        maxQuestions:value.checkpoint.maxQuestions,recordedQuestions:value.record?.responses?.length??0,
        recordPromptSha256:value.record?.promptSha256??null,staleOnly:value.staleOnly===true,stagingIssued:value.mode!=='off'};
    },
    async finish(context,binding,{admission,plan}) {
      const {entry,base}=context;
      if(!binding.ready)context.result={...base,status:'binding-required',context:null,
        contextAdmission:phaseContextAdmissionPresentation(admission),
        next:[recoveryActionGuidance(entry.session.phaseAgent?.handoff??{
          id:'select-story',safe:true,automatic:false,confirmation:'none',skill:'/sf-session',
          command:`singularity-flow session attach ${entry.workflow.workItem.id} --json`,
          detail:'This session has not selected a Story; attach the one this checkout holds.'})],authoringAllowed:false};
      else {
        const module=await native();
        const result=await module.presentNativePhaseEntry(entry,base,context.facts,{admission,plan,
          context:context.composition??null,clarification:context.clarification,authoringProgress:context.authoringProgress});
        context.result=await module.checkpointNativePhaseEntry(entry,result);
      }
      const task=context.result.taskResume;
      return {workId:binding.workId,phase:binding.phase,generation:binding.inspectionGeneration,
        task:task?{operationId:task.operationId,state:task.state,continuationBudget:task.continuationBudget}:null};
    }
  };
}

/** Workspace selection is a CLI preference; a supplied SDK root remains authoritative. */
export function createGitPhaseEntryEngine({root=null,cwd=process.cwd(),modelEnabled=true}={}) {
  if(root!==null&&(typeof root!=='string'||!path.isAbsolute(root))||typeof cwd!=='string'||!path.isAbsolute(cwd)) {
    throw new SingularityFlowError('Git phase entry requires an explicit absolute checkout or invocation directory.',{code:'ENGINE_INPUT_INVALID'});
  }
  let context;
  const port=createGitPhaseEntryPort({root,cwd,modelEnabled,onContext:value=>{context=value;}});
  const stages=ENGINE_OPERATIONS.find(operation=>operation.port==='phaseEntry').stages;
  const phaseEntry=Object.fromEntries(stages.map(stage=>[stage,(...args)=>port[stage](...args)]));
  const engine=createEngine({ports:{phaseEntry,invocation:{run:callback=>withoutConfigurationReadScope(()=>withoutReadScope(callback))}}});
  return Object.freeze({engine,presentation:()=>context});
}

/** Local authoring boundary, using the installed admission and crash-recovery transaction. */
function generationIntentFacts(context,binding) {
  return {workId:binding.workId,phase:binding.phase,generation:binding.generation,
    intent:{id:context.result.id,sha256:context.result.receiptSha256,
      baselineCommit:context.result.baseline?.commit,status:context.result.status}};
}

export function createGitPhaseBeginPort({root,onContext=()=>{}}) {
  return {
    async load(inputs) {
      const {loadAcceptedStoryExecution}=await import('../accepted-story-execution.mjs');
      const accepted=await loadAcceptedStoryExecution(root,inputs.workId??null);
      const context={root,config:accepted.definition,workflow:accepted.workflow};onContext(context);return context;
    },
    async verify(context,binding) {
      const {verifyOpenGenerationIntent}=await import('../generation-boundary.mjs');
      context.phase=context.workflow.phases[binding.phase];
      await verifyOpenGenerationIntent(root,context.workflow,context.phase);
      context.result=context.phase.generationIntent;context.retained=true;
      return generationIntentFacts(context,binding);
    },
    async begin(context,binding,inputs) {
      const {beginPhaseGeneration,saveStoryDraft}=await import('../state-stores.mjs');
      const {verifyOpenGenerationIntent}=await import('../generation-boundary.mjs');
      const {storyDraftTransaction}=await import('./story-draft-transaction.mjs');
      context.phase=context.workflow.phases[binding.phase];
      context.result=await storyDraftTransaction(root,context.config,context.workflow,`phase-begin:${binding.phase}`,async()=>{
        const opened=await beginPhaseGeneration(root,context.config,context.workflow,{
          phaseId:binding.phase,adoptExisting:inputs.adoptExisting===true,confirm:inputs.confirm??null
        });
        await saveStoryDraft(root,context.config,context.workflow);
        await verifyOpenGenerationIntent(root,context.workflow,context.phase);
        return opened;
      });
      context.retained=false;return generationIntentFacts(context,binding);
    }
  };
}

export function createGitPhaseBeginEngine({root}={}) {
  if(typeof root!=='string'||!path.isAbsolute(root))throw new SingularityFlowError(
    'Git generation entry requires an explicit absolute checkout root.',{code:'ENGINE_INPUT_INVALID'});
  let context;
  const phaseBegin=createGitPhaseBeginPort({root,onContext:value=>{context=value;}});
  const engine=createEngine({ports:{phaseBegin,invocation:{
    run:callback=>withoutConfigurationReadScope(()=>withoutReadScope(callback))
  }}});
  return Object.freeze({engine,presentation:()=>context});
}

/** Native draft observations. Authorship presentation is trusted host context, not operation input. */
function createGitPhaseCheckPort({root,kind,authoringAgent=false,onContext=()=>{}}) {
  return {
    async load(inputs) {
      const {loadAcceptedStoryExecution}=await import('../accepted-story-execution.mjs');
      const accepted=await loadAcceptedStoryExecution(root,inputs.workId??null);
      const context={root,config:accepted.definition,workflow:accepted.workflow};onContext(context);return context;
    },
    async inspect(context,binding) {
      const {loadSession}=await import('../session.mjs');
      const check=kind==='prepublish'?(await import('../phase-prepublish.mjs')).phasePrepublish
        :(await import('../phase-draft-check.mjs')).phaseDraftCheck;
      const {operationContext}=await import('../operation-context.mjs');
      const {agentPublicationProducer}=await import('../kernel/phase-policy.mjs');
      const phase=context.workflow.phases[binding.phase];context.phase=phase;
      const session=await loadSession(root,{required:false});
      const result=await check(root,context.config,context.workflow,phase,{
        modelEnabled:operationContext()?.modelMode.enabled!==false,session,
        requestedProducer:authoringAgent?agentPublicationProducer(phase):null
      });
      const {observeWorkflowTaskCheck,readWorkflowTaskResume}=await import('../workflow-task-store.mjs');
      if(kind==='draft-check')await observeWorkflowTaskCheck(root,context.workflow,phase,result);
      const task=await readWorkflowTaskResume(root,context.workflow,phase,{generation:result.generation,
        progress:{state:result.status==='ready'?'publish-ready':result.correction?.sameTurn?'repair-draft':'blocked',
          nextAction:result.commandGuidance?.next??result.commandGuidance?.publish}});
      context.result=result;context.taskResume=task;
      return {workId:result.workId,phase:result.phase,generation:result.generation,phaseStatus:result.phaseStatus,
        inspectionStage:result.inspectionStage,...(kind==='prepublish'?{readiness:result.readiness}:{}),producer:result.producer??null,
        qualityDisposition:result.qualityDisposition,draftFingerprint:result.draftFingerprint??null,
        findings:result.findings.map(finding=>{
          const details=finding.details??{},coverage=details.coverage;
          return {code:String(finding.code??'UNKNOWN_PHASE_FINDING'),sourceCode:details.sourceCode?String(details.sourceCode):null,
            category:finding.category||null,message:String(finding.message??details.message??finding.code??''),
            phaseId:finding.phaseId||finding.phase||details.upstreamPhase||details.ownerPhase||null,path:finding.path??null,
            line:Number.isSafeInteger(finding.line)&&finding.line>=0?finding.line:null,clauseId:details.clauseId||finding.clauseId||null,
            upstreamDecisionComplete:details.upstreamDecision?.complete===true,
            coverageReviewRequired:Boolean(coverage?.invalidEvidence?.length||coverage?.unclaimedChangedPaths?.length||coverage?.withdrawnButClaimed?.length),
            riskEligible:details.riskEligible===true||details.qualityRisk?.eligible===true};
        }),advisories:(result.advisories??[]).map((item,index)=>{
          const projected=result.resolution?.advisories?.[index],details=item.details??{};
          const owner=details.owner??details.ownerPhase??details.upstreamPhase,clause=details.clauseId??item.clauseId;
          const issueRefs=Array.isArray(details.issueRefs)?details.issueRefs
            :/^UPI-\d{3,}$/u.test(details.issue??'')?[details.issue]:[];
          return {code:item.code||null,category:item.category||null,message:String(item.message??''),
            requiredBefore:projected?.code===item.code?projected.requiredBefore??null:item.requiredBefore??null,
            ownerPhase:typeof owner==='string'&&owner?owner:null,
            clauseId:typeof clause==='string'&&clause?clause:null,issueRefs,
            status:typeof details.status==='string'&&details.status?details.status:null};
        }),
        warningCount:(result.warnings??[]).length,correction:{class:result.correction?.class??null,
          sameTurn:result.correction?.sameTurn===true,requiresNewGeneration:result.correction?.requiresNewGeneration===true},
        task:task?{operationId:task.operationId,state:task.state,continuationBudget:task.continuationBudget}:null};
    }
  };
}

export function createGitPhasePrepublishPort(options) {
  return createGitPhaseCheckPort({...options,kind:'prepublish'});
}

export function createGitPhaseDraftCheckPort(options) {
  return createGitPhaseCheckPort({...options,kind:'draft-check'});
}

function createGitPhaseCheckEngine({root,authoringAgent=false,kind}) {
  if(typeof root!=='string'||!path.isAbsolute(root)||typeof authoringAgent!=='boolean')throw new SingularityFlowError(
    `Git ${kind==='prepublish'?'prepublication':'draft-check'} inspection requires an absolute checkout and a host presentation mode.`,{code:'ENGINE_INPUT_INVALID'});
  let context;
  const port=createGitPhaseCheckPort({root,kind,authoringAgent,onContext:value=>{context=value;}});
  const engine=createEngine({ports:{[kind==='prepublish'?'phasePrepublish':'phaseDraftCheck']:port,invocation:{
    run:callback=>withoutConfigurationReadScope(()=>withoutReadScope(callback))
  }}});
  return Object.freeze({engine,presentation:()=>context});
}

export function createGitPhasePrepublishEngine({root,authoringAgent=false}={}) {
  return createGitPhaseCheckEngine({root,authoringAgent,kind:'prepublish'});
}

export function createGitPhaseDraftCheckEngine({root,authoringAgent=false}={}) {
  return createGitPhaseCheckEngine({root,authoringAgent,kind:'draft-check'});
}

/** Exact native successor preview and local transaction; the SDK never receives command prose. */
export function createGitPhaseRolloverPort({root,onContext=()=>{}}) {
  return {
    async load(inputs) {
      const {loadAcceptedStoryExecution}=await import('../accepted-story-execution.mjs');
      const accepted=await loadAcceptedStoryExecution(root,inputs.workId??null);
      const context={root,config:accepted.definition,workflow:accepted.workflow};onContext(context);return context;
    },
    async inspect(context,binding,inputs) {
      const {generationRecovery}=await import('../recovery-plan.mjs');
      const {generationResultMatches,generationResultDigest}=await import('../state-stores.mjs');
      const {safeCommandGuidance}=await import('../safe-command-guidance.mjs');
      const {config,workflow}=context,phase=workflow.phases[binding.phase];context.phase=phase;
      const plan=await generationRecovery(root,workflow,phase,async(repositoryRoot,selectedPhase)=>
        await generationResultMatches(repositoryRoot,config,workflow,selectedPhase)
          ?selectedPhase.generationIntent.publication.resultDigest
          :generationResultDigest(repositoryRoot,config,workflow,selectedPhase));
      if(plan?.action.id===`return-submitted-generation:${phase.id}`)throw new SingularityFlowError(
        'Return the submitted packet through authorized rejection before opening a successor; direct rollover is not legal while awaiting approval.',
        {code:'GENERATION_ROLLOVER_REVIEW_REQUIRED',details:{actions:[plan.action]}});
      if(!plan||plan.action.mode==='manual'||!plan.action.command)throw new SingularityFlowError(
        plan?.action.detail??`Phase '${binding.phase}' has no changed consumed generation to roll over.`,
        {code:'GENERATION_ROLLOVER_UNAVAILABLE',details:plan??null});
      const route=safeCommandGuidance(plan.action);
      if(!route)throw new SingularityFlowError(
        'The reviewed rollover action has no validated Shell and Copilot route. Re-run recovery before changing state.',
        {code:'GENERATION_ROLLOVER_ROUTE_UNAVAILABLE',details:{action:plan.action}});
      const preview={schemaVersion:1,workId:workflow.workItem.id,phase:phase.id,
        fromGeneration:phase.generation,toGeneration:nextPhaseGeneration(phase),
        confirmation:plan.blocker.details.rolloverConfirmation,changeSetDigest:plan.blocker.details.changeSetDigest,
        currentResultDigest:plan.blocker.details.currentResultDigest,
        command:route.command,executable:route.executable,argv:route.argv,skill:route.skill,
        copilotCommand:route.copilotCommand,platformCommands:route.platformCommands,mutates:Boolean(inputs.confirm)};
      Object.assign(context,{plan,route,preview});
      return {workId:preview.workId,phase:preview.phase,fromGeneration:Number(preview.fromGeneration),
        toGeneration:preview.toGeneration,confirmation:preview.confirmation,
        changeSetDigest:preview.changeSetDigest,currentResultDigest:preview.currentResultDigest};
    },
    async begin(context,binding,plan) {
      const {beginPhaseGeneration,saveStoryDraft}=await import('../state-stores.mjs');
      const {verifyOpenGenerationIntent}=await import('../generation-boundary.mjs');
      const {storyDraftTransaction}=await import('./story-draft-transaction.mjs');
      const {config,workflow,phase}=context;
      context.result=await storyDraftTransaction(root,config,workflow,`phase-rollover:${binding.phase}`,async()=>{
        const opened=await beginPhaseGeneration(root,config,workflow,{
          phaseId:binding.phase,adoptExisting:Boolean(plan.changeSetDigest),confirm:plan.changeSetDigest
        });
        await saveStoryDraft(root,config,workflow);
        await verifyOpenGenerationIntent(root,workflow,phase);
        return opened;
      });
      return generationIntentFacts(context,binding);
    }
  };
}

export function createGitPhaseRolloverEngine({root}={}) {
  if(typeof root!=='string'||!path.isAbsolute(root))throw new SingularityFlowError(
    'Git generation rollover requires an explicit absolute checkout root.',{code:'ENGINE_INPUT_INVALID'});
  let context;
  const phaseRollover=createGitPhaseRolloverPort({root,onContext:value=>{context=value;}});
  const engine=createEngine({ports:{phaseRollover,invocation:{
    run:callback=>withoutConfigurationReadScope(()=>withoutReadScope(callback))
  }}});
  return Object.freeze({engine,presentation:()=>context});
}
