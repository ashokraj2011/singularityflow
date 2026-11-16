/**
 * SPEC-OSA v1.1 §7.1: the person's yes to one exact successor proposal [D3, OSA:REQ-030].
 *
 * Three records, all sealed with the clone's machine-local key (story-version-acceptance.mjs `sealHere`), so a JSON file
 * written by hand is never consent:
 * - the proposal record: what a `phase rollover` preview proposed (the exact version, the last publication and its digest,
 *   the reason, the configuration and lifecycle revisions) and the question it asks, kept under the preview's confirmation;
 * - the grant: the host's own delivery of the person's answer. The pre-tool hook writes it only from the answer the host
 *   handed the post-tool hook to a question that named that exact version (copilot-answer-binding.mjs), or from the
 *   `/sf-confirm` code the person typed into their prompt. Model-written JSON never reaches it;
 * - the receipt, `VersionOpeningConsent/v1`: bound to the proposal digest, the principal (the identity this machine
 *   resolves, with the session that answered), the confirmation time and its expiry. The opening operation commits it
 *   with the opening (story-version-opening.mjs), so reconciling the same opening reuses it.
 * No Git and no network here: the hook loads this module only for the one command that opens a version.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sealHere, sealedHere } from './story-version-acceptance.mjs';

export { consentQuestion } from './story-version-proposal.mjs';

export const CONSENT_SCHEMA = 'version-opening-consent/v1';
export const GRANT_SCHEMA = 'version-opening-grant/v1';
export const PROPOSAL_RECORD_SCHEMA = 'version-opening-proposal-record/v1';
export const CONSENT_PURPOSE = 'version-opening-consent';
export const GRANT_PURPOSE = 'version-opening-grant';
export const PROPOSAL_PURPOSE = 'version-opening-proposal';
/** A yes holds for one turn window (30 minutes) from when it was given, never longer [OSA:REQ-051, AC-021]. */
export const CONSENT_TTL_MS = 30 * 60 * 1000;
/**
 * Where a yes can come from: the host's question tool, a typed /sf-confirm code, the person's own terminal, or the decisions
 * card, whose answer its extension records outside the chat (`decisions record --version-consent`) [OSA Stage 4].
 */
export const CONSENT_SURFACES = Object.freeze(['question-tool', 'confirm-code', 'terminal', 'decisions-card']);

const store = (commonDir) => path.join(commonDir, 'singularity-flow', 'version-consents');
const keyOf = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 40);
const proposalFile = (commonDir, confirmation) => path.join(store(commonDir), `${keyOf(confirmation)}.proposal.json`);
const grantFile = (commonDir, digest) => path.join(store(commonDir), `${keyOf(digest)}.grant.json`);

async function writePrivate(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if ((await lstat(path.dirname(file))).isSymbolicLink()) throw new Error('Unsafe consent store');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function readSealed(file, purpose, commonDir, schema) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) return null;
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value?.schema === schema && sealedHere(commonDir, purpose, value) ? value : null;
  } catch { return null; }
}

/** Keep what a preview proposed, under its confirmation, for the hook that will hear the person's answer. Null without a key. */
export async function recordProposal(commonDir, { proposal, digest, question, confirmation, principal = null, now = Date.now() }) {
  // `principal`: who previewed it here; the yes the hook later hears is theirs, and a different identity at opening is refused.
  const record = sealHere(commonDir, PROPOSAL_PURPOSE, { schema: PROPOSAL_RECORD_SCHEMA, confirmation, digest, proposal, question,
    principal, recordedAt: new Date(now).toISOString() });
  if (record) await writePrivate(proposalFile(commonDir, confirmation), record);
  return record;
}

/** The proposal a preview kept under `confirmation`, or null (none here, or not sealed by this clone). */
export async function readProposalRecord(commonDir, confirmation) {
  const record = await readSealed(proposalFile(commonDir, confirmation), PROPOSAL_PURPOSE, commonDir, PROPOSAL_RECORD_SCHEMA);
  return record?.confirmation === confirmation ? record : null;
}

/**
 * The host delivered the person's yes to the proposal's question: keep it as a grant for the opening command. `session` is
 * the host's session ID (kept only as its SHA-256), `host` which host delivered it. Null without a key.
 */
export async function grantConsent(commonDir, { record, surface, question, answer = 'yes', session = null, turnId = null, host = null,
  now = Date.now(), ttlMs = CONSENT_TTL_MS }) {
  if (!record || !CONSENT_SURFACES.includes(surface)) return null;
  const grant = sealHere(commonDir, GRANT_PURPOSE, { schema: GRANT_SCHEMA, grantId: randomUUID(), confirmation: record.confirmation,
    proposalDigest: record.digest, binding: { workId: record.proposal.workId, phase: record.proposal.phase, version: record.proposal.version },
    surface, question: String(question ?? record.question).slice(0, 600), answer: String(answer).slice(0, 120), principal: record.principal ?? null,
    session: session ? createHash('sha256').update(String(session)).digest('hex') : null, turnId: turnId ?? null, host,
    grantedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() });
  if (grant) await writePrivate(grantFile(commonDir, record.digest), grant);
  return grant;
}

/**
 * The newest proposal a preview kept on this clone for `phase` of `workId`, made on the Story as it is now
 * (`lifecycleRevision`, the local Story branch head), or null. The decisions card asks it as it was proposed.
 */
export async function pendingProposalRecord(commonDir, { workId, phase, lifecycleRevision }) {
  let names;
  try { names = (await readdir(store(commonDir))).filter((name) => name.endsWith('.proposal.json')); } catch { return null; }
  const found = [];
  for (const name of names.slice(0, 256)) {
    const record = await readSealed(path.join(store(commonDir), name), PROPOSAL_PURPOSE, commonDir, PROPOSAL_RECORD_SCHEMA);
    if (record?.proposal?.workId === workId && record.proposal.phase === phase && record.proposal.lifecycleRevision === lifecycleRevision) found.push(record);
  }
  return found.sort((left, right) => String(right.recordedAt).localeCompare(String(left.recordedAt)))[0] ?? null;
}

/** The unexpired grant for a proposal digest, or null. */
export async function readGrant(commonDir, digest, { now = Date.now() } = {}) {
  const grant = await readSealed(grantFile(commonDir, digest), GRANT_PURPOSE, commonDir, GRANT_SCHEMA);
  return grant?.proposalDigest === digest && Date.parse(grant.expiresAt) >= now ? grant : null;
}

/** A used grant goes: one yes opens one version. */
export async function dropGrant(commonDir, digest) {
  await rm(grantFile(commonDir, digest), { force: true }).catch(() => {});
}

/**
 * A `VersionOpeningConsent/v1` receipt, sealed, for the proposal `digest`. `principal` is the identity the opening process
 * resolved on this machine (Git, a GitHub login), never a value from a model's arguments; `assurance` says how the yes
 * reached SFlow. Null without a key.
 */
export function consentReceipt(commonDir, { proposal, digest, surface, question, answer = 'yes', principal, assurance, session = null,
  turnId = null, host = null, confirmedAt = Date.now(), ttlMs = CONSENT_TTL_MS }) {
  return sealHere(commonDir, CONSENT_PURPOSE, { schema: CONSENT_SCHEMA, receiptId: randomUUID(), proposalDigest: digest,
    binding: { workId: proposal.workId, phase: proposal.phase, version: proposal.version, from: proposal.from?.published ?? 0,
      confirmation: proposal.confirmation ?? null },
    principal: { kind: 'human', identity: { name: principal?.name ?? null, email: principal?.email ?? null, login: principal?.login ?? null },
      assurance, session, host },
    response: { surface, question: String(question).slice(0, 600), answer: String(answer).slice(0, 120), turnId },
    confirmedAt: new Date(confirmedAt).toISOString(), expiresAt: new Date(confirmedAt + ttlMs).toISOString() });
}

/** Two identities name one person: the same email or login, case aside, else the same name. */
export function samePrincipal(left, right) {
  const lower = (value) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null);
  if (lower(left?.email) && lower(right?.email)) return lower(left.email) === lower(right.email);
  if (lower(left?.login) && lower(right?.login)) return lower(left.login) === lower(right.login);
  return Boolean(lower(left?.name)) && lower(left?.name) === lower(right?.name);
}

/**
 * Why `receipt` does not authorize opening the proposal `digest` now, as `{ code, words }`, or null when it does: not
 * sealed by this clone, another proposal (wrong target), not a yes (declined), expired, or another person.
 */
export function consentProblem(commonDir, receipt, { digest, proposal, principal, now = Date.now() }) {
  if (!receipt) return { code: 'VERSION_CONSENT_REQUIRED', words: `Starting version ${proposal.version} of ${proposal.step} needs the person's yes.` };
  if (receipt.schema !== CONSENT_SCHEMA || !sealedHere(commonDir, CONSENT_PURPOSE, receipt)) {
    return { code: 'VERSION_CONSENT_UNVERIFIED', words: 'This consent was not given through SFlow on this machine, so it opens nothing.' };
  }
  if (receipt.proposalDigest !== digest || receipt.binding?.workId !== proposal.workId || receipt.binding?.phase !== proposal.phase
      || Number(receipt.binding?.version) !== Number(proposal.version)) {
    return { code: 'VERSION_CONSENT_WRONG_TARGET', words: `This yes was for another proposal than version ${proposal.version} of ${proposal.step} as it is now; it needs the person's yes again.` };
  }
  if (!/^yes$/iu.test(String(receipt.response?.answer ?? ''))) return { code: 'VERSION_CONSENT_DECLINED', words: `The person did not say yes to starting version ${proposal.version}.` };
  if (!(Date.parse(receipt.expiresAt) >= now)) return { code: 'VERSION_CONSENT_EXPIRED', words: `The person's yes to version ${proposal.version} expired; ask them again.` };
  if (principal && !samePrincipal(receipt.principal?.identity, principal)) {
    return { code: 'VERSION_CONSENT_PRINCIPAL_CHANGED', words: 'Another person gave this yes; the one opening the version now must give their own.' };
  }
  return null;
}
