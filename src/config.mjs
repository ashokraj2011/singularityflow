import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { SingularityFlowError, readJson, snapshot, writeText } from './util.mjs';
import { validateInjectionDefinition } from './inject.mjs';
import { groundingMode } from './grounding.mjs';
import { isAgentTemplateReference, materializeAgentTemplate, parseAgentTemplateReference } from './agents.mjs';
import { markdownWorldModelViews, structuredWorldModelViewReferences, WORLD_MODEL_VIEW_ID } from './world-model-views.mjs';

export const WORKFLOW_PATH = '.singularity/workflow.yml';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT_MODES = new Set(['off', 'record', 'enforce']);
export const SEQUENCE_GATE_IDS = [
  'completion', 'currentPhase', 'phaseStatus', 'freshGeneration',
  'generationCommit', 'remoteGeneration', 'publicationPending', 'documentPhase'
];
const SEQUENCE_GATE_MODES = new Set(['hard', 'soft']);

function assertId(value, label) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new SingularityFlowError(`${label} '${value}' must be lower-case kebab-case.`);
}

function assertRelative(value, label) {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new SingularityFlowError(`${label} must be a repository-relative path without '..'.`);
}

function assertTemplate(value, label) {
  if (isAgentTemplateReference(value)) parseAgentTemplateReference(value);
  else assertRelative(value, label);
}

export function configuredInputsMode(definition) {
  const mode = definition.inputsMode ?? 'off';
  if (!INPUT_MODES.has(mode)) throw new SingularityFlowError(`inputsMode must be off, record, or enforce; got '${mode}'.`);
  return mode;
}

export function normalizeSequenceGates(value = {}, overrides = {}) {
  for (const [label, source] of [['sequenceGates', value], ['work-type sequenceGates', overrides]]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new SingularityFlowError(`${label} must be an object.`);
    for (const [gate, mode] of Object.entries(source)) {
      if (gate !== 'default' && !SEQUENCE_GATE_IDS.includes(gate)) throw new SingularityFlowError(`${label} contains unknown gate '${gate}'. Allowed: ${SEQUENCE_GATE_IDS.join(', ')}.`);
      if (!SEQUENCE_GATE_MODES.has(mode)) throw new SingularityFlowError(`${label}.${gate} must be hard or soft.`);
    }
  }
  const fallback = overrides.default ?? value.default ?? 'hard';
  return Object.fromEntries([
    ['default', fallback],
    ...SEQUENCE_GATE_IDS.map((gate) => [gate, overrides[gate] ?? value[gate] ?? fallback])
  ]);
}

export function normalizePhaseInputs(value, label = 'Phase inputs') {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new SingularityFlowError(`${label} must be an array.`);
  const seen = new Set();
  return value.map((entry, index) => {
    const source = typeof entry === 'string' ? { phase: entry } : entry;
    const entryLabel = `${label}[${index}]`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new SingularityFlowError(`${entryLabel} must be a phase ID or object.`);
    for (const key of Object.keys(source)) if (!['phase', 'optional', 'maxBytes'].includes(key)) throw new SingularityFlowError(`${entryLabel} has unsupported field '${key}'.`);
    assertId(source.phase, `${entryLabel}.phase`);
    if (source.optional != null && typeof source.optional !== 'boolean') throw new SingularityFlowError(`${entryLabel}.optional must be boolean.`);
    if (source.maxBytes != null && (!Number.isInteger(source.maxBytes) || source.maxBytes < 1)) throw new SingularityFlowError(`${entryLabel}.maxBytes must be a positive integer.`);
    if (seen.has(source.phase)) throw new SingularityFlowError(`${label} references '${source.phase}' more than once.`);
    seen.add(source.phase);
    return { phase: source.phase, optional: source.optional ?? false, maxBytes: source.maxBytes ?? null };
  });
}

export function validateDefinition(definition) {
  if (definition?.version !== 1) throw new SingularityFlowError('workflow.yml version must be 1.');
  if (!definition.personas || !Object.keys(definition.personas).length) throw new SingularityFlowError('workflow.yml must define at least one persona.');
  if (!definition.workTypes || !Object.keys(definition.workTypes).length) throw new SingularityFlowError('workflow.yml must define at least one work type.');
  if (!definition.phases || !Object.keys(definition.phases).length) throw new SingularityFlowError('workflow.yml must define phases.');
  assertRelative(definition.workItemRoot ?? '.singularity/work-items', 'workItemRoot');
  assertRelative(definition.templatesRoot, 'templatesRoot');
  assertRelative(definition.personaPromptsRoot, 'personaPromptsRoot');
  configuredInputsMode(definition);
  normalizeSequenceGates(definition.sequenceGates ?? {});
  groundingMode(definition);
  if (definition.worldModel?.outputDir) assertRelative(definition.worldModel.outputDir, 'worldModel.outputDir');
  if (definition.worldModel?.promptSource && definition.worldModel.promptSource !== 'builtin') assertRelative(definition.worldModel.promptSource, 'worldModel.promptSource');
  if (definition.worldModel?.views != null) {
    if (!Array.isArray(definition.worldModel.views) || !definition.worldModel.views.length) throw new SingularityFlowError('worldModel.views must be a non-empty array when configured.');
    if (new Set(definition.worldModel.views).size !== definition.worldModel.views.length) throw new SingularityFlowError('worldModel.views must not contain duplicates.');
    for (const view of definition.worldModel.views) if (!WORLD_MODEL_VIEW_ID.test(view)) throw new SingularityFlowError(`World-model view '${view}' must be lower-case kebab-case.`);
  }
  validateInjectionDefinition(definition);
  if (definition.tokens?.mode && definition.tokens.mode !== 'exact-or-unavailable') throw new SingularityFlowError("tokens.mode must be 'exact-or-unavailable'.");
  for (const [model, pricing] of Object.entries(definition.tokens?.pricing ?? {})) {
    if (!model.trim()) throw new SingularityFlowError('tokens.pricing model names must not be empty.');
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) throw new SingularityFlowError(`Token pricing for '${model}' must be an object.`);
    for (const field of ['input', 'output', 'cachedInput']) {
      if (pricing[field] != null && (!Number.isFinite(pricing[field]) || pricing[field] < 0)) throw new SingularityFlowError(`tokens.pricing.${model}.${field} must be a non-negative number.`);
    }
    if (pricing.input == null && pricing.output == null && pricing.cachedInput == null) throw new SingularityFlowError(`Token pricing for '${model}' must define input, output, or cachedInput.`);
  }
  for (const phaseId of definition.documents?.allowedPhases ?? []) if (!definition.phases[phaseId]) throw new SingularityFlowError(`Document policy references unknown phase '${phaseId}'.`);
  if (definition.documents?.maxFileBytes != null && (!Number.isInteger(definition.documents.maxFileBytes) || definition.documents.maxFileBytes < 1)) throw new SingularityFlowError('documents.maxFileBytes must be a positive integer.');
  if (definition.collaboration != null) {
    if (!definition.collaboration || typeof definition.collaboration !== 'object' || Array.isArray(definition.collaboration)) throw new SingularityFlowError('collaboration must be an object.');
    if (definition.collaboration.assignmentMode && !['off', 'suggested', 'required'].includes(definition.collaboration.assignmentMode)) throw new SingularityFlowError('collaboration.assignmentMode must be off, suggested, or required.');
    if (definition.collaboration.approvalReminderAfterHours != null && (!Number.isFinite(definition.collaboration.approvalReminderAfterHours) || definition.collaboration.approvalReminderAfterHours < 0)) throw new SingularityFlowError('collaboration.approvalReminderAfterHours must be a non-negative number.');
    for (const channel of definition.collaboration.notifications ?? []) if (!['terminal'].includes(channel)) throw new SingularityFlowError(`Unsupported collaboration notification channel '${channel}'.`);
  }
  for (const [id, persona] of Object.entries(definition.personas)) {
    assertId(id, 'Persona');
    if (!persona.label || !persona.prompt) throw new SingularityFlowError(`Persona '${id}' requires label and prompt.`);
    assertRelative(persona.prompt, `Persona '${id}' prompt`);
    for (const phaseId of [...(persona.suggestedPhases ?? []), ...(persona.mayApprove ?? [])]) if (!definition.phases[phaseId]) throw new SingularityFlowError(`Persona '${id}' references unknown phase '${phaseId}'.`);
  }
  for (const [id, workType] of Object.entries(definition.workTypes)) {
    assertId(id, 'Work type');
    if (!workType.label || !Array.isArray(workType.phases) || !workType.phases.length) throw new SingularityFlowError(`Work type '${id}' requires label and phases.`);
    for (const phaseId of workType.phases) if (!definition.phases[phaseId]) throw new SingularityFlowError(`Work type '${id}' references unknown phase '${phaseId}'.`);
    for (const phaseId of Object.keys(workType.templateOverrides ?? {})) if (!workType.phases.includes(phaseId)) throw new SingularityFlowError(`Work type '${id}' has a template override for inactive phase '${phaseId}'.`);
    for (const phaseId of Object.keys(workType.phaseOverrides ?? {})) if (!workType.phases.includes(phaseId)) throw new SingularityFlowError(`Work type '${id}' has an override for inactive phase '${phaseId}'.`);
    for (const phaseId of workType.documents?.allowedPhases ?? []) if (!workType.phases.includes(phaseId)) throw new SingularityFlowError(`Work type '${id}' allows document upload in inactive phase '${phaseId}'.`);
    normalizeSequenceGates(definition.sequenceGates ?? {}, workType.sequenceGates ?? {});
  }
  for (const [id, phase] of Object.entries(definition.phases)) {
    assertId(id, 'Phase');
    if (!phase.label || !phase.artifact?.path) throw new SingularityFlowError(`Phase '${id}' requires label and artifact.path.`);
    assertRelative(phase.artifact.path, `Phase '${id}' artifact.path`);
    const template = phase.defaultTemplate;
    if (template) assertTemplate(template, `Phase '${id}' defaultTemplate`);
    for (const [workTypeId, workType] of Object.entries(definition.workTypes)) if (workType.templateOverrides?.[id]) assertTemplate(workType.templateOverrides[id], `Work type '${workTypeId}' template override for '${id}'`);
    if (!template && !Object.values(definition.workTypes).some((type) => type.templateOverrides?.[id])) throw new SingularityFlowError(`Phase '${id}' has no default or work-type template.`);
    for (const persona of phase.approval?.personas ?? []) {
      if (!definition.personas[persona]) throw new SingularityFlowError(`Phase '${id}' approval references unknown persona '${persona}'.`);
      if (!(definition.personas[persona].mayApprove ?? []).includes(id)) throw new SingularityFlowError(`Persona '${persona}' must list '${id}' in mayApprove.`);
    }
    normalizePhaseInputs(phase.inputs, `Phase '${id}' inputs`);
  }
  for (const [workTypeId, workType] of Object.entries(definition.workTypes)) {
    const resolved = resolveWorkType(definition, workTypeId);
    for (const consumer of resolved.phases) {
      for (const input of consumer.inputs) {
        const producer = resolved.phases.find((phase) => phase.id === input.phase);
        if (!producer) throw new SingularityFlowError(`Work type '${workTypeId}' phase '${consumer.id}' input references inactive phase '${input.phase}'.`);
        if (producer.order >= consumer.order) throw new SingularityFlowError(`Work type '${workTypeId}' phase '${consumer.id}' input '${input.phase}' must precede the consumer.`);
      }
    }
  }
  if (definition.worldModel?.views) {
    const configuredViews = new Set(definition.worldModel.views);
    for (const [view, references] of structuredWorldModelViewReferences(definition)) {
      if (!configuredViews.has(view)) throw new SingularityFlowError(`World-model view '${view}' is used by ${references.join(', ')} but is not declared in worldModel.views.`);
    }
  }
  return definition;
}

async function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(absolute));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(absolute);
  }
  return files;
}

export async function worldModelPromptViewReferences(root, definition) {
  const locations = [
    definition.templatesRoot,
    definition.personaPromptsRoot,
    '.github/skills',
    '.github/agents',
    '.claude/agents'
  ];
  const source = definition.worldModel?.promptSource;
  const promptFiles = source && source !== 'builtin' ? [path.join(root, source)] : [];
  for (const location of locations) promptFiles.push(...await markdownFiles(path.join(root, location)));
  const references = new Map();
  for (const file of [...new Set(promptFiles)]) {
    if (!existsSync(file)) continue;
    const content = await readFile(file, 'utf8');
    for (const view of markdownWorldModelViews(content)) {
      const list = references.get(view) ?? [];
      const relative = path.relative(root, file).replaceAll(path.sep, '/');
      if (!list.includes(relative)) list.push(relative);
      references.set(view, list);
    }
  }
  return references;
}

export async function validateWorldModelPromptViewReferences(root, definition) {
  if (!definition.worldModel?.views) return new Map();
  const configured = new Set(definition.worldModel.views);
  const references = await worldModelPromptViewReferences(root, definition);
  for (const [view, files] of references) {
    if (!configured.has(view)) throw new SingularityFlowError(`World-model view '${view}' is referenced by ${files.join(', ')} but is not declared in worldModel.views.`);
  }
  return references;
}

function legacyDefinition(config, worldModel = {}) {
  const personas = {};
  const phases = {};
  for (const phase of config.phases ?? []) {
    const personaId = String(phase.owner ?? 'developer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'developer';
    personas[personaId] ??= { label: phase.owner ?? 'Developer', description: `Legacy ${phase.owner ?? 'developer'} persona`, prompt: `${personaId}.md`, suggestedPhases: [], worldModelViews: [], mayApprove: [] };
    personas[personaId].suggestedPhases.push(phase.id);
    personas[personaId].mayApprove.push(phase.id);
    phases[phase.id] = {
      label: phase.label ?? phase.id,
      suggestedPersonas: [personaId],
      defaultTemplate: `legacy/${phase.id}.md`,
      artifact: { ...(phase.requiredArtifact ?? {}), path: phase.requiredArtifact?.path ?? `artifacts/${phase.id}/${phase.id}.md` },
      worldModel: worldModel.phases?.[phase.id] ?? { views: [], depth: 'standard' },
      writeScope: 'source-and-artifact',
      approval: { personas: [personaId], minimum: 1, rejectTo: [phase.id] },
      qualityCommands: phase.qualityCommands ?? []
    };
  }
  return {
    version: 1,
    inputsMode: 'off',
    defaultBaseBranch: config.defaultBaseBranch ?? 'main',
    workItemRoot: config.workItemRoot ?? '.singularity/work-items',
    idPattern: config.idPattern ?? '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
    git: { remote: 'origin', publish: 'off' },
    templatesRoot: '.singularity/templates',
    personaPromptsRoot: '.singularity/personas',
    tokens: { mode: 'exact-or-unavailable' },
    documents: { allowedPhases: Object.keys(phases), maxFileBytes: 26214400, maxPreviewBytes: 1048576 },
    personas,
    workTypes: { legacy: { label: 'Legacy workflow', phases: Object.keys(phases), templateOverrides: {} } },
    phases,
    governance: {
      requireAcceptanceCriteriaTags: config.governance?.requireAcceptanceCriteriaTags ?? true,
      protectedPaths: config.governance?.protectedPaths ?? []
    },
    _legacy: true
  };
}

export async function loadDefinition(root) {
  const yamlPath = path.join(root, WORKFLOW_PATH);
  if (existsSync(yamlPath)) {
    const definition = validateDefinition(YAML.parse(await readFile(yamlPath, 'utf8')));
    for (const [id, persona] of Object.entries(definition.personas)) if (!existsSync(path.join(root, definition.personaPromptsRoot, persona.prompt))) throw new SingularityFlowError(`Persona prompt missing for '${id}': ${path.posix.join(definition.personaPromptsRoot, persona.prompt)}`);
    for (const workTypeId of Object.keys(definition.workTypes)) for (const phase of resolveWorkType(definition, workTypeId).phases) {
      if (isAgentTemplateReference(phase.template)) continue;
      if (!existsSync(path.join(root, definition.templatesRoot, phase.template))) throw new SingularityFlowError(`Template missing for work type '${workTypeId}' phase '${phase.id}': ${path.posix.join(definition.templatesRoot, phase.template)}`);
    }
    await validateWorldModelPromptViewReferences(root, definition);
    return definition;
  }
  const legacyPath = path.join(root, '.singularity/config.json');
  if (!existsSync(legacyPath)) throw new SingularityFlowError(`Missing ${WORKFLOW_PATH}. Run: singularity-flow init`);
  const worldPath = path.join(root, '.singularity/worldmodel.json');
  return legacyDefinition(await readJson(legacyPath), existsSync(worldPath) ? await readJson(worldPath) : {});
}

async function copyIfMissing(source, destination) {
  if (existsSync(destination)) return false;
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  return true;
}

export async function initializeDefinition(root) {
  const wrote = [];
  const mappings = [
    ['workflow.yml', WORKFLOW_PATH],
    ['artifacts', '.singularity/templates'],
    ['personas', '.singularity/personas'],
    ['worldmodel-builder.md', '.singularity/prompts/worldmodel-builder.md']
  ];
  for (const [source, destination] of mappings) {
    if (await copyIfMissing(path.join(packageRoot, 'templates', source), path.join(root, destination))) wrote.push(destination);
  }
  return wrote;
}

export function resolveWorkType(definition, workTypeId) {
  const workType = definition.workTypes[workTypeId];
  if (!workType) throw new SingularityFlowError(`Unknown work type '${workTypeId}'.`);
  let phases = workType.phases.map((id, order) => {
    const phase = structuredClone(definition.phases[id]);
    const override = structuredClone(workType.phaseOverrides?.[id] ?? {});
    const merged = {
      ...phase,
      ...override,
      artifact: { ...(phase.artifact ?? {}), ...(override.artifact ?? {}) },
      worldModel: { ...(phase.worldModel ?? {}), ...(override.worldModel ?? {}) },
      approval: { ...(phase.approval ?? {}), ...(override.approval ?? {}) },
      comparison: { ...(phase.comparison ?? {}), ...(override.comparison ?? {}) }
    };
    const template = workType.templateOverrides?.[id] ?? phase.defaultTemplate;
    const inputs = normalizePhaseInputs(merged.inputs, `Work type '${workTypeId}' phase '${id}' inputs`);
    return { id, order, ...merged, inputs, template };
  });
  const phaseById = Object.fromEntries(phases.map((phase) => [phase.id, phase]));
  phases = phases.map((phase) => ({
    ...phase,
    inputs: phase.inputs.map((input) => ({ ...input, path: phaseById[input.phase]?.artifact?.path ?? null }))
  }));
  const documents = { ...(definition.documents ?? {}), ...(workType.documents ?? {}) };
  documents.allowedPhases = (documents.allowedPhases ?? []).filter((phaseId) => workType.phases.includes(phaseId));
  const sequenceGates = normalizeSequenceGates(definition.sequenceGates ?? {}, workType.sequenceGates ?? {});
  return { id: workTypeId, label: workType.label, inputsMode: configuredInputsMode(definition), sequenceGates, documents, phases };
}

export async function snapshotResolution(root, definition, resolved) {
  const definitionSnapshot = await snapshot(path.join(root, WORKFLOW_PATH));
  const templates = {};
  for (const phase of resolved.phases) {
    if (isAgentTemplateReference(phase.template)) {
      templates[phase.id] = await materializeAgentTemplate(root, phase.template, { phaseId: phase.id });
      continue;
    }
    const file = path.join(root, definition.templatesRoot, phase.template);
    if (!existsSync(file)) throw new SingularityFlowError(`Template missing for phase '${phase.id}': ${path.relative(root, file)}`);
    templates[phase.id] = { path: path.posix.join(definition.templatesRoot, phase.template), sha256: (await snapshot(file)).sha256 };
  }
  return {
    configSha256: definitionSnapshot.sha256,
    inputsMode: resolved.inputsMode ?? configuredInputsMode(definition),
    worldModelGrounding: groundingMode(definition),
    sequenceGates: resolved.sequenceGates ?? normalizeSequenceGates(definition.sequenceGates ?? {}),
    templates
  };
}

export async function migrateLegacyConfig(root) {
  if (existsSync(path.join(root, WORKFLOW_PATH))) return { migrated: false, reason: `${WORKFLOW_PATH} already exists` };
  const currentRoot = path.join(root, '.singularity');
  const previousRoot = path.join(root, `.${['s', 'd', 'l', 'c'].join('')}`);
  let movedStateRoot = false;
  if (!existsSync(currentRoot) && existsSync(previousRoot)) {
    await rename(previousRoot, currentRoot);
    movedStateRoot = true;
  }
  const legacyPath = path.join(currentRoot, 'config.json');
  if (!existsSync(legacyPath)) throw new SingularityFlowError('No .singularity/config.json exists to migrate.');
  const definition = await loadDefinition(root);
  await mkdir(path.join(root, '.singularity/templates/legacy'), { recursive: true });
  await mkdir(path.join(root, '.singularity/personas'), { recursive: true });
  for (const [id, phase] of Object.entries(definition.phases)) {
    await writeText(path.join(root, '.singularity/templates', phase.defaultTemplate), `# {{work.id}} — ${phase.label}\n\nTODO: Complete the ${phase.label} artifact.\n`);
  }
  for (const [id, persona] of Object.entries(definition.personas)) await writeText(path.join(root, '.singularity/personas', persona.prompt), `Act as ${persona.label}. Follow the active phase contract and cite evidence.\n`);
  const clean = structuredClone(definition); delete clean._legacy;
  await writeFile(path.join(root, WORKFLOW_PATH), YAML.stringify(clean));
  const resolved = resolveWorkType(clean, 'legacy');
  const resolution = await snapshotResolution(root, clean, resolved);
  const workRoot = path.join(root, clean.workItemRoot ?? '.singularity/work-items');
  let migratedWorkItems = 0;
  if (existsSync(workRoot)) {
    for (const entry of await readdir(workRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statePath = path.join(workRoot, entry.name, 'workflow.json');
      if (!existsSync(statePath)) continue;
      const state = await readJson(statePath);
      if (state.schemaVersion === 2) continue;
      state.schemaVersion = 2;
      state.workItem.workType = 'legacy'; state.workItem.workTypeLabel = 'Legacy workflow';
      state.resolution = { ...resolution, workType: 'legacy', workTypeLabel: 'Legacy workflow', documents: resolved.documents, sourceSha256: null, phases: resolved.phases };
      state.usage = { mode: 'exact-or-unavailable', totalTokens: 0, records: 0, exactRecords: 0, unavailableRecords: 0, byPhase: {}, byPersona: {}, byWorkType: {}, byWorkItem: {} };
      state.documents = { count: 0, updatedAt: null };
      for (const phaseId of state.phaseOrder ?? []) {
        const phase = state.phases[phaseId]; const definitionPhase = resolved.phases.find((item) => item.id === phaseId);
        phase.suggestedPersonas ??= definitionPhase?.suggestedPersonas ?? (phase.owner ? [phase.owner] : []);
        phase.approvalPolicy ??= definitionPhase?.approval ?? { personas: phase.owner ? [phase.owner] : [], minimum: 1, rejectTo: [phaseId] };
        phase.template ??= definitionPhase?.template ?? null; phase.worldModel ??= definitionPhase?.worldModel ?? {};
        phase.writeScope ??= definitionPhase?.writeScope ?? 'source-and-artifact'; phase.comparison ??= definitionPhase?.comparison ?? {};
        phase.generation ??= phase.artifacts?.length ? 1 : 0; phase.generatedBy ??= null; phase.generatedPersona ??= null;
        phase.usage ??= []; phase.approvals ??= phase.approvedBy ? [{ decision: 'approved', phase: phaseId, actor: { name: phase.approvedBy }, persona: phase.owner, at: phase.approvedAt, selfApproval: false, channel: 'legacy' }] : [];
      }
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
      migratedWorkItems += 1;
    }
  }
  return { migrated: true, path: WORKFLOW_PATH, migratedWorkItems, movedStateRoot };
}

export async function renderArtifactTemplate(root, definition, resolvedPhase, variables) {
  const file = variables.templateSnapshot?.source === 'agent'
    ? path.join(root, variables.templateSnapshot.path)
    : path.join(root, definition.templatesRoot, resolvedPhase.template);
  let text = await readFile(file, 'utf8');
  const replacements = {
    '{{work.id}}': variables.id,
    '{{work.title}}': variables.title,
    '{{work.type}}': variables.workType,
    '{{phase.id}}': resolvedPhase.id,
    '{{phase.label}}': resolvedPhase.label,
    '{{inputs}}': variables.inputs ?? ''
  };
  for (const [token, value] of Object.entries(replacements)) text = text.replaceAll(token, value ?? '');
  return text;
}

export async function personaPrompt(root, definition, personaId) {
  const persona = definition.personas[personaId];
  if (!persona) throw new SingularityFlowError(`Unknown persona '${personaId}'.`);
  return readFile(path.join(root, definition.personaPromptsRoot, persona.prompt), 'utf8');
}
