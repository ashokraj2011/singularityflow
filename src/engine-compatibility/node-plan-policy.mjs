/** Bind the shared plan rules to explicit Node path syntax; no records or source discovery. */
import {planAmendmentPolicies} from '../kernel/plan-amendments.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from './node-configuration-path.mjs';
export const planDecisions=planAmendmentPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
