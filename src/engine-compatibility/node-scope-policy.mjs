/** Explicit Node digest/checklist binding; domain rules remain pure and shared. */
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {STARTER_CHECKLIST,validateChecklistDecisions} from './node-specification-policy.mjs';
import {scopeStatementPolicies} from '../kernel/scope-statements.mjs';
import {scopeInventoryPolicies} from '../kernel/scope-inventory.mjs';
import {scopeDecisionPolicies} from '../kernel/scope-decisions.mjs';
export const scopeStatements=scopeStatementPolicies(NODE_TEXT_DIGESTS);
export const scopeInventory=scopeInventoryPolicies(NODE_TEXT_DIGESTS);
export const scopeDecisions=scopeDecisionPolicies({checklist:STARTER_CHECKLIST,validateChecklistDecisions});
