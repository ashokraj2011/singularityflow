/**
 * One structured event per gateway invocation, useful without private reasoning.
 * `[INT:IFC-070]` `[INT:CON-140]` `[INT:REQ-140]` `[INT:CON-141]` `[INT:CON-142]`
 *
 * An event says which tool ran, what it resolved to, about which subject, under which registry and
 * policy, how many candidates it offered, which plan it touched, whether a model selected it, which
 * host, the confirmation state, the effects, the outcome, how long it took and a correlation ID.
 * It never says what the person typed: an utterance is a keyed hash (the key is machine-local and
 * never leaves this machine), and no prompt, secret, confirmation value, receipt, source excerpt or
 * model reasoning is ever an argument to this module, so none can be written by it.
 *
 * Nothing here persists a confirmation value, receipt, secret or raw prompt `[INT:CON-103]`.
 * Machine-local, append-only and bounded: the newest events are kept and older ones expire, because
 * these are transient guide-session records, not evidence. Evidence keeps its own handles.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { activeWorkspaceFile } from '../workspace-context.mjs';

const MAX_EVENTS = 2000;

export function gatewayEventsFile(env = process.env) {
  return path.join(path.dirname(activeWorkspaceFile(env)), 'gateway-events.jsonl');
}

async function intentKey(env) {
  const file = path.join(path.dirname(activeWorkspaceFile(env)), 'gateway-intent.key');
  try { return Buffer.from((await readFile(file, 'utf8')).trim(), 'base64url'); } catch {
    const key = randomBytes(32);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${key.toString('base64url')}\n`, { mode: 0o600, flag: 'wx' }).catch(() => {});
    try { return Buffer.from((await readFile(file, 'utf8')).trim(), 'base64url'); } catch { return key; }
  }
}

/** The fields an event may carry, and nothing else: a closed shape is what keeps the privacy rule. */
function eventOf({ tool, result, durationMs, host, modelSelected, correlationId, confirmation, intent }) {
  const why = result?.why?.[0] ?? null;
  return {
    at: new Date().toISOString(),
    correlationId,
    tool,
    host,
    modelSelected: Boolean(modelSelected),
    operation: result?.operation?.id ?? null,
    kind: result?.kind ?? null,
    subject: result?.subject ? { kind: result.subject.kind, id: result.subject.id } : null,
    hashes: {
      registry: result?.subject?.revision?.registryHash ?? null,
      policy: result?.subject?.revision?.policyHash ?? null,
      sourceCommit: result?.subject?.revision?.sourceCommit ?? null
    },
    candidateCount: result?.kind === 'candidates' ? result.next.length : 0,
    planId: result?.data?.plan?.handle ?? null,
    confirmation: confirmation ?? 'none',
    effects: result?.effects ?? null,
    outcome: result?.outcome?.status ?? null,
    reason: result?.kind === 'refusal' ? why?.code ?? null : null,
    durationMs,
    intent
  };
}

export async function recordGatewayEvent(input, { env = process.env } = {}) {
  const intent = input.utterance
    ? { keyedHash: createHmac('sha256', await intentKey(env)).update(String(input.utterance)).digest('hex') }
    : null;
  const file = gatewayEventsFile(env);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(eventOf({ ...input, intent }))}\n`, { mode: 0o600 });
  // Bounded: once past twice the ceiling, keep the newest MAX_EVENTS.
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length > MAX_EVENTS * 2) await writeFile(file, `${lines.slice(-MAX_EVENTS).join('\n')}\n`, { mode: 0o600 });
}

/** Events, newest last, filtered the way the Logs view asks `[INT:REQ-141]`. */
export async function readGatewayEvents({ subject = null, host = null, operation = null, outcome = null, reason = null,
  modelSelected = null, correlationId = null, limit = 200, env = process.env } = {}) {
  let text = '';
  try { text = await readFile(gatewayEventsFile(env), 'utf8'); } catch { return []; }
  const events = text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  return events.filter((event) => (!subject || event.subject?.id === subject)
    && (!host || event.host === host) && (!operation || event.operation === operation)
    && (!outcome || event.outcome === outcome) && (!reason || event.reason === reason)
    && (modelSelected == null || event.modelSelected === modelSelected)
    && (!correlationId || event.correlationId === correlationId)).slice(-limit);
}

/**
 * The kernel, with every tool call recorded. The wrapper sees the request and the result and
 * records only the closed event shape; the receipt argument of `run` is never read.
 */
export function auditedKernel(kernel, { host, modelSelected = false, env = process.env } = {}) {
  const timed = (tool, call, utteranceOf = () => null) => async (request = {}, ...rest) => {
    const started = Date.now();
    const correlationId = `cor_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const result = await call(request, ...rest);
    await recordGatewayEvent({
      tool, result, durationMs: Date.now() - started, host, modelSelected, correlationId,
      confirmation: tool === 'sflow_run' ? (rest[0]?.confirmationReceiptId ? 'receipt-presented' : 'none') : 'none',
      utterance: utteranceOf(request)
    }, { env }).catch(() => {});
    return result;
  };
  return Object.freeze({
    ...kernel,
    resolve: timed('sflow_resolve', (request, options) => kernel.resolve(request, options), (request) => request.utterance),
    read: timed('sflow_read', (request) => kernel.read(request)),
    // `next` stays synchronous for the hosts that render from it; its event is written behind it.
    next(request = {}) {
      const started = Date.now();
      const result = kernel.next(request);
      recordGatewayEvent({ tool: 'sflow_next', result, durationMs: Date.now() - started, host, modelSelected,
        correlationId: `cor_${randomUUID().replaceAll('-', '').slice(0, 20)}` }, { env }).catch(() => {});
      return result;
    },
    explain: timed('sflow_explain', (request) => kernel.explain(request), (request) => request.question),
    run: timed('sflow_run', (request, confirmation) => kernel.run(request, confirmation))
  });
}
