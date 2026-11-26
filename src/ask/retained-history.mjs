import YAML from 'yaml';
import { withoutGitProcessOverrides } from '../git-enterprise-environment.mjs';
import { normalizeLedgerConfig } from '../ledger-config.mjs';
import { canonicalJson, ledgerEntryFile, ledgerPayloadDigest, sha256 } from '../ledger.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { ledgerPage } from '../ledger-pages.mjs';
import { localConfigurationAtRef, parseSubjectStateRecord, safeRefRoot } from '../repository-subject-index.mjs';
import { sourceFileAt } from '../source-inspection.mjs';
import { storySummaryFromSubject } from '../story-state-index.mjs';
import { definitionLedgerConfig } from '../subject-identity-records.mjs';
import { ASK_PAGE_SIZE, coverage, historyFinding, pageRowCount, pageViewDigest } from './history-result.mjs';
import { storiesRoot } from '../story-paths.mjs';

const ENTRY_LIMIT = 1000;
const OWNER_READ_LIMIT = 64;
const MODES = ['history', 'activity-during', 'completed-during', 'currently-complete', 'as-of'];
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const text = value => typeof value === 'string' && value ? value.slice(0, 240) : null;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function workKind(entry) {
  const kind = entry.subject?.kind ?? entry.payload?.lifecycleEvent?.subject?.kind;
  if (kind != null) return kind === 'story' || kind === 'initiative' ? kind : null;
  // Older publications have the owner config path and the lifecycle event ID, rather than kind.
  if (!entry.payload?.lifecycleEventId) return null;
  if (entry.payload.configPath === 'singularity/workflow.yml') return 'story';
  if (entry.payload.configPath === 'singularity/portfolio.yml') return 'initiative';
  return null;
}

function workEvent(entry, kind) {
  const id = entry.subject?.workId;
  const commit = entry.transport?.publishedCommit;
  const eventAt = iso(entry.payload?.lifecycleEvent?.createdAt) ?? iso(entry.createdAt);
  if (!ID.test(id ?? '') || !OID.test(commit ?? '') || !eventAt) return null;
  const branch = text(entry.subject.branch);
  const summary = kind === 'story' ? storySummaryFromSubject(entry, id, branch, commit) : null;
  let entryPath = null;
  try { entryPath = ledgerEntryFile(entry.capabilityId, entry.hash); } catch { /* Legacy events may have no typed locator. */ }
  return {
    id, kind, branch, commit, title: summary?.title?.slice(0, 240) ?? text(entry.subject.title),
    status: summary?.status ?? null, phase: summary?.phase ?? null, event: entry.eventType,
    eventAt, recordedAt: iso(entry.transport?.recordedAt), eventId: text(entry.eventId), entryHash: entry.hash,
    entryPath,
    noncanonical: kind === 'story' && Boolean(entry.subject.canonicalBranch && entry.subject.canonicalBranch !== branch)
  };
}

/** Read just one owner record at a retained publication commit, even if its branch is gone. */
export function retainedSubjectAtCommit(root, { kind, id, commit, env = retainedEnvironment() }) {
  if (!['story', 'initiative'].includes(kind) || !ID.test(id) || !OID.test(commit)) {
    return { status: 'unavailable', reason: 'The retained work identity or commit is invalid.' };
  }
  const story = kind === 'story';
  const definition = localConfigurationAtRef(root, commit, story ? 'singularity/workflow.yml' : 'singularity/portfolio.yml', env);
  if (definition.status === 'unavailable') return definition;
  try {
    const declared = definition.content ? YAML.parse(definition.content) : null;
    const stateRoot = story ? safeRefRoot(declared?.workItemRoot, storiesRoot())
      : safeRefRoot(declared?.initiativeRoot, 'singularity/initiatives');
    const relative = [stateRoot, id, story ? 'workflow.json' : 'state.json'].join('/');
    const observed = sourceFileAt(root, commit, relative, { env, offline: true, maxBytes: 4 * 1024 * 1024 });
    const entry = observed.status === 'present'
      ? parseSubjectStateRecord(relative, observed.value, { source: 'ref', ref: commit, commit, directory: id }) : null;
    if (entry?.kind !== kind || entry.id !== id) {
      return { status: 'unavailable', reason: 'The retained owner record is unavailable or does not match its work identity.', path: relative };
    }
    return { status: 'present', entry };
  } catch (error) {
    return { status: 'unavailable', reason: error.message };
  }
}

function retainedEnvironment() {
  return { ...withoutGitProcessOverrides(process.env), GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0' };
}

function workStateReader(root, addGap) {
  const checked = new Map();
  const until = performance.now() + 7_000;
  const env = retainedEnvironment();
  return event => {
    if (event.status || event.noncanonical) return event;
    const key = [event.kind, event.id, event.commit].join(':');
    if (checked.has(key)) return { ...event, ...checked.get(key) };
    if (checked.size >= OWNER_READ_LIMIT || performance.now() >= until) {
      addGap('ASK_WORK_RECORDS_LIMITED', 'Some retained work states exceeded this read’s local record budget. Ask for one work ID to narrow the read.');
      return event;
    }
    const found = retainedSubjectAtCommit(root, { ...event, env });
    let state = null;
    if (found.status === 'present') {
      const record = found.entry.state;
      const work = event.kind === 'story' ? record.workItem : record.initiative;
      state = {
        title: text(work.title) ?? event.title, status: text(record.status),
        phase: text(record.currentPhase), recordPath: found.entry.location.path,
        noncanonical: event.kind === 'story' && Boolean(event.branch && event.branch !== found.entry.canonicalBranch)
      };
      if (!state.status) addGap('ASK_WORK_RECORD_UNAVAILABLE', 'One or more retained work states did not record a status.');
    } else {
      addGap('ASK_WORK_RECORD_UNAVAILABLE', 'One or more exact work records referenced by the ledger are unavailable locally.');
    }
    checked.set(key, state);
    return { ...event, ...state };
  };
}

const finished = row => row.kind === 'story' ? row.status === 'closed' : row.status === 'complete';
const within = (at, window) => at >= window.startInclusive && at < window.endExclusive;
const publicEvent = ({ noncanonical: _noncanonical, ...event }) => event;

function matchingRows(events, intent, window, state, addGap) {
  if (intent.mode === 'history') return events.map(publicEvent);
  const subjects = new Map();
  for (const event of events) {
    const key = [event.kind, event.id].join(':');
    if (!subjects.has(key)) subjects.set(key, []);
    subjects.get(key).push(event);
  }
  const rows = [];
  for (const records of subjects.values()) {
    if (intent.mode === 'activity-during') {
      const activity = records.filter(event => within(event.eventAt, window));
      if (activity.length) rows.push({ ...publicEvent(activity[0]), activityCount: activity.length });
      continue;
    }
    const canonical = records.filter(event => !event.noncanonical);
    if (intent.mode === 'currently-complete') {
      for (const event of canonical) {
        const row = state(event);
        if (row.noncanonical) continue;
        if (finished(row)) rows.push(publicEvent(row));
        break;
      }
      continue;
    }
    // Ledger order is authoritative for transitions. Dates that conflict with that order cannot
    // establish what the owner’s state was at an intervening instant.
    if (canonical.some((event, index) => index > 0 && event.eventAt > canonical[index - 1].eventAt)) {
      addGap('ASK_WORK_EVENT_ORDER_UNCERTAIN', 'Retained event timestamps for some work do not agree with the ledger’s order.');
      continue;
    }
    if (intent.mode === 'as-of') {
      for (const event of canonical) {
        if (event.eventAt >= window.endExclusive) continue;
        const row = state(event);
        if (row.noncanonical) continue;
        if (row.status) rows.push(publicEvent(row));
        break;
      }
      continue;
    }
    for (let index = 0; index < canonical.length; index += 1) {
      const event = canonical[index];
      if (!within(event.eventAt, window)) continue;
      const row = state(event);
      if (row.noncanonical || !finished(row)) continue;
      let previous;
      for (const before of canonical.slice(index + 1)) {
        const candidate = state(before);
        if (!candidate.noncanonical) { previous = candidate; break; }
      }
      if (!previous?.status) {
        addGap('ASK_COMPLETION_BASELINE_UNAVAILABLE', 'At least one retained complete state lacks a preceding state to establish its completion date.');
      } else if (!finished(previous)) {
        rows.push({ ...publicEvent(row), completedAt: row.eventAt });
        break;
      }
    }
  }
  if (intent.mode === 'as-of' && !rows.length) {
    addGap('ASK_AS_OF_BASELINE_UNAVAILABLE', 'The retained ledger does not establish this work’s state by the requested date.');
  }
  return rows.sort((a, b) => b.eventAt.localeCompare(a.eventAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

export async function retainedHistory(root, intent, window, cursor, audience) {
  const config = normalizeLedgerConfig(await definitionLedgerConfig(root));
  const namespace = config.remote + '/' + config.branch;
  const eventList = intent.mode === 'history';
  const unit = eventList ? 'events' : 'work-items';
  const diagnostics = [];
  const addGap = (code, message) => {
    if (!diagnostics.some(entry => entry.code === code)) diagnostics.push(historyFinding(code, message));
  };
  let snapshot = cursor?.snapshot ?? null;
  const retrieved = cursor?.retrieved ?? 0;
  const ledgerContinuation = cursor?.ledgerContinuation ?? null;
  const answer = (rows = [], next = null, available = true) => ({
    history: {
      provider: 'sflow-state-ledger', mode: intent.mode, availableModes: MODES, scope: { namespace, snapshot, workKind: intent.workKind, workId: intent.workId ?? null },
      basis: 'retained-lifecycle-event-time', observation: 'local-snapshot', window, rows
    },
    coverage: coverage(unit, retrieved + rows.length, diagnostics, next, available),
    diagnostics, next,
    start: snapshot ? { ...cursor, snapshot, namespace } : null
  });
  if (!config.enabled) {
    addGap('ASK_WORK_HISTORY_DISABLED', 'The repository has no enabled Story and Initiative ledger to answer this history query.');
    return answer([], null, false);
  }
  if (cursor && cursor.namespace !== namespace) {
    addGap('ASK_WORK_HISTORY_SCOPE_CHANGED', 'The configured state ledger changed. Start the history query again in the selected checkout.');
    return answer([], null, false);
  }
  let page;
  try {
    page = await ledgerPage(root, config, {
      ...(ledgerContinuation ? { continuation: ledgerContinuation } : { snapshot }),
      limit: ENTRY_LIMIT, stopAtDamage: true, offline: true
    });
  } catch (error) {
    addGap(error.code ?? 'ASK_WORK_HISTORY_UNAVAILABLE', error.message);
    return answer([], cursor ? { ...cursor, retry: true } : null, retrieved > 0);
  }
  snapshot = page.snapshot;
  if (!snapshot) {
    addGap('ASK_WORK_HISTORY_SNAPSHOT_UNAVAILABLE', 'No local snapshot of the configured state ledger is available.');
    return answer([], null, false);
  }
  if (page.damaged || (!eventList && !page.complete)) {
    addGap(page.damaged?.code ?? 'ASK_WORK_HISTORY_CAPPED', page.damaged?.message ??
      'This read reached the retained ledger’s 1,000-event scan limit. Older records have not been inspected.');
  }
  const events = [];
  for (const entry of page.entries) {
    const kind = workKind(entry);
    if (!kind || (intent.workKind && intent.workKind !== kind) ||
        (intent.workId && intent.workId.toLowerCase() !== entry.subject?.workId?.toLowerCase?.())) continue;
    const event = workEvent(entry, kind);
    if (event) events.push(event);
    else addGap('ASK_WORK_EVENT_UNAVAILABLE', 'Some retained work events lack an exact commit, work ID, or event timestamp.');
  }
  const rows = matchingRows(events, intent, window, workStateReader(root, addGap), addGap);
  const offset = cursor?.offset ?? 0;
  const view = pageViewDigest(rows, diagnostics);
  if (cursor?.view && cursor.view !== view) {
    addGap('ASK_WORK_HISTORY_VIEW_CHANGED', 'Local availability of the retained records changed. Start the history query again.');
    return answer([], null, false);
  }
  const available = rows.slice(offset, offset + ASK_PAGE_SIZE);
  const selected = available.slice(0, pageRowCount(available, audience));
  const nextOffset = offset + selected.length;
  const progress = { snapshot, namespace, retrieved: retrieved + selected.length };
  let next = null;
  if (nextOffset < rows.length) {
    next = { ...progress, ledgerContinuation, offset: nextOffset, view };
  } else if (eventList && page.continuation) {
    next = { ...progress, ledgerContinuation: page.continuation };
  }
  return answer(selected, next, (!page.damaged || retrieved > 0 || page.entries.length > 0) &&
    (intent.mode !== 'as-of' || rows.length > 0));
}

/** Verify a previously issued event locator directly in the exact retained state tree. */
export async function retainedEventAtSnapshot(root, ref) {
  const config = normalizeLedgerConfig(await definitionLedgerConfig(root));
  if (!config.enabled || ref.namespace !== config.remote + '/' + config.branch || !OID.test(ref.snapshot) ||
      !/^[a-f0-9]{64}$/u.test(ref.entryHash) || !/^ledger\/entries\/[a-z0-9._-]+\/[a-f0-9]{64}\.json$/u.test(ref.path)) return null;
  const observed = sourceFileAt(root, ref.snapshot, ref.path, {
    env: retainedEnvironment(), offline: true, maxBytes: 1024 * 1024
  });
  if (observed.status !== 'present') return null;
  const { record } = readRecord('ledger-entry', observed.value);
  if (sha256(canonicalJson(record)) !== ref.entryHash ||
      (record.payloadDigest !== undefined && ledgerPayloadDigest(record) !== record.payloadDigest) ||
      ledgerEntryFile(record.capabilityId, ref.entryHash) !== ref.path || workKind(record) !== ref.workKind ||
      record.subject?.workId !== ref.workId || record.transport?.publishedCommit !== ref.commit) return null;
  const event = workEvent({ ...record, hash: ref.entryHash }, ref.workKind);
  return event ? publicEvent(event) : null;
}
