/**
 * SF Guard (SPEC-PSS-v1 §10.10): the repository stores that keep their person step's presence
 * signature with the record.
 *
 * Each store below used to take the person's touch at the CLI's dispatch and keep nothing. Now the
 * step signs where it records, once, over the exact record it writes, and every reader counts the
 * record only when that signature verifies against the approver's key pinned in the policy chain (or a
 * per-person exception covered them), never GitHub. Which record needs one follows the repository's
 * signed policy as it stood at the record's own time: recorded while SF Guard was off, it reads
 * `pre-signing`; in a repository that never opted in nothing changes.
 *
 * Two ways to keep it, by the record's format:
 * - inline: an open record (a lease's ledger payload, a repair's authorization event, an agents-lock
 *   entry, a host-policy assertion) carries the `presence` block itself, over the record's body
 *   (`bodySha256`, which leaves the block out);
 * - beside: an immutable, content-addressed or strict record (an Epic approval or completion, a goal
 *   plan approval, a program authority, a ratified or confirmed intent) keeps a seal file next to it,
 *   `<record>.presence.json`, binding the record file's exact bytes (`fileSha256`).
 *
 * `STORES` names each store's record shape, so the remote checks (remote-check.mjs for the branches,
 * state-check.mjs for the state branch) and the readers decide the same way.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../records.mjs';
import { parseSeal, repositorySeal, repositorySealPolicy, repositorySealVerdict, sealBytes, sealedRecord } from './repository-seals.mjs';

export const SEAL_SUFFIX = '.presence.json';
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const withoutPresence = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { presence: _presence, ...rest } = value;
  return rest;
};

/** The digest of an inline record's body: the record without its own `presence` block. */
export function bodySha256(body) {
  return digest(canonicalJson(withoutPresence(body)));
}

/** The record an inline signature covers. */
export function inlineRecord(store, key, body) {
  return sealedRecord(store, String(key), { bodySha256: bodySha256(body) });
}

/** The record a seal beside a file covers: the file's exact bytes. */
export function fileRecord(store, key, bytes) {
  return sealedRecord(store, String(key), { fileSha256: digest(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')) });
}

/** Where the seal of the record file `file` lives. */
export function sealPathFor(file) {
  return String(file).replace(/\.(?:json|ya?ml)$/u, '') + SEAL_SUFFIX;
}

/**
 * The stores, by name: `label` and `route` (what a person runs to record it again, signed), and for an
 * inline store `body(entry)` (the fields its signature covers), `key(entry)` and `at(entry)` (the time
 * the record claims).
 */
export const STORES = Object.freeze({
  'capability-lease': {
    label: 'capability lease', inline: true,
    body: (entry) => ({ eventId: entry?.eventId ?? null, eventType: entry?.eventType ?? null, capabilityId: entry?.capabilityId ?? null,
      actor: entry?.actor ?? null, authorityGroup: entry?.authorityGroup ?? null, payload: withoutPresence(entry?.payload ?? null), createdAt: entry?.createdAt ?? null }),
    key: (entry) => entry?.eventId, at: (entry) => entry?.createdAt,
    presence: (entry) => entry?.payload?.presence ?? null,
    route: (entry) => `a person ${entry?.eventType === 'capability-lease-revoked' ? 'revokes' : 'grants'} the lease again in their own terminal (singularity-flow capabilities lease ${entry?.eventType === 'capability-lease-revoked' ? 'revoke' : 'grant'} ${entry?.capabilityId ?? '<CAPABILITY>'} …), where it takes their Touch ID`
  },
  'repair-authorization': {
    label: 'repair authorization', inline: true,
    body: (event) => ({ repairId: event?.repairId ?? null, planSha256: event?.data?.planSha256 ?? null, actor: event?.data?.actor ?? null,
      leaseId: event?.data?.leaseId ?? null, branch: event?.data?.branch ?? null }),
    key: (event) => `${event?.repairId}/${event?.data?.leaseId}`, at: (event) => event?.at,
    presence: (event) => event?.data?.presence ?? null,
    route: (event) => `a person authorizes the repair again in their own terminal (singularity-flow repair authorize ${event?.repairId ?? '<RPR-ID>'} --confirm <PLAN-SHA256>), where it takes their Touch ID`
  },
  'agents-lock': {
    label: 'agents lock entry', inline: true,
    body: (entry) => withoutPresence(entry), key: (entry, id) => id, at: (entry) => entry?.lockedAt,
    presence: (entry) => entry?.presence ?? null,
    route: (entry, id) => `a person locks the agent again in their own terminal (singularity-flow agents lock ${id ?? '<AGENT>'} --update), where it takes their Touch ID`
  },
  'host-policy-assertion': {
    label: 'host-policy assertion', inline: true,
    body: (report) => ({ ...withoutPresence(report?.confirmation ?? null), remote: report?.remote ?? null, branch: report?.branch ?? null, repositoryCommit: report?.repositoryCommit ?? null }),
    key: (report) => `${report?.remote}/${report?.branch}@${report?.repositoryCommit}`, at: (report) => report?.confirmation?.assertedAt,
    presence: (report) => report?.confirmation?.presence ?? null,
    route: () => 'a person asserts the host policy again in their own terminal (singularity-flow ledger deployment-check --authority <GROUP> --confirm-… --record), where it takes their Touch ID'
  },
  'epic-approval': { label: 'Epic approval', route: (id) => `a person approves the Epic phase again in their own terminal (singularity-flow epic ${id ? `requirements approve --epic ${id}` : 'requirements|planning approve'}), where it takes their Touch ID` },
  'epic-completion': { label: 'Epic completion', route: (id) => `a person completes the Epic again in their own terminal (singularity-flow epic complete ${id ?? '<EPIC-ID>'} --confirm ${id ?? '<EPIC-ID>'}), where it takes their Touch ID` },
  'goal-plan-approval': { label: 'goal plan approval', route: (id) => `a person approves the plan again in their own terminal (singularity-flow goal plan approve ${id ?? '<GEX-ID>'} --generation <N> --confirm <PLAN-SHA256>), where it takes their Touch ID` },
  'program-authority': { label: 'program approval', route: () => 'a person approves the program again in their own terminal (singularity-flow program approve <FILE> --confirm <PROPOSAL-SHA256>), where it takes their Touch ID' },
  'intent-record': { label: 'intent record', route: () => 'a person ratifies or confirms the intent again in their own terminal (singularity-flow intent ratify|confirm … --out <FILE>), where it takes their Touch ID' }
});

/** The standing of an inline record: `repositorySealVerdict`'s verdict, plus the store's route. */
export function inlineVerdict(policy, store, entry, id = undefined) {
  const shape = STORES[store];
  const body = shape.body(entry, id);
  const record = inlineRecord(store, shape.key(entry, id), body);
  const presence = shape.presence(entry);
  const verdict = repositorySealVerdict(policy, { record, recordedAt: shape.at(entry) ?? null,
    seal: presence && typeof presence === 'object' ? repositorySeal(presence, record) : presence == null ? null : { invalid: true } });
  return { ...verdict, route: shape.route(entry, id) };
}

/** The standing of a record kept in its own file, from the file's bytes and its seal file's bytes. */
export function fileVerdict(policy, store, { key, bytes, seal = null, recordedAt = null, routeId = null }) {
  const record = fileRecord(store, key, bytes ?? '');
  const parsed = parseSeal(seal);
  return { ...repositorySealVerdict(policy, { record, recordedAt, seal: parsed }), route: STORES[store].route(routeId) };
}

/**
 * Before an inline store writes `entry`: its presence block, signed over its body (null while SF Guard
 * is off here). One touch; every refusal carries M2's routes and nothing is written.
 */
export async function signInline(root, store, entry, { action, title, lines = [], id = undefined }) {
  const shape = STORES[store];
  const record = inlineRecord(store, shape.key(entry, id), shape.body(entry, id));
  const { signRepositoryStep } = await import('./repository-steps.mjs');
  return signRepositoryStep(root, { action, title, lines, record: { ...record } });
}

/**
 * Before a beside store writes the file holding `bytes`: the seal to write next to it (as bytes), or
 * null while SF Guard is off here.
 */
export async function signBeside(root, store, { key, bytes, action, title, lines = [] }) {
  const record = fileRecord(store, key, bytes);
  const { signRepositoryStep } = await import('./repository-steps.mjs');
  const presence = await signRepositoryStep(root, { action, title, lines, record: { ...record } });
  return presence ? sealBytes(repositorySeal(presence, record)) : null;
}

/** The repository's SF Guard policy for these stores, once per command; null when it never opted in. */
export function storePolicy(root) {
  return repositorySealPolicy(root);
}

/** A refusal for a record that does not count, naming the route a person can take today. */
export async function refuseUncounted(what, verdict) {
  const { SingularityFlowError } = await import('../util.mjs');
  return new SingularityFlowError(`SF Guard: ${what} does not count (${verdict.reason}). Route: ${verdict.route}.`,
    { code: verdict.code ?? 'PSS_RECORD_UNSIGNED', details: { route: verdict.route } });
}

/** The capability ledger entries that count: a lease grant or revocation only while its signature does. */
export async function countedLeaseEntries(root, entries) {
  const leases = (entries ?? []).filter((entry) => ['capability-lease-granted', 'capability-lease-revoked'].includes(entry?.eventType));
  if (!leases.length) return entries ?? [];
  const policy = await storePolicy(root);
  if (!policy) return entries;
  return entries.filter((entry) => !leases.includes(entry) || inlineVerdict(policy, 'capability-lease', entry).counts);
}

/** `capabilities lease grant|revoke`: one touch over the exact ledger entry, kept in its payload, then the append. */
export async function appendSignedLease(root, ledgerConfig, intent, publishedCommit) {
  const verb = intent.eventType === 'capability-lease-revoked' ? 'revoke' : 'grant';
  const presence = await signInline(root, 'capability-lease', intent, { action: 'capability.lease', title: `${verb} a break-glass lease on ${intent.capabilityId}`,
    lines: [`Capability: ${intent.capabilityId}`, `Lease: ${intent.payload?.leaseId ?? '(new)'}`, `Reason: ${intent.payload?.reason ?? ''}`,
      ...(intent.payload?.expiresAt ? [`Expires: ${intent.payload.expiresAt}`] : []), `Step: ${verb} a capability break-glass lease`] });
  if (presence) intent.payload = { ...intent.payload, presence };
  const { appendLedgerIntent } = await import('../ledger.mjs');
  return appendLedgerIntent(root, ledgerConfig, intent, publishedCommit);
}

/** Refuse an inline record that does not count, naming its route; nothing in a repository that never opted in. */
export async function assertCountedInline(root, store, entry, what, id = undefined) {
  const policy = await storePolicy(root);
  const standing = policy ? inlineVerdict(policy, store, entry, id) : null;
  if (standing && !standing.counts) throw await refuseUncounted(what, standing);
}

/** `repair authorize`: one touch over the exact authorization (plan, lease, actor, branch), before anything is written. */
export function signRepairAuthorization(root, repairId, planSha256, lease, branch) {
  return signInline(root, 'repair-authorization', { repairId, data: { planSha256, actor: lease.actor, leaseId: lease.leaseId, branch } }, {
    action: 'repair.authorize', title: `authorize repair ${repairId}`,
    lines: [`Repair: ${repairId}`, `Plan: ${planSha256}`, `Branch: ${branch}`, 'Step: authorize a repair'] });
}

/** `agents lock`: the entry to write, with its presence block while SF Guard is on. */
export async function signedAgentLock(root, agentId, resolution) {
  const presence = await signInline(root, 'agents-lock', resolution, { id: agentId, action: 'agents.lock', title: `lock agent ${agentId}`,
    lines: [`Agent: ${agentId}`, `Pack SHA-256: ${resolution.sourceSha256}`, `Dependencies: ${resolution.dependencies?.length ?? 0}`, 'Step: lock the trusted agents'] });
  return presence ? { ...resolution, presence } : resolution;
}
