/**
 * The WEL observe profiles' result adapters. Exact identity for delivery evidence now comes from
 * src/verification/ (ADR 0016); these v1 names remain for the corpus measurement tooling.
 */
import { javascriptWelResultAdapter } from './wel-javascript.mjs';

export const WEL_EXACT_TEST_ADAPTERS = Object.freeze([
  'junit5-surefire-v1', 'jest-static-v1', 'vitest-static-v1'
]);

export function welResultAdapter(profile) {
  if (profile === 'junit5-surefire-v1') return 'junit-xml';
  return javascriptWelResultAdapter(profile);
}
