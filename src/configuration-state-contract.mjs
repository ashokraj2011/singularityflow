/** Domain identities and shared transaction receipts. Git transports these records; a cache cannot. */
import { createHash } from 'node:crypto';
import { canonicalJson } from './records.mjs';
import { portableConfigurationPath, portableFilesystemPathIdentity } from './configuration-assets.mjs';
import { SingularityFlowError } from './util.mjs';

export const CONFIGURATION_STATE_PATH = 'singularity/configuration-transactions.json';
export const isConfigurationStatePath = value => portableFilesystemPathIdentity(value) === portableFilesystemPathIdentity(CONFIGURATION_STATE_PATH);
export const CONFIGURATION_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ID = /^(?:cfp|cft)-[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const BRANCH = /^sflow\/config-change\/workflow\/[a-z0-9._/-]+$/u;
export const configurationDigest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = message => { throw new SingularityFlowError(message, { code: 'CONFIGURATION_STATE_INVALID' }); };
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).some(key => !keys.includes(key))) fail('Invalid configuration state fields.');
}
export function configurationProposalId(remoteFingerprint, logicalKey) {
  if (!SHA.test(remoteFingerprint) || typeof logicalKey !== 'string' || !logicalKey.trim() || logicalKey.length > 256) {
    fail('Configuration proposal identity requires an authority and bounded logical key.');
  }
  return `cfp-${configurationDigest({ remoteFingerprint, logicalKey })}`;
}
/** Legacy branch suffixes are revisions, never entity identities. */
export function configurationProposalKey(branch) {
  if (!BRANCH.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) fail('Invalid proposal transport identity.');
  return branch.slice('sflow/config-change/workflow/'.length).replace(/-[a-f0-9]{8}(?:-[a-f0-9]{12})?$/u, '');
}
export function emptyConfigurationState() {
  return { format: 'sflow.configuration-state', version: 1, revision: 0, transactions: [] };
}
export function validateConfigurationTransaction(value) {
  exact(value, ['id', 'proposalId', 'proposalRevision', 'branch', 'baseCommit', 'expectedAuthorityCommit', 'actor', 'changes', 'digest']);
  if (!ID.test(value.id ?? '') || !value.id.startsWith('cft-') || !ID.test(value.proposalId ?? '') || !value.proposalId.startsWith('cfp-')
      || !CONFIGURATION_OID.test(value.proposalRevision ?? '') || !CONFIGURATION_OID.test(value.baseCommit ?? '')
      || !CONFIGURATION_OID.test(value.expectedAuthorityCommit ?? '') || !SHA.test(value.digest ?? '')) fail('Invalid configuration transaction binding.');
  configurationProposalKey(value.branch);
  exact(value.actor, ['name', 'email']);
  if (['name', 'email'].some(key => typeof value.actor[key] !== 'string' || !value.actor[key].trim()
      || value.actor[key].length > 256 || /[\u0000-\u001f]/u.test(value.actor[key]))) fail('Invalid configuration transaction actor.');
  if (!Array.isArray(value.changes) || value.changes.length > 2_000) fail('Invalid configuration transaction changes.');
  const paths = new Set();
  for (const change of value.changes) {
    exact(change, ['path', 'beforeSha256', 'afterSha256', 'beforeMode', 'afterMode']);
    if (typeof change.path !== 'string' || portableConfigurationPath(change.path) !== change.path || isConfigurationStatePath(change.path)
        || paths.has(portableFilesystemPathIdentity(change.path))) fail('Invalid or repeated transaction asset.');
    paths.add(portableFilesystemPathIdentity(change.path));
    for (const side of ['before', 'after']) {
      if (change[`${side}Sha256`] === null ? change[`${side}Mode`] !== null
        : !SHA.test(change[`${side}Sha256`] ?? '') || !['100644', '100755'].includes(change[`${side}Mode`])) fail('Invalid transaction asset hash or mode.');
    }
  }
  const { digest, ...core } = value;
  if (digest !== configurationDigest(core)
      || value.id !== `cft-${configurationDigest({ proposalId: value.proposalId, proposalRevision: value.proposalRevision,
        expectedAuthorityCommit: value.expectedAuthorityCommit, actor: value.actor, changes: value.changes })}`) fail('Configuration transaction digest does not match its bindings.');
  return value;
}
export function createConfigurationTransaction({ proposalId, proposalRevision, branch, baseCommit, expectedAuthorityCommit, actor, changes }) {
  if (!Array.isArray(changes) || changes.some(change => typeof change?.path !== 'string')) fail('Invalid transaction asset path.');
  const orderedChanges = [...changes].sort((a, b) => a.path.localeCompare(b.path));
  const core = { id: `cft-${configurationDigest({ proposalId, proposalRevision, expectedAuthorityCommit, actor, changes: orderedChanges })}`,
    proposalId, proposalRevision, branch, baseCommit, expectedAuthorityCommit, actor,
    changes: orderedChanges };
  return validateConfigurationTransaction({ ...core, digest: configurationDigest(core) });
}
export function readConfigurationState(text) {
  if (text == null) return emptyConfigurationState();
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) fail('Shared configuration state exceeds its record budget.');
  let value;
  try { value = JSON.parse(text); } catch { fail('Shared configuration state is not valid JSON.'); }
  exact(value, ['format', 'version', 'revision', 'transactions']);
  if (value.format !== 'sflow.configuration-state' || value.version !== 1 || !Number.isSafeInteger(value.revision)
      || value.revision < 0 || !Array.isArray(value.transactions) || value.transactions.length !== value.revision
      || value.transactions.length > 2_000) fail('Shared configuration state has invalid lineage.');
  const ids = new Set();
  for (const record of value.transactions) {
    validateConfigurationTransaction(record);
    if (ids.has(record.id)) fail('Shared configuration state has duplicate transactions.');
    ids.add(record.id);
  }
  return value;
}
export function appendConfigurationTransaction(state, transaction) {
  readConfigurationState(JSON.stringify(state));
  validateConfigurationTransaction(transaction);
  const existing = state.transactions.find(record => record.id === transaction.id);
  if (existing) {
    if (existing.digest !== transaction.digest) fail('Configuration transaction identity collision.');
    return state;
  }
  const result = { ...state, revision: state.revision + 1, transactions: [...state.transactions, transaction] };
  readConfigurationState(JSON.stringify(result));
  return result;
}
