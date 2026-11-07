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
