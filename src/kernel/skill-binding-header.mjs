/** Binding shape/version rules only: no package approval, content verification, storage or execution. */
import { SingularityFlowError } from '../foundation/failures.mjs';


export const SKP_CONTRACT_COMPILER = 'skp-contract/v1';

export const SKP_PHASE_BINDING_VERSION = 1;

const SHA256 = /^sha256:[a-f0-9]{64}$/;


function fail(code, message, details = null) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}


function plain(value, label, code = 'SKP_CONTRACT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${label} must be a plain object.`);
  }
  return value;
}


function closed(value, allowed, label, code = 'SKP_CONTRACT_INVALID') {
  plain(value, label, code);
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) fail(code, `${label} contains unsupported field '${field}'.`, { field });
  }
}


function checkedDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('SKP_CONTRACT_INVALID', `${label} must be a sha256:<64 lowercase hex> digest.`);
  }
  return value;
}


/** The configured phase reader and policy projections share one closed binding-header reader. */
export function validateSkillPhaseBindingHeader(binding, phaseId = null) {
  const label = phaseId == null ? 'Skill phase' : `Skill phase '${phaseId}'`;
  closed(binding, ['schemaVersion', 'compiler', 'compilationSha256', 'parserProfile', 'bindingRefs'],
    `${label} binding`, 'SKP_PHASE_BINDING_INVALID');
  const bindingVersion = binding.schemaVersion;
  if (bindingVersion !== SKP_PHASE_BINDING_VERSION
      || binding.compiler !== SKP_CONTRACT_COMPILER
      || binding.parserProfile !== SKP_PARSER_PROFILE) {
    fail('SKP_PHASE_BINDING_UNSUPPORTED', `${label} has an unsupported binding or parser version.`);
  }
  checkedDigest(binding.compilationSha256, `${label} compilation digest`);
  return binding;
}

export const SKP_PARSER_PROFILE = 'skp-skill-text/v1';
export { fail as skillBindingFail, plain as skillBindingPlain, closed as skillBindingClosed, checkedDigest as skillBindingDigest };
