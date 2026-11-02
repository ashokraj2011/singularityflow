/**
 * SF Guard M2 (SPEC-PSS-v1 REQ-003, REQ-030, REQ-040 to REQ-042): presence-signed approve and reject.
 *
 * A Story pins SF Guard's policy when it starts (`resolution.presence`), so a later change never
 * affects it. On a Story whose pin is `required`, approve and reject take the approver's presence
 * signature (their card in their own terminal, then one Touch ID touch) before anything is written,
 * and every place that counts approvals counts only a record whose signature verifies against the
 * approver's pinned key, or one an active per-person exception covers (labelled as a bypass). So an
 * approval an agent writes with plain Git, or one that reuses another record's signature, counts
 * for nothing.
 *
 * The signature covers a digest of the record's own decision fields (`boundDecisionSha256`), so no
 * field of a signed record can change without the signature failing. Verification reads only the
 * keys pinned in the approved configuration's policy chain, never GitHub, and a Story without a pin,
 * or pinned `off`, behaves exactly as before: its records count, labelled `pre-signing` once the
 * repository has opted in.
 *
 * Counting is synchronous: `loadPresenceContext` reads and folds the chain once per command, and
 * `presenceCounts` gives the readers a predicate. On a `required` Story whose chain was not read the
 * predicate counts nothing, so a reader that forgot to read it can never count a forged record.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { activeException, approverId, exceptionLabel, foldPresenceChain, presenceEventDigest } from './chain.mjs';
import { forgetPersonCounts, presencePinKey, registerPersonCounts } from './counted.mjs';
import { presenceNonce, presenceStatement, statementText } from './statement.mjs';
import { verifyPresenceSignature } from './sshsig.mjs';

export const PRESENCE_PIN_SCHEMA = 'sflow-presence-pin@1';
export const PRESENCE_RECORD_SCHEMA = 'sflow-presence-record@1';
// The decision fields a presence signature binds: everything the person decided over, known when the
// record is made. Fields added later by the engine (invalidation, resolved change requests) are not
// the person's decision and stay outside it.
const BOUND_FIELDS = Object.freeze([
  'decision', 'phase', 'at', 'actor', 'agent', 'authorityGroup', 'identityAssurance', 'channel', 'generation',
  'artifactSha256', 'artifactSet', 'bundleSha256', 'reviewPacketSha256', 'qualityRisks', 'skillEvidenceSha256',
  'evidenceCommit', 'rejectedIntentAmendments', 'artifactSetSha256', 'architectureIntent', 'architectureDecision',
  'reviewEvidenceCommit', 'checklist', 'checklistSha256', 'implementationBindings', 'witnessMappings',
  'witnessMappingsSha256', 'actionContext', 'upstream', 'selfApproval',
  'target', 'reason', 'changeRequestId', 'clauseIds', 'members', 'repairBudget'
]);
// Copilot's hosts (the CLI, and VS Code's agent host) set these in an agent's shell. They are a
// courtesy, never the boundary: they let an agent's run refuse with the person's command instead of
// showing a Touch ID prompt the person did not start. Any other process needs the person's terminal,
// and a process that unsets them still needs the person's touch.
const AGENT_MARKERS = Object.freeze(['COPILOT_CLI', 'AI_AGENT']);
const ACTIONS = Object.freeze({ approved: 'phase.approve', rejected: 'phase.reject' });

const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

/** The digest of a record's own decision fields: what its presence signature covers. */
export function boundDecisionSha256(record) {
  const bound = {};
  for (const field of BOUND_FIELDS) if (record?.[field] !== undefined) bound[field] = record[field];
  return sha256(canonicalJson(bound));
}

/**
 * The approver ID of `actor` in `authorities` (a Story's pinned approval authorities), or null. A
 * record may keep its actor as the identity object or as its key (`actorKey`: login, else email).
 */
export function actorApproverId(authorities, actor) {
  const key = typeof actor === 'string' ? actor.trim().toLowerCase() : '';
  const email = key ? (key.includes('@') ? key : '') : String(actor?.email ?? '').trim().toLowerCase();
  const login = key ? (key.includes('@') ? '' : key) : String(actor?.login ?? '').trim().toLowerCase();
  if (!email && !login) return null;
  for (const authority of Object.values(authorities ?? {})) {
    for (const member of authority?.members ?? []) {
      const memberEmail = String(member?.email ?? '').trim().toLowerCase();
      const memberLogin = String(member?.githubLogin ?? member?.login ?? '').trim().toLowerCase();
      if ((email && memberEmail === email) || (login && memberLogin === login)) return approverId(member);
    }
  }
  return null;
}

/** The statement a person record's presence signature covers, rebuilt from the record itself. */
export function recordStatement(record, presence, { chainId, workId }) {
  return presenceStatement({
    repository: `presence:${chainId}`, subject: { kind: 'story', id: workId },
    step: record.phase ?? null, generation: Number.isInteger(record.generation) ? record.generation : null,
    action: ACTIONS[record.decision] ?? `phase.${record.decision}`,
    decision: { decision: record.decision, recordSha256: boundDecisionSha256(record) },
    reviewed: { reviewPacketSha256: record.reviewPacketSha256 ?? null },
    actor: { approver: presence.approver }, authorityGroup: record.authorityGroup ?? null,
    at: presence.at, nonce: presence.nonce, keyId: presence.keyId
  });
}

/**
 * The digest of one of a Story's other person records (SF Guard M3): the fields it had when it was
 * signed, named in the digest, so a field added later (a withdrawal) never breaks it and one changed
 * or removed always does.
 */
export function personRecordDigest(record, fields) {
  const values = {};
  for (const field of fields) if (record?.[field] !== undefined) values[field] = record[field];
  return sha256(canonicalJson({ fields, values }));
}

/**
 * The statement one touch signs for every person record a command wrote (SF Guard M3): the records'
 * digests, sorted, so each record verifies on its own against the one signature.
 */
export function personBatchStatement(presence, { chainId, workId }) {
  return presenceStatement({
    repository: `presence:${chainId}`, subject: { kind: 'story', id: workId }, step: null, generation: null,
    action: presence.action, decision: { records: presence.batch }, reviewed: {},
    actor: { approver: presence.approver }, authorityGroup: null, at: presence.at, nonce: presence.nonce, keyId: presence.keyId
  });
}

/**
 * The Story pin for a Story starting now: SF Guard's state in the approved configuration, or null
 * when the repository never opted in (no policy file), so a Story there is exactly as before.
 */
export async function presencePinForStart(root) {
  const { readPresencePolicy } = await import('./store.mjs');
  const policy = await readPresencePolicy(root);
  if (!policy.present || !policy.chain) return null;
  const valid = policy.chain.events.slice(0, policy.folded.validLength);
  return {
    schema: PRESENCE_PIN_SCHEMA, status: policy.folded.enabled ? 'required' : 'off', chainId: policy.folded.chainId,
    events: valid.length, tip: valid.length ? presenceEventDigest(valid.at(-1)) : null
  };
}

const contexts = new Map();
const policies = new Map();

/**
 * How a Story's pin stands against the chain it names: `required` when the pin says so, or when a pin
 * that says `off` does not match the chain (a forged or rewritten pin never turns SF Guard off).
 */
export function pinRequirement(pin, chain) {
  if (!pin) return { required: false, reason: 'no-pin' };
  if (pin.schema !== PRESENCE_PIN_SCHEMA || !['required', 'off'].includes(pin.status)) return { required: true, reason: 'pin-invalid' };
  if (pin.status === 'required') return { required: true, reason: 'pinned-required' };
  if (!chain || chain.chainId !== pin.chainId || !Number.isInteger(pin.events) || pin.events < 0 || pin.events > chain.events.length) {
    return { required: Boolean(chain && chain.chainId === pin.chainId), reason: 'pin-not-in-chain' };
  }
  const prefix = { ...chain, events: chain.events.slice(0, pin.events) };
  const tip = pin.events ? presenceEventDigest(prefix.events.at(-1)) : null;
  if (tip !== pin.tip) return { required: true, reason: 'pin-not-in-chain' };
  return { required: false, reason: 'pinned-off', prefix };
}

/**
 * Read and fold the policy chain a Story's pin names, once per command and repository. Returns the
 * Story's context: whether its pin requires presence is the Story's own, so two Stories on one chain
 * (one pinned `off`, one `required`) never read each other's.
 */
export async function loadPresenceContext(root, workflow, { verify } = {}) {
  const pin = workflow?.resolution?.presence ?? null;
  const cached = contexts.get(pinKey(workflow));
  if (cached) return cached;
  let policy = null;
  let unreadable = null;
  // A repository that never opted in has no policy file: nothing is read, and nothing changes.
  if (pin || await policyFilePresent(root)) {
    const read = policies.get(root) ?? (async () => {
      const { readPresencePolicy } = await import('./store.mjs');
      return readPresencePolicy(root, { verify }).then((value) => ({ value }), (error) => ({ error: error?.message ?? String(error) }));
    })();
    policies.set(root, read);
    const outcome = await read;
    policy = outcome.value ?? null;
    unreadable = outcome.error ?? null;
  }
  const chain = policy?.chain ?? null;
  const folded = policy ? policy.folded : foldPresenceChain(null);
  const requirement = pinRequirement(pin, chain && chain.chainId === pin?.chainId ? { ...chain, events: chain.events.slice(0, folded.validLength) } : chain);
  if (requirement.required === false && requirement.reason === 'pinned-off' && requirement.prefix) {
    // A pin that says `off` must fold to `off` at the event it names.
    const at = foldPresenceChain(requirement.prefix, verify ? { verify } : {});
    if (at.enabled) Object.assign(requirement, { required: true, reason: 'pin-not-in-chain' });
  }
  const context = { pin, chainId: chain?.chainId ?? pin?.chainId ?? null, chain, folded, required: requirement.required,
    reason: requirement.reason, optedIn: Boolean(folded.enabled), unreadable, verify: verify ?? verifyPresenceSignature };
  contexts.set(pinKey(workflow), context);
  // The Story's synchronous readers count its other person records through this (counted.mjs).
  const verdicts = new WeakMap();
  const counts = context.required ? (record) => {
    if (!record || typeof record !== 'object') return false;
    if (!verdicts.has(record)) verdicts.set(record, personRecordVerdict(context, record, { workflow }).counts);
    return verdicts.get(record);
  } : null;
  // An authorship claim (`--authored human|external-tool`) is believed only when its author signed it.
  if (counts) counts.claim = (authorship, where) => authorshipClaimVerdict(context, authorship, { workflow, ...where }).counts;
  registerPersonCounts(pinKey(workflow), counts);
  return context;
}

async function policyFilePresent(root) {
  const [{ existsSync }, path, { configurationReadRootForPath }, { PRESENCE_CHAIN_PATH }] = await Promise.all([
    import('node:fs'), import('node:path'), import('../configuration-read-scope.mjs'), import('./chain.mjs')]);
  try { return existsSync(path.join(configurationReadRootForPath(root, PRESENCE_CHAIN_PATH), PRESENCE_CHAIN_PATH)); }
  catch { return false; }
}

/** One Story's pin, as the key of its context: its Story and the pin itself. */
const pinKey = presencePinKey;

/** Forget every context and policy read in this process (a command that changed the chain, and tests). */
export function forgetPresenceContexts() {
  contexts.clear();
  policies.clear();
  forgetPersonCounts();
}

/** The context already read for `workflow`'s pin, or null. */
export function presenceContextOf(workflow) {
  return workflow?.resolution?.presence ? contexts.get(pinKey(workflow)) ?? null : null;
}

/** Every key the chain ever pinned for an approver, with the event that retired it, if any. */
function keyHistory(context) {
  const history = new Map();
  const events = context.chain?.events?.slice(0, context.folded.validLength) ?? [];
  for (const event of events) {
    if (['register', 'rotate', 'recover'].includes(event.kind)) {
      for (const entry of history.values()) {
        if (entry.approver === event.approver && entry.retiredAt == null && entry.keyId !== event.keyId) entry.retiredAt = event.at;
      }
      history.set(event.keyId, { approver: event.approver, keyId: event.keyId, key: event.key, since: event.at, retiredAt: null });
    } else if (event.kind === 'revoke') {
      const entry = history.get(event.keyId);
      if (entry && entry.retiredAt == null) entry.retiredAt = event.at;
    }
  }
  return history;
}

/** The exception `id` for `approver` that held when `at` was recorded, or null. */
function exceptionAt(context, id, approver, at) {
  const entry = context.folded.exceptions.get(id);
  if (!entry || entry.approver !== approver) return null;
  if (entry.active) return entry;
  const revoke = (context.chain?.events ?? []).find((event) => event.kind === 'exception-revoke' && event.exceptionId === id);
  return revoke && Date.parse(at) < Date.parse(revoke.at) ? entry : null;
}

/**
 * How one person record stands under SF Guard: `{ counts, state, label, code, reason, signer }`.
 * `state` is `not-required`, `pre-signing`, `signed`, `bypass` or `invalid`.
 */
export function personRecordVerdict(context, record, { workflow }) {
  if (!context?.required) {
    const state = context?.optedIn ? 'pre-signing' : 'not-required';
    return { counts: true, state, label: state === 'pre-signing' ? 'pre-signing: SF Guard was off when this Story started' : null, code: null, reason: null, signer: null };
  }
  const invalid = (code, reason) => ({ counts: false, state: 'invalid', label: `not counted: ${reason}`, code, reason, signer: null });
  const presence = record?.presence;
  if (!presence || typeof presence !== 'object') return invalid('PSS_RECORD_UNSIGNED', 'it carries no presence signature');
  if (presence.schema !== PRESENCE_RECORD_SCHEMA || presence.chainId !== context.chainId) return invalid('PSS_SIGNATURE_INVALID', 'its presence block names another policy chain');
  const approver = actorApproverId(workflow?.resolution?.approvalAuthorities, record.actor);
  if (!approver || approver !== presence.approver) return invalid('PSS_SIGNATURE_INVALID', 'its presence block names another approver');
  if (presence.bypass) {
    const exception = exceptionAt(context, presence.bypass, approver, presence.at ?? record.at);
    if (!exception) return invalid('PSS_RECORD_UNSIGNED', `exception ${presence.bypass} does not cover this approver`);
    return { counts: true, state: 'bypass', label: exceptionLabel(exception), code: null, reason: null, signer: approver };
  }
  const key = keyHistory(context).get(presence.keyId);
  if (!key || key.approver !== approver) return invalid('PSS_SIGNATURE_INVALID', `${presence.keyId ?? 'its key'} is not ${approver}'s pinned key`);
  if (key.retiredAt && !(Date.parse(presence.at) < Date.parse(key.retiredAt))) {
    return invalid('PSS_SIGNATURE_INVALID', `${presence.keyId} was retired before this record was signed`);
  }
  if (presence.batch !== undefined) {
    // One of a Story's other person records (M3): its digest is one the batch statement signs. Its own
    // identity assurance stays what the approval check found; the presence block is what reads as signed.
    const fields = presence.fields;
    if (!Array.isArray(fields) || !fields.every((field) => typeof field === 'string' && field !== 'presence')
        || !Array.isArray(presence.batch) || typeof presence.action !== 'string'
        || !presence.batch.includes(personRecordDigest(record, fields))) {
      return invalid('PSS_SIGNATURE_INVALID', 'its fields are not the ones its presence signature covers');
    }
    let batch;
    try { batch = personBatchStatement(presence, { chainId: context.chainId, workId: workflow?.workItem?.id }); }
    catch { return invalid('PSS_SIGNATURE_INVALID', 'its presence block is malformed'); }
    const checked = context.verify({ message: statementText(batch), armored: presence.signature, publicKey: key.key });
    if (!checked.valid) return invalid('PSS_SIGNATURE_INVALID', `the signature does not match this record (${checked.reason})`);
    return { counts: true, state: 'signed', label: `signed with ${presence.keyId}`, code: null, reason: null, signer: approver };
  }
  if (record.identityAssurance !== 'presence-signed') return invalid('PSS_SIGNATURE_INVALID', 'its identity assurance is not presence-signed');
  let statement;
  try { statement = recordStatement(record, presence, { chainId: context.chainId, workId: workflow?.workItem?.id }); }
  catch { return invalid('PSS_SIGNATURE_INVALID', 'its presence block is malformed'); }
  const verified = context.verify({ message: statementText(statement), armored: presence.signature, publicKey: key.key });
  if (!verified.valid) return invalid('PSS_SIGNATURE_INVALID', `the signature does not match this record (${verified.reason})`);
  return { counts: true, state: 'signed', label: `signed with ${presence.keyId}`, code: null, reason: null, signer: approver };
}

/** The producers that claim a person's or an external tool's work: believed only when signed. */
export const AUTHORSHIP_CLAIM_PRODUCERS = Object.freeze(['human', 'external-tool', 'legacy-unspecified']);

/**
 * The IDs a publication's actor may hold a presence key under: an approver's ID when the Story's
 * configuration lists them, and the email-based ID authors register with (SPEC-PSS-v1 §10.5).
 */
export function claimantIds(authorities, actor) {
  const email = String(actor?.email ?? '').trim().toLowerCase();
  return [...new Set([actorApproverId(authorities, actor), email.includes('@') ? approverId({ email }) : null].filter(Boolean))];
}

/** The claim an author's presence signature covers (SPEC-PSS-v1 §10.5). */
export function authorshipClaimStatement(presence, { chainId }) {
  const { claim } = presence;
  return presenceStatement({
    repository: `presence:${chainId}`, subject: { kind: 'story', id: claim.workId }, step: claim.phase, generation: claim.generation,
    action: presence.action, decision: { claimSha256: sha256(canonicalJson(claim)) }, reviewed: { artifactSha256: claim.artifactSha256 ?? null },
    actor: { approver: presence.approver }, authorityGroup: null, at: presence.at, nonce: presence.nonce, keyId: presence.keyId
  });
}

/**
 * How a generation's authorship claim stands under SF Guard: `{ counts, state, label }`. A claim that a
 * person or an external tool wrote it counts only when its author's presence signature covers this very
 * claim (producer, channel, Story, step, generation and artifact), or an exception covers its author;
 * otherwise the generation is read as the agent's, with every agent check (the user's rule: an unsigned
 * claim is not believed).
 */
export function authorshipClaimVerdict(context, authorship, { workflow, phase = null, generation = null } = {}) {
  const producer = authorship?.producer ?? 'legacy-unspecified';
  if (!context?.required || !AUTHORSHIP_CLAIM_PRODUCERS.includes(producer)) return { counts: true, state: 'not-a-claim', label: null };
  const unsigned = (reason) => ({ counts: false, state: 'unsigned', label: `read as the agent's: ${reason}` });
  const presence = authorship?.presence;
  if (!presence || typeof presence !== 'object' || !presence.claim || typeof presence.claim !== 'object') return unsigned('the authorship claim carries no presence signature');
  if (presence.schema !== PRESENCE_RECORD_SCHEMA || presence.chainId !== context.chainId) return unsigned('its presence block names another policy chain');
  const { claim } = presence;
  const ids = claimantIds(workflow?.resolution?.approvalAuthorities, authorship.actor);
  if (!ids.includes(presence.approver) || claim.producer !== producer || claim.channel !== (authorship.channel ?? null)
      || claim.workId !== workflow?.workItem?.id || (phase && claim.phase !== phase) || (Number.isInteger(generation) && claim.generation !== generation)
      || (claim.artifactSha256 && authorship.source?.sha256 && claim.artifactSha256 !== authorship.source.sha256)) {
    return unsigned('its presence signature covers another claim');
  }
  if (presence.bypass) {
    const exception = exceptionAt(context, presence.bypass, presence.approver, presence.at);
    return exception ? { counts: true, state: 'bypass', label: `bypass: per-person exception ${exception.id}` } : unsigned(`exception ${presence.bypass} does not cover its author`);
  }
  const key = keyHistory(context).get(presence.keyId);
  if (!key || key.approver !== presence.approver) return unsigned(`${presence.keyId ?? 'its key'} is not its author's pinned key`);
  if (key.retiredAt && !(Date.parse(presence.at) < Date.parse(key.retiredAt))) return unsigned(`${presence.keyId} was retired before the claim was signed`);
  let statement;
  try { statement = authorshipClaimStatement(presence, { chainId: context.chainId }); }
  catch { return unsigned('its presence block is malformed'); }
  const checked = context.verify({ message: statementText(statement), armored: presence.signature, publicKey: key.key });
  if (!checked.valid) return unsigned(`the signature does not match the claim (${checked.reason})`);
  return { counts: true, state: 'signed', label: `signed by its author with ${presence.keyId}` };
}

/**
 * The counting predicate for `workflow`'s person records: null when SF Guard does not apply (every
 * record counts, as before), else `(record) => boolean`. On a `required` Story whose chain this
 * process did not read, nothing counts.
 */
export function presenceCounts(workflow) {
  const pin = workflow?.resolution?.presence;
  if (!pin) return null;
  const context = presenceContextOf(workflow);
  if (!context) return pin.status === 'off' ? null : () => false;
  if (!context.required) return null;
  return (record) => personRecordVerdict(context, record, { workflow }).counts;
}

/** Read `workflow`'s policy chain (once per command) and return its counting predicate, or null. */
export async function presenceCountsFor(root, workflow) {
  if (!workflow?.resolution?.presence) return null;
  await loadPresenceContext(root, workflow);
  return presenceCounts(workflow);
}

/** Whether this process is a person at their own terminal, as far as it can tell. */
export function personTerminal({ env = process.env, stdin = process.stdin, stderr = process.stderr } = {}) {
  if (AGENT_MARKERS.some((name) => env[name])) return { person: false, reason: 'an agent started this command' };
  if (!stdin?.isTTY || !stderr?.isTTY) return { person: false, reason: 'this command has no terminal to show the card in' };
  return { person: true, reason: null };
}

function personCommand(action, workflow, phase) {
  return action === 'phase.approve'
    ? `singularity-flow approve ${phase.id} --work-id ${workflow.workItem.id}`
    : `singularity-flow reject ${phase.id} --work-id ${workflow.workItem.id} --reason "<why>"`;
}

/**
 * Before an approve or reject writes anything on a `required` Story: what the record will carry.
 * Returns null when SF Guard does not apply; `{ bypass }` under an active per-person exception;
 * else `{ sign(record) }`, which shows the card and takes the touch once the record exists. Every
 * refusal names a route the person can take today (REQ-042).
 */
export async function preparePersonPresence(root, { workflow, phase, actor, action, command: given = null }, dependencies = {}) {
  const context = await loadPresenceContext(root, workflow, { verify: dependencies.verify });
  if (!context.required) return null;
  const approver = actorApproverId(workflow.resolution?.approvalAuthorities, actor);
  const command = given ?? personCommand(action, workflow, phase);
  const verb = { 'phase.approve': 'approve', 'phase.reject': 'reject', 'phase.reopen': 'reopen' }[action] ?? 'decide';
  const routes = { command, others: `another approver can ${verb} it`,
    exception: approver ? `another approver can record a per-person exception: singularity-flow guard exception add ${approver}` : null };
  if (!approver) {
    fail(`SF Guard: this Story requires presence-signed person steps, and your identity is not an approver in its pinned configuration. ${routes.others}.`,
      'PSS_NOT_AN_APPROVER', { routes });
  }
  if (!context.chain) {
    fail(`SF Guard: this Story requires presence-signed person steps, and its policy (singularity/presence.json in the approved configuration) cannot be read here${context.unreadable ? `: ${context.unreadable}` : ''}. Nothing was written. Bring the configuration up to date (singularity-flow sync), then run the same command again; or ${routes.others}.`,
      'PSS_POLICY_UNREADABLE', { approver, routes });
  }
  const exception = activeException(context.folded, approver);
  if (exception) {
    return { context, approver, bypass: exception, presence: () => ({ schema: PRESENCE_RECORD_SCHEMA, chainId: context.chainId, approver,
      bypass: exception.id, at: new Date().toISOString() }) };
  }
  const pin = context.folded.pins.get(approver);
  if (!pin) {
    fail(`SF Guard: this Story requires your presence signature, and you have no presence key pinned. Register one in your own terminal (singularity-flow guard register), or ${routes.others}, or ${routes.exception}.`,
      'PSS_KEY_NOT_REGISTERED', { approver, routes });
  }
  // Checked before anything is shown or written, in this order: Windows, Linux and CI have no signer.
  const availability = (dependencies.signerAvailability ?? (await import('./signer.mjs')).signerAvailability)();
  if (!availability.available) {
    fail(`SF Guard cannot sign on this computer: ${availability.reason}. Nothing was written. Run this step on the Mac that holds your presence key (${pin.keyId}), or ${routes.others}, or ${routes.exception}.`,
      'PSS_SIGNER_UNAVAILABLE', { approver, keyId: pin.keyId, routes });
  }
  const terminal = (dependencies.personTerminal ?? personTerminal)();
  if (!terminal.person) {
    fail(`SF Guard: ${{ approve: 'approving', reject: 'rejecting', reopen: 'reopening' }[verb] ?? 'deciding'} this step needs your presence signature, taken in your own terminal (${terminal.reason}). Nothing was written. Run it there: ${command}`,
      'PSS_CARD_NOT_SHOWN', { approver, nextAction: { command, label: `Run in your own terminal: ${command}` }, routes });
  }
  const held = await (dependencies.holdsKey ?? holdsKey)(pin.keyId);
  if (!held) {
    fail(`SF Guard: this Mac does not hold your pinned presence key ${pin.keyId}. Run this step on the Mac that holds it, rotate to a key on this Mac (singularity-flow guard rotate --key <NEW-KEY-ID>), or ${routes.others}. If you never registered ${pin.keyId}, revoke it: singularity-flow guard revoke ${approver} --reason "not my key".`,
      'PSS_SIGNER_UNAVAILABLE', { approver, keyId: pin.keyId, routes });
  }
  const card = dependencies.card ?? (async (fields) => (await import('./signer.mjs')).presenceCard(fields));
  const sign = dependencies.sign ?? (async (request) => (await import('./signer.mjs')).signWithPresence(request));
  return {
    context, approver, keyId: pin.keyId,
    /** Sign `record` (its fields final): the card, then one touch. Returns its presence block. */
    async signRecord(record, { cardLines = [] } = {}) {
      const presence = { schema: PRESENCE_RECORD_SCHEMA, chainId: context.chainId, approver, keyId: pin.keyId,
        at: new Date().toISOString(), nonce: presenceNonce() };
      const statement = recordStatement(record, presence, { chainId: context.chainId, workId: workflow.workItem.id });
      const shown = await card({
        title: `${verb} ${workflow.workItem.id} / ${phase.id}`,
        lines: [`Step: ${phase.label ?? phase.id}, generation ${record.generation}`,
          `Decision: ${record.decision}${record.target ? ` (back to ${record.target})` : ''}`,
          `Review packet: ${record.reviewPacketSha256 ?? '(none)'}`,
          // SF Guard's labels for the work, sealed by that packet, read before the touch (SPEC-SFG-v1 AC-008).
          ...cardLines,
          `Record: ${statement.decision.recordSha256}`],
        keyId: pin.keyId
      });
      const signed = await sign({ statement, keyId: pin.keyId, publicKey: pin.key, card: shown });
      return { ...presence, signature: signed.signature, userVerification: Boolean(signed.userVerification) };
    }
  };
}

async function holdsKey(keyId) {
  const { ctkIdentities, presenceIdentityStanding } = await import('./local-keys.mjs');
  return presenceIdentityStanding(ctkIdentities(), keyId).ok;
}

/**
 * Attach the presence block a prepared step gives `record`: signed, or labelled as a bypass.
 * `cardLines` are shown on the card before the touch (the packet's SF Guard labels).
 */
export async function attachPersonPresence(prepared, record, { cardLines = [] } = {}) {
  if (!prepared) return record;
  if (prepared.bypass) {
    // Unsigned, and never read as signed: the exception travels with the record and labels it.
    record.presence = prepared.presence();
    return record;
  }
  record.identityAssurance = 'presence-signed';
  record.presence = await prepared.signRecord(record, { cardLines });
  return record;
}

/** The label a surface shows beside one person record, or null when SF Guard does not apply. */
export function personRecordLabel(workflow, record) {
  const context = presenceContextOf(workflow);
  if (!workflow?.resolution?.presence || !context) return null;
  return personRecordVerdict(context, record, { workflow }).label;
}
