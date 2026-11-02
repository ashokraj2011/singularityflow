/**
 * SF Guard (SPEC-PSS-v1 §10.9): the seal a repository-level person step keeps beside its record.
 *
 * A step with no Story (a specification revision or split published to the state branch, a
 * configuration approval) follows the repository's signed SF Guard policy as it stood when the
 * record was written. While it was on, the step's presence signature is kept in a seal file next to
 * the record (`presence.json`), and every reader counts the record only when its seal verifies
 * against the approver's key pinned in the policy chain, never GitHub. The seal binds the record's
 * own digest, so an edited record, or a seal carried to another record, counts for nothing. A record
 * with no seal counts only when SF Guard was off when it was recorded (`pre-signing`); the time it
 * claims is the writer's, so the remote check (state-check.mjs) is what catches a back-dated one.
 */
import { canonicalJson } from '../records.mjs';
import { exceptionLabel } from './chain.mjs';
import { PRESENCE_RECORD_SCHEMA } from './person-records.mjs';
import { repositoryRecordSha256, repositoryStepStatement } from './repository-steps.mjs';
import { verifyPresenceSignature } from './sshsig.mjs';
import { statementText } from './statement.mjs';

export const REPOSITORY_SEAL_SCHEMA = 'sflow-presence-seal@1';
export const SEAL_FILE = 'presence.json';
export const CONFIGURATION_SEAL_ROOT = 'singularity/presence-seals/configuration';

/** The record a repository step's signature covers: its store, its key and the fields that name it. */
export function sealedRecord(store, key, fields = {}) {
  return { store, key, ...fields };
}

/** The seal kept beside `record` for its `presence` block. */
export function repositorySeal(presence, record) {
  return { schema: REPOSITORY_SEAL_SCHEMA, store: record.store, key: record.key, record,
    recordSha256: repositoryRecordSha256(record), presence };
}

export function sealBytes(seal) {
  return Buffer.from(canonicalJson(seal), 'utf8');
}

/** A seal file's content: the seal, `null` when there is none, or `{ invalid: true }`. */
export function parseSeal(bytes) {
  if (bytes == null) return null;
  try {
    const seal = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
    return seal && typeof seal === 'object' && !Array.isArray(seal) ? seal : { invalid: true };
  } catch { return { invalid: true }; }
}

/** When SF Guard was on, by the chain's valid events, oldest first. */
export function enabledIntervals(chain, folded) {
  const intervals = [];
  let open = null;
  for (const event of chain?.events?.slice(0, folded?.validLength ?? 0) ?? []) {
    if (event.kind === 'enable' && !open) open = { from: event.at, to: null };
    else if (event.kind === 'disable' && open) { open.to = event.at; intervals.push(open); open = null; }
  }
  if (open) intervals.push(open);
  return intervals;
}

/** Whether SF Guard was on at `at`; a time that cannot be read counts as on while it is on now. */
export function wasOn(intervals, at) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return intervals.some((interval) => interval.to === null);
  return intervals.some((interval) => time >= Date.parse(interval.from) && (interval.to === null || time < Date.parse(interval.to)));
}

/** Every approver key the chain pinned, with when it was retired. An author's key never signs a repository step. */
function approverKeys(chain, folded) {
  const keys = new Map();
  for (const event of chain?.events?.slice(0, folded?.validLength ?? 0) ?? []) {
    if (['register', 'rotate', 'recover'].includes(event.kind)) {
      if (event.role === 'author') continue;
      for (const entry of keys.values()) {
        if (entry.approver === event.approver && entry.retiredAt == null && entry.keyId !== event.keyId) entry.retiredAt = event.at;
      }
      keys.set(event.keyId, { approver: event.approver, key: event.key, retiredAt: null });
    } else if (event.kind === 'revoke') {
      const entry = keys.get(event.keyId);
      if (entry && entry.retiredAt == null) entry.retiredAt = event.at;
    }
  }
  return keys;
}

/** The exception `id` for `approver` that held at `at`, or null. */
function exceptionAt(chain, folded, id, approver, at) {
  const entry = folded?.exceptions?.get(id);
  if (!entry || entry.approver !== approver) return null;
  if (entry.active) return entry;
  const revoke = (chain?.events ?? []).find((event) => event.kind === 'exception-revoke' && event.exceptionId === id);
  return revoke && Date.parse(at) < Date.parse(revoke.at) ? entry : null;
}

const counted = (state, label, signer = null) => ({ counts: true, state, label, code: null, reason: null, signer });
const refused = (code, reason) => ({ counts: false, state: 'invalid', label: `not counted: ${reason}`, code, reason, signer: null });

/**
 * How one repository record stands under the repository's SF Guard policy (`readPresencePolicy`):
 * `{ counts, state, label, code, reason, signer }`, `state` one of `not-required`, `pre-signing`,
 * `signed`, `bypass` or `invalid`. `record` is what the seal must cover; `recordedAt` the time the
 * record claims; `seal` its parsed seal file, or null.
 */
export function repositorySealVerdict(policy, { record, recordedAt = null, seal = null, verify = verifyPresenceSignature }) {
  const chain = policy?.chain ?? null;
  const folded = policy?.folded ?? null;
  // A repository that never opted in reads every record as before, seal or not.
  if (!policy?.present || !chain) return counted('not-required', null);
  if (!seal) {
    return wasOn(enabledIntervals(chain, folded), recordedAt)
      ? refused('PSS_RECORD_UNSIGNED', 'it carries no presence signature, and SF Guard was on when it was recorded')
      : counted('pre-signing', 'pre-signing: SF Guard was off when this was recorded');
  }
  if (seal.invalid) return refused('PSS_SIGNATURE_INVALID', 'its presence seal cannot be read');
  const recordSha256 = repositoryRecordSha256(record);
  if (seal.schema !== REPOSITORY_SEAL_SCHEMA || seal.store !== record.store || seal.key !== record.key || seal.recordSha256 !== recordSha256) {
    return refused('PSS_SIGNATURE_INVALID', 'its presence seal is for another record');
  }
  const presence = seal.presence;
  if (!presence || typeof presence !== 'object' || presence.schema !== PRESENCE_RECORD_SCHEMA || presence.chainId !== chain.chainId
      || presence.recordSha256 !== recordSha256 || typeof presence.approver !== 'string') {
    return refused('PSS_SIGNATURE_INVALID', 'its presence block names another policy chain or record');
  }
  if (presence.bypass) {
    const exception = exceptionAt(chain, folded, presence.bypass, presence.approver, presence.at);
    return exception ? counted('bypass', exceptionLabel(exception), presence.approver)
      : refused('PSS_RECORD_UNSIGNED', `exception ${presence.bypass} does not cover ${presence.approver}`);
  }
  const key = approverKeys(chain, folded).get(presence.keyId);
  if (!key || key.approver !== presence.approver) return refused('PSS_SIGNATURE_INVALID', `${presence.keyId ?? 'its key'} is not ${presence.approver}'s pinned key`);
  if (key.retiredAt && !(Date.parse(presence.at) < Date.parse(key.retiredAt))) {
    return refused('PSS_SIGNATURE_INVALID', `${presence.keyId} was retired before this record was signed`);
  }
  let statement;
  try { statement = repositoryStepStatement(presence); }
  catch { return refused('PSS_SIGNATURE_INVALID', 'its presence block is malformed'); }
  const checked = verify({ message: statementText(statement), armored: presence.signature, publicKey: key.key });
  if (!checked.valid) return refused('PSS_SIGNATURE_INVALID', `the signature does not match this record (${checked.reason})`);
  return counted('signed', `signed by ${presence.approver} with ${presence.keyId}`, presence.approver);
}

const policies = new Map();

/**
 * The repository's SF Guard policy for repository records, read once per command: null when the
 * repository never opted in (no policy file), so nothing is read and nothing changes.
 */
export async function repositorySealPolicy(root, { verify } = {}) {
  if (!policies.has(root)) {
    policies.set(root, (async () => {
      const [{ existsSync }, path, { configurationReadRootForPath }, { PRESENCE_CHAIN_PATH }] = await Promise.all([
        import('node:fs'), import('node:path'), import('../configuration-read-scope.mjs'), import('./chain.mjs')]);
      let present = false;
      try { present = existsSync(path.join(configurationReadRootForPath(root, PRESENCE_CHAIN_PATH), PRESENCE_CHAIN_PATH)); } catch { present = false; }
      if (!present) return null;
      const { readPresencePolicy } = await import('./store.mjs');
      return readPresencePolicy(root, verify ? { verify } : {});
    })());
  }
  return policies.get(root);
}

/** Forget the policies read in this process (a command that changed the chain, and tests). */
export function forgetRepositorySealPolicies() {
  policies.clear();
}
