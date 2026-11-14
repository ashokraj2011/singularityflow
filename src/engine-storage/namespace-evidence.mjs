/** Registered read coordination. Evidence rules and proof ownership remain separate. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceEvidenceReader} from './namespace-evidence-reader.mjs';
export function createNamespaceEvidencePort(options){
  const {scope,workId,access,clock}=options,observer=createNamespaceStoryObserver(options),reader=createNamespaceEvidenceReader({observer,scope,workId}),
    contexts=new WeakMap(),operation='story.evidence';
  return {async load(input,{signal}={}){
    if(input.workId!=null&&input.workId!==workId)throw new SingularityFlowError('Use the bound Story.',{code:'ACTIVE_SUBJECT_MISMATCH'});
    const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation),
      captured=await observer.capture({signal}),context={subject:{kind:'story',id:workId},workflow:captured.snapshot.workflow};
    contexts.set(context,{captured,principal});return context;
  },async read(context,{signal}={}){
    const state=contexts.get(context);if(!state)throw new SingularityFlowError('Use the issued evidence context.',{code:'ENGINE_INPUT_INVALID'});
    const at=projectEnrollmentTimestamp(await clock.now()),observed=await reader.inspect(state.captured.snapshot,{signal,at});await observed.fresh();
    phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation,{expected:state.principal});
    const fresh=await observer.capture({signal});if(fresh.snapshot.revision!==state.captured.snapshot.revision||fresh.basis.authorityVersion!==state.captured.basis.authorityVersion)
      throw new SingularityFlowError('The Story or authority changed during evidence reading.',{code:'ENGINE_CONTEXT_CHANGED'});
    const version=observed.report.profile==='sflow-evidence-evaluation/v5'?5:observed.graph.executionPolicies!==undefined?4:observed.admission?.witnessMappings?3:(state.captured.snapshot.workflow.namespaceObligationRisks??[]).length?2:1;
    return {schemaVersion:version,profile:'sflow-namespace-evidence-context/v'+version,projectId:scope.projectId,workId,revision:state.captured.snapshot.revision,
      configuration:state.captured.snapshot.configuration,observedAt:at,report:observed.report,excluded:observed.excluded,
      references:observed.references,localSourceChecked:false,terminalDecision:false,approvalRecorded:false};
  }};
}
