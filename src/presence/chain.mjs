/**
 * SF Guard's policy chain (SPEC-PSS-v1 §6, §8): the approved configuration's record of which presence
 * key each approver pinned, whether the repository requires presence-signed person steps, and the
 * per-person exceptions.
 *
 * `singularity/presence.json` is one append-only, hash-linked list of events. Each event is signed:
 * a key event by the key it pins (and, for a rotation, the key it replaces), and every policy event by
 * an approver whose key is already pinned. Folding replays the list from the start and stops at the
 * first event that is malformed, unlinked, unsigned or not authorized, so the effective policy is the
 * longest valid prefix: an unsigned event can neither turn SF Guard off nor add a key, and it never
 * blocks anyone either. Verification reads only the pinned keys recorded here, never GitHub; GitHub
 * is read when a key is registered (src/presence/anchor.mjs) and by the remote check.
 *
 * Nothing in this file names a person. Approvers are `approverId`s, derived from the approved
 * configuration's member entries, which keep the emails and logins.
 */
import { createHash } from 'node:crypto';

import { canonicalJson, compactCanonicalJson } from '../records.mjs';
import { presenceStatement, statementText } from './statement.mjs';
import { parsePresencePublicKey, verifyPresenceSignature } from './sshsig.mjs';

export const PRESENCE_CHAIN_PATH = 'singularity/presence.json';
export const PRESENCE_CHAIN_SCHEMA = 'sflow-presence-chain@1';
export const PRESENCE_EVENT_KINDS = Object.freeze(['register', 'rotate', 'recover', 'revoke', 'enable', 'disable', 'exception', 'exception-revoke']);
export const WINDOWS_EXCEPTION_REASON = 'Windows: no presence signer yet';
const KEY_EVENTS = new Set(['register', 'rotate', 'recover']);
const APPROVER_ID = /^approver-[0-9a-f]{12}$/u;
const CHAIN_ID = /^[0-9a-f]{32}$/u;
const EXCEPTION_ID = /^EXC-[0-9]{3,6}$/u;
const MAX_EVENTS = 10_000;
const MAX_REASON = 500;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The approver id of an approved-configuration member (`{ email, githubLogin }`), or null. */
export function approverId(member) {
  const login = String(member?.githubLogin ?? member?.login ?? '').trim().toLowerCase();
  const email = String(member?.email ?? '').trim().toLowerCase();
  const identity = login ? `github:${login}` : email.includes('@') ? `email:${email}` : null;
  return identity ? `approver-${sha256(identity).slice(0, 12)}` : null;
}

export function newChainId() {
  return sha256(globalThis.crypto.getRandomValues(new Uint8Array(32))).slice(0, 32);
}

export function emptyPresenceChain(chainId = newChainId()) {
  return { schema: PRESENCE_CHAIN_SCHEMA, chainId, events: [] };
}

/** The digest the next event links to: the whole event, its signatures included. */
export function presenceEventDigest(event) {
  return `sha256:${sha256(compactCanonicalJson(event))}`;
}

function eventCore(event) {
  const { signatures: _signatures, ...core } = event;
  return core;
}

/** The statement one signature of `event` covers. */
export function presenceEventStatement(chainId, event, entry) {
  return presenceStatement({
    repository: `presence:${chainId}`, subject: { kind: 'presence-chain', id: chainId }, step: null, generation: event.seq,
    action: `presence.${event.kind}`, decision: eventCore(event), reviewed: { previous: event.previous },
    actor: { approver: entry.signer }, at: event.at, nonce: entry.nonce, keyId: entry.keyId
  });
}

/** The next unsigned event of `chain`: its sequence number, link and time added to `fields`. */
export function nextPresenceEvent(chain, fields, { at = new Date().toISOString() } = {}) {
  const last = chain.events.at(-1);
  return { seq: chain.events.length, previous: last ? presenceEventDigest(last) : null, at, ...fields, signatures: [] };
}

/** The chain as it is written: canonical, so every writer produces the same bytes. */
export function presenceChainText(chain) {
  return canonicalJson(chain);
}

const problem = (event, code, message) => ({ seq: Number.isInteger(event?.seq) ? event.seq : null, kind: event?.kind ?? null, code, message });

function freshState(chainId) {
  return { chainId, enabled: false, enabledAt: null, remoteCheck: null, pins: new Map(), retired: [], exceptions: new Map(), exceptionCount: 0 };
}

function checkShape(event, index) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'is not an object';
  if (event.seq !== index) return `has sequence ${event.seq}, not ${index}`;
  if (!PRESENCE_EVENT_KINDS.includes(event.kind)) return `has unknown kind ${event.kind}`;
  if (typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))) return 'has no valid time';
  if (!Array.isArray(event.signatures) || !event.signatures.length) return 'carries no signature';
  for (const entry of event.signatures) {
    if (!entry || !APPROVER_ID.test(entry.signer ?? '') || typeof entry.keyId !== 'string' || !/^[0-9a-f]{32}$/u.test(entry.nonce ?? '') || typeof entry.signature !== 'string') {
      return 'has a malformed signature entry';
    }
  }
  if (KEY_EVENTS.has(event.kind) || event.kind === 'revoke') {
    if (!APPROVER_ID.test(event.approver ?? '')) return 'names no approver';
  }
  if (KEY_EVENTS.has(event.kind)) {
    const key = parsePresencePublicKey(event.key);
    if (!key.valid) return `pins a key that is not a presence key: ${key.reason}`;
    if (key.keyId !== event.keyId) return 'names a key ID that is not its key';
    if (event.github?.listed !== true || typeof event.github.snapshotSha256 !== 'string' || typeof event.github.fetchedAt !== 'string') {
      return 'records no GitHub listing of its key';
    }
  }
  if (['revoke', 'disable', 'exception-revoke'].includes(event.kind) && (typeof event.reason !== 'string' || !event.reason.trim() || event.reason.length > MAX_REASON)) {
    return 'gives no reason';
  }
  return null;
}

function exceptionShape(entry) {
  return entry && EXCEPTION_ID.test(entry.id ?? '') && APPROVER_ID.test(entry.approver ?? '')
    && typeof entry.reason === 'string' && entry.reason.trim() && entry.reason.length <= MAX_REASON;
}

/**
 * Replay `chain`. Returns the effective state after its longest valid prefix (`pins`, `enabled`,
 * `exceptions`, …), the number of events that count (`validLength`) and the first problem, if any.
 * `verify` is the signature check; tests pass the real one.
 */
export function foldPresenceChain(chain, { verify = verifyPresenceSignature } = {}) {
  if (!chain) return { ...freshState(null), length: 0, validLength: 0, problems: [], signatures: [] };
  if (chain.schema !== PRESENCE_CHAIN_SCHEMA || !CHAIN_ID.test(chain.chainId ?? '') || !Array.isArray(chain.events) || chain.events.length > MAX_EVENTS) {
    return { ...freshState(chain?.chainId ?? null), length: 0, validLength: 0, signatures: [],
      problems: [{ seq: null, kind: null, code: 'PSS_CHAIN_INVALID', message: `SF Guard's policy file is not a ${PRESENCE_CHAIN_SCHEMA} chain.` }] };
  }
  const state = freshState(chain.chainId);
  const verified = [];
  let previous = null;
  for (const [index, event] of chain.events.entries()) {
    const stop = (code, message) => ({ ...state, length: chain.events.length, validLength: index, signatures: verified, problems: [problem(event, code, `SF Guard event ${index} (${event?.kind ?? 'unknown'}) ${message}`)] });
    const shape = checkShape(event, index);
    if (shape) return stop('PSS_CHAIN_INVALID', shape);
    if (event.previous !== previous) return stop('PSS_CHAIN_INVALID', 'is not linked to the event before it');
    // Which keys may sign this event: the approver's pinned key, and for a key event the new key.
    const signedBy = [];
    for (const entry of event.signatures) {
      const pinned = state.pins.get(entry.signer);
      const ownKey = KEY_EVENTS.has(event.kind) && entry.signer === event.approver && entry.keyId === event.keyId ? event.key : null;
      const key = ownKey ?? (pinned?.keyId === entry.keyId ? pinned.key : null);
      if (!key) return stop('PSS_POLICY_UNSIGNED', `is signed by ${entry.keyId}, which is not ${entry.signer}'s pinned key`);
      const result = verify({ message: statementText(presenceEventStatement(chain.chainId, event, entry)), armored: entry.signature, publicKey: key });
      if (!result.valid) return stop('PSS_POLICY_UNSIGNED', `has a signature that does not verify: ${result.reason}`);
      signedBy.push({ signer: entry.signer, keyId: entry.keyId, own: Boolean(ownKey), userVerification: result.userVerification });
    }
    const byPin = signedBy.filter((entry) => !entry.own);
    const own = signedBy.find((entry) => entry.own);
    const current = event.approver ? state.pins.get(event.approver) : null;
    switch (event.kind) {
      case 'register': {
        if (current) return stop('PSS_POLICY_UNSIGNED', `registers a key for ${event.approver}, who already has one pinned; rotate or recover it instead`);
        if (!own) return stop('PSS_POLICY_UNSIGNED', 'is not signed by the key it registers');
        if ([...state.pins.values()].some((pin) => pin.keyId === event.keyId)) return stop('PSS_POLICY_UNSIGNED', `pins ${event.keyId}, which another approver has pinned`);
        state.pins.set(event.approver, { keyId: event.keyId, key: event.key, since: index, recovered: false });
        break;
      }
      case 'rotate': {
        if (!current || current.keyId !== event.previousKeyId) return stop('PSS_POLICY_UNSIGNED', `rotates a key ${event.approver} does not have pinned`);
        if (!own || !byPin.some((entry) => entry.signer === event.approver)) return stop('PSS_POLICY_UNSIGNED', 'is not signed by both the old and the new key');
        state.retired.push({ approver: event.approver, keyId: current.keyId, until: index, why: 'rotated' });
        state.pins.set(event.approver, { keyId: event.keyId, key: event.key, since: index, recovered: false });
        break;
      }
      case 'recover': {
        if (!current || current.keyId !== event.previousKeyId) return stop('PSS_POLICY_UNSIGNED', `recovers a key ${event.approver} does not have pinned`);
        if (!own) return stop('PSS_POLICY_UNSIGNED', 'is not signed by the key it recovers to');
        if (!Array.isArray(event.github.delisted) || !event.github.delisted.includes(current.keyId)) {
          return stop('PSS_POLICY_UNSIGNED', 'does not record that GitHub no longer lists the lost key');
        }
        state.retired.push({ approver: event.approver, keyId: current.keyId, until: index, why: 'recovered' });
        state.pins.set(event.approver, { keyId: event.keyId, key: event.key, since: index, recovered: true });
        break;
      }
      case 'revoke': {
        if (!current || current.keyId !== event.keyId) return stop('PSS_POLICY_UNSIGNED', `revokes a key ${event.approver} does not have pinned`);
        if (!byPin.length) return stop('PSS_POLICY_UNSIGNED', 'is not signed by a pinned key');
        state.retired.push({ approver: event.approver, keyId: current.keyId, until: index, why: 'revoked' });
        state.pins.delete(event.approver);
        break;
      }
      case 'enable': {
        if (state.enabled) return stop('PSS_POLICY_UNSIGNED', 'turns SF Guard on, but it is already on');
        if (!byPin.length) return stop('PSS_POLICY_UNSIGNED', 'is not signed by a pinned key');
        const exceptions = event.exceptions ?? [];
        if (!Array.isArray(exceptions) || !exceptions.every(exceptionShape)) return stop('PSS_CHAIN_INVALID', 'lists a malformed exception');
        for (const entry of exceptions) {
          const added = addException(state, entry, index, byPin[0].signer);
          if (added) return stop('PSS_POLICY_UNSIGNED', added);
        }
        if (event.remoteCheck != null && (typeof event.remoteCheck !== 'string' || !event.remoteCheck.trim() || event.remoteCheck.length > 200)) {
          return stop('PSS_CHAIN_INVALID', 'names a malformed remote check');
        }
        state.enabled = true;
        state.enabledAt = index;
        state.remoteCheck = event.remoteCheck ?? null;
        break;
      }
      case 'disable': {
        if (!state.enabled) return stop('PSS_POLICY_UNSIGNED', 'turns SF Guard off, but it is not on');
        if (!byPin.length) return stop('PSS_POLICY_UNSIGNED', 'is not signed by a pinned key');
        state.enabled = false;
        break;
      }
      case 'exception': {
        if (!exceptionShape(event.exception)) return stop('PSS_CHAIN_INVALID', 'records a malformed exception');
        if (!byPin.length) return stop('PSS_POLICY_UNSIGNED', 'is not signed by a pinned key');
        const added = addException(state, event.exception, index, byPin[0].signer);
        if (added) return stop('PSS_POLICY_UNSIGNED', added);
        break;
      }
      case 'exception-revoke': {
        const entry = state.exceptions.get(event.exceptionId);
        if (!entry?.active) return stop('PSS_POLICY_UNSIGNED', `revokes ${event.exceptionId}, which is not an active exception`);
        if (!byPin.length) return stop('PSS_POLICY_UNSIGNED', 'is not signed by a pinned key');
        entry.active = false;
        entry.revokedAt = index;
        break;
      }
      default: return stop('PSS_CHAIN_INVALID', 'has an unknown kind');
    }
    verified.push(...signedBy.map((entry) => ({ seq: index, kind: event.kind, ...entry })));
    previous = presenceEventDigest(event);
  }
  return { ...state, length: chain.events.length, validLength: chain.events.length, signatures: verified, problems: [] };
}

function addException(state, entry, index, signer) {
  if (state.exceptions.has(entry.id)) return `reuses exception ID ${entry.id}`;
  if ([...state.exceptions.values()].some((existing) => existing.active && existing.approver === entry.approver)) {
    return `adds a second exception for ${entry.approver}`;
  }
  state.exceptions.set(entry.id, { id: entry.id, approver: entry.approver, reason: entry.reason, signedBy: signer, since: index, active: true, revokedAt: null });
  state.exceptionCount += 1;
  return null;
}

/** The next exception ID: EXC-001, EXC-002, … */
export function nextExceptionId(folded, taken = 0) {
  return `EXC-${String(folded.exceptions.size + taken + 1).padStart(3, '0')}`;
}

/** The active exception for `approver`, or null. */
export function activeException(folded, approver) {
  return [...folded.exceptions.values()].find((entry) => entry.active && entry.approver === approver) ?? null;
}

/**
 * How one approver's person steps stand under the chain: `signed` (a pinned key), `bypass` (a signed
 * per-person exception, labelled as one), `unregistered`, or `not-required` when SF Guard is off.
 */
export function approverStanding(folded, approver) {
  const exception = activeException(folded, approver);
  const pin = folded.pins.get(approver) ?? null;
  if (!folded.enabled) return { state: 'not-required', pin, exception, label: 'person steps unsigned in this repository' };
  if (exception) return { state: 'bypass', pin, exception, label: `bypass: per-person exception ${exception.id}` };
  if (pin) return { state: 'signed', pin, exception: null, label: `signed with ${pin.keyId}` };
  return { state: 'unregistered', pin: null, exception: null, label: 'no presence key pinned' };
}

/**
 * Whether `next` keeps every event of `previous`, in order: the only change SF Guard's policy file
 * may take. A shorter file, or one with a different event in a kept position, is a rewrite.
 */
export function extendsPresenceChain(previous, next) {
  if (!previous || !previous.events?.length) return true;
  if (!next || next.chainId !== previous.chainId || !Array.isArray(next.events) || next.events.length < previous.events.length) return false;
  return previous.events.every((event, index) => presenceEventDigest(event) === presenceEventDigest(next.events[index]));
}

/** Parse the policy file's text, or return a problem; never throws. */
export function parsePresenceChain(text) {
  if (text == null) return { chain: null, problem: null };
  try { return { chain: JSON.parse(text), problem: null }; }
  catch (error) {
    return { chain: null, problem: { seq: null, kind: null, code: 'PSS_CHAIN_INVALID', message: `SF Guard's policy file is not JSON: ${error.message}` } };
  }
}
