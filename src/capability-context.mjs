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
  resolveEffectiveCapabilityPolicy,
  resolveCapabilitySourceScope,
  validateCapabilities
} from './capabilities.mjs';
import { loadDefinition } from './config.mjs';
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
import { ledgerLog } from './ledger.mjs';
import { withWorldModelSourceScope } from './source-scope.mjs';
import {
  activeWorkspaceFile, workspaceMemberContextForRepository, workspaceRegistryFile
} from './workspace-context.mjs';
import { workspaceRepositoryPath } from './workspace.mjs';
import {
  posix, run, secureRepositoryPath, SingularityFlowError, snapshot, writeJson, writeText
} from './util.mjs';

const CAPABILITY_CONTEXT_SCHEMA = 1;
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

function soleDelivery(definition) {
  const rows = Object.keys(definition.capabilities)
    .map((id) => ({ id, repositories: capabilityDeliveries(definition, id).flatMap((item) => item.repositories ?? []) }))
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
  required = false,
  offline = false,
  expectedMapSha256 = null
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
    if (required || capabilityId) throw new SingularityFlowError(`No ${CAPABILITIES_PATH} is available for this repository or its active workspace.`);
    return null;
  }

  const { definition, snapshot: mapSnapshot } = loadedMap;
  let selected = capabilityId;
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
    if (required) throw new SingularityFlowError('This repository maps to more than one capability. Pass --capability <id>.');
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
  return {
    schemaVersion: 1,
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
    sourceScope: resolveCapabilitySourceScope(definition, selected),
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
  views = []
} = {}) {
  const groundingDefinition = withWorldModelSourceScope(definition ?? {}, sourceScope);
  const worldModel = groundingDefinition.worldModel ?? { outputDir: 'singularity/world-model' };
  const outputDir = worldModel.outputDir ?? 'singularity/world-model';
  const requiredSelections = [
    { kind: 'core', tier: 'full' },
    ...unique(views).map((view) => ({ kind: 'view', view, tier: 'full' }))
  ];
  const sourceState = await worldModelSourceSnapshot(repositoryRoot, groundingDefinition);
  const worldModelConfig = {
    ...worldModel,
    ledger: groundingDefinition.ledger,
    stateBranch: worldModel.stateBranch ?? groundingDefinition.ledger?.branch ?? null,
    remote: worldModel.remote ?? groundingDefinition.git?.remote ?? 'origin',
    definition: groundingDefinition
  };
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
    outputDir,
    requiredSelections,
    sourceState,
    located,
    manifestPath,
    manifest: validated.manifest,
    normalizedManifest: validated.normalizedManifest
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
      repositories.push({ id: repositoryId, status: 'missing' });
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
        views
      });
    }
    catch (error) {
      const status = error.code === 'world_model.capability_missing'
        ? 'world-model-missing'
        : error.code === 'world_model.capability_stale'
          ? 'world-model-stale'
          : error.code === 'world_model.capability_authority_conflict'
            ? 'world-model-authority-conflict'
            : 'world-model-invalid';
      warnings.push(`Capability repository '${repositoryId}' world model is unavailable: ${error.message}`);
      repositories.push({ id: repositoryId, status, ...(error.details ?? {}) });
      continue;
    }
    const {
      outputDir, sourceState, located, manifestPath, manifest, normalizedManifest
    } = resolved;
    const manifestInfo = await snapshot(manifestPath);
    const commit = manifest.repository_commit ?? manifest.repository?.commit
      ?? run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, allowFailure: true }).stdout.trim();
    const selected = [];
    for (const selection of modelFiles(normalizedManifest, views)) {
      const { relative } = selection;
      const absolute = path.join(located.directory, relative);
      const info = await snapshot(absolute);
      if (!info.exists) {
        warnings.push(`Capability repository '${repositoryId}' is missing world-model file '${relative}'.`);
        continue;
      }
      if (used + info.size > maxBytes) {
        warnings.push(`Capability world-model context reached its ${maxBytes}-byte budget before '${repositoryId}/${relative}'.`);
        break;
      }
      const targetRelative = posix(path.join('context', 'capability-world-model', repositoryId, relative));
      const target = path.join(itemDirectory, targetRelative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeText(target, await readFile(absolute, 'utf8'));
      const copied = await snapshot(target);
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
      sourceTreeSha256: manifest.source_tree_sha256 ?? null,
      requestedSourceTreeSha256: sourceState.sha256,
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

export async function renderCapabilityWorldModelPack(root, capability, { views = [] } = {}) {
  if (!capability?.context?.path) return { text: '', files: [], warnings: [] };
  const recordInfo = await snapshot(path.join(root, capability.context.path));
  if (!recordInfo.exists || recordInfo.sha256 !== capability.context.sha256) {
    throw new SingularityFlowError(`Capability world-model context changed after lifecycle creation: ${capability.context.path}.`);
  }
  const record = JSON.parse(await readFile(path.join(root, capability.context.path), 'utf8'));
  const files = [];
  const requested = new Set(views);
  for (const entry of record.files ?? []) {
    const entryViews = entry.views ?? ['core'];
    if (requested.size && !entryViews.includes('core') && !entryViews.some((view) => requested.has(view))) continue;
    const info = await snapshot(path.join(root, entry.path));
    if (!info.exists || info.sha256 !== entry.sha256) {
      throw new SingularityFlowError(`Capability world-model snapshot changed: ${entry.path}.`);
    }
    files.push({ ...entry, content: await readFile(path.join(root, entry.path), 'utf8') });
  }
  if (!files.length && capability.policy?.worldModelGrounding === 'enforce' && (record.repositories ?? []).some((entry) => entry.status !== 'local-grounding')) {
    throw new SingularityFlowError(`Capability '${capability.id}' requires cross-repository grounding, but no sibling world-model files were pinned.`);
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
