/**
 * Which environment a run of a start entry or a test command uses, and whether it counts for a
 * Story step [RUN "Several environments"].
 *
 * A run may use only the environments its start or test entry lists, else the single environment
 * `checks` (or the command's own `environment` field) links the command to. The first listed one is
 * the default. When `checks` links the command, only a run in that environment counts for the
 * step's obligation; without a link, any of the command's declared environments counts.
 */
import { SingularityFlowError } from './util.mjs';

export const LOCAL_INTEGRATION_POLICY_COMMAND = 'singularity-flow capability show --json';

/** The environments a run may use, in order (first is the default), and the linked one if any. */
export function allowedRunEnvironments({ listed = [], linked = null } = {}) {
  const allowed = listed.length ? [...listed] : linked ? [linked] : [];
  return Object.freeze({ allowed: Object.freeze(allowed), linked: linked ?? null, default: allowed[0] ?? null });
}

/**
 * Choose the environment for one run, or refuse naming the allowed ones. Every allowed environment
 * must be declared in singularity/environments.yml. Returns null when the subject uses none.
 */
export function selectRunEnvironment({ listed = [], linked = null, requested = null, declaration = null, subject }) {
  const { allowed } = allowedRunEnvironments({ listed, linked });
  const undeclared = allowed.filter((name) => !Object.hasOwn(declaration?.environments ?? {}, name));
  if (undeclared.length) {
    throw new SingularityFlowError(
      `${subject} names environment(s) not declared in singularity/environments.yml: ${undeclared.join(', ')}.`
      + ` Declared: ${Object.keys(declaration?.environments ?? {}).sort().join(', ') || 'none'}.`,
      { code: 'RUN_ENVIRONMENT_UNKNOWN', details: { subject, undeclared, declared: Object.keys(declaration?.environments ?? {}).sort() } });
  }
  if (requested != null) {
    if (!allowed.includes(requested)) {
      throw new SingularityFlowError(
        allowed.length
          ? `${subject} may run only in ${allowed.map((name) => `'${name}'`).join(', ')}, not '${requested}'.`
          : `${subject} declares no environment, so it runs without one; remove --environment ${requested}.`,
        { code: 'RUN_ENVIRONMENT_NOT_ALLOWED', details: { subject, requested, allowed: [...allowed] } });
    }
    return requested;
  }
  return allowed[0] ?? null;
}

/** Whether a run in `environment` counts for the step's obligation of a command. */
export function environmentCountsForStep({ environment = null, listed = [], linked = null } = {}) {
  if (linked) return environment === linked;
  if (!environment) return true;
  return listed.includes(environment);
}

// The labels a local-integration run carries live beside the receipt (code-delivery-tests.mjs).

/** The coded refusal for private values while the capability policy is off. */
export function localIntegrationPolicyRefusal({ capabilityId, environment, subject }) {
  return new SingularityFlowError(
    `${subject} needs environment '${environment}', whose values are given to a local process only when capability`
    + ` '${capabilityId}' sets policy.localIntegrationEvidence to allowed. It is off. Change it through a capability proposal`
    + ' (capabilities.yml, reviewed like any other capability change); nothing ran and no value was read.',
    { code: 'LOCAL_INTEGRATION_POLICY_OFF', details: {
      capabilityId, environment, policy: 'localIntegrationEvidence', value: 'off',
      changedBy: 'capability proposal', inspect: LOCAL_INTEGRATION_POLICY_COMMAND
    } });
}

/** The coded refusal for an environment that is not completely bound on this machine. */
export function environmentBindingRefusal({ environment, status, missing = [], subject }) {
  return new SingularityFlowError(
    `${subject} needs environment '${environment}', which is ${status} on this machine${missing.length ? ` (missing ${missing.join(', ')})` : ''}.`
    + ` Bind it from your own secret helper: your-approved-secret-helper --format sflow-env-json ${environment} | singularity-flow env bind ${environment} --stdin. Nothing ran.`,
    { code: 'ENVIRONMENT_BINDING_UNAVAILABLE', details: {
      environment, status, missing: [...missing], recoveryCommands: [`singularity-flow env bind ${environment} --stdin`, 'singularity-flow env status --json']
    } });
}
