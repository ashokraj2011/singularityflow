/**
 * Browser-verified revision-loop contracts.
 *
 * This module deliberately stops short of granting arbitrary process authority. A browser run may
 * be recorded only from the original same-process result of the fixed REV execution bridge. The
 * bridge proves bounded filesystem/process cleanup, while this layer independently binds those
 * bytes to a retained candidate and a closed browser-check definition. That assurance is useful
 * for review, but is not by itself Testing evidence or publication authority.
 */
import { createHash } from 'node:crypto';

import { createGitRuntime } from '../git-access.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { readRecord, stampCurrentRecord } from '../schema-migrations.mjs';
import { isPortableRepositoryPathComponent, SingularityFlowError } from '../util.mjs';
import { verifySgosRevisionCandidateReference } from './candidate-adapter.mjs';
import {
  readRevisionBrokeredResultBytes, revisionBrokeredParentSha256
} from './execution-bridge.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANDIDATE_ID = /^CAN-[A-Za-z0-9._:-]{6,127}$/;
const RUN_ID = /^BRL-[a-f0-9]{12}$/;
const ATTEMPT_ID = /^REVBR-[0-9a-f-]{36}$/;
const REASON = /^[A-Z][A-Z0-9_]{1,127}$/;
const MAX_FILES = 2_000;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const ARTIFACT_BYTES = new WeakMap();
const PREPARED_RUNS = new WeakMap();
const RUN_STATES = new WeakMap();
const TERMINAL_RUN_STATES = new Set([
  'completed', 'infrastructure-failed', 'cancelled', 'timed-out', 'unavailable',
  'recovery-required'
]);
const RUN_TRANSITIONS = Object.freeze({
  planned: new Set(['running', 'cancelled', 'unavailable']),
  running: new Set([
    'completed', 'infrastructure-failed', 'cancelled', 'timed-out', 'recovery-required'
  ])
});
const ARTIFACT_KINDS = new Set([
  'playwright-report', 'playwright-trace', 'playwright-screenshot', 'playwright-video',
  'visual-diff', 'structured-result', 'bounded-log'
]);
const MEDIA_TYPES = new Set([
  'application/json', 'application/zip', 'text/plain', 'text/html',
  'image/png', 'image/jpeg', 'image/webp', 'video/webm'
]);

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }
function bytesHash(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(value)).digest('hex')}`;
}
function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('REV_BROWSER_INPUT_INVALID', `${label} must be a plain object.`);
  }
  return value;
}
function exact(value, keys, label) {
  plain(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('REV_BROWSER_INPUT_INVALID', `${label} has missing or unknown fields.`);
  }
  return value;
}
function requiredHash(value, label) {
  if (!HASH.test(String(value ?? ''))) fail('REV_BROWSER_INPUT_INVALID', `${label} needs an exact SHA-256 digest.`);
  return value;
}
function identifier(value, label, pattern = ID) {
  if (!pattern.test(String(value ?? ''))) fail('REV_BROWSER_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedIdentifier(value, label) {
  return identifier(value, label, BOUNDED_ID);
}
function compareStableIds(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('REV_BROWSER_INPUT_INVALID', `${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    fail('REV_BROWSER_INPUT_INVALID', `${label} must be an exact UTC timestamp.`);
  }
  return value;
}
function relativePath(value, label, { dot = false, allowGoverned = false } = {}) {
  if (dot && value === '.') return value;
  if (typeof value !== 'string' || !value || value.length > 1024
      || value !== value.normalize('NFC') || value.startsWith('/')
      || value.split('/').some((part) => !isPortableRepositoryPathComponent(part))) {
    fail('REV_BROWSER_PATH_INVALID', `${label} must be a safe repository-relative path.`);
  }
  const first = value.split('/')[0].toLowerCase();
  if (!allowGoverned && ['.sflow', '.singularity-flow', 'singularity'].includes(first)) {
    fail('REV_BROWSER_PATH_INVALID', `${label} cannot target governed or local runtime state.`);
  }
  return value;
}
function inOutputRoot(relative, roots) {
  return roots.some((root) => relative === root || relative.startsWith(`${root}/`));
}
function seal(kind, core, field) {
  const stamped = stampCurrentRecord(kind, { ...core, kind });
  return Object.freeze({ ...stamped, [field]: hash(stamped) });
}

function normalizePolicies(value) {
  exact(value, ['screenshots', 'traces', 'video'], 'artifact policy');
  const allowed = ['always', 'on-failure', 'never'];
  for (const key of ['screenshots', 'traces', 'video']) {
    if (!allowed.includes(value[key])) fail('REV_BROWSER_CHECK_INVALID', `Artifact policy '${key}' is unsupported.`);
  }
  return { screenshots: value.screenshots, traces: value.traces, video: value.video };
}

function normalizeLimits(value) {
  exact(value, [
    'maximumArtifacts', 'maximumArtifactBytes', 'maximumOutputBytes',
    'maximumTests', 'maximumLogBytes'
  ], 'browser limits');
  return {
    maximumArtifacts: integer(value.maximumArtifacts, 'maximumArtifacts', 1, 256),
    maximumArtifactBytes: integer(value.maximumArtifactBytes, 'maximumArtifactBytes', 1, MAX_FILE_BYTES),
    maximumOutputBytes: integer(value.maximumOutputBytes, 'maximumOutputBytes', 1, MAX_TREE_BYTES),
    maximumTests: integer(value.maximumTests, 'maximumTests', 1, 100_000),
    maximumLogBytes: integer(value.maximumLogBytes, 'maximumLogBytes', 1, 1024 * 1024)
  };
}

/** Construct the closed, self-hashed definition consumed by every BRL run. */
export function defineRevisionBrowserCheck(value) {
  exact(value, [
    'id', 'argv', 'workingDirectory', 'environment', 'outputRoots', 'artifacts',
    'visualBaseline', 'timeoutMs', 'limits', 'result', 'accessClass', 'retentionClass'
  ], 'browser check');
  identifier(value.id, 'browser check id');
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.length > 64
      || value.argv.some((item) => typeof item !== 'string' || !item || item.length > 2048
        || /[\u0000-\u001f\u007f]/u.test(item))) {
    fail('REV_BROWSER_CHECK_INVALID', 'Browser check must use a bounded argv array. Shell command strings are unsupported.');
  }
  const workingDirectory = relativePath(value.workingDirectory, 'workingDirectory', { dot: true });
  exact(value.environment, ['name', 'fingerprintSha256'], 'environment binding');
  identifier(value.environment.name, 'environment name');
  const environment = {
    name: value.environment.name,
    fingerprintSha256: value.environment.fingerprintSha256 == null
      ? null : requiredHash(value.environment.fingerprintSha256, 'environment fingerprint')
  };
  if (!Array.isArray(value.outputRoots) || !value.outputRoots.length || value.outputRoots.length > 16) {
    fail('REV_BROWSER_CHECK_INVALID', 'Browser check needs bounded output roots.');
  }
  const outputRoots = value.outputRoots.map((item) => relativePath(item, 'output root'));
  if (new Set(outputRoots.map((item) => item.toLowerCase())).size !== outputRoots.length) {
    fail('REV_BROWSER_CHECK_INVALID', 'Browser output roots must be unique on portable filesystems.');
  }
  if (outputRoots.some((item, index) => outputRoots.some((other, otherIndex) =>
    index !== otherIndex && (item.startsWith(`${other}/`) || other.startsWith(`${item}/`))))) {
    fail('REV_BROWSER_CHECK_INVALID', 'Browser output roots cannot overlap.');
  }
  const artifacts = normalizePolicies(value.artifacts);
  let visualBaseline = null;
  if (value.visualBaseline !== null) {
    exact(value.visualBaseline, [
      'path', 'manifestSha256', 'tolerance', 'approvalSha256', 'updatePolicy'
    ], 'visual baseline');
    if (value.visualBaseline.updatePolicy !== 'governed'
        || typeof value.visualBaseline.tolerance !== 'number'
        || !Number.isFinite(value.visualBaseline.tolerance)
        || value.visualBaseline.tolerance < 0 || value.visualBaseline.tolerance > 1) {
      fail('REV_BROWSER_CHECK_INVALID', 'Visual baseline must use governed updates and a tolerance from 0 through 1.');
    }
    // A reporter-provided pixel count is not a deterministic visual comparison. Keep the closed
    // contract shape readable for forward-compatible diagnostics, but refuse activation until the
    // registered comparator can independently load approved baseline pixels and verify membership.
    fail('REV_BROWSER_VISUAL_COMPARATOR_UNAVAILABLE',
      'Visual browser checks require the unavailable registered pixel comparator and governed baseline store.');
  }
  integer(value.timeoutMs, 'browser timeout', 1_000, 2 * 60 * 60 * 1000);
  const limits = normalizeLimits(value.limits);
  exact(value.result, ['adapter', 'path', 'adapterSha256'], 'browser result');
  if (value.result.adapter !== 'sflow-browser-result-v1') {
    fail('REV_BROWSER_CHECK_INVALID', 'Browser result adapter must be sflow-browser-result-v1.');
  }
  const resultPath = relativePath(value.result.path, 'result path');
  if (!inOutputRoot(resultPath, outputRoots)) {
    fail('REV_BROWSER_CHECK_INVALID', 'Structured result must be below a declared output root.');
  }
  if (!['private', 'story'].includes(value.accessClass)
      || !['ephemeral', 'review', 'proof'].includes(value.retentionClass)) {
    fail('REV_BROWSER_CHECK_INVALID', 'Browser artifacts need supported access and retention classes.');
  }
  const core = {
    schemaVersion: 1,
    id: value.id, argv: [...value.argv], argvSha256: hash(value.argv),
    workingDirectory, environment, outputRoots: [...outputRoots].sort(), artifacts,
    visualBaseline, timeoutMs: value.timeoutMs, limits,
    result: {
      adapter: 'sflow-browser-result-v1', path: resultPath,
      adapterSha256: requiredHash(value.result.adapterSha256, 'result adapter')
    },
    accessClass: value.accessClass, retentionClass: value.retentionClass
  };
  return seal('revision-browser-check', core, 'definitionSha256');
}

function verifyCheck(value) {
  let migrated;
  try { migrated = readRecord('revision-browser-check', value).record; }
  catch { fail('REV_BROWSER_CHECK_INVALID', 'Browser check has an unreadable schema version.'); }
  const { definitionSha256, kind, argvSha256, ...input } = migrated;
  delete input.schemaVersion;
  const rebuilt = defineRevisionBrowserCheck({
    id: input.id, argv: input.argv, workingDirectory: input.workingDirectory,
    environment: input.environment, outputRoots: input.outputRoots, artifacts: input.artifacts,
    visualBaseline: input.visualBaseline, timeoutMs: input.timeoutMs, limits: input.limits,
    result: input.result, accessClass: input.accessClass, retentionClass: input.retentionClass
  });
  if (kind !== 'revision-browser-check'
      || argvSha256 !== rebuilt.argvSha256 || definitionSha256 !== rebuilt.definitionSha256
      || canonicalJson(migrated) !== canonicalJson(rebuilt)) {
    fail('REV_BROWSER_CHECK_INVALID', 'Browser check definition seal is invalid.');
  }
  return rebuilt;
}

async function candidateFiles(root, tree) {
  const runtimeResult = await createGitRuntime();
  if (!runtimeResult.ok) {
    fail('REV_BROWSER_CANDIDATE_UNAVAILABLE', 'The reviewed Git access layer is unavailable.');
  }
  const runtime = runtimeResult.value;
  let repository = null;
  let invocation = null;
  try {
    const opened = await runtime.openRepository(root);
    if (!opened.ok) {
      fail('REV_BROWSER_CANDIDATE_UNAVAILABLE', 'The retained candidate repository is unavailable.');
    }
    repository = opened.value;
    invocation = repository.beginInvocation();
    const listed = await invocation.tree({ oid: tree, recursive: true });
    if (!listed.ok) {
      fail('REV_BROWSER_CANDIDATE_UNAVAILABLE', 'Browser run needs a retained local candidate tree.');
    }
    const entries = [];
    const folded = new Set();
    let totalBytes = 0;
    for (const item of listed.value.entries) {
      if (item.objectType !== 'blob' || !['100644', '100755'].includes(item.mode)
          || typeof item.path?.text !== 'string' || !Number.isSafeInteger(item.size)
          || item.size < 0 || item.size > MAX_FILE_BYTES) {
        fail('REV_BROWSER_CANDIDATE_UNAVAILABLE',
          'Candidate tree contains a link, submodule, non-UTF-8 path, or oversized entry.');
      }
      // Governed files are part of the exact retained Candidate and therefore participate in its
      // materialization digest. They remain read-only: only separately validated outputRoots may
      // receive execution effects.
      const relative = relativePath(item.path.text, 'candidate path', { allowGoverned: true });
      const foldedPath = relative.toLowerCase();
      totalBytes += item.size;
      if (folded.has(foldedPath) || entries.length >= MAX_FILES || totalBytes > MAX_TREE_BYTES) {
        fail('REV_BROWSER_CANDIDATE_LIMIT', 'Candidate tree is ambiguous or exceeds its limits.');
      }
      folded.add(foldedPath);
      entries.push({
        path: relative, executable: item.mode === '100755', objectId: item.oid, bytes: item.size
      });
    }
    const loaded = await invocation.blobs({
      oids: entries.map((entry) => entry.objectId), mode: 'required'
    });
    if (!loaded.ok || loaded.value.entries.length !== entries.length) {
      fail('REV_BROWSER_CANDIDATE_UNAVAILABLE', 'Candidate blobs are unavailable.');
    }
    return entries.map((entry, index) => {
      const blob = loaded.value.entries[index];
      if (blob.oid !== entry.objectId || !Buffer.isBuffer(blob.bytes)
          || blob.bytes.length !== entry.bytes) {
        fail('REV_BROWSER_CANDIDATE_UNAVAILABLE', 'Candidate blob identity or size changed.');
      }
      return { path: entry.path, bytes: Buffer.from(blob.bytes), executable: entry.executable };
    });
  } finally {
    await invocation?.dispose();
    await repository?.dispose();
    await runtime.dispose();
  }
}

/** Verify and bind one browser run to exact candidate bytes and approved inputs. */
export async function prepareRevisionBrowserRun({
  root, candidateReference, workId, phaseId, phaseGeneration, loopId, intervalId,
  runId, configSha256, workflowSha256, proofProfileSha256, testManifest, check
} = {}) {
  boundedIdentifier(workId, 'work id');
  identifier(phaseId, 'phase id');
  integer(phaseGeneration, 'phase generation', 1, Number.MAX_SAFE_INTEGER);
  boundedIdentifier(loopId, 'loop id');
  boundedIdentifier(intervalId, 'interval id');
  identifier(runId, 'browser run id', RUN_ID);
  const subjectId = `${workId}:${phaseId}`;
  if (typeof root !== 'string' || !candidateReference
      || candidateReference.family !== 'sgos-candidate'
      || !CANDIDATE_ID.test(String(candidateReference.candidateId ?? ''))
      || !HASH.test(String(candidateReference.candidateSha256 ?? ''))
      || !OID.test(String(candidateReference.repository?.candidateTree ?? ''))
      || await verifySgosRevisionCandidateReference(root, candidateReference, { subjectId }) !== true) {
    fail('REV_BROWSER_CANDIDATE_UNVERIFIED', 'Browser run needs an independently verified retained candidate.');
  }
  const definition = verifyCheck(check);
  requiredHash(configSha256, 'configuration');
  requiredHash(workflowSha256, 'workflow');
  requiredHash(proofProfileSha256, 'proof profile');
  if (!Array.isArray(testManifest) || !testManifest.length
      || testManifest.length > definition.limits.maximumTests) {
    fail('REV_BROWSER_TEST_MANIFEST_INVALID', 'Browser run needs a bounded nonempty approved test manifest.');
  }
  const seenTests = new Set();
  const normalizedTestManifest = testManifest.map((entry) => {
    exact(entry, ['id', 'bodySha256'], 'browser test manifest entry');
    if (typeof entry.id !== 'string' || !entry.id || entry.id.length > 256
        || seenTests.has(entry.id)) {
      fail('REV_BROWSER_TEST_MANIFEST_INVALID', 'Browser test manifest IDs must be unique and bounded.');
    }
    seenTests.add(entry.id);
    return { id: entry.id, bodySha256: requiredHash(entry.bodySha256, 'test manifest body') };
  }).sort(compareStableIds);
  const parentFiles = await candidateFiles(root, candidateReference.repository.candidateTree);
  const candidatePaths = parentFiles.map((item) => item.path.toLocaleLowerCase('en-US'));
  for (const outputRoot of definition.outputRoots) {
    const foldedRoot = outputRoot.toLocaleLowerCase('en-US');
    if (candidatePaths.some((candidatePath) => candidatePath === foldedRoot
      || candidatePath.startsWith(`${foldedRoot}/`)
      || foldedRoot.startsWith(`${candidatePath}/`))) {
      fail('REV_BROWSER_OUTPUT_SCOPE_VIOLATION',
        `Browser output root '${outputRoot}' overlaps retained Candidate source. Use a new, untracked output directory.`);
    }
  }
  const materializationSha256 = revisionBrokeredParentSha256(parentFiles);
  const core = stampCurrentRecord('revision-browser-run-key', {
    kind: 'revision-browser-run-key',
    candidateId: candidateReference.candidateId,
    candidateSha256: candidateReference.candidateSha256,
    candidateRefSha256: hash(candidateReference),
    candidateTree: candidateReference.repository.candidateTree,
    materializationSha256,
    workId, phaseId, phaseGeneration, loopId, intervalId, runId,
    configSha256, workflowSha256, proofProfileSha256,
    testManifestSha256: hash(normalizedTestManifest),
    checkId: definition.id, checkDefinitionSha256: definition.definitionSha256,
    argvSha256: definition.argvSha256, timeoutMs: definition.timeoutMs,
    environmentName: definition.environment.name,
    environmentSha256: definition.environment.fingerprintSha256,
    baselineManifestSha256: definition.visualBaseline?.manifestSha256 ?? null,
    adapterSha256: definition.result.adapterSha256
  });
  const runKey = Object.freeze({ ...core, runKeySha256: hash(core) });
  const prepared = Object.freeze({
    runKey, check: definition,
    parentFiles: parentFiles.map((item) => ({ ...item, bytes: Buffer.from(item.bytes) })),
    available: definition.environment.fingerprintSha256 !== null,
    unavailableReason: definition.environment.fingerprintSha256 === null
      ? 'ENVIRONMENT_UNBOUND' : null
  });
  PREPARED_RUNS.set(prepared, Object.freeze({
    root, candidateReference, subjectId,
    runKeySha256: runKey.runKeySha256,
    checkDefinitionSha256: definition.definitionSha256,
    testManifest: normalizedTestManifest
  }));
  return prepared;
}

function verifyRunKey(input) {
  let value;
  try { value = readRecord('revision-browser-run-key', input).record; }
  catch { fail('REV_BROWSER_RUN_KEY_INVALID', 'Browser run key has an unreadable schema version.'); }
  exact(value, [
    'schemaVersion', 'kind', 'candidateId', 'candidateSha256', 'candidateRefSha256',
    'candidateTree', 'materializationSha256', 'workId', 'phaseId', 'phaseGeneration',
    'loopId', 'intervalId', 'runId', 'configSha256', 'workflowSha256',
    'proofProfileSha256', 'testManifestSha256', 'checkId', 'checkDefinitionSha256',
    'argvSha256', 'timeoutMs', 'environmentName', 'environmentSha256', 'baselineManifestSha256',
    'adapterSha256', 'runKeySha256'
  ], 'browser run key');
  if (value.kind !== 'revision-browser-run-key'
      || !CANDIDATE_ID.test(String(value.candidateId ?? '')) || !OID.test(String(value.candidateTree ?? ''))
      || !BOUNDED_ID.test(String(value.workId ?? '')) || !ID.test(String(value.phaseId ?? ''))
      || !BOUNDED_ID.test(String(value.loopId ?? '')) || !BOUNDED_ID.test(String(value.intervalId ?? ''))
      || !RUN_ID.test(String(value.runId ?? ''))
      || !Number.isSafeInteger(value.phaseGeneration) || value.phaseGeneration < 1
      || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1_000
      || value.timeoutMs > 2 * 60 * 60 * 1000) {
    fail('REV_BROWSER_RUN_KEY_INVALID', 'Browser run key has an invalid identity.');
  }
  for (const field of [
    'candidateSha256', 'candidateRefSha256', 'materializationSha256', 'configSha256',
    'workflowSha256', 'proofProfileSha256', 'testManifestSha256',
    'checkDefinitionSha256', 'argvSha256', 'adapterSha256'
  ]) requiredHash(value[field], `run key ${field}`);
  if (value.environmentSha256 !== null) requiredHash(value.environmentSha256, 'environment fingerprint');
  if (value.baselineManifestSha256 !== null) requiredHash(value.baselineManifestSha256, 'baseline manifest');
  const core = structuredClone(value);
  delete core.runKeySha256;
  if (hash(core) !== value.runKeySha256) fail('REV_BROWSER_RUN_KEY_INVALID', 'Browser run key seal is invalid.');
  return structuredClone(value);
}

export function createRevisionBrowserRunState({ runKey, at }) {
  const selected = verifyRunKey(runKey);
  timestamp(at, 'run state time');
  const core = stampCurrentRecord('revision-browser-run-state', {
    kind: 'revision-browser-run-state', runKeySha256: selected.runKeySha256,
    state: selected.environmentSha256 === null ? 'unavailable' : 'planned', sequence: 0,
    previousStateSha256: null,
    reasonCode: selected.environmentSha256 === null ? 'ENVIRONMENT_UNBOUND' : null,
    at
  });
  const state = Object.freeze({ ...core, stateSha256: hash(core) });
  RUN_STATES.set(state, Object.freeze({
    runKeySha256: selected.runKeySha256, state: core.state,
    at, runningAt: null, terminalAt: TERMINAL_RUN_STATES.has(core.state) ? at : null
  }));
  return state;
}

function verifyRunState(input) {
  let value;
  try { value = readRecord('revision-browser-run-state', input).record; }
  catch { fail('REV_BROWSER_RUN_STATE_INVALID', 'Browser run state has an unreadable schema version.'); }
  exact(value, [
    'schemaVersion', 'kind', 'runKeySha256', 'state', 'sequence', 'previousStateSha256',
    'reasonCode', 'at', 'stateSha256'
  ], 'browser run state');
  requiredHash(value.runKeySha256, 'run key');
  requiredHash(value.stateSha256, 'run state');
  timestamp(value.at, 'run state time');
  integer(value.sequence, 'run sequence', 0, 32);
  if (!['planned', 'running', ...TERMINAL_RUN_STATES].includes(value.state)
      || (value.reasonCode !== null && !REASON.test(String(value.reasonCode)))) {
    fail('REV_BROWSER_RUN_STATE_INVALID', 'Browser run state is outside its closed vocabulary.');
  }
  const core = structuredClone(value);
  delete core.stateSha256;
  if (hash(core) !== value.stateSha256) fail('REV_BROWSER_RUN_STATE_INVALID', 'Browser run state seal is invalid.');
  return structuredClone(value);
}

export function transitionRevisionBrowserRunState(state, { to, at, reasonCode = null } = {}) {
  const prior = verifyRunState(state);
  const original = state && RUN_STATES.get(state);
  if (!original || original.runKeySha256 !== prior.runKeySha256) {
    fail('REV_BROWSER_RUN_STATE_INVALID',
      'Browser transition needs the original same-process prior state.');
  }
  timestamp(at, 'run state time');
  if (Date.parse(at) < Date.parse(prior.at)) {
    fail('REV_BROWSER_RUN_STATE_INVALID', 'Browser run state time cannot move backwards.');
  }
  if (!RUN_TRANSITIONS[prior.state]?.has(to) || TERMINAL_RUN_STATES.has(prior.state)) {
    fail('REV_BROWSER_RUN_STATE_INVALID', `Browser run cannot transition from '${prior.state}' to '${String(to)}'.`);
  }
  if ((['infrastructure-failed', 'cancelled', 'timed-out', 'unavailable', 'recovery-required'].includes(to))
      !== (reasonCode !== null) || (reasonCode !== null && !REASON.test(String(reasonCode)))) {
    fail('REV_BROWSER_RUN_STATE_INVALID', 'Non-success terminal states need one bounded reason code.');
  }
  const core = stampCurrentRecord('revision-browser-run-state', {
    kind: 'revision-browser-run-state', runKeySha256: prior.runKeySha256,
    state: to, sequence: prior.sequence + 1, previousStateSha256: prior.stateSha256,
    reasonCode, at
  });
  const next = Object.freeze({ ...core, stateSha256: hash(core) });
  RUN_STATES.set(next, Object.freeze({
    runKeySha256: prior.runKeySha256, state: to, at,
    runningAt: to === 'running' ? at : original.runningAt,
    terminalAt: TERMINAL_RUN_STATES.has(to) ? at : null
  }));
  return next;
}

function counts(value, maximumTests) {
  exact(value, ['discovered', 'passed', 'failed', 'skipped', 'flaky'], 'browser test totals');
  const result = {};
  for (const field of ['discovered', 'passed', 'failed', 'skipped', 'flaky']) {
    result[field] = integer(value[field], `tests.${field}`, 0, maximumTests);
  }
  if (result.discovered !== result.passed + result.failed + result.skipped + result.flaky) {
    fail('REV_BROWSER_RESULT_INVALID', 'Browser test totals do not reconcile.');
  }
  return result;
}

function testCases(values, maximumTests) {
  if (!Array.isArray(values) || values.length > maximumTests) {
    fail('REV_BROWSER_RESULT_INVALID', 'Browser test case inventory exceeds its bound.');
  }
  const seen = new Set();
  return values.map((value) => {
    exact(value, ['id', 'titleSha256', 'bodySha256', 'status', 'attempts'], 'browser test case');
    if (typeof value.id !== 'string' || !value.id || value.id.length > 256 || seen.has(value.id)) {
      fail('REV_BROWSER_RESULT_INVALID', 'Browser test IDs must be unique and bounded.');
    }
    seen.add(value.id);
    requiredHash(value.titleSha256, 'test title');
    requiredHash(value.bodySha256, 'test body');
    if (!['passed', 'failed', 'skipped', 'flaky'].includes(value.status)) {
      fail('REV_BROWSER_RESULT_INVALID', 'Browser test case status is unsupported.');
    }
    return {
      id: value.id, titleSha256: value.titleSha256, bodySha256: value.bodySha256,
      status: value.status, attempts: integer(value.attempts, 'test attempts', 1, 100)
    };
  });
}

function artifactInventory(manifest, bytes, definition) {
  if (!Array.isArray(manifest) || manifest.length > definition.limits.maximumArtifacts) {
    fail('REV_BROWSER_ARTIFACT_INVALID', 'Browser artifact inventory exceeds its bound.');
  }
  const seen = new Set();
  let totalBytes = 0;
  const inventory = manifest.map((item) => {
    exact(item, ['path', 'kind', 'mediaType', 'captureProvenanceSha256'], 'browser artifact');
    const relative = relativePath(item.path, 'artifact path');
    if (!inOutputRoot(relative, definition.outputRoots) || seen.has(relative.toLowerCase())
        || !ARTIFACT_KINDS.has(item.kind) || !MEDIA_TYPES.has(item.mediaType)) {
      fail('REV_BROWSER_ARTIFACT_INVALID', 'Browser artifact identity, path, kind, or media type is invalid.');
    }
    seen.add(relative.toLowerCase());
    const content = bytes.get(relative);
    if (!Buffer.isBuffer(content) || content.length > definition.limits.maximumArtifactBytes) {
      fail('REV_BROWSER_ARTIFACT_INVALID', 'Browser artifact bytes are missing or exceed their bound.');
    }
    totalBytes += content.length;
    if (totalBytes > definition.limits.maximumOutputBytes) {
      fail('REV_BROWSER_ARTIFACT_INVALID', 'Browser artifacts exceed the total output bound.');
    }
    // Until the separately gated artifact-admission layer can independently identify media,
    // scan exact bytes, and authenticate capture lineage, reporter metadata is descriptive only.
    // Never preserve a caller-provided provenance digest or mark these bytes previewable.
    if (item.captureProvenanceSha256 !== null) {
      fail('REV_BROWSER_ARTIFACT_PROVENANCE_UNAVAILABLE',
        'Browser artifact capture provenance is unavailable until secure artifact admission is installed.');
    }
    return {
      path: relative, kind: item.kind, mediaType: item.mediaType,
      sha256: bytesHash(content), bytes: content.length,
      captureProvenanceSha256: null,
      accessClass: definition.accessClass, retentionClass: definition.retentionClass,
      previewable: false
    };
  });
  for (const [policy, kind] of [
    ['screenshots', 'playwright-screenshot'], ['traces', 'playwright-trace'],
    ['video', 'playwright-video']
  ]) {
    const count = inventory.filter((item) => item.kind === kind).length;
    const configured = definition.artifacts[policy];
    if (configured === 'never' && count > 0) {
      fail('REV_BROWSER_ARTIFACT_INVALID', `Browser artifact policy forbids ${policy}.`);
    }
    if (configured === 'always' && count === 0) {
      fail('REV_BROWSER_ARTIFACT_INVALID', `Browser artifact policy requires ${policy}.`);
    }
  }
  return inventory;
}

function visualComparisons(values, artifacts, definition) {
  if (!Array.isArray(values) || values.length > definition.limits.maximumArtifacts) {
    fail('REV_BROWSER_RESULT_INVALID', 'Visual comparison inventory exceeds its bound.');
  }
  const byPath = new Map(artifacts.map((item) => [item.path, item]));
  const testIds = new Set();
  return values.map((value) => {
    exact(value, [
      'testId', 'actualPath', 'baselineSha256', 'diffPath', 'differentPixels', 'totalPixels'
    ], 'visual comparison');
    if (!definition.visualBaseline) {
      fail('REV_BROWSER_RESULT_INVALID', 'Visual comparisons require a governed pinned baseline.');
    }
    if (typeof value.testId !== 'string' || !value.testId || value.testId.length > 256
        || testIds.has(value.testId)) {
      fail('REV_BROWSER_RESULT_INVALID', 'Visual comparison test IDs must be unique and bounded.');
    }
    testIds.add(value.testId);
    const actual = byPath.get(relativePath(value.actualPath, 'visual actual path'));
    const diff = value.diffPath === null ? null
      : byPath.get(relativePath(value.diffPath, 'visual diff path'));
    if (!actual || actual.kind !== 'playwright-screenshot'
        || (diff && diff.kind !== 'visual-diff')) {
      fail('REV_BROWSER_RESULT_INVALID', 'Visual comparison artifacts are missing or have the wrong kind.');
    }
    requiredHash(value.baselineSha256, 'visual baseline image');
    const totalPixels = integer(value.totalPixels, 'total pixels', 1, 1_000_000_000);
    const differentPixels = integer(value.differentPixels, 'different pixels', 0, totalPixels);
    const diffRatio = differentPixels / totalPixels;
    return {
      testId: String(value.testId), baselineManifestSha256: definition.visualBaseline.manifestSha256,
      baselineSha256: value.baselineSha256, actualSha256: actual.sha256,
      diffSha256: diff?.sha256 ?? null, differentPixels, totalPixels, diffRatio,
      tolerance: definition.visualBaseline.tolerance,
      verdict: diffRatio <= definition.visualBaseline.tolerance ? 'within-tolerance' : 'over-tolerance'
    };
  });
}

/**
 * Convert one original bridge handoff into a sealed browser receipt. The bridge currently proves
 * bounded effects only, so the receipt cannot satisfy Testing or publication on its own.
 */
export async function buildRevisionBrowserRunReceipt({
  prepared, state, bridgeReceipt, startedAt, endedAt
} = {}) {
  const binding = prepared && PREPARED_RUNS.get(prepared);
  if (!binding) {
    fail('REV_BROWSER_PREPARED_RUN_INVALID',
      'Browser receipt needs the original same-process prepared run, not reconstructed input.');
  }
  const runKey = verifyRunKey(prepared?.runKey);
  const definition = verifyCheck(prepared?.check);
  const selectedState = verifyRunState(state);
  const stateBinding = state && RUN_STATES.get(state);
  if (!stateBinding || stateBinding.runKeySha256 !== runKey.runKeySha256) {
    fail('REV_BROWSER_RUN_STATE_INVALID',
      'Browser receipt needs the original same-process terminal state.');
  }
  if (binding.runKeySha256 !== runKey.runKeySha256
      || binding.checkDefinitionSha256 !== definition.definitionSha256
      || runKey.checkDefinitionSha256 !== definition.definitionSha256
      || runKey.argvSha256 !== definition.argvSha256
      || runKey.checkId !== definition.id
      || runKey.environmentName !== definition.environment.name
      || runKey.environmentSha256 !== definition.environment.fingerprintSha256
      || runKey.baselineManifestSha256 !== null
      || runKey.adapterSha256 !== definition.result.adapterSha256
      || runKey.timeoutMs !== definition.timeoutMs
      || runKey.testManifestSha256 !== hash(binding.testManifest)
      || runKey.candidateId !== binding.candidateReference.candidateId
      || runKey.candidateSha256 !== binding.candidateReference.candidateSha256
      || runKey.candidateRefSha256 !== hash(binding.candidateReference)
      || runKey.candidateTree !== binding.candidateReference.repository.candidateTree) {
    fail('REV_BROWSER_PREPARED_RUN_INVALID',
      'Prepared browser run bindings changed after candidate and check verification.');
  }
  if (await verifySgosRevisionCandidateReference(binding.root, binding.candidateReference, {
    subjectId: binding.subjectId
  }) !== true) {
    fail('REV_BROWSER_CANDIDATE_UNVERIFIED',
      'Retained candidate identity changed before the browser receipt was built.');
  }
  const currentFiles = await candidateFiles(
    binding.root, binding.candidateReference.repository.candidateTree
  );
  if (revisionBrokeredParentSha256(currentFiles) !== runKey.materializationSha256
      || revisionBrokeredParentSha256(prepared.parentFiles) !== runKey.materializationSha256) {
    fail('REV_BROWSER_CANDIDATE_UNVERIFIED',
      'Prepared candidate bytes differ from the retained candidate tree.');
  }
  if (!prepared?.available || runKey.environmentSha256 === null) {
    fail('REV_BROWSER_ENVIRONMENT_UNBOUND', 'An unbound browser environment is unavailable and cannot produce a pass.');
  }
  if (selectedState.runKeySha256 !== runKey.runKeySha256 || selectedState.state !== 'completed') {
    fail('REV_BROWSER_RUN_STATE_INVALID', 'A completed state for this exact run key is required.');
  }
  if (bridgeReceipt?.status !== 'bounded-effects-collected'
      || bridgeReceipt.cleanup?.verified !== true || bridgeReceipt.unknownEffects?.length
      || bridgeReceipt.parentSha256 !== runKey.materializationSha256) {
    fail('REV_BROWSER_BRIDGE_INVALID', 'Browser result is not an exact, cleaned bridge handoff for this candidate.');
  }
  // Authenticate the original same-process bridge receipt before trusting any timing fields on it.
  const bytes = readRevisionBrokeredResultBytes(bridgeReceipt);
  timestamp(startedAt, 'browser run start');
  timestamp(endedAt, 'browser run end');
  const observedTiming = bridgeReceipt?.processTiming;
  if (!observedTiming || observedTiming.startedAt !== startedAt
      || observedTiming.endedAt !== endedAt
      || !Number.isSafeInteger(observedTiming.durationMs) || observedTiming.durationMs < 0
      || observedTiming.timeoutMs !== definition.timeoutMs) {
    fail('REV_BROWSER_TIMING_INVALID',
      'Browser receipt timing must exactly match the original fixed-bridge monotonic measurement and registered timeout.');
  }
  if (stateBinding.state !== 'completed'
      || Date.parse(stateBinding.runningAt) > Date.parse(startedAt)
      || Date.parse(stateBinding.terminalAt) < Date.parse(endedAt)
      || selectedState.at !== stateBinding.terminalAt) {
    fail('REV_BROWSER_TIMING_INVALID',
      'Browser lifecycle state does not enclose its authenticated fixed-bridge execution interval.');
  }
  const durationMs = observedTiming.durationMs;
  if (durationMs > definition.timeoutMs) {
    fail('REV_BROWSER_TIMEOUT_EXCEEDED',
      'Browser run duration exceeds the exact registered check timeout.');
  }
  for (const change of bridgeReceipt.changes ?? []) {
    if (change.after === null || !inOutputRoot(change.path, definition.outputRoots)) {
      fail('REV_BROWSER_OUTPUT_SCOPE_VIOLATION', 'Browser execution changed or removed a path outside its output roots.');
    }
  }
  const resultBytes = bytes.get(definition.result.path);
  if (!Buffer.isBuffer(resultBytes) || resultBytes.length > MAX_RESULT_BYTES) {
    fail('REV_BROWSER_RESULT_INVALID', 'Structured browser result is missing or exceeds its bound.');
  }
  let parsed;
  try { parsed = JSON.parse(resultBytes.toString('utf8')); }
  catch { fail('REV_BROWSER_RESULT_INVALID', 'Structured browser result is not valid JSON.'); }
  exact(parsed, [
    'schemaVersion', 'kind', 'status', 'reasonCode', 'exitCode', 'tests', 'testCases',
    'artifacts', 'visualComparisons', 'logPath'
  ], 'structured browser result');
  if (parsed.schemaVersion !== 1 // schema-transient: untrusted adapter transport, never persisted
      || parsed.kind !== 'sflow-browser-result-v1'
      || !['passed', 'failed', 'skipped', 'unavailable'].includes(parsed.status)
      || (parsed.reasonCode !== null && !REASON.test(String(parsed.reasonCode)))
      || (parsed.status === 'passed' ? parsed.reasonCode !== null : parsed.reasonCode === null)
      || (parsed.exitCode !== null
        && (!Number.isSafeInteger(parsed.exitCode) || parsed.exitCode < 0 || parsed.exitCode > 255))) {
    fail('REV_BROWSER_RESULT_INVALID', 'Structured browser result has unsupported status fields.');
  }
  const tests = counts(parsed.tests, definition.limits.maximumTests);
  const cases = testCases(parsed.testCases, definition.limits.maximumTests);
  const observedTestManifest = cases.map(({ id, bodySha256 }) => ({ id, bodySha256 }))
    .sort(compareStableIds);
  if (canonicalJson(observedTestManifest) !== canonicalJson(binding.testManifest)
      || hash(observedTestManifest) !== runKey.testManifestSha256) {
    fail('REV_BROWSER_TEST_MANIFEST_MISMATCH',
      'Browser results do not match the exact approved test manifest.');
  }
  if (cases.length !== tests.discovered
      || cases.filter((item) => item.status === 'passed').length !== tests.passed
      || cases.filter((item) => item.status === 'failed').length !== tests.failed
      || cases.filter((item) => item.status === 'skipped').length !== tests.skipped
      || cases.filter((item) => item.status === 'flaky').length !== tests.flaky) {
    fail('REV_BROWSER_RESULT_INVALID', 'Per-test outcomes do not match browser totals.');
  }
  if (parsed.status === 'passed' && (parsed.exitCode !== 0 || tests.failed > 0
      || tests.skipped > 0 || tests.flaky > 0 || tests.discovered === 0
      || cases.some((item) => item.attempts !== 1))) {
    fail('REV_BROWSER_RESULT_INVALID',
      'A passing browser result needs one-attempt, non-skipped, non-flaky discovered tests and exit code zero.');
  }
  const artifacts = artifactInventory(parsed.artifacts, bytes, definition);
  const inventoryPaths = new Set([definition.result.path, ...artifacts.map((item) => item.path)]);
  if ([...bytes.keys()].some((item) => !inventoryPaths.has(item))) {
    fail('REV_BROWSER_ARTIFACT_INVALID', 'Browser output contains an uninventoried file.');
  }
  let logSha256 = null;
  if (parsed.logPath !== null) {
    const log = artifacts.find((item) => item.path === parsed.logPath && item.kind === 'bounded-log');
    if (!log || log.bytes > definition.limits.maximumLogBytes) {
      fail('REV_BROWSER_ARTIFACT_INVALID', 'Browser log is missing or exceeds its dedicated bound.');
    }
    logSha256 = log.sha256;
  }
  const comparisons = visualComparisons(parsed.visualComparisons, artifacts, definition);
  if (comparisons.some((item) => !cases.some((testCase) => testCase.id === item.testId))) {
    fail('REV_BROWSER_RESULT_INVALID', 'Visual comparison references an unknown test case.');
  }
  if (parsed.status === 'failed' && parsed.exitCode === 0 && tests.failed === 0
      && !comparisons.some((item) => item.verdict === 'over-tolerance')) {
    fail('REV_BROWSER_RESULT_INVALID', 'Failed browser result has no failed assertion, exit, or visual comparison.');
  }
  if (['skipped', 'unavailable'].includes(parsed.status) && parsed.exitCode !== null) {
    fail('REV_BROWSER_RESULT_INVALID', 'Skipped or unavailable browser results cannot claim a process exit verdict.');
  }
  const status = parsed.status === 'passed' && comparisons.some((item) => item.verdict === 'over-tolerance')
    ? 'failed' : parsed.status;
  if (status === 'failed') {
    for (const [policy, kind] of [
      ['screenshots', 'playwright-screenshot'], ['traces', 'playwright-trace'],
      ['video', 'playwright-video']
    ]) {
      if (definition.artifacts[policy] === 'on-failure'
          && !artifacts.some((item) => item.kind === kind)) {
        fail('REV_BROWSER_ARTIFACT_INVALID', `Failed browser run requires ${policy} by policy.`);
      }
    }
  }
  const core = {
    schemaVersion: 1, runKey,
    attemptId: identifier(bridgeReceipt.attemptId, 'browser attempt id', ATTEMPT_ID),
    candidateUnderTestAttestation: null,
    startedAt, endedAt, durationMs,
    status, reasonCode: status === parsed.status ? parsed.reasonCode : 'VISUAL_TOLERANCE_EXCEEDED',
    exitCode: parsed.exitCode,
    tests, testCases: cases, logSha256, artifacts, visualComparisons: comparisons,
    bridgeReceiptSha256: requiredHash(bridgeReceipt.receiptSha256, 'bridge receipt'),
    executionAssurance: 'bounded-effects-only',
    assertionWitnessStatus: 'not-established',
    testingVerificationStatus: 'not-established-by-browser-run',
    publicationEligibilityEstablished: false
  };
  const receipt = seal('revision-browser-run-receipt', core, 'receiptSha256');
  let receiptBytes;
  try { receiptBytes = Buffer.byteLength(`${canonicalJson(receipt)}\n`); }
  catch { fail('REV_BROWSER_RESULT_INVALID', 'Browser receipt is not canonical JSON.'); }
  if (receiptBytes > MAX_RECEIPT_BYTES) fail('REV_BROWSER_RESULT_INVALID', 'Browser receipt exceeds its byte limit.');
  ARTIFACT_BYTES.set(receipt, new Map(artifacts.map((item) => [item.sha256, Buffer.from(bytes.get(item.path))])));
  return receipt;
}

export function validateRevisionBrowserRunReceipt(value) {
  let receipt;
  try { receipt = readRecord('revision-browser-run-receipt', value).record; }
  catch { fail('REV_BROWSER_RECEIPT_INVALID', 'Browser receipt has an unreadable schema version.'); }
  let receiptBytes;
  try { receiptBytes = Buffer.byteLength(`${canonicalJson(receipt)}\n`); }
  catch { fail('REV_BROWSER_RECEIPT_INVALID', 'Stored browser receipt is not canonical JSON.'); }
  if (receiptBytes > MAX_RECEIPT_BYTES) {
    fail('REV_BROWSER_RECEIPT_INVALID', 'Stored browser receipt exceeds its byte limit.');
  }
  exact(receipt, [
    'schemaVersion', 'kind', 'runKey', 'attemptId', 'candidateUnderTestAttestation',
    'startedAt', 'endedAt', 'durationMs', 'status', 'reasonCode',
    'exitCode', 'tests', 'testCases', 'logSha256', 'artifacts', 'visualComparisons',
    'bridgeReceiptSha256', 'executionAssurance', 'assertionWitnessStatus',
    'testingVerificationStatus', 'publicationEligibilityEstablished', 'receiptSha256'
  ], 'browser run receipt');
  if (receipt.kind !== 'revision-browser-run-receipt') {
    fail('REV_BROWSER_RECEIPT_INVALID', 'Stored browser receipt has the wrong kind.');
  }
  verifyRunKey(receipt.runKey);
  identifier(receipt.attemptId, 'browser attempt id', ATTEMPT_ID);
  timestamp(receipt.startedAt, 'browser run start');
  timestamp(receipt.endedAt, 'browser run end');
  if (Date.parse(receipt.endedAt) < Date.parse(receipt.startedAt)
      || !Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0
      || receipt.durationMs > receipt.runKey.timeoutMs
      || !['passed', 'failed', 'skipped', 'unavailable'].includes(receipt.status)
      || (receipt.status === 'passed' ? receipt.reasonCode !== null : receipt.reasonCode === null)
      || (receipt.reasonCode !== null && !REASON.test(String(receipt.reasonCode)))
      || (receipt.exitCode !== null
        && (!Number.isSafeInteger(receipt.exitCode) || receipt.exitCode < 0 || receipt.exitCode > 255))) {
    fail('REV_BROWSER_RECEIPT_INVALID', 'Stored browser receipt has invalid status or timing.');
  }
  const totals = counts(receipt.tests, 100_000);
  const cases = testCases(receipt.testCases, 100_000);
  const observedTestManifest = cases.map(({ id, bodySha256 }) => ({ id, bodySha256 }))
    .sort(compareStableIds);
  if (cases.length !== totals.discovered
      || cases.filter((item) => item.status === 'passed').length !== totals.passed
      || cases.filter((item) => item.status === 'failed').length !== totals.failed
      || cases.filter((item) => item.status === 'skipped').length !== totals.skipped
      || cases.filter((item) => item.status === 'flaky').length !== totals.flaky
      || (receipt.status === 'passed' && (receipt.exitCode !== 0 || totals.discovered === 0
        || totals.failed > 0 || totals.skipped > 0 || totals.flaky > 0
        || cases.some((item) => item.attempts !== 1)))) {
    fail('REV_BROWSER_RECEIPT_INVALID', 'Stored browser test inventory is inconsistent.');
  }
  if (hash(observedTestManifest) !== receipt.runKey.testManifestSha256) {
    fail('REV_BROWSER_RECEIPT_INVALID',
      'Stored browser test bodies do not match the exact run-key manifest binding.');
  }
  if (receipt.logSha256 !== null) requiredHash(receipt.logSha256, 'browser log');
  requiredHash(receipt.bridgeReceiptSha256, 'bridge receipt');
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length > 256
      || !Array.isArray(receipt.visualComparisons) || receipt.visualComparisons.length > 256) {
    fail('REV_BROWSER_RECEIPT_INVALID', 'Stored browser evidence inventory exceeds its bound.');
  }
  if (receipt.visualComparisons.length !== 0) {
    fail('REV_BROWSER_RECEIPT_INVALID',
      'Visual claims are unavailable until a registered comparator and governed baseline store exist.');
  }
  const paths = new Set();
  for (const artifact of receipt.artifacts) {
    exact(artifact, [
      'path', 'kind', 'mediaType', 'sha256', 'bytes', 'captureProvenanceSha256',
      'accessClass', 'retentionClass', 'previewable'
    ], 'stored browser artifact');
    relativePath(artifact.path, 'stored artifact path');
    if (paths.has(artifact.path.toLowerCase()) || !ARTIFACT_KINDS.has(artifact.kind)
        || !MEDIA_TYPES.has(artifact.mediaType)
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
        || artifact.bytes > MAX_FILE_BYTES
        || !['private', 'story'].includes(artifact.accessClass)
        || !['ephemeral', 'review', 'proof'].includes(artifact.retentionClass)
        || artifact.captureProvenanceSha256 !== null || artifact.previewable !== false) {
      fail('REV_BROWSER_RECEIPT_INVALID', 'Stored browser artifact metadata is invalid.');
    }
    paths.add(artifact.path.toLowerCase());
    requiredHash(artifact.sha256, 'stored artifact');
  }
  const artifactHashes = new Set(receipt.artifacts.map((item) => item.sha256));
  for (const comparison of receipt.visualComparisons) {
    exact(comparison, [
      'testId', 'baselineManifestSha256', 'baselineSha256', 'actualSha256', 'diffSha256',
      'differentPixels', 'totalPixels', 'diffRatio', 'tolerance', 'verdict'
    ], 'stored visual comparison');
    for (const field of ['baselineManifestSha256', 'baselineSha256', 'actualSha256']) {
      requiredHash(comparison[field], `stored visual ${field}`);
    }
    if (comparison.diffSha256 !== null) requiredHash(comparison.diffSha256, 'stored visual diff');
    if (!artifactHashes.has(comparison.actualSha256)
        || (comparison.diffSha256 !== null && !artifactHashes.has(comparison.diffSha256))
        || !Number.isSafeInteger(comparison.totalPixels) || comparison.totalPixels < 1
        || !Number.isSafeInteger(comparison.differentPixels) || comparison.differentPixels < 0
        || comparison.differentPixels > comparison.totalPixels
        || comparison.diffRatio !== comparison.differentPixels / comparison.totalPixels
        || typeof comparison.tolerance !== 'number' || comparison.tolerance < 0
        || comparison.tolerance > 1
        || comparison.verdict !== (comparison.diffRatio <= comparison.tolerance
          ? 'within-tolerance' : 'over-tolerance')) {
      fail('REV_BROWSER_RECEIPT_INVALID', 'Stored visual comparison is inconsistent.');
    }
  }
  const { receiptSha256, ...core } = receipt;
  requiredHash(receiptSha256, 'browser receipt');
  if (hash(core) !== receiptSha256
      || receipt.runKey.runKeySha256 !== core.runKey.runKeySha256
      || receipt.executionAssurance !== 'bounded-effects-only'
      || receipt.candidateUnderTestAttestation !== null
      || receipt.assertionWitnessStatus !== 'not-established'
      || receipt.testingVerificationStatus !== 'not-established-by-browser-run'
      || receipt.publicationEligibilityEstablished !== false) {
    fail('REV_BROWSER_RECEIPT_INVALID', 'Browser receipt seal or authority boundary is invalid.');
  }
  return structuredClone(receipt);
}

/** Same-process artifact handoff for the private immutable store. */
export function readRevisionBrowserRunArtifactBytes(receiptObject) {
  validateRevisionBrowserRunReceipt(receiptObject);
  const values = ARTIFACT_BYTES.get(receiptObject);
  if (!values) fail('REV_BROWSER_ARTIFACT_HANDOFF_INVALID', 'No original browser artifact handoff exists.');
  return new Map([...values].map(([digest, bytes]) => [digest, Buffer.from(bytes)]));
}

function staleBindings(observed, expected) {
  const fields = [
    ['candidate', 'candidateRefSha256'], ['candidate-tree', 'candidateTree'],
    ['subject', 'workId'], ['loop', 'loopId'], ['interval', 'intervalId'], ['run', 'runId'],
    ['phase', 'phaseId'], ['phase-generation', 'phaseGeneration'],
    ['configuration', 'configSha256'], ['workflow', 'workflowSha256'],
    ['proof-profile', 'proofProfileSha256'], ['test-manifest', 'testManifestSha256'],
    ['environment', 'environmentSha256'],
    ['baseline', 'baselineManifestSha256'], ['adapter', 'adapterSha256']
  ];
  const stale = fields.filter(([, field]) => observed[field] !== expected[field]).map(([label]) => label);
  if (observed.argvSha256 !== expected.argvSha256
      || observed.checkDefinitionSha256 !== expected.checkDefinitionSha256
      || observed.timeoutMs !== expected.timeoutMs) stale.splice(12, 0, 'command');
  return stale;
}

/** Deterministic, model-free comparison/card projection. */
export function compareRevisionBrowserRun({ receipt, expectedRunKey } = {}) {
  const selected = validateRevisionBrowserRunReceipt(receipt);
  const expected = verifyRunKey(expectedRunKey);
  const stale = staleBindings(selected.runKey, expected);
  const assertions = selected.testCases.map((item) => ({
    testId: item.id, status: item.status,
    verdict: item.status === 'passed' ? 'observed-pass'
      : item.status === 'failed' ? 'observed-fail' : item.status,
    witnessEligible: false
  }));
  const status = stale.length ? 'stale'
    : selected.status === 'passed' ? 'observed-passed' : selected.status;
  const core = {
    schemaVersion: 1, kind: 'revision-browser-comparison',
    runKeySha256: selected.runKey.runKeySha256,
    expectedRunKeySha256: expected.runKeySha256,
    receiptSha256: selected.receiptSha256,
    status, staleBindings: stale, assertions,
    visuals: selected.visualComparisons.map((item) => ({ ...item, witnessEligible: false })),
    humanObservation: 'finding-required',
    criterionSatisfactionEstablished: false,
    modelInvocations: 0
  };
  return seal('revision-browser-comparison', core, 'comparisonSha256');
}
