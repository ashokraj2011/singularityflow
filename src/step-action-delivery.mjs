/**
 * Delivering after-step actions.
 *
 * After a governed transition is committed (and published, unless publication is off), the
 * actions its Story pinned for that step are written to this repository's action outbox, one
 * record per delivery, and tried at once within a small time budget. A record that cannot be
 * delivered stays in the outbox and is retried by later transitions, by `sync`, by
 * `singularity-flow integrations retry`, or from VS Code. Each record carries the exact request
 * body, so a retry sends the same thing, and its key makes a retry the same delivery.
 *
 * The outbox is machine-local state under the repository's common Git directory. It is never
 * governance evidence: it records what this machine tried to send. An action whose target is
 * delivered from a pipeline is written with status `pipeline` and never tried here: the pipeline
 * rebuilds it from the pushed commit (step-action-pipeline.mjs), with the same delivery key. Secrets are read from the
 * delivering process's environment when a request is made and are never written anywhere.
 *
 * Nothing here can fail a lifecycle transition: every error becomes an outcome on a record.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { lstat, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { committedFileBytes } from './git.mjs';
import { prepareSharedPublicationStorage, sharedPublicationStorageDirectory } from './publication-storage.mjs';
import { recordSha256 } from './records.mjs';
import {
  actionsForTrigger, buildStepActionEvent, stepActionDeliveryKey, stepActionText, stepActionTriggers, summarizeArtifact
} from './step-actions.mjs';
import { STEP_ACTION_WRITERS } from './step-action-writers.mjs';
import { pinnedHttpRequest } from './pinned-http.mjs';
import { SingularityFlowError } from './util.mjs';

export const STEP_ACTION_OUTBOX = 'action-outbox';
export const STEP_ACTION_RECORD_SCHEMA = 'sflow-step-action-delivery@1';
export const MAX_DELIVERY_ATTEMPTS = 8;
/** Seconds to wait after the nth failed attempt before trying again. */
export const RETRY_BACKOFF_SECONDS = Object.freeze([30, 120, 600, 1800, 7200, 21600, 86400]);
export const INLINE_DELIVERY_BUDGET_MS = 15_000;
const MAX_ARTIFACT_READ_BYTES = 256 * 1024;
/** The largest approved artifact an action sends as a file (Jira attachment, Git commit, upload). */
export const MAX_ARTIFACT_SEND_BYTES = 4 * 1024 * 1024;
const LOCK_STALE_MS = 2 * 60 * 1000;
const MAX_RECORDED_ATTEMPTS = 20;
const USER_AGENT = 'singularity-flow-step-actions/1';

function nowIso(clock) { return new Date(clock()).toISOString(); }

function outboxPath(root) { return sharedPublicationStorageDirectory(root, STEP_ACTION_OUTBOX); }

function recordFile(directory, key) {
  if (!/^sad_[0-9a-f]{40}$/.test(key)) throw new SingularityFlowError(`'${key}' is not a delivery key.`, { code: 'STEP_ACTION_DELIVERY_UNKNOWN' });
  return path.join(directory, `${key}.json`);
}

function sealed(record) {
  const { integrity: _ignored, ...core } = record;
  return { ...core, integrity: recordSha256(core) };
}

async function writeRecord(directory, record) {
  const file = recordFile(directory, record.key);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sealed(record), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** A record as stored, or a `tampered` marker when its contents no longer match its seal. */
async function readRecord(directory, key) {
  let text;
  try { text = await readFile(recordFile(directory, key), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let record;
  try { record = JSON.parse(text); } catch { return { key, tampered: true }; }
  const { integrity, ...core } = record ?? {};
  if (record?.schema !== STEP_ACTION_RECORD_SCHEMA || record.key !== key || integrity !== recordSha256(core)) return { key, tampered: true };
  return record;
}

async function recordKeys(directory) {
  let names;
  try { names = await readdir(directory); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => /^sad_[0-9a-f]{40}\.json$/.test(name)).map((name) => name.slice(0, -5)).sort();
}

/** One process delivers a record at a time; a lock left by a crashed process expires. */
async function withRecordLock(directory, key, clock, work) {
  const lock = path.join(directory, `${key}.lock`);
  let handle;
  try { handle = await open(lock, 'wx', 0o600); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const info = await stat(lock).catch(() => null);
    if (info && clock() - info.mtimeMs < LOCK_STALE_MS) return { skipped: 'locked' };
    await rm(lock, { force: true });
    try { handle = await open(lock, 'wx', 0o600); } catch { return { skipped: 'locked' }; }
  }
  try {
    await handle.writeFile(`${process.pid} ${nowIso(clock)}\n`);
    return await work();
  } finally {
    await handle.close().catch(() => {});
    await rm(lock, { force: true }).catch(() => {});
  }
}

function boundedDetail(text) {
  return String(text ?? '')
    .replace(/(authorization|token|secret|signature|api[-_]?key|password)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s"']+/g, (url) => { try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}/…`; } catch { return '[address]'; } })
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}

function secretValue(name, env) {
  if (!name) return null;
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * POST a body to an address, connecting to the address its host resolved to so a second lookup
 * cannot redirect it. A public target refuses private addresses; plain http reaches only this
 * machine; redirects are never followed.
 */
export { pinnedHttpRequest };

export async function postDelivery({ url, headers, body, timeoutMs, network = 'public', lookupImpl = dnsLookup }) {
  const answer = await pinnedHttpRequest({ url, method: 'POST', headers, body, timeoutMs, network, lookupImpl });
  return answer.transport ?? classifyResponse(answer.status, answer.text);
}

/** What an answer means for the delivery: done, try again later, or needs a person. */
export function classifyResponse(status, text = '') {
  if (status >= 200 && status < 300) return { outcome: 'delivered', status };
  // A receiver that recognises the idempotency key answers 409: it already has this delivery.
  if (status === 409) return { outcome: 'delivered', status, detail: 'The receiver already had this delivery.' };
  if (status >= 300 && status < 400) return { outcome: 'failed', status, code: 'STEP_ACTION_REDIRECT_REFUSED', detail: 'The target answered with a redirect, which is never followed. Update its address.' };
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: 'retry', status, code: 'STEP_ACTION_TARGET_UNAVAILABLE', detail: boundedDetail(text) || `HTTP ${status}` };
  }
  return { outcome: 'failed', status, code: 'STEP_ACTION_TARGET_REFUSED', detail: boundedDetail(text) || `HTTP ${status}` };
}

/**
 * The request a record makes, with its secrets read from `env` now. A secret the target names but
 * this machine does not have makes the delivery unavailable here, without spending an attempt.
 */
export function deliveryRequest(record, env, clock = Date.now) {
  const target = record.action.targetSpec;
  const event = record.event;
  const base = {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    'idempotency-key': record.key,
    'x-sflow-delivery': record.key,
    'x-sflow-trigger': record.trigger
  };
  const missing = (name) => ({ unavailable: { code: 'STEP_ACTION_SECRET_MISSING', detail: `Secret ${name} is not set on this machine.` } });
  if (target.kind === 'webhook') {
    const body = JSON.stringify(event);
    const headers = { ...base };
    if (target.signingSecret) {
      const secret = secretValue(target.signingSecret, env);
      if (!secret) return missing(target.signingSecret);
      const timestamp = String(Math.floor(clock() / 1000));
      headers['x-sflow-timestamp'] = timestamp;
      headers['x-sflow-signature'] = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
    }
    return { url: target.url, headers, body };
  }
  if (target.kind === 'http-log') {
    const token = target.tokenSecret ? secretValue(target.tokenSecret, env) : null;
    if (target.tokenSecret && !token) return missing(target.tokenSecret);
    const message = stepActionText(event);
    const labels = target.labels ?? {};
    const at = Date.parse(event.at ?? '') || clock();
    const headers = { ...base };
    let body;
    if (target.format === 'splunk-hec') {
      headers.authorization = `Splunk ${token}`;
      body = JSON.stringify({ time: at / 1000, source: 'singularity-flow', sourcetype: '_json', event: { message, ...event }, fields: labels });
    } else if (target.format === 'datadog') {
      headers['dd-api-key'] = token;
      body = JSON.stringify([{ ddsource: 'singularity-flow', service: labels.service ?? 'singularity-flow',
        ddtags: Object.entries(labels).filter(([key]) => key !== 'service').map(([key, value]) => `${key}:${value}`).join(','), message, sflow: event }]);
    } else if (target.format === 'elastic') {
      headers.authorization = `ApiKey ${token}`;
      body = JSON.stringify({ '@timestamp': new Date(at).toISOString(), message, labels, sflow: event });
    } else if (target.format === 'loki') {
      if (token) headers.authorization = `Bearer ${token}`;
      body = JSON.stringify({ streams: [{ stream: { source: 'singularity-flow', trigger: record.trigger, ...labels },
        values: [[`${BigInt(at) * 1000000n}`, JSON.stringify({ message, ...event })]] }] });
    } else {
      if (token) headers.authorization = `Bearer ${token}`;
      body = JSON.stringify({ message, labels, ...event });
    }
    return { url: target.url, headers, body };
  }
  if (target.kind === 'teams') {
    const raw = secretValue(target.urlSecret, env);
    if (!raw) return missing(target.urlSecret);
    let url;
    try { url = new URL(raw); } catch { return { failed: { code: 'STEP_ACTION_ADDRESS_REFUSED', detail: `Secret ${target.urlSecret} is not a valid address.` } }; }
    if (url.protocol !== 'https:' || url.username || url.password) {
      return { failed: { code: 'STEP_ACTION_ADDRESS_REFUSED', detail: `Secret ${target.urlSecret} must be an https:// address without credentials.` } };
    }
    return { url: url.toString(), headers: base, body: JSON.stringify({ text: stepActionText(event) }) };
  }
  return { failed: { code: 'STEP_ACTION_KIND_UNAVAILABLE', detail: `This build cannot deliver to a ${target.kind} target.` } };
}

function nextAttemptAt(record, clock) {
  const spent = record.attempts.filter((attempt) => attempt.outcome === 'retry').length;
  const wait = RETRY_BACKOFF_SECONDS[Math.min(spent - 1, RETRY_BACKOFF_SECONDS.length - 1)] ?? RETRY_BACKOFF_SECONDS[0];
  return new Date(clock() + wait * 1000).toISOString();
}

/** Try one record now and write its outcome. Returns the updated record. */
async function attemptRecord(directory, record, { env, clock, post, logger, writers = STEP_ACTION_WRITERS, root = null }) {
  const at = nowIso(clock);
  let result;
  if (env?.SINGULARITY_FLOW_NO_NETWORK === '1' || env?.SINGULARITY_FLOW_NO_NETWORK === 'true') {
    result = { outcome: 'unavailable', code: 'STEP_ACTION_NETWORK_DISABLED', detail: 'SINGULARITY_FLOW_NO_NETWORK is set, so nothing is sent.' };
  } else if (Object.hasOwn(writers, record.action?.targetSpec?.kind ?? '')) {
    // Jira and the other writers talk to their service themselves; they check the delivery key
    // there before writing, and never throw.
    try {
      result = await writers[record.action.targetSpec.kind](record, { root, env, timeoutMs: (record.action.targetSpec.timeoutSeconds ?? 10) * 1000 });
    } catch (error) {
      result = { outcome: 'retry', code: 'STEP_ACTION_WRITER_FAILED', detail: boundedDetail(error?.message) };
    }
  } else {
    const request = deliveryRequest(record, env, clock);
    if (request.unavailable) result = { outcome: 'unavailable', ...request.unavailable };
    else if (request.failed) result = { outcome: 'failed', ...request.failed };
    else {
      try {
        result = await post({ ...request, timeoutMs: (record.action.targetSpec.timeoutSeconds ?? 10) * 1000, network: record.action.targetSpec.network });
      } catch (error) {
        result = { outcome: 'retry', code: 'STEP_ACTION_NETWORK_FAILED', detail: boundedDetail(error?.message) };
      }
    }
  }
  const attempt = { at, outcome: result.outcome, ...(result.status ? { status: result.status } : {}),
    ...(result.code ? { code: result.code } : {}), ...(result.detail ? { detail: boundedDetail(result.detail) } : {}) };
  const attempts = [...record.attempts, attempt].slice(-MAX_RECORDED_ATTEMPTS);
  const updated = { ...record, attempts, updatedAt: at };
  if (result.outcome === 'delivered') {
    updated.status = 'delivered'; updated.deliveredAt = at; updated.nextAttemptAt = null;
  } else if (result.outcome === 'failed') {
    updated.status = 'failed'; updated.nextAttemptAt = null;
  } else if (result.outcome === 'retry') {
    const spent = attempts.filter((entry) => entry.outcome === 'retry').length;
    if (spent >= MAX_DELIVERY_ATTEMPTS) { updated.status = 'failed'; updated.nextAttemptAt = null; }
    else { updated.status = 'pending'; updated.nextAttemptAt = nextAttemptAt(updated, clock); }
  } else {
    // Unavailable on this machine: try again on the next chance, without spending an attempt.
    updated.status = 'pending'; updated.nextAttemptAt = at;
  }
  await writeRecord(directory, updated);
  try {
    logger?.info?.('step-action.attempt', `${record.action.id} → ${record.action.target}: ${attempt.outcome}`, {
      key: record.key, workId: record.workId, phaseId: record.phaseId, trigger: record.trigger,
      target: record.action.target, kind: record.action.targetSpec.kind, outcome: attempt.outcome,
      status: attempt.status ?? null, code: attempt.code ?? null
    });
  } catch { /* logging never fails a delivery */ }
  return updated;
}

/**
 * The approved artifact's bytes, for actions that send `artifact`: read once, when the transition
 * commits, and kept only if they hash to what the step recorded. The record is sealed, so a
 * delivery sends exactly the approved bytes, whatever the working tree holds by then.
 */
async function readArtifactForDelivery(root, workflow, phaseId, { commit = null } = {}) {
  const artifact = (workflow.phases?.[phaseId]?.artifacts ?? []).find((entry) => typeof entry?.path === 'string'
    && !path.isAbsolute(entry.path) && !entry.path.split(/[\\/]/).includes('..'));
  if (!artifact) return { path: null, sha256: null, problem: 'This step recorded no artifact to send.' };
  const described = { path: artifact.path, sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : null };
  try {
    let bytes;
    if (commit) {
      // A pipeline sends the bytes of the commit it delivers for, whatever its checkout holds.
      bytes = committedFileBytes(root, commit, artifact.path);
      if (!bytes) return { ...described, problem: `${artifact.path} is not in commit ${String(commit).slice(0, 12)}.` };
      if (bytes.length > MAX_ARTIFACT_SEND_BYTES) return { ...described, problem: `${artifact.path} is larger than ${MAX_ARTIFACT_SEND_BYTES / (1024 * 1024)} MiB, so it is not sent.` };
    } else {
      const file = path.join(root, artifact.path);
      const info = await lstat(file);
      if (!info.isFile()) return { ...described, problem: `${artifact.path} is not a regular file, so it is not sent.` };
      if (info.size > MAX_ARTIFACT_SEND_BYTES) return { ...described, problem: `${artifact.path} is larger than ${MAX_ARTIFACT_SEND_BYTES / (1024 * 1024)} MiB, so it is not sent.` };
      bytes = await readFile(file);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (described.sha256 && sha256 !== described.sha256) {
      return { ...described, problem: `${artifact.path} no longer matches the hash the step recorded, so it is not sent.` };
    }
    return { ...described, sha256, mediaType: /\.md$/i.test(artifact.path) ? 'text/markdown' : 'application/octet-stream', base64: bytes.toString('base64') };
  } catch {
    return { ...described, problem: `${artifact.path} could not be read on this machine.` };
  }
}

async function readArtifactSummary(root, workflow, phaseId, { commit = null } = {}) {
  const artifact = (workflow.phases?.[phaseId]?.artifacts ?? []).find((entry) => typeof entry?.path === 'string'
    && !path.isAbsolute(entry.path) && !entry.path.split(/[\\/]/).includes('..'));
  if (!artifact) return null;
  try {
    if (commit) {
      const bytes = committedFileBytes(root, commit, artifact.path);
      return bytes && bytes.length <= MAX_ARTIFACT_READ_BYTES ? summarizeArtifact(bytes.toString('utf8')) : null;
    }
    const file = path.join(root, artifact.path);
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_ARTIFACT_READ_BYTES) return null;
    return summarizeArtifact(await readFile(file, 'utf8'));
  } catch { return null; }
}

/**
 * Write the deliveries a committed transition calls for. `published` is false when the commit
 * could not be pushed: those deliveries wait until `sync` publishes it.
 *
 * `deliverer` says who is writing: the machine that made the transition writes a pipeline target's
 * deliveries as `pipeline` and never tries them; a pipeline writes only those, as due, and reads
 * the artifact from the commit (`fromCommit`). `include` can leave further actions out.
 */
export async function enqueueStepActions(root, workflow, {
  event, commit, remote = null, published = true, clock = Date.now, deliverer = 'transition', fromCommit = false, include = null
} = {}) {
  const phaseId = event?.phaseId;
  if (!phaseId || !workflow?.workItem?.id) return [];
  const phase = workflow.phases?.[phaseId];
  const resolved = (workflow.resolution?.phases ?? []).find((entry) => entry.id === phaseId);
  if (!resolved?.afterStep?.length) return [];
  const triggers = stepActionTriggers(event.type, phase);
  if (!triggers.length) return [];
  const directory = await prepareSharedPublicationStorage(root, STEP_ACTION_OUTBOX, 'After-step action outbox');
  const generation = Number.isSafeInteger(event.generation) ? event.generation : (Number.isSafeInteger(phase?.generation) ? phase.generation : 0);
  const decision = event.type === 'phase-rejected'
    ? { returnedTo: event.payload?.targetPhaseId ?? null, changeRequest: event.payload?.changeRequestId ?? null }
    : null;
  let summary;
  let artifact;
  const written = [];
  const source = fromCommit ? { commit } : {};
  for (const trigger of triggers) {
    for (const action of actionsForTrigger(resolved, trigger)) {
      const viaPipeline = action.targetSpec?.deliverFrom === 'pipeline';
      if (deliverer === 'pipeline' && !viaPipeline) continue;
      if (include && !include(action, trigger)) continue;
      const key = stepActionDeliveryKey({ workId: workflow.workItem.id, phaseId, generation, trigger, actionId: action.id });
      if (await readRecord(directory, key)) continue;
      const payload = buildStepActionEvent({ workflow, phaseId, trigger, action, deliveryKey: key, event, commit, remote, decision });
      payload.step.generation = generation;
      if (action.send === 'summary') {
        summary ??= await readArtifactSummary(root, workflow, phaseId, source);
        payload.summary = summary ?? { title: null, acceptanceCriteria: [] };
      }
      if (action.send === 'artifact') artifact ??= await readArtifactForDelivery(root, workflow, phaseId, source);
      const at = nowIso(clock);
      const status = deliverer === 'transition' && viaPipeline ? 'pipeline' : published ? 'pending' : 'waiting';
      const record = {
        schema: STEP_ACTION_RECORD_SCHEMA, key, workId: workflow.workItem.id, phaseId, generation, trigger,
        action: structuredClone(action), event: payload, commit: commit ?? null,
        status, createdAt: at, updatedAt: at, nextAttemptAt: status === 'pending' ? at : null,
        deliveredAt: null, attempts: [],
        ...(action.send === 'artifact' ? { artifact } : {})
      };
      await writeRecord(directory, record);
      written.push(record);
    }
  }
  return written;
}

/**
 * Deliveries that waited for their commit to be published become due once `sync` publishes it.
 */
export async function releaseWaitingStepActions(root, { workId, clock = Date.now } = {}) {
  const directory = outboxPath(root);
  let released = 0;
  for (const key of await recordKeys(directory)) {
    const record = await readRecord(directory, key);
    if (!record || record.tampered || record.status !== 'waiting' || (workId && record.workId !== workId)) continue;
    await writeRecord(directory, { ...record, status: 'pending', nextAttemptAt: nowIso(clock), updatedAt: nowIso(clock) });
    released += 1;
  }
  return released;
}

/**
 * Deliver what is due, within a time budget. With `keys`, deliver exactly those records now,
 * ignoring their wait; with `includeFailed`, failed records are tried again with a fresh budget.
 */
export async function deliverStepActions(root, {
  keys = null, includeFailed = false, budgetMs = INLINE_DELIVERY_BUDGET_MS, env = process.env, clock = Date.now,
  post = postDelivery, logger = null, concurrency = 4, writers = STEP_ACTION_WRITERS
} = {}) {
  const directory = outboxPath(root);
  const started = clock();
  const chosen = keys ? [...new Set(keys)] : await recordKeys(directory);
  const due = [];
  const report = { delivered: [], retrying: [], failed: [], unavailable: [], skipped: [], tampered: [] };
  for (const key of chosen) {
    const record = await readRecord(directory, key);
    if (!record) { if (keys) report.skipped.push({ key, reason: 'unknown' }); continue; }
    if (record.tampered) { report.tampered.push({ key }); continue; }
    if (record.status === 'delivered' || record.status === 'waiting') { if (keys) report.skipped.push({ key, reason: record.status }); continue; }
    // A pipeline delivers its own targets; a person can still name one to deliver it from here.
    if (record.status === 'pipeline' && !keys) continue;
    if (record.status === 'failed' && !(includeFailed || keys)) continue;
    if (!keys && record.status === 'pending' && record.nextAttemptAt && Date.parse(record.nextAttemptAt) > clock()) continue;
    due.push(record.status === 'failed' ? { ...record, status: 'pending', attempts: record.attempts.map((attempt) => (
      attempt.outcome === 'retry' ? { ...attempt, outcome: 'retried' } : attempt)) } : record);
  }
  let index = 0;
  const worker = async () => {
    while (index < due.length) {
      if (clock() - started > budgetMs) return;
      const record = due[index++];
      const outcome = await withRecordLock(directory, record.key, clock, () => attemptRecord(directory, record, { env, clock, post, logger, writers, root }));
      if (outcome?.skipped) { report.skipped.push({ key: record.key, reason: outcome.skipped }); continue; }
      const last = outcome.attempts.at(-1);
      const entry = { key: record.key, action: record.action.id, target: record.action.target, trigger: record.trigger,
        phaseId: record.phaseId, workId: record.workId, status: last?.status ?? null, code: last?.code ?? null, detail: last?.detail ?? null };
      if (outcome.status === 'delivered') report.delivered.push(entry);
      else if (outcome.status === 'failed') report.failed.push(entry);
      else if (last?.outcome === 'unavailable') report.unavailable.push(entry);
      else report.retrying.push(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, due.length)) }, worker));
  report.notReached = due.slice(index).map((record) => record.key);
  return report;
}

/** Every delivery in the outbox, newest first, without request bodies. */
export async function listStepActionDeliveries(root, { workId = null, includeDelivered = true } = {}) {
  const directory = outboxPath(root);
  const records = [];
  for (const key of await recordKeys(directory)) {
    const record = await readRecord(directory, key);
    if (!record) continue;
    if (record.tampered) { records.push({ key, status: 'tampered' }); continue; }
    if (workId && record.workId !== workId) continue;
    if (!includeDelivered && record.status === 'delivered') continue;
    records.push({
      key, status: record.status, workId: record.workId, phaseId: record.phaseId, generation: record.generation,
      trigger: record.trigger, action: record.action.id, target: record.action.target, kind: record.action.targetSpec.kind,
      send: record.action.send, required: record.action.required === true, commit: record.commit, createdAt: record.createdAt, updatedAt: record.updatedAt,
      deliveredAt: record.deliveredAt, nextAttemptAt: record.nextAttemptAt,
      attempts: record.attempts.length, lastAttempt: record.attempts.at(-1) ?? null
    });
  }
  return records.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

/** One delivery record as this machine's outbox holds it: null when it has none, `{ tampered }` when its seal no longer matches. */
export async function readStepActionDelivery(root, key) {
  return readRecord(outboxPath(root), key);
}

/**
 * Every delivered record in the outbox, whole, for one Story when `workId` is given. Receipts are
 * made from these; a record whose seal no longer matches its contents is never returned.
 */
export async function readDeliveredStepActions(root, { workId = null } = {}) {
  const directory = outboxPath(root);
  const delivered = [];
  for (const key of await recordKeys(directory)) {
    const record = await readRecord(directory, key);
    if (!record || record.tampered || record.status !== 'delivered') continue;
    if (workId && record.workId !== workId) continue;
    delivered.push(record);
  }
  return delivered;
}

function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }

/** One line a person can act on, or null when everything went out. */
export function stepActionWarning(report) {
  if (!report) return null;
  const problems = [...report.failed, ...report.retrying, ...report.unavailable];
  if (!problems.length) return null;
  const first = problems[0];
  const reason = first.status ? `HTTP ${first.status}` : (first.detail ?? first.code ?? 'not delivered');
  return `${plural(problems.length, 'after-step action')} not delivered yet (${first.action} → ${first.target}: ${reason}). `
    + (report.failed.length
      ? 'Fix the target, then run singularity-flow integrations retry.'
      : 'It will be retried; singularity-flow integrations status shows each delivery.');
}

/** Whether a Story pinned any after-step action; a Story that did costs nothing at its transitions. */
export function storyUsesStepActions(workflow) {
  return (workflow?.resolution?.phases ?? []).some((phase) => Array.isArray(phase?.afterStep) && phase.afterStep.length > 0);
}

/**
 * The step-action work at the end of a governed transition: write what the transition calls for,
 * then deliver what is due in this repository within the inline budget. Never throws. A Story that
 * pinned no actions returns at once, without touching Git or the outbox.
 */
export async function runStepActionsAfterTransition(root, workflow, {
  event, commit, remote = null, published = true, env = process.env, clock = Date.now, post = postDelivery, logger = null,
  budgetMs = INLINE_DELIVERY_BUDGET_MS
} = {}) {
  if (!storyUsesStepActions(workflow)) {
    return { queued: [], waiting: [], delivered: [], retrying: [], failed: [], unavailable: [], skipped: [], tampered: [], notReached: [] };
  }
  try {
    const queued = await enqueueStepActions(root, workflow, { event, commit, remote, published, clock });
    const report = await deliverStepActions(root, { env, clock, post, logger, budgetMs });
    const waiting = queued.filter((record) => record.status === 'waiting').map((record) => record.key);
    return { queued: queued.map((record) => record.key), waiting, ...report };
  } catch (error) {
    return { queued: [], waiting: [], delivered: [], retrying: [], failed: [], unavailable: [], skipped: [], tampered: [], notReached: [],
      error: { code: error?.code ?? 'STEP_ACTION_RUNTIME_FAILED', message: boundedDetail(error?.message) } };
  }
}
