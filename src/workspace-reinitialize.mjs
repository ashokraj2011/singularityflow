/**
 * Reviewed, repeatable workspace reinitialization.
 *
 * Reinitialization deliberately composes existing authorities instead of inventing a second
 * upgrade path: configuration refresh owns the reviewed framework-seed merge and configuration
 * state projection, while the schema census owns durable-record compatibility. Capability-specific
 * publication and portable locator repair are deliberately outside this command's boundary;
 * user-owned capability definitions remain unchanged when the approved configuration is mirrored.
 * Historical records are never rewritten by this command.
 */
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { assertCredentialFreeRemote, redactDiagnosticText, sanitizeRemote } from './git-remote-diagnostics.mjs';
import { schemaCensus } from './schema-census.mjs';
import { SingularityFlowError } from './util.mjs';
import {
  readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath
} from './workspace.mjs';
import { refreshWorkspaceConfigurations } from './workspace-configuration-refresh.mjs';

export const REINITIALIZATION_SCHEMA_POLICY = Object.freeze({
  mode: 'read-time',
  validatesStoredVersions: true,
  rewritesStoredRecords: false,
  immutableRecordsRewritten: false,
  statement: 'Readable legacy durable records are migrated in memory by their registered readers. Reinitialization validates their stored schema versions but never rewrites immutable historical bytes.'
});

const CONFIGURATION_PLAN = /^cfgp-([a-f0-9]{24})$/;
const REINITIALIZATION_PLAN = /^wrip-([a-f0-9]{24})-([a-f0-9]{64})$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const SHELL_SAFE_ARGUMENT = /^[A-Za-z0-9._/@:=,+-]+$/;

function commandArgument(value, placeholder = 'VALUE') {
  const text = String(value ?? '');
  // NUL and line controls cannot be represented as a portable one-line recovery command. Keep
  // argv executable and explicit by using a conspicuous operator-supplied placeholder instead.
  return /[\0\r\n]/.test(text) ? placeholder : text;
}

function posixQuote(value) {
  const text = String(value);
  if (SHELL_SAFE_ARGUMENT.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value) {
  const text = String(value);
  if (SHELL_SAFE_ARGUMENT.test(text)) return text;
  return `'${text.replaceAll("'", "''")}'`;
}

function commandAction(argv, { skill = null, cwd = null } = {}) {
  const exactArgv = argv.map((value) => String(value));
  const shell = process.platform === 'win32' ? 'powershell' : 'posix';
  const quote = shell === 'powershell' ? powershellQuote : posixQuote;
  return {
    argv: exactArgv,
    command: exactArgv.map(quote).join(' '),
    shell,
    ...(skill ? { skill } : {}),
    ...(cwd ? { cwd } : {})
  };
}

function reinitializeArgv({ workspace, repositories, acceptBundledConflicts, resolutions }, tail) {
  const values = ['singularity-flow', 'workspace', 'reinitialize'];
  if (workspace) values.push(commandArgument(workspace, 'WORKSPACE'));
  for (const repository of repositories ?? []) {
    values.push('--repository', commandArgument(repository, 'REPOSITORY'));
  }
  if (acceptBundledConflicts) values.push('--accept-bundled-conflicts');
  for (const [name, resolution] of Object.entries(resolutions ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    values.push('--resolve', commandArgument(`${name}=${resolution}`, 'PATH=RESOLUTION'));
  }
  values.push(...tail, '--json');
  return values;
}

function reinitializeAction(commandInput, tail) {
  return commandAction(reinitializeArgv(commandInput, tail), { skill: '/sf-admin' });
}

function routingTopologyIdentity(topology) {
  return {
    workspaces: topology.workspaces.map((entry) => ({
      workspaceId: entry.workspaceId,
      workspacePath: entry.workspacePath
    })),
    memberships: topology.bindings.map((entry) => ({
      workspaceId: entry.workspaceId,
      workspacePath: entry.workspacePath,
      repositoryId: entry.repositoryId,
      repositoryRemote: entry.repositoryRemote,
      repositoryPath: entry.repositoryPath
    }))
  };
}

function lifecycleRefSnapshot(census) {
  return (census?.lifecycleRefs ?? []).map((entry) => ({
    ref: entry.ref,
    commit: entry.commit
  })).sort((left, right) => left.ref.localeCompare(right.ref)
    || left.commit.localeCompare(right.commit));
}

function schemaAuthorityIdentity(censuses) {
  return (censuses ?? []).map((census) => ({
    repository: census.repository,
    remote: census.remote,
    path: path.resolve(census.path),
    lifecycleRefs: lifecycleRefSnapshot(census)
  })).sort((left, right) => left.path.localeCompare(right.path)
    || String(left.repository ?? '').localeCompare(String(right.repository ?? '')));
}

function reinitializationPlanId(configurationPlanId, topology, schemaCensuses = []) {
  const match = String(configurationPlanId ?? '').match(CONFIGURATION_PLAN);
  if (!match) return null;
  const identity = {
    configurationPlanId,
    topology: routingTopologyIdentity(topology),
    schemaAuthorities: schemaAuthorityIdentity(schemaCensuses)
  };
  return `wrip-${match[1]}-${sha256(identity)}`;
}

function parseReinitializationPlan(planId) {
  const match = String(planId ?? '').match(REINITIALIZATION_PLAN);
  if (!match) throw new SingularityFlowError(
    'Workspace reinitialization requires the compound plan ID returned by workspace reinitialize --dry-run. A configuration-only cfgp plan does not authorize the reviewed workspace and schema boundary.', {
      code: 'WORKSPACE_REINITIALIZE_PLAN_INVALID'
    }
  );
  return Object.freeze({
    planId: match[0],
    configurationPlanId: `cfgp-${match[1]}`,
    topologySha256: match[2]
  });
}

function migrationSummary(census) {
  const migrations = [];
  let readTimeMigrationRecords = 0;
  let readTimeMigrationSteps = 0;
  for (const family of census.families) {
    // A lower stored version is only a migration candidate. Count it as compatible after the
    // registered reader actually accepted and migrated it; otherwise a corrupt in-range record could
    // be reported both as a successful migration and as an unreadable blocker.
    const records = Number.isSafeInteger(family.readTimeMigrationRecords)
      ? family.readTimeMigrationRecords : 0;
    const steps = Number.isSafeInteger(family.readTimeMigrationSteps)
      ? family.readTimeMigrationSteps : 0;
    if (!records) continue;
    const storedVersions = [];
    for (const rawVersion of Object.keys(family.versions)) {
      const version = Number(rawVersion);
      if (!Number.isInteger(version) || version >= family.currentVersion
          || version < family.readable.minimum) continue;
      storedVersions.push(version);
    }
    readTimeMigrationRecords += records;
    readTimeMigrationSteps += steps;
    migrations.push({
      family: family.family,
      currentVersion: family.currentVersion,
      storedVersions: storedVersions.sort((left, right) => left - right),
      records,
      steps
    });
  }
  const blocked = census.totals.outsideRange + census.totals.unreadable;
  const advisory = census.totals.unregistered + (census.truncated ? 1 : 0);
  return {
    status: blocked ? 'attention-required'
      : readTimeMigrationRecords ? 'read-time-compatible'
        : advisory ? 'advisory' : 'current',
    healthy: blocked === 0,
    scannedFiles: census.scannedFiles,
    records: census.totals.registeredRecords,
    observedFamilies: census.totals.observedFamilies,
    readTimeMigrationRecords,
    readTimeMigrationSteps,
    migrations,
    outsideReadableRange: census.totals.outsideRange,
    unregistered: census.totals.unregistered,
    unreadable: census.totals.unreadable,
    truncated: census.truncated,
    lifecycleRefs: lifecycleRefSnapshot(census)
  };
}

async function selectedTopology(registryFile, results, services) {
  const requestedWorkspaceIds = new Set((results ?? []).flatMap((result) =>
    (result.memberships ?? []).map((membership) => membership.workspaceId)));
  const entries = (await services.readWorkspaceRegistry(registryFile))
    .filter((entry) => !entry.archivedAt && requestedWorkspaceIds.has(entry.id));
  const manifests = new Map();
  const issues = [];
  const registeredWorkspaceIds = new Set(entries.map((entry) => entry.id));
  for (const workspaceId of requestedWorkspaceIds) {
    if (!registeredWorkspaceIds.has(workspaceId)) issues.push({
      workspaceId,
      status: 'unavailable',
      reason: `Workspace '${workspaceId}' is no longer present in the active local registry.`
    });
  }
  for (const entry of entries) {
    try {
      manifests.set(entry.id, {
        entry,
        manifest: await services.readWorkspace(entry.path)
      });
    }
    catch (error) {
      issues.push({
        workspaceId: entry.id,
        status: 'unavailable',
        reason: redactDiagnosticText(error?.message ?? String(error))
      });
    }
  }

  const checkouts = new Map();
  const bindings = new Map();
  for (const result of results ?? []) {
    for (const membership of result.memberships ?? []) {
      const loaded = manifests.get(membership.workspaceId);
      const manifest = loaded?.manifest;
      const repository = manifest?.repositories?.[membership.repositoryId];
      if (!manifest || !repository) {
        if (manifest) issues.push({
          workspaceId: membership.workspaceId,
          repositoryId: membership.repositoryId,
          status: 'unavailable',
          reason: `Repository '${membership.repositoryId}' is no longer a member of workspace '${membership.workspaceId}'.`
        });
        continue;
      }
      let repositoryRemote;
      try {
        repositoryRemote = assertCredentialFreeRemote(repository.url);
      } catch (error) {
        issues.push({
          workspaceId: manifest.id,
          repositoryId: repository.id,
          status: 'unavailable',
          reason: `Workspace routing contains a remote that cannot be safely rebound: ${redactDiagnosticText(error?.message ?? String(error))}`
        });
        continue;
      }
      const checkout = path.resolve(workspaceRepositoryPath(manifest, repository));
      bindings.set(JSON.stringify([manifest.id, repository.id]), {
        workspaceId: manifest.id,
        workspacePath: path.resolve(loaded.entry.path),
        repositoryId: repository.id,
        repositoryRemote,
        repositoryPath: checkout
      });
      const checkoutEntry = checkouts.get(checkout) ?? {
        repository: result.repository,
        remote: sanitizeRemote(repositoryRemote),
        path: checkout,
        memberships: []
      };
      checkoutEntry.memberships.push(membership);
      checkouts.set(checkout, checkoutEntry);
    }
  }
  return {
    checkouts: [...checkouts.values()],
    workspaces: entries.map((entry) => ({
      workspaceId: entry.id,
      workspacePath: path.resolve(entry.path)
    })).sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)
      || left.workspacePath.localeCompare(right.workspacePath)),
    bindings: [...bindings.values()].sort((left, right) =>
      left.workspaceId.localeCompare(right.workspaceId)
        || left.repositoryId.localeCompare(right.repositoryId)),
    issues
  };
}

function authorityCensusCollector(services, expectedLifecycleRefs = null) {
  const observations = new Map();
  return {
    observations,
    async inspect(candidate) {
      const paths = [...new Set(candidate.repository.localPaths
        ?? (candidate.repository.localPath ? [candidate.repository.localPath] : []))];
      const failures = [];
      await Promise.all(paths.map(async (checkoutPath) => {
        const requested = path.resolve(checkoutPath);
        const key = await realpath(requested).catch(() => requested);
        try {
          const census = await services.schemaCensus(key, {
            includeLifecycleRefs: true,
            configurationRoot: candidate.root,
            stateAuthorityRoot: candidate.root
          });
          const summary = migrationSummary(census);
          observations.set(key, {
            census,
            authority: {
              source: 'approved-configuration-candidate',
              configurationSourceCommit: candidate.sourceCommit ?? null,
              stateAuthorityCommit: candidate.stateBefore?.stateCommit ?? null
            }
          });
          const actualLifecycleRefs = lifecycleRefSnapshot(census);
          if (expectedLifecycleRefs?.has(key)
              && sha256(actualLifecycleRefs) !== expectedLifecycleRefs.get(key)) {
            throw new SingularityFlowError(
              `Lifecycle refs changed after schema migration readiness was reviewed for '${key}'.`, {
                code: 'WORKSPACE_REINITIALIZE_SCHEMA_AUTHORITY_CHANGED'
              }
            );
          }
          // The apply path invokes this hook before publishing configuration. Propagate a schema
          // blocker into refresh preflight so a record that changed after the reviewed preview
          // cannot turn a supposedly safe reinitialization into a partial mutation.
          if (!summary.healthy || summary.truncated) {
            throw new SingularityFlowError(
              `Schema migration readiness is blocked for '${key}'.`, {
                code: 'WORKSPACE_REINITIALIZE_SCHEMA_BLOCKED'
              }
            );
          }
        } catch (error) {
          if (!observations.has(key)) observations.set(key, { error });
          failures.push(error);
        }
      }));
      if (failures.length) throw failures[0];
    }
  };
}

async function lifecycleRefExpectations(censuses) {
  const expected = new Map();
  await Promise.all((censuses ?? []).map(async (census) => {
    const requested = path.resolve(census.path);
    const key = await realpath(requested).catch(() => requested);
    expected.set(key, sha256(lifecycleRefSnapshot(census)));
  }));
  return expected;
}

async function censusCheckouts(checkouts, services, authoritative = new Map()) {
  return Promise.all(checkouts.map(async (checkout) => {
    const exists = await lstat(checkout.path).catch(() => null);
    if (!exists?.isDirectory()) return {
      ...checkout,
      status: 'checkout-unavailable',
      reason: 'The registered repository checkout is not present on this machine; remote configuration was still reviewed independently.'
    };
    try {
      const requested = path.resolve(checkout.path);
      const key = await realpath(requested).catch(() => requested);
      const observation = authoritative.get(key);
      if (observation?.error) throw observation.error;
      const summary = migrationSummary(observation?.census
        ?? await services.schemaCensus(checkout.path, { includeLifecycleRefs: true }));
      return {
        ...checkout,
        ...summary,
        schemaAuthority: observation?.authority ?? { source: 'working-tree' },
        ...(summary.status === 'attention-required' ? {
          nextAction: commandAction(['singularity-flow', 'doctor', '--json'], {
            cwd: checkout.path
          })
        } : {})
      };
    } catch (error) {
      return {
        ...checkout,
        status: 'attention-required',
        healthy: false,
        reason: redactDiagnosticText(error?.message ?? String(error)),
        nextAction: commandAction(['singularity-flow', 'doctor', '--json'], {
          cwd: checkout.path
        })
      };
    }
  }));
}

function blockingSchemaCensuses(censuses) {
  return censuses.filter((entry) => entry.status === 'checkout-unavailable'
    || entry.status === 'attention-required'
    || entry.truncated === true);
}

function unchangedCapabilityPortability() {
  return {
    status: 'outside-scope-unchanged',
    changed: false,
    statement: 'Capability-specific publication and portable locator repair are outside safe reinitialization. User-owned capability definitions remain unchanged in the approved configuration mirror.',
    plannedLeads: [],
    results: []
  };
}

/**
 * Reapply the installed configuration contract without destroying repository or historical state.
 *
 * The optional service seam is for deterministic tests; production callers use the authorities
 * imported above.
 */
export async function reinitializeWorkspaces({
  registryFile,
  workspace = null,
  repositories = [],
  dryRun = false,
  acceptBundledConflicts = false,
  resolutions = {},
  confirmPlan = null
} = {}, serviceOverrides = {}) {
  if (!registryFile) throw new SingularityFlowError('Workspace reinitialization requires the workspace registry path.');
  const ownershipTransfers = Object.entries(resolutions ?? {})
    .filter(([, resolution]) => resolution !== 'local');
  if (acceptBundledConflicts || ownershipTransfers.length) {
    throw new SingularityFlowError(
      'Safe reinitialization cannot replace repository-owned configuration with packaged content. '
        + 'It restores only missing or exact registered framework seeds; use the separately reviewed '
        + 'workspace refresh-configuration journey for a deliberate ownership transfer.', {
        code: 'WORKSPACE_REINITIALIZE_OWNERSHIP_TRANSFER_UNSUPPORTED',
        details: { paths: ownershipTransfers.map(([conflictPath]) => conflictPath) }
      }
    );
  }
  if (dryRun && confirmPlan) throw new SingularityFlowError(
    'Workspace reinitialization preview cannot also apply a confirmed plan. Use --dry-run first, then rerun without it using --confirm-plan <PLAN-ID>.',
    { code: 'WORKSPACE_REINITIALIZE_MODE_CONFLICT' }
  );
  const commandInput = { workspace, repositories, acceptBundledConflicts, resolutions };
  if (!dryRun && !confirmPlan) throw new SingularityFlowError(
    'Workspace reinitialization is plan-first. Run the dry-run command, review the exact configuration changes, then apply its plan ID.', {
      code: 'WORKSPACE_REINITIALIZE_CONFIRMATION_REQUIRED',
      details: {
        nextAction: reinitializeAction(commandInput, ['--dry-run'])
      }
    }
  );

  const services = {
    refreshWorkspaceConfigurations,
    schemaCensus,
    readWorkspaceRegistry,
    readWorkspace,
    ...serviceOverrides
  };
  const refreshInput = {
    registryFile, workspace, repositories, acceptBundledConflicts, resolutions,
    // Reinitialize is the explicit product-seed refresh. Ordinary `refresh-configuration` keeps
    // its conservative three-way behavior, while this plan restores only framework-owned workflow
    // contracts and keeps every repository-only workflow, template and agent intact.
    restorePackagedSeeds: true
  };
  let confirmed = null;
  if (!dryRun) confirmed = parseReinitializationPlan(confirmPlan);

  // Applying a compound plan begins with the same read-only configuration preview used to create
  // it. This verifies both the embedded cfgp identity and the local workspace/repository topology before
  // `refreshWorkspaceConfigurations` receives any authority to mutate a remote ref.
  const previewCensusCollector = authorityCensusCollector(services);
  const preview = await services.refreshWorkspaceConfigurations({
    ...refreshInput, dryRun: true, confirmPlan: null,
    inspectCandidate: previewCensusCollector.inspect
  });
  const previewTopology = await selectedTopology(registryFile, preview.results, services);
  if (!Array.isArray(preview.results) || preview.results.length !== preview.total) {
    previewTopology.issues.push({
      status: 'unavailable',
      reason: 'Configuration preview did not return one result for every selected repository; no compound plan can be issued.'
    });
  }
  // Schema compatibility is part of the reviewed boundary, not an after-the-fact diagnostic.
  // A missing checkout, bounded/truncated census, unreadable record, or out-of-range version must
  // prevent both plan issuance and mutation.
  const previewSchemaCensuses = await censusCheckouts(
    previewTopology.checkouts, services, previewCensusCollector.observations
  );
  const previewSchemaBlockers = blockingSchemaCensuses(previewSchemaCensuses);
  const observedPlanId = previewTopology.issues.length || previewSchemaBlockers.length
    || !preview.planId
    ? null : reinitializationPlanId(
      preview.planId, previewTopology, previewSchemaCensuses
    );

  if (dryRun) {
    const planId = preview.status === 'blocked' || previewSchemaBlockers.length
      ? null : observedPlanId;
    const status = preview.status === 'blocked' || previewTopology.issues.length
      || previewSchemaBlockers.length
      ? 'blocked' : preview.status;
    return Object.freeze({
      schemaVersion: 1, // schema-transient: process-boundary reinitialization report, never persisted
      resultType: 'workspace-reinitialization',
      status,
      dryRun: true,
      planId,
      configurationPlanId: preview.planId ?? null,
      total: preview.total,
      updated: 0,
      failed: (preview.failed ?? 0)
        + previewSchemaBlockers.length
        + previewTopology.issues.length,
      results: preview.results,
      configurationRefresh: preview,
      capabilityPortability: unchangedCapabilityPortability(),
      schemaMigrationPolicy: REINITIALIZATION_SCHEMA_POLICY,
      schemaCensuses: previewSchemaCensuses,
      topologyIssues: previewTopology.issues,
      nextAction: planId
        ? reinitializeAction(commandInput, ['--confirm-plan', planId]) : null
    });
  }

  if (preview.status === 'blocked'
      || previewTopology.issues.length
      || previewSchemaBlockers.length
      || observedPlanId !== confirmed.planId
      || preview.planId !== confirmed.configurationPlanId) {
    const reason = previewSchemaBlockers.length
      ? 'One or more selected checkouts could not complete the bounded schema compatibility census.'
      : previewTopology.issues.length
      ? 'Workspace membership or repository routing could not be rebound exactly.'
      : 'Configuration authority or workspace repository topology changed after preview.';
    return Object.freeze({
      schemaVersion: 1, // schema-transient: rejected compound reinitialization confirmation
      resultType: 'workspace-reinitialization',
      status: 'blocked',
      topologyStatus: 'stale-plan',
      dryRun: false,
      planId: confirmed.planId,
      observedPlanId,
      configurationPlanId: confirmed.configurationPlanId,
      observedConfigurationPlanId: preview.planId ?? null,
      total: preview.total,
      updated: 0,
      failed: Math.max(1, preview.failed ?? 0),
      results: (preview.results ?? []).map((entry) => ({
        ...entry,
        status: 'stale-plan',
        configurationChanged: false,
        stateChanged: false,
        error: reason
      })),
      configurationRefresh: preview,
      capabilityPortability: unchangedCapabilityPortability(),
      schemaMigrationPolicy: REINITIALIZATION_SCHEMA_POLICY,
      schemaCensuses: previewSchemaCensuses,
      topologyIssues: previewTopology.issues,
      nextAction: reinitializeAction(commandInput, ['--dry-run'])
    });
  }

  const applyCensusCollector = authorityCensusCollector(
    services, await lifecycleRefExpectations(previewSchemaCensuses)
  );
  const refresh = await services.refreshWorkspaceConfigurations({
    ...refreshInput, dryRun: false, confirmPlan: confirmed.configurationPlanId,
    inspectCandidate: applyCensusCollector.inspect
  });
  // Configuration publication may legitimately change sflow/config. Rebind the local workspace
  // and repository paths after it completes. Capability authorities and locators are intentionally
  // not observed or separately published because they are outside safe reinitialization.
  const topology = await selectedTopology(registryFile, refresh.results, services);
  if (!Array.isArray(refresh.results) || refresh.results.length !== refresh.total) {
    topology.issues.push({
      status: 'unavailable',
      reason: 'Configuration apply did not return one result for every selected repository.'
    });
  }
  const schemaCensuses = await censusCheckouts(
    topology.checkouts, services, applyCensusCollector.observations
  );
  const schemaBlockers = blockingSchemaCensuses(schemaCensuses);
  const topologyChanged = sha256(routingTopologyIdentity(previewTopology))
    !== sha256(routingTopologyIdentity(topology));
  const capabilityPortability = unchangedCapabilityPortability();

  const schemaBlocked = schemaBlockers.length > 0;
  const topologyBlocked = topologyChanged || topology.issues.length > 0;
  const status = refresh.status === 'blocked' ? 'blocked'
      : refresh.status === 'partial' || schemaBlocked || topologyBlocked ? 'partial'
        : 'complete';
  const nextAction = topologyBlocked || schemaBlocked || refresh.status !== 'complete'
    ? reinitializeAction(commandInput, ['--dry-run']) : null;
  return Object.freeze({
    schemaVersion: 1, // schema-transient: process-boundary reinitialization report, never persisted
    resultType: 'workspace-reinitialization',
    status,
    topologyStatus: topologyBlocked ? 'stale-plan' : 'current',
    dryRun: false,
    planId: confirmed.planId,
    configurationPlanId: confirmed.configurationPlanId,
    total: refresh.total,
    updated: refresh.updated,
    failed: (refresh.failed ?? 0) + schemaBlockers.length
      + topology.issues.length,
    results: refresh.results,
    configurationRefresh: refresh,
    capabilityPortability,
    schemaMigrationPolicy: REINITIALIZATION_SCHEMA_POLICY,
    schemaCensuses,
    topologyIssues: topology.issues,
    nextAction
  });
}
