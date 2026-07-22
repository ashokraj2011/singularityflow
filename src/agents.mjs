import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import YAML from 'yaml';
import { exists, nowIso, posix, snapshot, writeJson, writeText, SingularityFlowError } from './util.mjs';

export const AGENT_LOCK_PATH = '.singularity/agents.lock.yml';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MAX_BYTES = 1024 * 1024;
const HARD_MAX_BYTES = 10 * 1024 * 1024;
const TOKEN_PATTERN = /\{([^}]+)\}/g;
const ALLOWED_TOKENS = new Set(['workId', 'workType', 'phase', 'generation']);

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function idPattern(value) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value); }
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
  const privateIpv4 = isIP(host) === 4 && (/^10\./.test(host) || /^127\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^0\./.test(host));
  const privateIpv6 = isIP(host) === 6 && (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || privateIpv4 || privateIpv6) throw new SingularityFlowError(`${label} must use a public Internet host.`);
  return value;
}

function parseFrontmatter(text, file) {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) throw new SingularityFlowError(`Agent frontmatter is not closed: ${file}`);
  const value = YAML.parse(text.slice(4, end)) ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`Agent frontmatter must be an object: ${file}`);
  return value;
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
  const frontmatter = parseFrontmatter(text, source);
  const id = agentId ?? frontmatter.name ?? path.basename(source).replace(/\.agent\.md$|\.md$/i, '');
  if (!idPattern(id)) throw new SingularityFlowError(`Agent '${id}' must use lower-case kebab-case.`);
  const skillRows = rowsForHeading(text, 'Remote skills', ['ID', 'URL', 'Phases', 'Personas', 'Optional', 'Max bytes']);
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
  const skills = skillRows.map((row) => ({ ...common(row, 'skill', 'URL'), phases: splitList(row.Phases), personas: splitList(row.Personas) }));
  const templates = templateRows.map((row) => ({ ...common(row, 'template', 'URL'), phases: splitList(row.Phases) }));
  const generated = generatedRows.map((row) => {
    const entry = { ...common(row, 'generated', 'URL template', true), phase: row.Phase };
    if (!idPattern(entry.phase)) throw new SingularityFlowError(`Generated artifact '${entry.id}' has invalid phase '${entry.phase}'.`);
    const target = posix(row.Target);
    if (!target.startsWith(`artifacts/${entry.phase}/`) || path.isAbsolute(target) || target.split('/').includes('..') || !target.endsWith('.md')) throw new SingularityFlowError(`Generated artifact '${entry.id}' target must be a Markdown path under artifacts/${entry.phase}/.`);
    return { ...entry, target };
  });
  return { id, source, frontmatter, skills, templates, generated, dependencies: [...skills, ...templates, ...generated] };
}

async function agentFiles(directory) {
  if (!(await exists(directory))) return [];
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /(?:\.agent)?\.md$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

export async function discoverAgents(root) {
  const locations = [
    ['repository', path.join(root, '.github/agents')],
    ['repository', path.join(root, '.claude/agents')],
    ['plugin', path.join(packageRoot, 'plugin/agents')]
  ];
  const agents = new Map();
  for (const [scope, directory] of locations) {
    for (const file of await agentFiles(directory)) {
      const text = await readFile(file, 'utf8');
      const parsed = parseAgentDependencies(text, { source: posix(path.relative(root, file)) });
      if (!agents.has(parsed.id)) agents.set(parsed.id, { ...parsed, scope, file, text, sha256: hash(text) });
    }
  }
  return [...agents.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function findAgent(root, id) {
  const agent = (await discoverAgents(root)).find((candidate) => candidate.id === id);
  if (!agent) throw new SingularityFlowError(`Unknown agent '${id}'. Run singularity-flow agents list.`);
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

export async function fetchRemoteMarkdown(url, { maxBytes = DEFAULT_MAX_BYTES, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new SingularityFlowError('This Node runtime does not provide HTTPS fetch support.');
  let current = validateRemoteUrl(url, 'Remote Markdown URL');
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try { response = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.1' } }); }
    catch (error) { throw new SingularityFlowError(`Unable to fetch ${current}: ${error.name === 'AbortError' ? 'request timed out' : error.message}`); }
    finally { clearTimeout(timeout); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3) throw new SingularityFlowError(`Remote Markdown URL exceeded 3 redirects: ${url}`);
      const location = response.headers.get('location');
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
  if (existing && !update) throw new SingularityFlowError(`Agent '${agentId}' is already locked. Use --update to review new remote hashes.`);
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
    if (!matches(phase.id, dependency.phases) || !matches(session.persona, dependency.personas)) continue;
    if (dependency.status !== 'ready') { if (!dependency.optional) throw new SingularityFlowError(`Required remote skill '${dependency.id}' is unavailable.`); continue; }
    const content = await readFile(dependency.path, 'utf8');
    selected.push({ ...dependency, content });
  }
  const text = selected.map((entry) => `<!-- remote agent skill: ${session.agent}/${entry.id} sha256=${entry.sha256} -->\n\n## Remote skill: ${entry.id}\n\n${entry.content.trim()}`).join('\n\n');
  let audit = null;
  if (record && workflow && itemDirectory && selected.length) {
    const generation = phase.generation + 1; const files = [];
    for (const entry of selected) {
      const target = path.join(itemDirectory, 'context/agent-snapshots', session.agent, `${entry.id}-${entry.sha256}.md`);
      if (!(await exists(target))) { await mkdir(path.dirname(target), { recursive: true }); await copyFile(entry.path, target); }
      files.push({ id: entry.id, type: 'skill', url: entry.url, sha256: entry.sha256, size: entry.size, path: posix(path.relative(root, target)) });
    }
    audit = { schemaVersion: 1, workId: workflow.workItem.id, phase: phase.id, generation, agent: session.agent, persona: session.persona, agentSourceSha256: synced.agent.sha256, files, recordedAt: nowIso() };
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
      const record = JSON.parse(await readFile(recordFile, 'utf8')); const current = await snapshot(target);
      if (!current.exists || current.sha256 !== record.renderedSha256) throw new SingularityFlowError(`Remote output '${dependency.id}' was edited locally. Use agents refresh-output ${dependency.id} --replace to replace it.`);
      outputs.push(record); continue;
    }
    if (await exists(target) && !replace) {
      if (!recordExists) throw new SingularityFlowError(`Remote output '${dependency.id}' would overwrite ${dependency.target}. Use agents refresh-output ${dependency.id} --replace.`);
      const previous = JSON.parse(await readFile(recordFile, 'utf8')); const current = await snapshot(target);
      if (current.sha256 !== previous.renderedSha256) throw new SingularityFlowError(`Remote output '${dependency.id}' has local edits. Use agents refresh-output ${dependency.id} --replace to overwrite them.`);
    }
    const url = expandUrl(dependency.url, workflow, phase);
    try {
      const fetched = await fetchRemoteMarkdown(url, { maxBytes: dependency.maxBytes, fetchImpl });
      await writeText(target, fetched.content);
      const record = { schemaVersion: 1, workId: workflow.workItem.id, workType: workflow.workItem.workType, phase: phase.id, generation, agent: session.agent, resource: dependency.id, target: dependency.target, url, resolvedUrl: fetched.resolvedUrl, sourceSha256: fetched.sha256, renderedSha256: fetched.sha256, bytes: fetched.size, fetchedAt: nowIso() };
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
    if (await exists(file)) await writeJson(file, { ...JSON.parse(await readFile(file, 'utf8')), renderedSha256: current.sha256, finalizedAt: nowIso() });
  }
}

export async function remoteOutputConflicts(phase, { itemDirectory } = {}) {
  const conflicts = [];
  for (const output of phase.remoteOutputs ?? []) {
    const file = path.join(itemDirectory, 'context', `remote-output-${output.agent}-${output.resource}-${phase.id}-gen${output.generation}.json`);
    if (!(await exists(file))) continue;
    const record = JSON.parse(await readFile(file, 'utf8')); const current = await snapshot(path.join(itemDirectory, output.target));
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
      const record = YAML.parse(await readFile(file, 'utf8')); const current = await snapshot(path.join(itemDirectory, output.target));
      if (!current.exists || current.sha256 !== record.renderedSha256) errors.push(`${phase.id} remote output '${output.resource}' no longer matches its finalized hash`);
      else passes.push(`remote output verified: ${phase.id} ← ${output.agent}/${output.resource}@${output.sourceSha256.slice(0, 8)}`);
    }
  }
  const auditFile = path.join(itemDirectory, 'context', `agents-${phase.id}-gen${phase.generation}.json`);
  if (await exists(auditFile)) {
    const audit = JSON.parse(await readFile(auditFile, 'utf8'));
    for (const entry of audit.files ?? []) {
      const current = await snapshot(path.join(root, entry.path));
      if (!current.exists || current.sha256 !== entry.sha256) errors.push(`${phase.id} remote skill snapshot failed integrity: ${entry.id}`);
    }
    if (!errors.length) passes.push(`remote agent context verified: ${phase.id} as ${audit.agent}`);
  }
  return { errors, warnings, passes };
}
