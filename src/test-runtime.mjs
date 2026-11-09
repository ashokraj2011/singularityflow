import { normalizeTestRuntime } from './kernel/configuration-policy.mjs';
export { normalizeTestRuntime } from './kernel/configuration-policy.mjs';
/** Approved test-only runtime settings. Never change the caller's environment. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from './package-root.mjs';
import { SingularityFlowError } from './util.mjs';

const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** test-run-environment.mjs [TCE:REQ-030]; an editor bundle loads the staged CLI's copy by URL. */
export const gateTestEnvironmentModule = () => (globalThis.__SFLOW_EXTENSION_HOST__ === true
  ? import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'test-run-environment.mjs')).href)
  : import('./test-run-environment.mjs'));

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

const reporterFlag = (token) => token === '--test-reporter' || token.startsWith('--test-reporter=');
const destinationFlag = (token) => token === '--test-reporter-destination' || token.startsWith('--test-reporter-destination=');

/** A native reporter is required for exact Node identities: ordinary TAP omits passing files. */
export async function nodeTestReporterEnvironment(environment, root, { argv = [], cwd = root } = {}) {
  const env = { ...environment };
  delete env.NODE_TEST_CONTEXT;
  env.SINGULARITY_FLOW_NODE_TEST_ROOT = root;
  const reporter = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'verification', 'node-test-reporter.mjs')).href;
  // Every `node --test` run the command reaches, through its npm run chain and workspaces, not only its outer script.
  const { runs, outer } = await (await import('./test-command-resolution.mjs')).nodeTestRunsAt(argv.map(String), cwd);
  // Each run's reporter and destination flags; a chain this reader cannot follow is read as its outer text, as before.
  const shape = (tokens) => ({ reporters: tokens.filter(reporterFlag).length, destinations: tokens.filter(destinationFlag).length });
  const textShape = (text) => ({ reporters: (text.match(/--test-reporter(?:=|\s)/gu) ?? []).length,
    destinations: (text.match(/--test-reporter-destination(?:=|\s)/gu) ?? []).length });
  const shapes = runs.length ? runs.map(shape) : [textShape(outer.join(' '))];
  const [{ reporters: existing, destinations }] = shapes;
  // NODE_OPTIONS reaches every run, so the runs must agree on how many reporters they install.
  const conflicting = shapes.some((entry) => entry.reporters !== existing || entry.destinations !== destinations);
  if (existing > 1 || destinations > existing || conflicting || /--test-reporter(?:=|\s)/u.test(env.NODE_OPTIONS ?? '')) {
    throw Object.assign(new Error('Exact Node evidence supports one repository TAP reporter. Remove duplicate/ambient reporter flags or use a single node --test command; no test was launched.'), { code: 'NODE_TEST_REPORTER_UNSUPPORTED' });
  }
  // With an explicit TAP reporter, retain its output and add only the identity event record. Node
  // requires one destination per reporter when more than one is installed; both use the captured
  // stream unless the approved command explicitly supplied its own destination.
  env.SINGULARITY_FLOW_NODE_TEST_TAP = existing ? '0' : '1';
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --test-reporter=${reporter}${existing
    ? ' --test-reporter-destination=stdout' + (destinations ? '' : ' --test-reporter-destination=stdout') : ''}`.trim();
  return env;
}
