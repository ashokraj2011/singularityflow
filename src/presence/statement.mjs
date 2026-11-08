/**
 * The statement a person's presence signature covers (SPEC-PSS-v1 IFC-001).
 *
 * One canonical JSON text, rebuilt by every verifier from the record it checks, so a signature can
 * never move to another record, generation or reviewed digest. The actor is an approver id
 * (`approverId`), never an email or login: those stay in the approved configuration's member list.
 */
import { createHash } from 'node:crypto';

import { compactCanonicalJson } from '../foundation/record-schema.mjs';

export const PRESENCE_STATEMENT_SCHEMA = 'pss-statement/1';
const FIELDS = ['schema', 'repository', 'subject', 'step', 'generation', 'action', 'decision', 'reviewed', 'actor', 'authorityGroup', 'at', 'nonce', 'keyId'];

/** The statement for one signature, with exactly the IFC-001 fields. */
export function presenceStatement({ repository, subject, step = null, generation = null, action, decision = {}, reviewed = {}, actor, authorityGroup = null, at, nonce, keyId }) {
  const statement = { schema: PRESENCE_STATEMENT_SCHEMA, repository, subject, step, generation, action, decision, reviewed, actor, authorityGroup, at, nonce, keyId };
  for (const field of ['repository', 'action', 'at', 'nonce', 'keyId']) {
    if (typeof statement[field] !== 'string' || !statement[field]) throw new TypeError(`A presence statement needs ${field}.`);
  }
  if (!statement.actor || typeof statement.actor.approver !== 'string') throw new TypeError('A presence statement needs actor.approver.');
  return Object.fromEntries(FIELDS.map((field) => [field, statement[field]]));
}

/** The exact bytes signed and verified. */
export function statementText(statement) {
  return compactCanonicalJson(statement);
}

export function statementSha256(statement) {
  return `sha256:${createHash('sha256').update(statementText(statement)).digest('hex')}`;
}

/** A fresh 128-bit nonce. */
export function presenceNonce() {
  return createHash('sha256').update(globalThis.crypto.getRandomValues(new Uint8Array(32))).digest('hex').slice(0, 32);
}
