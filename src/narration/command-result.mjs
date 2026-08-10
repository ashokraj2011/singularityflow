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
import { MESSAGES, REASONS } from './messages.mjs';

export const COMMAND_RESULT_SCHEMA_VERSION = 1;

const STATUSES = new Set(['succeeded', 'refused', 'failed', 'noop']);
const REST_STATES = new Set(['complete', 'cancelled', 'awaiting-others', 'informational']);
// `docs` is the documentation plane. It is its own source rather than being folded into `config` or
// `evidence` because NCL-005 asks a WHY entry to name a resolvable source, and "a topic in the
// shipped package" resolves somewhere neither of those two points at.
const WHY_SOURCES = new Set(['pin', 'policy', 'gate', 'sequence', 'evidence', 'config', 'remote', 'telemetry', 'identity', 'docs']);
const NEXT_RANKS = new Set(['NOW', 'SOON', 'LATER']);
const NEXT_KINDS = new Set(['workflow', 'remediation', 'review', 'informational']);
const MODEL_POLICIES = new Set(['never', 'optional', 'required']);
const SUBJECT_KINDS = new Set(['story', 'initiative', 'capability', 'workspace', 'repository']);
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

export function effects(input = {}) {
  const allowed = new Set(['stateChanged', 'filesChanged', 'publicationCreated', 'externalSystemsChanged']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) invalid(`effects contains unknown key${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  const {
    stateChanged = false,
    filesChanged = false,
    publicationCreated = false,
    externalSystemsChanged = false
  } = input;
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
export function validateCommandResult(result, { requireEnvelope = false } = {}) {
  if (requireEnvelope) {
    if (result?.schemaVersion !== COMMAND_RESULT_SCHEMA_VERSION) {
      invalid(`schemaVersion must be ${COMMAND_RESULT_SCHEMA_VERSION}`);
    }
    if (result?.resultType !== 'command-result') invalid("resultType must be 'command-result'");
  }
  const { operation, subject, outcome, effects: declared, why = [], next = [], restState = null, data = {} } = result ?? {};
  if (!String(operation?.id ?? '').trim()) invalid('operation.id is required');
  if (!['read', 'mutation'].includes(operation?.classification)) invalid('operation.classification must be read or mutation');
  if (subject !== null) {
    if (!SUBJECT_KINDS.has(subject?.kind)) invalid(`subject.kind '${subject?.kind}' must be one of ${[...SUBJECT_KINDS].join(', ')}`);
    if (!String(subject?.id ?? '').trim()) invalid('subject.id is required when subject is present');
  }
  if (!outcome || !STATUSES.has(outcome.status)) invalid(`outcome.status must be one of ${[...STATUSES].join(', ')}`);
  if (!ID_PATTERN.test(outcome.messageId ?? '')) invalid(`outcome.messageId '${outcome.messageId}' must be a dotted lower-case id`);
  if (!Object.hasOwn(MESSAGES, outcome.messageId)) invalid(`outcome.messageId '${outcome.messageId}' is not in the narration catalog`);
  if (outcome.slots !== undefined && (outcome.slots === null || Array.isArray(outcome.slots) || typeof outcome.slots !== 'object')) invalid('outcome.slots must be an object');
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

  if (!Array.isArray(why)) invalid('why must be an array');
  for (const entry of why) {
    if (!ID_PATTERN.test(entry?.code ?? '')) invalid(`why[].code '${entry?.code}' must be a dotted lower-case reason code`);
    if (!WHY_SOURCES.has(entry?.source)) invalid(`why[].source '${entry?.source}' must be one of ${[...WHY_SOURCES].join(', ')}`);
    if (!Object.hasOwn(REASONS, entry.code)) invalid(`why[].code '${entry.code}' is not in the reason catalog`);
    if ('detail' in (entry ?? {})) invalid(`why[] carries reason codes, not prose (${entry.code} supplied a detail)`);
  }

  if (!Array.isArray(next)) invalid('next must be an array');
  for (const entry of next) {
    if (!entry?.id || !entry?.label || !entry?.command) invalid('next[] entries need id, label and command');
    if (!NEXT_RANKS.has(entry.rank)) invalid(`next[].rank '${entry.rank}' must be one of ${[...NEXT_RANKS].join(', ')}`);
    if (!NEXT_KINDS.has(entry.kind)) invalid(`next[].kind '${entry.kind}' must be one of ${[...NEXT_KINDS].join(', ')}`);
    if (!MODEL_POLICIES.has(entry.modelPolicy)) invalid(`next[].modelPolicy '${entry.modelPolicy}' must be one of ${[...MODEL_POLICIES].join(', ')}`);
  }

  if (restState !== null && !REST_STATES.has(restState)) {
    invalid(`restState '${restState}' must be null or one of ${[...REST_STATES].join(', ')}`);
  }
  if (data === null || Array.isArray(data) || typeof data !== 'object') invalid('data must be an object');

  return result;
}

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
  const result = {
    operation,
    subject,
    outcome,
    effects: declared,
    why,
    next,
    restState,
    data
  };
  validateCommandResult(result);

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

/**
 * NCL-006, enforced where a result becomes final.
 *
 * Not at construction: continuation is resolved by the planner against post-command state, which by
 * definition is not known while the handler is still building its result. Checking it here means a
 * dead end is caught on the way out, which is the only moment the question can honestly be asked.
 */
export function assertContinuation(result) {
  if (!result.next.length && result.restState === null) {
    invalid(`${result.outcome.messageId} offers no next action and declares no rest state`);
  }
  return result;
}

/** True when a result reports that it left everything as it was. */
export function preservedEverything(result) {
  return Object.values(result.effects).every((value) => value === false);
}
