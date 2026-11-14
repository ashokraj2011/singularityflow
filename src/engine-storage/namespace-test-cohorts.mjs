/** Registered human cohort coordination. Execution remains owned by the existing check operation. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {namespaceTestCohortRecordProfile} from '../foundation/record-schema.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {standaloneDecisionRequest} from '../kernel/decision-plan.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceTestCohortOwner} from './namespace-test-cohort-reader.mjs';
const fail=(message,code)=>{throw new SingularityFlowError(message,{code});};
export function createNamespaceTestCohortPorts(options){
  const {scope,workId,access}=options,observer=createNamespaceStoryObserver(options),owned=createNamespaceTestCohortOwner({observer,scope,workId}),
    operation='test-cohort.context',contexts=new WeakMap(),
    request=(input,workflow)=>{
      const raw=standaloneDecisionRequest('test-cohort.confirm',input),phaseId=raw.revoke?workflow.namespaceTestCohorts?.find(row=>row.id===raw.revoke)?.phase:raw.phaseId;
      if(!phaseId||raw.revoke&&(raw.phaseId||raw.baselineOperationId||raw.observedOperationId||raw.observedPhaseId||raw.candidateGeneration||raw.expectedContext||raw.expires)
        ||!raw.revoke&&(!raw.baselineOperationId||!raw.observedOperationId||!raw.expectedContext))fail('Select the exact reviewed baseline and candidate, or one original decision to revoke.','TEST_COHORT_INVALID');
      return {...raw,phaseId,baselinePhaseId:raw.revoke?phaseId:raw.baselinePhaseId};
    },
    decision=createNamespaceRecordedMutationPort(options,{operation:'test-cohort.confirm',explicitIdentity:true,request,requestUsesWorkflow:true,
      owner:owned.owner,contract:namespaceDecisionContract,finish:(value,revision,{replayed})=>({workId,phase:value.phase,recordKind:'test-cohort',record:value.outcome.record,
        revision:replayed?null:revision,retained:replayed,pushed:false,actorId:value.actor.principalId,authorityGroup:value.authorityGroup,currentPhase:value.outcome.currentPhase})});
  const context={async load(input,{signal}={}){
    if(input.workId!=null&&input.workId!==workId)fail('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
    const principal=phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation),captured=await observer.capture({signal}),
      value={subject:{kind:'story',id:workId},workflow:captured.snapshot.workflow,phase:captured.snapshot.workflow.phases[input.phaseId]};
    if(!value.phase)fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');contexts.set(value,{captured,principal,input});return value;
  },async read(context,{signal}={}){
    const state=contexts.get(context);if(!state)fail('Use the issued cohort context.','ENGINE_INPUT_INVALID');
    const source=await owned.context(state.captured.snapshot,state.input,{signal,at:await options.clock.now()}),prior=await owned.admitted(state.captured.snapshot,{signal});
    phaseTransitionAccess(await access.current({projectId:scope.projectId,workId,operation,signal}),scope.projectId,operation,{expected:state.principal});
    const fresh=await observer.capture({signal});if(fresh.snapshot.revision!==state.captured.snapshot.revision||fresh.basis.authorityVersion!==state.captured.basis.authorityVersion)
      fail('The Story or cohort authority changed while reading.','ENGINE_CONTEXT_CHANGED');
    const history=prior.filter(row=>row.value.phase===context.phase.id),fields=['schemaVersion','profile','id','revokes','phase','generation','contextSha256','selectionSha256',
      'expiresAt','reason','actor','authorityGroup','recordedAt'],value={...source.context.value,expectedContext:source.context.sha256,
        ...(namespaceTestCohortRecordProfile('context',source.context.value).executionBinding?{purpose:source.renewal?'renew-original-cohort':'review-observed-cohort',sourceObservation:source.renewal?'retained-original':'recorded-execution'}:{}),
        authorities:testRunRiskAuthorities(context.workflow,context.phase.id),revision:state.captured.snapshot.revision,
        previousDecisionTotal:history.length,previousDecisionsTruncated:history.length>32,
        previousDecisions:history.slice(-32).map(row=>({record:Object.fromEntries(fields.filter(key=>Object.hasOwn(row.value.outcome.record,key)).map(key=>[key,row.value.outcome.record[key]])),reference:row.reference}))};
    if(new TextEncoder().encode(JSON.stringify(value)).byteLength>2_097_152)fail('The cohort review exceeds its bounded packet, including decision history.','ENGINE_STORAGE_LIMIT');
    return value;
  }};
  return Object.freeze({context,decision,owned});
}
