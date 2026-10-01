/**
 * An MCP server published for others to install: what it is, the policy a repository may adopt for
 * it, and the host entry VS Code or Copilot uses to start or reach it.
 *
 *   { "format": "sflow-mcp-server@1", "id", "label", "description",
 *     "policy": { "tools", "approval", "evidence", "sources" },
 *     "host": { "type": "stdio", "command", "args", "env" } | { "type": "http", "url", "headers" },
 *     "inputs": [ VS Code input definitions for ${input:…} values ] }
 *
 * A descriptor never assigns itself to agents or steps; the person importing it chooses those, and
 * the governed policy is reviewed like any other configuration change. The host entry is not
 * configuration: it is written to the developer's VS Code workspace file only by an explicit
 * `mcp host add`, after the exact command or URL is shown.
 */
import { normalizeMcpServers } from './mcp.mjs';
import { SingularityFlowError } from './util.mjs';

export const MCP_SERVER_DESCRIPTOR_FORMAT = 'sflow-mcp-server@1';
export const MCP_IMPORT_ROOT = 'singularity/imports/mcp';
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message, code = 'MCP_DESCRIPTOR_INVALID') { return new SingularityFlowError(message, { code }); }

function text(value, label, max, required = false) {
  if (value == null) { if (required) throw fail(`${label} is required.`); return null; }
  const result = String(value).replace(/\s+/g, ' ').trim();
  if (!result || result.length > max) throw fail(`${label} must be 1 to ${max} characters.`);
  return result;
}

function strings(value, label) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw fail(`${label} must be an object of text values.`);
  }
  return { ...value };
}

/** A floating package (npx without an exact version) installs whatever is newest when started. */
function floatingPackage(host) {
  if (host.type !== 'stdio' || !['npx', 'pnpm', 'bunx', 'uvx'].includes(host.command)) return null;
  const spec = host.args.find((arg) => !arg.startsWith('-') && arg !== 'dlx');
  if (!spec) return null;
  const version = spec.startsWith('@') ? spec.slice(1).split('@')[1] : spec.split('@')[1];
  return !version || version === 'latest' || /[\^~*x]/.test(version) ? spec : null;
}

export function parseMcpServerDescriptor(sourceText, { id: requestedId = null } = {}) {
  let value;
  try { value = JSON.parse(sourceText); } catch (error) { throw fail(`An MCP server descriptor must be JSON: ${error.message}`); }
  if (!value || typeof value !== 'object' || value.format !== MCP_SERVER_DESCRIPTOR_FORMAT) {
    throw fail(`An MCP server descriptor must declare format '${MCP_SERVER_DESCRIPTOR_FORMAT}'.`);
  }
  for (const key of Object.keys(value)) {
    if (!['format', 'id', 'label', 'description', 'policy', 'host', 'inputs'].includes(key)) throw fail(`The MCP server descriptor contains unknown field '${key}'.`);
  }
  const id = requestedId ?? value.id;
  if (!ID.test(String(id ?? ''))) throw fail('The MCP server needs a lower-case kebab-case id.');
  const label = text(value.label, 'The MCP server label', 120) ?? id;
  const description = text(value.description, 'The MCP server description', 500);
  const policy = value.policy ?? {};
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw fail('The MCP server policy must be an object.');
  for (const key of Object.keys(policy)) {
    if (!['tools', 'approval', 'evidence', 'sources'].includes(key)) throw fail(`The MCP server policy may not set '${key}'; the importing repository chooses agents and steps.`);
  }
  // The same normalizer the configuration uses, so an invalid policy is refused before review.
  const normalized = normalizeMcpServers({ [id]: { label, hostReference: id, ...policy } })[id];
  const rawHost = value.host;
  if (!rawHost || typeof rawHost !== 'object' || Array.isArray(rawHost)) throw fail('The MCP server descriptor needs a host entry.');
  let host;
  if (rawHost.type === 'stdio') {
    const command = text(rawHost.command, 'The MCP server command', 256, true);
    if (!Array.isArray(rawHost.args ?? []) || (rawHost.args ?? []).some((arg) => typeof arg !== 'string')) throw fail('The MCP server args must be a list of text.');
    host = { type: 'stdio', command, args: [...(rawHost.args ?? [])], ...(rawHost.env ? { env: strings(rawHost.env, 'The MCP server env') } : {}) };
  } else if (rawHost.type === 'http') {
    let url;
    try { url = new URL(String(rawHost.url ?? '')); } catch { throw fail('The MCP server url is not a valid URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw fail('An installed MCP server must use an HTTPS URL without credentials.');
    host = { type: 'http', url: url.toString(), ...(rawHost.headers ? { headers: strings(rawHost.headers, 'The MCP server headers') } : {}) };
  } else throw fail(`The MCP server host type must be stdio or http, not '${rawHost.type}'.`);
  const inputs = value.inputs ?? [];
  if (!Array.isArray(inputs) || inputs.some((input) => !input || typeof input !== 'object' || !ID.test(String(input.id ?? '')))) {
    throw fail('The MCP server inputs must be a list of VS Code input definitions with kebab-case ids.');
  }
  const warnings = [];
  const floating = floatingPackage(host);
  if (floating) warnings.push(`It installs ${floating} without an exact version, so what runs can change after review. Prefer an exact version.`);
  return {
    id, label, description, host, inputs: inputs.map((input) => ({ ...input })), warnings,
    policy: {
      tools: normalized.tools, approval: normalized.approval, evidence: normalized.evidence,
      ...(normalized.sources ? { sources: normalized.sources } : {})
    }
  };
}

export function mcpDescriptorPath(id) { return `${MCP_IMPORT_ROOT}/${id}.json`; }
