/**
 * The configuration a Story branch carries: its own workflow's closure, not every workflow's.
 *
 * Story start copied the whole approved configuration into each Story branch: every work type in
 * `singularity/workflow.yml`, every agent, template, skill and instruction. A Story runs only its
 * own work type, so this module picks that work type's closure out of the approved revision.
 *
 * What a workflow depends on is decided once, by the workflow bundle closure
 * (`workflowRetirementSupport.buildBundle`, the graph export and delete already use). Two
 * Story-specific choices are passed into it:
 * - `seedAgents`: every agent that may draft one of the Story's steps, the same rule the Story's
 *   pinned catalog uses (`snapshotResolution`). A Story may switch to any of them.
 * - `serverScope: 'selected'`: an MCP server travels without the other workflows' steps that also
 *   use it, and is narrowed below to the steps and agents this branch carries.
 *
 * The projection is pure: the same approved bytes and work types always give the same files, so a
 * later check can derive it again from the approved revision and compare. Files kept whole are the
 * approved bytes. Four kinds of file are rewritten, and each records the approved object it came
 * from: `singularity/workflow.yml` (only this work type and what it uses), agents that also serve
 * other workflows' steps (their step lists are trimmed, as export does), the skill attachments
 * file and the Copilot agent mapping file (rows for agents and workflows this branch does not
 * carry are dropped).
 *
 * Only per-workflow content is left out: agents, workflow templates, library skills and
 * instructions, and user-defined agent folders this closure does not use. Every other approved
 * file stays: repository settings (portfolio, capabilities, impact, model tiers, environments,
 * prompts, constitutions, locks) are read during a Story and are small.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { AGENT_MAPPING_PATH } from './agents.mjs';
import { loadDefinition } from './config.mjs';
import { configurationAssetPolicy, isConfigurationAssetPath } from './engine-compatibility/node-configuration-path.mjs';
import { copyCompiledDefinition } from './configuration-definition-cache.mjs';
import { withConfigurationReadRoot } from './configuration-read-scope.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';
import { INSTRUCTION_LIBRARY_ROOT } from './instruction-library.mjs';
import { recordSha256 } from './records.mjs';
import { SKILL_ATTACHMENTS_PATH, SKILL_LIBRARY_ROOT } from './skill-library.mjs';
import { USER_DEFINED_ROOT } from './user-defined-agent-identity.mjs';
import { removeTemporaryTree, SingularityFlowError } from './util.mjs';
import { workflowRetirementSupport } from './workflow-transfer.mjs';
import { renderPreservingFormatting } from './yaml-formatting.mjs';

export const STORY_CONFIGURATION_CLOSURE_KIND = 'work-type';
const WORKFLOW_FILE = 'singularity/workflow.yml';

function fail(message, code, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
const posixDirname = (relative) => path.posix.dirname(relative);
const within = (relative, root) => relative === root || relative.startsWith(`${root}/`);

/**
 * The library entry a path belongs to: `<root>/<name>/…` names `name`, and with `manifests` so
 * does `<root>/<name>.json`. Null for anything else, such as a file directly under the root.
 */
function libraryEntry(relative, root, { manifests = false } = {}) {
  if (!relative.startsWith(`${root}/`)) return null;
  const rest = relative.slice(root.length + 1);
  const slash = rest.indexOf('/');
  if (slash > 0) return rest.slice(0, slash);
  return manifests && rest.endsWith('.json') && rest.length > 5 ? rest.slice(0, -5) : null;
}

/** Git's own object ID for `bytes`, in the repository's object format (SHA-1 or SHA-256). */
export function gitBlobObject(bytes, format = 'sha1') {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * The agents the Story's pinned catalog keeps (`snapshotResolution`): one that names no step, one
 * that names a step of these work types, and every step default and source reviewer.
 */
export function storyCatalogAgents(definition, workTypes, resolveWorkType) {
  const kept = new Set();
  for (const workTypeId of workTypes) {
    const resolved = resolveWorkType(structuredClone(definition), workTypeId);
    const phaseIds = new Set(resolved.phases.map((phase) => phase.id));
    const required = new Set([
      ...resolved.phases.map((phase) => phase.defaultAgent).filter(Boolean),
      resolved.sourceReview?.mode !== 'off' ? resolved.sourceReview?.reviewerAgent : null
    ].filter(Boolean));
    for (const agent of definition.agentCatalog ?? []) {
      if (agent.phases?.length && !agent.phases.some((id) => phaseIds.has(id)) && !required.has(agent.id)) continue;
      kept.add(agent.id);
    }
  }
  return kept;
}

/** Delete every key of the map at `keys` that `kept` does not hold. */
function keepOnly(document, value, keys, kept) {
  let map = value;
  for (const key of keys) map = plain(map) ? map[key] : undefined;
  if (!plain(map)) return;
  for (const id of Object.keys(map)) if (!kept.has(id)) document.deleteIn([...keys, id]);
}

/** Replace the list at `keys`, keeping its flow (`[a, b]`) or block layout. */
function setList(document, keys, values) {
  const node = document.createNode(values);
  if (YAML.isSeq(document.getIn(keys, true)) && document.getIn(keys, true).flow) node.flow = true;
  document.setIn(keys, node);
}

/** A list narrowed to `kept`; null when a list that named entries would name none (it would mean "any"). */
function narrowedList(list, kept) {
  if (!Array.isArray(list) || !list.length) return list;
  const narrowed = list.filter((id) => kept.has(id));
  return narrowed.length ? narrowed : null;
}

/**
 * `singularity/workflow.yml` with only these work types and the objects their closure uses.
 * Repository settings (approval groups, artifact sets, security, roots, policies) are kept whole:
 * approval groups are governance identities, an approval with no named group uses the file's first
 * group, and a Story pins the whole artifact-set catalog, so its policy matches a whole copy's.
 */
export function projectWorkflowText(text, { workTypes, objects, phases, agents }) {
  const document = YAML.parseDocument(text);
  if (document.errors?.length) fail(`Cannot parse ${WORKFLOW_FILE}: ${document.errors[0].message}`, 'STORY_CONFIGURATION_CLOSURE_INVALID');
  const value = document.toJS() ?? {};
  keepOnly(document, value, ['workTypes'], new Set(workTypes));
  keepOnly(document, value, ['phases'], phases);
  keepOnly(document, value, ['templates'], new Set(Object.keys(objects.templates ?? {})));
  keepOnly(document, value, ['integrations', 'targets'], new Set(Object.keys(objects.integrations?.targets ?? {})));
  const servers = new Set(Object.keys(objects.mcpServers ?? {}));
  keepOnly(document, value, ['mcpServers'], servers);
  for (const id of servers) {
    const server = value.mcpServers?.[id];
    if (!plain(server)) continue;
    for (const [field, carried] of [['phases', phases], ['agents', agents]]) {
      const narrowed = narrowedList(server[field], carried);
      if (narrowed === null) {
        fail(`MCP server '${id}' is used here but none of its ${field} are carried.`, 'STORY_CONFIGURATION_CLOSURE_INVALID');
      }
      if (Array.isArray(server[field]) && narrowed.length !== server[field].length) setList(document, ['mcpServers', id, field], narrowed);
    }
  }
  // An allow-list (empty allows none), and each work type keeps only its own steps of it anyway.
  const allowed = value.documents?.allowedPhases;
  if (Array.isArray(allowed) && allowed.some((id) => !phases.has(id))) {
    setList(document, ['documents', 'allowedPhases'], allowed.filter((id) => phases.has(id)));
  }
  keepOnly(document, value, ['contextPolicy', 'phaseOverrides'], phases);
  const defaultWorkflow = value.delivery?.defaultWorkflowProfile;
  if (typeof defaultWorkflow === 'string' && !workTypes.includes(defaultWorkflow)) {
    document.setIn(['delivery', 'defaultWorkflowProfile'], workTypes[0]);
  }
  return renderPreservingFormatting(text, document);
}

/** The attachments file without rows for agents or workflows this branch does not carry. */
export function projectSkillAttachmentsText(text, { workTypes, agents, phases }) {
  const document = YAML.parseDocument(text);
  if (document.errors?.length) fail(`Cannot parse ${SKILL_ATTACHMENTS_PATH}: ${document.errors[0].message}`, 'STORY_CONFIGURATION_CLOSURE_INVALID');
  const rows = document.toJS()?.attachments;
  if (!Array.isArray(rows)) return { text, skills: new Set() };
  const skills = new Set();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const carried = typeof row?.agent === 'string' ? agents.has(row.agent)
      : typeof row?.workflow === 'string' && workTypes.includes(row.workflow);
    const steps = strings(row?.steps);
    const narrowed = narrowedList(steps, phases);
    if (!carried || narrowed === null) { document.deleteIn(['attachments', index]); continue; }
    if (steps.length && narrowed.length !== steps.length) setList(document, ['attachments', index, 'steps'], narrowed);
    if (typeof row.skill === 'string') skills.add(row.skill);
  }
  return { text: renderPreservingFormatting(text, document), skills };
}

/** The Copilot agent mapping file without rows naming an agent this branch does not carry. */
export function projectAgentMappingsText(text, agents) {
  const document = YAML.parseDocument(text);
  if (document.errors?.length) return text;
  const mappings = document.toJS()?.mappings;
  if (!plain(mappings)) return text;
  for (const [name, agentId] of Object.entries(mappings)) {
    if (typeof agentId === 'string' && !agents.has(agentId)) document.deleteIn(['mappings', name]);
  }
  return renderPreservingFormatting(text, document);
}

/**
 * Compute the closure of `workTypes` from the approved assets.
 *
 * `root` is a plain directory holding exactly the approved snapshot's bytes; the bundle closure
 * reads it directly. `assets` are that snapshot's verified entries, `definition` its compiled
 * definition and `resolveWorkType` the compiler's resolver. Returns the entries to materialize, in path order,
 * each with its bytes and Git identity; rewritten ones also name the approved object they came from.
 */
export async function projectStoryConfiguration(root, { assets, definition, workTypes, resolveWorkType }) {
  const selected = [...new Set(workTypes)].sort();
  if (!selected.length) fail('A Story configuration closure needs at least one work type.', 'STORY_CONFIGURATION_CLOSURE_INVALID');
  for (const id of selected) {
    if (!Object.hasOwn(definition.workTypes ?? {}, id)) fail(`Work type '${id}' is not in the approved configuration.`, 'STORY_CONFIGURATION_CLOSURE_INVALID');
  }
  const catalog = new Map((definition.agentCatalog ?? []).map((agent) => [agent.id, agent]));
  const seedAgents = [...storyCatalogAgents(definition, selected, resolveWorkType)].sort();
  // Approved skill packages (`singularity/skills/`) are kept whole below, so the bundle need not
  // capture them; that capture is the one part of the closure that needs a verified overlay.
  const bundle = await workflowRetirementSupport.buildBundle(root, selected.map((id) => `story:${id}`), {
    seedAgents, serverScope: 'selected', skillPackages: false
  });
  const objects = bundle.objects.story;
  const phases = new Set(Object.keys(objects.phases ?? {}));
  const bundledAgents = bundle.assets.filter((asset) => asset.kind === 'agent').map((asset) => asset.id);
  // Agents a validator may see: those carried here plus the packaged ones every installation has.
  const knownAgents = new Set([...bundledAgents,
    ...[...catalog.values()].filter((agent) => agent.scope !== 'repository').map((agent) => agent.id)]);
  const repositoryAgentFiles = new Map([...catalog.values()].filter((agent) => agent.scope === 'repository')
    .map((agent) => [agent.source, agent.id]));
  const keptAgentFiles = new Set(bundledAgents.map((id) => catalog.get(id))
    .filter((agent) => agent?.scope === 'repository').map((agent) => agent.source));
  const keptTemplates = new Set(bundle.assets.filter((asset) => asset.kind === 'template').map((asset) => asset.path));
  const keptSkills = new Set(bundle.assets.filter((asset) => asset.kind === 'skill')
    .map((asset) => libraryEntry(posixDirname(asset.path) + '/', SKILL_LIBRARY_ROOT)));
  const keptInstructions = new Set(bundle.assets.filter((asset) => asset.kind === 'instruction')
    .map((asset) => libraryEntry(posixDirname(asset.path) + '/', INSTRUCTION_LIBRARY_ROOT)));
  const keptUserDefined = new Set(bundle.assets.filter((asset) => asset.kind === 'user-defined')
    .map((asset) => libraryEntry(asset.path, USER_DEFINED_ROOT, { manifests: true })));
  const templateRoots = [...new Set([definition.templatesRoot ?? 'singularity/templates',
    ...Object.values(bundle.requirements?.templateRoots ?? {})].filter(Boolean))];
  // A template root is chosen by the repository. One that also holds the workflow, a library or
  // other repository settings is not a template folder this closure may thin out.
  if (templateRoots.some((templateRoot) => [WORKFLOW_FILE, SKILL_LIBRARY_ROOT, INSTRUCTION_LIBRARY_ROOT, USER_DEFINED_ROOT,
    AGENT_MAPPING_PATH].some((relative) => within(relative, templateRoot)))) {
    fail('A template root also holds repository configuration, so its templates are copied whole.', 'STORY_CONFIGURATION_CLOSURE_INVALID');
  }

  const byPath = new Map(assets.map((entry) => [entry.relative, entry]));
  const format = /^[0-9a-f]{64}$/u.test(byPath.get(WORKFLOW_FILE)?.object ?? '') ? 'sha256' : 'sha1';
  const entries = [];
  const derive = (entry, bytes, transform) => {
    if (bytes.equals(entry.contents)) return { ...entry };
    return {
      relative: entry.relative, contents: bytes, mode: entry.mode, gitMode: entry.gitMode,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      object: gitBlobObject(bytes, format),
      derived: Object.freeze({ object: entry.object, sha256: entry.sha256, transform })
    };
  };
  for (const entry of assets) {
    const relative = entry.relative;
    const text = () => entry.contents.toString('utf8');
    if (relative === WORKFLOW_FILE) {
      entries.push(derive(entry, Buffer.from(projectWorkflowText(text(), {
        workTypes: selected, objects, phases, agents: knownAgents
      }), 'utf8'), 'work-type-projection'));
      continue;
    }
    if (repositoryAgentFiles.has(relative)) {
      if (!keptAgentFiles.has(relative)) continue;
      entries.push(derive(entry, Buffer.from(workflowRetirementSupport.phaseScopedAgentText(text(), phases), 'utf8'), 'agent-steps'));
      continue;
    }
    if (relative === SKILL_ATTACHMENTS_PATH) {
      const projected = projectSkillAttachmentsText(text(), { workTypes: selected, agents: knownAgents, phases });
      if (!projected.skills.size) continue;
      entries.push(derive(entry, Buffer.from(projected.text, 'utf8'), 'skill-attachments'));
      continue;
    }
    if (relative === AGENT_MAPPING_PATH) {
      entries.push(derive(entry, Buffer.from(projectAgentMappingsText(text(), knownAgents), 'utf8'), 'agent-mappings'));
      continue;
    }
    // A library entry (a skill, an instruction, a user-defined agent's folder and manifest) travels
    // whole or not at all; a file directly under a library root belongs to no entry and stays.
    const skill = libraryEntry(relative, SKILL_LIBRARY_ROOT);
    const instruction = libraryEntry(relative, INSTRUCTION_LIBRARY_ROOT);
    const userDefined = libraryEntry(relative, USER_DEFINED_ROOT, { manifests: true });
    if (skill != null || instruction != null || userDefined != null) {
      if (keptSkills.has(skill) || keptInstructions.has(instruction) || keptUserDefined.has(userDefined)) entries.push({ ...entry });
      continue;
    }
    if (templateRoots.some((templateRoot) => within(relative, templateRoot))) {
      if (keptTemplates.has(relative)) entries.push({ ...entry });
      continue;
    }
    entries.push({ ...entry });
  }
  return Object.freeze({
    kind: STORY_CONFIGURATION_CLOSURE_KIND,
    workTypes: Object.freeze(selected),
    entries: Object.freeze(entries.sort((left, right) => left.relative.localeCompare(right.relative))),
    approvedAssetCount: assets.length
  });
}

async function writeEntries(entries, directory) {
  for (const entry of entries) {
    const target = path.join(directory, entry.relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.contents);
    await chmod(target, entry.mode);
  }
}

const yamlOf = (entries, relative) => {
  const entry = entries.find((candidate) => candidate.relative === relative);
  return entry ? YAML.parse(entry.contents.toString('utf8')) ?? {} : {};
};

/**
 * Project, then compile, the closure of `workTypes`. `inputs()` gives the verified snapshot's
 * entries, a private copy of its compiled definition and the compiler's resolver.
 */
async function computeClosure(workTypes, inputs) {
  const { assets, definition, resolveWorkType } = inputs();
  const host = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-closure-'));
  try {
    // The verified bytes, laid out as a repository the bundle closure reads directly.
    const approved = path.join(host, 'approved');
    await writeEntries(assets, approved);
    const projection = await projectStoryConfiguration(approved, { assets, definition, workTypes, resolveWorkType });
    const entries = Object.freeze(projection.entries.map((entry) => Object.freeze({ ...entry })));
    const scratch = path.join(host, 'closure');
    await writeEntries(entries, scratch);
    const assetPolicy = configurationAssetPolicy(yamlOf(entries, WORKFLOW_FILE), yamlOf(entries, 'singularity/portfolio.yml'));
    if (entries.some((entry) => !isConfigurationAssetPath(entry.relative, assetPolicy))) {
      fail('The Story configuration closure changed which files are configuration.', 'STORY_CONFIGURATION_CLOSURE_INVALID');
    }
    // The closure must stand on its own: every Story command that loads the definition reads it.
    const compiled = copyCompiledDefinition(await withConfigurationReadRoot(scratch, scratch, null,
      () => loadDefinition(scratch), { assetPolicy }), scratch, scratch);
    const definitionSha256 = recordSha256(compiled);
    const closureAssets = Object.freeze(Object.fromEntries(entries.map((entry) => [entry.relative, Object.freeze({
      sha256: entry.sha256, object: entry.object, mode: entry.gitMode
    })])));
    const derived = Object.freeze(Object.fromEntries(entries.filter((entry) => entry.derived)
      .map((entry) => [entry.relative, entry.derived])));
    /** The compiled definition rebound to `root`; refuses one changed in memory. */
    const copyDefinition = (root = scratch) => {
      if (recordSha256(compiled) !== definitionSha256) {
        fail('Verified Story configuration closure changed in memory.', 'STORY_CONFIGURATION_SNAPSHOT_INVALID');
      }
      return copyCompiledDefinition(compiled, scratch, root);
    };
    return Object.freeze({
      kind: projection.kind, workTypes: projection.workTypes, approvedAssetCount: projection.approvedAssetCount,
      entries, assets: closureAssets, derived, copyDefinition,
      /** The expected checkout for a record naming this closure, or null when it names another. */
      materialization(recorded, root) {
        if (recorded?.kind !== STORY_CONFIGURATION_CLOSURE_KIND
            || !isDeepStrictEqual(recorded.derived ?? {}, { ...derived })) return null;
        return {
          assets: Object.fromEntries(Object.entries(closureAssets).map(([relative, entry]) => [relative, { ...entry }])),
          definition: () => copyDefinition(root)
        };
      }
    });
  } finally {
    await removeTemporaryTree(host);
  }
}

const CLOSURES = new WeakMap();

/**
 * The closure of `workTypes` from one verified snapshot, computed once per snapshot and work-type
 * set. `snapshot` is the owner-verified object and only keys the cache; `inputs` supplies its bytes.
 */
export function storyConfigurationClosure(snapshot, workTypes, inputs) {
  if (!Array.isArray(workTypes) || !workTypes.length || workTypes.some((id) => typeof id !== 'string')) {
    return Promise.reject(new SingularityFlowError('A Story configuration closure names its work types.', {
      code: 'STORY_CONFIGURATION_CLOSURE_INVALID'
    }));
  }
  const selected = [...new Set(workTypes)].sort();
  const key = JSON.stringify(selected);
  let closures = CLOSURES.get(snapshot);
  if (!closures) CLOSURES.set(snapshot, closures = new Map());
  if (!closures.has(key)) {
    const pending = measureCommandSpan('configuration.closure', () => computeClosure(selected, inputs));
    // A refusal is reported to its caller; a later caller computes again rather than inherit it.
    closures.set(key, pending);
    pending.catch(() => { if (closures.get(key) === pending) closures.delete(key); });
  }
  return closures.get(key);
}

/**
 * The closure a new Story branch receives, or null for the whole copy (`reason` says why).
 *
 * A base branch that already carries configuration (an older layout, or a merged Story) keeps the
 * work types it carries (`carried`, its `workTypes` map), so the Story never deletes configuration
 * its base has (`base`) and the approved revision still has. A start agent that is a repository
 * agent outside the closure would otherwise be replaced by a packaged copy, so its audited override
 * keeps the whole copy too. `closureFor(workTypes)` computes a verified closure.
 */
export async function storyBranchClosure(closureFor, { approved, assets, workTypes, agents = [], base = [], carried = null }) {
  const selected = new Set(workTypes);
  for (const id of Object.keys(plain(carried) ? carried : {})) {
    if (Object.hasOwn(approved.workTypes ?? {}, id)) selected.add(id);
  }
  let closure;
  try { closure = await closureFor([...selected]); }
  catch (error) {
    incrementCommandCounter('configuration.closure-unavailable');
    return { closure: null, reason: error?.code ?? 'STORY_CONFIGURATION_CLOSURE_INVALID' };
  }
  const approvedPaths = new Set(assets.map((entry) => entry.relative));
  if (base.some((relative) => approvedPaths.has(relative) && !closure.assets[relative])) {
    return { closure: null, reason: 'STORY_CONFIGURATION_BASE_CARRIES_MORE' };
  }
  if (agents.some((id) => (approved.agentCatalog ?? []).some((agent) => agent.id === id
      && agent.scope === 'repository' && !closure.assets[agent.source]))) {
    return { closure: null, reason: 'STORY_CONFIGURATION_AGENT_OUTSIDE_CLOSURE' };
  }
  return { closure, reason: null };
}
