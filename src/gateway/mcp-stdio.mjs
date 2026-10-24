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
import { noEffects, preservedAll, sflowResult } from './result.mjs';
import { SFLOW_TOOLS } from './tools.mjs';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;
/** The longest line a client may send; tool arguments are schema-bounded far below it. */
export const MCP_MAX_LINE_BYTES = 4 * 1024 * 1024;

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

/** The words a person sees before confirming: the kernel's confirmation text, effects first. */
function confirmationMessage(review) {
  return `${review.confirmationText.title}\n${review.confirmationText.detail}`;
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

  const queue = [];
  const invalid = (id, message) => send({ id, error: { code: -32600, message } });
  /**
   * One line, judged before anything reads a field of it. Whatever a client writes, the answer is a
   * JSON-RPC error and the server keeps serving: a `null` here used to throw in this listener and
   * take the process down, and a batch got no reply at all.
   */
  function receive(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    // The protocol version served here removed JSON-RPC batching, so a batch is one invalid request.
    if (Array.isArray(message)) { invalid(null, `Batches are not supported in MCP ${MCP_PROTOCOL_VERSION}; send one message per line.`); return; }
    if (!message || typeof message !== 'object') { invalid(null, 'A message must be a JSON-RPC object.'); return; }
    const { id } = message;
    if (id !== undefined && id !== null && typeof id !== 'string' && !Number.isFinite(id)) { invalid(null, 'A request id is a string or a number.'); return; }
    const answer = id === undefined ? null : id;
    if (message.jsonrpc !== '2.0') { invalid(answer, 'A message must declare jsonrpc "2.0".'); return; }
    if (message.method === undefined && id !== undefined) {
      // A response: to our own request, which must not wait behind the call waiting for it, or to
      // nothing we asked, which is dropped — answering a response would start a loop.
      if (pending.has(id)) handle(message);
      return;
    }
    if (typeof message.method !== 'string') { invalid(answer, 'A request names its method as a string.'); return; }
    if (message.params !== undefined && (message.params === null || typeof message.params !== 'object' || Array.isArray(message.params))) {
      invalid(answer, 'Request params are an object.');
      return;
    }
    if (message.method === 'tools/call' && message.params?.arguments !== undefined
        && (message.params.arguments === null || typeof message.params.arguments !== 'object' || Array.isArray(message.params.arguments))) {
      send({ id: answer, error: { code: -32602, message: 'Tool arguments are an object.' } });
      return;
    }
    queue.push(handle(message));
  }

  return new Promise((resolve) => {
    // Lines are split here rather than by readline, which buffers a line of any length: past the cap
    // the rest of that line is discarded as it arrives, and the line is refused as a whole.
    let parts = [];
    let size = 0;
    let dropping = false;
    const finish = (piece) => {
      if (dropping || size + piece.length > MCP_MAX_LINE_BYTES) invalid(null, `Message too large: one line holds at most ${MCP_MAX_LINE_BYTES} bytes.`);
      else receive(Buffer.concat([...parts, piece]).toString('utf8').replace(/\r$/u, ''));
      parts = []; size = 0; dropping = false;
    };
    input.on('data', (chunk) => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      let start = 0;
      for (let at = data.indexOf(10); at !== -1; at = data.indexOf(10, start)) {
        finish(data.subarray(start, at));
        start = at + 1;
      }
      const rest = data.subarray(start);
      if (dropping || !rest.length) return;
      if (size + rest.length > MCP_MAX_LINE_BYTES) { dropping = true; parts = []; size = 0; return; }
      parts.push(rest);
      size += rest.length;
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (dropping || size) finish(Buffer.alloc(0));
      Promise.allSettled(queue).then(resolve);
    };
    input.on('end', close);
    input.on('close', close);
  });
}
