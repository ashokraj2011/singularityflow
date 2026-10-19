/** Pure transport identities; reading a digest must not load repository bootstrap writers. */
import { recordSha256 } from './records.mjs';
const FIELDS = Object.freeze(['schemaVersion', 'repository', 'root', 'remote', 'branch', 'commit', 'destinationRef',
  'remoteFingerprint', 'expectedRemoteSha']);
export function capabilityPublicationIdentity(entry) {
  const fields = (entry?.schemaVersion ?? 1) >= 2 ? [...FIELDS, 'baseCommit', 'candidate'] : FIELDS;
  return Object.fromEntries(fields.map(field => [field, entry?.[field] === undefined ? null : entry[field]]));
}
export function capabilityPublicationEntrySha256(entry) {
  return `sha256:${recordSha256(capabilityPublicationIdentity(entry))}`;
}
export function capabilityPublicationPlanSha256(entries = []) {
  return `sha256:${recordSha256(entries.map(capabilityPublicationIdentity))}`;
}
