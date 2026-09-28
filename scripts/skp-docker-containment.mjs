#!/usr/bin/env node
/**
 * Opt-in, inert Docker containment candidate. This command never loads or executes a skill.
 * A successful probe is not host qualification and never authorizes a Story phase to launch.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeSkpDockerContainment } from '../src/skp-docker-containment-probe.mjs';

export const SKP_DOCKER_PROBE_FIXTURE = 'Singularity Flow SKP Docker containment probe\ninert fixture v1\n';

const IMAGE = /^docker\.io\/library\/busybox@sha256:[a-f0-9]{64}$/u;
const ARGUMENTS = Object.freeze(['--image', '--docker-executable', '--docker-socket']);
const SAFE_CODE = /^SKP_[A-Z0-9_]{1,96}$/u;
const CHECK_IDS = Object.freeze([
  'hash', 'runtimePolicy', 'read', 'write', 'network', 'controlPlane', 'cancellation'
]);
const CHECK_STATUSES = new Set(['not-run', 'observed', 'unavailable']);
const CONTAINER_CLEANUP = new Set(['not-started', 'observed-absent', 'unknown']);
const LOCAL_CLEANUP = new Set(['not-staged', 'observed-removed', 'unknown']);

function validAbsolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) && value.trim() === value
    && !/[\r\n\0]/u.test(value);
}

/** Parse only three explicit flags; never consult ambient Docker context or pull an image. */
export function parseSkpDockerProbeArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6 || argv.some((value) => typeof value !== 'string')) {
    throw Object.assign(new Error('Invalid probe arguments.'), { code: 'SKP_DOCKER_PROBE_INPUT_INVALID' });
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!ARGUMENTS.includes(name) || values.has(name) || !argv[index + 1]) {
      throw Object.assign(new Error('Invalid probe arguments.'), { code: 'SKP_DOCKER_PROBE_INPUT_INVALID' });
    }
    values.set(name, argv[index + 1]);
  }
  const image = values.get('--image');
  const dockerExecutable = values.get('--docker-executable');
  const dockerSocketPath = values.get('--docker-socket');
  if (!IMAGE.test(image ?? '') || !validAbsolute(dockerExecutable)
      || !validAbsolute(dockerSocketPath)) {
    throw Object.assign(new Error('Invalid probe arguments.'), { code: 'SKP_DOCKER_PROBE_INPUT_INVALID' });
  }
  return Object.freeze({ image, dockerExecutable, dockerSocketPath });
}

function safeCode(value, fallback) {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback;
}

function safeReport(result, failure = null) {
  const reportedChecks = Array.isArray(result?.checks) ? result.checks : [];
  const checks = CHECK_IDS.map((id) => {
    const entries = reportedChecks.filter((entry) => entry?.id === id);
    const status = entries.length === 1 && CHECK_STATUSES.has(entries[0]?.status)
      ? entries[0].status : 'not-run';
    return { id, status };
  });
  const completeChecks = reportedChecks.length === CHECK_IDS.length
    && checks.every((entry) => entry.status === 'observed');
  const reportedCleanup = Array.isArray(result?.recovery?.containers)
    ? result.recovery.containers : [];
  const containers = CHECK_IDS.map((id) => {
    const entries = reportedCleanup.filter((entry) => entry?.id === id);
    const cleanup = entries.length === 1 && CONTAINER_CLEANUP.has(entries[0]?.cleanup)
      ? entries[0].cleanup : 'unknown';
    return { id, cleanup };
  });
  const localStageCleanup = LOCAL_CLEANUP.has(result?.recovery?.localStageCleanup)
    ? result.recovery.localStageCleanup : 'unknown';
  const candidate = !failure && result?.status === 'candidate-observed' && completeChecks
    && containers.every((entry) => entry.cleanup === 'observed-absent')
    && localStageCleanup === 'observed-removed'
    && result.qualified === false && result.launchAuthorized === false
    && result.skillExecuted === false && result.deliveryAuthenticated === false
    && result.hostEnforcementProven === false;
  const status = candidate ? 'candidate-observed' : 'unavailable';
  const code = status === 'unavailable'
    ? safeCode(failure?.code ?? result?.code, 'SKP_DOCKER_CONTAINMENT_UNAVAILABLE') : null;
  return {
    schemaVersion: 1,
    resultType: 'sflow-skp-docker-containment-cli',
    status, code,
    observationScope: 'fixed-inert-fixture-only',
    checks,
    recovery: {
      containers,
      localStageCleanup,
      effectsKnownAbsent: false,
      automaticRetryAuthorized: false
    },
    qualified: false,
    launchAuthorized: false,
    skillExecuted: false,
    deliveryAuthenticated: false,
    hostEnforcementProven: false
  };
}

/** Injectable only for a no-Docker CLI test; production uses the registered candidate probe. */
export async function runSkpDockerProbeCli(argv, {
  probe = probeSkpDockerContainment,
  write = (line) => process.stdout.write(line)
} = {}) {
  let result = null; let failure = null;
  try {
    const options = parseSkpDockerProbeArguments(argv);
    result = await probe({ packageBytes: Buffer.from(SKP_DOCKER_PROBE_FIXTURE, 'utf8'), ...options });
  } catch (error) {
    failure = error;
  }
  let report;
  try { report = safeReport(result, failure); }
  catch { report = safeReport(null, { code: 'SKP_DOCKER_CONTAINMENT_REPORT_INVALID' }); }
  write(`${JSON.stringify(report)}\n`);
  return report.status === 'candidate-observed' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSkpDockerProbeCli(process.argv.slice(2));
}
