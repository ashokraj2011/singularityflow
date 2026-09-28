/**
 * One read-only compatibility pass over every active workspace repository checkout.
 *
 * schemaCensus calls the registered readRecord migration chains. The returned current-shape
 * records exist only inside that read; neither this module nor the census republishes stored bytes.
 */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { schemaCensus } from './schema-census.mjs';
import { schemaMigrationRegistry } from './schema-migrations.mjs';
import { mapLimit, SingularityFlowError } from './util.mjs';
import { readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath } from './workspace.mjs';
import { workspaceRegistryFile } from './workspace-context.mjs';

export const SCHEMA_UPGRADE_ALL_POLICY = Object.freeze({
  mode: 'read-time',
  storedRecordsRewritten: 0,
  networkAccess: false,
  scope: 'active-registered-workspace-repository-checkouts',
  coveredStores: Object.freeze([
    'governed-checkout-json', 'git-common-state-json',
    'selected-world-model-state-bindings', 'local-lifecycle-ref-json'
  ]),
  excludedStores: Object.freeze([
    'repositories-outside-active-workspace-manifests',
    'machine-home-local-state', 'workspace-private-state',
    'owner-bound-content-addressed-objects', 'pathless-and-unmapped-records'
  ])
});

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function failure(code, reason, extra = {}) {
  return Object.freeze({ code, reason, ...extra });
}

const MAX_FINDINGS_PER_KIND = 20;
const MAX_FINDING_PATH_LENGTH = 512;

function findingPath(value) {
  if (typeof value !== 'string' || !value) return '[path unavailable]';
  const normalized = value.replaceAll('\\', '/').replace(/[\u0000-\u001f\u007f]/g, '?');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
      || normalized.split('/').includes('..')) return '[unsafe path withheld]';
  return normalized.length > MAX_FINDING_PATH_LENGTH
    ? `${normalized.slice(0, MAX_FINDING_PATH_LENGTH - 3)}...` : normalized;
}

function findingFamily(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    ? value : null;
}

function findingCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
    ? value : fallback;
}

function findingVersion(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Keep diagnostics short and content-free even when a repository has many historical records. */
function censusRecordFindings(census) {
  const totals = census.totals ?? {};
  const outsideRange = [];
  for (const family of census.families ?? []) {
    for (const entry of family.outsideRange ?? []) {
      if (outsideRange.length >= MAX_FINDINGS_PER_KIND) break;
      const storedVersion = findingVersion(entry.storedVersion);
      outsideRange.push(Object.freeze({
        category: 'outside-range', path: findingPath(entry.path),
        family: findingFamily(family.family), storedVersion,
        code: storedVersion != null && storedVersion > family.readable?.maximum
          ? 'SCHEMA_VERSION_FUTURE'
          : storedVersion != null && storedVersion < family.readable?.minimum
            ? 'SCHEMA_VERSION_ARCHIVED' : 'SCHEMA_VERSION_OUTSIDE_RANGE'
      }));
    }
    if (outsideRange.length >= MAX_FINDINGS_PER_KIND) break;
  }
  const unreadable = (census.unreadable ?? []).slice(0, MAX_FINDINGS_PER_KIND)
    .map((entry) => Object.freeze({
      category: 'unreadable', path: findingPath(entry.path),
      family: findingFamily(entry.family), storedVersion: findingVersion(entry.storedVersion),
      code: findingCode(entry.code, 'SCHEMA_RECORD_UNREADABLE')
    }));
  const unregistered = (census.unregistered ?? []).slice(0, MAX_FINDINGS_PER_KIND)
    .map((entry) => Object.freeze({
      category: 'unregistered', path: findingPath(entry.path), family: null,
      storedVersion: findingVersion(entry.schemaVersion),
      code: findingCode(entry.code, 'SCHEMA_FAMILY_UNREGISTERED')
    }));
  const findings = Object.freeze([...outsideRange, ...unreadable, ...unregistered]);
  const findingsOmitted = Math.max(0,
    nonNegativeInteger(totals.outsideRange) + nonNegativeInteger(totals.unreadable)
      + nonNegativeInteger(totals.unregistered) - findings.length);
  return Object.freeze({ findings, findingsOmitted });
}

function checkoutResult(target, census) {
  const totals = census.totals ?? {};
  const migratedRecords = nonNegativeInteger(totals.readTimeMigrationRecords);
  const migrationSteps = nonNegativeInteger(totals.readTimeMigrationSteps);
  const { findings, findingsOmitted } = censusRecordFindings(census);
  const relevantFindings = (category) => Object.freeze(findings.filter((item) => item.category === category));
  const omittedFor = (category, count) => Math.max(0,
    nonNegativeInteger(count) - relevantFindings(category).length);
  const blockers = [];
  if (nonNegativeInteger(totals.outsideRange)) blockers.push(failure(
    'SCHEMA_VERSION_OUTSIDE_RANGE',
    `${totals.outsideRange} registered record(s) are outside their readable version range.`, {
      findings: relevantFindings('outside-range'),
      findingsOmitted: omittedFor('outside-range', totals.outsideRange)
    }
  ));
  if (nonNegativeInteger(totals.unreadable)) blockers.push(failure(
    'SCHEMA_RECORD_UNREADABLE',
    `${totals.unreadable} registered record(s) could not be read or migrated.`, {
      findings: relevantFindings('unreadable'),
      findingsOmitted: omittedFor('unreadable', totals.unreadable)
    }
  ));
  if (nonNegativeInteger(totals.unregistered)) blockers.push(failure(
    'SCHEMA_FAMILY_UNREGISTERED',
    `${totals.unregistered} versioned record(s) have no registered family.`, {
      findings: relevantFindings('unregistered'),
      findingsOmitted: omittedFor('unregistered', totals.unregistered)
    }
  ));
  if (census.truncated) blockers.push(failure(
    'SCHEMA_CENSUS_TRUNCATED', 'The bounded census could not inspect every eligible record.'
  ));
  if (census.healthy === false && !blockers.length) blockers.push(failure(
    'SCHEMA_CENSUS_UNHEALTHY', 'The repository schema census reported an unhealthy result.'
  ));
  const migrations = (census.families ?? [])
    .filter((family) => nonNegativeInteger(family.readTimeMigrationRecords) > 0)
    .map((family) => Object.freeze({
      family: family.family,
      currentVersion: family.currentVersion,
      storedVersions: Object.keys(family.versions ?? {})
        .map(Number)
        .filter((version) => Number.isInteger(version) && version < family.currentVersion)
        .sort((left, right) => left - right),
      records: family.readTimeMigrationRecords,
      steps: nonNegativeInteger(family.readTimeMigrationSteps)
    }));
  return Object.freeze({
    path: target.path,
    memberships: Object.freeze(target.memberships),
    status: blockers.length ? 'blocked' : 'complete',
    scannedFiles: nonNegativeInteger(census.scannedFiles),
    records: nonNegativeInteger(totals.registeredRecords),
    validatedRecords: nonNegativeInteger(totals.validatedRecords),
    migratedRecords,
    migrationSteps,
    readTimeMigrationRecords: migratedRecords,
    readTimeMigrationSteps: migrationSteps,
    observedFamilies: nonNegativeInteger(totals.observedFamilies),
    outsideRange: nonNegativeInteger(totals.outsideRange),
    unreadable: nonNegativeInteger(totals.unreadable),
    unregistered: nonNegativeInteger(totals.unregistered),
    truncated: census.truncated === true,
    migrations: Object.freeze(migrations),
    findings,
    findingsOmitted,
    blockers: Object.freeze(blockers)
  });
}

/**
 * Prove the current build can read locally available history for every active registered checkout.
 * The optional service seam supports deterministic tests without creating a second migration path.
 */
export async function auditAllWorkspaceSchemas({
  registryFile = workspaceRegistryFile()
} = {}, serviceOverrides = {}) {
  if (typeof registryFile !== 'string' || !registryFile.trim()) {
    throw new SingularityFlowError('A workspace registry path is required for the schema audit.', {
      code: 'SCHEMA_UPGRADE_REGISTRY_REQUIRED'
    });
  }
  const services = {
    readWorkspaceRegistry, readWorkspace, workspaceRepositoryPath, schemaCensus,
    ...serviceOverrides
  };
  // An invalid registry is a hard refusal. Treating it as empty would falsely report full coverage.
  const registry = await services.readWorkspaceRegistry(registryFile);
  const active = registry.filter((entry) => !entry.archivedAt)
    .sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
  const archived = registry.filter((entry) => Boolean(entry.archivedAt));
  const workspaces = [];
  const skipped = archived.map((entry) => Object.freeze({
    kind: 'workspace', workspaceId: entry.id, path: entry.path,
    code: 'WORKSPACE_ARCHIVED', reason: 'Archived workspace is outside the active audit scope.'
  }));
  const blocked = [];
  if (active.length === 0) blocked.push(failure(
    'NO_ACTIVE_WORKSPACES', 'No active registered workspaces are available for a schema audit.'
  ));
  const targets = new Map();
  let declaredRepositories = 0;
  let manifestsRead = 0;

  for (const entry of active) {
    let manifest;
    try {
      manifest = await services.readWorkspace(entry.path);
    } catch {
      const item = failure('WORKSPACE_MANIFEST_UNREADABLE',
        'The registered workspace manifest could not be read or validated.', {
          kind: 'workspace', workspaceId: entry.id, path: entry.path
        });
      blocked.push(item);
      skipped.push(item);
      workspaces.push(Object.freeze({ id: entry.id, path: entry.path, status: 'blocked', repositories: [] }));
      continue;
    }
    if (manifest.id !== entry.id) {
      const item = failure('WORKSPACE_ID_MISMATCH',
        'The registered workspace ID differs from its manifest ID.', {
          kind: 'workspace', workspaceId: entry.id, path: entry.path
        });
      blocked.push(item);
      skipped.push(item);
      workspaces.push(Object.freeze({ id: entry.id, path: entry.path, status: 'blocked', repositories: [] }));
      continue;
    }
    manifestsRead += 1;
    const memberships = [];
    const repositories = Object.values(manifest.repositories ?? {})
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const repository of repositories) {
      declaredRepositories += 1;
      let requestedPath;
      try {
        requestedPath = path.resolve(services.workspaceRepositoryPath(manifest, repository));
      } catch {
        const item = failure('CHECKOUT_PATH_INVALID',
          'The registered repository checkout path could not be resolved.', {
            kind: 'repository', workspaceId: entry.id, repositoryId: repository.id
          });
        blocked.push(item);
        skipped.push(item);
        continue;
      }
      const canonicalPath = await realpath(requestedPath).catch(() => requestedPath);
      const membership = Object.freeze({ workspaceId: entry.id, repositoryId: repository.id });
      memberships.push(Object.freeze({ ...membership, checkoutPath: canonicalPath }));
      const target = targets.get(canonicalPath) ?? { path: canonicalPath, memberships: [] };
      target.memberships.push(membership);
      targets.set(canonicalPath, target);
    }
    workspaces.push(Object.freeze({
      id: entry.id, path: entry.path,
      status: 'read', repositories: Object.freeze(memberships)
    }));
  }

  const repositories = await mapLimit(
    [...targets.values()].sort((left, right) => left.path.localeCompare(right.path)),
    2,
    async (target) => {
      const info = await lstat(target.path).catch(() => null);
      if (!info?.isDirectory()) {
        const item = failure('CHECKOUT_UNAVAILABLE',
          'The registered repository checkout is not an available directory.', {
            kind: 'repository', path: target.path,
            memberships: Object.freeze(target.memberships)
          });
        return { result: Object.freeze({
          path: target.path, memberships: Object.freeze(target.memberships),
          status: 'skipped', blockers: Object.freeze([item])
        }), skipped: item, blocked: item };
      }
      try {
        const census = await services.schemaCensus(target.path, { includeLifecycleRefs: true });
        const result = checkoutResult(target, census);
        return { result, blocked: result.blockers.map((item) => Object.freeze({
          ...item, kind: 'repository', path: target.path,
          memberships: result.memberships
        })) };
      } catch {
        const item = failure('SCHEMA_CENSUS_FAILED',
          'The repository schema census could not complete.', {
            kind: 'repository', path: target.path,
            memberships: Object.freeze(target.memberships)
          });
        return { result: Object.freeze({
          path: target.path, memberships: Object.freeze(target.memberships),
          status: 'blocked', blockers: Object.freeze([item])
        }), blocked: item };
      }
    }
  );
  const checkoutResults = repositories.map((entry) => entry.result);
  for (const entry of repositories) {
    if (entry.skipped) skipped.push(entry.skipped);
    if (entry.blocked) blocked.push(...(Array.isArray(entry.blocked) ? entry.blocked : [entry.blocked]));
  }
  const scanned = checkoutResults.filter((entry) => entry.status !== 'skipped'
    && entry.scannedFiles !== undefined);
  const totals = Object.freeze({
    registeredRecords: scanned.reduce((sum, entry) => sum + entry.records, 0),
    validatedRecords: scanned.reduce((sum, entry) => sum + entry.validatedRecords, 0),
    migratedRecords: scanned.reduce((sum, entry) => sum + entry.migratedRecords, 0),
    migrationSteps: scanned.reduce((sum, entry) => sum + entry.migrationSteps, 0),
    readTimeMigrationRecords: scanned.reduce((sum, entry) => sum + entry.readTimeMigrationRecords, 0),
    readTimeMigrationSteps: scanned.reduce((sum, entry) => sum + entry.readTimeMigrationSteps, 0),
    outsideRange: scanned.reduce((sum, entry) => sum + entry.outsideRange, 0),
    unreadable: scanned.reduce((sum, entry) => sum + entry.unreadable, 0),
    unregistered: scanned.reduce((sum, entry) => sum + entry.unregistered, 0)
  });
  const registryFamilies = Object.values(schemaMigrationRegistry);
  const partialCodes = new Set([
    'NO_ACTIVE_WORKSPACES', 'WORKSPACE_MANIFEST_UNREADABLE', 'CHECKOUT_UNAVAILABLE',
    'SCHEMA_CENSUS_TRUNCATED'
  ]);
  const status = blocked.some((item) => !partialCodes.has(item.code))
    ? 'blocked' : blocked.length ? 'partial' : 'complete';
  const result = {
    schemaVersion: 1, // schema-transient: read-only command report, never persisted
    resultType: 'schema-upgrade-all',
    status,
    policy: SCHEMA_UPGRADE_ALL_POLICY,
    coverage: Object.freeze({
      registryValidation: 'passed',
      manifestValidation: Object.freeze({ passed: manifestsRead, failed: active.length - manifestsRead }),
      registeredWorkspaces: registry.length,
      activeWorkspaces: active.length,
      archivedWorkspaces: archived.length,
      manifestsRead,
      declaredRepositories,
      uniqueCheckouts: targets.size,
      scannedCheckouts: scanned.length,
      skippedCheckouts: checkoutResults.filter((entry) => entry.status === 'skipped').length,
      registeredFamilies: registryFamilies.length,
      pathlessFamilies: registryFamilies.filter((family) => !family.paths.length).length,
      complete: status === 'complete'
    }),
    totals,
    workspaces: Object.freeze(workspaces),
    repositories: Object.freeze(checkoutResults),
    blocked: Object.freeze(blocked),
    skipped: Object.freeze(skipped)
  };
  return Object.freeze(result);
}
