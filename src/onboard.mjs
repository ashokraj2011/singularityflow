import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import {
  configurationBranchHead, ensureConfigurationBranch, loadStoryConfigurationSnapshot,
  resolveRemoteStoryConfigurationAuthority
} from './configuration-branch.mjs';
import { gitCommitIdentity } from './git.mjs';
import { GitRemoteSession } from './git-execution.mjs';
import { assertCredentialFreeRemote, sanitizeRemote } from './git-remote-diagnostics.mjs';
import { recordSha256 } from './records.mjs';
import { createRepoContext } from './repo-context.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import {
  nowIso, SingularityFlowError, writeAtomic, writeJson
} from './util.mjs';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stateFile(identity) {
  return path.join(identity.commonDir, 'singularity-flow', 'fos', 'attachments',
    identity.repositoryInstanceId, 'current.json');
}

function journalFile(identity, operationId) {
  return path.join(identity.commonDir, 'singularity-flow', 'fos', 'operations', `${operationId}.json`);
}

function validOid(value, objectFormat) {
  const length = objectFormat === 'sha256' ? 64 : objectFormat === 'sha1' ? 40 : 0;
  return length > 0 && new RegExp(`^[a-f0-9]{${length}}$`).test(value ?? '');
}

function validateAttachmentDescriptor(descriptor) {
  const dependencies = descriptor?.dependencyClosure;
  const route = descriptor?.route;
  const locator = descriptor?.locator;
  const pin = descriptor?.pin;
  const objectFormat = descriptor?.repository?.objectFormat;
  const paths = Array.isArray(dependencies) ? dependencies.map((entry) => entry?.path) : [];
  const validDependencies = Array.isArray(dependencies) && dependencies.length > 0
    && dependencies.length <= 4096
    && dependencies.every((entry) => typeof entry?.path === 'string'
      && entry.path.length > 0 && entry.path.length <= 4096
      && !path.isAbsolute(entry.path) && !entry.path.split(/[\\/]/).includes('..')
      && validOid(entry.object, objectFormat)
      && /^100(?:644|755)$/.test(entry.gitMode ?? '')
      && /^sha256:[a-f0-9]{64}$/.test(entry.sha256 ?? ''))
    && new Set(paths).size === paths.length;
  const folded = validDependencies ? `sha256:${recordSha256({
    sourceCommit: descriptor.authority?.sourceCommit,
    dependencies
  })}` : null;
  const expectedAuthorityId = sha256(JSON.stringify({
    location: descriptor?.authority?.locator,
    ref: locator?.ref
  }));
  const valid = descriptor?.kind === 'fos-attachment-descriptor'
    && descriptor?.readerRange?.minimum === 1 && descriptor?.readerRange?.maximum === 1
    && ['local', 'remote'].includes(route?.kind)
    && (route.kind === 'remote'
      ? typeof route.remoteName === 'string' && route.remoteName.length > 0
      : route.remoteName == null)
    && locator?.kind === route.kind && locator?.remoteName === route.remoteName
    && (route.kind === 'remote' ? typeof locator.url === 'string' && locator.url.length > 0 : locator.url == null)
    && /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(locator?.ref ?? '')
    && locator.ref === `refs/heads/${descriptor?.authority?.branch}`
    && descriptor?.authorityId === expectedAuthorityId
    && descriptor?.repository?.repositoryId === descriptor?.repository?.repositoryInstanceId
    && descriptor?.trustBinding?.authorityId === descriptor?.authorityId
    && descriptor?.trustBinding?.kind === descriptor?.trust?.kind
    && descriptor?.trustBinding?.effectiveDestinationSha256 === descriptor?.trust?.effectiveDestinationSha256
    && validOid(descriptor?.authority?.commit, objectFormat)
    && validOid(descriptor?.authority?.sourceCommit, objectFormat)
    && pin?.objectFormat === objectFormat && pin?.commitOid === descriptor.authority.commit
    && pin?.foldSchemaVersion === 1 && pin?.foldDigest === folded
    && JSON.stringify(pin?.dependencies) === JSON.stringify(dependencies)
    && descriptor?.verifiedFoldSha256 === folded
    && descriptor?.effectivePolicyDigest === descriptor?.policySha256
    && /^sha256:[a-f0-9]{64}$/.test(descriptor?.policySha256 ?? '')
    && (descriptor?.offlineSnapshotSha256 == null
      || /^sha256:[a-f0-9]{64}$/.test(descriptor.offlineSnapshotSha256))
    && descriptor?.policyEpoch === descriptor?.authority?.sourceCommit
    && descriptor?.observation?.source === (route.kind === 'remote' ? 'remote-observed' : 'local-verified')
    && descriptor?.observation?.remoteOid === (route.kind === 'remote' ? descriptor.authority.commit : null)
    && typeof descriptor?.operationId === 'string' && /^fos-op-[a-f0-9]{24}$/.test(descriptor.operationId)
    && typeof descriptor?.receiptId === 'string' && /^fos-receipt-[a-f0-9]{24}$/.test(descriptor.receiptId);
  if (!valid) throw new SingularityFlowError(
    'The FOS authority descriptor is incomplete, inconsistent, or outside its bounded reader contract.',
    { code: 'AUTHORITY_PIN_INVALID' }
  );
}

function validatedState(parsed) {
  if (parsed.kind !== 'fos-attachment-state') {
    throw new SingularityFlowError('The FOS attachment state uses an unsupported format.', {
      code: 'AUTHORITY_PIN_INVALID'
    });
  }
  const descriptor = readRecord('fos-attachment-descriptor', parsed.descriptor).record;
  const receipt = readRecord('fos-attachment-receipt', parsed.receipt).record;
  validateAttachmentDescriptor(descriptor);
  if (descriptor.descriptorSha256 !== `sha256:${recordSha256({
    ...descriptor, descriptorSha256: null
  })}`) throw new SingularityFlowError('The FOS authority descriptor digest is invalid.', {
    code: 'AUTHORITY_PIN_INVALID'
  });
  const { receiptSha256, ...receiptBody } = receipt;
  if (receiptSha256 !== `sha256:${recordSha256(receiptBody)}`) {
    throw new SingularityFlowError('The FOS attachment receipt digest is invalid.', {
      code: 'AUTHORITY_PIN_INVALID'
    });
  }
  if (receipt.descriptorSha256 !== descriptor.descriptorSha256
      || receipt.receiptId !== descriptor.receiptId
      || receipt.operationId !== descriptor.operationId
      || receipt.authorityCommit !== descriptor.authority.commit) {
    throw new SingularityFlowError('The FOS attachment receipt does not bind the stored descriptor.', {
      code: 'AUTHORITY_PIN_INVALID'
    });
  }
  const offlineSnapshot = validateOfflineSnapshot(parsed.offlineSnapshot ?? null, descriptor);
  return Object.freeze({ ...parsed, descriptor, receipt, offlineSnapshot });
}

async function recoverableJournalState(identity) {
  const directory = path.dirname(journalFile(identity, 'placeholder'));
  const files = (await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  })).filter((entry) => entry.isFile() && /^fos-op-[a-f0-9]{24}\.json$/.test(entry.name));
  if (files.length > 256) throw new SingularityFlowError(
    'FOS recovery has more operation journals than the bounded reader can inspect.', {
      code: 'FOS_RECOVERY_LIMIT_EXCEEDED'
    }
  );
  const candidates = [];
  for (const file of files) {
    try {
      const journal = readRecord('fos-operation-journal', await readFile(path.join(directory, file.name), 'utf8')).record;
      if (journal.kind !== 'fos-operation-journal'
          || journal.request?.repositoryInstanceId !== identity.repositoryInstanceId
          || !['validated', 'completed', 'recovery-required'].includes(journal.phase)
          || !journal.candidate) continue;
      const candidate = validatedState(readRecord('fos-attachment-state', journal.candidate).record);
      if (candidate.descriptor.operationId !== journal.operationId
          || candidate.descriptor.worktree.worktreeInstanceId !== identity.worktreeInstanceId
          || candidate.descriptor.descriptorSha256 !== journal.candidateDigest) continue;
      candidates.push({ journal, candidate });
    } catch {
      // One malformed operation receipt cannot hide a different fully sealed recovery candidate.
    }
  }
  candidates.sort((left, right) => String(right.journal.updatedAt).localeCompare(String(left.journal.updatedAt)));
  const recovered = candidates[0];
  if (!recovered) return null;
  return Object.freeze({
    ...recovered.candidate,
    recovery: Object.freeze({
      required: true,
      operationId: recovered.journal.operationId,
      journalPhase: recovered.journal.phase
    })
  });
}

async function readState(identity) {
  try {
    const parsed = readRecord('fos-attachment-state', await readFile(stateFile(identity), 'utf8')).record;
    return validatedState(parsed);
  } catch (error) {
    if (error?.code === 'SCHEMA_VERSION_FUTURE' || error?.code === 'SCHEMA_VERSION_ARCHIVED') throw error;
    const truncatedOrMissing = error?.code === 'ENOENT' || error?.code === 'SCHEMA_RECORD_INVALID'
      || error instanceof SyntaxError;
    if (truncatedOrMissing) {
      const recovered = await recoverableJournalState(identity);
      if (recovered) return recovered;
    }
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError || error?.code === 'SCHEMA_RECORD_INVALID') throw new SingularityFlowError(
      'The FOS attachment state is not valid JSON and no sealed recovery candidate is available.', {
        code: 'AUTHORITY_PIN_INVALID'
      }
    );
    throw error;
  }
}

async function writeJournal(identity, record) {
  await writeJson(journalFile(identity, record.operationId), record);
}

function operationRecord(values) {
  return {
    schemaVersion: currentSchemaVersion('fos-operation-journal'),
    kind: 'fos-operation-journal',
    ...values
  };
}

function selectedRoute(existing, { remote, authorityLocal }) {
  if (remote && authorityLocal) throw new SingularityFlowError(
    '--remote and --authority-local are mutually exclusive.', { code: 'AUTHORITY_ROUTE_INVALID' }
  );
  if (authorityLocal) return { kind: 'local', remoteName: null };
  if (remote) return { kind: 'remote', remoteName: remote };
  if (existing?.descriptor?.route?.kind === 'remote') {
    return { kind: 'remote', remoteName: existing.descriptor.route.remoteName };
  }
  if (existing?.descriptor?.route?.kind === 'local') return { kind: 'local', remoteName: null };
  return null;
}

async function resolveRoute(context, existing, options) {
  let route = selectedRoute(existing, options);
  if (route) return route;
  const remotes = await context.observe('repository.remotes');
  if (remotes.length === 0) throw new SingularityFlowError(
    'No configured Git remote is available. Choose --authority-local only when a reviewed local authority already exists.',
    { code: 'AUTHORITY_ROUTE_REQUIRED' }
  );
  if (remotes.length !== 1) throw new SingularityFlowError(
    `More than one Git remote is configured (${remotes.join(', ')}). Choose one explicitly with --remote <NAME>.`,
    { code: 'AUTHORITY_ROUTE_AMBIGUOUS', details: { candidates: remotes } }
  );
  route = { kind: 'remote', remoteName: remotes[0] };
  return route;
}

async function routeLocation(context, route) {
  // Bind a local authority to Git's canonical worktree root. The caller may have entered an OS
  // alias such as macOS `/var` versus `/private/var`, a symlink, or a differently cased Windows
  // path; persisting that spelling makes the next invocation look like an authority rebind.
  if (route.kind === 'local') return context.observe('repository.root');
  const remoteUrl = await context.observe('repository.remote-url', { remote: route.remoteName });
  if (!remoteUrl) throw new SingularityFlowError(
    `Configured remote '${route.remoteName}' has no single readable fetch URL.`, {
      code: 'AUTHORITY_UNAVAILABLE'
    }
  );
  // Fail before any network call or durable record when the repository-local value embeds a
  // credential, names an option-like transport, or delegates to an external helper. The shared
  // remote transport freezes ambient URL rewrites later; this validation keeps the literal itself
  // safe to bind and diagnose.
  return assertCredentialFreeRemote(remoteUrl);
}

async function sameAuthorityLocation(route, current, recorded) {
  if (route.kind !== 'local') return sanitizeRemote(current) === recorded;
  try {
    return await realpath(current) === await realpath(recorded);
  } catch {
    // A missing or unreadable recorded location cannot be treated as an equivalent authority.
    return false;
  }
}

function fold(snapshot) {
  const dependencies = snapshot.assets.map((asset) => ({
    path: asset.relative,
    object: asset.object,
    gitMode: asset.gitMode,
    sha256: `sha256:${asset.sha256}`
  })).sort((left, right) => left.path.localeCompare(right.path));
  return {
    dependencies,
    foldSha256: `sha256:${recordSha256({
      sourceCommit: snapshot.sourceCommit,
      dependencies
    })}`
  };
}

const OFFLINE_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
const OFFLINE_POLICY_PATH = 'singularity/fos.yml';
const OFFLINE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const FOS_LOCAL_BOOTSTRAP_POLICY_ID = 'unmanaged-local-v1';
const LOCAL_BOOTSTRAP_POLICY_BODY = Object.freeze({
  id: FOS_LOCAL_BOOTSTRAP_POLICY_ID,
  version: 1,
  scope: 'unmanaged-local',
  organizationalAuthority: false,
  permitsRemotePublication: false,
  proposedPolicySelfAuthorizing: false,
  source: 'signed-package-preset'
});
export const FOS_LOCAL_BOOTSTRAP_POLICY_SHA256 = `sha256:${recordSha256(LOCAL_BOOTSTRAP_POLICY_BODY)}`;

function offlineSnapshotFor(snapshot, folded, observedAt) {
  const totalBytes = snapshot.assets.reduce((sum, asset) => sum + asset.contents.length, 0);
  if (totalBytes > OFFLINE_SNAPSHOT_MAX_BYTES) return null;
  const body = {
    schemaVersion: currentSchemaVersion('fos-offline-snapshot'),
    kind: 'fos-offline-snapshot',
    authorityCommit: snapshot.observedCommit,
    sourceCommit: snapshot.sourceCommit,
    foldSha256: folded.foldSha256,
    observedAt,
    totalBytes,
    assets: snapshot.assets.map((asset) => ({
      path: asset.relative,
      object: asset.object,
      gitMode: asset.gitMode,
      mode: asset.mode,
      sha256: `sha256:${asset.sha256}`,
      bytes: asset.contents.length,
      contentsBase64: asset.contents.toString('base64')
    })).sort((left, right) => left.path.localeCompare(right.path))
  };
  return Object.freeze({
    ...body,
    snapshotSha256: `sha256:${recordSha256(body)}`
  });
}

function validateOfflineSnapshot(snapshot, descriptor) {
  if (descriptor.offlineSnapshotSha256 == null) {
    if (snapshot != null) throw new SingularityFlowError(
      'The FOS attachment contains unbound offline bytes.', { code: 'AUTHORITY_PIN_INVALID' }
    );
    return null;
  }
  const current = readRecord('fos-offline-snapshot', snapshot).record;
  const { snapshotSha256, ...body } = current;
  const dependencies = new Map(descriptor.dependencyClosure.map((entry) => [entry.path, entry]));
  let totalBytes = 0;
  const valid = current.kind === 'fos-offline-snapshot'
    && snapshotSha256 === descriptor.offlineSnapshotSha256
    && snapshotSha256 === `sha256:${recordSha256(body)}`
    && current.authorityCommit === descriptor.authority.commit
    && current.sourceCommit === descriptor.authority.sourceCommit
    && current.foldSha256 === descriptor.verifiedFoldSha256
    && current.observedAt === descriptor.observedAt
    && Array.isArray(current.assets)
    && current.assets.length === dependencies.size
    && current.assets.length <= 4096
    && current.assets.every((asset) => {
      const dependency = dependencies.get(asset?.path);
      if (!dependency || typeof asset.contentsBase64 !== 'string'
          || !Number.isInteger(asset.bytes) || asset.bytes < 0
          || !Number.isInteger(asset.mode)) return false;
      const bytes = Buffer.from(asset.contentsBase64, 'base64');
      if (bytes.toString('base64') !== asset.contentsBase64 || bytes.length !== asset.bytes
          || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.sha256
          || asset.object !== dependency.object || asset.gitMode !== dependency.gitMode
          || asset.sha256 !== dependency.sha256) return false;
      totalBytes += bytes.length;
      return totalBytes <= OFFLINE_SNAPSHOT_MAX_BYTES;
    })
    && totalBytes === current.totalBytes;
  if (!valid) throw new SingularityFlowError(
    'The FOS offline snapshot is incomplete or does not match the verified authority pin.', {
      code: 'AUTHORITY_PIN_INVALID'
    }
  );
  return Object.freeze(current);
}

function offlinePolicyDecision(state, now) {
  const snapshot = validateOfflineSnapshot(state.offlineSnapshot, state.descriptor);
  if (!snapshot) throw new SingularityFlowError(
    'The verified attachment has no complete offline snapshot. Refresh online before offline reuse.', {
      code: 'AUTHORITY_UNAVAILABLE'
    }
  );
  const asset = snapshot.assets.find((entry) => entry.path === OFFLINE_POLICY_PATH);
  if (!asset) throw new SingularityFlowError(
    `Pinned offline reuse is not permitted because ${OFFLINE_POLICY_PATH} is absent from the approved authority.`, {
      code: 'AUTHORITY_UNAVAILABLE'
    }
  );
  let document;
  try {
    const parsed = YAML.parse(Buffer.from(asset.contentsBase64, 'base64').toString('utf8')) ?? {};
    document = readRecord('fos-offline-policy', parsed).record;
  }
  catch { throw new SingularityFlowError('The pinned FOS offline policy is malformed.', { code: 'AUTHORITY_PIN_INVALID' }); }
  const policy = document.offline ?? {};
  const observed = Date.parse(state.descriptor.observedAt);
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const notAfter = Date.parse(policy.notAfter ?? '');
  const maxAgeSeconds = Number(policy.maxAgeSeconds);
  const policyValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(policy.policyId ?? '')
    && policy.enabled === true
    && policy.revoked !== true
    && policy.requiredLive !== true
    && Array.isArray(policy.operations) && policy.operations.includes('onboard')
    && Number.isInteger(maxAgeSeconds) && maxAgeSeconds > 0
    && maxAgeSeconds <= OFFLINE_MAX_AGE_SECONDS
    && Number.isFinite(observed) && Number.isFinite(current) && current >= observed
    && Number.isFinite(notAfter)
    && policy.authorityPolicySha256 === state.descriptor.policySha256;
  const expiresAtMs = policyValid
    ? Math.min(notAfter, observed + maxAgeSeconds * 1000)
    : Number.NaN;
  if (!policyValid || current >= expiresAtMs) throw new SingularityFlowError(
    'The approved pinned/offline policy is absent, incompatible, revoked, expired, or requires a live authority check.', {
      code: 'AUTHORITY_UNAVAILABLE'
    }
  );
  return Object.freeze({
    policyId: policy.policyId,
    policySha256: asset.sha256,
    ageMilliseconds: current - observed,
    expiresAt: new Date(expiresAtMs).toISOString()
  });
}

function descriptorFor({
  identity, route, location, authority, snapshot, offlineSnapshot, operationId, receiptId, observedAt
}) {
  const folded = fold(snapshot);
  const workflowAsset = snapshot.assets.find((asset) => asset.relative === 'singularity/workflow.yml');
  if (!workflowAsset) throw new SingularityFlowError(
    'The selected authority has no singularity/workflow.yml policy asset.', {
      code: 'AUTHORITY_NOT_CONFIGURED'
    }
  );
  const safeLocation = sanitizeRemote(location);
  const authorityRef = `refs/heads/${authority.branch}`;
  const authorityId = sha256(JSON.stringify({ location: safeLocation, ref: authorityRef }));
  const descriptor = {
    schemaVersion: currentSchemaVersion('fos-attachment-descriptor'),
    kind: 'fos-attachment-descriptor',
    readerRange: { minimum: 1, maximum: 1 },
    repository: {
      repositoryId: identity.repositoryInstanceId,
      repositoryInstanceId: identity.repositoryInstanceId,
      objectFormat: identity.objectFormat
    },
    worktree: { worktreeInstanceId: identity.worktreeInstanceId },
    route,
    authorityId,
    locator: {
      kind: route.kind,
      remoteName: route.remoteName,
      url: route.kind === 'remote' ? safeLocation : null,
      ref: authorityRef
    },
    authority: {
      locator: safeLocation,
      branch: authority.branch,
      commit: authority.commit,
      sourceCommit: snapshot.sourceCommit,
      source: authority.source
    },
    trust: {
      kind: route.kind === 'local' ? 'explicit-local-authority' : 'configured-git-remote',
      effectiveDestinationSha256: sha256(safeLocation)
    },
    trustBinding: {
      kind: route.kind === 'local' ? 'explicit-local-authority' : 'configured-git-remote',
      effectiveDestinationSha256: sha256(safeLocation),
      authorityId
    },
    pin: {
      objectFormat: identity.objectFormat,
      commitOid: authority.commit,
      foldDigest: folded.foldSha256,
      foldSchemaVersion: 1,
      dependencies: folded.dependencies
    },
    verifiedFoldSha256: folded.foldSha256,
    dependencyClosure: folded.dependencies,
    readerContract: { family: 'story-configuration-snapshot', version: 1 },
    // The runtime definition carries process-local normalization state. The reviewed workflow
    // object is the stable policy input and is already covered by the verified dependency fold.
    policySha256: `sha256:${workflowAsset.sha256}`,
    effectivePolicyDigest: `sha256:${workflowAsset.sha256}`,
    policyEpoch: snapshot.sourceCommit,
    offlineSnapshotSha256: offlineSnapshot?.snapshotSha256 ?? null,
    observation: {
      source: route.kind === 'local' ? 'local-verified' : 'remote-observed',
      observedAt,
      remoteOid: route.kind === 'remote' ? authority.commit : null
    },
    operationId,
    receiptId,
    observedAt,
    descriptorSha256: null
  };
  descriptor.descriptorSha256 = `sha256:${recordSha256(descriptor)}`;
  return descriptor;
}

function receiptFor(descriptor, actor, { changed }) {
  const receipt = {
    schemaVersion: currentSchemaVersion('fos-attachment-receipt'),
    kind: 'fos-attachment-receipt',
    receiptId: descriptor.receiptId,
    operationId: descriptor.operationId,
    descriptorSha256: descriptor.descriptorSha256,
    authorityCommit: descriptor.authority.commit,
    actor: { name: actor.name ?? null, email: actor.email ?? null },
    disposition: changed ? 'attached' : 'already-attached',
    recordedAt: nowIso()
  };
  return { ...receipt, receiptSha256: `sha256:${recordSha256(receipt)}` };
}

export async function readFosAttachment(root) {
  const context = createRepoContext(root);
  const identity = await context.identity();
  return readState(identity);
}

/** Resolve the exact previously attached Story configuration authority without organization scan. */
export async function fosStoryConfigurationAuthority(root) {
  const context = createRepoContext(root);
  const identity = await context.identity();
  const state = await readState(identity);
  if (!state) return null;
  if (state.descriptor.repository.repositoryInstanceId !== identity.repositoryInstanceId
      || state.descriptor.worktree.worktreeInstanceId !== identity.worktreeInstanceId) {
    throw new SingularityFlowError('The FOS authority pin belongs to a different repository or worktree.', {
      code: 'AUTHORITY_PIN_INVALID'
    });
  }
  const location = await routeLocation(context, state.descriptor.route);
  if (!await sameAuthorityLocation(state.descriptor.route, location,
    state.descriptor.authority.locator)) {
    throw new SingularityFlowError(
      'The configured authority location changed after onboarding. Refresh the authority pin explicitly.', {
        code: 'AUTHORITY_CONFLICT'
      }
    );
  }
  return Object.freeze({
    remote: location,
    branch: state.descriptor.authority.branch,
    commit: state.descriptor.authority.commit,
    sourceCommit: state.descriptor.authority.sourceCommit,
    source: 'fos-attachment'
  });
}

function bootstrapActor(root, env) {
  const actor = gitCommitIdentity(root, { env });
  if (!actor?.email) throw new SingularityFlowError(
    'Approved bootstrap requires a configured Git email that can be bound to the authorization.', {
      code: 'NOT_AUTHORIZED'
    }
  );
  return Object.freeze({ ...actor, principalId: `git:${actor.email.toLowerCase()}` });
}

async function bootstrapAuthorization({
  policyId, route, actor, resolveBootstrapPolicy, kernelAuthorize
}) {
  let policy;
  if (route.kind === 'local' && policyId === FOS_LOCAL_BOOTSTRAP_POLICY_ID) {
    policy = {
      ...LOCAL_BOOTSTRAP_POLICY_BODY,
      approved: true,
      policySha256: FOS_LOCAL_BOOTSTRAP_POLICY_SHA256,
      policyEpoch: 1,
      trustAnchorSha256: FOS_LOCAL_BOOTSTRAP_POLICY_SHA256,
      actorPrincipalId: actor.principalId
    };
  } else if (typeof resolveBootstrapPolicy === 'function') {
    policy = await resolveBootstrapPolicy(Object.freeze({
      policyId, route: structuredClone(route), actorPrincipalId: actor.principalId
    }));
  } else {
    throw new SingularityFlowError(
      'No existing trusted bootstrap policy provider can authorize this request. The proposed configuration cannot authorize its own creation.', {
        code: 'TRUST_REQUIRED'
      }
    );
  }
  const expectedScope = route.kind === 'local' ? 'unmanaged-local' : 'organization';
  const valid = policy?.approved === true
    && policy.id === policyId
    && policy.scope === expectedScope
    && /^sha256:[a-f0-9]{64}$/.test(policy.policySha256 ?? '')
    && /^sha256:[a-f0-9]{64}$/.test(policy.trustAnchorSha256 ?? '')
    && Number.isInteger(policy.policyEpoch)
    && policy.actorPrincipalId === actor.principalId
    && policy.proposedPolicySelfAuthorizing !== true
    && (route.kind === 'local'
      ? policy.organizationalAuthority === false && policy.permitsRemotePublication === false
      : policy.permitsRemotePublication === true);
  if (!valid) throw new SingularityFlowError(
    'The selected bootstrap policy is missing approval, actor, scope, epoch, or trust-anchor binding.', {
      code: 'NOT_AUTHORIZED'
    }
  );
  if (route.kind === 'remote') {
    if (typeof kernelAuthorize !== 'function') throw new SingularityFlowError(
      'Remote bootstrap requires a trusted governance-kernel authorization adapter.', {
        code: 'TRUST_REQUIRED'
      }
    );
    const request = Object.freeze({
      operation: 'fos-authority-bootstrap',
      policyId: policy.id,
      policySha256: policy.policySha256,
      policyEpoch: policy.policyEpoch,
      trustAnchorSha256: policy.trustAnchorSha256,
      actorPrincipalId: actor.principalId,
      expectedRemoteOid: null,
      targetRef: 'refs/heads/sflow/config'
    });
    const result = await kernelAuthorize(request);
    const bound = result?.disposition === 'allow'
      && Object.entries(request).every(([key, value]) => result[key] === value)
      && /^sha256:[a-f0-9]{64}$/.test(result.receiptSha256 ?? '');
    if (!bound) throw new SingularityFlowError(
      'The governance kernel did not authorize this exact remote bootstrap.', {
        code: 'NOT_AUTHORIZED'
      }
    );
    return Object.freeze({ policy: Object.freeze(structuredClone(policy)), kernel: Object.freeze(structuredClone(result)) });
  }
  return Object.freeze({ policy: Object.freeze(structuredClone(policy)), kernel: null });
}

/**
 * Explicitly establish one missing configuration authority under a pre-existing bootstrap trust
 * contract. The local preset is package-scoped and can never claim organizational authority;
 * remote creation requires an injected trusted policy resolver and governance-kernel receipt.
 */
export async function bootstrapFosAuthority(root, {
  remote = null,
  authorityLocal = false,
  publish = false,
  policyId,
  resolveBootstrapPolicy = null,
  kernelAuthorize = null,
  beforeAuthorityCreate = null,
  afterAuthorityCreate = null,
  env = process.env
} = {}) {
  if (!policyId || (authorityLocal && publish) || (!authorityLocal && !publish)) {
    throw new SingularityFlowError(
      'Bootstrap requires --policy; local bootstrap forbids --publish and remote bootstrap requires it.', {
        code: 'FOS_BOOTSTRAP_OPTIONS_INVALID'
      }
    );
  }
  const context = createRepoContext(root, { cache: false });
  const identity = await context.identity();
  if (identity.bare) throw new SingularityFlowError(
    'FOS bootstrap requires an existing working checkout.', { code: 'REPOSITORY_STATE_UNSUPPORTED' }
  );
  if (await readState(identity)) throw new SingularityFlowError(
    'This checkout already has a verified FOS attachment; bootstrap cannot replace its authority.', {
      code: 'AUTHORITY_CONFLICT'
    }
  );
  const route = await resolveRoute(context, null, { remote, authorityLocal });
  const location = await routeLocation(context, route);
  const actor = bootstrapActor(root, env);
  const authorization = await bootstrapAuthorization({
    policyId, route, actor, resolveBootstrapPolicy, kernelAuthorize
  });
  const request = {
    kind: 'authority-bootstrap',
    repositoryInstanceId: identity.repositoryInstanceId,
    authorityLocator: sanitizeRemote(location),
    route,
    actorPrincipalId: actor.principalId,
    expectedRemoteOid: null,
    policyId: authorization.policy.id,
    policySha256: authorization.policy.policySha256,
    policyEpoch: authorization.policy.policyEpoch,
    trustAnchorSha256: authorization.policy.trustAnchorSha256
  };
  const requestDigest = `sha256:${recordSha256(request)}`;
  const operationId = `fos-op-${requestDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`;

  return withSubjectLock(root, { kind: 'fos-bootstrap', id: identity.repositoryInstanceId }, async () => {
    const journalPath = journalFile(identity, operationId);
    let prior = null;
    try { prior = readRecord('fos-operation-journal', await readFile(journalPath, 'utf8')).record; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (prior && prior.requestDigest !== requestDigest) throw new SingularityFlowError(
      `Operation '${operationId}' was already used with different bootstrap inputs.`, {
        code: 'IDEMPOTENCY_CONFLICT'
      }
    );
    if (prior?.phase === 'completed' || prior?.phase === 'authority-committed'
        || (prior?.phase === 'recovery-required' && prior.authorityCommit)) {
      if (prior.phase !== 'completed') {
        const recoveryHead = await configurationBranchHead(location, {
          session: new GitRemoteSession({ env }), refresh: true
        });
        if (!recoveryHead.reachable || recoveryHead.sha !== prior.authorityCommit) {
          throw new SingularityFlowError(
            'The authority changed after bootstrap publication and before attachment recovery.', {
              code: 'AUTHORITY_MOVED',
              details: { expectedOid: prior.authorityCommit, actual: recoveryHead.sha ?? null }
            }
          );
        }
      }
      const attached = await onboardRepository(root, {
        remote: route.remoteName, authorityLocal: route.kind === 'local'
      });
      await writeJournal(identity, operationRecord({
        ...prior, phase: 'completed', attachmentOperationId: attached.operationId,
        updatedAt: nowIso(), lastErrorCode: null
      }));
      return Object.freeze({
        ...attached, status: 'bootstrapped', bootstrap: Object.freeze({
          operationId, policyId, scope: authorization.policy.scope,
          organizationalAuthority: authorization.policy.organizationalAuthority === true,
          authorityCommit: prior.authorityCommit, reconciled: true
        })
      });
    }
    const startedAt = prior?.startedAt ?? nowIso();
    let journal = operationRecord({
      operationId, requestDigest, request,
      actorBinding: { name: actor.name, email: actor.email, principalId: actor.principalId },
      authorization,
      phase: 'prepared', startedAt, updatedAt: nowIso(), lastErrorCode: null
    });
    await writeJournal(identity, journal);
    try {
      const session = new GitRemoteSession({ env });
      const observed = await configurationBranchHead(location, { session, refresh: true });
      if (!observed.reachable) throw new SingularityFlowError(
        observed.error ?? 'The selected bootstrap authority is unavailable.', {
          code: observed.observation?.failure?.code ?? 'AUTHORITY_UNAVAILABLE'
        }
      );
      if (observed.exists) throw new SingularityFlowError(
        'The configuration authority already exists; attach or refresh it instead of bootstrapping.', {
          code: 'AUTHORITY_CONFLICT', details: { actualOid: observed.sha }
        }
      );
      journal = operationRecord({ ...journal, phase: 'authorized', updatedAt: nowIso() });
      await writeJournal(identity, journal);
      if (beforeAuthorityCreate) await beforeAuthorityCreate();
      const created = await ensureConfigurationBranch(location, {
        remoteSession: session, observedHead: observed, authorIdentity: actor, env
      });
      if (created.created !== true) throw new SingularityFlowError(
        'Another authorized creator established the configuration authority first. The winner was preserved; review it before attachment.', {
          code: 'AUTHORITY_CONFLICT', details: { actualOid: created.commit }
        }
      );
      journal = operationRecord({
        ...journal, phase: 'authority-committed', authorityCommit: created.commit,
        updatedAt: nowIso()
      });
      await writeJournal(identity, journal);
      if (afterAuthorityCreate) await afterAuthorityCreate(created.commit);
      const attached = await onboardRepository(root, {
        remote: route.remoteName, authorityLocal: route.kind === 'local'
      });
      journal = operationRecord({
        ...journal, phase: 'completed', attachmentOperationId: attached.operationId,
        updatedAt: nowIso(), lastErrorCode: null
      });
      await writeJournal(identity, journal);
      return Object.freeze({
        ...attached, status: 'bootstrapped', bootstrap: Object.freeze({
          operationId, policyId, scope: authorization.policy.scope,
          organizationalAuthority: authorization.policy.organizationalAuthority === true,
          authorityCommit: created.commit, reconciled: false
        })
      });
    } catch (error) {
      await writeJournal(identity, operationRecord({
        ...journal, phase: 'recovery-required', updatedAt: nowIso(),
        lastErrorCode: error?.code ?? 'AUTHORITY_UNAVAILABLE'
      })).catch(() => {});
      throw error;
    }
  });
}

export async function onboardRepository(root, {
  remote = null,
  authorityLocal = false,
  offline = false,
  resume = null,
  refresh = false,
  cache = true,
  stateWriter = writeAtomic,
  now = new Date()
} = {}) {
  if (offline && (refresh || resume)) throw new SingularityFlowError(
    'Offline reuse cannot refresh authority or resume a mutating attachment operation.', {
      code: 'AUTHORITY_ROUTE_INVALID'
    }
  );
  const context = createRepoContext(root, { cache });
  const identity = await context.identity();
  if (identity.bare) throw new SingularityFlowError(
    'FOS onboarding attaches a working checkout, not a bare repository.', { code: 'REPOSITORY_STATE_UNSUPPORTED' }
  );
  const existing = await readState(identity);
  if (offline && !existing) throw new SingularityFlowError(
    'Offline reuse requires a previously verified attachment pin and complete retained snapshot.', {
      code: 'AUTHORITY_UNAVAILABLE'
    }
  );
  const route = await resolveRoute(context, existing, { remote, authorityLocal });
  if (refresh && !existing) throw new SingularityFlowError(
    'This repository has no recorded FOS authority pin to refresh. Run sflow onboard first.', {
      code: 'AUTHORITY_PIN_MISSING'
    }
  );
  const request = {
    kind: offline ? 'offline-reuse' : refresh ? 'authority-refresh' : 'repository-onboard',
    repositoryInstanceId: identity.repositoryInstanceId,
    route,
    ...(refresh || offline
      ? { previousDescriptorSha256: existing?.descriptor?.descriptorSha256 ?? null }
      : {})
  };
  const requestDigest = `sha256:${recordSha256(request)}`;
  const operationId = `fos-op-${requestDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  if (resume && resume !== operationId) throw new SingularityFlowError(
    `Operation '${resume}' does not match the current attachment request '${operationId}'.`, {
      code: 'IDEMPOTENCY_CONFLICT', details: { expectedOperationId: operationId }
    }
  );

  return withSubjectLock(root, { kind: 'fos-attachment', id: identity.repositoryInstanceId }, async () => {
    const currentBinding = await readState(identity);
    if ((existing?.revision ?? null) !== (currentBinding?.revision ?? null)) {
      throw new SingularityFlowError(
        'The repository authority attachment changed while this operation was being prepared. Read the current pin and retry.',
        { code: 'AUTHORITY_CONFLICT' }
      );
    }
    if (currentBinding && JSON.stringify(currentBinding.descriptor.route) !== JSON.stringify(route)) {
      throw new SingularityFlowError(
        'This repository is already attached to a different authority route. A reviewed rebind operation is required; onboard cannot replace it.',
        { code: 'AUTHORITY_REBIND_REQUIRED' }
      );
    }
    const location = await routeLocation(context, route);
    if (currentBinding && !await sameAuthorityLocation(route, location,
      currentBinding.descriptor.authority.locator)) {
      throw new SingularityFlowError(
        'The configured authority location changed after onboarding. Refresh cannot silently rebind it; restore the recorded remote or use a reviewed rebind operation.',
        { code: 'AUTHORITY_CONFLICT' }
      );
    }
    if (offline) {
      const policy = offlinePolicyDecision(currentBinding, now);
      return Object.freeze({
        status: 'already-attached', changed: false, operationId,
        descriptor: currentBinding.descriptor, receipt: currentBinding.receipt,
        freshness: {
          mode: 'pinned-offline', observedAt: currentBinding.descriptor.observedAt,
          current: false, latest: false,
          ageMilliseconds: policy.ageMilliseconds,
          expiresAt: policy.expiresAt,
          policyId: policy.policyId,
          policySha256: policy.policySha256
        }
      });
    }
    if (currentBinding?.recovery?.required) {
      await stateWriter(stateFile(identity), `${JSON.stringify({
        schemaVersion: currentBinding.schemaVersion,
        kind: currentBinding.kind,
        revision: currentBinding.revision,
        descriptor: currentBinding.descriptor,
        receipt: currentBinding.receipt,
        offlineSnapshot: currentBinding.offlineSnapshot
      }, null, 2)}\n`, { mode: 0o600 });
    }
    // Ordinary onboarding is attachment, not freshness refresh. Once the exact route is attached,
    // repeat calls return its existing receipt without contacting the authority or rewriting local
    // state. `authority refresh` is the explicit operation that may advance the pin.
    if (currentBinding && !refresh && !resume) return Object.freeze({
      status: 'already-attached', changed: false, operationId,
      descriptor: currentBinding.descriptor, receipt: currentBinding.receipt,
      freshness: {
        mode: 'pinned-local', observedAt: currentBinding.descriptor.observedAt,
        current: false, latest: false
      }
    });
    const journalPath = journalFile(identity, operationId);
    let prior = null;
    try { prior = readRecord('fos-operation-journal', await readFile(journalPath, 'utf8')).record; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (prior && prior.requestDigest !== requestDigest) throw new SingularityFlowError(
      `Operation '${operationId}' was already used with different inputs.`, { code: 'IDEMPOTENCY_CONFLICT' }
    );
    const actor = gitCommitIdentity(root);
    const startedAt = prior?.startedAt ?? nowIso();
    let journal = operationRecord({
      operationId, requestDigest, request, actorBinding: actor,
      phase: 'prepared', startedAt, updatedAt: nowIso(), lastErrorCode: null
    });
    await writeJournal(identity, journal);
    try {
      const authority = await resolveRemoteStoryConfigurationAuthority(location);
      if (!authority) throw new SingularityFlowError(
        `The selected ${route.kind === 'local' ? 'local repository' : `remote '${route.remoteName}'`} does not advertise a reviewed sflow/config or verifiable state authority. Nothing was attached.`,
        { code: 'AUTHORITY_NOT_CONFIGURED' }
      );
      const snapshot = await loadStoryConfigurationSnapshot(authority);
      const observedAt = nowIso();
      const receiptId = `fos-receipt-${requestDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`;
      const folded = fold(snapshot);
      const offlineSnapshot = offlineSnapshotFor(snapshot, folded, observedAt);
      let descriptor = descriptorFor({
        identity, route, location, authority, snapshot, offlineSnapshot,
        operationId, receiptId, observedAt
      });
      const current = await readState(identity);
      const unchanged = Boolean(current
        && current.descriptor.authority.commit === descriptor.authority.commit
        && current.descriptor.authority.sourceCommit === descriptor.authority.sourceCommit
        && current.descriptor.verifiedFoldSha256 === descriptor.verifiedFoldSha256
        && current.descriptor.policySha256 === descriptor.policySha256
        && JSON.stringify(current.descriptor.route) === JSON.stringify(descriptor.route));
      if (unchanged) descriptor = current.descriptor;
      const receipt = unchanged
        ? current.receipt
        : receiptFor(descriptor, actor, { changed: true });
      const candidate = {
        schemaVersion: currentSchemaVersion('fos-attachment-state'),
        kind: 'fos-attachment-state',
        revision: (current?.revision ?? 0) + (unchanged ? 0 : 1),
        descriptor,
        receipt,
        offlineSnapshot: unchanged ? current.offlineSnapshot : offlineSnapshot
      };
      journal = operationRecord({
        ...journal, phase: 'validated', candidateDigest: descriptor.descriptorSha256,
        authorityCommit: authority.commit, candidate, updatedAt: nowIso()
      });
      await writeJournal(identity, journal);
      if (!unchanged) {
        await stateWriter(stateFile(identity), `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
      }
      journal = operationRecord({
        ...journal, phase: 'completed', observedOutcome: {
          descriptorSha256: descriptor.descriptorSha256,
          receiptId: receipt.receiptId,
          changed: !unchanged
        }, updatedAt: nowIso()
      });
      await writeJournal(identity, journal);
      return Object.freeze({
        status: unchanged ? 'already-attached' : refresh ? 'refreshed' : 'attached',
        changed: !unchanged,
        operationId,
        descriptor,
        receipt,
        freshness: { mode: 'observed-online', observedAt, current: true, latest: true }
      });
    } catch (error) {
      await writeJournal(identity, operationRecord({
        ...journal, phase: 'recovery-required', updatedAt: nowIso(),
        lastErrorCode: error?.code ?? 'AUTHORITY_UNAVAILABLE'
      })).catch(() => {});
      throw error;
    }
  });
}

export async function refreshFosAuthority(root, options = {}) {
  return onboardRepository(root, { ...options, refresh: true });
}
