/**
 * The local MCP adapter: the same five tools, the same kernel, over stdio. `[INT:IFC-062]` `[INT:CON-020]`
 *
 * There was no `gateway` command and no stdio transport before this module. It speaks JSON-RPC 2.0,
 * one message per line, and implements the MCP methods a tool server needs — `initialize`,
 * `tools/list`, `tools/call`, `ping` — plus one request it sends: `elicitation/create`, the host's
 * own trusted UI, which is how a person confirms a plan here without the model seeing it.
 *
 * Capability negotiation is the first thing that happens `[INT:IFC-063]`: what the client declares
 * at `initialize` becomes the kernel's host capabilities before any plan is offered. A client that
 * cannot elicit gets every plan to read and none to run, and is told the explicit command instead
 * `[INT:CON-133]` `[INT:REQ-130]`. The adapter contains no lifecycle logic `[INT:CON-033]`: every
 * answer is the kernel's, serialized; MCP configuration carries no credentials `[INT:CON-132]`.
 */
import { createInterface } from 'node:readline';

import { noEffects, preservedAll, sflowResult } from './result.mjs';
import { SFLOW_TOOLS } from './tools.mjs';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;

/** What an MCP client's `initialize` declares, as the kernel's host capability record. */
export function negotiatedCapabilities(params = {}) {
  const declared = params?.capabilities ?? {};
  const sflow = declared.experimental?.sflow ?? {};
  return Object.freeze({
    schemaVersion: 2,
    confirmationChannel: declared.elicitation ? 'native' : 'none',
    hostActions: [],
    previewBytes: Number.isInteger(sflow.previewBytes) ? Math.min(sflow.previewBytes, 64 * 1024) : 16 * 1024,
    uriHandling: false,
    modelAvailable: true,
    externalProviders: Array.isArray(sflow.externalProviders) ? sflow.externalProviders.map(String).slice(0, 8) : []
  });
}

function refusal(code, slots = {}) {
  return sflowResult({
    kind: 'refusal', operation: { id: 'gateway.run', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots }, effects: noEffects(),
    why: [{ code, source: 'deterministic', slots }], preserved: preservedAll('gateway.nothing-was-carried-out'), restState: 'blocked'
  });
}

/** The words a person sees before confirming: the exact preview, and what it will change. */
function confirmationMessage(review) {
  const preview = review.review?.preview ?? {};
  const changes = Object.entries(review.effects).filter(([, value]) => value).map(([key]) => key);
  return [`Confirm: ${String(preview.action ?? review.operationId).replaceAll('-', ' ')}`,
    ...Object.entries(preview).filter(([key]) => key !== 'action')
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`),
    `This will change: ${changes.length ? changes.join(', ') : 'nothing'}`].join('\n').slice(0, 4000);
}

/**
 * Serve one MCP session. `createKernel(capabilities)` builds the host gateway once the client has
 * declared what it can do; everything after that is dispatch.
 */
export function serveMcp({ input, output, createKernel, serverInfo, log = () => {} }) {
  const pending = new Map();
  let kernel = null;
  let capabilities = negotiatedCapabilities();
  let nextId = 1;
  const send = (message) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = `sflow-${nextId++}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('elicitation timed out')); }, ELICITATION_TIMEOUT_MS);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
    send({ id, method, params });
  });

  /** `sflow_run`: a confirmation collected by the client's own UI, exchanged for a receipt here. */
  async function confirmAndRun(planId) {
    if (capabilities.confirmationChannel !== 'native') return refusal('gateway.confirmation-channel-unavailable');
    let review;
    try { review = kernel.planReview(planId); } catch { return kernel.run({ planId }); }
    const subject = String(review.review?.preview?.subject?.id ?? review.review?.preview?.workspace?.id ?? '');
    const exact = review.confirmation === 'exact-confirm';
    const answer = await request('elicitation/create', {
      message: confirmationMessage(review),
      requestedSchema: exact
        ? { type: 'object', properties: { confirm: { type: 'string', title: `Type ${subject} to confirm exactly this record` } }, required: ['confirm'] }
        : { type: 'object', properties: { confirm: { type: 'boolean', title: 'Carry this out' } }, required: ['confirm'] }
    }).catch(() => null);
    const accepted = answer?.action === 'accept' && (exact ? answer.content?.confirm === subject : answer.content?.confirm === true);
    if (!accepted) return refusal('gateway.confirmation-declined');
    // The receipt exists only inside this call: from confirmPlan straight into run, never serialized.
    const receipt = kernel.confirmPlan({ planId, planHash: review.planHash, reviewDigest: review.review?.digest ?? null });
    return kernel.run({ planId }, { confirmationReceiptId: receipt.receiptId, confirmationValue: receipt.value });
  }

  async function call(name, args = {}) {
    if (name === 'sflow_resolve') {
      const { subject = null, ...rest } = args;
      return kernel.resolve(rest, subject ? { subject: { kind: subject.workId ? 'story' : 'repository', id: subject.workId ?? subject.repositoryId ?? null } } : {});
    }
    if (name === 'sflow_read') return kernel.read({ resolutionId: args.resolutionId });
    if (name === 'sflow_next') return kernel.next({ scope: args.scope, subject: args.subject ?? null });
    if (name === 'sflow_run') return confirmAndRun(args.planId);
    if (name === 'sflow_explain') return kernel.explain({ question: args.question, topic: args.topic });
    return null;
  }

  async function handle(message) {
    if (message.id !== undefined && !message.method && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'client error'));
      else waiter.resolve(message.result);
      return;
    }
    const { id, method, params = {} } = message;
    try {
      if (method === 'initialize') {
        capabilities = negotiatedCapabilities(params);
        kernel = await createKernel(capabilities);
        return send({ id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo,
          instructions: 'Resolve what the person asked with sflow_resolve; read, explain or run only what it returns. The kernel decides what is legal.' } });
      }
      if (method === 'notifications/initialized' || id === undefined) return undefined;
      if (method === 'ping') return send({ id, result: {} });
      if (method === 'tools/list') {
        return send({ id, result: { tools: SFLOW_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } });
      }
      if (method === 'tools/call') {
        if (!kernel) return send({ id, error: { code: -32002, message: 'Initialize the session first.' } });
        const result = await call(params.name, params.arguments ?? {});
        if (!result) return send({ id, error: { code: -32602, message: `'${params.name}' is not one of the five SFlow tools.` } });
        return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.kind === 'refusal' } });
      }
      return send({ id, error: { code: -32601, message: `Method '${method}' is not supported.` } });
    } catch (error) {
      log(`[gateway] ${method}: ${error?.code ?? error?.message ?? error}`);
      return send({ id, error: { code: -32603, message: String(error?.code ?? 'internal error').slice(0, 120) } });
    }
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  const queue = [];
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    // Responses to our own requests must not wait behind the call that is waiting for them.
    if (message.id !== undefined && !message.method) { handle(message); return; }
    queue.push(handle(message));
  });
  return new Promise((resolve) => lines.on('close', () => Promise.allSettled(queue).then(resolve)));
}
