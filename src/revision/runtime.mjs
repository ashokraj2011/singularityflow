/** Honest capability boundary for the guarded local writer and unavailable full REV profile. */
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, SingularityFlowError } from '../util.mjs';
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

function localGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith('GIT_') || normalized.startsWith('GCM_')) delete env[key];
  }
  return {
    ...env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'
  };
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
    const result = run('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      cwd: root, env: localGitEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      allowFailure: true, timeoutClass: 'local-read', windowsHide: true
    });
    if (result.error || result.status !== 0) {
      refusePilot('REV pilot requires the exact Git repository top-level.');
    }
    gitRoot = await realpath(result.stdout.trim());
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
  // These guarded local operations are available without claiming the externally witnessed,
  // autonomous REV activation profile below.
  guardedInteractivePreviewAvailable: true,
  guardedManualCaptureAvailable: true,
  guardedLocalHeadCasAvailable: true,
  guardedSelectedHeadPublicationAvailable: true,
  registeredAttachmentRoutingAvailable: true,
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
  brlContractsAvailable: true,
  brlReceiptStoreAvailable: true,
  // Assertion/result-card projection is deterministic, but visual comparison is deliberately
  // unavailable until an independently registered pixel comparator and governed baseline store
  // are installed. Do not advertise the broader BRL comparison capability yet.
  brlDeterministicComparisonAvailable: false,
  brlTrustedBrowserExecutorAvailable: false,
  brlCandidateUnderTestAttestationAvailable: false,
  brlPublicationBridgeAvailable: false,
  brlBoundaryReasons: Object.freeze({
    deterministicVisualComparison: 'BRL_VISUAL_COMPARATOR_UNAVAILABLE',
    trustedBrowserExecutor: 'BRL_TRUSTED_BROWSER_EXECUTOR_UNAVAILABLE',
    candidateUnderTestAttestation: 'BRL_CANDIDATE_UNDER_TEST_ATTESTATION_UNAVAILABLE',
    publicationBridge: 'BRL_PUBLICATION_BRIDGE_UNAVAILABLE'
  }),
  evidenceBoundary: Object.freeze({
    candidate: 'retained-reference-foundation-only',
    program: 'approved-program-binding-unavailable',
    attempt: 'declarative-probe-only-unverified',
    receipt: 'projection-only-no-authenticated-durable-receipt',
    recovery: 'private-local-foundation-only',
    compareRestore: 'kernel-only-no-public-ux',
    browserLoop: 'candidate-bound-contract-store-and-comparison-only-no-trusted-executor'
  }),
  reasonCode: 'REV_EXECUTION_UNAVAILABLE'
});

const GUARDED_OPERATIONS = Object.freeze({
  preview: Object.freeze([
    'guardedInteractivePreviewAvailable', 'guardedLocalHeadCasAvailable',
    'registeredAttachmentRoutingAvailable'
  ]),
  capture: Object.freeze([
    'guardedManualCaptureAvailable', 'guardedLocalHeadCasAvailable'
  ]),
  inspect: Object.freeze(['guardedInteractivePreviewAvailable']),
  recovery: Object.freeze(['guardedLocalHeadCasAvailable'])
});

/**
 * Authoritative gate for the safe built-in profile. This intentionally does not claim the full
 * externally witnessed/autonomous activation profile; it only admits the named local operation
 * when every compiled guarded capability needed by that operation is present.
 */
export function assertGuardedRevisionCapability(operation) {
  const required = GUARDED_OPERATIONS[operation];
  if (!required) refusePilot(`Unknown guarded REV operation '${operation}'.`, 'REV_GUARDED_OPERATION_UNKNOWN');
  const missing = required.filter((flag) => revisionRuntimeCapabilities[flag] !== true);
  if (missing.length) {
    refusePilot(`Guarded REV '${operation}' is unavailable: ${missing.join(', ')}.`,
      'REV_GUARDED_CAPABILITY_UNAVAILABLE');
  }
  return Object.freeze({ operation, eligible: true, required: Object.freeze([...required]) });
}

const ACTIVATION_FOUNDATIONS = Object.freeze([
  Object.freeze({ id: 'candidate-head-cas', status: 'guarded-local',
    detail: 'The guarded interactive command exposes the machine-local append-only head journal and exact retained Candidate CAS; autonomous execution remains disabled.' }),
  Object.freeze({ id: 'candidate-precheck-publication', status: 'guarded-local-publication',
    detail: 'Candidate-bound precheck is exposed by the guarded local flow. An eligible exact current selected head is consumed by ordinary Code-phase publication under the Story transaction lock.' }),
  Object.freeze({ id: 'code-check-projection', status: 'projection-only',
    detail: 'Code-check planning and result projection exist; no authenticated durable Code-check receipt can be produced.' }),
  Object.freeze({ id: 'compare-discard-restore', status: 'kernel-only',
    detail: 'Exact Candidate comparison and head restoration are tested kernel primitives; the guarded UX exposes inspection, recovery, and abandonment, not unrestricted restoration.' })
]);

function activationBlocker(code, message, remediationClass, extra = {}) {
  return Object.freeze({ code, remediationClass, blocksActivation: true, message, ...extra });
}

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
  blockers.push(activationBlocker('REV_PILOT_ATTESTATION_UNAVAILABLE',
    'No gate-owned release attestation binds current source, platform, and passing pilot witnesses.',
    'external-release-evidence'));
  if (revisionRuntimeCapabilities.activationProfile !== 'REV_POC_SINGLE_REPO') {
    blockers.push(activationBlocker('REV_PILOT_RUNTIME_DISABLED',
      'The installed runtime does not claim the REV_POC_SINGLE_REPO profile.',
      'guarded-product-activation'));
  }
  if (revisionRuntimeCapabilities.codeRevisionExecutionAvailable !== true) {
    blockers.push(activationBlocker('REV_EXECUTION_UNAVAILABLE',
      'Transactional code revision execution is not installed.',
      'external-execution-boundary'));
  }
  for (const flag of PILOT_BRIDGES) {
    if (revisionRuntimeCapabilities[flag] !== true) {
      blockers.push(activationBlocker('REV_PILOT_BRIDGE_UNAVAILABLE',
        `Required pilot bridge '${flag}' is unavailable.`,
        flag === 'releaseWitnessExecutionAvailable'
          ? 'external-release-evidence' : 'guarded-product-activation', { bridge: flag }));
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      await readFile(path.join(DEFAULT_RELEASE_ROOT, 'revision-trace-manifest.json'))));
  } catch {
    blockers.push(activationBlocker('REV_TRACE_INCOMPLETE',
      'The release trace manifest is unreadable.', 'release-integrity'));
  }
  let missingPilotCoreCriteria = [];
  if (manifest) {
    if (manifest.activationProfile !== 'REV_POC_SINGLE_REPO') {
      blockers.push(activationBlocker('REV_TRACE_PROFILE_MISMATCH',
        `The release trace profile is '${manifest.activationProfile ?? '<missing>'}', not 'REV_POC_SINGLE_REPO'.`,
        'release-integrity'));
    }
    const { REV_PILOT_CORE_CRITERIA } = await import('./trace-manifest.mjs');
    missingPilotCoreCriteria = REV_PILOT_CORE_CRITERIA.filter((id) => !manifest.enabledCriteria?.[id]);
    if (missingPilotCoreCriteria.length) {
      blockers.push(activationBlocker('REV_TRACE_INCOMPLETE',
        `${missingPilotCoreCriteria.length} pilot-core criteria lack enabled exact witnesses.`,
        'external-release-evidence'));
    }
  }
  if (!optIn) blockers.push(activationBlocker('REV_PILOT_OPT_IN_REQUIRED',
    `Future prerequisite after pilot runtime and witnesses are released: opt in at ${REV_PILOT_OPT_IN_PATH}. An opt-in cannot enable REV in this build.`,
    'future-repository-choice'));
  const guardedOperations = Object.freeze(Object.fromEntries(Object.keys(GUARDED_OPERATIONS)
    .map((operation) => [operation, assertGuardedRevisionCapability(operation)])));
  return Object.freeze({ schemaVersion: 1, kind: 'revision-pilot-activation-status',
    requested: Boolean(optIn), activationProfile: 'disabled', eligible: false,
    guardedEligible: true, guardedOperations,
    blockers: Object.freeze(blockers.map((blocker) => Object.freeze(blocker))),
    foundations: ACTIVATION_FOUNDATIONS,
    evidenceBoundary: revisionRuntimeCapabilities.evidenceBoundary,
    safeNextActions: Object.freeze([
      Object.freeze({ id: 'inspect-capabilities', classification: 'read',
        shell: 'singularity-flow revision capabilities --json',
        copilot: '/sf-revision capabilities', requiresActiveStory: false }),
      Object.freeze({ id: 'inspect-attachments', classification: 'read',
        shell: 'singularity-flow revision attachments capabilities --json',
        copilot: '/sf-revision attachments', requiresActiveStory: false })
    ]),
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
