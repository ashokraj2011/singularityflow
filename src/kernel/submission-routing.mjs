/** Select decision-input provenance from the pinned program. Storage binds the exact source packets. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {decisionAfter,normalizeDecisionInputValues} from './workflow-decisions.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const missing=decision=>{throw new SingularityFlowError('The submitted routing inputs have no complete recorded source.',{
  code:'DECISION_INPUTS_MISSING',details:{decision}});};
export function submissionRoutingSelection(workflow,phase) {
  const decision=decisionAfter(workflow,phase.id);if(!decision)return null;
  const record=decision.inputs.length?phase.decisionInputs:null;
  if(decision.inputs.length&&(!record||record.decision!==decision.id||!same(record.values,normalizeDecisionInputValues(decision,record.values))))missing(decision.id);
  const groups=new Map(),index=workflow.phaseOrder.indexOf(phase.id);if(index<0)missing(decision.id);
  for(const input of decision.reuses??[]) {
    const source=workflow.resolution.decisions.find(item=>item.id===input.from),producer=source?workflow.phases[source.after]:null;
    if(!source||!producer||workflow.phaseOrder.indexOf(source.after)<0||workflow.phaseOrder.indexOf(source.after)>=index||producer.status!=='approved'
      ||!producer.decisionInputs||producer.decisionInputs.decision!==source.id)missing(input.from);
    const values=normalizeDecisionInputValues(source,producer.decisionInputs.values);
    if(!Object.hasOwn(values,input.name)||!same(values,producer.decisionInputs.values))missing(source.id);
    let group=groups.get(source.id);
    if(!group){group={decision:source.id,phase:source.after,generation:producer.generation,values:{}};groups.set(source.id,group);}
    group.values[input.name]=values[input.name];
  }
  return {decision:decision.id,record:record?structuredClone(record):null,reused:[...groups.values()]};
}
/** Compare only semantic input selection; packet references are verified by the storage reader. */
export function assertSubmittedRoutingSelection(workflow,phase,routing) {
  const expected=submissionRoutingSelection(workflow,phase),observed=routing?{decision:routing.decision,record:routing.record,
    reused:routing.reused.map(({decision,phase,generation,values})=>({decision,phase,generation,values}))}:null;
  if(!same(expected,observed))throw new SingularityFlowError('The review packet does not bind the pinned decision inputs.',{
    code:'SUBMISSION_ROUTING_BINDING_CHANGED',details:{phase:phase.id}});
  return expected;
}
