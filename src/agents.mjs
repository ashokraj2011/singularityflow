import { nextPhaseGeneration } from './phase-generation.mjs';
import { retainedSkillExpansion } from './retained-skill-instructions.mjs';
import { resolveSkillInstructions } from './instruction-library.mjs';
import { composeSkillInstructions } from './skill-instruction-composition.mjs';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { parseYamlText } from './yaml-parse-cache.mjs';
import { exists, nearestNames, nowIso, posix, secureRepositoryPath, snapshot, writeBytes, writeJson, writeText, SingularityFlowError } from './util.mjs';
import {
  DEFAULT_REMOTE_MAX_BYTES, HARD_REMOTE_MAX_BYTES, fetchRemoteMarkdown, validatePublicHttpsUrl
} from './remote-fetch.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { scopedCatalogRead } from './catalog-read-scope.mjs';
import {
  LIBRARY_SKILL_TABLE, SKILL_ATTACHMENTS_PATH, effectiveLibrarySkills, librarySkillReference, normalizeSkillUse,
  parseLibrarySkill, readLibrarySkill, readSkillAttachments, renderLibrarySkills
} from './skill-library.mjs';
import { repositoryGitPath } from './git-directory.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { COPILOT_AGENT_MAPPING_NAME_RULE, validCopilotAgentMappingName } from './copilot-agent-names.mjs';

export { fetchRemoteMarkdown, isPublicRemoteAddress, resolvePublicRemoteHost } from './remote-fetch.mjs';

export const AGENT_LOCK_PATH = 'singularity/agents.lock.yml';
export const AGENT_MAPPING_PATH = 'singularity/agent-mappings.yml';
const DEFAULT_MAX_BYTES = DEFAULT_REMOTE_MAX_BYTES;
const HARD_MAX_BYTES = HARD_REMOTE_MAX_BYTES;
const TOKEN_PATTERN = /\{([^}]+)\}/g;
import { AGENT_ALLOWED_TOKENS as ALLOWED_TOKENS } from './agent-document-parser.mjs';
/** Where imported copies of agent dependencies live; only paths under it are accepted in the lock. */
export const AGENT_VENDOR_ROOT = 'singularity/imports/agents';

// Repository copies of packaged agents remain repository-owned files: their public scope,
// editability, Story snapshot identity, and hashes must not change. Keep the stronger provenance
// needed by validation out of that serializable shape. `initializeDefinition` can add an optional
// pack's agent files to an older workflow before the pack itself is explicitly installed; an exact
// package copy is safe to leave dormant, while one changed byte restores strict repository-agent
// validation.
const EXACT_PACKAGED_REPOSITORY_AGENTS = new WeakSet();
let packagedAgentIdentitiesPromise = null;

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
export { parseAgentDependencies, parseAttachedSkills, isMcpDependencyUrl, isAgentTemplateReference, parseAgentTemplateReference } from './agent-document-parser.mjs';
import { parseAgentDependencies, validAgentId as idPattern, isMcpDependencyUrl, isAgentTemplateReference, parseAgentTemplateReference } from './agent-document-parser.mjs';

async function agentFiles(directory) {
  if (!(await exists(directory))) return [];
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /(?:\.agent)?\.md$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

function packagedAgentIdentity(file, text) {
  return `${path.basename(file).toLocaleLowerCase('en-US')}\0${hash(text)}`;
}

async function packagedAgentIdentities() {
  packagedAgentIdentitiesPromise ??= (async () => {
    const identities = new Set();
    for (const directory of [
      path.join(PACKAGE_ROOT, 'plugin/agents'),
      path.join(PACKAGE_ROOT, 'templates/agents')
    ]) {
      for (const file of await agentFiles(directory)) {
        const text = await readFile(file, 'utf8');
        identities.add(packagedAgentIdentity(file, text));
      }
    }
    return identities;
  })();
  return packagedAgentIdentitiesPromise;
}

export async function discoverAgents(root) {
  const repositoryRoot = configurationReadRoot(root);
  return scopedCatalogRead(JSON.stringify(['agents', path.resolve(root), repositoryRoot]),
    () => discoverAgentsSnapshot(root, repositoryRoot), (source, copy) => {
      source.forEach((agent, index) => {
        if (EXACT_PACKAGED_REPOSITORY_AGENTS.has(agent)) EXACT_PACKAGED_REPOSITORY_AGENTS.add(copy[index]);
      });
    });
}

async function discoverAgentsSnapshot(root, repositoryRoot) {
  const packagedIdentities = await packagedAgentIdentities();
  const locations = [
    ['repository', path.join(repositoryRoot, '.github/agents')],
    ['plugin', path.join(PACKAGE_ROOT, 'plugin/agents')],
    ['bundled', path.join(PACKAGE_ROOT, 'templates/agents')]
  ];
  const agents = new Map();
  for (const [scope, directory] of locations) {
    const localIds = new Map();
    for (const file of await agentFiles(directory)) {
      const text = await readFile(file, 'utf8');
      const parsed = parseAgentDependencies(text, { source: posix(path.relative(repositoryRoot, file)) });
      if (localIds.has(parsed.id)) throw new SingularityFlowError(
        `Agent ID '${parsed.id}' is declared by both '${localIds.get(parsed.id)}' and '${file}'. Give each agent a unique ID.`,
        { code: 'AGENT_ID_COLLISION', details: { id: parsed.id, scope, files: [localIds.get(parsed.id), file] } }
      );
      localIds.set(parsed.id, file);
      if (!agents.has(parsed.id)) {
        const discovered = { ...parsed, scope, file, text, sha256: hash(text) };
        agents.set(parsed.id, discovered);
        if (scope === 'repository'
            && packagedIdentities.has(packagedAgentIdentity(file, text))) {
          EXACT_PACKAGED_REPOSITORY_AGENTS.add(discovered);
        }
      }
    }
  }
  // Skills the attachments file attaches to an agent, whoever owns the agent. One naming an agent
  // that is not here is refused when configuration loads (assertAttachedLibrarySkills).
  for (const attachment of await readSkillAttachments(root)) {
    const agent = agents.get(attachment.agent);
    if (agent) {
      agent.attachedSkills = Object.freeze([...(agent.attachedSkills ?? []),
        Object.freeze({ id: attachment.id, phases: attachment.phases, use: attachment.use })]);
    }
  }
  return [...agents.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function validateAgentCatalog(agents, definition) {
  if (!agents.length) throw new SingularityFlowError('No Agent Markdown files were found in .github/agents or the bundled plugin.');
  const displayNames = new Map();
  for (const agent of agents) {
    const name = (agent.displayName ?? agent.label ?? agent.id).trim().toLowerCase();
    if (displayNames.has(name) && displayNames.get(name) !== agent.id) throw new SingularityFlowError(
      `Copilot agent name '${agent.displayName ?? agent.label}' is shared by '${displayNames.get(name)}' and '${agent.id}'. Rename one of them.`,
      { code: 'AGENT_NAME_COLLISION' }
    );
    displayNames.set(name, agent.id);
  }
  const phaseIds = new Set(Object.keys(definition.phases ?? {}));
  for (const agent of agents) {
    if (['read-only', 'read-only-review'].includes(agent.metadata?.['sflow-mode'])
        && agent.defaultFor.some((id) => phaseIds.has(id))) {
      throw new SingularityFlowError(`Read-only agent '${agent.id}' cannot be a phase's default author. Select a writable author and keep reviewer selection operation-scoped.`, {
        code: 'READ_ONLY_AGENT_DEFAULT_AUTHOR', details: { agentId: agent.id, phases: agent.defaultFor }
      });
    }
    // Repository agents are part of this repository's contract, so a misspelled or removed phase
    // must fail validation. Packaged agents are a catalog shared by every valid workflow-v2
    // repository, including repositories created before an optional profile/phase was added to the
    // package. Their extra declarations are dormant unless that phase exists locally; rejecting
    // them made an otherwise valid older v2 workflow unload when the extension was upgraded.
    if (agent.scope === 'repository' && !EXACT_PACKAGED_REPOSITORY_AGENTS.has(agent)) {
      for (const phase of [...agent.phases, ...agent.defaultFor]) {
        if (!phaseIds.has(phase)) {
          const [suggestion] = nearestNames(phase, [...phaseIds], { limit: 1 });
          throw new SingularityFlowError(
            `Agent '${agent.id}' references unknown phase '${phase}'.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`, {
              code: 'AGENT_PHASE_UNKNOWN',
              details: { agentId: agent.id, phaseId: phase, source: agent.source ?? null, ...(suggestion ? { suggestion } : {}) }
            }
          );
        }
      }
      for (const attachment of agent.librarySkills ?? []) {
        for (const phase of attachment.phases) {
          if (!phaseIds.has(phase)) throw new SingularityFlowError(
            `Agent '${agent.id}' attaches skill '${attachment.id}' for unknown phase '${phase}'.`, {
              code: 'AGENT_PHASE_UNKNOWN',
              details: { agentId: agent.id, phaseId: phase, skillId: attachment.id, source: agent.source ?? null }
            }
          );
        }
      }
    }
    // The attachments file is this repository's own, whoever owns the agent it names.
    for (const attachment of agent.attachedSkills ?? []) {
      for (const phase of attachment.phases) {
        if (!phaseIds.has(phase)) throw new SingularityFlowError(
          `${SKILL_ATTACHMENTS_PATH} attaches skill '${attachment.id}' to agent '${agent.id}' for unknown step '${phase}'.`, {
            code: 'AGENT_PHASE_UNKNOWN',
            details: { agentId: agent.id, phaseId: phase, skillId: attachment.id, source: SKILL_ATTACHMENTS_PATH }
          }
        );
      }
    }
  }
  for (const phaseId of phaseIds) {
    const compatible = agents.filter((agent) => !agent.phases.length || agent.phases.includes(phaseId));
    if (!compatible.length) throw new SingularityFlowError(`Phase '${phaseId}' has no compatible agent.`);
    const defaults = compatible.filter((agent) => agent.defaultFor.includes(phaseId));
    if (defaults.length !== 1) throw new SingularityFlowError(`Phase '${phaseId}' requires exactly one default agent; found ${defaults.length}.`);
  }
  return agents;
}

export function resolvePhaseAgent(agents, phaseId, { requestedAgent = null, nativeCopilotAgent = null } = {}) {
  const fallback = agents.find((agent) => agent.defaultFor.includes(phaseId));
  if (!fallback) throw new SingularityFlowError(`Phase '${phaseId}' has no default agent.`);
  const selected = requestedAgent ? agents.find((agent) => agent.id === requestedAgent) : fallback;
  if (!selected) throw new SingularityFlowError(`Unknown agent '${requestedAgent}'.`);
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
    if (!validCopilotAgentMappingName(copilotAgent)) throw new SingularityFlowError(`Copilot agent mapping key '${copilotAgent}' must ${COPILOT_AGENT_MAPPING_NAME_RULE}.`);
    if (typeof agentId !== 'string' || !idPattern(agentId)) throw new SingularityFlowError(`Copilot agent '${copilotAgent}' must map to a lower-case kebab-case agent ID.`);
    if (known && !known.has(agentId)) throw new SingularityFlowError(`Copilot agent '${copilotAgent}' maps to unknown agent '${agentId}'.`);
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
      `Copilot agent display name '${copilotAgent}' matches multiple agents. Add an exact mapping in ${AGENT_MAPPING_PATH}.`
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
  if (!agent) throw new SingularityFlowError(`Unknown agent '${id}'. Run singularity-flow agents list.`);
  return agent;
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

/**
 * The imported copy of a locked dependency. It is configuration, so the secure resolver reads the
 * approved configuration's copy when this process reads approved configuration; only paths under the
 * agent vendor root are read, and never through a symbolic link.
 */
async function vendoredDependency(root, locked) {
  const target = await secureRepositoryPath(root, portableVendoredPath(locked.vendored), {
    label: 'Imported agent dependency', type: 'file'
  });
  if (!target.exists) return { exists: false, size: 0, sha256: null, absolute: null };
  return { ...(await snapshot(target.absolute)), absolute: target.absolute };
}

export function portableVendoredPath(value) {
  const relative = String(value ?? '');
  if (!relative.startsWith(`${AGENT_VENDOR_ROOT}/`) || relative.includes('\\') || relative.includes('\0')
      || path.posix.normalize(relative) !== relative || relative.split('/').includes('..')) {
    throw new SingularityFlowError(`Imported agent dependency path '${relative}' must be a plain path under ${AGENT_VENDOR_ROOT}/.`, { code: 'AGENT_VENDORED_PATH_INVALID' });
  }
  return relative;
}

function cachePath(root, agentId, entry) {
  return repositoryGitPath(root, 'singularity-flow', 'agents', agentId, `${entry.type}-${entry.id}-${entry.sha256}.md`);
}

export async function resolveAgentLock(root, agent, { fetchImpl = globalThis.fetch, existing = null } = {}) {
  const dependencies = [];
  for (const dependency of agent.dependencies) {
    if (dependency.type === 'generated') {
      dependencies.push({ ...dependency, urlTemplate: dependency.url, url: undefined, dynamic: true, sha256: null, size: null, resolvedUrl: null });
      continue;
    }
    // An imported dependency's bytes were reviewed in the change that vendored them; re-fetching here
    // would trust new bytes the vendored copy does not contain. It changes only by importing again.
    const vendored = lockDependency(existing, dependency);
    if (vendored?.vendored) {
      if (vendored.url !== dependency.url) {
        throw new SingularityFlowError(
          `Agent '${agent.id}' ${dependency.type} '${dependency.id}' was imported from ${vendored.url}, but its row now names ${dependency.url}. Import the new source with singularity-flow import add instead of re-locking.`,
          { code: 'AGENT_VENDORED_SOURCE_CHANGED' }
        );
      }
      dependencies.push({ ...vendored });
      continue;
    }
    if (isMcpDependencyUrl(dependency.url)) {
      throw new SingularityFlowError(
        `Agent '${agent.id}' ${dependency.type} '${dependency.id}' comes from an MCP server and has no imported copy. Import it with singularity-flow import preview ${dependency.url.replace('mcp://', 'mcp:')} --launch, then import add.`,
        { code: 'AGENT_MCP_DEPENDENCY_NOT_IMPORTED' }
      );
    }
    try {
      const fetched = await fetchRemoteMarkdown(dependency.url, { maxBytes: dependency.maxBytes, fetchImpl });
      dependencies.push({ ...dependency, sha256: fetched.sha256, size: fetched.size, resolvedUrl: fetched.resolvedUrl });
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
  const resolution = suppliedResolution ?? await resolveAgentLock(root, agent, { fetchImpl, existing });
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
  if (locked.vendored) {
    const vendored = await vendoredDependency(root, locked);
    if (vendored.sha256 === locked.sha256) return { ...locked, path: vendored.absolute, status: 'ready', cached: true };
    const problem = vendored.exists
      ? `Imported ${dependency.type} '${dependency.id}' at ${locked.vendored} does not match its locked hash ${locked.sha256.slice(0, 12)}.`
      : `Imported ${dependency.type} '${dependency.id}' is missing from ${locked.vendored}.`;
    if (dependency.optional) return { ...locked, status: 'unavailable', warning: problem };
    throw new SingularityFlowError(`${problem} Restore the imported file or import it again.`, { code: 'AGENT_VENDORED_DEPENDENCY_MISMATCH' });
  }
  if (isMcpDependencyUrl(locked.url)) {
    const problem = `${dependency.type} '${dependency.id}' comes from an MCP server and has no imported copy.`;
    if (dependency.optional) return { ...locked, status: 'unavailable', warning: problem };
    throw new SingularityFlowError(`${problem} Import it again with singularity-flow import.`, { code: 'AGENT_MCP_DEPENDENCY_NOT_IMPORTED' });
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
  // The cache must hold the exact locked bytes: re-encoding the text (a missing final newline, a
  // byte-order mark) would make the cached file differ from its lock forever.
  await writeBytes(destination, fetched.bytes);
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
      const cached = locked?.vendored ? await vendoredDependency(root, locked)
        : locked?.sha256 ? await snapshot(cachePath(root, agent.id, locked)) : { exists: dependency.type === 'generated', sha256: null };
      dependencies.push({ id: dependency.id, type: dependency.type, optional: dependency.optional, locked: Boolean(locked), sha256: locked?.sha256 ?? null, status: !entry ? 'unlocked' : sourceChanged ? 'stale-agent' : !locked ? 'missing-lock' : locked.status === 'unavailable' ? 'unavailable' : dependency.type === 'generated' || (cached.exists && cached.sha256 === locked.sha256) ? 'ready' : 'needs-sync' });
    }
    results.push({ id: agent.id, scope: agent.scope, source: agent.source, sourceSha256: agent.sha256, locked: Boolean(entry), sourceChanged, status: !agent.dependencies.length ? 'local-only' : !entry ? 'unlocked' : sourceChanged ? 'stale' : dependencies.every((item) => ['ready', 'unavailable'].includes(item.status)) ? 'ready' : 'needs-sync', dependencies });
  }
  return results;
}



export async function materializeAgentTemplate(root, reference, { phaseId = null, ...options } = {}) {
  const { agentId, templateId } = parseAgentTemplateReference(reference); const synced = await syncAgent(root, agentId, options);
  const template = synced.dependencies.find((entry) => entry.type === 'template' && entry.id === templateId);
  if (!template) throw new SingularityFlowError(`Agent '${agentId}' has no locked remote template '${templateId}'.`);
  if (phaseId && !matches(phaseId, template.phases)) throw new SingularityFlowError(`Remote template '${agentId}/${templateId}' is not scoped to phase '${phaseId}'.`);
  if (template.status !== 'ready') throw new SingularityFlowError(`Remote template '${agentId}/${templateId}' is unavailable.`);
  return { source: 'agent', agent: agentId, resource: templateId, url: template.url, resolvedUrl: template.resolvedUrl, sha256: template.sha256, size: template.size, cachePath: template.path };
}

function matches(value, configured) { return !configured?.length || configured.includes(value); }

export async function renderAgentSkills(root, workflow, phase, session, {
  record = false, fetchImpl = globalThis.fetch, itemDirectory = null, executionContext = null
} = {}) {
  if (!session?.agent) return { text: '', skills: [], warnings: [] };
  const saved = executionContext?.identity?.mode === 'workflow-snapshot';
  // Skills from the skill master have their own rendering and warning, below.
  const remote = saved ? executionContext.dependencies.filter((entry) => entry.source !== 'library') : [];
  const synced = saved
    ? {
        agent: executionContext.agent,
        dependencies: remote.map((entry) => ({
          ...entry, sha256: entry.sha256?.replace(/^sha256:/, '') ?? null,
          type: entry.kind, status: entry.inclusion === 'included' ? 'ready' : 'unavailable',
          content: entry.text, size: entry.text == null ? null : Buffer.byteLength(entry.text),
          path: entry.blobPath, warning: entry.inclusion === 'omitted'
            ? `Optional ${entry.kind} '${entry.id}' was omitted from the accepted Story snapshot.` : null
        })),
        warnings: remote
          .filter((entry) => entry.inclusion === 'omitted')
          .map((entry) => `Optional ${entry.kind} '${entry.id}' was omitted from the accepted Story snapshot.`)
      }
    : await syncAgent(root, session.agent, { fetchImpl });
  const selected = [];
  for (const dependency of synced.dependencies.filter((entry) => entry.type === 'skill')) {
    if (!matches(phase.id, dependency.phases)) continue;
    if (dependency.status !== 'ready') { if (!dependency.optional) throw new SingularityFlowError(`Required remote skill '${dependency.id}' is unavailable.`); continue; }
    // Snapshot execution retains and verifies bytes before this renderer is entered. Opening the
    // historical path again would reintroduce a TOCTOU window; live/legacy execution keeps the
    // existing locked-cache read.
    const content = saved ? dependency.content : await readFile(dependency.path, 'utf8');
    selected.push({ ...dependency, content });
  }
  const library = await attachedLibrarySkills(root, phase, saved ? executionContext : null, synced.agent, session.agent);
  if (!saved) {
    for (const entry of (await readSkillAttachments(configurationReadRoot(root)))
      .filter((entry) => entry.workflow === workflow?.workItem?.workType && matches(phase.id, entry.phases))) {
      const skill = await readLibrarySkill(configurationReadRoot(root), entry.id);
      if (!skill) throw new SingularityFlowError(`Workflow '${entry.workflow}' attaches missing skill '${entry.id}'.`, { code: 'SKILL_LIBRARY_MISSING' });
      library.skills.push({ ...skill, use: entry.use, scopes: [`workflow ${entry.workflow}`] });
    }
  }
  // Same bytes can be attached through both scopes. Render once, preserving both use conditions.
  const unique = new Map();
  for (const entry of library.skills) {
    const prior = unique.get(entry.id);
    if (prior) {
      if (prior.sha256 !== entry.sha256) throw new SingularityFlowError(`Attached skill '${entry.id}' has conflicting retained bytes.`, { code: 'SKILL_ATTACHMENT_CONFLICT' });
      prior.scopes = [...new Set([...prior.scopes, ...entry.scopes])];
      // An unrestricted attachment must not become restricted by the other scope's condition.
      prior.use = [...new Set([prior.use || 'Whenever this step needs it', entry.use || 'Whenever this step needs it'])].join('; ');
    } else unique.set(entry.id, { ...entry, scopes: entry.scopes ?? [`agent ${session.agent}`] });
  }
  library.skills = [...unique.values()];
  const expansions = new Map(library.skills.flatMap(entry => {
    const command = retainedSkillExpansion(workflow, phase, executionContext, entry);
    return command ? [[entry.id, command]] : [];
  }));
  // Definitions referenced by on-demand skills are retained with the skill, not eagerly loaded.
  for (const skill of library.skills) {
    if (!saved) skill.referencedInstructions = await resolveSkillInstructions(configurationReadRoot(root), skill);
  }
  const composition = composeSkillInstructions(library.skills.filter(entry => !expansions.has(entry.id)));
  const text = [
    selected.map((entry) => `<!-- agent skill: ${session.agent}/${entry.id} sha256=${entry.sha256} -->\n\n## Agent skill: ${entry.id}\n\n${entry.content.trim()}`).join('\n\n'),
    renderLibrarySkills(session.agent, library.skills, { expansions, composition }),
    composition.tail
  ].filter(Boolean).join('\n\n');
  const warnings = [...synced.warnings, ...library.warnings];
  let audit = null;
  if (record && workflow && itemDirectory && (selected.length || library.skills.length)) {
    const generation = nextPhaseGeneration(phase); const files = [];
    for (const entry of selected) {
      const target = saved ? null
        : path.join(itemDirectory, 'context/agent-snapshots', session.agent, `${entry.id}-${entry.sha256}.md`);
      if (target && !(await exists(target))) { await mkdir(path.dirname(target), { recursive: true }); await copyFile(entry.path, target); }
      files.push({
        id: entry.id, type: 'skill', url: saved ? null : entry.url,
        sha256: String(entry.sha256).replace(/^sha256:/, ''), size: entry.size,
        path: saved ? entry.path : posix(path.relative(root, target))
      });
    }
    // A skill from the skill master is recorded by the exact text the prompt used.
    for (const entry of library.skills) {
      const target = saved ? null
        : path.join(itemDirectory, 'context/agent-snapshots', session.agent, `${entry.id}-${entry.sha256}.md`);
      if (target && !(await exists(target))) await writeText(target, entry.text);
      files.push({
        id: entry.id, type: 'skill', url: saved ? null : librarySkillReference(entry.id),
        sha256: entry.sha256, size: entry.bytes,
        path: saved ? entry.path : posix(path.relative(root, target))
      });
    }
    const seenInstructions = new Set();
    for (const skill of library.skills.filter(entry => !expansions.has(entry.id))) for (const item of skill.referencedInstructions ?? []) {
      if (seenInstructions.has(item.id)) continue;
      seenInstructions.add(item.id);
      files.push({ id: item.id, type: 'instruction', url: null, sha256: item.sha256, size: item.bytes, path: item.path });
    }
    audit = { schemaVersion: currentSchemaVersion('agent-context-audit'), workId: workflow.workItem.id, phase: phase.id, generation, agent: session.agent, nativeCopilotAgent: session.nativeCopilotAgent ?? null, agentSourceSha256: synced.agent.sha256, files, recordedAt: nowIso() };
    await writeJson(path.join(itemDirectory, 'context', `agents-${phase.id}-gen${generation}.json`), audit);
  }
  return { text, skills: [...selected, ...library.skills], warnings, audit,
    loading: [...selected, ...library.skills].map(entry => ({
      id: entry.id, sha256: entry.sha256,
      representation: expansions.has(entry.id) ? 'retained-catalog' : 'full-instructions',
      loading: entry.loading ?? 'eager', instructionBytes: Buffer.byteLength(entry.instructions ?? entry.content ?? '')
    })) };
}

/**
 * The skills from the skill master an agent applies in a step. In a Story snapshot they are the
 * bytes retained when the Story started, attached by the saved agent; a later edit to a skill or to
 * the agent does not change that Story. Live, they are read from the library, and an attached
 * skill that is missing there stops the prompt.
 */
async function attachedLibrarySkills(root, phase, executionContext, agent, agentId) {
  const skills = []; const warnings = [];
  if (executionContext) {
    for (const entry of executionContext.dependencies.filter((dependency) => dependency.source === 'library')) {
      if (!matches(phase.id, entry.phases)) continue;
      if (entry.inclusion !== 'included') {
        warnings.push(`Skill '${entry.id}' is attached to ${agentId}, but this Story's snapshot did not keep it when the Story started, so this Story does not use it.`);
        continue;
      }
      const parsed = parseLibrarySkill(entry.text, { id: entry.id });
      skills.push({ ...parsed, sha256: parsed.sha256, use: entry.use ?? '', path: entry.blobPath ?? null,
        referencedInstructions: entry.referencedInstructions ?? [],
        scopes: [entry.scope === 'workflow' ? `workflow ${entry.workflowId}` : `agent ${agentId}`] });
    }
    return { skills, warnings };
  }
  for (const attachment of effectiveLibrarySkills(agent)) {
    if (!matches(phase.id, attachment.phases)) continue;
    const skill = await readLibrarySkill(configurationReadRoot(root), attachment.id);
    if (!skill) {
      throw new SingularityFlowError(`Skill '${attachment.id}' is attached to ${agentId} but is not in the skill master.`, {
        code: 'SKILL_LIBRARY_MISSING', details: { agentId, skillId: attachment.id }
      });
    }
    skills.push({ ...skill, use: attachment.use, scopes: [`agent ${agentId}`] });
  }
  return { skills, warnings };
}

function expandUrl(template, workflow, phase) {
  const values = { workId: workflow.workItem.id, workType: workflow.workItem.workType, phase: phase.id, generation: nextPhaseGeneration(phase) };
  return template.replace(TOKEN_PATTERN, (_, token) => encodeURIComponent(String(values[token])));
}

export async function prepareRemoteOutputs(root, workflow, phase, session, {
  itemDirectory, refresh = false, replace = false, resourceId = null,
  fetchImpl = globalThis.fetch, executionContext = null
} = {}) {
  if (!session?.agent) return { outputs: [], warnings: [] };
  const saved = executionContext?.identity?.mode === 'workflow-snapshot';
  const synced = saved
    ? { agent: executionContext.agent, lock: null }
    : await syncAgent(root, session.agent, { fetchImpl });
  const outputs = []; const warnings = [];
  for (const dependency of synced.agent.generated.filter((entry) => entry.phase === phase.id && (!resourceId || entry.id === resourceId))) {
    const savedRequirement = saved
      ? executionContext.dependencies.find((entry) => (
          entry.kind === 'generated' && entry.id === dependency.id
        ))
      : null;
    if (saved && savedRequirement?.inclusion !== 'external-requirement') {
      throw new SingularityFlowError(
        `Saved generated artifact requirement '${session.agent}/${dependency.id}' is unavailable.`,
        { code: 'WFA_DEPENDENCY_UNAVAILABLE' }
      );
    }
    // Dynamic generated output is a local capability requirement, not portable response bytes.
    // Its URL/target declaration comes from the verified saved agent; legacy execution retains the
    // reviewed live lock check.
    const locked = saved ? { dynamic: true } : lockDependency(synced.lock, dependency);
    if (!locked?.dynamic) throw new SingularityFlowError(`Generated artifact '${dependency.id}' is not present in the agent lock.`);
    const generation = nextPhaseGeneration(phase);
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
      await writeBytes(target, fetched.bytes);
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
