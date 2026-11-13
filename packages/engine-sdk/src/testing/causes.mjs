/** Pure cause and message values; an explicit capability normalizes caller-provided memory bytes. */
import {testRunCausePolicies as values} from '../../../../src/kernel/test-run-cause.mjs';
export function testRunCausePolicies(bytes){const rules=values(bytes);
  // Consumers cannot rewrite the private classification table through its descriptive view.
  return Object.freeze({...rules,TEST_RUN_CAUSES:Object.freeze(Object.fromEntries(Object.entries(rules.TEST_RUN_CAUSES)
    .map(([id,row])=>[id,Object.freeze([...row])]))) });}
