/**
 * A small, bounded MCP client for content a person asks to import from an approved MCP server:
 * a prompt, a resource, or the text a tool returns.
 *
 * Agents keep using MCP servers through their host (VS Code or Copilot); this client exists only for
 * an explicit import. It reads the server's host entry from the same files the hosts read, contacts
 * the server only after the caller has the person's consent, and never runs during Story execution.
 * Both transports are bounded in time and bytes, and a launched server's whole process tree is
 * stopped afterwards.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import { resolvePlatformProcess } from './platform-process.mjs';
import { SingularityFlowError, exists, signalProcessTree } from './util.mjs';

export const MCP_CLIENT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const LINE_MAX_BYTES = 4 * 1024 * 1024;
const STDERR_KEEP_BYTES = 16 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function fail(message, code = 'MCP_CLIENT_FAILED', details = undefined) {
  return new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

/** The host configuration files the hosts read, in the order a name is resolved. */
export function mcpHostSources(root, home = os.homedir()) {
  return [
    { surface: 'vscode-workspace', file: path.join(root, '.vscode', 'mcp.json'), key: 'servers' },
    { surface: 'copilot-workspace', file: path.join(root, '.mcp.json'), key: 'mcpServers' },
    { surface: 'copilot-user', file: path.join(home, '.copilot', 'mcp-config.json'), key: 'mcpServers' }
  ];
}

function substitute(value, { root, home, label }) {
  if (typeof value !== 'string') throw fail(`${label} must be text.`, 'MCP_HOST_ENTRY_INVALID');
  return value.replace(/\$\{([^}]+)\}/g, (match, name) => {
    if (name === 'workspaceFolder') return root;
    if (name === 'userHome') return home;
    if (name.startsWith('env:')) return process.env[name.slice(4)] ?? '';
    if (name.startsWith('input:')) {
      throw fail(`${label} asks the host for '${name}', which only VS Code can prompt for. Provide it through an environment variable (\${env:NAME}) to import from this server.`, 'MCP_HOST_INPUT_UNSUPPORTED');
    }
    throw fail(`${label} uses '${match}', which Singularity Flow cannot resolve.`, 'MCP_HOST_ENTRY_INVALID');
  });
}

function stringMap(value, label, context) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object of text values.`, 'MCP_HOST_ENTRY_INVALID');
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, { ...context, label: `${label}.${key}` })]));
}

/** A host entry as a transport this client can open. */
export function mcpTransportFromEntry(entry, { root, home = os.homedir(), name = 'server' } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail(`MCP host entry '${name}' must be an object.`, 'MCP_HOST_ENTRY_INVALID');
  const context = { root, home };
  const type = entry.type ?? (entry.command ? 'stdio' : entry.url ? 'http' : null);
  if (type === 'stdio') {
    if (entry.envFile != null) throw fail(`MCP host entry '${name}' reads an envFile; import from it with plain env values instead.`, 'MCP_HOST_ENTRY_INVALID');
    const command = substitute(entry.command ?? '', { ...context, label: `MCP host entry '${name}' command` }).trim();
    if (!command) throw fail(`MCP host entry '${name}' has no command.`, 'MCP_HOST_ENTRY_INVALID');
    const args = Array.isArray(entry.args ?? []) ? (entry.args ?? []).map((arg, index) => substitute(arg, { ...context, label: `MCP host entry '${name}' args[${index}]` })) : null;
    if (!args) throw fail(`MCP host entry '${name}' args must be a list.`, 'MCP_HOST_ENTRY_INVALID');
    return Object.freeze({ type: 'stdio', command, args: Object.freeze(args), env: Object.freeze(stringMap(entry.env, `MCP host entry '${name}' env`, context)), cwd: root });
  }
  if (type === 'http' || type === 'sse') {
    if (type === 'sse') throw fail(`MCP host entry '${name}' uses the older SSE transport; this client speaks streamable HTTP only.`, 'MCP_HOST_ENTRY_UNSUPPORTED');
    const url = substitute(entry.url ?? '', { ...context, label: `MCP host entry '${name}' url` });
    let parsed;
    try { parsed = new URL(url); } catch { throw fail(`MCP host entry '${name}' url is not a valid URL.`, 'MCP_HOST_ENTRY_INVALID'); }
    if (parsed.username || parsed.password) throw fail(`MCP host entry '${name}' url must not carry credentials.`, 'MCP_HOST_ENTRY_INVALID');
    if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)))) {
      throw fail(`MCP host entry '${name}' must use HTTPS, or plain HTTP only on this machine (localhost).`, 'MCP_HOST_ENTRY_INVALID');
    }
    return Object.freeze({ type: 'http', url: parsed.toString(), headers: Object.freeze(stringMap(entry.headers, `MCP host entry '${name}' headers`, context)) });
  }
  throw fail(`MCP host entry '${name}' has type '${entry.type}', which this client cannot open.`, 'MCP_HOST_ENTRY_UNSUPPORTED');
}

/** The first host entry for `hostReference`, from the same files and in the same order the hosts use. */
export async function resolveMcpHostEntry(root, hostReference, { home = os.homedir() } = {}) {
  for (const source of mcpHostSources(root, home)) {
    if (!(await exists(source.file))) continue;
    let document;
    try { document = JSON.parse(await readFile(source.file, 'utf8')); }
    catch (error) { throw fail(`${source.file} is not valid JSON: ${error.message}`, 'MCP_HOST_CONFIG_INVALID'); }
    const servers = document?.[source.key] ?? document?.servers ?? document?.mcpServers ?? {};
    if (servers && Object.hasOwn(servers, hostReference)) {
      return { surface: source.surface, file: source.file, name: hostReference, entry: servers[hostReference] };
    }
  }
  throw fail(`No VS Code or Copilot MCP configuration defines a server named '${hostReference}'.`, 'MCP_HOST_ENTRY_MISSING');
}

/**
 * What contacting this server means, in words a person can consent to. Header values can carry
 * tokens, so only their names are shown.
 */
export function describeMcpTransport(transport) {
  if (transport.type === 'stdio') {
    const quote = (value) => (/^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value));
    return `runs ${[transport.command, ...transport.args].map(quote).join(' ')} in ${transport.cwd}`;
  }
  const headers = Object.keys(transport.headers ?? {});
  return `connects to ${transport.url}${headers.length ? ` with header(s) ${headers.join(', ')}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Sessions

function jsonRpcError(method, error) {
  return fail(`The MCP server refused ${method}: ${error?.message ?? 'unknown error'}`, 'MCP_REQUEST_FAILED', { code: error?.code ?? null });
}

/** A stdio session: newline-delimited JSON-RPC over the launched process's stdin and stdout. */
async function openStdioSession(transport, { timeoutMs, maxBytes, spawnImpl = spawn, environment = process.env }) {
  const launch = resolvePlatformProcess(transport.command, transport.args, { environment });
  const child = spawnImpl(launch.executable, launch.arguments, {
    cwd: transport.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, ...transport.env },
    windowsHide: true, detached: process.platform !== 'win32', ...launch.spawnOptions
  });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let failure = null;
  let received = 0;
  let stderr = '';
  let line = '';
  const decoder = new StringDecoder('utf8');
  const closedWaiters = new Set();
  const rejectAll = (error) => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on('error', (error) => rejectAll(fail(`Could not start the MCP server: ${error.message}`, 'MCP_LAUNCH_FAILED')));
  child.on('exit', (code) => rejectAll(fail(`The MCP server exited (${code ?? 'signal'}) before it answered.${stderr.trim() ? ` It said: ${stderr.trim().slice(-400)}` : ''}`, 'MCP_SERVER_EXITED')));
  child.on('close', () => { closed = true; for (const waiter of [...closedWaiters]) waiter(); });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-STDERR_KEEP_BYTES); });
  child.stdout.on('data', (chunk) => {
    received += chunk.length;
    if (received > maxBytes) { rejectAll(fail(`The MCP server sent more than ${maxBytes} bytes.`, 'MCP_RESPONSE_TOO_LARGE')); return; }
    line += decoder.write(chunk);
    let newline;
    while ((newline = line.indexOf('\n')) >= 0) {
      const text = line.slice(0, newline).replace(/\r$/, '');
      line = line.slice(newline + 1);
      if (!text.trim()) continue;
      let message;
      try { message = JSON.parse(text); } catch { continue; } // servers may log to stdout; only JSON-RPC counts
      if (message?.id == null || !pending.has(message.id)) continue;
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter.reject(jsonRpcError(waiter.method, message.error)); else waiter.resolve(message.result);
    }
    if (Buffer.byteLength(line, 'utf8') > LINE_MAX_BYTES) rejectAll(fail('The MCP server sent a message larger than the client accepts.', 'MCP_RESPONSE_TOO_LARGE'));
  });
  const send = (message) => { if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`); };
  return {
    request(method, params = {}) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(fail(`The MCP server did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`, 'MCP_TIMEOUT')); }, timeoutMs);
        pending.set(id, { method, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params = {}) { send({ jsonrpc: '2.0', method, params }); return Promise.resolve(); },
    async close() {
      try { child.stdin.end(); } catch { /* already closed */ }
      const waitClosed = (milliseconds) => (closed ? Promise.resolve(true) : new Promise((resolve) => {
        const done = () => { clearTimeout(timer); closedWaiters.delete(done); resolve(true); };
        const timer = setTimeout(() => { closedWaiters.delete(done); resolve(false); }, milliseconds);
        closedWaiters.add(done);
      }));
      if (await waitClosed(300)) return;
      await signalProcessTree(child, 'SIGTERM').catch(() => false);
      if (await waitClosed(1000)) return;
      await signalProcessTree(child, 'SIGKILL').catch(() => false);
      await waitClosed(1000);
    }
  };
}

/** The JSON-RPC message an SSE body carries for `id`, read until it arrives or the stream ends. */
async function responseFromEventStream(response, id, maxBytes) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw fail(`The MCP server sent more than ${maxBytes} bytes.`, 'MCP_RESPONSE_TOO_LARGE');
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let message;
        try { message = JSON.parse(data); } catch { continue; }
        const messages = Array.isArray(message) ? message : [message];
        const match = messages.find((entry) => entry?.id === id);
        if (match) return match;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* the stream may already be closed */ }
  }
  throw fail('The MCP server closed its event stream without answering.', 'MCP_REQUEST_FAILED');
}

/** A streamable HTTP session: one POST per JSON-RPC message, following the server's session ID. */
function openHttpSession(transport, { timeoutMs, maxBytes, fetchImpl = globalThis.fetch }) {
  let sessionId = null;
  let protocolVersion = null;
  let nextId = 1;
  const headers = () => ({
    ...transport.headers,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {})
  });
  const post = async (body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(transport.url, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    } catch (error) {
      throw fail(`Could not reach the MCP server at ${transport.url}: ${error.name === 'AbortError' ? 'it did not answer in time' : error.message}`, 'MCP_UNREACHABLE');
    } finally { clearTimeout(timer); }
  };
  return {
    async request(method, params = {}) {
      const id = nextId++;
      const response = await post({ jsonrpc: '2.0', id, method, params });
      if (!response.ok) throw fail(`The MCP server answered ${method} with HTTP ${response.status}.`, 'MCP_REQUEST_FAILED');
      sessionId = response.headers.get('mcp-session-id') ?? sessionId;
      const type = String(response.headers.get('content-type') ?? '');
      let message;
      if (type.includes('text/event-stream')) message = await responseFromEventStream(response, id, maxBytes);
      else {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) throw fail(`The MCP server sent more than ${maxBytes} bytes.`, 'MCP_RESPONSE_TOO_LARGE');
        try { message = JSON.parse(bytes.toString('utf8')); } catch { throw fail(`The MCP server's answer to ${method} is not JSON.`, 'MCP_REQUEST_FAILED'); }
        if (Array.isArray(message)) message = message.find((entry) => entry?.id === id);
      }
      if (!message || message.id !== id) throw fail(`The MCP server did not answer ${method}.`, 'MCP_REQUEST_FAILED');
      if (message.error) throw jsonRpcError(method, message.error);
      if (method === 'initialize') protocolVersion = message.result?.protocolVersion ?? MCP_CLIENT_PROTOCOL_VERSION;
      return message.result;
    },
    async notify(method, params = {}) {
      const response = await post({ jsonrpc: '2.0', method, params });
      if (!response.ok && response.status !== 202) throw fail(`The MCP server refused ${method} (HTTP ${response.status}).`, 'MCP_REQUEST_FAILED');
    },
    async close() {
      if (!sessionId) return;
      try { await fetchImpl(transport.url, { method: 'DELETE', headers: headers(), redirect: 'error' }); } catch { /* the session expires on its own */ }
    }
  };
}

/**
 * Open a session, initialize it, run `work(session)`, and always close it. The session offers
 * `request(method, params)`, `serverInfo` and `capabilities`.
 */
export async function withMcpSession(transport, work, {
  timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, clientVersion = '1', fetchImpl, spawnImpl, environment
} = {}) {
  const session = transport.type === 'stdio'
    ? await openStdioSession(transport, { timeoutMs, maxBytes, spawnImpl, environment })
    : openHttpSession(transport, { timeoutMs, maxBytes, fetchImpl });
  try {
    const initialized = await session.request('initialize', {
      protocolVersion: MCP_CLIENT_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: 'singularity-flow-import', version: clientVersion }
    });
    await session.notify('notifications/initialized');
    return await work({
      request: (method, params) => session.request(method, params),
      serverInfo: initialized?.serverInfo ?? null,
      capabilities: initialized?.capabilities ?? {},
      protocolVersion: initialized?.protocolVersion ?? null
    });
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Results as text

function textOfContent(content) {
  if (!content || typeof content !== 'object') return '';
  if (content.type === 'text') return String(content.text ?? '');
  if (content.type === 'resource' && content.resource) return String(content.resource.text ?? '');
  return '';
}

/** The text a prompt expands to: every text part of every message, in order. */
export function promptText(result) {
  const parts = (result?.messages ?? []).map((message) => textOfContent(message?.content)).filter((text) => text.trim());
  if (!parts.length) throw fail('The MCP prompt returned no text.', 'MCP_RESULT_EMPTY');
  return parts.join('\n\n');
}

/** The text of a resource: its text contents, or a text-typed blob decoded. */
export function resourceText(result) {
  const parts = (result?.contents ?? []).map((entry) => {
    if (typeof entry?.text === 'string') return entry.text;
    if (typeof entry?.blob === 'string' && /^(text\/|application\/(json|yaml|x-yaml|markdown))/.test(String(entry.mimeType ?? ''))) {
      return Buffer.from(entry.blob, 'base64').toString('utf8');
    }
    return '';
  }).filter((text) => text.trim());
  if (!parts.length) throw fail('The MCP resource has no text content.', 'MCP_RESULT_EMPTY');
  return parts.join('\n\n');
}

/** The text a tool returned. A tool that reports an error is refused with what it said. */
export function toolText(result) {
  const parts = (result?.content ?? []).map(textOfContent).filter((text) => text.trim());
  if (result?.isError) throw fail(`The MCP tool reported an error: ${parts.join(' ').slice(0, 400) || 'no detail'}`, 'MCP_TOOL_ERROR');
  if (!parts.length && result?.structuredContent != null) return `${JSON.stringify(result.structuredContent, null, 2)}\n`;
  if (!parts.length) throw fail('The MCP tool returned no text.', 'MCP_RESULT_EMPTY');
  return parts.join('\n\n');
}
