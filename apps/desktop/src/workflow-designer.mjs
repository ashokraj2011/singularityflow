const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertId(id, label) {
  if (!ID_PATTERN.test(id)) throw new Error(`${label} must be lower-case kebab-case.`);
}

function clone(definition) {
  return structuredClone(definition);
}

function normalizedTemplateName(value) {
  const name = String(value ?? '').trim().replace(/^\/+/, '');
  if (!name || !name.endsWith('.md') || name.split('/').includes('..')) throw new Error('Template name must be a relative .md path without "..".');
  return name;
}

function normalizedMarkdownName(value, label) {
  const name = String(value ?? '').trim().replace(/^\/+/, '');
  if (!name || !name.endsWith('.md') || name.split('/').includes('..')) throw new Error(`${label} must be a relative .md path without "..".`);
  return name;
}

export function createPersona(definition, values) {
  const id = String(values.id ?? '').trim();
  assertId(id, 'Persona ID');
  if (definition.personas[id]) throw new Error(`Persona '${id}' already exists.`);
  const next = clone(definition);
  next.personas[id] = {
    label: String(values.label || id).trim() || id,
    description: String(values.description || `Guidance for the ${values.label || id} persona.`).trim(),
    prompt: normalizedMarkdownName(values.prompt || `${id}.md`, 'Persona prompt'),
    suggestedPhases: [],
    worldModelViews: [],
    mayApprove: []
  };
  return next;
}

export function removePersona(definition, id, replacementId) {
  if (!definition.personas[id]) throw new Error(`Persona '${id}' does not exist.`);
  if (Object.keys(definition.personas).length === 1) throw new Error('At least one persona must remain.');
  if (!definition.personas[replacementId] || replacementId === id) throw new Error('Choose a different replacement persona.');
  const next = clone(definition);
  for (const [phaseId, phase] of Object.entries(next.phases)) {
    if (phase.suggestedPersonas?.includes(id)) phase.suggestedPersonas = [...new Set(phase.suggestedPersonas.map((persona) => persona === id ? replacementId : persona))];
    if (phase.approval?.personas?.includes(id)) {
      phase.approval.personas = [...new Set(phase.approval.personas.map((persona) => persona === id ? replacementId : persona))];
      const capability = next.personas[replacementId].mayApprove ??= [];
      if (!capability.includes(phaseId)) capability.push(phaseId);
    }
  }
  delete next.personas[id];
  return next;
}

export function createWorkType(definition, { id, label, copyFrom }) {
  assertId(id, 'Workflow ID');
  if (definition.workTypes[id]) throw new Error(`Workflow '${id}' already exists.`);
  const source = definition.workTypes[copyFrom];
  if (!source) throw new Error(`Workflow '${copyFrom}' does not exist.`);
  const next = clone(definition);
  next.workTypes[id] = { ...clone(source), label: String(label || id).trim() || id };
  return next;
}

export function removeWorkType(definition, id) {
  if (!definition.workTypes[id]) throw new Error(`Workflow '${id}' does not exist.`);
  if (Object.keys(definition.workTypes).length === 1) throw new Error('At least one workflow must remain.');
  const next = clone(definition);
  delete next.workTypes[id];
  return next;
}

export function addPhaseToWorkType(definition, workTypeId, phaseId) {
  const profile = definition.workTypes[workTypeId];
  if (!profile) throw new Error(`Workflow '${workTypeId}' does not exist.`);
  if (!definition.phases[phaseId]) throw new Error(`Stage '${phaseId}' does not exist.`);
  if (profile.phases.includes(phaseId)) throw new Error(`Stage '${phaseId}' is already in this workflow.`);
  const next = clone(definition);
  const target = next.workTypes[workTypeId];
  const previous = target.phases.at(-1);
  target.phases.push(phaseId);
  target.phaseOverrides ??= {};
  target.phaseOverrides[phaseId] = { ...(target.phaseOverrides[phaseId] ?? {}), inputs: previous ? [previous] : [] };
  return next;
}

export function createPhase(definition, workTypeId, values) {
  const id = String(values.id ?? '').trim();
  assertId(id, 'Stage ID');
  if (definition.phases[id]) throw new Error(`Stage '${id}' already exists.`);
  if (!definition.workTypes[workTypeId]) throw new Error(`Workflow '${workTypeId}' does not exist.`);
  const persona = values.persona;
  if (!definition.personas[persona]) throw new Error('Choose an approval persona.');
  const template = normalizedTemplateName(values.template);
  const artifactFile = String(values.artifactFile || `${id}.md`).trim();
  if (!artifactFile.endsWith('.md') || artifactFile.includes('/') || artifactFile.includes('..')) throw new Error('Artifact filename must be a single .md filename.');
  const next = clone(definition);
  next.phases[id] = {
    label: String(values.label || id).trim() || id,
    suggestedPersonas: [persona],
    defaultTemplate: template,
    artifact: {
      path: `artifacts/${id}/${artifactFile}`,
      kind: String(values.kind || id).trim() || id,
      minimumBytes: Number(values.minimumBytes) || 200
    },
    worldModel: { views: [], depth: 'standard' },
    writeScope: values.writeScope === 'source-and-artifact' ? 'source-and-artifact' : 'artifact-only',
    approval: { personas: [persona], minimum: 1, rejectTo: [id] }
  };
  const capability = next.personas[persona].mayApprove ??= [];
  if (!capability.includes(id)) capability.push(id);
  const suggested = next.personas[persona].suggestedPhases ??= [];
  if (!suggested.includes(id)) suggested.push(id);
  return addPhaseToWorkType(next, workTypeId, id);
}

function inputPhase(entry) {
  return typeof entry === 'string' ? entry : entry?.phase;
}

export function removePhaseFromWorkType(definition, workTypeId, phaseId) {
  const profile = definition.workTypes[workTypeId];
  if (!profile?.phases.includes(phaseId)) throw new Error(`Stage '${phaseId}' is not in workflow '${workTypeId}'.`);
  if (profile.phases.length === 1) throw new Error('A workflow must contain at least one stage.');
  const next = clone(definition);
  const target = next.workTypes[workTypeId];
  target.phases = target.phases.filter((id) => id !== phaseId);
  delete target.templateOverrides?.[phaseId];
  delete target.phaseOverrides?.[phaseId];
  for (const id of target.phases) {
    const inherited = target.phaseOverrides?.[id]?.inputs ?? next.phases[id]?.inputs ?? [];
    if (!inherited.some((entry) => inputPhase(entry) === phaseId)) continue;
    target.phaseOverrides ??= {};
    target.phaseOverrides[id] = {
      ...(target.phaseOverrides[id] ?? {}),
      inputs: inherited.filter((entry) => inputPhase(entry) !== phaseId)
    };
  }
  if (target.documents?.allowedPhases) target.documents.allowedPhases = target.documents.allowedPhases.filter((id) => id !== phaseId);
  return next;
}

export function deleteUnusedPhase(definition, phaseId) {
  const users = Object.entries(definition.workTypes).filter(([, profile]) => profile.phases.includes(phaseId)).map(([id]) => id);
  if (users.length) throw new Error(`Stage '${phaseId}' is still used by: ${users.join(', ')}.`);
  if (!definition.phases[phaseId]) throw new Error(`Stage '${phaseId}' does not exist.`);
  const next = clone(definition);
  delete next.phases[phaseId];
  if (next.documents?.allowedPhases) next.documents.allowedPhases = next.documents.allowedPhases.filter((id) => id !== phaseId);
  for (const persona of Object.values(next.personas)) {
    persona.suggestedPhases = (persona.suggestedPhases ?? []).filter((id) => id !== phaseId);
    persona.mayApprove = (persona.mayApprove ?? []).filter((id) => id !== phaseId);
  }
  for (const phase of Object.values(next.phases)) {
    if (phase.approval?.rejectTo) phase.approval.rejectTo = phase.approval.rejectTo.filter((id) => id !== phaseId);
    if (phase.inputs) phase.inputs = phase.inputs.filter((entry) => inputPhase(entry) !== phaseId);
  }
  return next;
}

export function setWorkTypeInputs(definition, workTypeId, phaseId, inputs) {
  const profile = definition.workTypes[workTypeId];
  if (!profile?.phases.includes(phaseId)) throw new Error(`Stage '${phaseId}' is not active in workflow '${workTypeId}'.`);
  const earlier = new Set(profile.phases.slice(0, profile.phases.indexOf(phaseId)));
  if (inputs.some((id) => !earlier.has(id))) throw new Error('Stage inputs must come from earlier stages in this workflow.');
  const next = clone(definition);
  const target = next.workTypes[workTypeId];
  target.phaseOverrides ??= {};
  target.phaseOverrides[phaseId] = { ...(target.phaseOverrides[phaseId] ?? {}), inputs: [...inputs] };
  return next;
}

export function templateRepositoryPath(definition, name) {
  return `${String(definition.templatesRoot).replace(/\/$/, '')}/${normalizedTemplateName(name)}`;
}

export function personaPromptRepositoryPath(definition, name) {
  return `${String(definition.personaPromptsRoot).replace(/\/$/, '')}/${normalizedMarkdownName(name, 'Persona prompt')}`;
}

export function repositorySkillPath(id) {
  assertId(id, 'Skill ID');
  return `.github/skills/${id}/SKILL.md`;
}
