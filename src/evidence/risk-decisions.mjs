/** Native presence/clock adapter for the shared obligation-risk values. */
import {countedRecords} from '../presence/counted.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {obligationRiskPolicies} from '../kernel/obligation-risks.mjs';
export {fallbackAuthorities} from '../kernel/approval-fallback.mjs';
const values=/* @__PURE__ */ obligationRiskPolicies(NODE_TEXT_DIGESTS);
export const RISK_CATEGORIES=/* @__PURE__ */ (()=>values.RISK_CATEGORIES)();
export const RISK_TRANSITIONS=/* @__PURE__ */ (()=>values.RISK_TRANSITIONS)();
export const MAX_RISK_DAYS=/* @__PURE__ */ (()=>values.MAX_RISK_DAYS)();
export const observationDigest=/* @__PURE__ */ (()=>values.observationDigest)();
export const riskEligibility=/* @__PURE__ */ (()=>values.riskEligibility)();
export const riskAuthorities=/* @__PURE__ */ (()=>values.riskAuthorities)();
export const recordRiskDecision=/* @__PURE__ */ (()=>values.recordRiskDecision)();
export function recordRiskRevocation(workflow,input){return values.recordRiskRevocation(workflow,input,countedRecords(workflow,workflow.riskDecisions));}
export function riskDecisionState(workflow,obligation,options={}){return values.riskDecisionState(workflow,obligation,{...options,at:options.at??new Date().toISOString()},countedRecords(workflow,workflow?.riskDecisions));}
export function acceptedImplementationClauses(workflow,options={}){return values.acceptedImplementationClauses(workflow,{...options,at:options.at??new Date().toISOString()},countedRecords(workflow,workflow?.riskDecisions));}
