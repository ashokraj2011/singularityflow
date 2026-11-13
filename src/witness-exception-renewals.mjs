/**
 * Renewing a lapsed witness exception (`decision witness-exception`, 2026-10-28).
 *
 * A step's approval may accept a test as an exception for a criterion (`approve --witness-mapping
 * <sha256>=exception:<facets> --witness-mapping-expires`). Once that date passed before the Story
 * finished, the final check refused it, and the only way out was returning the Story to that code
 * step: regenerating and retesting code that had not changed. A person who approves the step that
 * recorded the exception renews it instead, with a new future expiry and a reason, for that exact
 * exception (step, generation and mapping digest); a later generation of the step needs its own
 * decision. Renewals are append-only; the latest one for an exception sets its expiry, which the
 * final check reads (renewedWitnessExpiry in governance.mjs, where the gate's graph already is).
 */
import {renewedWitnessExpiry} from './governance.mjs';
import {witnessExceptionRenewalPolicies} from './kernel/human-witnesses.mjs';
export {renewedWitnessExpiry,witnessExceptionRenewalCommand} from './governance.mjs';
export const {witnessException,recordWitnessExceptionRenewal}=witnessExceptionRenewalPolicies({renewedWitnessExpiry});
