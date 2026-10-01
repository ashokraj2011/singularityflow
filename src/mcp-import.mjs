/**
 * Importing from an approved MCP server: a prompt, a resource, or a tool's answer becomes content to
 * preview, pin and vendor exactly like a skill or template from a link.
 *
 * Three gates, all deliberate: the repository's governed policy names what may be read
 * (`mcpServers.<id>.sources`), the person consents to contacting the server for this import
 * (`--launch`, after seeing what it runs or where it connects), and what comes back is checked and
 * staged like any other import. A server's output is not reproducible on another machine, so the
 * vendored copy is the only copy anything ever reads.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import {
  describeMcpTransport, mcpTransportFromEntry, promptText, resolveMcpHostEntry, resourceText, toolText,
  withMcpSession
} from './mcp-client.mjs';
import { mcpSourceAllowed, normalizeMcpServers } from './mcp.mjs';
import { sha256Hex } from './remote-fetch.mjs';
import { scanText } from './secrets.mjs';
import { SingularityFlowError } from './util.mjs';

const WORKFLOW_PATH = 'singularity/workflow.yml';
const METHODS = Object.freeze({ prompt: 'prompts', resource: 'resources', tool: 'tools' });
const MAX_ARGUMENTS = 32;

function fail(message, code, details = undefined) {
  return new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

/** `mcp:<server>/prompt|resource|tool/<name>`; a resource URI is percent-encoded. */
export function parseMcpReference(text) {
  const match = /^mcp:([a-z0-9]+(?:-[a-z0-9]+)*)\/(prompt|resource|tool)\/(.+)$/.exec(String(text ?? '').trim());
  if (!match) throw fail(`'${text}' is not an MCP reference; use mcp:<server>/prompt/<name>, mcp:<server>/resource/<encoded URI> or mcp:<server>/tool/<name>.`, 'IMPORT_REFERENCE_UNSUPPORTED');
  let name;
  try { name = match[2] === 'resource' ? decodeURIComponent(match[3]) : match[3]; }
  catch { throw fail(`The resource in '${text}' is not correctly percent-encoded.`, 'IMPORT_REFERENCE_UNSUPPORTED'); }
  if (match[2] !== 'resource' && /[\s/]/.test(name)) throw fail(`The ${match[2]} name in '${text}' must be one word.`, 'IMPORT_REFERENCE_UNSUPPORTED');
  return Object.freeze({ kind: 'mcp', server: match[1], method: match[2], name, display: String(text).trim() });
}

/** The agent-table URL that names where an MCP import came from (it is never fetched). */
export function mcpSourceUrl(source) {
  return `mcp://${source.server}/${source.method}/${encodeURIComponent(source.name)}`;
}

/** Prompt or tool arguments: a bounded map of text values, checked for secrets. */
export function normalizeMcpArguments(value = {}) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw fail('MCP arguments must be name=value pairs.', 'MCP_ARGUMENTS_INVALID');
  const entries = Object.entries(value);
  if (entries.length > MAX_ARGUMENTS) throw fail(`At most ${MAX_ARGUMENTS} MCP arguments can be given.`, 'MCP_ARGUMENTS_INVALID');
  const normalized = {};
  for (const [name, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw fail(`MCP argument name '${name}' is not valid.`, 'MCP_ARGUMENTS_INVALID');
    const text = String(raw ?? '');
    if (text.length > 4096) throw fail(`MCP argument '${name}' is longer than 4096 characters.`, 'MCP_ARGUMENTS_INVALID');
    normalized[name] = text;
  }
  // Arguments are recorded with the import; a credential must never be one of them.
  if (scanText(Object.entries(normalized).map(([name, text]) => `${name}=${text}`).join('\n'), { path: 'MCP arguments' }).some((finding) => !finding.waived)) {
    throw fail('An MCP argument looks like a credential. Arguments are recorded with the import, so pass credentials to the server through its own configuration instead.', 'MCP_ARGUMENTS_INVALID');
  }
  return normalized;
}

/** The governed MCP servers, read from the effective configuration without loading every agent. */
export async function configuredMcpServers(root) {
  let raw;
  try { raw = YAML.parse(await readFile(path.join(configurationReadRoot(root), WORKFLOW_PATH), 'utf8')) ?? {}; }
  catch (error) { throw fail(`Cannot read the governed MCP servers: ${error.message}`, 'MCP_CONFIGURATION_UNREADABLE'); }
  return normalizeMcpServers(raw.mcpServers ?? {});
}

function requireServer(servers, id) {
  const server = servers[id];
  if (!server) throw fail(`This repository governs no MCP server called '${id}'.`, 'MCP_SERVER_UNKNOWN');
  if (!server.sources) {
    throw fail(`MCP server '${id}' does not allow imports. To import from it, list what may be read under mcpServers.${id}.sources (prompts, resources or tools) in a reviewed workflow change.`, 'MCP_SOURCE_NOT_ALLOWED');
  }
  return server;
}

async function serverTransport(root, server) {
  const host = await resolveMcpHostEntry(root, server.hostReference);
  return { host, transport: mcpTransportFromEntry(host.entry, { root, name: server.hostReference }) };
}

function consent(server, transport, launch) {
  if (launch) return;
  const description = describeMcpTransport(transport);
  throw fail(`Importing from MCP server ${server.label} ${description}. Nothing was started. Repeat with --launch to allow it for this import.`, 'MCP_LAUNCH_CONSENT_REQUIRED', {
    server: server.id, transport: transport.type, description
  });
}

/**
 * Read one prompt, resource or tool answer from an approved server, after consent. Returns the
 * exact text as bytes and the provenance an import records.
 */
export async function fetchMcpContent(root, reference, { launch = false, arguments: args = {}, sessionOptions = {} } = {}) {
  const server = requireServer(await configuredMcpServers(root), reference.server);
  if (!mcpSourceAllowed(server.sources, reference.method, reference.name)) {
    throw fail(`MCP server '${server.id}' does not allow importing ${reference.method} '${reference.name}'. Add it to mcpServers.${server.id}.sources.${METHODS[reference.method]} in a reviewed workflow change.`, 'MCP_SOURCE_NOT_ALLOWED');
  }
  const parameters = normalizeMcpArguments(args);
  if (reference.method === 'resource' && Object.keys(parameters).length) throw fail('An MCP resource takes no arguments.', 'MCP_ARGUMENTS_INVALID');
  const { host, transport } = await serverTransport(root, server);
  consent(server, transport, launch);
  const { text, serverInfo } = await withMcpSession(transport, async (session) => {
    const value = reference.method === 'prompt'
      ? promptText(await session.request('prompts/get', { name: reference.name, arguments: parameters }))
      : reference.method === 'resource'
        ? resourceText(await session.request('resources/read', { uri: reference.name }))
        : toolText(await session.request('tools/call', { name: reference.name, arguments: parameters }));
    return { text: value, serverInfo: session.serverInfo };
  }, sessionOptions);
  return {
    bytes: Buffer.from(text, 'utf8'),
    source: {
      kind: 'mcp', server: server.id, hostReference: server.hostReference, hostSurface: host.surface,
      method: reference.method, name: reference.name, arguments: parameters,
      argumentsSha256: sha256Hex(JSON.stringify(parameters)),
      serverInfo: serverInfo ? { name: String(serverInfo.name ?? ''), version: String(serverInfo.version ?? '') } : null,
      url: mcpSourceUrl({ server: server.id, method: reference.method, name: reference.name })
    }
  };
}

/** Every governed server that allows imports, without contacting any of them. */
export async function importableMcpServers(root) {
  return Object.values(await configuredMcpServers(root)).filter((server) => server.sources)
    .map((server) => ({ id: server.id, label: server.label, hostReference: server.hostReference, sources: server.sources }));
}

/**
 * What an approved server offers that its policy allows importing: prompts with their arguments,
 * resources, and tools with their input schema. Contacting the server needs consent.
 */
export async function listMcpSources(root, serverId, { launch = false, sessionOptions = {} } = {}) {
  const server = requireServer(await configuredMcpServers(root), serverId);
  const { transport } = await serverTransport(root, server);
  consent(server, transport, launch);
  return withMcpSession(transport, async (session) => {
    const capabilities = session.capabilities ?? {};
    const page = async (method, key) => {
      const items = [];
      let cursor;
      for (let pages = 0; pages < 10; pages += 1) {
        const result = await session.request(method, cursor ? { cursor } : {});
        items.push(...(result?.[key] ?? []));
        cursor = result?.nextCursor;
        if (!cursor) break;
      }
      return items;
    };
    const prompts = capabilities.prompts && server.sources.prompts.length ? await page('prompts/list', 'prompts') : [];
    const resources = capabilities.resources && server.sources.resources.length ? await page('resources/list', 'resources') : [];
    const tools = capabilities.tools && server.sources.tools.length ? await page('tools/list', 'tools') : [];
    return {
      schemaVersion: 1,
      resultType: 'mcp-sources',
      server: { id: server.id, label: server.label, hostReference: server.hostReference },
      serverInfo: session.serverInfo,
      transport: describeMcpTransport(transport),
      prompts: prompts.filter((prompt) => mcpSourceAllowed(server.sources, 'prompt', prompt.name)).map((prompt) => ({
        name: prompt.name, description: prompt.description ?? null,
        arguments: (prompt.arguments ?? []).map((argument) => ({ name: argument.name, description: argument.description ?? null, required: argument.required === true })),
        reference: `mcp:${server.id}/prompt/${prompt.name}`
      })),
      resources: resources.filter((resource) => mcpSourceAllowed(server.sources, 'resource', resource.uri)).map((resource) => ({
        uri: resource.uri, name: resource.name ?? resource.uri, description: resource.description ?? null, mimeType: resource.mimeType ?? null,
        reference: `mcp:${server.id}/resource/${encodeURIComponent(resource.uri)}`
      })),
      tools: tools.filter((tool) => mcpSourceAllowed(server.sources, 'tool', tool.name)).map((tool) => ({
        name: tool.name, description: tool.description ?? null,
        arguments: Object.entries(tool.inputSchema?.properties ?? {}).map(([name, schema]) => ({
          name, description: schema?.description ?? null, required: (tool.inputSchema?.required ?? []).includes(name)
        })),
        reference: `mcp:${server.id}/tool/${tool.name}`
      }))
    };
  }, sessionOptions);
}
