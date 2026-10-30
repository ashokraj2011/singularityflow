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
import { LEDGER_PAGE_MAX, ledgerPage } from './ledger-pages.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
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

/**
 * Every Epic and Initiative identity the reachable ledger chain records, newest binding per ID.
 * `offline` keeps to the state ref already held here; otherwise the usual state refresh runs first.
 */
export async function initiativeIdentityRecords(root, rawConfig, { offline = true } = {}) {
  const config = normalizeLedgerConfig(rawConfig ?? {});
  if (!config.enabled) {
    return Object.freeze({ source: IDENTITY_SOURCE.LEDGER_OFF, snapshot: null, records: null });
  }
  const records = new Map();
  let snapshot = null;
  let continuation = null;
  do {
    const page = await ledgerPage(root, config, { limit: LEDGER_PAGE_MAX, continuation, offline });
    snapshot ??= page.snapshot;
    for (const entry of page.entries) {
      if (subjectKind(entry) !== 'initiative') continue;
      const id = text(entry.subject?.workId ?? entry.payload?.lifecycleEvent?.subject?.id);
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
    source: IDENTITY_SOURCE.LEDGER, snapshot,
    records: Object.freeze([...records.values()].sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => Object.freeze({ ...record, aliases: Object.freeze(record.aliases) })))
  });
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
    throw new SingularityFlowError(
      `Initiative reference '${requested}' names more than one recorded identity: ${matches.map((record) => record.id).join(', ')}.`,
      { code: 'INITIATIVE_IDENTITY_AMBIGUOUS', details: { reference: requested, candidates: matches.map((record) => record.id) } }
    );
  }
  if (!matches.length) {
    throw new SingularityFlowError(
      `No Initiative identity '${requested}' is recorded in the state ledger. A branch is not an identity. `
      + "Check the ID, or run 'singularity-flow ledger reconcile' if its start was never recorded.",
      { code: 'INITIATIVE_IDENTITY_UNRECORDED', details: { reference: requested, identitySource: IDENTITY_SOURCE.LEDGER } }
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
    if (error?.code !== 'INITIATIVE_IDENTITY_UNRECORDED' || !currentBranch) throw error;
    const { buildRepositorySubjectIndex, resolveContext } = await import('./repository-subject-index.mjs');
    const own = resolveContext(await buildRepositorySubjectIndex(root, { definition, portfolio }), {
      reference, kind: 'initiative', required: false
    });
    if (!own || own.canonicalBranch !== currentBranch) throw error;
    return Object.freeze({ id: own.id, kind: 'initiative', branch: own.canonicalBranch, aliases: Object.freeze([]), recorded: false });
  }
}
