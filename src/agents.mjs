import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { BlockList, isIP } from 'node:net';
import YAML from 'yaml';
import { exists, nowIso, posix, secureRepositoryPath, snapshot, writeJson, writeText, SingularityFlowError } from './util.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

export const AGENT_LOCK_PATH = 'singularity/agents.lock.yml';
export const AGENT_MAPPING_PATH = 'singularity/agent-mappings.yml';
const DEFAULT_MAX_BYTES = 1024 * 1024;
const HARD_MAX_BYTES = 10 * 1024 * 1024;
const TOKEN_PATTERN = /\{([^}]+)\}/g;
const ALLOWED_TOKENS = new Set(['workId', 'workType', 'phase', 'generation']);
const BLOCKED_REMOTE_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) BLOCKED_REMOTE_ADDRESSES.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8]
]) BLOCKED_REMOTE_ADDRESSES.addSubnet(network, prefix, 'ipv6');

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function idPattern(value) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value); }
function displayNameId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return idPattern(normalized) ? normalized : null;
}
function copilotAgentPattern(value) {
  return typeof value === 'string' && value === value.trim()
    && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(value);
}
function splitList(value) { return !value || value === '*' || value === '-' ? [] : value.split(',').map((item) => item.trim()).filter(Boolean); }
function parseBoolean(value, label) {
  if (!value || value === '-') return false;
  if (['true', 'yes'].includes(value.toLowerCase())) return true;
  if (['false', 'no'].includes(value.toLowerCase())) return false;
  throw new SingularityFlowError(`${label} must be true or false.`);
}
function parseMaxBytes(value, label) {
  if (!value || value === '-') return DEFAULT_MAX_BYTES;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > HARD_MAX_BYTES) throw new SingularityFlowError(`${label} must be between 1 and ${HARD_MAX_BYTES}.`);
  return number;
}
function linkValue(value) { return value.match(/^\[[^\]]*\]\(([^)]+)\)$/)?.[1] ?? value; }
function validateRemoteUrl(value, label, { dynamic = false } = {}) {
  const tokens = [...value.matchAll(TOKEN_PATTERN)].map((match) => match[1]);
  if (!dynamic && tokens.length) throw new SingularityFlowError(`${label} cannot contain template variables.`);
  for (const token of tokens) if (!ALLOWED_TOKENS.has(token)) throw new SingularityFlowError(`${label} uses unsupported variable '{${token}}'.`);
  const candidate = dynamic ? value.replace(TOKEN_PATTERN, 'value') : value;
  let url;
  try { url = new URL(candidate); } catch { throw new SingularityFlowError(`${label} must be a valid public HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new SingularityFlowError(`${label} must be a public HTTPS URL without embedded credentials.`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || (isIP(host) && !isPublicRemoteAddress(host))) {
    throw new SingularityFlowError(`${label} must use a public Internet host.`);
  }
  return value;
}

export function isPublicRemoteAddress(address) {
  const family = isIP(address);
  if (family === 6 && address.toLowerCase().startsWith('::ffff:')) return false;
  return family !== 0 && !BLOCKED_REMOTE_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export async function resolvePublicRemoteHost(url, { lookupImpl = dnsLookup } = {}) {
  const parsed = new URL(url);
  const literal = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(literal);
  const addresses = literalFamily
    ? [{ address: literal, family: literalFamily }]
    : await lookupImpl(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new SingularityFlowError(`Remote Markdown host '${parsed.hostname}' did not resolve to an address.`);
  const blocked = addresses.find((entry) => !isPublicRemoteAddress(entry.address));
  if (blocked) {
    throw new SingularityFlowError(
      `Remote Markdown host '${parsed.hostname}' resolved to non-public address ${blocked.address}; request blocked.`
    );
  }
  // Every returned address is checked, not merely the selected one. Pinning one
  // validated result below prevents a second DNS lookup from rebinding the host.
  return addresses[0];
}

function pinnedHttpsFetch(url, { signal, headers }, resolved, maxBytes) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'GET',
      headers,
      signal,
      lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family)
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new SingularityFlowError(`Remote Markdown ${url} exceeds its ${maxBytes} byte limit.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          status: response.statusCode ?? 0,
          headers: { get: (name) => response.headers[String(name).toLowerCase()] ?? null },
          arrayBuffer: async () => bytes
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function resolveRemoteHostWithTimeout(url, lookupImpl, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      resolvePublicRemoteHost(url, { lookupImpl }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new SingularityFlowError(`DNS lookup for ${url} timed out.`)), timeoutMs);
      })
    ]);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`Unable to resolve remote Markdown host for ${url}: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function parseAgentDocument(text, file) {
  // Git for Windows commonly checks Markdown out with CRLF line endings. Agent
  // documents are cross-platform interchange files, so their parser must not
  // depend on core.autocrlf. Some Windows editors also add a UTF-8 BOM.
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const opening = /^---\r?\n/.exec(normalized);
  if (!opening) return { frontmatter: {}, body: normalized };
  const remainder = normalized.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/.exec(remainder);
  if (!closing) throw new SingularityFlowError(`Agent frontmatter is not closed: ${file}`);
  const value = YAML.parse(remainder.slice(0, closing.index)) ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`Agent frontmatter must be an object: ${file}`);
  return { frontmatter: value, body: remainder.slice(closing.index + closing[0].length) };
}

function metadataList(metadata, key) {
  const value = metadata?.[key];
  if (value == null || value === '' || value === '*' || value === '-') return [];
  if (typeof value !== 'string') throw new SingularityFlowError(`Agent metadata '${key}' must be a comma-separated string.`);
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function rowsForHeading(text, heading, expected) {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (headingIndex < 0) return [];
  let index = headingIndex + 1;
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (!lines[index]?.trim().startsWith('|')) throw new SingularityFlowError(`Agent heading '${heading}' must be followed by a Markdown table.`);
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  const headers = cells(lines[index]).map((cell) => cell.toLowerCase());
  if (JSON.stringify(headers) !== JSON.stringify(expected.map((item) => item.toLowerCase()))) throw new SingularityFlowError(`Agent heading '${heading}' requires columns: ${expected.join(' | ')}.`);
  index += 1;
  if (!lines[index]?.includes('---')) throw new SingularityFlowError(`Agent heading '${heading}' has no Markdown table separator.`);
  index += 1;
  const rows = [];
  for (; index < lines.length && lines[index].trim().startsWith('|'); index += 1) {
    const values = cells(lines[index]);
    if (values.length !== expected.length) throw new SingularityFlowError(`Agent heading '${heading}' contains a row with ${values.length} columns; expected ${expected.length}.`);
    rows.push(Object.fromEntries(expected.map((key, cellIndex) => [key, values[cellIndex]])));
  }
  return rows;
}

export function parseAgentDependencies(text, { source = 'agent.md', agentId = null } = {}) {
  const { frontmatter, body } = parseAgentDocument(text, source);
  const declaredName = frontmatter.name;
  if (declaredName != null && (typeof declaredName !== 'string' || !declaredName.trim()
      || declaredName.length > 128 || /[\u0000-\u001f\u007f]/.test(declaredName))) {
    throw new SingularityFlowError(`Agent name in ${source} must be non-empty display text of at most 128 characters.`);
  }
  const sourceId = path.basename(source).replace(/\.agent\.md$|\.md$/i, '');
  // Existing governed agents historically placed their kebab-case ID in `name`; preserve that
  // contract. Native Copilot Agent Markdown also permits a human display name in the same field.
  // In that shape the stable governed ID is the kebab-case filename, keeping display text out of
  // workflow identity and allowing capability review to validate the shared `.github/agents` tree.
  // Some native-agent editors also preserve the display name in the filename. Normalize that
  // legacy shape deterministically so Windows checkouts do not become unable to review otherwise
  // valid capability configuration. New files should still use the explicit kebab-case filename.
  const id = agentId ?? (idPattern(declaredName) ? declaredName
    : idPattern(sourceId) ? sourceId : displayNameId(declaredName) ?? sourceId);
  if (!idPattern(id)) throw new SingularityFlowError(`Agent '${id}' must use lower-case kebab-case.`);
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) throw new SingularityFlowError(`Agent '${id}' requires a non-empty description.`);
  if (!body.trim()) throw new SingularityFlowError(`Agent '${id}' requires a non-empty prompt body.`);
  if (Buffer.byteLength(body, 'utf8') > 30000) throw new SingularityFlowError(`Agent '${id}' prompt body exceeds 30000 bytes.`);
  const metadata = frontmatter.metadata ?? {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new SingularityFlowError(`Agent '${id}' metadata must be an object.`);
  for (const [key, value] of Object.entries(metadata)) if (typeof value !== 'string') throw new SingularityFlowError(`Agent '${id}' metadata '${key}' must be a string.`);
  const phases = metadataList(metadata, 'sflow-phases');
  const defaultFor = metadataList(metadata, 'sflow-default-for');
  const worldModelViews = metadataList(metadata, 'sflow-world-model-views');
  const tools = frontmatter.tools ?? [];
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string' || !tool.trim())) throw new SingularityFlowError(`Agent '${id}' tools must be an array of non-empty tool names.`);
  if (new Set(tools).size !== tools.length) throw new SingularityFlowError(`Agent '${id}' tools must not contain duplicates.`);
  for (const phase of [...phases, ...defaultFor]) if (!idPattern(phase)) throw new SingularityFlowError(`Agent '${id}' references invalid phase '${phase}'.`);
  for (const view of worldModelViews) if (!idPattern(view)) throw new SingularityFlowError(`Agent '${id}' references invalid world-model view '${view}'.`);
  for (const phase of defaultFor) if (phases.length && !phases.includes(phase)) throw new SingularityFlowError(`Agent '${id}' defaults phase '${phase}' without supporting it.`);
  const skillRows = rowsForHeading(text, 'Remote skills', ['ID', 'URL', 'Phases', 'Optional', 'Max bytes']);
  const templateRows = rowsForHeading(text, 'Remote artifact templates', ['ID', 'URL', 'Phases', 'Optional', 'Max bytes']);
  const generatedRows = rowsForHeading(text, 'Remote generated artifacts', ['ID', 'URL template', 'Phase', 'Target', 'Optional', 'Max bytes']);
  const seen = new Set();
  const common = (row, type, urlKey, dynamic = false) => {
    if (!idPattern(row.ID)) throw new SingularityFlowError(`Remote ${type} ID '${row.ID}' in ${source} must be lower-case kebab-case.`);
    if (seen.has(row.ID)) throw new SingularityFlowError(`Remote dependency ID '${row.ID}' is duplicated in ${source}.`);
    seen.add(row.ID);
    const url = validateRemoteUrl(linkValue(row[urlKey]), `${type} '${row.ID}' URL`, { dynamic });
    return { id: row.ID, type, url, optional: parseBoolean(row.Optional, `${type} '${row.ID}' Optional`), maxBytes: parseMaxBytes(row['Max bytes'], `${type} '${row.ID}' Max bytes`) };
  };
  const skills = skillRows.map((row) => ({ ...common(row, 'skill', 'URL'), phases: splitList(row.Phases) }));
  const templates = templateRows.map((row) => ({ ...common(row, 'template', 'URL'), phases: splitList(row.Phases) }));
  const generated = generatedRows.map((row) => {
    const entry = { ...common(row, 'generated', 'URL template', true), phase: row.Phase };
    if (!idPattern(entry.phase)) throw new SingularityFlowError(`Generated artifact '${entry.id}' has invalid phase '${entry.phase}'.`);
    const target = posix(row.Target);
    if (!target.startsWith(`artifacts/${entry.phase}/`) || path.isAbsolute(target) || target.split('/').includes('..') || !target.endsWith('.md')) throw new SingularityFlowError(`Generated artifact '${entry.id}' target must be a Markdown path under artifacts/${entry.phase}/.`);
    return { ...entry, target };
  });
  return {
    id,
    source,
    displayName: declaredName?.trim() ?? id,
    label: metadata['sflow-label'] ?? declaredName?.trim() ?? id,
    description: frontmatter.description.trim(),
    frontmatter,
    metadata,
    phases,
    defaultFor,
    worldModelViews,
    tools,
    prompt: body.trim(),
    skills,
    templates,
    generated,
    dependencies: [...skills, ...templates, ...generated]
  };
}

async function agentFiles(directory) {
  if (!(await exists(directory))) return [];
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /(?:\.agent)?\.md$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

export async function discoverAgents(root) {
  const repositoryRoot = configurationReadRoot(root);
  const locations = [
    ['repository', path.join(repositoryRoot, '.github/agents')],
    ['plugin', path.join(PACKAGE_ROOT, 'plugin/agents')],
    ['bundled', path.join(PACKAGE_ROOT, 'templates/agents')]
  ];
  const agents = new Map();
  for (const [scope, directory] of locations) {
    for (const file of await agentFiles(directory)) {
      const text = await readFile(file, 'utf8');
      const parsed = parseAgentDependencies(text, { source: posix(path.relative(repositoryRoot, file)) });
      if (!agents.has(parsed.id)) agents.set(parsed.id, { ...parsed, scope, file, text, sha256: hash(text) });
    }
  }
  return [...agents.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function validateAgentCatalog(agents, definition) {
  if (!agents.length) throw new SingularityFlowError('No governed Agent Markdown files were found in .github/agents or the bundled plugin.');
  const phaseIds = new Set(Object.keys(definition.phases ?? {}));
  const viewIds = new Set(definition.worldModel?.views ?? []);
  for (const agent of agents) {
    // Repository agents are part of this repository's contract, so a misspelled or removed phase
    // must fail validation. Packaged agents are a catalog shared by every valid workflow-v2
    // repository, including repositories created before an optional profile/phase was added to the
    // package. Their extra declarations are dormant unless that phase exists locally; rejecting
    // them made an otherwise valid older v2 workflow unload when the extension was upgraded.
    if (agent.scope === 'repository') {
      for (const phase of [...agent.phases, ...agent.defaultFor]) {
        if (!phaseIds.has(phase)) throw new SingularityFlowError(`Agent '${agent.id}' references unknown phase '${phase}'.`);
      }
    }
    for (const view of agent.worldModelViews) if (!viewIds.has(view)) throw new SingularityFlowError(`Agent '${agent.id}' references undeclared world-model view '${view}'.`);
  }
  for (const phaseId of phaseIds) {
    const compatible = agents.filter((agent) => !agent.phases.length || agent.phases.includes(phaseId));
    if (!compatible.length) throw new SingularityFlowError(`Phase '${phaseId}' has no compatible governed agent.`);
    const defaults = compatible.filter((agent) => agent.defaultFor.includes(phaseId));
    if (defaults.length !== 1) throw new SingularityFlowError(`Phase '${phaseId}' requires exactly one default governed agent; found ${defaults.length}.`);
  }
  return agents;
}

export function resolvePhaseAgent(agents, phaseId, { requestedAgent = null, nativeCopilotAgent = null } = {}) {
  const fallback = agents.find((agent) => agent.defaultFor.includes(phaseId));
  if (!fallback) throw new SingularityFlowError(`Phase '${phaseId}' has no default governed agent.`);
  const selected = requestedAgent ? agents.find((agent) => agent.id === requestedAgent) : fallback;
  if (!selected) throw new SingularityFlowError(`Unknown governed agent '${requestedAgent}'.`);
  const compatible = !selected.phases.length || selected.phases.includes(phaseId);
  return {
    agent: selected,
    nativeCopilotAgent,
    source: requestedAgent ? 'session-override' : 'phase-default',
    compatible,
    warning: compatible ? null : `Agent '${selected.id}' is not declared for phase '${phaseId}'. Continuing with an audited compatibility override.`
  };
}

export function validateAgentMappings(value, { agentIds = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${AGENT_MAPPING_PATH} must contain a YAML object.`);
  for (const key of Object.keys(value)) if (!['version', 'mappings'].includes(key)) throw new SingularityFlowError(`${AGENT_MAPPING_PATH} contains unknown field '${key}'.`);
  if (value.version !== 1) throw new SingularityFlowError(`${AGENT_MAPPING_PATH} version must be 1.`);
  const mappings = value.mappings ?? {};
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) throw new SingularityFlowError(`${AGENT_MAPPING_PATH} mappings must be an object.`);
  const known = agentIds ? new Set(agentIds) : null;
  const normalized = {};
  for (const [copilotAgent, agentId] of Object.entries(mappings)) {
    if (!copilotAgentPattern(copilotAgent)) throw new SingularityFlowError(`Copilot agent mapping key '${copilotAgent}' must be trimmed display text using letters, numbers, spaces, '.', '_' or '-' and be at most 128 characters.`);
    if (typeof agentId !== 'string' || !idPattern(agentId)) throw new SingularityFlowError(`Copilot agent '${copilotAgent}' must map to a lower-case kebab-case governed agent ID.`);
    if (known && !known.has(agentId)) throw new SingularityFlowError(`Copilot agent '${copilotAgent}' maps to unknown governed agent '${agentId}'.`);
    normalized[copilotAgent] = agentId;
  }
  return { version: 1, mappings: normalized };
}

export async function loadAgentMappings(root, { agents = null } = {}) {
  const discovered = agents ?? await discoverAgents(root);
  const file = await secureRepositoryPath(root, AGENT_MAPPING_PATH, {
    label: 'Copilot agent mapping file',
    type: 'file'
  });
  if (!file.exists) return { path: AGENT_MAPPING_PATH, exists: false, version: 1, mappings: {} };
  let parsed;
  try { parsed = YAML.parse(await readFile(file.absolute, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`${AGENT_MAPPING_PATH} is invalid YAML: ${error.message}`); }
  return { path: AGENT_MAPPING_PATH, exists: true, ...validateAgentMappings(parsed, { agentIds: discovered.map((agent) => agent.id) }) };
}

export async function resolveCopilotAgent(root, copilotAgent, { agents = null } = {}) {
  const discovered = agents ?? await discoverAgents(root);
  const configured = await loadAgentMappings(root, { agents: discovered });
  const explicit = Object.hasOwn(configured.mappings, copilotAgent);
  const exact = discovered.find((candidate) => candidate.id === copilotAgent) ?? null;
  const displayMatches = exact ? [] : discovered.filter((candidate) => candidate.displayName === copilotAgent);
  if (!explicit && displayMatches.length > 1) {
    throw new SingularityFlowError(
      `Copilot agent display name '${copilotAgent}' matches multiple governed agents. Add an exact mapping in ${AGENT_MAPPING_PATH}.`
    );
  }
  const automatic = exact ?? displayMatches[0] ?? null;
  const agentId = explicit ? configured.mappings[copilotAgent] : automatic?.id ?? copilotAgent;
  return {
    copilotAgent,
    agentId,
    source: explicit ? 'configured' : exact ? 'same-name' : automatic ? 'display-name' : 'same-name',
    mappingPath: configured.path,
    agent: discovered.find((candidate) => candidate.id === agentId) ?? null
  };
}

export async function agentMappingStatus(root) {
  const agents = await discoverAgents(root);
  const configured = await loadAgentMappings(root, { agents });
  const rows = Object.entries(configured.mappings).map(([copilotAgent, agentId]) => ({
    copilotAgent, agentId, source: 'configured'
  }));
  const displayCounts = new Map();
  for (const agent of agents) {
    displayCounts.set(agent.displayName, (displayCounts.get(agent.displayName) ?? 0) + 1);
  }
  for (const agent of agents) {
    if (Object.hasOwn(configured.mappings, agent.id)) continue;
    rows.push({ copilotAgent: agent.id, agentId: agent.id, source: 'same-name fallback' });
    if (agent.displayName !== agent.id && displayCounts.get(agent.displayName) === 1
        && !Object.hasOwn(configured.mappings, agent.displayName)) {
      rows.push({ copilotAgent: agent.displayName, agentId: agent.id, source: 'display-name fallback' });
    }
  }
  return { ...configured, rows: rows.sort((left, right) => left.copilotAgent.localeCompare(right.copilotAgent)) };
}

export async function findAgent(root, id) {
  const agent = (await discoverAgents(root)).find((candidate) => candidate.id === id);
  if (!agent) throw new SingularityFlowError(`Unknown governed agent '${id}'. Run singularity-flow agents list.`);
  return agent;
}

async function responseBody(response, maxBytes, label) {
  if (!response.ok) throw new SingularityFlowError(`${label} returned HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new SingularityFlowError(`${label} returned empty Markdown.`);
  if (buffer.length > maxBytes) throw new SingularityFlowError(`${label} exceeds its ${maxBytes} byte limit.`);
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new SingularityFlowError(`${label} is not valid UTF-8 Markdown.`); }
  return { content, size: buffer.length, sha256: hash(buffer) };
}

export async function fetchRemoteMarkdown(url, {
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  lookupImpl = fetchImpl === globalThis.fetch ? dnsLookup : null
} = {}) {
  if (typeof fetchImpl !== 'function') throw new SingularityFlowError('This Node runtime does not provide HTTPS fetch support.');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_MAX_BYTES) {
    throw new SingularityFlowError(`Remote Markdown byte limit must be between 1 and ${HARD_MAX_BYTES}.`);
  }
  let current = validateRemoteUrl(url, 'Remote Markdown URL');
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const resolved = lookupImpl ? await resolveRemoteHostWithTimeout(current, lookupImpl, timeoutMs) : null;
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const requestOptions = { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.1' } };
      response = resolved && fetchImpl === globalThis.fetch
        ? await pinnedHttpsFetch(current, requestOptions, resolved, maxBytes)
        : await fetchImpl(current, requestOptions);
    }
    catch (error) { throw new SingularityFlowError(`Unable to fetch ${current}: ${error.name === 'AbortError' ? 'request timed out' : error.message}`); }
    finally { clearTimeout(timeout); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3) throw new SingularityFlowError(`Remote Markdown URL exceeded 3 redirects: ${url}`);
      const rawLocation = response.headers.get('location');
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (!location) throw new SingularityFlowError(`Remote Markdown redirect has no location: ${current}`);
      current = validateRemoteUrl(new URL(location, current).toString(), 'Remote Markdown redirect');
      continue;
    }
    return { ...(await responseBody(response, maxBytes, `Remote Markdown ${current}`)), url, resolvedUrl: current };
  }
  throw new SingularityFlowError(`Unable to fetch ${url}.`);
}

async function loadLock(root) {
  const file = path.join(root, AGENT_LOCK_PATH);
  if (!(await exists(file))) return { version: 1, agents: {} };
  const lock = YAML.parse(await readFile(file, 'utf8'));
  if (lock?.version !== 1 || !lock.agents || typeof lock.agents !== 'object') throw new SingularityFlowError(`${AGENT_LOCK_PATH} is invalid.`);
  return lock;
}

async function saveLock(root, lock) {
  await writeText(path.join(root, AGENT_LOCK_PATH), YAML.stringify(lock));
}

function cachePath(root, agentId, entry) {
  return path.join(root, '.git/singularity-flow/agents', agentId, `${entry.type}-${entry.id}-${entry.sha256}.md`);
}

export async function resolveAgentLock(root, agent, { fetchImpl = globalThis.fetch } = {}) {
  const dependencies = [];
  for (const dependency of agent.dependencies) {
    if (dependency.type === 'generated') {
      dependencies.push({ ...dependency, urlTemplate: dependency.url, url: undefined, dynamic: true, sha256: null, size: null, resolvedUrl: null });
      continue;
    }
    try {
      const fetched = await fetchRemoteMarkdown(dependency.url, { maxBytes: dependency.maxBytes, fetchImpl });
      dependencies.push({ ...dependency, ...fetched, content: undefined });
    } catch (error) {
      if (!dependency.optional) throw error;
      dependencies.push({ ...dependency, status: 'unavailable', error: error.message, sha256: null, size: null, resolvedUrl: null });
    }
  }
  return { source: agent.source, sourceSha256: agent.sha256, lockedAt: nowIso(), dependencies };
}

export async function lockAgent(root, agentId, { update = false, accepted = false, fetchImpl = globalThis.fetch, resolution: suppliedResolution = null } = {}) {
  const agent = await findAgent(root, agentId); const lock = await loadLock(root); const existing = lock.agents[agentId];
  if (existing && !update) throw new SingularityFlowError(`agent '${agentId}' is already locked. Use --update to review new remote hashes.`);
  const resolution = suppliedResolution ?? await resolveAgentLock(root, agent, { fetchImpl });
  if (!accepted) return { agent, resolution, existing, written: false };
  lock.agents[agentId] = resolution; await saveLock(root, lock);
  return { agent, resolution, existing, written: true, path: AGENT_LOCK_PATH };
}

function lockDependency(lockEntry, dependency) {
  return lockEntry?.dependencies?.find((entry) => entry.id === dependency.id && entry.type === dependency.type);
}

async function materializeLocked(root, agent, lockEntry, dependency, { fetchImpl = globalThis.fetch } = {}) {
  const locked = lockDependency(lockEntry, dependency);
  if (!locked) {
    if (dependency.optional) return { ...dependency, status: 'unavailable', warning: `Optional ${dependency.type} '${dependency.id}' is not locked.` };
    throw new SingularityFlowError(`Agent '${agent.id}' ${dependency.type} '${dependency.id}' is not locked. Run singularity-flow agents lock ${agent.id} --update.`);
  }
  if (locked.dynamic) return locked;
  if (!locked.sha256) {
    if (dependency.optional) return { ...locked, status: 'unavailable', warning: locked.error ?? `Optional ${dependency.id} was unavailable when locked.` };
    throw new SingularityFlowError(`Required ${dependency.type} '${dependency.id}' has no locked hash.`);
  }
  const destination = cachePath(root, agent.id, locked);
  const cached = await snapshot(destination);
  if (cached.exists && cached.sha256 === locked.sha256) return { ...locked, path: destination, status: 'ready', cached: true };
  let fetched;
  try { fetched = await fetchRemoteMarkdown(locked.url, { maxBytes: locked.maxBytes, fetchImpl }); }
  catch (error) {
    if (dependency.optional) return { ...locked, status: 'unavailable', warning: error.message };
    throw error;
  }
  if (fetched.sha256 !== locked.sha256) throw new SingularityFlowError(`Remote ${dependency.type} '${dependency.id}' changed (${locked.sha256.slice(0, 12)} → ${fetched.sha256.slice(0, 12)}). Update the agent lock deliberately.`);
  await writeText(destination, fetched.content);
  return { ...locked, path: destination, status: 'ready', cached: false };
}

export async function syncAgent(root, agentId, { fetchImpl = globalThis.fetch } = {}) {
  const agent = await findAgent(root, agentId);
  if (!agent.dependencies.length) return { agent, dependencies: [], warnings: [] };
  const lock = await loadLock(root); const entry = lock.agents[agentId];
  if (!entry) throw new SingularityFlowError(`Agent '${agentId}' has remote dependencies but no lock. Run singularity-flow agents lock ${agentId}.`);
  if (entry.sourceSha256 !== agent.sha256) throw new SingularityFlowError(`Agent '${agentId}' changed after locking. Run singularity-flow agents lock ${agentId} --update.`);
  const dependencies = []; const warnings = [];
  for (const dependency of agent.dependencies) {
    const materialized = await materializeLocked(root, agent, entry, dependency, { fetchImpl });
    dependencies.push(materialized); if (materialized.warning) warnings.push(materialized.warning);
  }
  return { agent, dependencies, warnings, lock: entry };
}

export async function agentStatus(root, requestedAgent = null) {
  const agents = await discoverAgents(root);
  const lock = await loadLock(root);
  const results = [];
  for (const agent of agents.filter((candidate) => !requestedAgent || candidate.id === requestedAgent)) {
    const entry = lock.agents[agent.id];
    const sourceChanged = Boolean(entry && entry.sourceSha256 !== agent.sha256);
    const dependencies = [];
    for (const dependency of agent.dependencies) {
      const locked = lockDependency(entry, dependency);
      const cached = locked?.sha256 ? await snapshot(cachePath(root, agent.id, locked)) : { exists: dependency.type === 'generated', sha256: null };
      dependencies.push({ id: dependency.id, type: dependency.type, optional: dependency.optional, locked: Boolean(locked), sha256: locked?.sha256 ?? null, status: !entry ? 'unlocked' : sourceChanged ? 'stale-agent' : !locked ? 'missing-lock' : locked.status === 'unavailable' ? 'unavailable' : dependency.type === 'generated' || (cached.exists && cached.sha256 === locked.sha256) ? 'ready' : 'needs-sync' });
    }
    results.push({ id: agent.id, scope: agent.scope, source: agent.source, sourceSha256: agent.sha256, locked: Boolean(entry), sourceChanged, status: !agent.dependencies.length ? 'local-only' : !entry ? 'unlocked' : sourceChanged ? 'stale' : dependencies.every((item) => ['ready', 'unavailable'].includes(item.status)) ? 'ready' : 'needs-sync', dependencies });
  }
  return results;
}

export function parseAgentTemplateReference(value) {
  const match = /^agent:([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(value ?? '');
  if (!match) throw new SingularityFlowError(`Remote template reference '${value}' must use agent:<agent-id>/<template-id>.`);
  return { agentId: match[1], templateId: match[2] };
}

export function isAgentTemplateReference(value) { return typeof value === 'string' && value.startsWith('agent:'); }

export async function materializeAgentTemplate(root, reference, { phaseId = null, ...options } = {}) {
  const { agentId, templateId } = parseAgentTemplateReference(reference); const synced = await syncAgent(root, agentId, options);
  const template = synced.dependencies.find((entry) => entry.type === 'template' && entry.id === templateId);
  if (!template) throw new SingularityFlowError(`Agent '${agentId}' has no locked remote template '${templateId}'.`);
  if (phaseId && !matches(phaseId, template.phases)) throw new SingularityFlowError(`Remote template '${agentId}/${templateId}' is not scoped to phase '${phaseId}'.`);
  if (template.status !== 'ready') throw new SingularityFlowError(`Remote template '${agentId}/${templateId}' is unavailable.`);
  return { source: 'agent', agent: agentId, resource: templateId, url: template.url, resolvedUrl: template.resolvedUrl, sha256: template.sha256, size: template.size, cachePath: template.path };
}

function matches(value, configured) { return !configured?.length || configured.includes(value); }

export async function renderAgentSkills(root, workflow, phase, session, { record = false, fetchImpl = globalThis.fetch, itemDirectory = null } = {}) {
  if (!session?.agent) return { text: '', skills: [], warnings: [] };
  const synced = await syncAgent(root, session.agent, { fetchImpl }); const selected = [];
  for (const dependency of synced.dependencies.filter((entry) => entry.type === 'skill')) {
    if (!matches(phase.id, dependency.phases)) continue;
    if (dependency.status !== 'ready') { if (!dependency.optional) throw new SingularityFlowError(`Required remote skill '${dependency.id}' is unavailable.`); continue; }
    const content = await readFile(dependency.path, 'utf8');
    selected.push({ ...dependency, content });
  }
  const text = selected.map((entry) => `<!-- agent skill: ${session.agent}/${entry.id} sha256=${entry.sha256} -->\n\n## Agent skill: ${entry.id}\n\n${entry.content.trim()}`).join('\n\n');
  let audit = null;
  if (record && workflow && itemDirectory && selected.length) {
    const generation = phase.generation + 1; const files = [];
    for (const entry of selected) {
      const target = path.join(itemDirectory, 'context/agent-snapshots', session.agent, `${entry.id}-${entry.sha256}.md`);
      if (!(await exists(target))) { await mkdir(path.dirname(target), { recursive: true }); await copyFile(entry.path, target); }
      files.push({ id: entry.id, type: 'skill', url: entry.url, sha256: entry.sha256, size: entry.size, path: posix(path.relative(root, target)) });
    }
    audit = { schemaVersion: currentSchemaVersion('agent-context-audit'), workId: workflow.workItem.id, phase: phase.id, generation, agent: session.agent, nativeCopilotAgent: session.nativeCopilotAgent ?? null, agentSourceSha256: synced.agent.sha256, files, recordedAt: nowIso() };
    await writeJson(path.join(itemDirectory, 'context', `agents-${phase.id}-gen${generation}.json`), audit);
  }
  return { text, skills: selected, warnings: synced.warnings, audit };
}

function expandUrl(template, workflow, phase) {
  const values = { workId: workflow.workItem.id, workType: workflow.workItem.workType, phase: phase.id, generation: phase.generation + 1 };
  return template.replace(TOKEN_PATTERN, (_, token) => encodeURIComponent(String(values[token])));
}

export async function prepareRemoteOutputs(root, workflow, phase, session, { itemDirectory, refresh = false, replace = false, resourceId = null, fetchImpl = globalThis.fetch } = {}) {
  if (!session?.agent) return { outputs: [], warnings: [] };
  const synced = await syncAgent(root, session.agent, { fetchImpl }); const outputs = []; const warnings = [];
  for (const dependency of synced.agent.generated.filter((entry) => entry.phase === phase.id && (!resourceId || entry.id === resourceId))) {
    const locked = lockDependency(synced.lock, dependency);
    if (!locked?.dynamic) throw new SingularityFlowError(`Generated artifact '${dependency.id}' is not present in the agent lock.`);
    const generation = phase.generation + 1;
    const recordFile = path.join(itemDirectory, 'context', `remote-output-${session.agent}-${dependency.id}-${phase.id}-gen${generation}.json`);
    const target = path.join(itemDirectory, dependency.target);
    const recordExists = await exists(recordFile);
    if (recordExists && !refresh) {
      const record = readRecord('remote-agent-output', await readFile(recordFile)).record; const current = await snapshot(target);
      if (!current.exists || current.sha256 !== record.renderedSha256) throw new SingularityFlowError(`Remote output '${dependency.id}' was edited locally. Use agents refresh-output ${dependency.id} --replace to replace it.`);
      outputs.push(record); continue;
    }
    if (await exists(target) && !replace) {
      if (!recordExists) throw new SingularityFlowError(`Remote output '${dependency.id}' would overwrite ${dependency.target}. Use agents refresh-output ${dependency.id} --replace.`);
      const previous = readRecord('remote-agent-output', await readFile(recordFile)).record; const current = await snapshot(target);
      if (current.sha256 !== previous.renderedSha256) throw new SingularityFlowError(`Remote output '${dependency.id}' has local edits. Use agents refresh-output ${dependency.id} --replace to overwrite them.`);
    }
    const url = expandUrl(dependency.url, workflow, phase);
    try {
      const fetched = await fetchRemoteMarkdown(url, { maxBytes: dependency.maxBytes, fetchImpl });
      await writeText(target, fetched.content);
      const record = { schemaVersion: currentSchemaVersion('remote-agent-output'), workId: workflow.workItem.id, workType: workflow.workItem.workType, phase: phase.id, generation, agent: session.agent, resource: dependency.id, target: dependency.target, url, resolvedUrl: fetched.resolvedUrl, sourceSha256: fetched.sha256, renderedSha256: fetched.sha256, bytes: fetched.size, fetchedAt: nowIso() };
      await writeJson(recordFile, record); outputs.push(record);
    } catch (error) {
      if (!dependency.optional) throw error;
      warnings.push(`Optional remote output '${dependency.id}' is unavailable: ${error.message}`);
    }
  }
  if (resourceId && !outputs.some((entry) => entry.resource === resourceId) && !warnings.some((entry) => entry.includes(`'${resourceId}'`))) throw new SingularityFlowError(`Active agent '${session.agent}' has no generated artifact '${resourceId}' for phase ${phase.id}.`);
  return { outputs, warnings };
}

export async function updateRemoteOutputRenderedHashes(root, workflow, phase, { itemDirectory, generation = phase.generation } = {}) {
  for (const output of phase.remoteOutputs ?? []) {
    if (output.generation !== generation) continue;
    const current = await snapshot(path.join(itemDirectory, output.target));
    output.renderedSha256 = current.sha256;
    const file = path.join(itemDirectory, 'context', `remote-output-${output.agent}-${output.resource}-${phase.id}-gen${generation}.json`);
    if (await exists(file)) await writeJson(file, { ...readRecord('remote-agent-output', await readFile(file)).record, renderedSha256: current.sha256, finalizedAt: nowIso() });
  }
}

export async function remoteOutputConflicts(phase, { itemDirectory } = {}) {
  const conflicts = [];
  for (const output of phase.remoteOutputs ?? []) {
    const file = path.join(itemDirectory, 'context', `remote-output-${output.agent}-${output.resource}-${phase.id}-gen${output.generation}.json`);
    if (!(await exists(file))) continue;
    const record = readRecord('remote-agent-output', await readFile(file)).record; const current = await snapshot(path.join(itemDirectory, output.target));
    if (!current.exists || current.sha256 !== record.renderedSha256) conflicts.push({ resource: output.resource, target: output.target, expected: record.renderedSha256, current: current.sha256 });
  }
  return conflicts;
}

export async function verifyAgentIntegrity(root, workflow, phase, { itemDirectory } = {}) {
  const errors = []; const warnings = []; const passes = [];
  for (const output of (phase.remoteOutputs ?? []).filter((entry) => entry.generation === phase.generation)) {
    const file = path.join(itemDirectory, 'context', `remote-output-${output.agent}-${output.resource}-${phase.id}-gen${phase.generation}.json`);
    if (!(await exists(file))) errors.push(`${phase.id} remote output record is missing for ${output.resource}`);
    else {
      const record = readRecord('remote-agent-output', await readFile(file)).record; const current = await snapshot(path.join(itemDirectory, output.target));
      if (!current.exists || current.sha256 !== record.renderedSha256) errors.push(`${phase.id} remote output '${output.resource}' no longer matches its finalized hash`);
      else passes.push(`remote output verified: ${phase.id} ← ${output.agent}/${output.resource}@${output.sourceSha256.slice(0, 8)}`);
    }
  }
  const auditFile = path.join(itemDirectory, 'context', `agents-${phase.id}-gen${phase.generation}.json`);
  if (await exists(auditFile)) {
    const audit = readRecord('agent-context-audit', await readFile(auditFile)).record;
    for (const entry of audit.files ?? []) {
      const current = await snapshot(path.join(root, entry.path));
      if (!current.exists || current.sha256 !== entry.sha256) errors.push(`${phase.id} remote skill snapshot failed integrity: ${entry.id}`);
    }
    if (!errors.length) passes.push(`remote agent context verified: ${phase.id} as ${audit.agent}`);
  }
  return { errors, warnings, passes };
}
