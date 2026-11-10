/** Native path binding and presence-aware plan amendment projections. Rules live in the kernel. */
import {countedRecords} from './presence/counted.mjs';
import {planAmendmentPolicies} from './kernel/plan-amendments.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from './engine-compatibility/node-configuration-path.mjs';
export {MAX_PLAN_AMENDMENT_CHANGES} from './kernel/decision-limits.mjs';
export {accountedAmendmentPaths} from './kernel/specification-policy.mjs';
const values=/* @__PURE__ */ planAmendmentPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const planAuthorities=/* @__PURE__ */ (()=>values.planAuthorities)();
export const planRowsOf=/* @__PURE__ */ (()=>values.planRowsOf)();
export const recordPlanAmendment=/* @__PURE__ */ (()=>values.recordPlanAmendment)();
export function planAmendmentRecord(workflow){return values.planAmendmentRecord(workflow,countedRecords(workflow,workflow?.planAmendments));}
