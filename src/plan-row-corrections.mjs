/** Native compatibility: pure correction rules receive the exact presence-counted records. */
import {planCorrectionPolicies,planCorrectionRecordShapes} from './kernel/plan-corrections.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from './engine-compatibility/node-configuration-path.mjs';
import {nativeRecordShape} from './engine-compatibility/node-record-shapes.mjs';
import {NODE_TEXT_DIGESTS} from './records.mjs';
import {countedRecords} from './presence/counted.mjs';
const policies=/* @__PURE__ */ planCorrectionPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
export const PlanRowCorrectionSchema=/* @__PURE__ */ nativeRecordShape(planCorrectionRecordShapes().row);
export const planCorrectionAuthorities=/* @__PURE__ */ (()=>policies.planCorrectionAuthorities)();
export const recordPlanRowCorrection=/* @__PURE__ */ (()=>policies.recordPlanRowCorrection)();
export function applyPlanCorrections(record,workflow,options={}){return policies.applyPlanCorrections(record,workflow,options,countedRecords(workflow,workflow?.planAmendments));}
export function planRowCorrections(workflow,ownerPhase=null){return policies.planRowCorrections(workflow,ownerPhase,countedRecords(workflow,workflow?.planAmendments));}
