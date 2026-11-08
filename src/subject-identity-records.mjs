/**
 * Epic and Initiative identities as the state ledger records them (SDA §5, SDA-AC-024).
 *
 * Allocation, Initiative resume, the Initiative list and goals read these records, never an
 * inventory of application branches. Every Initiative lifecycle publication and every local Epic
 * reservation appends a ledger entry naming its subject and the branch it is bound to; the newest
 * entry for an ID is its record. With the ledger off there is no authority record: `records` is
 * null and a caller that still scans branches says so (`IDENTITY_SOURCE.LEDGER_OFF`).
 */
import { configurationReadDefinition } from './configuration-read-scope.mjs';
import { readConfigurationSource } from './configuration-source.mjs';
import { LEDGER_PAGE_MAX, LEDGER_VERIFY_COMMAND, ledgerEntriesBeyondChain, ledgerPage } from './ledger-pages.mjs';
import { normalizeLedgerConfig } from "./kernel/configuration-declarations.mjs";
import { SingularityFlowError } from './util.mjs';

export const IDENTITY_SOURCE = Object.freeze({
  LEDGER: 'ledger-records',
  LEDGER_OFF: 'branch-scan-ledger-off'
});
/** The lifecycle payload operation a local Epic reservation records. */
export const EPIC_RESERVATION_OPERATION = 'reserve-local-epic-identity';

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function subjectKind(entry) {
  return entry?.subject?.kind ?? entry?.payload?.lifecycleEvent?.subject?.kind ?? null;
}

function operationOf(entry) {
  return text(entry?.payload?.lifecyclePayload?.operation ?? entry?.payload?.operation
    ?? entry?.payload?.lifecycleEvent?.payload?.operation);
}

/**
 * The `ledger` block the workflow definition declares, or `{}` (ledger off) when the repository has
 * no workflow definition. Read from the request's configuration source, not a full definition load:
 * a list surface must not pay for agent discovery to learn one switch. Unreadable YAML refuses.
 */
export async function definitionLedgerConfig(root) {
  const compiled = await configurationReadDefinition(root);
  if (compiled) return compiled.ledger ?? {};
  const source = await readConfigurationSource(root);
  if (!source.workflow?.exists) return {};
  if (source.error) throw source.error;
  return source.parsed?.ledger ?? {};
}

const entryId = (entry) => text(entry?.subject?.workId ?? entry?.payload?.lifecycleEvent?.subject?.id);

/**
 * Every Epic and Initiative identity the reachable ledger chain records, newest binding per ID.
 * `offline` keeps to the state ref already held here; otherwise the usual state refresh runs first.
 *
 * A missing or corrupt entry ends the chain there: one bad entry anywhere blocked every Initiative
 * list, resume, goal and local Epic ID (sweep B3). `records` then holds what the chain held before
 * it and `unreadable` names it and `ledger verify`; a reader serves what it can and says so.
 */
export async function initiativeIdentityRecords(root, rawConfig, { offline = true } = {}) {
  const config = normalizeLedgerConfig(rawConfig ?? {});
  if (!config.enabled) {
    return Object.freeze({ source: IDENTITY_SOURCE.LEDGER_OFF, snapshot: null, records: null });
  }
  const records = new Map();
  let snapshot = null;
  let continuation = null;
  let unreadable = null;
  do {
    const page = await ledgerPage(root, config, { limit: LEDGER_PAGE_MAX, continuation, offline, stopAtDamage: true });
    snapshot ??= page.snapshot;
    if (page.damaged) unreadable = page.damaged;
    for (const entry of page.entries) {
      if (subjectKind(entry) !== 'initiative') continue;
      const id = entryId(entry);
      if (!id) continue;
      const operation = operationOf(entry);
      const existing = records.get(id);
      if (existing) {
        if (operation === EPIC_RESERVATION_OPERATION) existing.reservedAs = 'epic';
        continue;
      }
      const branch = text(entry.subject?.branch ?? entry.payload?.lifecycleEvent?.subject?.branch) ?? id;
      records.set(id, {
        id, kind: 'initiative', branch,
        aliases: branch === id ? [] : [branch],
        profile: text(entry.subject?.profile),
        reservedAs: operation === EPIC_RESERVATION_OPERATION ? 'epic' : null,
        recordedAt: text(entry.transport?.recordedAt) ?? text(entry.createdAt),
        event: Object.freeze({
          eventId: entry.eventId ?? null, eventType: entry.eventType ?? null, entryHash: entry.hash,
          operation, publishedCommit: entry.transport?.publishedCommit ?? null
        })
      });
    }
    continuation = page.continuation;
  } while (continuation);
  return Object.freeze({
    source: IDENTITY_SOURCE.LEDGER, snapshot, offline,
    records: Object.freeze([...records.values()].sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => Object.freeze({ ...record, aliases: Object.freeze(record.aliases) }))),
    ...(unreadable ? { unreadable: Object.freeze({ ...unreadable,
      message: `Initiatives recorded before ledger entry ${unreadable.entryHash ?? '(the head)'} could not be read: ${unreadable.message}` }) } : {})
  });
}

/** The refusal for an identity question the readable part of the ledger cannot answer. */
function ledgerUnreadableRefusal(identities, question) {
  const { unreadable, snapshot } = identities;
  return new SingularityFlowError(`${question} The state ledger cannot be read past entry ${unreadable.entryHash ?? '(its head)'}: ${unreadable.message}`, {
    code: 'LEDGER_CHAIN_INVALID',
    details: { snapshot, entryHash: unreadable.entryHash, nextAction: LEDGER_VERIFY_COMMAND }
  });
}

/**
 * Every Epic and Initiative ID an allocation must not reuse, from the ledger chain and, past a
 * damaged entry, from every other entry file of the same snapshot (sweep B3). Refuses, naming
 * `ledger verify`, only when an entry is missing or unparseable, so uniqueness cannot be proven.
 */
export function initiativeIdsTaken(root, identities) {
  const ids = (identities.records ?? []).map((record) => record.id);
  if (!identities.unreadable) return ids;
  const beyond = identities.snapshot ? ledgerEntriesBeyondChain(root, identities.snapshot) : { entries: [], complete: false };
  if (!beyond.complete) {
    throw ledgerUnreadableRefusal(identities, 'A new Epic ID cannot be proven unused: a ledger entry is missing or unreadable, so an ID recorded there would be invisible.');
  }
  return [...new Set([...ids, ...beyond.entries.filter((entry) => subjectKind(entry) === 'initiative').map(entryId).filter(Boolean)])];
}

/**
 * The one record an ID or recorded alias names. A reference the records do not know refuses: a
 * branch that merely looks like an Initiative is never adopted as one.
 */
export function resolveInitiativeIdentity(identities, reference) {
  const requested = String(reference ?? '').trim();
  const matches = (identities?.records ?? []).filter((record) => record.id === requested
    || record.aliases.includes(requested));
  if (matches.length > 1) {
    const candidates = matches.map((record) => record.id);
    throw new SingularityFlowError(
      `Initiative reference '${requested}' names more than one recorded identity: ${candidates.join(', ')}. `
      + `Name the one you mean by its ID, for example: singularity-flow initiative resume ${candidates[0]}`,
      { code: 'INITIATIVE_IDENTITY_AMBIGUOUS', details: { reference: requested, candidates,
        nextAction: `singularity-flow initiative resume ${candidates[0]}` } }
    );
  }
  if (!matches.length) {
    // Past a damaged entry the records are incomplete: "not recorded" would be a guess.
    if (identities?.unreadable) throw ledgerUnreadableRefusal(identities, `Initiative '${requested}' is not among the identities the readable part of the state ledger records.`);
    // The usual cause is an Initiative started on another computer whose record this checkout has
    // not fetched yet; an offline read names the fetch first (A9).
    const fetch = identities?.offline !== false ? `singularity-flow initiative resume ${requested} --fetch` : null;
    throw new SingularityFlowError(
      `No Initiative identity '${requested}' is recorded in the state ledger${fetch ? ' this checkout has read' : ''}. A branch is not an identity. `
      + (fetch ? `If it was started on another computer, fetch its record first: ${fetch}. Otherwise check the ID, or run`
        : 'Check the ID, or run')
      + " 'singularity-flow ledger reconcile' if its start was never recorded.",
      { code: 'INITIATIVE_IDENTITY_UNRECORDED', details: { reference: requested, identitySource: IDENTITY_SOURCE.LEDGER,
        nextAction: fetch ?? 'singularity-flow ledger reconcile' } }
    );
  }
  return matches[0];
}

/**
 * The recorded identity a reference names, or this checkout's own Initiative: one whose state is in
 * the working tree on its canonical branch, checked out now, is local authored state and needs no
 * branch inventory to be found. Anything else the records do not know still refuses.
 */
export async function resolveInitiativeReference(root, identities, reference, {
  definition = {}, portfolio = null, currentBranch = null
} = {}) {
  try { return resolveInitiativeIdentity(identities, reference); } catch (error) {
    const unanswered = error?.code === 'INITIATIVE_IDENTITY_UNRECORDED' || (error?.code === 'LEDGER_CHAIN_INVALID' && identities?.unreadable);
    if (!unanswered || !currentBranch) throw error;
    const { buildRepositorySubjectIndex, resolveContext } = await import('./repository-subject-index.mjs');
    const own = resolveContext(await buildRepositorySubjectIndex(root, { definition, portfolio }), {
      reference, kind: 'initiative', required: false
    });
    if (!own || own.canonicalBranch !== currentBranch) throw error;
    return Object.freeze({ id: own.id, kind: 'initiative', branch: own.canonicalBranch, aliases: Object.freeze([]), recorded: false });
  }
}
