/** Registered namespace decision-list coordination. Observations never enter a write port. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseTransitionAccess} from '../kernel/phase-preparation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceDecisionListReader} from './namespace-decision-list-reader.mjs';
const fail=(message,code)=>{throw new SingularityFlowError(message,{code});};
export function createNamespaceDecisionListPorts(options,runtime=null){
  const {scope,workId,access,clock}=options,observer=createNamespaceStoryObserver(options),
    owned=createNamespaceDecisionListReader({observer,scope,workId,runtime}),states=new WeakMap();
  const decisionList={
    async load(input,{signal}={}){
      if(input.workId!=null&&input.workId!==workId)fail('Use the bound Story.','ACTIVE_SUBJECT_MISMATCH');
      const facts=await access.current({projectId:scope.projectId,workId,operation:'decisions.list',signal}),
        principal=phaseTransitionAccess(facts,scope.projectId,'decisions.list'),snapshot=(await observer.inspect({signal})).snapshot,
        phaseId=input.phaseId??snapshot.workflow.currentPhase;
      if(phaseId!==null&&!snapshot.workflow.phases[phaseId])fail('Name a phase of this Story.','ENGINE_PHASE_UNAVAILABLE');
      const context={subject:{kind:'story',id:workId},workflow:snapshot.workflow};states.set(context,{snapshot,principal,permissions:facts.permissions,phaseId});return context;
    },
    async read(context,_binding,{signal}={}){
      const s=states.get(context);if(!s)fail('Use the issued decision list.','ENGINE_INPUT_INVALID');
      const value=await owned.read(s.snapshot,{principal:s.principal,permissions:s.permissions,phaseId:s.phaseId,at:projectEnrollmentTimestamp(await clock.now()),signal});
      await value.fresh();const current=await access.current({projectId:scope.projectId,workId,operation:'decisions.list',signal});
      phaseTransitionAccess(current,scope.projectId,'decisions.list',{expected:s.principal});
      if(canonicalJson([...current.permissions].sort())!==canonicalJson([...s.permissions].sort()))fail('Decision permissions changed during inspection.','ENGINE_CONTEXT_CHANGED');
      if((await observer.inspect({signal})).snapshot.revision!==s.snapshot.revision)fail('The decisions changed during inspection.','ENGINE_CONTEXT_CHANGED');
      return {revision:s.snapshot.revision,policy:value.policy,actions:value.actions};
    }
  };
  return Object.freeze({decisionList});
}
