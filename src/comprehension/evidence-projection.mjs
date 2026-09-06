/** Bounded, read-only projection of already-recorded phase delivery evidence. */
import path from 'node:path';

import { recordSha256 } from '../records.mjs';
import { validateChangeRegionManifest } from './contracts.mjs';

export const CMP_EVIDENCE_PROJECTION_LIMITS = Object.freeze({
  maximumAcceptanceClauses: 500,
  maximumTestExecutions: 100,
  maximumIdentifierBytes: 512
});

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/u;

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function digest(value) {
  const source = String(value ?? '');
  if (!SHA256.test(source)) return null;
  return source.startsWith('sha256:') ? source : `sha256:${source}`;
}

function identifier(value) {
  const source = String(value ?? '').trim();
  return source && !source.includes('\0')
    && Buffer.byteLength(source, 'utf8') <= CMP_EVIDENCE_PROJECTION_LIMITS.maximumIdentifierBytes
    ? source : null;
}

function regionPath(region) {
  return region.location?.pathAfter ?? region.location?.pathBefore ?? null;
}

function safeRoot(value) {
  const source = String(value ?? '').replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (source === '.') return source;
  const normalized = path.posix.normalize(source);
  return identifier(normalized) && normalized !== '..' && !normalized.startsWith('../')
    && !path.posix.isAbsolute(normalized) && !path.win32.isAbsolute(source)
    && normalized === source && !source.includes('//') ? normalized : null;
}

function boundedIds(values, limit) {
  const all = [...new Set((Array.isArray(values) ? values : [])
    .map(identifier).filter(Boolean))].sort();
  return { values: all.slice(0, limit), omitted: Math.max(0, all.length - limit) };
}

function unavailable(manifest, phaseId, reason) {
  const core = {
    schemaVersion: 1, // schema-transient: leased IDE projection; never persisted or authorized
    kind: 'comprehension-recorded-evidence',
    authoritative: false,
    lifecycleGate: false,
    candidateSha256: manifest.compatibilityCandidateSha256,
    status: phaseId ? 'unavailable' : 'not-applicable',
    reason,
    phase: phaseId,
    generation: null,
    deliveryStatus: null,
    deliveryReceiptSha256: null,
    acceptance: { required: [], tagged: [], missing: [], omitted: 0 },
    testExecutions: [],
    regions: [],
    counts: { acceptanceRequired: 0, acceptanceTagged: 0, acceptanceMissing: 0, testExecutions: 0, linkedRegions: 0 },
    truncated: false
  };
  return freezeDeep({ ...core, evidenceProjectionSha256: `sha256:${recordSha256(core)}` });
}

/**
 * Join current change regions to the delivery and test receipts already present in workflow state.
 *
 * No artifact or receipt file is opened here. A path can enter the result only when the exact same
 * repository-relative identity already exists in the verified region manifest. Consequently this
 * optional projection cannot turn stale prose, an arbitrary receipt path, or an unrelated prior
 * generation into evidence for the current change set.
 */
export function buildComprehensionEvidenceProjection({ workflow = null, phaseId = null, manifest } = {}) {
  const validation = validateChangeRegionManifest(manifest);
  if (!validation.valid) return unavailable(manifest ?? { compatibilityCandidateSha256: null }, phaseId, 'manifest-integrity-invalid');
  if (!workflow || !phaseId) return unavailable(manifest, null, 'no-active-story');
  const phase = workflow.phases?.[phaseId];
  if (!phase) return unavailable(manifest, phaseId, 'phase-unavailable');
  const delivery = phase.deliveryEvidence;
  if (!delivery) return unavailable(manifest, phaseId, 'delivery-evidence-unavailable');

  const required = boundedIds(delivery.acceptanceCriteria?.required,
    CMP_EVIDENCE_PROJECTION_LIMITS.maximumAcceptanceClauses);
  const tagged = boundedIds(delivery.acceptanceCriteria?.tagged,
    CMP_EVIDENCE_PROJECTION_LIMITS.maximumAcceptanceClauses);
  const missing = boundedIds(delivery.acceptanceCriteria?.missing,
    CMP_EVIDENCE_PROJECTION_LIMITS.maximumAcceptanceClauses);
  const sourcePaths = new Set(Array.isArray(delivery.sourcePaths) ? delivery.sourcePaths : []);
  const testPaths = new Set(Array.isArray(delivery.testPaths) ? delivery.testPaths : []);
  const supportingPaths = new Set(Array.isArray(delivery.supportingTestPaths)
    ? delivery.supportingTestPaths : []);

  const allExecutions = Array.isArray(delivery.testExecutions) ? delivery.testExecutions : [];
  const testExecutions = allExecutions.slice(0, CMP_EVIDENCE_PROJECTION_LIMITS.maximumTestExecutions)
    .map((execution) => ({
      commandId: identifier(execution?.commandId) ?? 'unavailable',
      status: identifier(execution?.status) ?? 'unavailable',
      receiptSha256: digest(execution?.receiptSha256),
      affectedRoots: [...new Set((Array.isArray(execution?.affectedRoots) ? execution.affectedRoots : [])
        .map(safeRoot).filter(Boolean))].sort()
    }));
  const regions = manifest.regions.map((region) => {
    const candidate = regionPath(region);
    const roles = [
      ...(sourcePaths.has(candidate) ? ['source'] : []),
      ...(testPaths.has(candidate) ? ['test'] : []),
      ...(supportingPaths.has(candidate) ? ['test-support'] : [])
    ];
    const commandIds = candidate ? testExecutions.filter((execution) => execution.affectedRoots.some(
      (root) => root === '.' || candidate === root || candidate.startsWith(`${root.replace(/\/$/u, '')}/`)
    )).map((execution) => execution.commandId) : [];
    return {
      regionSha256: region.regionSha256,
      path: candidate,
      roles,
      testCommandIds: commandIds
    };
  }).filter((region) => region.roles.length || region.testCommandIds.length);
  const omitted = required.omitted + tagged.omitted + missing.omitted
    + Math.max(0, allExecutions.length - testExecutions.length);
  const core = {
    schemaVersion: 1, // schema-transient: leased IDE projection; never persisted or authorized
    kind: 'comprehension-recorded-evidence',
    authoritative: false,
    lifecycleGate: false,
    candidateSha256: manifest.compatibilityCandidateSha256,
    status: 'available',
    reason: null,
    phase: phaseId,
    generation: Number.isInteger(phase.generation) ? phase.generation : null,
    deliveryStatus: identifier(delivery.status) ?? 'unavailable',
    deliveryReceiptSha256: digest(delivery.receiptSha256),
    acceptance: {
      required: required.values,
      tagged: tagged.values,
      missing: missing.values,
      omitted: required.omitted + tagged.omitted + missing.omitted
    },
    testExecutions,
    regions,
    counts: {
      acceptanceRequired: required.values.length,
      acceptanceTagged: tagged.values.length,
      acceptanceMissing: missing.values.length,
      testExecutions: testExecutions.length,
      linkedRegions: regions.length
    },
    truncated: omitted > 0
  };
  return freezeDeep({ ...core, evidenceProjectionSha256: `sha256:${recordSha256(core)}` });
}
