import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  loadStoryConfigurationSnapshot, resolveRemoteStoryConfigurationAuthority
} from './configuration-branch.mjs';
import { gitCommitIdentity } from './git.mjs';
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

async function readState(identity) {
  try {
    const parsed = readRecord('fos-attachment-state', await readFile(stateFile(identity), 'utf8')).record;
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
    return Object.freeze({ ...parsed, descriptor, receipt });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new SingularityFlowError(
      'The FOS attachment state is not valid JSON.', { code: 'AUTHORITY_PIN_INVALID' }
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
  if (route.kind === 'local') return context.root;
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

function descriptorFor({
  identity, route, location, authority, snapshot, operationId, receiptId, observedAt
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
  if (sanitizeRemote(location) !== state.descriptor.authority.locator) {
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

export async function onboardRepository(root, {
  remote = null,
  authorityLocal = false,
  offline = false,
  resume = null,
  refresh = false,
  cache = true
} = {}) {
  if (offline) throw new SingularityFlowError(
    'Pinned offline attachment is not enabled because no approved FOS offline-freshness policy is available. Retry online or add that policy through the normal configuration authority.',
    { code: 'AUTHORITY_UNAVAILABLE' }
  );
  const context = createRepoContext(root, { cache });
  const identity = await context.identity();
  if (identity.bare) throw new SingularityFlowError(
    'FOS onboarding attaches a working checkout, not a bare repository.', { code: 'REPOSITORY_STATE_UNSUPPORTED' }
  );
  const existing = await readState(identity);
  const route = await resolveRoute(context, existing, { remote, authorityLocal });
  if (refresh && !existing) throw new SingularityFlowError(
    'This repository has no recorded FOS authority pin to refresh. Run sflow onboard first.', {
      code: 'AUTHORITY_PIN_MISSING'
    }
  );
  const request = {
    kind: refresh ? 'authority-refresh' : 'repository-onboard',
    repositoryInstanceId: identity.repositoryInstanceId,
    route,
    ...(refresh ? { previousDescriptorSha256: existing?.descriptor?.descriptorSha256 ?? null } : {})
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
    if (currentBinding && currentBinding.descriptor.authority.locator !== sanitizeRemote(location)) {
      throw new SingularityFlowError(
        'The configured authority location changed after onboarding. Refresh cannot silently rebind it; restore the recorded remote or use a reviewed rebind operation.',
        { code: 'AUTHORITY_CONFLICT' }
      );
    }
    // Ordinary onboarding is attachment, not freshness refresh. Once the exact route is attached,
    // repeat calls return its existing receipt without contacting the authority or rewriting local
    // state. `authority refresh` is the explicit operation that may advance the pin.
    if (currentBinding && !refresh && !resume) return Object.freeze({
      status: 'already-attached', changed: false, operationId,
      descriptor: currentBinding.descriptor, receipt: currentBinding.receipt,
      freshness: { mode: 'pinned-local', observedAt: currentBinding.descriptor.observedAt }
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
      let descriptor = descriptorFor({
        identity, route, location, authority, snapshot, operationId, receiptId, observedAt
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
      journal = operationRecord({
        ...journal, phase: 'validated', candidateDigest: descriptor.descriptorSha256,
        authorityCommit: authority.commit, updatedAt: nowIso()
      });
      await writeJournal(identity, journal);
      if (!unchanged) {
        await writeAtomic(stateFile(identity), `${JSON.stringify({
          schemaVersion: currentSchemaVersion('fos-attachment-state'),
          kind: 'fos-attachment-state',
          revision: (current?.revision ?? 0) + 1,
          descriptor,
          receipt
        }, null, 2)}\n`, { mode: 0o600 });
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
        freshness: { mode: 'observed-online', observedAt }
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
