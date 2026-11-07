/** Pure version admission for durable records. */
import { SingularityFlowError } from './failures.mjs';

// Shared immutable format metadata, not backend selection or model/World Model behavior.
const frozenFamily = id => Object.freeze({ id, currentVersion: 1, minimumReadableVersion: 1,
  maximumReadableVersion: 1, unversionedAs: null, immutable: true, migrationPolicy: 'frozen-identity' });
export const NAMESPACE_STORAGE_SCHEMAS = Object.freeze({
  manifest: frozenFamily('namespace-filesystem-manifest'),
  entry: frozenFamily('namespace-filesystem-entry')
});
export const SQLITE_NAMESPACE_SCHEMAS = Object.freeze({
  manifest: frozenFamily('namespace-sqlite-manifest'),
  entry: frozenFamily('namespace-sqlite-entry')
});
// Historical view records retain their original schema and compatibility export indefinitely.
export const WORLD_MODEL_VIEW_CONTRACT_SCHEMA_VERSION = frozenFamily('world-model-view-contract').currentVersion;
// Writers need the current wire stamp, not every historical migration function.
export const COMMAND_TIMING_SCHEMA = Object.freeze({ id: 'dx-command-timing', currentVersion: 6 });

export function admitRecordSchemaVersion(entry, input) {
  const familyId = entry.id;
  let record = input;
  const storedVersion = Number.isInteger(record.schemaVersion) && record.schemaVersion > 0
    ? record.schemaVersion
    : entry.unversionedAs;
  if (storedVersion != null && record.schemaVersion == null) record = { ...record, schemaVersion: storedVersion };
  if (!Number.isInteger(storedVersion) || storedVersion < 1) {
    throw new SingularityFlowError(`Durable record '${familyId}' has no valid schemaVersion.`, {
      code: 'SCHEMA_VERSION_MISSING', details: { family: familyId, received: storedVersion ?? null }
    });
  }
  const future = storedVersion > entry.maximumReadableVersion;
  if (future || storedVersion < entry.minimumReadableVersion) {
    const direction = future ? 'above' : 'below';
    const recovery = future ? 'it was written by a newer sflow — upgrade to read it.'
      : 'use the archival reader for that release or a republication with recorded lineage.';
    throw new SingularityFlowError(
      `Durable record '${familyId}' is stored at schema version ${storedVersion} (v${storedVersion}), ${direction} this build's readable range v${entry.minimumReadableVersion}–v${entry.maximumReadableVersion}; ${recovery}`,
      { code: future ? 'SCHEMA_VERSION_FUTURE' : 'SCHEMA_VERSION_ARCHIVED',
        details: { family: familyId, storedVersion, readable: { minimum: entry.minimumReadableVersion, maximum: entry.maximumReadableVersion } } }
    );
  }
  return { record, storedVersion };
}
