/** Honest capability boundary until a transactional REV head/interval writer is installed. */
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SingularityFlowError } from '../util.mjs';
import { verifyRevisionPacket } from './packet.mjs';

export const REV_PILOT_OPT_IN_PATH = '.sflow/revision-pilot.json';
const MAX_OPT_IN_BYTES = 4096;
const DEFAULT_RELEASE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PILOT_BRIDGES = Object.freeze([
  'publicRoutePreviewAvailable', 'publicPacketPlanningAvailable', 'manualCaptureAvailable',
  'candidateHeadCasAvailable', 'codeResultAvailable', 'publicationBridgeAvailable',
  'releaseWitnessExecutionAvailable'
]);

function refusePilot(message, code = 'REV_PILOT_OPT_IN_INVALID') {
  throw new SingularityFlowError(message, { code });
}

function exactKeys(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...names].sort().join('\0');
}

/** An opt-in belongs to the requested repository, not to the process environment or package. */
export async function readRevisionPilotOptIn(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) {
    refusePilot('A concrete absolute repository root is required for REV pilot opt-in.');
  }
  let root;
  try { root = await realpath(repositoryRoot); }
  catch { refusePilot('REV pilot repository root is unavailable.'); }
  let gitRoot;
  try {
    gitRoot = await realpath(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim());
  } catch { refusePilot('REV pilot requires the exact Git repository top-level.'); }
  if (gitRoot !== root) refusePilot('REV pilot opt-in must name the exact Git repository top-level.');
  const directory = path.join(root, '.sflow');
  const filename = path.join(directory, 'revision-pilot.json');
  let directoryStat;
  try { directoryStat = await lstat(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    refusePilot('REV pilot opt-in directory must be a real repository-local directory.');
  }
  let fileStat;
  try { fileStat = await lstat(filename); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    refusePilot('REV pilot opt-in must be a regular repository-local file.');
  }
  let optIn;
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.size < 1 || opened.size > MAX_OPT_IN_BYTES
        || opened.dev !== fileStat.dev || opened.ino !== fileStat.ino
        || await realpath(filename) !== filename) {
      refusePilot('REV pilot opt-in changed, exceeds its size limit, or escapes its repository-local path.');
    }
    const bytes = Buffer.alloc(opened.size);
    const { bytesRead } = await file.read(bytes, 0, opened.size, 0);
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await file.read(extra, 0, 1, opened.size);
    if (bytesRead !== opened.size || extraBytes) {
      refusePilot('REV pilot opt-in changed while it was read.');
    }
    optIn = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    refusePilot('REV pilot opt-in must contain valid bounded UTF-8 JSON.');
  } finally { await file?.close(); }
  if (!exactKeys(optIn, ['kind', 'activationProfile'])
      || optIn.kind !== 'revision-pilot-opt-in'
      || optIn.activationProfile !== 'REV_POC_SINGLE_REPO') {
    refusePilot('REV pilot opt-in must explicitly select REV_POC_SINGLE_REPO with the exact fields.');
  }
  return Object.freeze({ ...optIn, repositoryRoot: root });
}

export const revisionRuntimeCapabilities = Object.freeze({
  schemaVersion: 1,
  kind: 'revision-runtime-capabilities',
  activationProfile: 'disabled',
  routeKernelAvailable: true,
  publicRoutePreviewAvailable: false,
  packetKernelAvailable: true,
  publicPacketPlanningAvailable: false,
  codeRevisionExecutionAvailable: false,
  manualCaptureAvailable: false,
  candidateHeadCasAvailable: false,
  codeResultAvailable: false,
  publicationBridgeAvailable: false,
  releaseWitnessExecutionAvailable: false,
  reasonCode: 'REV_EXECUTION_UNAVAILABLE'
});

/**
 * This is the authoritative public resolver. A caller cannot inject capability flags, a release
 * root, a source commit, or a platform claim. Until a gate-owned, source-bound release attestation
 * is installed and verified here, even a valid repository opt-in cannot activate code execution.
 */
export async function resolveRevisionRuntimeCapabilities({ repositoryRoot } = {}) {
  const optIn = await readRevisionPilotOptIn(repositoryRoot);
  if (!optIn) return revisionRuntimeCapabilities;
  refusePilot('REV pilot opt-in is recorded, but no gate-owned release attestation is installed or verified.',
    'REV_PILOT_ATTESTATION_UNAVAILABLE');
}

/** Read-only, fail-closed explanation for a repository's pilot request. */
export async function inspectRevisionPilotActivation({ repositoryRoot } = {}) {
  const optIn = await readRevisionPilotOptIn(repositoryRoot);
  const blockers = [];
  blockers.push({ code: 'REV_PILOT_ATTESTATION_UNAVAILABLE',
    message: 'No gate-owned release attestation binds current source, platform, and passing pilot witnesses.' });
  if (revisionRuntimeCapabilities.activationProfile !== 'REV_POC_SINGLE_REPO') {
    blockers.push({ code: 'REV_PILOT_RUNTIME_DISABLED',
      message: 'The installed runtime does not claim the REV_POC_SINGLE_REPO profile.' });
  }
  if (revisionRuntimeCapabilities.codeRevisionExecutionAvailable !== true) {
    blockers.push({ code: 'REV_EXECUTION_UNAVAILABLE',
      message: 'Transactional code revision execution is not installed.' });
  }
  for (const flag of PILOT_BRIDGES) {
    if (revisionRuntimeCapabilities[flag] !== true) {
      blockers.push({ code: 'REV_PILOT_BRIDGE_UNAVAILABLE', bridge: flag,
        message: `Required pilot bridge '${flag}' is unavailable.` });
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      await readFile(path.join(DEFAULT_RELEASE_ROOT, 'revision-trace-manifest.json'))));
  } catch {
    blockers.push({ code: 'REV_TRACE_INCOMPLETE', message: 'The release trace manifest is unreadable.' });
  }
  let missingPilotCoreCriteria = [];
  if (manifest) {
    if (manifest.activationProfile !== 'REV_POC_SINGLE_REPO') {
      blockers.push({ code: 'REV_TRACE_PROFILE_MISMATCH',
        message: `The release trace profile is '${manifest.activationProfile ?? '<missing>'}', not 'REV_POC_SINGLE_REPO'.` });
    }
    const { REV_PILOT_CORE_CRITERIA } = await import('./trace-manifest.mjs');
    missingPilotCoreCriteria = REV_PILOT_CORE_CRITERIA.filter((id) => !manifest.enabledCriteria?.[id]);
    if (missingPilotCoreCriteria.length) {
      blockers.push({ code: 'REV_TRACE_INCOMPLETE',
        message: `${missingPilotCoreCriteria.length} pilot-core criteria lack enabled exact witnesses.` });
    }
  }
  if (!optIn) blockers.push({ code: 'REV_PILOT_OPT_IN_REQUIRED',
    message: `Future prerequisite after pilot runtime and witnesses are released: opt in at ${REV_PILOT_OPT_IN_PATH}. An opt-in cannot enable REV in this build.` });
  return Object.freeze({ schemaVersion: 1, kind: 'revision-pilot-activation-status',
    requested: Boolean(optIn), activationProfile: 'disabled', eligible: false,
    blockers: Object.freeze(blockers.map((blocker) => Object.freeze(blocker))),
    missingPilotCoreCriterionCount: missingPilotCoreCriteria.length,
    missingPilotCoreCriterionSample: Object.freeze(missingPilotCoreCriteria.slice(0, 10)) });
}

/** No provider, Git, worktree, or Story mutation occurs. */
export function planRevisionExecution({ packet, routePlan, attachmentSetSha256 = null }) {
  verifyRevisionPacket(packet, { routePlan, attachmentSetSha256 });
  return {
    schemaVersion: 1, kind: 'revision-execution-unavailable',
    code: 'REV_EXECUTION_UNAVAILABLE',
    packetSha256: packet.packetSha256,
    routePlanSha256: routePlan.planSha256,
    attachmentSetSha256,
    effects: { codeChanged: false, artifactChanged: false, lifecycleChanged: false, externalChanged: false },
    requiredBridge: [
      'phase-bound durable loop head and interval journal',
      'atomic candidate/head/precheck compare-and-swap',
      'isolated execution with process quiescence and effect-resolution proof',
      'exact selected-candidate Story publication gate'
    ]
  };
}

export function assertRevisionExecutionInstalled() {
  throw new SingularityFlowError(
    'Code revision execution is not installed. Route and packet planning do not start a revision interval.',
    { code: 'REV_EXECUTION_UNAVAILABLE' }
  );
}
