/** Git-trusted SGOS Authority Store publication and synchronization service. */
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  exactRemoteBranchObservation, gitCommonDir
} from '../git.mjs';
import {
  materializeStateBranchPublicationAuthority, publishToStateBranch
} from '../ledger.mjs';
import { canonicalJson } from '../records.mjs';
import {
  configuredRemoteIdentity, frozenRemoteTransport
} from '../git-remote-diagnostics.mjs';
import { runRemoteGit } from '../git-execution.mjs';
import { safePrivateSidecarDirectory } from '../private-sidecar.mjs';
import { run, SingularityFlowError } from '../util.mjs';
import {
  authorityTransportEntryValidator, parseAuthorityTransport,
  SGOS_AUTHORITY_TRANSPORT_MAXIMUM_BYTES
} from './authority-transport.mjs';
import {
  loadApprovedSgosCapabilityPackTransportTrust,
  SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED
} from './capability-pack-authority.mjs';
import { loadApprovedPlatformMutationAuthority } from './platform/authority.mjs';
import {
  assertPortableAuthorityStoreId, createAuthorityState,
  openFilesystemAuthorityStore, planAuthorityGitProjectionImport, platformSha256,
  verifyAuthorityGitProjection
} from './platform/index.mjs';

const PROJECTION_ROOT = 'singularity/sgos/authority-stores';
const READ_REF = 'refs/sflow/authority-state-read';
const COMMIT = /^[a-f0-9]{40,64}$/u;

function fail(message, code = 'SGOS_AUTHORITY_GIT_STATE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function absoluteRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    fail('Git-trusted Authority Store operations require an explicit absolute repository root.',
      'SGOS_PLATFORM_REPOSITORY_REQUIRED');
  }
  return path.resolve(root);
}

export function gitTrustedAuthorityProjectionPath(storeId) {
  assertPortableAuthorityStoreId(storeId);
  return `${PROJECTION_ROOT}/${storeId}/current.json`;
}

function ledgerConfig(trust) {
  return Object.freeze({
    enabled: true,
    remote: trust.stateAuthority.remote,
    branch: trust.stateAuthority.branch
  });
}

function digest(value) {
  return platformSha256(value);
}

function safeTargetIdentity(root, trust) {
  const config = ledgerConfig(trust);
  const fetchIdentity = configuredRemoteIdentity(root, config.remote, { direction: 'fetch' });
  const pushIdentity = configuredRemoteIdentity(root, config.remote, { direction: 'push' });
  if (!fetchIdentity.configured || fetchIdentity.ambiguous || !fetchIdentity.url
      || !pushIdentity.configured || pushIdentity.ambiguous || !pushIdentity.url) {
    fail(
      `Git-trusted Authority Store requires one exact configured remote '${config.remote}'.`,
      'SGOS_AUTHORITY_GIT_REMOTE_UNAVAILABLE', { remote: config.remote }
    );
  }
  // Git-trusted authority is bound to the raw, reviewed repository configuration. Never resolve
  // it with `git remote get-url`: that command applies mutable machine-level insteadOf rules. The
  // frozen transport below addresses these exact raw URLs without allowing a second rewrite pass.
  // A distinct pushurl is also refused because a fresh clone of the fetch repository could not
  // discover authority published somewhere else.
  if (fetchIdentity.fingerprint !== pushIdentity.fingerprint) {
    fail(
      `Git-trusted Authority Store remote '${config.remote}' has different fetch and push targets.`,
      'SGOS_AUTHORITY_GIT_REMOTE_MISMATCH', { remote: config.remote }
    );
  }
  return Object.freeze({
    config,
    remote: config.remote,
    branch: config.branch,
    targetRef: `refs/heads/${config.branch}`,
    configuredUrlSha256: `sha256:${fetchIdentity.fingerprint}`,
    effectivePushUrlSha256: `sha256:${pushIdentity.fingerprint}`,
    effectiveFetchUrlSha256: `sha256:${fetchIdentity.fingerprint}`,
    effectivePushUrl: pushIdentity.url,
    effectiveFetchUrl: fetchIdentity.url
  });
}

function observeRemote(root, target) {
  const observed = exactRemoteBranchObservation(
    root, target.effectiveFetchUrl, target.branch
  );
  if (!observed.reachable) {
    fail(
      `Git-trusted Authority Store state branch '${target.remote}/${target.branch}' is unreachable.`,
      'SGOS_AUTHORITY_GIT_REMOTE_UNAVAILABLE', { remote: target.remote, branch: target.branch }
    );
  }
  if (observed.malformed) {
    fail(
      `Git-trusted Authority Store state branch '${target.remote}/${target.branch}' has an ambiguous advertisement.`,
      'SGOS_AUTHORITY_GIT_REMOTE_INVALID', { remote: target.remote, branch: target.branch }
    );
  }
  if (!COMMIT.test(String(observed.sha ?? ''))) {
    fail(
      `Git-trusted Authority Store requires the existing remote state branch '${target.remote}/${target.branch}'.`,
      'SGOS_AUTHORITY_GIT_STATE_BRANCH_MISSING', {
        remote: target.remote, branch: target.branch
      }
    );
  }
  return observed.sha;
}

function assertSameObservation(root, target, expectedCommit) {
  const current = observeRemote(root, target);
  if (current !== expectedCommit) {
    fail('Git-trusted Authority Store state changed after it was reviewed.',
      'SGOS_AUTHORITY_GIT_PLAN_STALE', {
        remote: target.remote, branch: target.branch,
        expectedStateCommit: expectedCommit, currentStateCommit: current
      });
  }
  return current;
}

async function isolatedRemoteFile(root, target, stateCommit, relative, { optional = false } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-authority-state-read-'));
  try {
    const initialized = run('git', ['init', '--bare', '--quiet'], {
      cwd: temporary, allowFailure: true
    });
    if (initialized.status !== 0) {
      fail('Unable to create the isolated Authority Store state reader.',
        'SGOS_AUTHORITY_GIT_REMOTE_UNAVAILABLE');
    }
    const frozen = frozenRemoteTransport(target.effectiveFetchUrl);
    const fetched = runRemoteGit([
      'fetch', '--no-tags', '--depth=1', '--', frozen.remote,
      `${target.targetRef}:${READ_REF}`
    ], {
      cwd: temporary, operation: 'remote-configuration', env: frozen.env, allowFailure: true
    });
    if (fetched.status !== 0) {
      fail('Unable to read the reviewed Git-trusted Authority Store state commit.',
        'SGOS_AUTHORITY_GIT_REMOTE_UNAVAILABLE', {
          remote: target.remote, branch: target.branch
        });
    }
    const fetchedCommit = run('git', ['rev-parse', '--verify', `${READ_REF}^{commit}`], {
      cwd: temporary, allowFailure: true
    }).stdout.trim();
    if (fetchedCommit !== stateCommit) {
      fail('Git-trusted Authority Store state changed while its projection was read.',
        'SGOS_AUTHORITY_GIT_PLAN_STALE', {
          expectedStateCommit: stateCommit, currentStateCommit: fetchedCommit || null
        });
    }
    const object = `${stateCommit}:${relative}`;
    const type = run('git', ['cat-file', '-t', object], {
      cwd: temporary, allowFailure: true
    });
    if (type.status !== 0) {
      if (optional) return null;
      fail(`Git-trusted Authority Store projection '${relative}' is absent from the state branch.`,
        'SGOS_AUTHORITY_GIT_PROJECTION_MISSING', { stateCommit, path: relative });
    }
    if (type.stdout.trim() !== 'blob') {
      fail(`Git-trusted Authority Store projection '${relative}' is not a file.`,
        'SGOS_AUTHORITY_GIT_PROJECTION_INVALID', { stateCommit, path: relative });
    }
    const sizeText = run('git', ['cat-file', '-s', object], {
      cwd: temporary, allowFailure: true
    }).stdout.trim();
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size <= 0
        || size > SGOS_AUTHORITY_TRANSPORT_MAXIMUM_BYTES) {
      fail('Git-trusted Authority Store projection exceeds its bounded file limit.',
        'SGOS_AUTHORITY_TRANSPORT_LIMIT', { stateCommit, path: relative });
    }
    const shown = run('git', ['cat-file', 'blob', object], {
      cwd: temporary, allowFailure: true, encoding: 'buffer',
      maxBuffer: SGOS_AUTHORITY_TRANSPORT_MAXIMUM_BYTES + 1024
    });
    if (shown.status !== 0 || shown.stdout.length !== size) {
      fail('Git-trusted Authority Store projection could not be read completely.',
        'SGOS_AUTHORITY_GIT_PROJECTION_INVALID', { stateCommit, path: relative });
    }
    assertSameObservation(root, target, stateCommit);
    return shown.stdout;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function trustContext(root, { expectedStoreId = null } = {}) {
  const trust = await loadApprovedSgosCapabilityPackTransportTrust(root, {
    refreshAuthority: true
  });
  if (trust.mode !== SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED
      || !trust.stateAuthority) {
    fail('Approved Capability Pack trust is not configured for git-trusted transport.',
      'SGOS_CAPABILITY_PACK_GIT_TRUST_REQUIRED');
  }
  if (expectedStoreId !== null && expectedStoreId !== trust.storeId) {
    fail('Requested Authority Store does not equal approved git-trusted policy.',
      'SGOS_AUTHORITY_TRANSPORT_STORE_MISMATCH', {
        requestedStoreId: expectedStoreId, approvedStoreId: trust.storeId
      });
  }
  const target = safeTargetIdentity(root, trust);
  return Object.freeze({
    trust,
    target,
    validateEntries: authorityTransportEntryValidator(trust.publishers)
  });
}

async function approvedAuthorization(root, operation, context) {
  const authorization = await loadApprovedPlatformMutationAuthority(root, operation);
  if (authorization.configurationCommit !== context.trust.configurationAuthority.commit) {
    fail('Approved git-trusted policy and mutation authority changed between verified reads.',
      'SGOS_AUTHORITY_GIT_CONFIGURATION_STALE', {
        trustCommit: context.trust.configurationAuthority.commit,
        authorizationCommit: authorization.configurationCommit
      });
  }
  return authorization;
}

function storeStateFile(root, storeId) {
  return path.join(
    gitCommonDir(root), 'singularity-flow', 'sgos', 'platform-authority', storeId,
    'state.json'
  );
}

async function openLocalStore(root, storeId) {
  const parent = path.join(
    gitCommonDir(root), 'singularity-flow', 'sgos', 'platform-authority'
  );
  try {
    await safePrivateSidecarDirectory(root, parent, { create: true });
  } catch (error) {
    if (error?.code === 'PRIVATE_SIDECAR_PATH_UNSAFE') {
      fail('Authority Store path must remain inside ordinary Git-common directories.',
        'SGOS_AUTHORITY_PATH_UNSAFE');
    }
    throw error;
  }
  return openFilesystemAuthorityStore({
    root: path.join(parent, storeId), storeId
  });
}

async function hasLocalStore(root, storeId) {
  const info = await lstat(storeStateFile(root, storeId)).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  });
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

function publicTarget(target) {
  return Object.freeze({
    remote: target.remote,
    branch: target.branch,
    targetRef: target.targetRef,
    configuredUrlSha256: target.configuredUrlSha256,
    effectiveFetchUrlSha256: target.effectiveFetchUrlSha256,
    effectivePushUrlSha256: target.effectivePushUrlSha256
  });
}

function trustPlanFields(context) {
  const { trust, target } = context;
  return {
    mode: SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED,
    remote: target.remote,
    branch: target.branch,
    projectionPath: gitTrustedAuthorityProjectionPath(trust.storeId),
    repositoryBindingSha256: trust.repositoryBindingSha256,
    policySha256: trust.policySha256,
    authorityContextSha256: trust.authorityContextSha256,
    configurationAuthority: trust.configurationAuthority,
    target: publicTarget(target)
  };
}

function assertContextMatchesPreview(context, preview) {
  const expected = trustPlanFields(context);
  const reviewed = Object.fromEntries(Object.keys(expected).map((key) => [key, preview[key]]));
  if (canonicalJson(expected) !== canonicalJson(reviewed)) {
    fail('Approved git-trusted configuration changed after confirmation.',
      'SGOS_AUTHORITY_GIT_CONFIGURATION_STALE');
  }
}

function plannedResult(operation, fields) {
  const core = deepFreeze({
    kind: `sgos-authority-git-${operation}-plan`,
    operation: `authority-store.${operation}`,
    ...fields
  });
  const plan = deepFreeze({ ...core, confirmationSha256: digest(core) });
  return deepFreeze({ ...fields, operation: core.operation, plan });
}

async function verifyProjectionForState(projection, context, stateCommit) {
  return verifyAuthorityGitProjection(projection, {
    expectedStoreId: context.trust.storeId,
    expectedRepositoryBindingSha256: context.trust.repositoryBindingSha256,
    expectedPolicySha256: context.trust.policySha256,
    expectedStateBranch: context.target.branch,
    stateBranch: context.target.branch,
    stateCommit,
    minimumAuthority: context.trust.minimumAuthority,
    validateEntries: context.validateEntries
  });
}

export async function planGitTrustedAuthorityPublish(root, { expectedStoreId = null } = {}) {
  const repositoryRoot = absoluteRoot(root);
  const context = await trustContext(repositoryRoot, { expectedStoreId });
  if (!await hasLocalStore(repositoryRoot, context.trust.storeId)) {
    fail(`Authority Store '${context.trust.storeId}' is not initialized.`,
      'SGOS_AUTHORITY_STORE_NOT_INITIALIZED', { storeId: context.trust.storeId });
  }
  const stateCommit = observeRemote(repositoryRoot, context.target);
  const store = await openLocalStore(repositoryRoot, context.trust.storeId);
  const projection = await store.exportGitProjection({
    repositoryBindingSha256: context.trust.repositoryBindingSha256,
    policySha256: context.trust.policySha256,
    validateEntries: context.validateEntries
  });
  // Treat the local projection as untrusted input before it can replace shared authority. This
  // enforces the approved anti-rollback floor even when the Store was created locally rather than
  // imported from Git.
  const verifiedLocal = await verifyProjectionForState(projection, context, stateCommit);
  const projectionBytes = canonicalJson(projection);
  const relative = gitTrustedAuthorityProjectionPath(context.trust.storeId);
  const published = await isolatedRemoteFile(
    repositoryRoot, context.target, stateCommit, relative, { optional: true }
  );
  let publicationMode = 'install';
  let remoteProjectionSha256 = null;
  let remoteRevision = null;
  let remoteStateSha256 = null;
  if (published !== null) {
    const remoteProjection = parseAuthorityTransport(published);
    const verifiedRemote = await verifyProjectionForState(
      remoteProjection, context, stateCommit
    );
    // Publishing is an ordinary forward-only import into the shared state plane. Reusing the
    // lineage planner makes stale and divergent publishers fail before mutation or authorization.
    const advance = planAuthorityGitProjectionImport(
      verifiedRemote.record.head, verifiedRemote.record.events, verifiedLocal, {
        authorityContextSha256: context.trust.authorityContextSha256
      }
    );
    publicationMode = advance.mode;
    remoteProjectionSha256 = verifiedRemote.projectionSha256;
    remoteRevision = verifiedRemote.revision;
    remoteStateSha256 = verifiedRemote.stateSha256;
  }
  const changed = publicationMode !== 'noop';
  // Bind the Store head carried by the same locked export, not a second read that could observe a
  // later transaction and falsely pair that state digest with the earlier projection bytes.
  const state = projection.head;
  return plannedResult('publish', {
    ...trustPlanFields(context),
    stateCommit,
    storeId: context.trust.storeId,
    revision: state.revision,
    stateSha256: state.recordSha256,
    eventSha256: state.eventSha256,
    projectionSha256: projection.recordSha256,
    projectionBytesSha256: digest(projectionBytes),
    publicationMode,
    remoteProjectionSha256,
    remoteRevision,
    remoteStateSha256,
    changed
  });
}

function requireConfirmation(value, expected, operation) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(value ?? '')) || value !== expected) {
    fail(`Git-trusted Authority Store ${operation} confirmation does not match the exact current plan.`,
      'SGOS_AUTHORITY_GIT_PLAN_STALE', { requiredConfirmationSha256: expected });
  }
}

function samePlan(expected, current, operation) {
  requireConfirmation(expected, current.plan.confirmationSha256, operation);
  return current;
}

export async function publishGitTrustedAuthority(root, {
  confirmationSha256, expectedStoreId = null
} = {}) {
  const repositoryRoot = absoluteRoot(root);
  let preview = await planGitTrustedAuthorityPublish(repositoryRoot, { expectedStoreId });
  requireConfirmation(confirmationSha256, preview.plan.confirmationSha256, 'publication');
  let context = await trustContext(repositoryRoot, { expectedStoreId });
  const authorization = await approvedAuthorization(
    repositoryRoot, 'authority-store.publish', context
  );
  preview = samePlan(
    confirmationSha256,
    await planGitTrustedAuthorityPublish(repositoryRoot, { expectedStoreId }), 'publication'
  );
  context = await trustContext(repositoryRoot, { expectedStoreId });
  assertContextMatchesPreview(context, preview);
  const materialized = materializeStateBranchPublicationAuthority(
    repositoryRoot, context.target.config, {
      expectedRemoteSha: preview.stateCommit,
      transportRemote: context.target.effectivePushUrl
    }
  );
  if (materialized.baseRef !== preview.stateCommit) {
    fail('The reviewed git-trusted state base was not materialized exactly.',
      'SGOS_AUTHORITY_GIT_PLAN_STALE', {
        expectedStateCommit: preview.stateCommit,
        materializedStateCommit: materialized.baseRef ?? null
      });
  }
  const store = await openLocalStore(repositoryRoot, context.trust.storeId);
  const projection = await store.exportGitProjection({
    repositoryBindingSha256: context.trust.repositoryBindingSha256,
    policySha256: context.trust.policySha256,
    validateEntries: context.validateEntries
  });
  if (projection.recordSha256 !== preview.projectionSha256
      || digest(canonicalJson(projection)) !== preview.projectionBytesSha256) {
    fail('The local Authority Store changed after publication confirmation.',
      'SGOS_AUTHORITY_GIT_PLAN_STALE');
  }
  const published = await publishToStateBranch(
    repositoryRoot, context.target.config,
    { [preview.projectionPath]: canonicalJson(projection) },
    `[sgos][authority-store] publish ${context.trust.storeId} revision ${preview.revision}`,
    {
      expectedRemoteSha: preview.stateCommit,
      baseRef: preview.stateCommit,
      refreshRemote: false,
      transportRemote: context.target.effectivePushUrl,
      exactBlobSha256: { [preview.projectionPath]: preview.projectionBytesSha256 }
    }
  );
  const stateCommit = published.commit ?? preview.stateCommit;
  return deepFreeze({
    ...preview,
    changed: published.changed,
    previousStateCommit: preview.stateCommit,
    stateCommit,
    authorizationSha256: authorization.recordSha256,
    published: published.published,
    plan: preview.plan
  });
}

async function verifiedRemoteProjection(repositoryRoot, context) {
  const stateCommit = observeRemote(repositoryRoot, context.target);
  const bytes = await isolatedRemoteFile(
    repositoryRoot, context.target, stateCommit,
    gitTrustedAuthorityProjectionPath(context.trust.storeId)
  );
  const projection = parseAuthorityTransport(bytes);
  const verified = await verifyProjectionForState(projection, context, stateCommit);
  return Object.freeze({ stateCommit, projection, verified });
}

async function virtualOrLocalImportPlan(repositoryRoot, context, remote) {
  const exists = await hasLocalStore(repositoryRoot, context.trust.storeId);
  if (exists) {
    const store = await openLocalStore(repositoryRoot, context.trust.storeId);
    const options = {
      projection: remote.projection,
      expectedRepositoryBindingSha256: context.trust.repositoryBindingSha256,
      expectedPolicySha256: context.trust.policySha256,
      expectedStateBranch: context.target.branch,
      stateBranch: context.target.branch,
      stateCommit: remote.stateCommit,
      minimumAuthority: context.trust.minimumAuthority,
      validateEntries: context.validateEntries,
      authorityContextSha256: context.trust.authorityContextSha256
    };
    let planned = await store.planGitProjectionImport(options);
    let forceInstall = false;
    if (planned.plan.mode === 'noop' && remote.verified.revision === 0) {
      const retained = await store.hasGitProjectionCutover({
        projectionSha256: remote.verified.projectionSha256,
        stateBranch: context.target.branch,
        stateCommit: remote.stateCommit
      });
      // Opening a missing Store creates a valid local genesis before the atomic Git cutover. If a
      // process stops in that small window, the next preview must resume installation instead of
      // mistaking byte-identical genesis state for a completed synchronization.
      forceInstall = !retained;
      if (forceInstall) {
        planned = await store.planGitProjectionImport({ ...options, forceInstall: true });
      }
    }
    return { exists, store, forceInstall, ...planned };
  }
  const genesis = createAuthorityState({
    storeId: context.trust.storeId,
    revision: 0,
    eventSha256: null,
    entriesSha256: platformSha256({}),
    entries: {}
  });
  return {
    exists,
    store: null,
    forceInstall: true,
    projection: remote.verified,
    plan: planAuthorityGitProjectionImport(genesis, [], remote.verified, {
      authorityContextSha256: context.trust.authorityContextSha256,
      forceInstall: true
    })
  };
}

export async function planGitTrustedAuthoritySync(root, { expectedStoreId = null } = {}) {
  const repositoryRoot = absoluteRoot(root);
  const context = await trustContext(repositoryRoot, { expectedStoreId });
  const remote = await verifiedRemoteProjection(repositoryRoot, context);
  const local = await virtualOrLocalImportPlan(repositoryRoot, context, remote);
  return plannedResult('sync', {
    ...trustPlanFields(context),
    stateCommit: remote.stateCommit,
    storeId: context.trust.storeId,
    revision: remote.verified.revision,
    stateSha256: remote.verified.stateSha256,
    eventSha256: remote.verified.eventSha256,
    projectionSha256: remote.verified.projectionSha256,
    localStoreExists: local.exists,
    localRevision: local.plan.beforeRevision,
    localStateSha256: local.plan.beforeStateSha256,
    importPlanSha256: local.plan.confirmationSha256,
    // A remote genesis projection is byte-identical to the virtual genesis used to plan an absent
    // Store. It is still an installation: confirmation materializes the private Store on this
    // machine. Reporting that filesystem change as a no-op would make the preview and command
    // effects dishonest even though the authority lineage itself has no events yet.
    importMode: local.exists ? local.plan.mode : 'install',
    changed: !local.exists || local.plan.mode !== 'noop'
  });
}

export async function syncGitTrustedAuthority(root, {
  confirmationSha256, expectedStoreId = null
} = {}) {
  const repositoryRoot = absoluteRoot(root);
  let preview = await planGitTrustedAuthoritySync(repositoryRoot, { expectedStoreId });
  requireConfirmation(confirmationSha256, preview.plan.confirmationSha256, 'synchronization');
  let context = await trustContext(repositoryRoot, { expectedStoreId });
  const authorization = await approvedAuthorization(
    repositoryRoot, 'authority-store.sync', context
  );
  preview = samePlan(
    confirmationSha256,
    await planGitTrustedAuthoritySync(repositoryRoot, { expectedStoreId }), 'synchronization'
  );
  context = await trustContext(repositoryRoot, { expectedStoreId });
  assertContextMatchesPreview(context, preview);
  const remote = await verifiedRemoteProjection(repositoryRoot, context);
  if (remote.stateCommit !== preview.stateCommit
      || remote.verified.projectionSha256 !== preview.projectionSha256) {
    fail('Git-trusted Authority Store state changed after synchronization confirmation.',
      'SGOS_AUTHORITY_GIT_PLAN_STALE');
  }
  const local = await virtualOrLocalImportPlan(repositoryRoot, context, remote);
  if (local.plan.confirmationSha256 !== preview.importPlanSha256) {
    fail('The local Authority Store changed after synchronization confirmation.',
      'SGOS_AUTHORITY_GIT_PLAN_STALE', {
        requiredImportPlanSha256: local.plan.confirmationSha256
      });
  }
  let store = local.store;
  if (!store) store = await openLocalStore(repositoryRoot, context.trust.storeId);
  const imported = await store.importGitProjection({
    projection: remote.projection,
    expectedRepositoryBindingSha256: context.trust.repositoryBindingSha256,
    expectedPolicySha256: context.trust.policySha256,
    expectedStateBranch: context.target.branch,
    stateBranch: context.target.branch,
    stateCommit: remote.stateCommit,
    minimumAuthority: context.trust.minimumAuthority,
    validateEntries: context.validateEntries,
    authorityContextSha256: context.trust.authorityContextSha256,
    forceInstall: local.forceInstall,
    confirmationSha256: local.plan.confirmationSha256,
    ...(local.plan.mode === 'noop' ? {} : { authorization })
  });
  return deepFreeze({
    ...preview,
    changed: !local.exists || imported.changed,
    stateCommit: remote.stateCommit,
    importMode: local.exists ? imported.mode : 'install',
    current: imported.current,
    importedEventCount: imported.importedEventCount,
    cutoverSha256: imported.cutoverSha256,
    // Admission authority is retained in the operation result/cutover receipt, never in the
    // deterministic projection whose bytes must remain reusable across machines.
    authorizationSha256: authorization.recordSha256,
    plan: preview.plan
  });
}
