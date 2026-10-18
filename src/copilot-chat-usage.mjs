/**
 * Copilot Chat usage on this computer.
 *
 * Copilot Chat in VS Code sends SFlow nothing by itself. When a developer turns counting on (VS Code
 * asks once), Copilot Chat writes its OpenTelemetry spans to one local file. This module follows that
 * file and keeps, for this repository, one content-free record per Copilot Chat request: when, on
 * which branch, which model, how many model calls, tokens, cache reads and writes, and the usage
 * Copilot billed for it. Nothing is committed: the records stay beside this repository's Git
 * directory, so a report shows the Copilot Chat use of this computer only.
 *
 * Only `telemetry chat sync` (VS Code runs it in the background) and `report` read Copilot's file.
 * Work commands never do; the snapshot reads only the small per-branch records written here.
 */
import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitCommonDir, remoteNames, remoteUrl } from './git.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { nowIso, writeAtomic } from './util.mjs';

const FORMAT = 'sflow-copilot-chat-usage/v1';
const LOCK_SUBJECT = Object.freeze({ kind: 'copilot-chat-usage', id: 'shared' });
const READ_BYTES = 1024 * 1024;
const MAXIMUM_LINE_BYTES = 16 * 1024 * 1024;
// A request's model calls are written before the request itself ends. Calls whose request never
// arrives (a crash, a window closed mid-request) are dropped after this long.
const PENDING_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/** The file Copilot Chat writes its spans to when counting is on. One per computer. */
export function copilotChatOtelFile(env = process.env) {
  return env.SINGULARITY_FLOW_COPILOT_CHAT_OTEL_FILE
    ? path.resolve(env.SINGULARITY_FLOW_COPILOT_CHAT_OTEL_FILE)
    : path.join(os.homedir(), '.singularity-flow', 'copilot-chat-otel.jsonl');
}

function usageDirectory(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'copilot-chat');
}

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

/** host/path, lower case, without credentials, scheme or `.git`: an SSH and an HTTPS remote agree. */
export function remoteKey(url) {
  let text = String(url ?? '').trim();
  if (!text) return null;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/u.exec(text);
  if (scp) text = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const parsed = new URL(text);
      text = parsed.protocol === 'file:' ? parsed.pathname : `${parsed.hostname}${parsed.pathname}`;
    } catch { /* a local path */ }
  }
  return text.replace(/\.git\/?$/iu, '').replace(/\/+$/u, '').toLowerCase() || null;
}

function repositoryRemoteKeys(root) {
  let names = [];
  try { names = remoteNames(root); } catch { return new Set(); }
  return new Set(names.map((name) => remoteKey(remoteUrl(root, name))).filter(Boolean));
}

const number = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const sum = (left, right) => (right == null ? left : (left ?? 0) + right);

function milliseconds(value) {
  if (Array.isArray(value) && value.length === 2) {
    const [seconds, nanoseconds] = value.map(Number);
    if (Number.isFinite(seconds) && Number.isFinite(nanoseconds)) return seconds * 1000 + nanoseconds / 1_000_000;
  }
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedText(value, limit = 256) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= limit && !/[\r\n\0]/u.test(text) ? text : null;
}

/**
 * One span's content-free facts, or null for anything else in the file (log records, metrics,
 * tool spans). Prompt and response attributes are never read.
 */
function spanFacts(line) {
  let node;
  try { node = JSON.parse(line); } catch { return null; }
  if (!node || typeof node !== 'object' || typeof node.traceId !== 'string' || typeof node.spanId !== 'string') return null;
  const attributes = node.attributes && typeof node.attributes === 'object' && !Array.isArray(node.attributes) ? node.attributes : {};
  const operation = attributes['gen_ai.operation.name'];
  if (operation !== 'chat' && operation !== 'invoke_agent') return null;
  return {
    operation,
    trace: hashed(node.traceId, 16),
    root: !node.parentSpanContext?.spanId,
    at: milliseconds(node.startTime),
    failed: node.status?.code === 2,
    model: boundedText(attributes['gen_ai.request.model'], 128),
    branch: boundedText(attributes['copilot_chat.repo.head_branch_name'] ?? attributes['github.copilot.git.branch']),
    remote: remoteKey(attributes['copilot_chat.repo.remote_url'] ?? attributes['github.copilot.git.repository']),
    inputTokens: number(attributes['gen_ai.usage.input_tokens']),
    outputTokens: number(attributes['gen_ai.usage.output_tokens']),
    cachedInputTokens: number(attributes['gen_ai.usage.cache_read.input_tokens']),
    cacheWriteInputTokens: number(attributes['gen_ai.usage.cache_creation.input_tokens']),
    nanoAiu: number(attributes['copilot_chat.copilot_usage_nano_aiu'])
  };
}

/** Complete lines from `start`; returns where the last complete line ended. */
async function readLines(file, start, onLine) {
  const handle = await open(file, 'r');
  try {
    const chunk = Buffer.alloc(READ_BYTES);
    let position = start;
    let consumed = start;
    let parts = [];
    let held = 0;
    let oversized = false;
    for (;;) {
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
        if (!oversized) onLine(Buffer.concat([...parts, chunk.subarray(from, found)]).toString('utf8'));
        parts = []; held = 0; oversized = false;
        consumed = position + found + 1;
        from = found + 1;
      }
      position += bytesRead;
    }
    return consumed;
  } finally {
    await handle.close();
  }
}

function addCall(pending, span, now) {
  const entry = pending[span.trace] ?? {
    firstSeen: now, at: null, model: null, modelCalls: 0, inputTokens: null, outputTokens: null,
    cachedInputTokens: null, cacheWriteInputTokens: null, nanoAiu: null, failed: false
  };
  entry.modelCalls += 1;
  if (span.at != null && (entry.at == null || span.at < entry.at)) entry.at = span.at;
  entry.model ??= span.model;
  for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'nanoAiu']) {
    entry[field] = sum(entry[field], span[field]);
  }
  entry.failed ||= span.failed;
  pending[span.trace] = entry;
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
 * Read what Copilot Chat wrote since the last sync and record this repository's requests. A request
 * belongs here when its window's repository has one of this repository's remotes (or, for a
 * repository with no remote, has none either). Repeating a sync adds nothing.
 */
export async function syncCopilotChatUsage(root, { file = copilotChatOtelFile(), now = Date.now() } = {}) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return { status: 'no-file', file, added: 0, bytesRead: 0 };
  return withUsageLock(root, async () => {
    const previous = await readCache(cursorFile(root));
    const sameFile = previous?.file?.dev === info.dev && previous?.file?.ino === info.ino && previous.offset <= info.size;
    const start = sameFile ? previous.offset : 0;
    const pending = sameFile ? { ...(previous.pending ?? {}) } : {};
    const remotes = repositoryRemoteKeys(root);
    const finished = new Map();
    const end = info.size > start ? await readLines(file, start, (line) => {
      const span = spanFacts(line);
      if (!span) return;
      if (span.operation === 'chat') { addCall(pending, span, now); return; }
      // A sub-agent's request belongs to the user's request it ran under, in the same trace.
      if (!span.root) return;
      const calls = pending[span.trace];
      delete pending[span.trace];
      const ours = span.branch && (span.remote ? remotes.has(span.remote) : remotes.size === 0);
      if (!ours) return;
      const request = {
        trace: span.trace,
        at: new Date(span.at ?? calls?.at ?? now).toISOString(),
        model: span.model ?? calls?.model ?? null,
        modelCalls: calls?.modelCalls ?? 0,
        inputTokens: calls?.inputTokens ?? null,
        outputTokens: calls?.outputTokens ?? null,
        cachedInputTokens: calls?.cachedInputTokens ?? null,
        cacheWriteInputTokens: calls?.cacheWriteInputTokens ?? null,
        nanoAiu: calls?.nanoAiu ?? null,
        failed: span.failed || Boolean(calls?.failed)
      };
      finished.set(span.branch, [...(finished.get(span.branch) ?? []), request]);
    }) : start;
    for (const [trace, entry] of Object.entries(pending)) {
      if (now - entry.firstSeen > PENDING_TTL_MS) delete pending[trace];
    }
    let added = 0;
    for (const [branch, requests] of finished) {
      const target = branchFile(root, branch);
      const existing = (await readCache(target))?.requests ?? [];
      const seen = new Set(existing.map((request) => request.trace));
      const fresh = requests.filter((request) => !seen.has(request.trace));
      if (!fresh.length) continue;
      added += fresh.length;
      await writeCache(target, {
        branch,
        requests: [...existing, ...fresh].sort((left, right) => left.at.localeCompare(right.at))
      });
    }
    await writeCache(cursorFile(root), {
      file: { dev: info.dev, ino: info.ino },
      offset: end,
      since: previous?.since ?? new Date(now).toISOString(),
      syncedAt: new Date(now).toISOString(),
      pending
    });
    return { status: 'synced', file, added, bytesRead: end - start };
  });
}

/**
 * The recorded Copilot Chat requests made on `branch` in this repository, without reading Copilot's
 * file. `since` is when this computer started following it; null means it never has.
 */
export async function copilotChatRequests(root, branch) {
  if (!root || !branch) return null;
  let cursor;
  try { cursor = await readCache(cursorFile(root)); } catch { return null; }
  if (!cursor) return null;
  const record = await readCache(branchFile(root, branch));
  return {
    since: cursor.since ?? null,
    syncedAt: cursor.syncedAt ?? null,
    requests: record?.branch === branch ? record.requests ?? [] : []
  };
}

/** Whether Copilot Chat's file exists and how far this repository has read it. */
export async function copilotChatUsageStatus(root, { file = copilotChatOtelFile() } = {}) {
  const info = await stat(file).catch(() => null);
  const cursor = root ? await readCache(cursorFile(root)) : null;
  return {
    file,
    exists: Boolean(info?.isFile()),
    bytes: info?.isFile() ? info.size : null,
    following: Boolean(cursor),
    since: cursor?.since ?? null,
    syncedAt: cursor?.syncedAt ?? null,
    unreadBytes: info?.isFile() && cursor ? Math.max(0, info.size - (cursor.offset ?? 0)) : null,
    checkedAt: nowIso()
  };
}

/**
 * This computer's Copilot Chat requests for the Story, for a report. `sync` first reads what Copilot
 * wrote since the last sync. A report never fails for this: unreadable usage is reported as not
 * counted.
 */
export async function storyCopilotChat(root, workflow, { sync = false } = {}) {
  const branch = workflow?.workItem?.branch ?? workflow?.workItem?.id ?? null;
  if (!root || !branch) return null;
  if (sync) {
    try { await syncCopilotChatUsage(root); } catch { /* the records already written still count */ }
  }
  try { return await copilotChatRequests(root, branch); } catch { return null; }
}
