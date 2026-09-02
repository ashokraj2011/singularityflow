/**
 * Model-free CLI surfaces for the bounded SGOS extension profiles.
 *
 * Mutating inputs are read from repository-contained JSON files, not from ambient stdin or
 * credential-bearing argv. Every Authority Store mutation retains the service's exact CAS and
 * confirmation boundary; this dispatcher does not invent authority or weaken those checks.
 */
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir, identity, repoRoot } from '../git.mjs';
import { safePrivateSidecarDirectory } from '../private-sidecar.mjs';
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
  createAuthorityState, createReadOnlyLessonCatalog, openFilesystemAuthorityStore,
  planPortableAuthorityImport, platformSha256, validatePlatformRecord,
  verifyPortableAuthorityTransport, verifySignedPlatformRecord
} from '../sgos/platform/index.mjs';
import {
  authorityTransportContext, createLocalAuthorityTransportSigner, parseAuthorityTransport,
  serializeAuthorityTransport, SGOS_AUTHORITY_TRANSPORT_MAXIMUM_BYTES
} from '../sgos/authority-transport.mjs';
import {
  planGitTrustedAuthorityPublish, planGitTrustedAuthoritySync,
  publishGitTrustedAuthority, syncGitTrustedAuthority
} from '../sgos/authority-git-transport.mjs';
import {
  ensureSecureRepositoryDirectory, SingularityFlowError, optionBoolean, optionNumber,
  optionString, secureRepositoryPath
} from '../util.mjs';
import {
  createSgosCapabilityPackGitTrustedTrustScaffold,
  createSgosCapabilityPackTransportTrustScaffold,
  loadApprovedSgosCapabilityPackLocalTrust, loadApprovedSgosStateAuthority,
  SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED,
  SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED, SGOS_CAPABILITY_PACK_TRUST_FORMAT,
  sgosCapabilityPackTransportRepositoryBinding
} from '../sgos/capability-pack-authority.mjs';
import { validateSgosCliOptions } from '../sgos/cli-options.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
// New Stores and every transport-v2 action use the portable vocabulary. The wider identifier is
// read compatibility for an exact Store already named by approved v1 Pack trust on POSIX only.
const STORE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9_-])?$/;
const LEGACY_STORE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const WINDOWS_RESERVED_STORE_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_STORE_ID = 'repository-platform';
const MUTATIONS = new Set([
  'candidate.freeze', 'candidate.verify', 'candidate.publish.plan', 'candidate.publish',
  'device.invoke', 'device.recover', 'device.revoke',
  'authority-store.init', 'authority-store.recover', 'authority-store.signer-create',
  'authority-store.export', 'authority-store.import', 'authority-store.rollback',
  'authority-store.publish', 'authority-store.sync',
  'pack.propose', 'pack.review', 'pack.activate', 'pack.revoke',
  'memory.register', 'memory.promote',
  'meta-tool.propose', 'meta-tool.evaluation', 'meta-tool.promote'
]);

function fail(message, code = 'SGOS_EXTENSION_CLI_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function rejectSecretArgv(options) {
  const forbidden = Object.keys(options).filter((key) =>
    /(?:private[-_]?key|secret|password|credential|token)/i.test(key));
  if (forbidden.length) {
    fail('Private keys and secret material are never accepted in SGOS extension command arguments.',
      'SGOS_SECRET_ARGV_REFUSED', { forbidden });
  }
}

function rejectCallerPlatformIdentity(options) {
  const forbidden = ['actor', 'reviewer', 'activated-by', 'revoked-by']
    .filter((key) => Object.hasOwn(options, key));
  if (forbidden.length) {
    fail('SGOS platform mutation identities come from the repository Git identity and exact approved configuration; caller-supplied identity options are refused.',
      'SGOS_PLATFORM_CALLER_IDENTITY_REFUSED', { forbidden });
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

function localStoreId(options) {
  const id = optionString(options, 'store') ?? DEFAULT_STORE_ID;
  if (!LEGACY_STORE_ID.test(id)) {
    fail('--store must be a canonical lower-case identifier.',
      'SGOS_AUTHORITY_STORE_ID_INVALID');
  }
  return id;
}

function portableStoreId(options) {
  const id = localStoreId(options);
  if (!STORE_ID.test(id) || WINDOWS_RESERVED_STORE_ID.test(id)) {
    fail('--store must be a portable canonical lower-case identifier.',
      'SGOS_AUTHORITY_STORE_ID_INVALID');
  }
  return id;
}

function isPortableStoreId(id) {
  return STORE_ID.test(id) && !WINDOWS_RESERVED_STORE_ID.test(id);
}

function authorityStoreLocation(root, options) {
  const id = localStoreId(options);
  const authorityRoot = path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'platform-authority', id);
  return { id, authorityRoot, stateFile: path.join(authorityRoot, 'state.json') };
}

async function authorityTransportInput(root, candidate) {
  if (!candidate) fail('Authority transport file is required.',
    'SGOS_AUTHORITY_TRANSPORT_FILE_REQUIRED');
  const secured = await secureRepositoryPath(root, String(candidate), {
    label: 'Authority transport input', mustExist: true, type: 'file'
  });
  let handle;
  try {
    handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size > SGOS_AUTHORITY_TRANSPORT_MAXIMUM_BYTES) {
      fail('Authority transport input exceeds the installed portable bundle limit.',
        'SGOS_AUTHORITY_TRANSPORT_LIMIT');
    }
    const bytes = await handle.readFile();
    const rebound = await secureRepositoryPath(root, secured.relative, {
      label: 'Authority transport input', mustExist: true, type: 'file'
    });
    if ((before.ino !== 0 && rebound.entry?.ino !== before.ino)
        || (before.dev !== 0 && rebound.entry?.dev !== before.dev)) {
      fail('Authority transport input changed while it was read.',
        'SGOS_AUTHORITY_TRANSPORT_FILE_CHANGED');
    }
    return { signedTransport: parseAuthorityTransport(bytes), relative: secured.relative };
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail('Authority transport input cannot be a symbolic link.',
        'SGOS_AUTHORITY_TRANSPORT_PATH_UNSAFE');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function publishAuthorityTransport(root, candidate, bytes) {
  if (!candidate) fail('Authority export requires --out <REPOSITORY-FILE>.',
    'SGOS_AUTHORITY_TRANSPORT_OUTPUT_REQUIRED');
  let target = await secureRepositoryPath(root, String(candidate), {
    label: 'Authority transport output', mustExist: false, type: 'file'
  });
  if (target.exists) fail('Authority transport output already exists.',
    'SGOS_AUTHORITY_TRANSPORT_OUTPUT_EXISTS', { path: target.relative });
  const directory = await ensureSecureRepositoryDirectory(root, path.dirname(target.relative), {
    label: 'Authority transport output directory'
  });
  target = await secureRepositoryPath(root, target.relative, {
    label: 'Authority transport output', mustExist: false, type: 'file'
  });
  if (target.exists) fail('Authority transport output already exists.',
    'SGOS_AUTHORITY_TRANSPORT_OUTPUT_EXISTS', { path: target.relative });
  const temporary = path.join(directory.absolute,
    `.${path.basename(target.absolute)}.pending-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try { await link(temporary, target.absolute); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      fail('Authority transport output already exists.',
        'SGOS_AUTHORITY_TRANSPORT_OUTPUT_EXISTS', { path: target.relative });
    }
    await syncDirectory(directory.absolute);
    const observed = await readFile(target.absolute, 'utf8');
    if (observed !== bytes) {
      fail('Authority transport output changed during publication.',
        'SGOS_AUTHORITY_TRANSPORT_FILE_CHANGED');
    }
    return { path: target.relative, bytes: Buffer.byteLength(bytes, 'utf8'), sha256: platformSha256(bytes) };
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    await syncDirectory(directory.absolute);
  }
}

async function authorityStore(root, options, { initialize = false } = {}) {
  const { id, authorityRoot, stateFile } = authorityStoreLocation(root, options);
  const portable = isPortableStoreId(id);
  if (initialize && !portable) portableStoreId(options);
  if (!portable) {
    const trust = await loadApprovedSgosCapabilityPackLocalTrust(root);
    if (trust.format !== SGOS_CAPABILITY_PACK_TRUST_FORMAT || trust.storeId !== id) {
      fail(`Nonportable Authority Store '${id}' is available only when approved legacy-v1 Pack trust names that exact local Store.`,
        'SGOS_AUTHORITY_STORE_ID_INVALID', {
          requestedStoreId: id,
          approvedStoreId: trust.storeId,
          approvedFormat: trust.format
        });
    }
  }
  try {
    await safePrivateSidecarDirectory(root, path.dirname(authorityRoot), {
      create: initialize
    });
  } catch (error) {
    if (error?.code === 'ENOENT' && !initialize) {
      fail(`Authority Store '${id}' is not initialized. Run: singularity-flow authority-store init --store ${id}.`,
        'SGOS_AUTHORITY_STORE_NOT_INITIALIZED', { storeId: id });
    }
    if (error?.code === 'PRIVATE_SIDECAR_PATH_UNSAFE') {
      fail('Authority Store path must remain inside ordinary Git-common directories.',
        'SGOS_AUTHORITY_PATH_UNSAFE');
    }
    throw error;
  }
  if (!initialize) {
    try { await lstat(stateFile); } catch (error) {
      if (error?.code === 'ENOENT') {
        fail(`Authority Store '${id}' is not initialized. Run: singularity-flow authority-store init --store ${id}.`,
          'SGOS_AUTHORITY_STORE_NOT_INITIALIZED', { storeId: id });
      }
      throw error;
    }
  }
  return openFilesystemAuthorityStore({
    root: authorityRoot, storeId: id, allowLegacyStoreId: !portable
  });
}

async function emit(value, options, operation, summary, {
  changed = false, stateChanged = changed, filesChanged = changed,
  externalSystemsChanged = false
} = {}) {
  const declared = {
    stateChanged, filesChanged,
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
    const commands = Object.hasOwn(options, 'commands')
      ? await jsonFile(root, optionString(options, 'commands'), '--commands', { array: true })
      : null;
    const timeoutMs = Object.hasOwn(options, 'timeout-ms')
      ? optionNumber(options, 'timeout-ms', null) : null;
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
  if (action === 'trust-scaffold') {
    if (positionals.length !== 2) {
      fail('authority-store trust-scaffold accepts no positional arguments.', 'SGOS_POSITIONAL_INVALID');
    }
    const mode = requiredString(options, 'mode');
    if (mode !== SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED) {
      fail("--mode must be 'git-trusted'. Signed mode is bootstrapped with signer-create.",
        'SGOS_AUTHORITY_TRANSPORT_MODE_INVALID');
    }
    const storeId = portableStoreId(options);
    const stateAuthority = await loadApprovedSgosStateAuthority(root, { refreshAuthority: true });
    const trustScaffold = createSgosCapabilityPackGitTrustedTrustScaffold({
      root, storeId, stateRemote: stateAuthority.remote
    });
    return emit({ mode, storeId, stateAuthority, trustScaffold }, options,
      'authority-store.trust-scaffold',
      `Prepared key-free git-trusted Authority Store policy for ${stateAuthority.remote}/${stateAuthority.branch}. Review it through sflow/config before publishing.`);
  }

  if (['publish', 'sync'].includes(action)) {
    if (positionals.length !== 2) {
      fail(`authority-store ${action} accepts no positional arguments.`, 'SGOS_POSITIONAL_INVALID');
    }
    const confirmationSha256 = optionString(options, 'confirm');
    const requestedStoreId = Object.hasOwn(options, 'store') ? portableStoreId(options) : null;
    const result = action === 'publish'
      ? confirmationSha256
        ? await publishGitTrustedAuthority(root, { confirmationSha256, expectedStoreId: requestedStoreId })
        : await planGitTrustedAuthorityPublish(root, { expectedStoreId: requestedStoreId })
      : confirmationSha256
        ? await syncGitTrustedAuthority(root, { confirmationSha256, expectedStoreId: requestedStoreId })
        : await planGitTrustedAuthoritySync(root, { expectedStoreId: requestedStoreId });
    const applied = Boolean(confirmationSha256);
    return emit(result, options,
      applied ? `authority-store.${action}` : `authority-store.${action}.plan`,
      applied
        ? `${result.changed ? action === 'publish' ? 'Published' : 'Synchronized' : 'Confirmed current'} Authority Store ${result.storeId} revision ${result.revision} ${action === 'publish' ? 'on' : 'from'} ${result.remote}/${result.branch}.`
        : `Review the exact git-trusted ${action} plan, then repeat with --confirm ${result.plan.confirmationSha256}.`,
      { changed: applied && result.changed });
  }

  if (action === 'signer-create') {
    if (positionals.length !== 2) {
      fail('authority-store signer-create accepts no positional arguments.', 'SGOS_POSITIONAL_INVALID');
    }
    // Complete every deterministic bootstrap check before creating private material. A malformed
    // Store ID or unverifiable repository must not leave behind a signer from a failed command.
    const scaffoldStoreId = portableStoreId(options);
    const repositoryBinding = sgosCapabilityPackTransportRepositoryBinding(root);
    const signer = await createLocalAuthorityTransportSigner(
      root, requiredString(options, 'signer')
    );
    const trustScaffold = createSgosCapabilityPackTransportTrustScaffold({
      root, storeId: scaffoldStoreId,
      signerKeyId: signer.keyId, signerPublicKeyPem: signer.publicKeyPem,
      repositoryBinding
    });
    const result = Object.freeze({ ...signer, trustScaffold });
    return emit(result, options, 'authority-store.signer-create',
      `${result.created ? 'Created' : 'Reused'} local Ed25519 Authority transport signer '${result.keyId}'. Review its complete v2 trust scaffold through sflow/config before exporting.`,
      { changed: result.created });
  }

  if (['export', 'inspect', 'import', 'rollback'].includes(action)) {
    if (['inspect', 'import'].includes(action)) {
      if (positionals.length !== 3 || !positionals[2]) {
        fail(`authority-store ${action} requires exactly one repository-contained bundle file.`,
          'SGOS_AUTHORITY_TRANSPORT_FILE_REQUIRED');
      }
    } else if (positionals.length !== 2) {
      fail(`authority-store ${action} accepts no positional arguments.`, 'SGOS_POSITIONAL_INVALID');
    }
    if (action === 'export') {
      requiredString(options, 'signer');
      if (!optionString(options, 'out')) {
        fail('Authority export requires --out <REPOSITORY-FILE>.',
          'SGOS_AUTHORITY_TRANSPORT_OUTPUT_REQUIRED');
      }
    }
    if (action === 'rollback') exactHash(options, 'receipt', '--receipt');
    const requestedStoreId = optionString(options, 'store');
    const mutation = action === 'export'
      ? 'authority-store.export'
      : action === 'import' && optionString(options, 'confirm')
        ? 'authority-store.import'
        : action === 'rollback' && optionString(options, 'confirm')
          ? 'authority-store.rollback'
          : null;
    const context = await authorityTransportContext(root, mutation, {
      signer: action === 'export' ? requiredString(options, 'signer') : null
    });
    if (action !== 'rollback'
        && context.trust.mode !== SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED) {
      fail(`authority-store ${action} requires signed v2 transport; approved configuration selects git-trusted v3. Use authority-store ${action === 'export' ? 'publish' : 'sync'} instead.`,
        'SGOS_AUTHORITY_TRANSPORT_MODE_MISMATCH');
    }
    const trustedStoreId = context.trust.storeId;
    if (requestedStoreId != null && requestedStoreId !== trustedStoreId) {
      fail('Requested Authority Store does not equal approved transport trust.',
        'SGOS_AUTHORITY_TRANSPORT_STORE_MISMATCH', {
          requestedStoreId, approvedStoreId: trustedStoreId
        });
    }
    const transportOptions = {
      expectedRepositoryBindingSha256: context.trust.repositoryBindingSha256,
      expectedPolicySha256: context.trust.policySha256,
      authorityContextSha256: context.trust.authorityContextSha256,
      minimumAuthority: context.trust.minimumAuthority,
      validateEntries: context.validateEntries
    };

    if (action !== 'export' && context.trust.minimumAuthority == null) {
      const remedy = context.trust.mode === SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED
        ? 'Publish the current Store, review its revision/state/projection digests into capability-pack-trust.json v3, publish sflow/config, and retry.'
        : 'Export the current Store, review its revision/state/export digests into capability-pack-trust.json v2, publish sflow/config, and retry.';
      fail(`Approved transport trust has no anti-rollback checkpoint. ${remedy}`,
        'SGOS_AUTHORITY_TRANSPORT_CONFIGURATION_STALE');
    }

    if (action === 'export') {
      const store = await authorityStore(root, { ...options, store: trustedStoreId });
      const signedTransport = await store.exportTransport({
        privateKeyPem: context.signer.privateKeyPem,
        keyId: context.signer.keyId,
        repositoryBindingSha256: context.trust.repositoryBindingSha256,
        policySha256: context.trust.policySha256,
        authorization: context.authorization,
        validateEntries: context.validateEntries
      });
      const bytes = serializeAuthorityTransport(signedTransport);
      const output = await publishAuthorityTransport(root, optionString(options, 'out'), bytes);
      const result = {
        status: 'exported', storeId: trustedStoreId,
        revision: signedTransport.record.head.revision,
        stateSha256: signedTransport.record.head.recordSha256,
        eventSha256: signedTransport.record.head.eventSha256,
        exportSha256: signedTransport.record.recordSha256,
        signedTransportSha256: platformSha256(signedTransport),
        repositoryBindingSha256: signedTransport.record.repositoryBindingSha256,
        signer: {
          keyId: context.signer.keyId, algorithm: 'ed25519',
          publicKeySha256: context.signer.publicKeySha256
        },
        capabilityPacks: await context.validateEntries(signedTransport.record.head.entries),
        output,
        credentialScan: { clean: true, findings: 0 }
      };
      return emit(result, options, 'authority-store.export',
        `Exported signed Authority Store ${trustedStoreId} revision ${result.revision} to ${output.path}.`,
        { changed: true, stateChanged: false, filesChanged: true });
    }

    if (action === 'rollback') {
      const store = await authorityStore(root, { ...options, store: trustedStoreId });
      const cutoverSha256 = exactHash(options, 'receipt', '--receipt');
      const confirmationSha256 = optionString(options, 'confirm');
      const rollbackMinimumAuthority = context.trust.mode
          === SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED
        ? context.trust.minimumAuthority
        : null;
      if (!confirmationSha256) {
        const result = await store.planRollback({
          cutoverSha256,
          validateRollback: context.validateRollback,
          authorityContextSha256: context.trust.authorityContextSha256,
          minimumAuthority: rollbackMinimumAuthority
        });
        return emit(result, options, 'authority-store.rollback.plan',
          `Review the exact Authority rollback plan, then repeat with --confirm ${result.plan.confirmationSha256}.`);
      }
      const result = await store.rollbackTransport({
        cutoverSha256, confirmationSha256,
        authorization: context.authorization,
        validateRollback: context.validateRollback,
        authorityContextSha256: context.trust.authorityContextSha256,
        minimumAuthority: rollbackMinimumAuthority
      });
      return emit(result, options, 'authority-store.rollback',
        `Rolled Authority Store ${trustedStoreId} back to revision ${result.current.revision}.`,
        { changed: true });
    }

    const input = await authorityTransportInput(root, positionals[2]);
    const keyId = input.signedTransport?.signature?.keyId;
    const trustedPublicKeyPem = context.trust.exporters[keyId];
    if (!trustedPublicKeyPem) {
      fail('Authority transport signer is not trusted by current approved configuration.',
        'SGOS_AUTHORITY_TRANSPORT_SIGNER_UNTRUSTED', { keyId: keyId ?? null });
    }
    const inputOptions = {
      ...transportOptions,
      signedTransport: input.signedTransport,
      trustedPublicKeyPem,
      expectedKeyId: keyId
    };
    const { stateFile } = authorityStoreLocation(root, { ...options, store: trustedStoreId });
    const exists = await lstat(stateFile).then((entry) => entry.isFile() && !entry.isSymbolicLink())
      .catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error));
    let planned;
    if (exists) {
      const store = await authorityStore(root, { ...options, store: trustedStoreId });
      planned = await store.planImport(inputOptions);
    } else {
      const transport = await verifyPortableAuthorityTransport(input.signedTransport, {
        ...inputOptions
      });
      const genesis = createAuthorityState({
        storeId: trustedStoreId,
        revision: 0,
        eventSha256: null,
        entriesSha256: platformSha256({}),
        entries: {}
      });
      planned = {
        transport,
        plan: planPortableAuthorityImport(genesis, [], transport, {
          authorityContextSha256: context.trust.authorityContextSha256
        })
      };
    }
    const report = {
      status: planned.plan.mode === 'noop' ? 'noop' : 'ready',
      trusted: true,
      repositoryMatch: true,
      file: input.relative,
      exportSha256: planned.transport.exportSha256,
      source: {
        storeId: planned.transport.storeId,
        revision: planned.transport.revision,
        stateSha256: planned.transport.stateSha256,
        eventSha256: planned.transport.eventSha256
      },
      destination: {
        exists,
        revision: planned.plan.beforeRevision,
        stateSha256: planned.plan.beforeStateSha256
      },
      mode: planned.plan.mode,
      capabilityPacks: planned.transport.semantic,
      plan: planned.plan
    };
    if (action === 'inspect') {
      return emit(report, options, 'authority-store.inspect',
        `Verified signed Authority transport ${report.exportSha256}; destination mode is ${report.mode}.`);
    }
    const confirmationSha256 = optionString(options, 'confirm');
    if (!confirmationSha256) {
      return emit(report, options, 'authority-store.import.plan',
        `Review the exact Authority import plan, then repeat with --confirm ${report.plan.confirmationSha256}.`);
    }
    // The first import plans against a virtual genesis Store. Validate that exact plan before
    // opening the filesystem adapter, because opening an absent Store durably writes genesis.
    // The adapter repeats this check under its cutover/transaction locks to close the later race.
    if (confirmationSha256 !== report.plan.confirmationSha256) {
      fail('Authority import confirmation does not match the exact current plan.',
        'SGOS_AUTHORITY_TRANSPORT_PLAN_STALE', {
          requiredConfirmationSha256: report.plan.confirmationSha256
        });
    }
    const store = await authorityStore(root, { ...options, store: trustedStoreId }, {
      initialize: true
    });
    const result = await store.importTransport({
      ...inputOptions,
      confirmationSha256,
      authorization: context.authorization
    });
    return emit(result, options, 'authority-store.import', result.changed
      ? `Imported Authority Store ${trustedStoreId} at revision ${result.current.revision}; rollback receipt ${result.cutoverSha256}.`
      : `Authority Store ${trustedStoreId} already equals the signed transport.`,
    { changed: result.changed });
  }

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
    registry: createCapabilityPackRegistry({
      authorityStore: store, trustedPublishers, repositoryRoot: root
    })
  };
}

async function packCommand(root, positionals, options) {
  const action = positionals[1] ?? 'list';
  if (['propose', 'review', 'activate', 'revoke'].includes(action)) {
    rejectCallerPlatformIdentity(options);
  }
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
    const result = await registry.propose(signedPack, cas(options));
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
      confirmPackSha256: exactHash(options, 'confirm'), ...cas(options)
    });
    return emit(result, options, 'pack.activate', `Activated ${result.packSha256} for ${result.domain}.`, { changed: true });
  }
  if (action === 'revoke') {
    const packSha256 = exactHash(options, 'pack');
    if (optionString(options, 'confirm') !== packSha256) {
      fail(`Pack revocation confirmation must equal ${packSha256}.`, 'SGOS_CAPABILITY_PACK_CONFIRMATION_MISMATCH');
    }
    const result = await registry.revoke({
      packSha256, reason: requiredString(options, 'reason'), ...cas(options)
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
  const packId = optionString(options, 'pack') ?? null;
  if (action === 'list') {
    const result = await catalog.list({ role, packId });
    return emit(result, options, 'learn.list', `${result.length} lesson(s) visible to ${role}.`);
  }
  if (action === 'show') {
    const result = await catalog.show({ role, lessonId: positionals[2], packId });
    return emit(result, options, 'learn.show', `${result.lessonId} · ${result.title}.`);
  }
  if (['start', 'inspect', 'explain-change', 'quiz', 'teach-back'].includes(action)) {
    const module = await jsonFile(root, optionString(options, 'module'), '--module');
    const request = { role, lessonId: positionals[2], packId, module };
    if (action === 'start') {
      const result = await catalog.start(request);
      return emit(result, options, 'learn.start',
        `Prepared read-only mission ${result.missionId}; no fixture was materialized or executed.`);
    }
    if (action === 'inspect') {
      const result = await catalog.inspect(request);
      return emit(result, options, 'learn.inspect',
        `${result.counts.steps} bounded mission step(s) · ${result.counts.completionChecks} completion check(s).`);
    }
    if (action === 'explain-change') {
      const result = await catalog.explainChange({ ...request, stepId: positionals[3] });
      return emit(result, options, 'learn.explain-change',
        `Step ${result.stepId} changes no repository, Git, Device, or governed Process state.`);
    }
    const answer = await jsonFile(root, optionString(options, 'answers'), '--answers');
    if (action === 'quiz') {
      const result = await catalog.quiz({ ...request, checkId: positionals[3], answer });
      return emit(result, options, 'learn.quiz',
        `Quiz ${result.checkId}: ${result.status}; this is not certification or authority.`);
    }
    const result = await catalog.teachBack({ ...request, checkId: positionals[3], answer });
    return emit(result, options, 'learn.teach-back',
      `Teach-back ${result.checkId}: ${result.status}; concept presence is not employee scoring.`);
  }
  fail(`Unknown learn action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function memoryCommand(root, positionals, options) {
  const action = positionals[1] ?? 'inspect';
  if (['register', 'promote'].includes(action)) rejectCallerPlatformIdentity(options);
  const store = await authorityStore(root, options);
  const memory = createPlatformMemoryService({ authorityStore: store, repositoryRoot: root });
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
    const result = await memory.registerCandidate(candidate, cas(options));
    return emit(result, options, 'memory.register', `Registered immutable Memory Candidate ${candidate.candidateId}.`, { changed: true });
  }
  if (action === 'promote') {
    const result = await memory.promote({
      candidateId: positionals[2], confirmCandidateSha256: exactHash(options, 'confirm'),
      reason: requiredString(options, 'reason'),
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
  return {
    store,
    service: createMetaToolService({
      authorityStore: store, trustedTraceIssuers, trustedEvaluators, repositoryRoot: root
    })
  };
}

async function metaToolCommand(root, positionals, options) {
  const action = positionals[1] ?? 'list';
  if (['propose', 'evaluation', 'promote'].includes(action)) {
    rejectCallerPlatformIdentity(options);
  }
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
    const result = await service.propose(candidate, traces, cas(options));
    return emit(result, options, 'meta-tool.propose', `Proposed Meta-tool Candidate ${result.recordSha256}.`, { changed: true });
  }
  if (action === 'evaluation') {
    const evaluation = await jsonFile(root, optionString(options, 'evaluation'), '--evaluation');
    const result = await service.recordEvaluation(evaluation, cas(options));
    return emit(result, options, 'meta-tool.evaluation', `Recorded signed Meta-tool Evaluation ${result.recordSha256}.`, { changed: true });
  }
  if (action === 'promote') {
    const result = await service.promote({
      candidateSha256: exactHash(options, 'candidate-sha256'),
      evaluationSha256: exactHash(options, 'evaluation-sha256'),
      confirmCandidateSha256: exactHash(options, 'confirm-candidate'),
      confirmEvaluationSha256: exactHash(options, 'confirm-evaluation'),
      decision: requiredString(options, 'decision'),
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
  const command = positionals[0];
  const action = positionals[1] ?? ({
    candidate: 'list', 'execution-unit': 'list', device: 'list', 'authority-store': 'status',
    pack: 'list', learn: 'list', memory: 'inspect', 'meta-tool': 'list'
  }[command]);
  validateSgosCliOptions(command, action, options);
  const root = repoRoot();
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
