import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  CAPABILITIES_PATH,
  capabilityDeliveries,
  capabilityForRepository,
  capabilityPath,
  IMPLICIT_CAPABILITY_ID,
  resolveCapabilityOwner,
  resolveImplicitCapability,
  resolveExplicitCapability,
  resolveEffectiveCapabilityPolicy,
  resolveCapabilitySourceScope,
  validateCapabilities
} from './capabilities.mjs';
import { loadDefinition, WORKFLOW_PATH } from './config.mjs';
import {
  CONFIGURATION_SOURCE_PATH, readConfigurationSource
} from './configuration-branch.mjs';
import {
  configurationReadAuthority, configurationReadRoot
} from './configuration-read-scope.mjs';
import {
  normalizeWorldModelManifest,
  resolveWorldModelSource,
  validateWorldModelDirectory,
  worldModelFreshness,
  worldModelSelectionEntry,
  worldModelSourceSnapshot
} from './grounding.mjs';
import {
  isWorldModelV4, resolveWorldModelV4Grounding
} from './world-model/commands.mjs';
import {
  cachedWorldModelV4AuthorityPresent, refreshWorldModelV4Authority
} from './world-model/authority-refresh.mjs';
import { worldModelStateAuthority } from './world-model/authority-config.mjs';
import { ledgerLog } from './ledger.mjs';
import { withWorldModelSourceScope } from './source-scope.mjs';
import {
  activeWorkspaceFile, workspaceMemberContextForRepository, workspaceRegistryFile
} from './workspace-context.mjs';
import { workspaceRepositoryPath } from './workspace.mjs';
import {
  posix, run, secureRepositoryPath, SingularityFlowError, snapshot, writeBytes, writeJson
} from './util.mjs';
import { isWorldModelAvailabilityError } from './world-model-availability.mjs';
import { configuredRemoteIdentity } from './git-remote-diagnostics.mjs';

const CAPABILITY_CONTEXT_SCHEMA = 1;
const CAPABILITY_WORLD_MODEL_UNAVAILABLE = 'world_model.capability_unavailable';
const CAPABILITY_WORLD_MODEL_AVAILABILITY_CODES = new Set([
  CAPABILITY_WORLD_MODEL_UNAVAILABLE,
  'world_model.capability_missing',
  'world_model.capability_stale',
  'WMB_MANIFEST_MISSING',
  'WMB_SOURCE_SNAPSHOT_STALE',
  'WMB_STATE_AUTHORITY_REFRESH_REQUIRED',
  'WMB_STATE_AUTHORITY_UNAVAILABLE',
  'WMB_VIEW_UNAVAILABLE',
  'world_model.state_extraction_failed'
]);
const CAPABILITY_WORLD_MODEL_AVAILABILITY_STATUSES = new Set([
  'missing',
  'world-model-missing',
  'world-model-stale',
  'world-model-unavailable'
]);
const CAPABILITY_WORLD_MODEL_SUCCESS_STATUSES = new Set(['local-grounding', 'pinned']);
const LEGACY_CAPABILITY_AVAILABILITY_REFRESH = new Set([
  'offline-cached', 'offline-no-state-copy', 'remote-absent', 'timeout-cached', 'unavailable'
]);
const LEGACY_CAPABILITY_AVAILABILITY_CLASSIFICATIONS = new Set([
  'authentication-required', 'authorization-denied', 'credential-helper-unavailable',
  'git-unavailable', 'sso-authorization-required', 'working-directory-unavailable',
  'branch-not-found', 'network-transient', 'offline', 'proxy-configuration', 'rate-limited',
  'remote-not-found', 'tls-trust'
]);
let capabilityMapReadObserverForTests = null;

/** @internal Test-only hook for exercising path replacement at the descriptor boundary. */
export function setCapabilityMapReadObserverForTests(observer = null) {
  if (observer !== null && typeof observer !== 'function') {
    throw new TypeError('Capability map read observer must be a function or null.');
  }
  capabilityMapReadObserverForTests = observer;
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function stricter(left = 'off', right = 'off', order = ['off', 'warn', 'enforce']) {
  return order[Math.max(order.indexOf(left), order.indexOf(right))];
}

function intersectConfigured(existing = [], required = null) {
  if (required == null) return [...existing];
  if (!existing?.length) return [...required];
  return existing.filter((value) => required.includes(value));
}

function tightenContextPolicy(current = {}, boundary = null) {
  if (!boundary) return current;
  const order = ['keep', 'compact', 'new'];
  const choose = (value) => stricter(value ?? 'keep', boundary, order);
  return {
    ...current,
    onApproval: choose(current.onApproval),
    onRejection: choose(current.onRejection),
    phaseOverrides: Object.fromEntries(Object.entries(current.phaseOverrides ?? {})
      .map(([phase, value]) => [phase, choose(value)]))
  };
}

function tightenStorage(storage, policy = {}) {
  if (!storage) return storage;
  const allowed = Object.hasOwn(policy, 'storageProviders') ? new Set(policy.storageProviders) : null;
  const providers = Object.fromEntries(Object.entries(storage.providers ?? {})
    .filter(([id]) => !allowed || allowed.has(id)));
  const allowedMimeTypes = intersectConfigured(storage.allowedMimeTypes ?? [], policy.allowedMimeTypes);
  const maxBytes = policy.maxDocumentBytes
    ? Math.min(storage.maxBytes ?? policy.maxDocumentBytes, policy.maxDocumentBytes)
    : storage.maxBytes;
  const defaultProvider = providers[storage.defaultProvider]
    ? storage.defaultProvider
    : Object.keys(providers)[0] ?? null;
  return { ...storage, providers, defaultProvider, allowedMimeTypes, maxBytes };
}

async function sourceForRepository(root) {
  const active = await workspaceMemberContextForRepository(
    root,
    activeWorkspaceFile(),
    workspaceRegistryFile(),
    { strict: true }
  );
  if (!active) {
    let repositoryId = null;
    const portfolioPath = path.join(root, 'singularity/portfolio.yml');
    if (existsSync(portfolioPath)) {
      try {
        const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
        const remote = normalizedRemote(run('git', ['config', '--get', 'remote.origin.url'], { cwd: root, allowFailure: true }).stdout);
        const matches = Object.entries(portfolio?.repositories ?? {})
          .filter(([, repository]) => normalizedRemote(repository?.url) === remote)
          .map(([id]) => id);
        if (matches.length === 1) repositoryId = matches[0];
        else if (!remote && Object.keys(portfolio?.repositories ?? {}).length === 1) repositoryId = Object.keys(portfolio.repositories)[0];
      } catch { /* A malformed portfolio is reported by its own validator; capability discovery stays optional. */ }
    }
    return { active: null, workspace: null, mapRoot: root, repositoryId };
  }
  const workspace = active.workspace;
  if (!workspace) {
    throw new SingularityFlowError(
      'The active workspace member was not bound to a validated workspace manifest snapshot.',
      { code: 'ACTIVE_WORKSPACE_UNAVAILABLE' }
    );
  }
  const lead = workspace.repositories[workspace.leadRepository];
  return {
    active,
    workspace,
    mapRoot: workspaceRepositoryPath(workspace, lead),
    repositoryId: active.repositoryId
  };
}

function normalizedRemote(value) {
  return String(value ?? '').trim().replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
}

function implicitRepositoryId(source, remoteUrl) {
  if (source.repositoryId) return source.repositoryId;
  const tail = String(remoteUrl ?? '').replaceAll('\\', '/').replace(/\/+$/, '')
    .split('/').pop()?.replace(/\.git$/i, '') ?? '';
  const normalized = tail.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'repository';
}

async function implicitLifecycleCapability(root, source, {
  pinnedConfiguration = null, configurationRoot = root
} = {}) {
  const config = await loadDefinition(root);
  const remote = configuredRemoteIdentity(root, 'origin');
  // A remote is the strongest repository identity, but local-only Git repositories are a supported
  // first-Story path. Bind those repositories to their root history, not the moving HEAD: using
  // HEAD made an unrelated configuration-only commit change the implicit capability identity and
  // falsely invalidate an otherwise byte-identical World Model. Root commits remain clone/path/user
  // independent and stable throughout ordinary history. An unborn repository still falls back to
  // the approved workflow bytes.
  const repositoryRoots = run('git', ['rev-list', '--max-parents=0', 'HEAD'], {
    cwd: root, allowFailure: true
  }).stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).sort().join('\n');
  const workflowBytes = await readFile(path.join(configurationRoot, WORKFLOW_PATH));
  const repositoryIdentitySha256 = remote.fingerprint
    ? `sha256:${remote.fingerprint}`
    : `sha256:${createHash('sha256').update(repositoryRoots || workflowBytes).digest('hex')}`;
  const resolution = resolveImplicitCapability({
    repositoryId: implicitRepositoryId(source, remote.url),
    repositoryIdentitySha256,
    approvedConfigurationSha256: `sha256:${createHash('sha256')
      .update(workflowBytes)
      .digest('hex')}`,
    approvalProfile: config.approvalSecurity?.profile ?? 'team',
    basePolicy: {}
  });
  return {
    schemaVersion: CAPABILITY_CONTEXT_SCHEMA,
    mode: 'implicit',
    id: IMPLICIT_CAPABILITY_ID,
    name: resolution.capability.label,
    kind: resolution.capability.kind,
    path: [IMPLICIT_CAPABILITY_ID],
    repositoryId: resolution.repository.id,
    deliveries: [{
      id: IMPLICIT_CAPABILITY_ID,
      name: resolution.capability.label,
      repository: resolution.repository.id,
      repositories: [resolution.repository.id]
    }],
    map: {
      path: null,
      sha256: null,
      authority: pinnedConfiguration ? 'pinned-story-configuration' : 'implicit-approved-configuration',
      repository: remote.url,
      branch: pinnedConfiguration?.branch ?? null,
      commit: pinnedConfiguration?.commit ?? null
    },
    effectiveResolution: resolution,
    resolutionSha256: resolution.resolutionSha256,
    basePolicy: resolution.policy,
    policy: resolution.policy,
    sourceScope: { sourceRoots: [], sharedRoots: [] },
    leases: [],
    warnings: []
  };
}

function soleDelivery(definition) {
  // Collection ancestors also return their descendant deliveries from `capabilityDeliveries`.
  // Counting those ancestors made one real delivery look like three choices (enterprise, product,
  // delivery), so automatic intake could never select the only approved delivery in a normal
  // hierarchy. The selectable unit is the delivery node itself.
  const rows = Object.entries(definition.capabilities ?? {})
    .filter(([, capability]) => capability.kind === 'delivery')
    .map(([id]) => ({
      id,
      repositories: capabilityDeliveries(definition, id).flatMap((item) => item.repositories ?? [])
    }))
    .filter((entry) => entry.repositories.length);
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * Retain one exact capability-map byte sequence for parsing, validation, and provenance.
 *
 * Returning null is reserved for a map that is genuinely absent at the secure path check. A map
 * that disappears after that check, is unsafe, cannot be parsed, or violates the capability schema
 * is an authority failure and must propagate to the caller.
 */
export function validateCapabilityMapBytes(value) {
  const bytes = Buffer.from(value);
  const definition = validateCapabilities(YAML.parse(bytes.toString('utf8')));
  return {
    definition,
    snapshot: {
      exists: true,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  };
}

export function validateConfigurationSnapshotCapabilities(snapshot, { capabilityId = null } = {}) {
  if (!snapshot) return null;
  const asset = snapshot.assets?.find((entry) => entry.relative === CAPABILITIES_PATH) ?? null;
  if (!asset) {
    if (capabilityId) {
      throw new SingularityFlowError(
        `No ${CAPABILITIES_PATH} is available in the approved configuration snapshot.`);
    }
    return { definition: null, capabilityId: null, mapSha256: null };
  }
  const retained = validateCapabilityMapBytes(asset.contents);
  if (asset.sha256 && retained.snapshot.sha256 !== asset.sha256) {
    throw new SingularityFlowError(
      `Verified Story configuration snapshot changed in memory: ${CAPABILITIES_PATH}.`,
      { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
    );
  }
  if (capabilityId && !retained.definition.capabilities[capabilityId]) {
    throw new SingularityFlowError(`Unknown capability '${capabilityId}'.`, {
      code: 'CAPABILITY_UNKNOWN',
      details: {
        capabilityId,
        mapPath: CAPABILITIES_PATH,
        mapSha256: retained.snapshot.sha256,
        authority: 'approved-configuration-snapshot'
      }
    });
  }
  return {
    definition: retained.definition,
    capabilityId: capabilityId ?? soleDelivery(retained.definition),
    mapSha256: retained.snapshot.sha256
  };
}

async function readRetainedCapabilityMap(root) {
  const located = await secureRepositoryPath(root, CAPABILITIES_PATH, {
    label: 'Capability map', type: 'file'
  });
  if (!located.exists) return null;
  await capabilityMapReadObserverForTests?.({ stage: 'located', path: located.absolute });
  let handle;
  try {
    // `secureRepositoryPath` proves every path component, then this descriptor freezes the exact
    // file used for both policy parsing and provenance. O_NOFOLLOW closes the replacement window
    // on platforms that expose it; the descriptor/path identity comparison also fails closed on
    // platforms where that flag is unavailable or a filesystem implements links as reparse points.
    handle = await open(
      located.absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    await capabilityMapReadObserverForTests?.({ stage: 'opened', path: located.absolute });
    const [opened, current] = await Promise.all([
      handle.stat(),
      lstat(located.absolute)
    ]);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
        || opened.dev !== located.entry.dev || opened.ino !== located.entry.ino
        || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new SingularityFlowError(
        `Capability map changed while it was being retained: ${CAPABILITIES_PATH}. Refresh approved configuration and retry; nothing was changed.`,
        {
          code: 'CAPABILITY_MAP_UNSAFE',
          details: { path: CAPABILITIES_PATH, reason: 'descriptor-identity-changed' }
        }
      );
    }
    return validateCapabilityMapBytes(await handle.readFile());
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    if (['ELOOP', 'ENOENT', 'ENOTDIR'].includes(error?.code)) {
      throw new SingularityFlowError(
        `Capability map changed while it was being retained: ${CAPABILITIES_PATH}. Refresh approved configuration and retry; nothing was changed.`,
        {
          code: 'CAPABILITY_MAP_UNSAFE',
          details: { path: CAPABILITIES_PATH, reason: error.code.toLowerCase() }
        }
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Resolve the organisational capability that owns the current repository.
 *
 * The map is read from the active workspace's lead repository when this is a participant clone;
 * otherwise the repository's own map is used. The returned value is safe to commit: it contains
 * hashes and repository identifiers, never machine-specific absolute paths.
 */
export async function resolveLifecycleCapability(root, {
  capabilityId = null,
  subjectPath = null,
  required = false,
  offline = false,
  expectedMapSha256 = null,
  refuseAmbiguous = false
} = {}) {
  const source = await sourceForRepository(root);
  const applicationRoot = path.resolve(root);
  const scopedConfigurationRoot = configurationReadRoot(root);
  const hasApprovedReadScope = path.resolve(scopedConfigurationRoot) !== applicationRoot;
  const approvedReadAuthority = configurationReadAuthority(root);
  const hasPinnedConfiguration = existsSync(path.join(root, CONFIGURATION_SOURCE_PATH));
  let pinnedConfiguration = null;
  if (hasPinnedConfiguration && !hasApprovedReadScope) {
    // A lifecycle branch carries the exact approved configuration it was created with. Verify the
    // complete pin before trusting any one file from it; falling back to the mutable workspace
    // checkout when this record is corrupt would silently replace pinned policy with unrelated
    // branch-local bytes.
    pinnedConfiguration = await readConfigurationSource(root, { verify: true });
  }
  // The active workspace identifies repository ownership, not configuration authority. During an
  // isolated Story start its canonical checkout may be on an application branch with an old or
  // generic map, while `root` already contains the exact approved snapshot. An approved read scope
  // has the same rule: the secure capability-map read is deliberately redirected to its verified
  // overlay. Parsing and provenance hashing share one retained byte buffer, so an authority change
  // cannot produce policy from one version and a receipt for another.
  let mapRoot = hasPinnedConfiguration || hasApprovedReadScope ? root : source.mapRoot;
  let loadedMap = await readRetainedCapabilityMap(mapRoot);
  if (!loadedMap && mapRoot !== root) {
    mapRoot = root;
    loadedMap = await readRetainedCapabilityMap(root);
  }
  if (!loadedMap) {
    if (expectedMapSha256) {
      throw new SingularityFlowError(
        `Capability authority changed between Story preflight and creation: expected ${expectedMapSha256}, resolved no map. Refresh Story intake and retry; nothing was changed.`, {
          code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
          details: {
            capabilityId,
            expectedMapSha256,
            actualMapSha256: null
          }
        }
      );
    }
    if (capabilityId && capabilityId !== IMPLICIT_CAPABILITY_ID) {
      throw new SingularityFlowError(
        `Unknown capability '${capabilityId}'. This repository currently uses the implicit '${IMPLICIT_CAPABILITY_ID}' capability.`,
        { code: 'CAPABILITY_UNKNOWN', details: { capabilityId, available: [IMPLICIT_CAPABILITY_ID] } }
      );
    }
    return implicitLifecycleCapability(root, source, {
      pinnedConfiguration,
      configurationRoot: scopedConfigurationRoot
    });
  }

  const { definition, snapshot: mapSnapshot } = loadedMap;
  let selected = capabilityId;
  if (!selected && subjectPath != null) {
    selected = resolveCapabilityOwner(definition, subjectPath).capabilityId;
  }
  if (!selected && source.repositoryId) selected = capabilityForRepository(definition, source.repositoryId)?.id ?? null;
  if (!selected && source.workspace?.capabilities?.length === 1) selected = source.workspace.capabilities[0];
  if (!selected) selected = soleDelivery(definition);
  // Compare the identity of the same retained bytes used for parsing before any early capability-free
  // return. A map that disappeared, became collection-only, or stopped mapping this repository must
  // not turn a preflighted delivery Story into an ungoverned Story merely because resolution now
  // returns null.
  if (expectedMapSha256 && mapSnapshot.sha256 !== expectedMapSha256) {
    throw new SingularityFlowError(
      `Capability authority changed between Story preflight and creation: expected ${expectedMapSha256}, resolved ${mapSnapshot.sha256}. Refresh Story intake and retry; nothing was changed.`, {
        code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
        details: {
          capabilityId: capabilityId ?? selected ?? null,
          expectedMapSha256,
          actualMapSha256: mapSnapshot.sha256
        }
      }
    );
  }
  if (!selected) {
    const deliveries = Object.entries(definition.capabilities ?? {})
      .filter(([, capability]) => capability.kind === 'delivery')
      .map(([id]) => id);
    if (refuseAmbiguous && deliveries.length > 1) {
      throw new SingularityFlowError(
        `This repository can resolve to more than one capability (${deliveries.join(', ')}). Pass --capability <id> before building reusable repository grounding.`,
        {
          code: 'WMB_CAPABILITY_SELECTION_REQUIRED',
          details: { capabilityIds: deliveries, option: '--capability <id>' }
        }
      );
    }
    if (required && deliveries.length > 1) throw new SingularityFlowError(
      `This repository maps to more than one approved capability (${deliveries.join(', ')}). Select one with --capability <id>.`,
      {
        code: 'CAPABILITY_SELECTION_REQUIRED',
        details: { capabilityIds: deliveries, option: '--capability <id>' }
      }
    );
    if (required) throw new SingularityFlowError(
      'No approved delivery capability maps this repository. Register and approve one before starting Auto work.',
      {
        code: 'CAPABILITY_REGISTRATION_REQUIRED',
        details: {
          capabilityIds: deliveries,
          nextAction: 'Open People & approvals → Capabilities in VS Code, or run `singularity-flow capability map <lower-case-kebab-id> --repository <REPOSITORY-URL>`.'
        }
      }
    );
    return null;
  }
  // Validate after every derivation path. Previously only an explicit --capability value was
  // checked; a workspace-derived ID reached policy folding and produced a late, context-free
  // "Unknown capability" failure.
  if (!definition.capabilities[selected]) {
    throw new SingularityFlowError(
      `Unknown capability '${selected}'.`, {
        code: 'CAPABILITY_UNKNOWN',
        details: {
          capabilityId: selected,
          mapPath: CAPABILITIES_PATH,
          mapSha256: mapSnapshot.sha256 ?? null,
          authority: hasApprovedReadScope && approvedReadAuthority
            ? 'approved-configuration'
            : hasPinnedConfiguration ? 'pinned-story-configuration' : 'working-tree'
        }
      }
    );
  }

  const config = await loadDefinition(mapRoot).catch(() => null);
  let entries = [];
  let leaseWarning = null;
  if (config?.ledger?.enabled && !offline) {
    try { entries = await ledgerLog(mapRoot, config.ledger, { limit: 10000 }); }
    catch (error) { leaseWarning = `Capability leases could not be read: ${error.message}`; }
  } else if (config?.ledger?.enabled && offline) {
    leaseWarning = 'Offline capability resolution does not refresh break-glass leases from the state branch.';
  }
  const effective = resolveEffectiveCapabilityPolicy(definition, selected, entries);
  const node = definition.capabilities[selected];
  // An explicit approved read overlay describes current configuration for new-work surfaces such
  // as Auto planning. Its bytes and provenance must move together even when the launch checkout is
  // an older pinned Story. Ordinary lifecycle calls have no overlay and continue to use the pin.
  const authorityProvenance = hasApprovedReadScope && approvedReadAuthority
    ? {
        // The approved reader freezes this credential-free identity when it selects the ref.
        // Do not reconstruct provenance later from mutable local Git configuration.
        repository: approvedReadAuthority.remote ?? null,
        branch: approvedReadAuthority.manifest?.source?.branch
          ?? (String(approvedReadAuthority.ref ?? '').endsWith('/state') ? 'state' : 'sflow/config'),
        commit: approvedReadAuthority.manifest?.source?.commit ?? approvedReadAuthority.commit ?? null,
        authority: 'approved-configuration'
      }
    : pinnedConfiguration
    ? {
        repository: pinnedConfiguration.repository,
        branch: pinnedConfiguration.branch,
        commit: pinnedConfiguration.commit,
        authority: 'pinned-story-configuration'
      }
    : {
          repository: run('git', ['config', '--get', 'remote.origin.url'], {
            cwd: mapRoot, allowFailure: true
          }).stdout.trim() || null,
          branch: run('git', ['branch', '--show-current'], {
            cwd: mapRoot, allowFailure: true
          }).stdout.trim() || null,
          commit: run('git', ['rev-parse', '--verify', 'HEAD'], {
            cwd: mapRoot, allowFailure: true
          }).stdout.trim() || null,
          authority: 'working-tree'
      };
  const mode = definition.version === 2 && definition.management?.mode === 'sflow-cli'
    ? 'explicit-managed' : 'explicit-legacy';
  const sourceScope = resolveCapabilitySourceScope(definition, selected);
  const repositoryIdentity = configuredRemoteIdentity(root, 'origin');
  const effectiveResolution = resolveExplicitCapability({
    mode,
    repositoryId: source.repositoryId ?? authorityProvenance.repository ?? path.basename(root),
    repositoryIdentitySha256: repositoryIdentity.fingerprint
      ? `sha256:${repositoryIdentity.fingerprint}`
      : `sha256:${createHash('sha256').update(String(source.repositoryId ?? authorityProvenance.repository ?? path.basename(root))).digest('hex')}`,
    approvedConfigurationSha256: `sha256:${mapSnapshot.sha256}`,
    capabilityStateSha256: `sha256:${mapSnapshot.sha256}`,
    capabilityId: selected,
    label: node.name ?? selected,
    kind: node.kind,
    sourceScope,
    teams: node.teams ?? [],
    dependencies: node.dependencies ?? [],
    policy: effective.policy,
    approvalProfile: config?.approvalSecurity?.profile ?? 'team'
  });
  return {
    schemaVersion: 1,
    mode,
    id: selected,
    name: node.name ?? selected,
    kind: node.kind,
    path: capabilityPath(definition, selected),
    repositoryId: source.repositoryId,
    deliveries: capabilityDeliveries(definition, selected),
    map: {
      path: CAPABILITIES_PATH,
      sha256: mapSnapshot.sha256,
      ...authorityProvenance
    },
    basePolicy: effective.basePolicy,
    policy: effective.policy,
    sourceScope,
    effectiveResolution,
    resolutionSha256: effectiveResolution.resolutionSha256,
    leases: effective.leases.map((lease) => ({
      leaseId: lease.leaseId,
      capabilityId: lease.capabilityId,
      expiresAt: lease.expiresAt,
      authorityGroup: lease.authorityGroup,
      relaxation: lease.relaxation
    })),
    warnings: leaseWarning ? [leaseWarning] : []
  };
}

export function applyCapabilityPolicyToWorkResolution(resolution, capability) {
  if (!capability) return resolution;
  const policy = capability.policy ?? {};
  const worldModelOff = resolution.intelligence?.worldModel === 'off';
  for (const authority of policy.requiredAuthorityGroups ?? []) {
    if (!resolution.approvalAuthorities?.[authority]) {
      throw new SingularityFlowError(`Capability '${capability.id}' requires unknown approval authority '${authority}'.`);
    }
  }
  const allowed = Object.hasOwn(policy, 'allowedPhases') ? new Set(policy.allowedPhases) : null;
  const phases = resolution.phases.map((phase) => {
    if (allowed && !allowed.has(phase.id)) {
      throw new SingularityFlowError(`Capability '${capability.id}' does not allow workflow phase '${phase.id}'.`);
    }
    if (Object.hasOwn(policy, 'writeScopes') && !policy.writeScopes.includes(phase.writeScope)) {
      throw new SingularityFlowError(`Capability '${capability.id}' does not allow write scope '${phase.writeScope}' for phase '${phase.id}'.`);
    }
    return {
      ...phase,
      worldModel: {
        ...(phase.worldModel ?? {}),
        // An explicit generic benchmark arm is an experimental isolation boundary. Capability
        // policy still tightens approvals, checks, scopes, and gates, but cannot contaminate it by
        // adding repository intelligence that the selected work type pins off.
        views: worldModelOff
          ? []
          : unique([...(phase.worldModel?.views ?? []), ...(policy.requiredWorldModelViews ?? [])])
      },
      qualityCommands: unique([...(phase.qualityCommands ?? []), ...(policy.qualityCommands ?? [])]),
      approval: {
        ...(phase.approval ?? {}),
        authorities: unique([...(phase.approval?.authorities ?? []), ...(policy.requiredAuthorityGroups ?? [])]),
        minimum: Math.max(phase.approval?.minimum ?? 1, policy.approvalMinimum ?? 1),
        allowSelfApproval: policy.allowSelfApproval == null
          ? phase.approval?.allowSelfApproval !== false
          : policy.allowSelfApproval && phase.approval?.allowSelfApproval !== false
      }
    };
  });
  const sequenceGates = policy.gateSeverity === 'block'
    ? Object.fromEntries(Object.keys(resolution.sequenceGates ?? { default: 'hard' }).map((gate) => [gate, 'hard']))
    : resolution.sequenceGates;
  return {
    ...resolution,
    phases,
    sequenceGates,
    contextPolicy: tightenContextPolicy(resolution.contextPolicy, policy.contextBoundary),
    documents: {
      ...(resolution.documents ?? {}),
      allowedMimeTypes: intersectConfigured(resolution.documents?.allowedMimeTypes ?? [], policy.allowedMimeTypes)
    },
    worldModelStaleness: policy.worldModelStaleness ?? null,
    worldModelSourceScope: worldModelOff ? null : capability.sourceScope ?? null
  };
}

export function applyCapabilityPolicyToInitiativeResolution(resolution, capability) {
  if (!capability) return resolution;
  const policy = capability.policy ?? {};
  const allowed = Object.hasOwn(policy, 'allowedPhases') ? new Set(policy.allowedPhases) : null;
  const authorities = policy.requiredAuthorityGroups ?? [];
  for (const authority of authorities) {
    if (!resolution.approvalAuthorities?.[authority]) {
      throw new SingularityFlowError(`Capability '${capability.id}' requires unknown approval authority '${authority}'.`);
    }
  }
  // A contract that explicitly needs no approval stays approval-free. Capability policy tightens
  // real approval gates; it must not silently invent a malformed `mode: none, minimum: 1` gate.
  const approval = (value) => value?.mode === 'none' ? value : ({
    ...value,
    authorities: unique([...(value?.authorities ?? []), ...authorities]),
    minimum: Math.max(value?.minimum ?? 1, policy.approvalMinimum ?? 1),
    allowSelfApproval: policy.allowSelfApproval == null
      ? value?.allowSelfApproval !== false
      : policy.allowSelfApproval && value?.allowSelfApproval !== false
  });
  const gateOrder = ['off', 'warn', 'block'];
  const storage = tightenStorage(resolution.storage, policy);
  const jira = resolution.jira ? {
    ...resolution.jira,
    allowedHosts: intersectConfigured(resolution.jira.allowedHosts ?? [], policy.jiraHosts),
    allowedProjects: intersectConfigured(resolution.jira.allowedProjects ?? [], policy.jiraProjects),
    writePolicy: {
      ...(resolution.jira.writePolicy ?? {}),
      operations: intersectConfigured(resolution.jira.writePolicy?.operations ?? [], policy.jiraOperations),
      allowedFields: intersectConfigured(resolution.jira.writePolicy?.allowedFields ?? [], policy.jiraFields)
    }
  } : resolution.jira;
  return {
    ...resolution,
    repositories: Object.fromEntries(Object.entries(resolution.repositories ?? {}).map(([id, repository]) => [id, {
      ...repository,
      requiredChecks: unique([...(repository.requiredChecks ?? []), ...(policy.requiredChecks ?? [])])
    }])),
    storage,
    jira,
    contextPolicy: tightenContextPolicy(resolution.contextPolicy, policy.contextBoundary),
    worldModelStaleness: policy.worldModelStaleness ?? null,
    worldModelSourceScope: capability.sourceScope ?? null,
    phases: resolution.phases.map((phase) => {
      if (allowed && !allowed.has(phase.id)) {
        throw new SingularityFlowError(`Capability '${capability.id}' does not allow initiative phase '${phase.id}'.`);
      }
      return {
        ...phase,
        worldModelViews: unique([...(phase.worldModelViews ?? []), ...(policy.requiredWorldModelViews ?? [])]),
        bundleApproval: approval(phase.bundleApproval),
        outputs: phase.outputs.map((output) => ({ ...output, approval: approval(output.approval) })),
        checklist: phase.checklist.map((check) => ({
          ...check,
          gate: policy.gateSeverity
            ? stricter(check.gate ?? 'off', policy.gateSeverity, gateOrder)
            : check.gate,
          approval: approval(check.approval)
        }))
      };
    })
  };
}

function modelFiles(manifest, views) {
  const normalized = manifest?.source_schema_version ? manifest : normalizeWorldModelManifest(manifest);
  const allowLegacyFallback = normalized.source_schema_version !== '3.0';
  const core = worldModelSelectionEntry(normalized, { kind: 'core', tier: 'full' }, { allowLegacyFallback });
  const selected = new Map(core?.path ? [[core.path, new Set(['core'])]] : []);
  for (const view of views) {
    const relative = worldModelSelectionEntry(normalized, {
      kind: 'view', view, tier: 'full'
    }, { allowLegacyFallback })?.path;
    if (!relative) continue;
    if (!selected.has(relative)) selected.set(relative, new Set());
    selected.get(relative).add(view);
  }
  return [...selected].map(([relative, matchedViews]) => ({ relative, views: [...matchedViews] }));
}

/** Resolve a sibling model against that repository's current capability-scoped source identity. */
export async function resolveCapabilityWorldModelCandidate(repositoryRoot, definition, {
  sourceScope = null,
  views = [],
  capabilityId = null
} = {}) {
  const groundingDefinition = withWorldModelSourceScope(definition ?? {}, sourceScope);
  const worldModel = groundingDefinition.worldModel ?? { outputDir: 'singularity/world-model' };
  const outputDir = worldModel.outputDir ?? 'singularity/world-model';
  const stateAuthority = worldModelStateAuthority(groundingDefinition);
  const requiredSelections = [
    { kind: 'core', tier: 'full' },
    ...unique(views).map((view) => ({ kind: 'view', view, tier: 'full' }))
  ];
  const worldModelConfig = {
    ...worldModel,
    ledger: groundingDefinition.ledger,
    stateBranch: stateAuthority.branch,
    remote: stateAuthority.remote,
    definition: groundingDefinition
  };
  if (isWorldModelV4(worldModelConfig)) {
    const phase = 'capability-context';
    const declaredViews = unique(views).length
      ? unique(views)
      : unique(groundingDefinition.worldModel?.views ?? []);
    // Reuse the same exact capability identity as a storyless WMB build. Falling back to the
    // checkout basename here gave sibling composition a different scope-policy digest from the
    // already published `repository-root` projection, so a fresh reusable model was rejected as
    // stale. The offline resolver reads only approved local authority and performs no model or
    // network work.
    const repositoryCapability = await resolveLifecycleCapability(repositoryRoot, {
      capabilityId,
      required: Boolean(capabilityId),
      offline: true,
      refuseAmbiguous: true
    });
    const config = {
      ...worldModelConfig,
      ...(repositoryCapability ? { repositoryCapability } : {}),
      staleness: 'fail',
      phases: {
        [phase]: {
          views: declaredViews,
          declaredViews,
          depth: 'standard',
          evidence: false
        }
      }
    };
    const authority = refreshWorldModelV4Authority(repositoryRoot, config, {
      refreshRemote: true
    });
    if (authority.status === 'remote-absent') {
      throw new SingularityFlowError(
        'The capability repository remote state branch has no registered World-Model projection.',
        { code: 'world_model.capability_missing', details: { refresh: authority.status } }
      );
    }
    if (['offline-cached', 'timeout-cached', 'unavailable'].includes(authority.status)
        && !cachedWorldModelV4AuthorityPresent(repositoryRoot, config)) {
      throw new SingularityFlowError(
        'The capability repository registered World-Model authority could not be refreshed and has no verified cache.',
        { code: CAPABILITY_WORLD_MODEL_UNAVAILABLE, details: { refresh: authority.status } }
      );
    }
    const resolved = resolveWorldModelV4Grounding(repositoryRoot, config, {
      phase,
      options: declaredViews.length ? { views: declaredViews.join(',') } : {}
    });
    if (!resolved.freshness.fresh) {
      throw new SingularityFlowError(
        'The capability repository registered World Model does not match its current scoped source snapshot.',
        {
          code: 'world_model.capability_stale',
          details: {
            sourceManifestSha256: resolved.sourceManifestSha256,
            reason: resolved.freshness.reason ?? null
          }
        }
      );
    }
    return {
      format: 'registered-v4',
      outputDir,
      requiredSelections: resolved.selections,
      sourceState: {
        format: 'registered-v4',
        sha256: resolved.sourceManifestSha256,
        commit: resolved.store.sourceSnapshot.revision.commit
      },
      located: resolved.located,
      manifestPath: null,
      manifest: resolved.manifest,
      normalizedManifest: null,
      resolved
    };
  }
  const sourceState = await worldModelSourceSnapshot(repositoryRoot, groundingDefinition);
  const located = await resolveWorldModelSource(repositoryRoot, worldModelConfig, {
    sourceTreeSha256: sourceState.sha256,
    requiredSelections
  });
  if (located.diverged) {
    throw new SingularityFlowError('The capability repository local and remote state branches have diverged.', {
      code: 'world_model.capability_authority_conflict',
      details: { branch: located.branch, authority: located.authority }
    });
  }
  if (located.refresh === 'remote-absent' && located.authority === 'unpublished-local-state') {
    throw new SingularityFlowError('The capability repository remote state branch is absent; a leftover local state ref requires explicit review.', {
      code: 'world_model.capability_authority_conflict',
      details: { branch: located.branch, authority: located.authority }
    });
  }
  const manifestPath = path.join(located.directory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new SingularityFlowError('No world-model manifest is available for the current scoped source snapshot.', {
      code: 'world_model.capability_missing'
    });
  }
  const validated = await validateWorldModelDirectory(located.directory, {
    integrity: 'full',
    requiredSelections,
    sourceLabel: 'capability repository world model'
  });
  const freshness = await worldModelFreshness(repositoryRoot, groundingDefinition, validated.manifest);
  if (!freshness.fresh || freshness.built !== sourceState.sha256) {
    throw new SingularityFlowError('The capability repository world model does not match its current scoped source snapshot.', {
      code: 'world_model.capability_stale',
      details: {
        requestedSourceTreeSha256: sourceState.sha256,
        sourceTreeSha256: freshness.built ?? null
      }
    });
  }
  return {
    format: 'legacy-v3',
    outputDir,
    requiredSelections,
    sourceState,
    located,
    manifestPath,
    manifest: validated.manifest,
    normalizedManifest: validated.normalizedManifest,
    manifestContentSha256: validated.manifestContentSha256,
    validatedModelFiles: validated.registeredFiles
  };
}

export function isLocalCapabilityRepository(repositoryId, sourceRepositoryId, repositoryRoot, currentRoot) {
  // Story worktrees have a different absolute path from the workspace checkout, but they are the
  // same logical repository. Comparing paths alone made SFlow snapshot its own old world model as
  // cross-repository capability context, duplicating thousands of prompt bytes and going stale as
  // soon as implementation changed the application tree.
  return Boolean(sourceRepositoryId && repositoryId === sourceRepositoryId)
    || (repositoryRoot != null && path.resolve(repositoryRoot) === path.resolve(currentRoot));
}

/** Snapshot sibling-repository world models into the governed item context. */
export async function materializeCapabilityWorldModelPack(root, capability, {
  itemDirectory,
  itemRelative,
  views = []
} = {}) {
  if (!capability) return null;
  const source = await sourceForRepository(root);
  const workspace = source.workspace;
  const repositoryIds = unique(capability.deliveries.flatMap((delivery) => delivery.repositories ?? []));
  const maxBytes = capability.policy?.contextMaxBytes ?? 256 * 1024;
  const files = [];
  const repositories = [];
  const warnings = [...(capability.warnings ?? [])];
  let used = 0;
  const current = path.resolve(root);

  for (const repositoryId of repositoryIds) {
    const configured = workspace?.repositories?.[repositoryId];
    const repositoryRoot = configured
      ? workspaceRepositoryPath(workspace, configured)
      : repositoryId === source.repositoryId ? root : null;
    if (!repositoryRoot || !existsSync(repositoryRoot)) {
      warnings.push(`Capability repository '${repositoryId}' is not materialized in the active workspace.`);
      repositories.push({
        id: repositoryId,
        status: 'missing',
        failureClass: 'availability',
        reasonCode: 'CAPABILITY_REPOSITORY_UNAVAILABLE'
      });
      continue;
    }
    if (isLocalCapabilityRepository(repositoryId, source.repositoryId, repositoryRoot, current)) {
      repositories.push({ id: repositoryId, status: 'local-grounding' });
      continue;
    }
    const repositoryDefinition = await loadDefinition(repositoryRoot).catch(() => ({}));
    let resolved;
    try {
      resolved = await resolveCapabilityWorldModelCandidate(repositoryRoot, repositoryDefinition, {
        sourceScope: capability.sourceScope ?? null,
        views,
        capabilityId: capability.id
      });
    }
    catch (error) {
      const availabilityFailure = isWorldModelAvailabilityError(error);
      const status = ['world_model.capability_missing', 'WMB_MANIFEST_MISSING', 'WMB_VIEW_UNAVAILABLE'].includes(error.code)
        ? 'world-model-missing'
        : ['world_model.capability_stale', 'WMB_SOURCE_SNAPSHOT_STALE'].includes(error.code)
          ? 'world-model-stale'
          : availabilityFailure
            ? 'world-model-unavailable'
          : error.code === 'world_model.capability_authority_conflict'
            ? 'world-model-authority-conflict'
            : 'world-model-invalid';
      warnings.push(`Capability repository '${repositoryId}' world model is unavailable: ${error.message}`);
      const failureClass = availabilityFailure
        ? 'availability'
        : 'integrity';
      repositories.push({
        id: repositoryId,
        status,
        failureClass,
        reasonCode: error.code ?? 'CAPABILITY_WORLD_MODEL_INVALID',
        ...(error.details ?? {})
      });
      continue;
    }
    const {
      format, outputDir, sourceState, located, manifest, normalizedManifest
    } = resolved;
    const manifestInfo = format === 'registered-v4'
      ? { sha256: resolved.resolved.manifestContentSha256 }
      : { sha256: resolved.manifestContentSha256 };
    const commit = format === 'registered-v4'
      ? resolved.resolved.store.sourceSnapshot.revision.commit
      : manifest.repository_commit ?? manifest.repository?.commit
        ?? run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, allowFailure: true }).stdout.trim();
    const selected = [];
    const selections = format === 'registered-v4'
      ? resolved.resolved.selected.map((entry) => ({
          relative: entry.relative,
          views: [entry.viewId],
          content: entry.body,
          bytes: entry.size,
          sha256: entry.sha256
        }))
      : modelFiles(normalizedManifest, views);
    const validatedFiles = new Map(
      (resolved.validatedModelFiles ?? []).map((entry) => [entry.path, entry])
    );
    const prepared = [];
    let preparationFailure = null;
    for (const selection of selections) {
      const { relative } = selection;
      const absolute = located.directory ? path.join(located.directory, relative) : null;
      try {
        let sourceBytes;
        let expectedSha256;
        if (selection.content != null) {
          sourceBytes = Buffer.from(selection.content, 'utf8');
          expectedSha256 = selection.sha256;
          if ((selection.bytes != null && sourceBytes.length !== selection.bytes)
              || (expectedSha256
                && createHash('sha256').update(sourceBytes).digest('hex') !== expectedSha256)) {
            throw new SingularityFlowError(
              `Capability repository '${repositoryId}' returned inconsistent registered world-model bytes for '${relative}'.`
            );
          }
        } else {
          const expected = validatedFiles.get(posix(relative));
          if (!expected) {
            throw new SingularityFlowError(
              `Capability repository '${repositoryId}' selected an unvalidated world-model file '${relative}'.`
            );
          }
          try { sourceBytes = await readFile(absolute); }
          catch (error) {
            if (!isWorldModelAvailabilityError(error)) throw error;
            throw new SingularityFlowError(
              `Capability repository '${repositoryId}' world-model file '${relative}' became unavailable.`,
              { code: CAPABILITY_WORLD_MODEL_UNAVAILABLE, cause: error }
            );
          }
          expectedSha256 = expected.sha256;
          if (sourceBytes.length !== expected.size
              || createHash('sha256').update(sourceBytes).digest('hex') !== expected.sha256) {
            throw new SingularityFlowError(
              `Capability repository '${repositoryId}' world-model file '${relative}' changed after validation.`
            );
          }
        }
        prepared.push({ selection, sourceBytes, expectedSha256 });
      } catch (error) {
        preparationFailure = error;
        break;
      }
      const preparedBytes = prepared.reduce((total, entry) => total + entry.sourceBytes.length, 0);
      if (used + preparedBytes > maxBytes) {
        prepared.pop();
        warnings.push(`Capability world-model context reached its ${maxBytes}-byte budget before '${repositoryId}/${relative}'.`);
        break;
      }
    }
    if (preparationFailure) {
      const availabilityFailure = isWorldModelAvailabilityError(preparationFailure);
      warnings.push(`Capability repository '${repositoryId}' world model could not be pinned: ${preparationFailure.message}`);
      repositories.push({
        id: repositoryId,
        status: availabilityFailure ? 'world-model-unavailable' : 'world-model-invalid',
        failureClass: availabilityFailure ? 'availability' : 'integrity',
        reasonCode: preparationFailure.code ?? 'CAPABILITY_WORLD_MODEL_INVALID'
      });
      continue;
    }
    for (const { selection, sourceBytes, expectedSha256 } of prepared) {
      const { relative } = selection;
      const targetRelative = posix(path.join('context', 'capability-world-model', repositoryId, relative));
      const target = path.join(itemDirectory, targetRelative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeBytes(target, sourceBytes);
      const copied = await snapshot(target);
      if (!copied.exists || copied.size !== sourceBytes.length
          || (expectedSha256 && copied.sha256 !== expectedSha256)) {
        throw new SingularityFlowError(
          `Capability world-model snapshot changed while it was being pinned: ${targetRelative}.`
        );
      }
      used += copied.size;
      const entry = {
        repositoryId,
        sourcePath: posix(path.join(outputDir, relative)),
        path: posix(path.join(itemRelative, targetRelative)),
        views: selection.views,
        sha256: copied.sha256,
        bytes: copied.size
      };
      files.push(entry);
      selected.push(entry.path);
    }
    repositories.push({
      id: repositoryId,
      status: 'pinned',
      repository: configured.url,
      branch: configured.defaultBranch,
      commit,
      manifestSha256: manifestInfo.sha256,
      sourceTreeSha256: format === 'registered-v4'
        ? resolved.resolved.sourceManifestSha256
        : manifest.source_tree_sha256 ?? null,
      requestedSourceTreeSha256: format === 'registered-v4'
        ? resolved.resolved.sourceManifestSha256
        : sourceState.sha256,
      format,
      source: located.source,
      files: selected
    });
  }

  const record = {
    schemaVersion: CAPABILITY_CONTEXT_SCHEMA,
    capabilityId: capability.id,
    capabilityPath: capability.path,
    capabilityMapSha256: capability.map.sha256,
    requiredViews: unique(views),
    maxBytes,
    bytes: used,
    repositories,
    files,
    warnings,
    recordedAt: new Date().toISOString()
  };
  const relative = posix(path.join(itemRelative, 'context', 'capability-world-model.json'));
  const absolute = path.join(root, relative);
  await writeJson(absolute, record);
  const info = await snapshot(absolute);
  return { path: relative, sha256: info.sha256, bytes: info.size, warnings };
}

async function renderCapabilityWorldModelPackStrict(root, capability, { views = [] } = {}) {
  if (!capability?.context?.path) return { text: '', files: [], warnings: [] };
  const recordPath = await secureRepositoryPath(root, capability.context.path, {
    label: 'Capability world-model context', type: 'file'
  });
  if (!recordPath.exists) {
    throw new SingularityFlowError(
      `Capability world-model context is unavailable: ${capability.context.path}.`,
      { code: CAPABILITY_WORLD_MODEL_UNAVAILABLE }
    );
  }
  let recordBytes;
  try { recordBytes = await readFile(recordPath.absolute); }
  catch (error) {
    if (!isWorldModelAvailabilityError(error)) throw error;
    throw new SingularityFlowError(
      `Capability world-model context became unavailable: ${capability.context.path}.`,
      { code: CAPABILITY_WORLD_MODEL_UNAVAILABLE, cause: error }
    );
  }
  const recordSha256 = createHash('sha256').update(recordBytes).digest('hex');
  if (recordSha256 !== capability.context.sha256) {
    throw new SingularityFlowError(`Capability world-model context changed after lifecycle creation: ${capability.context.path}.`);
  }
  let record;
  try { record = JSON.parse(recordBytes.toString('utf8')); }
  catch (error) {
    throw new SingularityFlowError(
      `Capability world-model context is invalid JSON: ${capability.context.path}.`,
      { cause: error }
    );
  }
  const files = [];
  const requested = new Set(views);
  for (const entry of record.files ?? []) {
    const entryViews = entry.views ?? ['core'];
    if (requested.size && !entryViews.includes('core') && !entryViews.some((view) => requested.has(view))) continue;
    const selectedPath = await secureRepositoryPath(root, entry.path, {
      label: 'Capability world-model snapshot', type: 'file'
    });
    if (!selectedPath.exists) {
      throw new SingularityFlowError(
        `Capability world-model snapshot is unavailable: ${entry.path}.`,
        { code: CAPABILITY_WORLD_MODEL_UNAVAILABLE }
      );
    }
    let content;
    try { content = await readFile(selectedPath.absolute); }
    catch (error) {
      if (!isWorldModelAvailabilityError(error)) throw error;
      throw new SingularityFlowError(
        `Capability world-model snapshot became unavailable: ${entry.path}.`,
        { code: CAPABILITY_WORLD_MODEL_UNAVAILABLE, cause: error }
      );
    }
    const contentSha256 = createHash('sha256').update(content).digest('hex');
    if (contentSha256 !== entry.sha256
        || (entry.bytes != null && content.length !== entry.bytes)) {
      throw new SingularityFlowError(`Capability world-model snapshot changed: ${entry.path}.`);
    }
    files.push({ ...entry, content: content.toString('utf8') });
  }
  const crossRepositories = (record.repositories ?? []).filter((entry) => entry.status !== 'local-grounding');
  const failureClass = (entry) => {
    if (CAPABILITY_WORLD_MODEL_SUCCESS_STATUSES.has(entry.status)) return null;
    if (['availability', 'integrity'].includes(entry.failureClass)) return entry.failureClass;
    if (CAPABILITY_WORLD_MODEL_AVAILABILITY_STATUSES.has(entry.status)) return 'availability';
    // Pre-fix v4 authority failures were stored as `world-model-invalid`, but retained the remote
    // failure classification. That is enough to migrate them safely at read time without
    // weakening genuinely malformed legacy records, which have no such classification.
    if (entry.status === 'world-model-invalid'
        && LEGACY_CAPABILITY_AVAILABILITY_CLASSIFICATIONS.has(entry.classification)) {
      return 'availability';
    }
    // Compatibility records written before failureClass/reasonCode existed retained enough
    // transport evidence to distinguish absence/offline state from malformed pinned bytes. Keep
    // this deliberately narrow: an authority conflict without one of these refresh outcomes, or
    // an invalid row without a known availability code, remains an integrity failure.
    if (entry.status === 'world-model-authority-conflict'
        && LEGACY_CAPABILITY_AVAILABILITY_REFRESH.has(entry.refresh)) {
      return 'availability';
    }
    if (entry.status === 'world-model-invalid'
        && CAPABILITY_WORLD_MODEL_AVAILABILITY_CODES.has(entry.reasonCode ?? entry.code)) {
      return 'availability';
    }
    return 'integrity';
  };
  const integrityFailures = crossRepositories.filter((entry) => failureClass(entry) === 'integrity');
  if (capability.policy?.worldModelGrounding === 'enforce' && integrityFailures.length) {
    throw new SingularityFlowError(
      `Capability '${capability.id}' has invalid cross-repository world-model context for ${integrityFailures.map((entry) => entry.id).join(', ')}.`
    );
  }
  if (!files.length && capability.policy?.worldModelGrounding === 'enforce' && crossRepositories.length) {
    const availabilityOnly = crossRepositories.every((entry) => failureClass(entry) !== 'integrity');
    throw new SingularityFlowError(
      `Capability '${capability.id}' requires cross-repository grounding, but no sibling world-model files were pinned.`,
      availabilityOnly ? { code: CAPABILITY_WORLD_MODEL_UNAVAILABLE } : {}
    );
  }
  const text = files.map((file) => [
    `## Capability world model: ${file.repositoryId} — ${file.sourcePath}`,
    '',
    `<!-- sha256=${file.sha256} capability=${capability.id} -->`,
    '',
    file.content.trim()
  ].join('\n')).join('\n\n');
  return { text, files: files.map(({ content, ...file }) => file), warnings: record.warnings ?? [] };
}

export async function renderCapabilityWorldModelPack(root, capability, options = {}) {
  const views = options.views ?? [];
  const grounding = options.grounding ?? capability?.policy?.worldModelGrounding ?? 'off';
  // Preserve the legacy direct-helper default for callers that only ask to render a pinned pack,
  // while an explicit workflow/capability `off` policy must not read or validate optional context.
  if (options.grounding === 'off' || capability?.policy?.worldModelGrounding === 'off') {
    return { text: '', files: [], warnings: [] };
  }
  try {
    return await renderCapabilityWorldModelPackStrict(root, capability, { views });
  } catch (error) {
    if (!isWorldModelAvailabilityError(error) && grounding !== 'warn') throw error;
    // Capability context is additional world-model intelligence. Known availability failures
    // retain ordinary governed inputs in every mode. Warn mode also preserves its historical
    // advisory behavior, while enforce still fails closed for changed or invalid pinned context.
    return {
      text: '', files: [],
      warnings: [`Capability world-model grounding unavailable: ${error.message}`]
    };
  }
}

export function capabilityResolutionSha256(capability) {
  return createHash('sha256').update(JSON.stringify(capability)).digest('hex');
}

export function assertCapabilitySource(capability, source = {}) {
  if (!capability || source.type !== 'jira') return;
  const policy = capability.policy ?? {};
  const key = String(source.key ?? source.id ?? '').toUpperCase();
  const project = key.match(/^([A-Z][A-Z0-9_-]*)-/)?.[1] ?? null;
  if (Object.hasOwn(policy, 'jiraProjects') && (!project || !policy.jiraProjects.includes(project))) {
    throw new SingularityFlowError(`Capability '${capability.id}' does not allow Jira project '${project ?? 'unknown'}'.`);
  }
  if (source.url && Object.hasOwn(policy, 'jiraHosts')) {
    let host = null;
    try { host = new URL(source.url).hostname.toLowerCase(); } catch { /* Normal source validation reports malformed URLs. */ }
    if (!host || !policy.jiraHosts.map((value) => {
      try { return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase(); }
      catch { return String(value).toLowerCase(); }
    }).includes(host)) {
      throw new SingularityFlowError(`Capability '${capability.id}' does not allow Jira host '${host ?? source.url}'.`);
    }
  }
}

export function capabilityWorldModelGrounding(current, capability) {
  return stricter(current ?? 'off', capability?.policy?.worldModelGrounding ?? 'off');
}
