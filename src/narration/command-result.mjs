/**
 * The command-result contract, and the constructors that make it hard to get wrong.
 *
 * This is the foundation of the narration plane — not the message catalog. The catalog is one
 * renderer over this. A command returns data describing what happened; only the output boundary
 * turns it into terminal prose or JSON.
 *
 * The one rule worth stating twice: narration may explain truth and project truth, but it must
 * never become another place where truth is computed or stored. Nothing here writes to disk, moves
 * a ref, or decides a lifecycle question. `effects` reports what the kernel already did.
 */
import { SingularityFlowError } from '../util.mjs';

export const COMMAND_RESULT_SCHEMA_VERSION = 1;

const STATUSES = new Set(['succeeded', 'refused', 'failed', 'noop']);
const REST_STATES = new Set(['complete', 'cancelled', 'awaiting-others', 'informational']);
const WHY_SOURCES = new Set(['pin', 'policy', 'gate', 'sequence', 'evidence', 'config', 'remote', 'telemetry', 'identity']);
const NEXT_RANKS = new Set(['NOW', 'SOON', 'LATER']);
const NEXT_KINDS = new Set(['workflow', 'remediation', 'review', 'informational']);
const ID_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Nothing happened. The only shape a refusal is allowed to declare. */
export function noEffects() {
  return Object.freeze({
    stateChanged: false,
    filesChanged: false,
    publicationCreated: false,
    externalSystemsChanged: false
  });
}

export function effects({
  stateChanged = false,
  filesChanged = false,
  publicationCreated = false,
  externalSystemsChanged = false
} = {}) {
  return Object.freeze({ stateChanged, filesChanged, publicationCreated, externalSystemsChanged });
}

export function refused(messageId, slots = {}) { return { status: 'refused', messageId, slots }; }
export function succeeded(messageId, slots = {}) { return { status: 'succeeded', messageId, slots }; }
export function failed(messageId, slots = {}) { return { status: 'failed', messageId, slots }; }
export function noop(messageId, slots = {}) { return { status: 'noop', messageId, slots }; }

/** One explained reason. The wording is the catalog's job; this carries the code and its evidence. */
export function because(code, source, { ref = null, slots = {} } = {}) {
  return { code, source, ref, slots };
}

/** One valid continuation. */
export function action({ id, label, command, rank = 'NOW', kind = 'workflow', modelPolicy = 'never' }) {
  return { id, label, command, rank, kind, modelPolicy };
}

function invalid(message) {
  throw new SingularityFlowError(`Command result is not well formed: ${message}`, { code: 'COMMAND_RESULT_INVALID' });
}

/**
 * Build and validate a command result.
 *
 * Validation runs here rather than at the output boundary so a malformed result fails in the
 * handler that produced it, where the fix is, instead of surfacing as odd narration later.
 */
export function commandResult({
  operation,
  subject = null,
  outcome,
  effects: declared,
  why = [],
  next = [],
  restState = null,
  data = {}
} = {}) {
  if (!operation?.id) invalid('operation.id is required');
  if (!['read', 'mutation'].includes(operation?.classification)) invalid('operation.classification must be read or mutation');
  if (!outcome || !STATUSES.has(outcome.status)) invalid(`outcome.status must be one of ${[...STATUSES].join(', ')}`);
  if (!ID_PATTERN.test(outcome.messageId ?? '')) invalid(`outcome.messageId '${outcome.messageId}' must be a dotted lower-case id`);
  if (!declared) invalid('effects are required; a command must say what it changed');
  for (const key of ['stateChanged', 'filesChanged', 'publicationCreated', 'externalSystemsChanged']) {
    if (typeof declared[key] !== 'boolean') invalid(`effects.${key} must be a boolean`);
  }

  // NCL-003 and NCL-004. A refusal that changed something is not a refusal, and reassurance that
  // does not follow from declared effects is how "nothing was lost" becomes a lie in a later
  // release. Checked structurally so no catalog wording can drift away from the truth.
  if (outcome.status === 'refused' && Object.values(declared).some(Boolean)) {
    invalid(`${outcome.messageId} is a refusal but declares effects: ${
      Object.entries(declared).filter(([, value]) => value).map(([key]) => key).join(', ')}`);
  }

  for (const entry of why) {
    if (!ID_PATTERN.test(entry?.code ?? '')) invalid(`why[].code '${entry?.code}' must be a dotted lower-case reason code`);
    if (!WHY_SOURCES.has(entry?.source)) invalid(`why[].source '${entry?.source}' must be one of ${[...WHY_SOURCES].join(', ')}`);
    if ('detail' in (entry ?? {})) invalid(`why[] carries reason codes, not prose (${entry.code} supplied a detail)`);
  }

  for (const entry of next) {
    if (!entry?.id || !entry?.label || !entry?.command) invalid('next[] entries need id, label and command');
    if (!NEXT_RANKS.has(entry.rank)) invalid(`next[].rank '${entry.rank}' must be one of ${[...NEXT_RANKS].join(', ')}`);
    if (!NEXT_KINDS.has(entry.kind)) invalid(`next[].kind '${entry.kind}' must be one of ${[...NEXT_KINDS].join(', ')}`);
  }

  if (restState !== null && !REST_STATES.has(restState)) {
    invalid(`restState '${restState}' must be null or one of ${[...REST_STATES].join(', ')}`);
  }

  // NCL-006. A refusal with no remediation is the worst dead end there is: the person is stopped and
  // not told how to proceed. Continuation is attached by the planner at the boundary, so this only
  // fires when nothing supplied one.
  if (!next.length && restState === null) {
    invalid(`${outcome.messageId} offers no next action and declares no rest state`);
  }

  return Object.freeze({
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    resultType: 'command-result',
    operation: Object.freeze({ id: operation.id, classification: operation.classification }),
    subject: subject ? Object.freeze({ kind: subject.kind, id: subject.id }) : null,
    outcome: Object.freeze({ status: outcome.status, messageId: outcome.messageId, slots: outcome.slots ?? {} }),
    effects: Object.freeze({ ...declared }),
    why: Object.freeze(why.map((entry) => Object.freeze({ ...entry }))),
    next: Object.freeze(next.map((entry) => Object.freeze({ ...entry }))),
    restState,
    data
  });
}

/** True when a result reports that it left everything as it was. */
export function preservedEverything(result) {
  return Object.values(result.effects).every((value) => value === false);
}
