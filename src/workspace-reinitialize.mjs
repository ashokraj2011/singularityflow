/**
 * Reviewed, repeatable workspace reinitialization.
 *
 * Reinitialization deliberately composes existing authorities instead of inventing a second
 * upgrade path: configuration refresh owns the reviewed three-way merge and state projection,
 * capability publication owns portable authority links, and the schema census owns durable-record
 * compatibility. Historical records are never rewritten by this command.
 */
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { publishOrganisationCapabilityMap } from './organisation.mjs';
import { CONFIGURATION_BRANCH } from './configuration-branch.mjs';
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { GitRemoteSession } from './git-execution.mjs';
import { assertCredentialFreeRemote, redactDiagnosticText, sanitizeRemote } from './git-remote-diagnostics.mjs';
import { schemaCensus } from './schema-census.mjs';
import { mapLimit, SingularityFlowError } from './util.mjs';
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

const successfulRefreshStatuses = new Set([
  'current', 'updated', 'would-update', 'would-initialize'
]);
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

function capabilityPublishAction(remote) {
  const exact = assertCredentialFreeRemote(remote);
  return commandAction([
    'singularity-flow', 'capability', 'publish', '--lead',
    commandArgument(exact, 'LEAD_URL'), '--json'
  ], { skill: '/sf-capability-map' });
}

async function observeLeadConfiguration(remote) {
  const exact = assertCredentialFreeRemote(remote);
  const observation = await new GitRemoteSession({ env: enterpriseGitEnvironment() }).observeAsync(exact, {
    includeHead: false,
    refs: [`refs/heads/${CONFIGURATION_BRANCH}`]
  });
  if (!observation.ok) throw new SingularityFlowError(
    `Cannot bind the capability authority on '${sanitizeRemote(exact)}' into the reinitialization plan. ${observation.failure?.advice ?? 'Git remote access failed.'}`, {
      code: observation.failure?.code ?? 'WORKSPACE_REINITIALIZE_AUTHORITY_UNAVAILABLE'
    }
  );
  const commit = observation.refs.get(`refs/heads/${CONFIGURATION_BRANCH}`) ?? null;
  return Object.freeze({ status: commit ? 'current' : 'missing', commit });
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
      repositoryPath: entry.repositoryPath,
      leadRepositoryId: entry.leadRepositoryId,
      leadRemote: entry.leadRemote,
      leadPath: entry.leadPath
    })),
    plannedLeads: topology.leads.map((lead) => ({
      remote: lead.remote,
      leadBindings: lead.leadBindings
    }))
  };
}

function reinitializationPlanId(configurationPlanId, topology) {
  const match = String(configurationPlanId ?? '').match(CONFIGURATION_PLAN);
  if (!match) return null;
  const identity = {
    configurationPlanId,
    topology: routingTopologyIdentity(topology),
    leadAuthorities: topology.leads.map((lead) => ({
      remote: lead.remote,
      status: lead.authorityObservation?.status ?? 'unavailable',
      configurationCommit: lead.authorityObservation?.commit ?? null
    }))
  };
  return `wrip-${match[1]}-${sha256(identity)}`;
}

function parseReinitializationPlan(planId) {
  const match = String(planId ?? '').match(REINITIALIZATION_PLAN);
  if (!match) throw new SingularityFlowError(
    'Workspace reinitialization requires the compound plan ID returned by workspace reinitialize --dry-run. A configuration-only cfgp plan does not authorize capability locator changes.', {
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
    truncated: census.truncated
  };
}

async function selectedTopology(registryFile, results, services, { observeLeads = true } = {}) {
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

  const refreshByMembership = new Map();
  for (const result of results ?? []) {
    for (const membership of result.memberships ?? []) {
      refreshByMembership.set(
        JSON.stringify([membership.workspaceId, membership.repositoryId]), result
      );
    }
  }

  const checkouts = new Map();
  const leads = new Map();
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
      const lead = manifest.repositories?.[manifest.leadRepository];
      if (!lead?.url) {
        issues.push({
          workspaceId: manifest.id,
          status: 'unavailable',
          reason: `Workspace '${manifest.id}' has no readable lead repository for capability portability.`
        });
        continue;
      }
      let repositoryRemote;
      let leadRemote;
      try {
        repositoryRemote = assertCredentialFreeRemote(repository.url);
        leadRemote = assertCredentialFreeRemote(lead.url);
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
      const leadPath = path.resolve(workspaceRepositoryPath(manifest, lead));
      bindings.set(JSON.stringify([manifest.id, repository.id]), {
        workspaceId: manifest.id,
        workspacePath: path.resolve(loaded.entry.path),
        repositoryId: repository.id,
        repositoryRemote,
        repositoryPath: checkout,
        leadRepositoryId: manifest.leadRepository,
        leadRemote,
        leadPath
      });
      const checkoutEntry = checkouts.get(checkout) ?? {
        repository: result.repository,
        remote: sanitizeRemote(repositoryRemote),
        path: checkout,
        memberships: []
      };
      checkoutEntry.memberships.push(membership);
      checkouts.set(checkout, checkoutEntry);

      if (!successfulRefreshStatuses.has(result.status)) continue;
      const remote = leadRemote;
      const existing = leads.get(remote) ?? {
        remote,
        displayRemote: sanitizeRemote(remote),
        workspaceIds: new Set(),
        triggeredByRepositories: new Set(),
        leadBindings: new Map(),
        expectedConfigurationCommits: new Set()
      };
      existing.workspaceIds.add(manifest.id);
      existing.triggeredByRepositories.add(result.repository);
      const leadRefresh = refreshByMembership.get(JSON.stringify([
        manifest.id, manifest.leadRepository
      ])) ?? null;
      existing.leadBindings.set(JSON.stringify([manifest.id, manifest.leadRepository]), {
        workspaceId: manifest.id,
        repositoryId: manifest.leadRepository,
        selected: Boolean(leadRefresh && successfulRefreshStatuses.has(leadRefresh.status))
      });
      if (leadRefresh && successfulRefreshStatuses.has(leadRefresh.status)
          && /^[0-9a-f]{40,64}$/i.test(String(leadRefresh.configurationCommit ?? ''))) {
        existing.expectedConfigurationCommits.add(leadRefresh.configurationCommit);
      }
      leads.set(remote, existing);
    }
  }
  const finalizedLeads = [...leads.values()].map((entry) => ({
    ...entry,
    workspaceIds: [...entry.workspaceIds].sort(),
    triggeredByRepositories: [...entry.triggeredByRepositories].sort(),
    leadBindings: [...entry.leadBindings.values()].sort((left, right) =>
      left.workspaceId.localeCompare(right.workspaceId)
        || left.repositoryId.localeCompare(right.repositoryId)),
    expectedConfigurationCommit: entry.expectedConfigurationCommits.size === 1
      ? [...entry.expectedConfigurationCommits][0] : null,
    authorityCommitConflict: entry.expectedConfigurationCommits.size > 1,
    authorityObservation: null
  })).sort((left, right) => left.remote.localeCompare(right.remote));
  if (observeLeads) {
    await mapLimit(finalizedLeads, Math.min(4, finalizedLeads.length || 1), async (lead) => {
      try { lead.authorityObservation = await services.observeLeadConfiguration(lead.remote); }
      catch (error) {
        lead.authorityObservation = { status: 'unavailable', commit: null };
        issues.push({
          lead: lead.displayRemote,
          status: 'unavailable',
          reason: redactDiagnosticText(error?.message ?? String(error)),
          nextAction: commandAction([
            'singularity-flow', 'workspace', 'doctor', '--network', '--repository',
            commandArgument(lead.remote, 'LEAD_URL'), '--json'
          ], { skill: '/sf-workspace' })
        });
      }
    });
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
    leads: finalizedLeads,
    issues
  };
}

async function censusCheckouts(checkouts, services) {
  return Promise.all(checkouts.map(async (checkout) => {
    const exists = await lstat(checkout.path).catch(() => null);
    if (!exists?.isDirectory()) return {
      ...checkout,
      status: 'checkout-unavailable',
      reason: 'The registered repository checkout is not present on this machine; remote configuration was still reviewed independently.'
    };
    try {
      const summary = migrationSummary(await services.schemaCensus(checkout.path));
      return {
        ...checkout,
        ...summary,
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

function capabilityPublicationResult(lead, publication) {
  const stateCurrent = ['current', 'updated', 'policy-disabled'].includes(publication?.status)
    || publication?.published === true
    || publication?.reason === 'it is already current there';
  const portable = publication?.portability?.portable !== false;
  const current = stateCurrent && portable;
  const reason = !stateCurrent
    ? publication?.reason ?? 'The capability state projection did not verify as current.'
    : !portable
      ? (publication?.portability?.failures ?? []).map((entry) => entry.reason).filter(Boolean).join('; ')
        || 'One or more delivery repositories still need a portable capability-authority locator.'
      : null;
  return {
    lead: lead.displayRemote,
    workspaceIds: lead.workspaceIds,
    triggeredByRepositories: lead.triggeredByRepositories,
    status: current ? 'current' : 'pending',
    stateStatus: publication?.status ?? (stateCurrent ? 'current' : 'unknown'),
    state: publication,
    ...(!current ? {
      reason,
      nextAction: capabilityPublishAction(lead.remote)
    } : {})
  };
}

async function publishCapabilityPortability(leads, services, commandInput) {
  const results = [];
  for (const lead of leads) {
    if (!lead.expectedConfigurationCommit || lead.authorityCommitConflict) {
      const binding = lead.leadBindings.find((entry) => entry.selected)
        ?? lead.leadBindings[0] ?? null;
      results.push({
        lead: lead.displayRemote,
        workspaceIds: lead.workspaceIds,
        triggeredByRepositories: lead.triggeredByRepositories,
        status: 'pending',
        code: lead.authorityCommitConflict
          ? 'CAPABILITY_REINITIALIZE_AUTHORITY_CONFLICT'
          : 'CAPABILITY_REINITIALIZE_LEAD_NOT_BOUND',
        reason: lead.authorityCommitConflict
          ? 'The selected workspaces disagree on the lead configuration commit; no capability locator was changed.'
          : 'The lead capability authority was not part of the confirmed refresh plan; no capability locator was changed.',
        ...(binding ? {
          nextAction: reinitializeAction({
              workspace: binding.workspaceId,
              repositories: [binding.repositoryId],
              acceptBundledConflicts: false,
              resolutions: {}
            }, ['--dry-run'])
        } : {})
      });
      continue;
    }
    try {
      const publication = await services.publishOrganisationCapabilityMap(lead.remote, {
        expectedConfigurationCommit: lead.expectedConfigurationCommit
      });
      results.push(capabilityPublicationResult(lead, publication));
    } catch (error) {
      results.push({
        lead: lead.displayRemote,
        workspaceIds: lead.workspaceIds,
        triggeredByRepositories: lead.triggeredByRepositories,
        status: 'pending',
        code: error?.code ?? 'CAPABILITY_PORTABILITY_REFRESH_FAILED',
        reason: redactDiagnosticText(error?.message ?? String(error)),
        nextAction: error?.code === 'CAPABILITY_CONFIGURATION_PLAN_STALE'
          ? reinitializeAction(commandInput, ['--dry-run'])
          : capabilityPublishAction(lead.remote)
      });
    }
  }
  return results;
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
    publishOrganisationCapabilityMap,
    observeLeadConfiguration,
    schemaCensus,
    readWorkspaceRegistry,
    readWorkspace,
    ...serviceOverrides
  };
  const refreshInput = {
    registryFile, workspace, repositories, acceptBundledConflicts, resolutions
  };
  let confirmed = null;
  if (!dryRun) confirmed = parseReinitializationPlan(confirmPlan);

  // Applying a compound plan begins with the same read-only configuration preview used to create
  // it. This verifies both the embedded cfgp identity and the local workspace/lead topology before
  // `refreshWorkspaceConfigurations` receives any authority to mutate a remote ref.
  const preview = await services.refreshWorkspaceConfigurations({
    ...refreshInput, dryRun: true, confirmPlan: null
  });
  const previewTopology = await selectedTopology(registryFile, preview.results, services, {
    observeLeads: true
  });
  if (!Array.isArray(preview.results) || preview.results.length !== preview.total) {
    previewTopology.issues.push({
      status: 'unavailable',
      reason: 'Configuration preview did not return one result for every selected repository; no compound plan can be issued.'
    });
  }
  // Schema compatibility is part of the reviewed boundary, not an after-the-fact diagnostic.
  // A missing checkout, bounded/truncated census, unreadable record, or out-of-range version must
  // prevent both plan issuance and mutation.
  const previewSchemaCensuses = await censusCheckouts(previewTopology.checkouts, services);
  const previewSchemaBlockers = blockingSchemaCensuses(previewSchemaCensuses);
  const observedPlanId = previewTopology.issues.length || previewSchemaBlockers.length
    || !preview.planId
    ? null : reinitializationPlanId(preview.planId, previewTopology);

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
      capabilityPortability: {
        status: 'not-run-during-preview',
        plannedLeads: previewTopology.leads.map((lead) => ({
          lead: lead.displayRemote,
          workspaceIds: lead.workspaceIds,
          triggeredByRepositories: lead.triggeredByRepositories,
          leadBindings: lead.leadBindings,
          authority: lead.authorityObservation
        })),
        results: []
      },
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
      ? 'Workspace membership, repository routing, or lead authority could not be rebound exactly.'
      : 'Configuration authority or workspace capability topology changed after preview.';
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
      capabilityPortability: {
        status: 'not-run-stale-plan', plannedLeads: [], results: []
      },
      schemaMigrationPolicy: REINITIALIZATION_SCHEMA_POLICY,
      schemaCensuses: previewSchemaCensuses,
      topologyIssues: previewTopology.issues,
      nextAction: reinitializeAction(commandInput, ['--dry-run'])
    });
  }

  const refresh = await services.refreshWorkspaceConfigurations({
    ...refreshInput, dryRun: false, confirmPlan: confirmed.configurationPlanId
  });
  // Configuration publication may legitimately change sflow/config. Rebind only the local routing
  // fields after it completes; lead commit movement is instead constrained by the cfgp apply and
  // the exact expectedConfigurationCommit handed to capability publication below.
  const topology = await selectedTopology(registryFile, refresh.results, services, {
    observeLeads: true
  });
  if (!Array.isArray(refresh.results) || refresh.results.length !== refresh.total) {
    topology.issues.push({
      status: 'unavailable',
      reason: 'Configuration apply did not return one result for every selected repository; capability locators were not changed.'
    });
  }
  const schemaCensuses = await censusCheckouts(topology.checkouts, services);
  const schemaBlockers = blockingSchemaCensuses(schemaCensuses);
  const topologyChanged = sha256(routingTopologyIdentity(previewTopology))
    !== sha256(routingTopologyIdentity(topology));
  const authorityChanged = topology.leads.some((lead) =>
    lead.expectedConfigurationCommit
      && lead.authorityObservation?.commit !== lead.expectedConfigurationCommit);
  let capabilityPortability;
  if (topologyChanged || topology.issues.length || authorityChanged) {
    capabilityPortability = {
      status: 'not-run-stale-plan',
      plannedLeads: [],
      results: []
    };
  } else if (schemaBlockers.length) {
    capabilityPortability = {
      status: 'not-run-schema-blocked',
      plannedLeads: [],
      results: []
    };
  } else if (refresh.status === 'blocked') {
    capabilityPortability = {
      status: 'not-run-configuration-blocked',
      plannedLeads: [],
      results: []
    };
  } else {
    const results = await publishCapabilityPortability(topology.leads, services, commandInput);
    capabilityPortability = {
      status: results.some((entry) => entry.status !== 'current') ? 'partial' : 'complete',
      plannedLeads: [],
      results
    };
  }

  const schemaBlocked = schemaBlockers.length > 0;
  const portabilityBlocked = capabilityPortability.status === 'partial';
  const topologyBlocked = topologyChanged || topology.issues.length > 0 || authorityChanged;
  const status = refresh.status === 'blocked' ? 'blocked'
      : refresh.status === 'partial' || schemaBlocked || portabilityBlocked || topologyBlocked ? 'partial'
        : 'complete';
  const nextAction = topologyBlocked || schemaBlocked
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
    failed: (refresh.failed ?? 0)
      + capabilityPortability.results.filter((entry) => entry.status !== 'current').length
      + schemaBlockers.length
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
