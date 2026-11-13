/**
 * Copilot's own session logs, counted for Story reports. [owner, 2026-11-13]
 *
 * Copilot CLI, and VS Code's Copilot agent (it runs on the same embedded Copilot runtime), write
 * every session to `<Copilot home>/session-state/<session>/events.jsonl` with no setup: where the
 * session ran (its Git root and branch) and, for each model call, the model, the tokens, the cache
 * reads and writes, the premium-request cost and the AI units Copilot accounted for it. This module
 * follows those files for one repository and keeps, beside its Git directory, one content-free
 * record per model call: when, on which branch, which model, the token counts, premium requests and
 * AIU. Beside them it keeps one record per agent turn, tool call, sub-agent start, model change,
 * Auto model pick and error (see activityRecord). Nothing is committed, so a report shows this
 * computer's Copilot use only. No prompt, response, tool name, argument, result, error message or
 * path is kept; a session is kept only as a short hash of its id.
 *
 * Work never reads Copilot's logs (owner rule, 2026-10-16). Only `report`, `telemetry sessions`
 * (VS Code runs `telemetry sessions sync` in the background) and the snapshot behind Story Analytics
 * import this module, and the snapshot reads only the records written here, never Copilot's files.
 * test/copilot-session-usage.test.mjs holds that line.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sameCopilotModel } from './copilot-activity.mjs';
import { gitCommonDir } from './git-execution.mjs';
import { worktreeInventory } from './story-worktree.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { writeAtomic } from './util.mjs';

const FORMAT = 'sflow-copilot-session-usage/v1';
const LOCK_SUBJECT = Object.freeze({ kind: 'copilot-session-usage', id: 'shared' });
const READ_BYTES = 1024 * 1024;
const FIRST_LINE_BYTES = 64 * 1024;
const MAXIMUM_LINE_BYTES = 16 * 1024 * 1024;
// One sync reads at most this much of Copilot's logs; what is left is read by the next one. A first
// sync in a repository Copilot has worked in for months reads a few hundred megabytes once.
export const DEFAULT_SYNC_BYTES = 512 * 1024 * 1024;
// What a sync reads. Version 2 added the activity records: a cursor written by an earlier reader is
// read again from each session's start, so turns and tool calls before the upgrade are recorded too;
// the calls it finds again are already recorded and are not added twice. [owner, 2026-11-13]
const READER = 2;
// Only these events are parsed; every other line is skipped from the bytes of its type.
const ACTIVITY = new Set(['assistant.turn_start', 'tool.execution_complete', 'subagent.started', 'session.model_change', 'session.auto_mode_resolved', 'session.error']);
const EVENTS = new Set(['session.start', 'session.resume', 'session.context_changed', 'session.usage_record', 'session.usage_checkpoint', ...ACTIVITY]);
const TYPE_PREFIX = Buffer.from('{"type":"');
const INITIATORS = new Set(['user', 'agent', 'sub-agent']);
// A model id as Copilot writes them (`model-alpha-1.5`); anything else is kept as `unknown`.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;

/** Where Copilot keeps its sessions: the override tests use, else `<COPILOT_HOME or ~/.copilot>/session-state`. */
export function copilotSessionStateDirectory(env = process.env) {
  if (env.SINGULARITY_FLOW_COPILOT_SESSION_STATE) return path.resolve(env.SINGULARITY_FLOW_COPILOT_SESSION_STATE);
  const home = String(env.COPILOT_HOME ?? '').trim() || path.join(os.homedir(), '.copilot');
  return path.join(home, 'session-state');
}

const usageDirectory = (root) => path.join(gitCommonDir(root), 'singularity-flow', 'copilot-sessions');
const cursorFile = (root) => path.join(usageDirectory(root), 'cursor.json');
const hashed = (value, length) => createHash('sha256').update(String(value)).digest('hex').slice(0, length);
const branchFile = (root, branch) => path.join(usageDirectory(root), 'branches', `${hashed(branch, 24)}.json`);

async function readCache(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value?.format === FORMAT ? value : null;
  } catch { return null; }
}

const writeCache = (file, value) => writeAtomic(file, `${JSON.stringify({ format: FORMAT, ...value })}\n`, { mode: 0o600 });

const count = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const bounded = (value, limit = 128) => (typeof value === 'string' && value.length && value.length <= limit && !/[\r\n\0]/u.test(value) ? value : null);
const timestamp = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);

function canonical(value) {
  try { return realpathSync.native(value); } catch { return null; }
}

/**
 * Whether a session's Git root is this repository: its main checkout or one of its worktrees
 * (Story worktrees included), as `git worktree list` names them. Compared exactly, as written and
 * resolved, so a different repository nested inside a checkout is never taken for it.
 */
export function repositoryMatcher(root) {
  const roots = new Set();
  let listed = [];
  try { listed = worktreeInventory(root).map((entry) => entry.path); } catch { /* the checkout alone */ }
  for (const entry of [root, ...listed]) {
    roots.add(path.resolve(entry));
    const real = canonical(entry);
    if (real) roots.add(real);
  }
  const answers = new Map();
  return (gitRoot) => {
    if (typeof gitRoot !== 'string' || !gitRoot) return false;
    if (!answers.has(gitRoot)) {
      const real = canonical(gitRoot);
      answers.set(gitRoot, roots.has(path.resolve(gitRoot)) || Boolean(real && roots.has(real)));
    }
    return answers.get(gitRoot);
  };
}

/** A new session's state before any of its events. */
const freshSession = () => ({ ours: false, matched: false, branch: null, reason: 'no-start-event', perCall: false, checkpoint: null, calls: 0, events: 0, unattributed: 0 });

/**
 * Where the session works from now on. A context event still resolving its Git root
 * (`pendingGitContext`) is followed by the resolved one, so it changes nothing.
 */
function applyContext(state, context, belongs) {
  if (!context || typeof context !== 'object') return;
  const gitRoot = typeof context.gitRoot === 'string' ? context.gitRoot : null;
  state.ours = belongs(gitRoot);
  state.branch = state.ours ? bounded(context.branch, 256) : null;
  state.reason = state.ours ? null : gitRoot ? 'other-repository' : 'no-git-context';
  if (state.ours) state.matched = true;
}

/**
 * Premium requests are the `cost` of the calls a person started (`initiator: 'user'`); calls the
 * agent or a sub-agent made on its own carry a `cost` too, but Copilot does not bill them.
 * [owner, 2026-11-13] Checked read-only, numbers only, against Copilot's own running totals on one
 * developer computer: 217 sessions held both per-call records (7,089 calls: 818 person, 6,163 agent,
 * 121 sub-agent) and a `session.usage_checkpoint`. In all 217 the person-initiated sum equalled the
 * last checkpoint's `totalPremiumRequests` and its `accountingSnapshot.totalPremiumRequestCost`;
 * the sum over every call matched in 26 (sessions where only the person's calls ran), and person
 * plus sub-agent calls in 204. AIU is the other way round: every call's `copilotUsage.totalNanoAiu`
 * summed to the checkpoint's `totalNanoAiu` in 215 of 217 (the 2 others are higher by auxiliary model
 * calls that have no per-call record). So premium requests count person calls only, AIU every call.
 */
const modelName = (value) => (typeof value === 'string' && MODEL.test(value) ? value : 'unknown');

function callRecord(usage, event, sessionKey, offset) {
  const initiator = INITIATORS.has(usage.initiator) ? usage.initiator : 'other';
  const usageId = bounded(usage.accounting?.usageId, 256);
  const sequence = Number.isSafeInteger(usage.accounting?.sequence) ? usage.accounting.sequence : null;
  const model = modelName(usage.model);
  // The model that answered, kept only when it is not the one asked for (a dated build of it is the
  // same model): the session-log form of the substitution Copilot's spans show. [owner, 2026-11-13]
  const answered = typeof usage.responseModel === 'string' && MODEL.test(usage.responseModel) ? usage.responseModel : null;
  return {
    // Opaque: Copilot's accounting id, else the session and its sequence, else where the line sits.
    key: hashed(usageId ?? (sequence != null ? `${sessionKey}:${sequence}` : `${sessionKey}@${offset}`), 16),
    at: timestamp(event.timestamp),
    session: sessionKey,
    model,
    initiator,
    inputTokens: count(usage.inputTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
    outputTokens: count(usage.outputTokens),
    premiumRequests: initiator === 'user' ? count(usage.cost) ?? 0 : 0,
    nanoAiu: count(usage.copilotUsage?.totalNanoAiu),
    ...(answered && model !== 'unknown' && !sameCopilotModel(model, answered) ? { resolvedModel: answered } : {})
  };
}

// Closed classes: anything else Copilot writes is kept as `other`, never as its own text.
const TOOL_FAILURES = new Set(['denied', 'rejected', 'failure']);
const ERROR_CLASSES = new Set(['quota', 'rate_limit', 'authentication', 'authorization', 'model', 'query']);
const MODEL_SOURCES = Object.freeze({ model_picker: 'person', sdk: 'host', startup: 'host', agent: 'agent', automatic: 'automatic' });

/** Copilot's class for an error: its `errorType` when known, else what its code or status says. */
function errorClass(data) {
  if (ERROR_CLASSES.has(data.errorType)) return data.errorType;
  const code = typeof data.errorCode === 'string' ? data.errorCode : '';
  if (/quota/iu.test(code) || data.statusCode === 402) return 'quota';
  if (/rate[_-]?limit/iu.test(code) || data.statusCode === 429) return 'rate_limit';
  return 'other';
}

/**
 * One content-free record for an activity event, or null for one that is not counted.
 * [owner, 2026-11-13] Shapes checked read-only, counts only, on one developer computer's 1,070
 * sessions: one `assistant.turn_start` per model round trip (7,173 beside 7,170 per-call records in
 * the sessions that write both); one `tool.execution_complete` per tool call, `success: false` with a
 * code (denied, rejected, failure) when it did not run or failed; errors carry a class (quota with
 * status 402, authentication, authorization, model, query) and a message, which is never kept.
 * - turn: one agent turn (sub-agents' turns included);
 * - tool: one tool call that finished, with the model that asked for it and its failure code;
 * - subagent: one sub-agent started, with its model;
 * - model-change: the session's model changed (`from` → `model`) by the person (model picker), the
 *   host (VS Code, start-up), the agent, or Copilot on its own. Setting the first model, Auto
 *   resolving its first pick (`initial_resolution`, counted by its auto-pick) and a change of
 *   reasoning effort alone are not changes;
 * - auto-pick: Auto chose `model` for a request; `fallback` when it fell back;
 * - error: Copilot reported an error to the session, by class and HTTP status.
 */
function activityRecord(event, sessionKey, offset) {
  const data = event.data ?? {};
  const id = bounded(event.id, 256);
  const base = (kind, identity = id) => ({
    key: hashed(identity ? `${kind}:${identity}` : `${sessionKey}@${offset}`, 16), at: timestamp(event.timestamp), session: sessionKey, kind
  });
  switch (event.type) {
    case 'assistant.turn_start': return base('turn');
    case 'tool.execution_complete': {
      // Copilot's tool call id is the call's own: a log read twice, or copied into another session, counts it once.
      const record = { ...base('tool', bounded(data.toolCallId, 256) ?? id), model: modelName(data.model) };
      if (data.success === false) record.failure = TOOL_FAILURES.has(data.error?.code) ? data.error.code : 'other';
      return record;
    }
    case 'subagent.started': return { ...base('subagent'), model: modelName(data.model) };
    case 'session.model_change': {
      if (typeof data.previousModel !== 'string' || typeof data.newModel !== 'string' || data.previousModel === data.newModel) return null;
      if (data.cause === 'initial_resolution') return null;
      return { ...base('model-change'), model: modelName(data.newModel), from: modelName(data.previousModel), source: MODEL_SOURCES[data.source] ?? 'other' };
    }
    case 'session.auto_mode_resolved':
      return { ...base('auto-pick'), model: modelName(data.chosenModel), ...(data.fallback === true ? { fallback: true } : {}) };
    case 'session.error': {
      const status = Number.isSafeInteger(data.statusCode) && data.statusCode >= 100 && data.statusCode <= 599 ? data.statusCode : null;
      return { ...base('error'), error: errorClass(data), ...(status ? { status } : {}) };
    }
    default: return null;
  }
}

/**
 * Copilot before 1.0.94 wrote no per-call records, only running totals at each checkpoint. Their
 * growth since the previous checkpoint is kept as one interval: premium requests and AIU, without
 * a model or tokens. Totals never fall within a session, across resumes included (checked on 461
 * such sessions); a checkpoint seen first after skipping the start of a session only sets the base.
 */
function checkpointRecord(state, data, event, sessionKey, offset) {
  const premium = count(data.totalPremiumRequests);
  const nanoAiu = count(data.totalNanoAiu);
  if (premium == null && nanoAiu == null) return null;
  // null: read from the session's start; { base: true }: its start was skipped.
  const previous = state.checkpoint;
  state.checkpoint = { premium: premium ?? previous?.premium ?? 0, nanoAiu: nanoAiu ?? previous?.nanoAiu ?? 0 };
  if (previous?.base) return null;
  const premiumRequests = Math.max(0, state.checkpoint.premium - (previous?.premium ?? 0));
  const nano = Math.max(0, state.checkpoint.nanoAiu - (previous?.nanoAiu ?? 0));
  if (!premiumRequests && !nano) return null;
  return { key: hashed(`${sessionKey}#checkpoint@${offset}`, 16), at: timestamp(event.timestamp), session: sessionKey, kind: 'checkpoint',
    model: 'unknown', initiator: 'other', inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null,
    premiumRequests, nanoAiu: nano || null };
}

/**
 * One session's events in log order, as a state machine. `push` takes a parsed event and the byte
 * offset of its line, and returns the record to keep for it, if any: `list` says whether it is a
 * model call (`calls`) or an activity record (`events`).
 */
export function createSessionUsageReader(state, { belongs, sessionKey }) {
  return (event, offset) => {
    const data = event?.data ?? {};
    if (event?.type === 'session.start' || event?.type === 'session.resume') { applyContext(state, data.context, belongs); return null; }
    if (event?.type === 'session.context_changed') {
      if (data.pendingGitContext !== true) applyContext(state, data, belongs);
      return null;
    }
    if (ACTIVITY.has(event?.type)) {
      const record = state.ours && state.branch ? activityRecord(event, sessionKey, offset) : null;
      if (!record) return null;
      state.events = (state.events ?? 0) + 1;
      return { branch: state.branch, record, list: 'events' };
    }
    let record = null;
    if (event?.type === 'session.usage_record' && data.usage && typeof data.usage === 'object') {
      state.perCall = true;
      record = callRecord(data.usage, event, sessionKey, offset);
    } else if (event?.type === 'session.usage_checkpoint' && !state.perCall) {
      record = checkpointRecord(state, data, event, sessionKey, offset);
    }
    if (!record || !state.ours) return null;
    if (!state.branch) { state.unattributed += 1; return null; }
    state.calls += record.kind ? 0 : 1;
    return { branch: state.branch, record, list: 'calls' };
  };
}

/** The type of the event a line holds when the line starts with it, as Copilot writes them; else null. */
function lineType(buffer) {
  if (buffer.length < TYPE_PREFIX.length || buffer.compare(TYPE_PREFIX, 0, TYPE_PREFIX.length, 0, TYPE_PREFIX.length) !== 0) return null;
  const end = buffer.indexOf(0x22, TYPE_PREFIX.length);
  return end > TYPE_PREFIX.length && end - TYPE_PREFIX.length <= 64 ? buffer.toString('latin1', TYPE_PREFIX.length, end) : null;
}

/**
 * Complete lines from `start`, at most `limit` bytes of them; returns where the last complete line
 * read ended. Lines are handed over as bytes with their offset, and only lines whose type is one this
 * module reads are decoded at all.
 */
export async function readSessionEvents(file, start, limit, onEvent) {
  const handle = await open(file, 'r');
  try {
    const chunk = Buffer.alloc(READ_BYTES);
    let position = start;
    let consumed = start;
    let parts = [];
    let held = 0;
    let oversized = false;
    const take = (line, offset) => {
      const type = lineType(line);
      if (type && !EVENTS.has(type)) return;
      let event;
      try { event = JSON.parse(line.toString('utf8')); } catch { return; }
      if (EVENTS.has(event?.type)) onEvent(event, offset);
    };
    while (consumed - start < limit) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      let from = 0;
      for (;;) {
        const found = chunk.indexOf(0x0a, from);
        if (found < 0 || found >= bytesRead) {
          if (!oversized && held + bytesRead - from > MAXIMUM_LINE_BYTES) { oversized = true; parts = []; held = 0; }
          if (!oversized) { parts.push(Buffer.from(chunk.subarray(from, bytesRead))); held += bytesRead - from; }
          break;
        }
        if (!oversized) take(parts.length ? Buffer.concat([...parts, chunk.subarray(from, found)]) : chunk.subarray(from, found), consumed);
        parts = []; held = 0; oversized = false;
        consumed = position + found + 1;
        from = found + 1;
        if (consumed - start >= limit) break;
      }
      position += bytesRead;
    }
    return consumed;
  } finally {
    await handle.close();
  }
}

/**
 * The session's first event, from at most its first 64 KiB: undefined while Copilot is still writing
 * that line, null when it is not an event.
 */
async function firstEvent(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(FIRST_LINE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (end < 0) return bytesRead < buffer.length ? undefined : null;
    try { return JSON.parse(buffer.subarray(0, end).toString('utf8')); } catch { return null; }
  } finally {
    await handle.close();
  }
}

async function withUsageLock(root, operation) {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { return await withSubjectLock(root, LOCK_SUBJECT, operation); }
    catch (error) {
      lastError = error;
      if (error?.code !== 'SUBJECT_LOCK_BUSY') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Read what Copilot added to its session logs since the last sync and record this repository's
 * model calls and activity by branch. A session is skipped from its first line when it started
 * somewhere else; one that grows is read from where the last sync stopped, so a branch or folder
 * change mid-session moves the calls after it. Each call and each activity record is kept once,
 * however often its log is read.
 */
export async function syncCopilotSessionUsage(root, {
  directory = copilotSessionStateDirectory(), now = Date.now(), maxBytes = DEFAULT_SYNC_BYTES
} = {}) {
  const names = await readdir(directory).catch(() => null);
  if (!names) return { status: 'no-directory', directory, added: 0, bytesRead: 0, pending: 0 };
  return withUsageLock(root, async () => {
    const previous = await readCache(cursorFile(root));
    // An earlier reader's positions are not reused: what it skipped is read again (see READER).
    const known = previous?.reader === READER ? previous.sessions ?? {} : {};
    const belongs = repositoryMatcher(root);
    const found = [];
    let withoutLog = 0;
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const info = await lstat(path.join(directory, name, 'events.jsonl')).catch(() => null);
      if (info?.isFile()) found.push({ name, key: hashed(name, 16), info });
      else withoutLog += 1;
    }
    // The newest sessions first: when a sync cannot read everything, the work going on now is read.
    found.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs);
    const sessions = {};
    const fresh = new Map();
    let bytesRead = 0;
    let pending = 0;
    for (const { name, key, info } of found) {
      const file = path.join(directory, name, 'events.jsonl');
      const before = known[key];
      const continuing = before && before.ino === info.ino && before.offset <= info.size;
      if (continuing && before.size === info.size && before.mtimeMs === info.mtimeMs) { sessions[key] = before; continue; }
      let state = continuing ? { ...before } : null;
      if (!state) {
        state = { ...freshSession(), ino: info.ino, offset: 0, size: null, mtimeMs: null };
        const start = await firstEvent(file).catch(() => null);
        // A session whose first line is still being written is decided by the next sync, from its start.
        if (start === undefined) { sessions[key] = state; continue; }
        if (start?.type === 'session.start') applyContext(state, start.data?.context, belongs);
        if (!state.ours) {
          // Not this repository's: skip what is written, and read only what it adds from now on.
          Object.assign(state, { offset: info.size, size: info.size, mtimeMs: info.mtimeMs, checkpoint: { base: true } });
          sessions[key] = state;
          continue;
        }
      }
      if (bytesRead >= maxBytes) { pending += 1; sessions[key] = state; continue; }
      const push = createSessionUsageReader(state, { belongs, sessionKey: key });
      const end = await readSessionEvents(file, state.offset, maxBytes - bytesRead, (event, offset) => {
        const kept = push(event, offset);
        if (!kept) return;
        if (!fresh.has(kept.branch)) fresh.set(kept.branch, { calls: [], events: [] });
        fresh.get(kept.branch)[kept.list].push(kept.record);
      });
      bytesRead += end - state.offset;
      const complete = end >= info.size || bytesRead < maxBytes;
      if (!complete) pending += 1;
      Object.assign(state, { offset: end, size: complete ? info.size : null, mtimeMs: complete ? info.mtimeMs : null });
      sessions[key] = state;
    }
    let added = 0;
    let addedEvents = 0;
    const byTime = (left, right) => String(left.at ?? '').localeCompare(String(right.at ?? ''));
    for (const [branch, records] of fresh) {
      const target = branchFile(root, branch);
      const existing = await readCache(target);
      const merged = {};
      let changed = false;
      for (const list of ['calls', 'events']) {
        const before = existing?.[list] ?? [];
        const seen = new Set(before.map((record) => record.key));
        const unseen = records[list].filter((record) => !seen.has(record.key) && seen.add(record.key));
        if (list === 'calls') added += unseen.length; else addedEvents += unseen.length;
        changed ||= unseen.length > 0;
        merged[list] = unseen.length ? [...before, ...unseen].sort(byTime) : before;
      }
      if (changed) await writeCache(target, { branch, ...merged });
    }
    const syncedAt = new Date(now).toISOString();
    await writeCache(cursorFile(root), { reader: READER, since: previous?.since ?? syncedAt, syncedAt, withoutLog, pending, sessions });
    return { status: 'synced', directory, added, addedEvents, bytesRead, pending, sessionsRead: found.length };
  });
}

function summary(cursor) {
  const states = Object.values(cursor?.sessions ?? {});
  const unmatched = {};
  for (const state of states) if (!state.matched) unmatched[state.reason ?? 'no-start-event'] = (unmatched[state.reason ?? 'no-start-event'] ?? 0) + 1;
  return {
    seen: states.length,
    matched: states.filter((state) => state.matched).length,
    unmatched,
    withoutLog: cursor?.withoutLog ?? 0,
    pending: cursor?.pending ?? 0,
    calls: states.reduce((sum, state) => sum + (state.calls ?? 0), 0),
    events: states.reduce((sum, state) => sum + (state.events ?? 0), 0),
    callsWithoutBranch: states.reduce((sum, state) => sum + (state.unattributed ?? 0), 0)
  };
}

/**
 * The recorded model calls and activity on `branch` in this repository, without reading Copilot's
 * logs. Null when this repository has never read them.
 */
export async function copilotSessionCalls(root, branch) {
  if (!root || !branch) return null;
  let cursor;
  try { cursor = await readCache(cursorFile(root)); } catch { return null; }
  if (!cursor) return null;
  const record = await readCache(branchFile(root, branch));
  const calls = record?.branch === branch ? record.calls ?? [] : [];
  const events = record?.branch === branch ? record.events ?? [] : [];
  const { matched, pending } = summary(cursor);
  return { since: cursor.since ?? null, syncedAt: cursor.syncedAt ?? null, repositorySessions: matched,
    branchSessions: new Set([...calls, ...events].map((entry) => entry.session)).size, pending, calls, events };
}

/** What Copilot's session folder holds and how far this repository has read it; reads no log. */
export async function copilotSessionUsageStatus(root, { directory = copilotSessionStateDirectory() } = {}) {
  const info = await stat(directory).catch(() => null);
  const cursor = root ? await readCache(cursorFile(root)) : null;
  let branches = 0;
  if (cursor) branches = (await readdir(path.join(usageDirectory(root), 'branches')).catch(() => [])).filter((name) => name.endsWith('.json')).length;
  return {
    directory,
    exists: Boolean(info?.isDirectory()),
    following: Boolean(cursor),
    since: cursor?.since ?? null,
    syncedAt: cursor?.syncedAt ?? null,
    sessions: cursor ? summary(cursor) : null,
    branches
  };
}

/**
 * This computer's Copilot model calls for the Story, for a report: the calls on the Story's branch
 * in this repository and, when there are none, why. `sync` first reads what Copilot wrote since the
 * last sync. A report never fails for this.
 */
export async function storyCopilotSessions(root, workflow, { sync = false, directory = copilotSessionStateDirectory() } = {}) {
  const branch = workflow?.workItem?.branch ?? workflow?.workItem?.id ?? null;
  if (!root || !branch) return null;
  let synced = null;
  if (sync) {
    try { synced = await syncCopilotSessionUsage(root, { directory }); } catch { synced = { status: 'failed' }; }
  }
  let calls = null;
  try { calls = await copilotSessionCalls(root, branch); } catch { calls = null; }
  if (calls) return { branch, read: true, ...calls };
  const exists = synced ? synced.status !== 'no-directory' : Boolean((await stat(directory).catch(() => null))?.isDirectory());
  return { branch, read: false, reason: !exists ? 'no-session-logs' : synced?.status === 'failed' ? 'unreadable' : 'not-read', calls: [], events: [] };
}
