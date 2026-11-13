/** Native presence/clock admission and legacy command presentation over the shared evidence rules. */
import {evidenceEvaluationPolicies,reviewFacetValue} from '../kernel/evidence-evaluation.mjs';
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX} from '../records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {countedApprovals,countedRecords} from '../presence/counted.mjs';
import {applicabilityStatus,endpointTaken} from './applicability.mjs';
import {scopeDecisionArgv,scopeDecisionCommandLine} from '../scope/extract.mjs';
const rules=/* @__PURE__ */ evidenceEvaluationPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS);
export function reviewFacet(phase,workflow=null){
  return reviewFacetValue(phase,workflow,countedApprovals(workflow,(phase?.approvals??[]).filter(item=>!item.invalidatedAt&&item.decision==='approved')));
}
export function testOnlyCorrection(workId, planStep, clauseId, planned, delivered = []) {
  // The one test the step delivered is named; with several, the person picks the row's own.
  const test = delivered.length === 1 && /^[A-Za-z0-9._/@+-]+$/u.test(delivered[0]) ? delivered[0] : '<TEST-PATH>';
  return `singularity-flow decision plan ${workId} --owner ${planStep} --set-fulfillment ${clauseId}=test-only`
    + ((planned?.tests ?? []).length ? '' : ` --add-test ${clauseId}=${test}`)
    + ' --reason "<why the tests are the whole delivery>"';
}

function legacyAction(action){
  if(action.kind==='explain')return {kind:'explain',command:'singularity-flow explain --subject clause --id '+action.subject.id};
  if(action.operation==='decision.risk')return {kind:'accept-risk',command:'singularity-flow decision risk --obligation '+action.inputs.obligationId+' --category <category> --expires <YYYY-MM-DD> --reason "<why>"'};
  if(action.operation==='decision.applicability')return {kind:'decide',command:'singularity-flow decision applicability --responsibility '+action.inputs.responsibility+' --reason "<why it does not apply>"'};
  if(action.operation==='decision.scope')return {kind:'decide',command:scopeDecisionCommandLine(scopeDecisionArgv(null,action.inputs.item)[action.requiredInputs.includes('clauseIds')?'linked':'unlinked'])};
  throw new Error('Unknown evidence action.');
}
function legacyFinding(value){
  if(!value.correction)return value;
  const {correction,...finding}=value;return {...finding,message:value.message.slice(0,-1)+': '+testOnlyCorrection(
    correction.workId,correction.ownerPhase,correction.clauseId,correction.planned,correction.delivered)+'.'};
}
export function evaluateEvidence(graph,options={}){
  const workflow=graph.workflow,admission={
    reviewApprovals:Object.fromEntries(Object.entries(workflow.phases??{}).map(([id,phase])=>[id,countedApprovals(workflow,
      (phase.approvals??[]).filter(item=>!item.invalidatedAt&&item.decision==='approved'))])),
    riskDecisions:countedRecords(workflow,workflow.riskDecisions),
    applicability:applicabilityStatus(workflow,endpointTaken(workflow))};
  const {profile,...value}=rules.evaluateEvidence(graph,{...options,at:options.at===undefined?new Date().toISOString():options.at,admission});
  return {...value,findings:value.findings.map(legacyFinding),rows:value.rows.map(row=>({...row,
    findings:row.findings.map(legacyFinding),actions:row.actions.map(legacyAction)}))};
}
