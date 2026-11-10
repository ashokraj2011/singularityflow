/** Explicit Node path/root values; this binding performs no I/O. */
import {repositoryPlanPolicies} from '../kernel/repository-plan.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from './node-configuration-path.mjs';
import {GOVERNED_ROOTS} from '../governed-roots.mjs';
const values=/* @__PURE__ */ repositoryPlanPolicies(NODE_CONFIGURATION_PATH_SYNTAX,GOVERNED_ROOTS);
export const deriveRepositoryPlan=/* @__PURE__ */ (()=>values.deriveRepositoryPlan)();
export const repositoryPlanValue=/* @__PURE__ */ (()=>values.repositoryPlanValue)();
export const repositoryPlanProjection=/* @__PURE__ */ (()=>values.repositoryPlanProjection)();
export const assertRepositoryPlanSources=/* @__PURE__ */ (()=>values.assertRepositoryPlanSources)();
export const repositoryPlanTestLocation=/* @__PURE__ */ (()=>values.repositoryPlanTestLocation)();
export const repositoryPlanAmendmentProjection=/* @__PURE__ */ (()=>values.repositoryPlanAmendmentProjection)();
