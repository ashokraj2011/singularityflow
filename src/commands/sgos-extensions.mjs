/**
 * Model-free CLI surfaces for the bounded SGOS extension profiles.
 *
 * Mutating inputs are read from repository-contained JSON files, not from ambient stdin or
 * credential-bearing argv. Every Authority Store mutation retains the service's exact CAS and
 * confirmation boundary; this dispatcher does not invent authority or weaken those checks.
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir, identity, repoRoot } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import {
  candidateDiffArguments, freezeSgosCandidate, listSgosCandidates,
  planSgosCandidatePublication, publishSgosCandidate, readSgosRetainedCandidate,
  verifySgosCandidate
} from '../sgos/candidate-lifecycle.mjs';
import {
  doctorSgosDevice, installedDeviceManifests, invokeSgosDevice, readSgosToolIntent,
  readSgosToolResult, recoverSgosToolIntent, revokeSgosDevice
} from '../sgos/devices.mjs';
import {
  installedExecutionUnit, installedExecutionUnitManifests
} from '../sgos/execution-units.mjs';
import {
  createCapabilityPackRegistry, createMetaToolService, createPlatformMemoryService,
  createReadOnlyLessonCatalog, openFilesystemAuthorityStore, validatePlatformRecord,
  verifySignedPlatformRecord
} from '../sgos/platform/index.mjs';
import { SingularityFlowError, optionBoolean, optionNumber, optionString, secureRepositoryPath } from '../util.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
// Store IDs become directory names below the Git common directory. Keep the CLI profile portable:
// ':' is invalid in Windows path components, a trailing dot is normalized away there, and device
// names such as CON/NUL are reserved even with an extension.
const STORE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9_-])?$/;
const WINDOWS_RESERVED_STORE_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_STORE_ID = 'repository-platform';
const MUTATIONS = new Set([
  'candidate.freeze', 'candidate.verify', 'candidate.publish.plan', 'candidate.publish',
  'device.invoke', 'device.recover', 'device.revoke',
  'authority-store.init', 'authority-store.recover',
  'pack.propose', 'pack.review', 'pack.activate', 'pack.revoke',
  'memory.register', 'memory.promote',
  'meta-tool.propose', 'meta-tool.evaluation', 'meta-tool.promote'
]);

function fail(message, code = 'SGOS_EXTENSION_CLI_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function rejectSecretArgv(options) {
  const forbidden = Object.keys(options).filter((key) =>
    /(?:private[-_]?key|secret|password|credential|token)/i.test(key));
  if (forbidden.length) {
    fail('Private keys and secret material are never accepted in SGOS extension command arguments.',
      'SGOS_SECRET_ARGV_REFUSED', { forbidden });
  }
}

async function repositoryFile(root, value, label) {
  if (!value) fail(`${label} is required.`, 'SGOS_FILE_REQUIRED', { label });
  const secured = await secureRepositoryPath(root, String(value), {
    label, mustExist: true, type: 'file'
  });
  let handle;
  try {
    handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) fail(`${label} must remain a regular file.`, 'SGOS_FILE_INVALID');
    if (opened.size > MAX_INPUT_BYTES) {
      fail(`${label} exceeds the ${MAX_INPUT_BYTES}-byte input ceiling.`, 'SGOS_FILE_LIMIT', {
        label, bytes: opened.size, maximumBytes: MAX_INPUT_BYTES
      });
    }
    const rebound = await secureRepositoryPath(root, secured.relative, {
      label, mustExist: true, type: 'file'
    });
    if (rebound.absolute !== secured.absolute
        || (opened.ino !== 0 && rebound.entry?.ino !== opened.ino)
        || (opened.dev !== 0 && rebound.entry?.dev !== opened.dev)) {
      fail(`${label} changed while it was being opened.`, 'SGOS_FILE_INVALID');
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_INPUT_BYTES) {
      fail(`${label} exceeds the ${MAX_INPUT_BYTES}-byte input ceiling.`, 'SGOS_FILE_LIMIT', {
        label, bytes: bytes.length, maximumBytes: MAX_INPUT_BYTES
      });
    }
    return { ...secured, bytes };
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail(`${label} cannot be a symbolic link.`, 'SGOS_FILE_INVALID');
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function jsonFile(root, value, label, { array = false } = {}) {
  const file = await repositoryFile(root, value, label);
  let parsed;
  try { parsed = JSON.parse(file.bytes.toString('utf8')); } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}.`, 'SGOS_FILE_INVALID', { file: file.relative });
  }
  if (array ? !Array.isArray(parsed) : (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    fail(`${label} must contain a JSON ${array ? 'array' : 'object'}.`, 'SGOS_FILE_INVALID', {
      file: file.relative
    });
  }
  return parsed;
}

async function publicTrustMap(root, option, label) {
  const input = await jsonFile(root, option, label);
  const result = {};
  for (const [keyId, source] of Object.entries(input)) {
    if (!/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(keyId) || typeof source !== 'string' || !source) {
      fail(`${label} must map canonical key IDs to public-key PEM text or repository-relative files.`,
        'SGOS_TRUST_INPUT_INVALID');
    }
    let pem = source;
    if (!source.includes('-----BEGIN PUBLIC KEY-----')) {
      pem = (await repositoryFile(root, source, `${label} key '${keyId}'`)).bytes.toString('utf8');
    }
    if (!pem.includes('-----BEGIN PUBLIC KEY-----') || /PRIVATE KEY/.test(pem)) {
      fail(`${label} entry '${keyId}' is not a public key.`, 'SGOS_TRUST_INPUT_INVALID');
    }
    result[keyId] = pem;
  }
  if (!Object.keys(result).length) fail(`${label} must contain at least one trust anchor.`, 'SGOS_TRUST_INPUT_INVALID');
  return Object.freeze(result);
}

function exactHash(options, key, label = `--${key}`) {
  const value = optionString(options, key);
  if (!HASH.test(String(value ?? ''))) fail(`${label} must be an exact sha256 digest.`, 'SGOS_DIGEST_REQUIRED');
  return value;
}

function requiredString(options, key, label = `--${key}`) {
  const value = optionString(options, key);
  if (!value) fail(`${label} is required.`, 'SGOS_OPTION_REQUIRED', { option: key });
  return value;
}

function cas(options) {
  const expectedRevision = optionNumber(options, 'expected-revision');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail('--expected-revision must be a non-negative safe integer.', 'SGOS_CAS_REQUIRED');
  }
  return {
    expectedRevision,
    expectedStateSha256: exactHash(options, 'expected-state-sha256')
  };
}

function storeId(options) {
  const id = optionString(options, 'store') ?? DEFAULT_STORE_ID;
  if (!STORE_ID.test(id) || WINDOWS_RESERVED_STORE_ID.test(id)) {
    fail('--store must be a portable canonical lower-case identifier.',
      'SGOS_AUTHORITY_STORE_ID_INVALID');
  }
  return id;
}

function authorityStoreLocation(root, options) {
  const id = storeId(options);
  const authorityRoot = path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'platform-authority', id);
  return { id, authorityRoot, stateFile: path.join(authorityRoot, 'state.json') };
}

async function authorityStore(root, options, { initialize = false } = {}) {
  const { id, authorityRoot, stateFile } = authorityStoreLocation(root, options);
  if (!initialize) {
    try { await lstat(stateFile); } catch (error) {
      if (error?.code === 'ENOENT') {
        fail(`Authority Store '${id}' is not initialized. Run: singularity-flow authority-store init --store ${id}.`,
          'SGOS_AUTHORITY_STORE_NOT_INITIALIZED', { storeId: id });
      }
      throw error;
    }
  }
  return openFilesystemAuthorityStore({ root: authorityRoot, storeId: id });
}

async function emit(value, options, operation, summary, {
  changed = false,
  externalSystemsChanged = false
} = {}) {
  const declared = {
    stateChanged: changed, filesChanged: changed,
    publicationCreated: operation === 'candidate.publish' && changed,
    externalSystemsChanged
  };
  return emitCommandResult(commandResult({
    operation: { id: operation, classification: MUTATIONS.has(operation) ? 'mutation' : 'read' },
    outcome: succeeded('sgos.reported', {
      summary: typeof summary === 'function' ? summary(value) : summary
    }),
    effects: Object.values(declared).some(Boolean) ? effects(declared) : noEffects(),
    restState: 'informational',
    data: { result: value }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}

function creator(root) {
  const observed = identity(root, { offline: true });
  return {
    kind: 'human', id: observed.email ?? observed.login ?? observed.name,
    name: observed.name, email: observed.email
  };
}

async function candidateCommand(root, positionals, options) {
  const action = positionals[1] ?? 'list';
  if (action === 'list') {
    const result = await listSgosCandidates(root);
    return emit(result, options, 'candidate.list', `${result.length} retained Candidate(s).`);
  }
  if (action === 'show') {
    const result = await readSgosRetainedCandidate(root, positionals[2]);
    return emit(result, options, 'candidate.show', `${result.candidate.candidateId} · ${result.candidate.candidateSha256}`);
  }
  if (action === 'freeze') {
    const result = await freezeSgosCandidate(root, {
      subjectId: optionString(options, 'subject') ?? path.basename(root), createdBy: creator(root)
    });
    return emit(result, options, 'candidate.freeze',
      `Retained ${result.candidate.candidateId} at ${result.candidate.candidateSha256}.`, { changed: true });
  }
  if (action === 'verify') {
    const commands = await jsonFile(root, optionString(options, 'commands'), '--commands', { array: true });
    const timeoutMs = optionNumber(options, 'timeout-ms', 15 * 60 * 1000);
    const result = await verifySgosCandidate(root, positionals[2], { commands, timeoutMs });
    return emit(result, options, 'candidate.verify',
      `Candidate verification ${result.status} at ${result.verificationReceiptSha256}.`, { changed: true });
  }
  if (action === 'publish') {
    const candidateId = positionals[2];
    const targetBranch = optionString(options, 'target-branch') ?? undefined;
    const remote = optionString(options, 'remote') ?? null;
    const confirmationSha256 = optionString(options, 'confirm');
    if (!confirmationSha256) {
      const plan = await planSgosCandidatePublication(root, candidateId, { targetBranch, remote });
      return emit(plan, options, 'candidate.publish.plan',
        `Review the exact Candidate publication plan, then repeat with --confirm ${plan.packetSha256}.`,
        { changed: true });
    }
    const result = await publishSgosCandidate(root, candidateId, {
      confirmationSha256, targetBranch, remote
    });
    return emit(result, options, 'candidate.publish',
      result.status === 'local-published-remote-pending'
        ? `Published ${result.candidateId} locally at ${result.publishedCommit}; remote '${result.remote?.remote ?? remote}' remains pending.`
        : `Published ${result.candidateId} exactly at ${result.publishedCommit}${remote ? ` to remote '${remote}'` : ''}.`, {
        changed: true,
        externalSystemsChanged: result.remote?.pushed === true && result.remote?.recovered !== true
      });
  }
  if (action === 'diff-argv') {
    const retained = await readSgosRetainedCandidate(root, positionals[2]);
    const result = candidateDiffArguments(retained);
    return emit(result, options, 'candidate.diff-argv', 'Exact Git diff arguments prepared; no command was executed.');
  }
  fail(`Unknown candidate action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function executionUnitCommand(root, positionals, options) {
  const action = positionals[1] ?? 'list';
  if (action === 'list') {
    const result = installedExecutionUnitManifests();
    return emit(result, options, 'execution-unit.list', `${result.length} installed Execution Unit(s).`);
  }
  if (action === 'doctor') {
    const requested = positionals[2] ?? 'all';
    const manifests = installedExecutionUnitManifests()
      .filter((manifest) => requested === 'all' || manifest.id === requested);
    if (!manifests.length) fail(`Execution Unit '${requested}' is not installed.`, 'SGOS_GEU_NOT_INSTALLED');
    const result = [];
    for (const manifest of manifests) {
      const unit = installedExecutionUnit(manifest.id, { root });
      result.push(await unit.doctor({ root }));
    }
    return emit(result, options, 'execution-unit.doctor',
      `${result.filter((entry) => entry.status === 'ready').length}/${result.length} Execution Unit(s) ready.`);
  }
  fail(`Unknown execution-unit action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function deviceCommand(root, positionals, options) {
  const action = positionals[1] ?? 'list';
  if (action === 'list') {
    const result = installedDeviceManifests();
    return emit(result, options, 'device.list', `${result.length} installed Device(s).`);
  }
  if (action === 'doctor') {
    const result = await doctorSgosDevice(root, positionals[2]);
    return emit(result, options, 'device.doctor', `Device attestation: ${result.status}.`);
  }
  if (action === 'invoke') {
    const request = await jsonFile(root, optionString(options, 'request'), '--request');
    const result = await invokeSgosDevice(root, request);
    return emit(result, options, 'device.invoke',
      `Recorded Tool Intent ${result.intent.intentSha256} and Result ${result.result.resultSha256}.`,
    { changed: result.recovered !== true });
  }
  if (action === 'recover') {
    const request = await jsonFile(root, optionString(options, 'request'), '--request');
    const result = await recoverSgosToolIntent(root, positionals[2], request);
    return emit(result, options, 'device.recover',
      `Recovered Tool Intent ${result.intent.intentSha256} without changing its identity.`,
    { changed: result.recovered !== true });
  }
  if (action === 'intent') {
    const result = await readSgosToolIntent(root, positionals[2]);
    return emit(result, options, 'device.intent', `Tool Intent ${result.intentSha256}.`);
  }
  if (action === 'result') {
    const result = await readSgosToolResult(root, positionals[2]);
    return emit(result, options, 'device.result', `Tool Result ${result.resultSha256} · ${result.status}.`);
  }
  if (action === 'revoke') {
    const result = await revokeSgosDevice(root, positionals[2], {
      reason: requiredString(options, 'reason'), confirmationSha256: optionString(options, 'confirm')
    });
    return emit(result, options, result.revoked ? 'device.revoke' : 'device.revoke.plan',
      result.revoked ? `Revoked exact Device manifest ${positionals[2]}.`
        : `Review the revocation, then repeat with --confirm ${result.confirmationSha256}.`,
    { changed: result.revoked });
  }
  fail(`Unknown device action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function authorityStoreCommand(root, positionals, options) {
  const action = positionals[1] ?? 'status';
  const { stateFile } = authorityStoreLocation(root, options);
  const existed = await lstat(stateFile).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  const store = await authorityStore(root, options, { initialize: action === 'init' });
  if (action === 'init' || action === 'status') {
    const state = await store.read();
    return emit({
      profile: store.profile, storeId: store.storeId, revision: state.revision,
      stateSha256: state.recordSha256, entryCount: Object.keys(state.entries).length
    }, options, `authority-store.${action}`,
    `Authority Store ${store.storeId} · revision ${state.revision} · ${state.recordSha256}.`,
    { changed: action === 'init' && !existed });
  }
  if (action === 'verify') {
    const result = await store.verify();
    return emit(result, options, 'authority-store.verify',
      `Authority Store ${result.storeId} passed lineage verification at revision ${result.revision}.`);
  }
  if (action === 'recover') {
    const confirmationSha256 = optionString(options, 'confirm');
    if (!confirmationSha256) {
      const result = await store.planRecovery();
      return emit(result, options, 'authority-store.recover.plan', result.required
        ? `Review the exact Authority Store recovery plan, then repeat with --confirm ${result.recoveryPlan.confirmationSha256}.`
        : `Authority Store ${result.storeId} requires no recovery.`);
    }
    if (!HASH.test(confirmationSha256)) {
      fail('--confirm must be the exact Authority Store recovery-plan digest.',
        'SGOS_AUTHORITY_RECOVERY_CONFIRMATION_REQUIRED');
    }
    const result = await store.recover({ confirmationSha256 });
    return emit(result, options, 'authority-store.recover', result.recovered
      ? `Recovered ${result.recoveredEventCount} exact Authority Store event(s).`
      : `Authority Store ${result.storeId} required no recovery.`,
    { changed: result.recovered === true });
  }
  fail(`Unknown authority-store action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function packRegistry(root, options) {
  const store = await authorityStore(root, options);
  const trustedPublishers = await publicTrustMap(root, optionString(options, 'trust'), '--trust');
  return {
    store, trustedPublishers,
    registry: createCapabilityPackRegistry({ authorityStore: store, trustedPublishers })
  };
}

async function packCommand(root, positionals, options) {
  const action = positionals[1] ?? 'list';
  const { store, registry, trustedPublishers } = await packRegistry(root, options);
  if (action === 'active') {
    const result = await registry.listActive();
    return emit(result, options, 'pack.active', `${result.length} active signed Capability Pack(s).`);
  }
  const verifyPackForRead = (signed) => {
    const keyId = signed?.record?.publisherKeyId;
    const trustedPublicKeyPem = trustedPublishers[keyId];
    if (!trustedPublicKeyPem) {
      fail(`Capability Pack publisher '${keyId ?? 'unknown'}' is not trusted.`, 'SGOS_CAPABILITY_PACK_UNTRUSTED');
    }
    return verifySignedPlatformRecord(signed, {
      trustedPublicKeyPem, expectedKeyId: keyId, expectedKind: 'platform-capability-pack'
    });
  };
  if (action === 'list') {
    const state = await store.read();
    const result = Object.values(state.entries)
      .filter((entry) => entry?.record?.kind === 'platform-capability-pack')
      .map(verifyPackForRead)
      .sort((left, right) => left.domain.localeCompare(right.domain)
        || left.packId.localeCompare(right.packId) || left.recordSha256.localeCompare(right.recordSha256));
    return emit(result, options, 'pack.list', `${result.length} trusted signed Capability Pack(s).`);
  }
  if (action === 'show') {
    const packSha256 = positionals[2];
    const state = await store.read();
    const signed = Object.values(state.entries).find((entry) => entry?.record?.recordSha256 === packSha256);
    if (!signed) fail(`Capability Pack '${packSha256}' is unavailable.`, 'SGOS_CAPABILITY_PACK_NOT_FOUND');
    const pack = verifyPackForRead(signed);
    return emit(pack, options, 'pack.show', `${pack.packId} · ${pack.domain} · ${pack.recordSha256}.`);
  }
  if (action === 'propose') {
    const signedPack = await jsonFile(root, optionString(options, 'signed-pack'), '--signed-pack');
    const result = await registry.propose(signedPack, { ...cas(options), actorId: requiredString(options, 'actor') });
    return emit(result, options, 'pack.propose', `Proposed signed Capability Pack ${result.recordSha256}.`, { changed: true });
  }
  if (action === 'review') {
    const review = await jsonFile(root, optionString(options, 'review'), '--review');
    const result = await registry.recordReview(review, cas(options));
    return emit(result, options, 'pack.review', `Recorded Pack review ${result.recordSha256} · ${result.decision}.`, { changed: true });
  }
  if (action === 'activate') {
    const result = await registry.activate({
      domain: requiredString(options, 'domain'),
      packSha256: exactHash(options, 'pack'),
      reviewSha256: exactHash(options, 'review-sha256'),
      confirmPackSha256: exactHash(options, 'confirm'),
      activatedBy: requiredString(options, 'activated-by'), ...cas(options)
    });
    return emit(result, options, 'pack.activate', `Activated ${result.packSha256} for ${result.domain}.`, { changed: true });
  }
  if (action === 'revoke') {
    const packSha256 = exactHash(options, 'pack');
    if (optionString(options, 'confirm') !== packSha256) {
      fail(`Pack revocation confirmation must equal ${packSha256}.`, 'SGOS_CAPABILITY_PACK_CONFIRMATION_MISMATCH');
    }
    const result = await registry.revoke({
      packSha256, revokedBy: requiredString(options, 'revoked-by'),
      reason: requiredString(options, 'reason'), ...cas(options)
    });
    return emit(result, options, 'pack.revoke', `Revoked Capability Pack ${result.packSha256}.`, { changed: true });
  }
  fail(`Unknown pack action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function learnCommand(root, positionals, options) {
  const action = positionals[1] ?? 'list';
  const { registry } = await packRegistry(root, options);
  const catalog = createReadOnlyLessonCatalog({ packRegistry: registry });
  const role = requiredString(options, 'role');
  if (action === 'list') {
    const result = await catalog.list({ role });
    return emit(result, options, 'learn.list', `${result.length} lesson(s) visible to ${role}.`);
  }
  if (action === 'show') {
    const result = await catalog.show({ role, lessonId: positionals[2] });
    return emit(result, options, 'learn.show', `${result.lessonId} · ${result.title}.`);
  }
  fail(`Unknown learn action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function memoryCommand(root, positionals, options) {
  const action = positionals[1] ?? 'inspect';
  const store = await authorityStore(root, options);
  const memory = createPlatformMemoryService({ authorityStore: store });
  if (action === 'inspect' || action === 'dependencies') {
    const result = await memory.inspect(positionals[2]);
    const output = action === 'dependencies'
      ? { memoryId: result.memoryId ?? positionals[2], available: result.available, valid: result.valid ?? null,
          dependencies: result.ref?.dependencies ?? [] }
      : result;
    return emit(output, options, `memory.${action}`, action === 'dependencies'
      ? `${output.dependencies.length} dependency reference(s).`
      : `Memory '${positionals[2]}' is ${result.available ? result.valid ? 'valid' : 'invalidated' : 'unavailable'}.`);
  }
  if (action === 'register') {
    const candidate = await jsonFile(root, optionString(options, 'candidate'), '--candidate');
    validatePlatformRecord(candidate, 'platform-memory-candidate');
    const result = await memory.registerCandidate(candidate, { ...cas(options), actorId: requiredString(options, 'actor') });
    return emit(result, options, 'memory.register', `Registered immutable Memory Candidate ${candidate.candidateId}.`, { changed: true });
  }
  if (action === 'promote') {
    const result = await memory.promote({
      candidateId: positionals[2], confirmCandidateSha256: exactHash(options, 'confirm'),
      reviewerId: requiredString(options, 'reviewer'), reason: requiredString(options, 'reason'),
      ...cas(options)
    });
    return emit(result, options, 'memory.promote',
      `Promoted Memory Candidate ${positionals[2]} at ${result.promotion.recordSha256}.`, { changed: true });
  }
  fail(`Unknown memory action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function metaToolService(root, options) {
  const store = await authorityStore(root, options);
  const trustedTraceIssuers = await publicTrustMap(root, optionString(options, 'trace-trust'), '--trace-trust');
  const trustedEvaluators = await publicTrustMap(root, optionString(options, 'evaluator-trust'), '--evaluator-trust');
  return { store, service: createMetaToolService({ authorityStore: store, trustedTraceIssuers, trustedEvaluators }) };
}

async function metaToolCommand(root, positionals, options) {
  const action = positionals[1] ?? 'list';
  if (action === 'list') {
    const store = await authorityStore(root, options);
    const state = await store.read();
    const result = Object.entries(state.entries)
      .filter(([key]) => key.startsWith('meta-candidate:') || key.startsWith('meta-evaluation:') || key.startsWith('meta-promotion:'))
      .map(([key, value]) => ({ key, kind: value?.record?.kind ?? value?.kind ?? null,
        sha256: value?.record?.recordSha256 ?? value?.recordSha256 ?? null }))
      .sort((left, right) => left.key.localeCompare(right.key));
    return emit(result, options, 'meta-tool.list', `${result.length} Meta-tool authority record(s).`);
  }
  const { service } = await metaToolService(root, options);
  if (action === 'propose') {
    const candidate = await jsonFile(root, optionString(options, 'candidate'), '--candidate');
    const traces = await jsonFile(root, optionString(options, 'traces'), '--traces', { array: true });
    const result = await service.propose(candidate, traces, { ...cas(options), actorId: requiredString(options, 'actor') });
    return emit(result, options, 'meta-tool.propose', `Proposed Meta-tool Candidate ${result.recordSha256}.`, { changed: true });
  }
  if (action === 'evaluation') {
    const evaluation = await jsonFile(root, optionString(options, 'evaluation'), '--evaluation');
    const result = await service.recordEvaluation(evaluation, { ...cas(options), actorId: requiredString(options, 'actor') });
    return emit(result, options, 'meta-tool.evaluation', `Recorded signed Meta-tool Evaluation ${result.recordSha256}.`, { changed: true });
  }
  if (action === 'promote') {
    const result = await service.promote({
      candidateSha256: exactHash(options, 'candidate-sha256'),
      evaluationSha256: exactHash(options, 'evaluation-sha256'),
      confirmCandidateSha256: exactHash(options, 'confirm-candidate'),
      confirmEvaluationSha256: exactHash(options, 'confirm-evaluation'),
      reviewerId: requiredString(options, 'reviewer'), decision: requiredString(options, 'decision'),
      reason: requiredString(options, 'reason'), ...cas(options)
    });
    return emit(result, options, 'meta-tool.promote',
      `Created reviewed Meta-tool promotion packet ${result.recordSha256}; Pack review is still required.`,
    { changed: true });
  }
  fail(`Unknown meta-tool action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

export async function run(_argv, { positionals, options }) {
  rejectSecretArgv(options);
  const root = repoRoot();
  const command = positionals[0];
  if (command === 'candidate') return candidateCommand(root, positionals, options);
  if (command === 'execution-unit') return executionUnitCommand(root, positionals, options);
  if (command === 'device') return deviceCommand(root, positionals, options);
  if (command === 'authority-store') return authorityStoreCommand(root, positionals, options);
  if (command === 'pack') return packCommand(root, positionals, options);
  if (command === 'learn') return learnCommand(root, positionals, options);
  if (command === 'memory') return memoryCommand(root, positionals, options);
  if (command === 'meta-tool') return metaToolCommand(root, positionals, options);
  fail(`Unknown SGOS extension command '${command}'.`, 'UNKNOWN_COMMAND');
}
