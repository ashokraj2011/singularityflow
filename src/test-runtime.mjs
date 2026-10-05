/** Approved test-only runtime settings. Never change the caller's environment. */
import { createHash } from 'node:crypto';
import { SingularityFlowError } from './util.mjs';

const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const NODE_OPTIONS = new Set(['--no-experimental-webstorage']);

export function normalizeTestRuntime(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => key !== 'nodeOptions')
      || (Object.hasOwn(value, 'nodeOptions') && (!Array.isArray(value.nodeOptions)
        || value.nodeOptions.some(flag => !NODE_OPTIONS.has(flag))))) {
    throw new SingularityFlowError('repositoryReadiness.testRuntime supports only nodeOptions: [--no-experimental-webstorage].',
      { code: 'TEST_RUNTIME_INVALID' });
  }
  return { nodeOptions: [...new Set(value.nodeOptions ?? [])].sort() };
}

export function testRuntimeEnvironment(profile = {}, environment = process.env) {
  return runtimeEnvironment(profile, environment, true);
}

function runtimeEnvironment(profile, environment, checkAvailability) {
  const normalized = normalizeTestRuntime(profile);
  const result = { ...environment };
  if (normalized.nodeOptions.length) {
    for (const flag of normalized.nodeOptions) {
      if (checkAvailability && !process.allowedNodeEnvironmentFlags.has(flag)) throw new SingularityFlowError(
        `The approved test runtime needs ${flag}, which this Node runtime does not support. Use a compatible Node runtime or review the configuration.`,
        { code: 'TEST_RUNTIME_UNSUPPORTED' });
    }
    const current = Object.entries(result).find(([key]) => key.toUpperCase() === 'NODE_OPTIONS')?.[1] ?? '';
    for (const key of Object.keys(result)) if (key.toUpperCase() === 'NODE_OPTIONS') delete result[key];
    result.NODE_OPTIONS = `${current} ${normalized.nodeOptions.filter(flag => !String(current).split(/\s+/u).includes(flag)).join(' ')}`.trim();
  }
  return result;
}

/** Ambient flags are hashed, not logged; receipts cannot survive a different execution runtime. */
export function testRuntimeIdentity(profile = {}, environment = process.env) {
  const normalized = normalizeTestRuntime(profile);
  // Identity inspection runs no command. Unsupported runtime settings must not prevent an
  // explicit unverified baseline deferral; executable plans/runners check availability separately.
  const effective = runtimeEnvironment(normalized, environment, false);
  const core = { node: process.version, platform: process.platform, arch: process.arch,
    profile: normalized, nodeOptionsSha256: digest(Object.entries(effective)
      .find(([key]) => key.toUpperCase() === 'NODE_OPTIONS')?.[1] ?? '') };
  return { ...core, sha256: digest(core) };
}
