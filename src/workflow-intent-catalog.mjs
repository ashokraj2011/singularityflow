/** One owner-captured catalog shared by intent authoring, exact retrieval and markup compilation. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, lstat, rm, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { TextDecoder } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { SingularityFlowError, secureRepositoryPath } from './util.mjs';
import { canonicalJson } from './records.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { scanEntries } from './secrets.mjs';
import { WORKFLOW_INTENT_PATTERNS, WORKFLOW_INTENT_FAMILIES } from './workflow-intent-patterns.mjs';

export const WORKFLOW_INTENT_CATALOG_FORMAT = 'sflow-workflow-intent-catalog/v1';
export const WORKFLOW_INTENT_KINDS = Object.freeze(['agent', 'skill', 'instruction', 'command-skill', 'phase', 'workflow', 'template', 'approval-authority', 'constitution', 'quality-command', 'execution-task', 'mcp-server']);
const sha = value => `sha256:${createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')}`;
const fail = (message, code = 'WORKFLOW_INTENT_INVALID') => { throw new SingularityFlowError(message, { code }); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const MAX_BYTES = 32 * 1024 * 1024;
const TEXT_BYTES = 1024 * 1024;

async function captureText(file, maximum = TEXT_BYTES) {
  const selected = await lstat(file, { bigint: true });
  if (!selected.isFile() || selected.size > BigInt(maximum)) fail('Catalog assets must be bounded regular UTF-8 files.', 'WORKFLOW_INTENT_ASSET_UNAVAILABLE');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || selected.dev !== before.dev || selected.ino !== before.ino || selected.size !== before.size) fail('Catalog asset selection changed.');
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) { const chunk = await handle.read(bytes, length, bytes.length - length, null); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (length > maximum || BigInt(length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('Catalog asset changed while being captured.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}

function declaredTags(text) {
  const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text ?? '');
  const value = front ? YAML.parse(front[1])?.metadata?.['sflow-tags'] : undefined;
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some(tag => typeof tag !== 'string' || !/^[a-z0-9]+(?:[-:][a-z0-9]+)*$/u.test(tag) || tag.length > 80)) fail('metadata.sflow-tags must be at most 32 short lower-case tags.');
  return [...new Set(value)];
}

async function capture(root, authority) {
  const [{ loadDefinition }, { discoverAgents }, library, instructionLibrary, { normalizeTemplateCatalog, resolveTemplate }, { studioConstitutions }, scope] = await Promise.all([
    import('./config.mjs'), import('./agents.mjs'), import('./skill-library.mjs'), import('./instruction-library.mjs'),
    import('./template-catalog.mjs'), import('./studio-constitution.mjs'), import('./configuration-read-scope.mjs')
  ]);
  const configRoot = scope.configurationReadRoot(root);
  const files = new Map(); let bytes = 0;
  const retain = (relative, text) => {
    if (files.has(relative)) return;
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES || files.size >= 4096) fail('The declared authoring catalog exceeds its bounded capture budget.', 'WORKFLOW_INTENT_LIMIT');
    files.set(relative, text);
  };
  const read = async relative => {
    const secured = await secureRepositoryPath(configRoot, relative, { label: 'Workflow catalog asset', type: 'file' });
    if (!secured.exists) fail(`Catalog asset '${relative}' is unavailable.`, 'WORKFLOW_INTENT_ASSET_UNAVAILABLE');
    const text = await captureText(secured.absolute); retain(relative, text); return text;
  };
  const rawText = await read('singularity/workflow.yml'); const definition = YAML.parse(rawText);
  await loadDefinition(root); // Existing policy validation owns meaning, not this discovery layer.
  const agents = await discoverAgents(root);
  const skills = await library.loadSkillLibrary(configRoot);
  const instructions = await instructionLibrary.loadInstructionLibrary(configRoot);
  const attachmentFile = await library.readSkillAttachments(configRoot);
  const entries = [], problems = [...skills.problems, ...instructions.problems];
  const add = (kind, id, value, { label = id, description = '', text = null, dependencies = [], tags = [] } = {}) => {
    let explicit = [], unavailable = null;
    try { explicit = declaredTags(text); } catch (error) { unavailable = error.code; problems.push({ kind, id, code: error.code, message: error.message }); }
    if (!scanEntries([{ path: `${kind}/${id}`, content: text ?? JSON.stringify(value), forceScan: true }]).clean) unavailable = 'WORKFLOW_INTENT_CONTENT_BLOCKED';
    const terms = `${id} ${description}`.toLowerCase();
    const frameworks = ['angular', 'spring', 'react', 'vue', 'java', 'python', 'playwright', 'vitest'].filter(word => new RegExp(`\\b${word}\\b`, 'u').test(terms));
    const item = { kind, id, label: unavailable ? id : label, description: unavailable ? 'Unavailable for authoring; inspect catalog diagnostics.' : String(description).slice(0, 1024),
      sha256: sha(value), tags: [...new Set([`kind:${kind}`, `source:${authority.kind === 'installed-package' ? 'installed' : 'approved'}`, ...tags, ...frameworks.map(word => `framework:${word}`), ...explicit])].sort(compare),
      dependencies, available: unavailable == null, ...(unavailable ? { problem: unavailable } : {}) };
    entries.push({ ...item, value }); return item;
  };
  for (const agent of agents) {
    const uses = library.effectiveLibrarySkills(agent);
    const { file, ...portableAgent } = agent;
    add('agent', agent.id, { ...portableAgent, source: agent.scope === 'repository' ? agent.source : null }, { label: agent.label ?? agent.id,
      description: agent.description, text: agent.text, dependencies: uses.map(use => ({ kind: 'skill', id: use.id, phases: use.phases, use: use.use })) });
    if (agent.scope === 'repository') retain(agent.source, agent.text);
  }
  for (const skill of skills.skills.values()) {
    retain(skill.path, skill.text);
    add('skill', skill.id, skill, { label: skill.label, description: skill.description, text: skill.text,
      dependencies: skill.instructionRefs.map(id => ({ kind: 'instruction', id })) });
  }
  for (const item of instructions.instructions.values()) {
    const text = await read(item.path);
    add('instruction', item.id, item, { label: item.label, description: item.description, text });
  }
  for (const [id, phase] of Object.entries(definition.phases ?? {})) add('phase', id, phase, {
    label: phase.label, description: `${phase.artifact?.kind ?? phase.kind ?? 'phase'}; write scope ${phase.writeScope ?? 'policy-defined'}`,
    tags: [`effect:${phase.writeScope === 'source-and-artifact' ? 'code' : 'artifact'}`],
    dependencies: [...(phase.inputs ?? []).map(input => ({ kind: 'phase', id: typeof input === 'string' ? input : input.phase })),
      ...agents.filter(agent => agent.defaultFor.includes(id)).map(agent => ({ kind: 'agent', id: agent.id }))] });
  for (const [id, workflow] of Object.entries(definition.workTypes ?? {})) add('workflow', id, workflow, {
    label: workflow.label, description: workflow.description, dependencies: [...workflow.phases.map(id => ({ kind: 'phase', id })),
      ...attachmentFile.filter(item => item.workflow === id).map(item => ({ kind: 'skill', id: item.id, phases: item.phases, use: item.use }))] });
  const templates = normalizeTemplateCatalog(definition.templates);
  const refs = new Set([...Object.keys(templates).map(id => `template:${id}`), ...Object.values(definition.phases ?? {}).map(phase => phase.defaultTemplate),
    ...Object.values(definition.workTypes ?? {}).flatMap(workflow => Object.values(workflow.templateOverrides ?? {}))].filter(Boolean));
  for (const reference of refs) {
    const template = resolveTemplate(definition, reference);
    if (!template?.path) continue; // No remote hydration during discovery.
    const text = await read(`${definition.templatesRoot ?? 'singularity/templates'}/${template.path}`);
    add('template', reference, { ...template, text }, { label: template.label ?? reference, description: template.description ?? '' });
  }
  for (const [id, group] of Object.entries(definition.approvalAuthorities ?? {})) add('approval-authority', id,
    { label: group.label ?? id, minimum: group.minimum ?? null }, { label: group.label, description: 'Human authority; discovery does not verify membership or grant approval.' });
  const { mcpDescriptorPath } = await import('./mcp-descriptor.mjs');
  for (const [id, server] of Object.entries(definition.mcpServers ?? {})) {
    const relative = mcpDescriptorPath(id);
    const target = await secureRepositoryPath(configRoot, relative, { label: 'MCP descriptor', type: 'file' });
    const descriptor = target.exists ? await read(relative) : null;
    add('mcp-server', id, server, { label: server.label, text: descriptor, description: 'Declared MCP policy only; host mapping, credentials, approval and runtime availability are not verified.' });
  }
  const constitutions = await studioConstitutions(configRoot, definition);
  for (const item of constitutions.files.values()) {
    if (item.present) { retain(item.path, item.text); add('constitution', item.path, { ...item, workflows: item.workflows }, { label: item.path,
      description: `Repository constitution used by ${item.workflows.length} workflow(s).` }); }
    for (const workflow of item.workflows.filter(value => value.mode !== 'off')) {
      entries.find(entry => entry.kind === 'workflow' && entry.id === workflow.id)?.dependencies.push({ kind: 'constitution', id: item.path, mode: workflow.mode });
    }
    problems.push(...item.problems.map(message => ({ kind: 'constitution', id: item.path, message })));
  }
  retain(library.SKILL_ATTACHMENTS_PATH, library.skillAttachmentsText(attachmentFile) ?? 'attachments: []\n');
  for (const [id, phase] of Object.entries(definition.phases ?? {})) for (const [index, command] of (phase.qualityCommands ?? []).entries()) add('quality-command', `${id}-${index + 1}`,
    { phase: id, declaration: command, readiness: 'declared-only; runtime resolution and fresh execution still required' }, { description: `Quality command declaration for ${id}; not permission or proof of runner availability.` });
  for (const task of (await import('./model-tasks.mjs')).MODEL_TASKS) add('execution-task', task, { id: task, qualification: 'not-verified' }, { description: 'Installed task name; host/provider availability, phase policy and authority still require verification.' });
  // Procedural Copilot skills are discoverable, but are not attachable prompt-library skills.
  const packageRoot = path.join(PACKAGE_ROOT, 'plugin', 'skills');
  const folders = await readdir(packageRoot, { withFileTypes: true });
  if (folders.length > 512) fail('Too many packaged procedural skills.', 'WORKFLOW_INTENT_LIMIT');
  for (const folder of folders.filter(item => item.isDirectory()).sort((a, b) => compare(a.name, b.name))) {
    const file = path.join(packageRoot, folder.name, 'SKILL.md');
    const text = await captureText(file, 256 * 1024); const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
    const metadata = front ? YAML.parse(front[1]) : {};
    add('command-skill', metadata.name ?? folder.name, { text, attachable: false }, { description: metadata.description ?? '', text, tags: ['use:invoke-only'] });
  }
  entries.sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
  if (entries.length > 4096) fail('Too many catalog assets.', 'WORKFLOW_INTENT_LIMIT');
  const source = { kind: authority.kind, ref: authority.ref ?? null, commit: authority.commit ?? null };
  const interpretation = await Promise.all(['workflow-intent-catalog.mjs', 'workflow-intent-patterns.mjs', 'workflow-markup.mjs', 'workflow-markup-parser.mjs', 'workflow-markup-mcp.mjs', 'skill-instruction-composition.mjs', 'workflow-intent-capabilities.mjs', 'commands/workflow-intent.mjs']
    .map(async file => ({ file, sha256: sha(await readFile(path.join(PACKAGE_ROOT, 'src', file), 'utf8')) })));
  const sourceSha256 = sha({ format: WORKFLOW_INTENT_CATALOG_FORMAT, interpretation, source, definition: sha(rawText),
    files: [...files].sort(([a], [b]) => compare(a, b)).map(([file, text]) => ({ file, sha256: sha(text) })), entries: entries.map(({ value, ...item }) => item), problems });
  return { root: configRoot, source, sourceSha256, definition, agents, attachments: attachmentFile, skills: skills.skills, instructions: instructions.instructions, files, entries, problems };
}

export async function withWorkflowIntentCatalog(root, { source = 'approved', expectedSource = null } = {}, action) {
  if (!['approved', 'installed'].includes(source)) fail('Catalog source must be approved or installed.');
  const useCapturedCatalog = async (selected, authority) => {
    const catalog = await capture(selected, authority);
    if (expectedSource && expectedSource !== catalog.sourceSha256) fail('The catalog changed. Preserve the draft and review a fresh catalog before rebinding it.', 'WORKFLOW_INTENT_CATALOG_STALE');
    return action(catalog);
  };
  if (source === 'installed') {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-intent-catalog-'));
    try { await (await import('./config.mjs')).initializeDefinition(temporary); return await useCapturedCatalog(temporary, { kind: 'installed-package' }); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  if (!root) fail('Select a repository for the approved catalog, or explicitly choose --source installed.', 'WORKFLOW_INTENT_SOURCE_REQUIRED');
  const { withApprovedConfigurationRead } = await import('./approved-configuration-reader.mjs');
  return withApprovedConfigurationRead(root, authority => {
    if (!authority || authority.kind === 'working-tree') fail('No approved configuration is available. Explicitly choose --source installed for a starter-only draft.', 'WORKFLOW_INTENT_SOURCE_REQUIRED');
    return useCapturedCatalog(root, authority);
  }, { preferAuthority: true, refreshAuthority: false });
}

export function queryWorkflowIntentCatalog(catalog, { kind = null, query = '', tags = [], cursor = 0, limit = 24 } = {}) {
  if (kind != null && !WORKFLOW_INTENT_KINDS.includes(kind) || typeof query !== 'string' || query.length > 512 || !Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')
      || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) fail('Use a supported catalog kind, bounded query, tags and page (limit 1..64).');
  const words = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
  const matches = catalog.entries.filter(item => (!kind || item.kind === kind) && tags.every(tag => item.tags.includes(tag))
    && words.every(word => `${item.id} ${item.label} ${item.description} ${item.tags.join(' ')}`.toLowerCase().includes(word)));
  return { schemaVersion: 1, resultType: 'workflow-intent-catalog', format: WORKFLOW_INTENT_CATALOG_FORMAT, source: catalog.source, sourceSha256: catalog.sourceSha256,
    entries: matches.slice(cursor, cursor + limit).map(({ value, ...item }) => item), total: matches.length, cursor,
    nextCursor: cursor + limit < matches.length ? cursor + limit : null,
    counts: Object.fromEntries(WORKFLOW_INTENT_KINDS.map(kind => [kind, catalog.entries.filter(item => item.kind === kind).length])),
    patterns: WORKFLOW_INTENT_PATTERNS, families: WORKFLOW_INTENT_FAMILIES, problems: catalog.problems,
    scope: 'Approved declared roots or the explicitly selected installed package only; no home, parent, branch or remote scan.',
    permissionEffect: 'none', membership: 'not-verified', authorityObservation: 'Locally observed approved reference or installed package; destination authority is revalidated during import.',
    meaning: 'Discovery is not applicability, authority, runtime qualification, approval or activation.' };
}

export function selectWorkflowIntentAsset(catalog, kind, id) {
  if (!WORKFLOW_INTENT_KINDS.includes(kind)) fail('Unknown asset kind.');
  const item = catalog.entries.find(item => item.kind === kind && item.id === id);
  if (!item) fail(`No ${kind} '${id}' exists in this exact catalog.`, 'WORKFLOW_INTENT_ASSET_UNKNOWN');
  if (!item.available) fail(`The selected ${kind} is unavailable for authoring: ${item.problem}.`, 'WORKFLOW_INTENT_ASSET_UNAVAILABLE');
  return item;
}

/** Source-binding placeholders are filled by the owner; the example never imports or executes. */
export async function workflowIntentExample(catalog) {
  selectWorkflowIntentAsset(catalog, 'workflow', 'demo-instruction-test-loop');
  const template = await readFile(path.join(PACKAGE_ROOT, 'examples', 'demo-intent-workflow.xml'), 'utf8');
  return { schemaVersion: 1, resultType: 'workflow-intent-example', sourceSha256: catalog.sourceSha256,
    source: template.replaceAll('{{CATALOG_SHA256}}', catalog.sourceSha256).replaceAll('{{CATALOG_SOURCE}}', catalog.source.kind === 'installed-package' ? 'installed' : 'approved'),
    meaning: 'Illustrative candidate only. Adapt the exact original intent, then compile and review; nothing was imported or approved.' };
}

/** Selected content once, without duplicating a complete SKILL.md as both text and instructions. */
export function workflowIntentAssetView(catalog, kind, id) {
  const { value, ...summary } = selectWorkflowIntentAsset(catalog, kind, id);
  const projected = ['agent', 'skill', 'instruction'].includes(kind) ? {
    instructions: value.instructions ?? value.prompt, ...(kind === 'agent' ? { tools: value.tools, phases: value.phases, views: value.worldModelViews } : {}),
    ...(kind === 'skill' ? { loading: value.loading, instructionRefs: value.instructionRefs } : {})
  } : value;
  return { ...summary, value: projected };
}
