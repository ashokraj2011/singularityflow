import {
  javascriptWelResultAdapter, observeJavascriptTestIdentities,
  verifyJavascriptTestIdentityObservation
} from './wel-javascript.mjs';
import {
  observeJunit5SurefireIdentities, verifyJunit5SurefireIdentityObservation
} from './wel-junit5.mjs';

export const WEL_EXACT_TEST_ADAPTERS = Object.freeze([
  'junit5-surefire-v1', 'jest-static-v1', 'vitest-static-v1'
]);

export function welResultAdapter(profile) {
  if (profile === 'junit5-surefire-v1') return 'junit-xml';
  return javascriptWelResultAdapter(profile);
}

export async function observeExactTestcaseIdentities(root, command, parsed, policy, options = {}) {
  if (policy?.adapter === 'junit5-surefire-v1') {
    return observeJunit5SurefireIdentities(root, command, parsed, policy, options);
  }
  if (javascriptWelResultAdapter(policy?.adapter)) {
    return observeJavascriptTestIdentities(root, command, parsed, policy, options);
  }
  return null;
}

export async function verifyExactTestcaseIdentityObservation(root, observation, options = {}) {
  if (observation?.profile === 'junit5-surefire-v1') {
    return verifyJunit5SurefireIdentityObservation(root, observation, options);
  }
  if (javascriptWelResultAdapter(observation?.profile)) {
    return verifyJavascriptTestIdentityObservation(root, observation, options);
  }
  return { valid: false, errors: ['exact local testcase observation profile is unsupported'], rawOccurrences: [] };
}
