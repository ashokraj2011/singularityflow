/** Deterministic partial-request edits. These values are proposals, never catalog authority. */
export const WORKFLOW_DRAFT_STAGES = ['Goal', 'Stages', 'Team & skills', 'Access & review', 'Review package', 'Submit & next steps'] as const;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export interface WorkflowDraftGuide {
  payload: Record<string, unknown>;
  definitions: Record<string, unknown>;
  workflows: Record<string, unknown>[];
  phases: Record<string, unknown>[];
  agents: Record<string, unknown>[];
  skills: Record<string, unknown>[];
  templates: Record<string, unknown>[];
}

/** Parse without silently normalizing duplicate keys in the advanced editor. */
export function workflowDraftEnvelope(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!object(parsed) || Object.keys(parsed).some((key) => !['payload', 'assets'].includes(key))
      || (parsed.payload !== undefined && !object(parsed.payload))) throw new Error('Guided editing requires a JSON envelope with an object payload and literal assets.');
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') stack.push(new Set());
    else if (character === '[') stack.push(null);
    else if (character === '}' || character === ']') stack.pop();
    else if (character === '"') {
      const start = index++;
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index] === '"') break;
        else index += 1;
      }
      let next = index + 1; while (/\s/u.test(text[next] ?? '') && next < text.length) next += 1;
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        const keys = stack.at(-1);
        if (keys?.has(key)) throw new Error('Duplicate JSON keys must be resolved in the advanced editor before a guided edit. No content was rewritten.');
        keys?.add(key);
      }
    }
  }
  return parsed;
}

export function workflowDraftGuide(text: string): WorkflowDraftGuide {
  const envelope = workflowDraftEnvelope(text);
  const payload = object(envelope.payload) ? envelope.payload : {};
  if (payload.schema !== undefined && payload.schema !== 'sflow-workflow-request@2') {
    throw new Error('This request version is not supported by the guided editor. Advanced bytes are retained; no version is silently migrated.');
  }
  if (payload.definitions !== undefined && !object(payload.definitions)) throw new Error('Definitions must be an object before guided editing. Advanced text is retained.');
  const definitions = object(payload.definitions) ? payload.definitions : {};
  const collection = (key: string): Record<string, unknown>[] => {
    const value = definitions[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 32 || value.some((entry) => !object(entry))) {
      throw new Error(`Guided ${key} editing requires at most 32 object definitions. Use advanced JSON; no unknown definition is removed.`);
    }
    return value as Record<string, unknown>[];
  };
  return { payload, definitions, workflows: collection('workflows'), phases: collection('phases'),
    agents: collection('agents'), skills: collection('skills'), templates: collection('templates') };
}

export const WORKFLOW_DRAFT_GUIDE_FIELDS = ['id', 'label', 'description', 'phase-label', 'phase-inputs',
  'agent-description', 'agent-prompt', 'skill-description', 'skill-instructions', 'template-content', 'agent-tools', 'phase-review', 'rationale',
  'phase-artifact-path', 'phase-artifact-kind', 'phase-artifact-minimum', 'phase-artifact-maximum', 'phase-write-scope', 'workflow-label', 'workflow-description'] as const;
export type WorkflowDraftGuideField = typeof WORKFLOW_DRAFT_GUIDE_FIELDS[number];
const strings = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);
export function workflowDraftContent(input: string | Record<string, unknown>, entry: Record<string, unknown>, field: string): string {
  if (typeof entry[field] === 'string') return entry[field];
  const envelope = typeof input === 'string' ? workflowDraftEnvelope(input) : input; const reference = entry[`${field}Asset`];
  const asset = Array.isArray(envelope.assets) ? envelope.assets.find((value) => object(value) && value.path === reference) : undefined;
  return object(asset) && typeof asset.content === 'string' ? asset.content : '';
}

/** Only fixed, typed fields can change; unrelated definitions/assets/manual text survive. */
export function editWorkflowDraftGuide(text: string, field: WorkflowDraftGuideField, value: string, index = 0): string {
  if (!WORKFLOW_DRAFT_GUIDE_FIELDS.includes(field) || typeof value !== 'string' || Buffer.byteLength(value) > 128 * 1024
      || !Number.isSafeInteger(index) || index < 0 || index >= 32) throw new Error('The guided answer exceeds its fixed field/index bounds.');
  const envelope = workflowDraftEnvelope(text); const guide = workflowDraftGuide(text);
  const payload = guide.payload; envelope.payload = payload;
  if (['id', 'label', 'description', 'rationale'].includes(field)) {
    if (field === 'id' && value && (value.length > 64 || !ID.test(value))) throw new Error('Package identity must be bounded lower-case kebab-case, or left unresolved.');
    payload[field] = value;
  } else if (field === 'workflow-label' || field === 'workflow-description') {
    const workflow = guide.workflows[index];
    if (!workflow) throw new Error('Select a candidate workflow before editing its display fields.');
    workflow[field === 'workflow-label' ? 'label' : 'description'] = value;
    payload.definitions = { ...guide.definitions, workflows: guide.workflows };
  } else {
    const key: 'phases' | 'agents' | 'skills' | 'templates' = field.startsWith('phase-') ? 'phases' : field.startsWith('agent-') ? 'agents'
      : field.startsWith('skill-') ? 'skills' : 'templates';
    const entries = guide[key]; const selected = entries[index];
    if (!selected) throw new Error('Create or select a candidate component before answering this question.');
    const property: Record<string, string> = { 'phase-label': 'label', 'phase-inputs': 'inputs',
      'agent-description': 'description', 'agent-prompt': 'prompt', 'skill-description': 'description', 'skill-instructions': 'instructions',
      'template-content': 'content', 'agent-tools': 'toolBindings', 'phase-review': 'approvalBinding', 'phase-write-scope': 'writeScope' };
    if (field.startsWith('phase-artifact-')) {
      if (selected.artifact !== undefined && !object(selected.artifact)) throw new Error('Resolve the artifact object in advanced JSON first; it was not replaced.');
      const artifact = object(selected.artifact) ? selected.artifact : {};
      const artifactProperties: Record<string, string> = { 'phase-artifact-path': 'path', 'phase-artifact-kind': 'kind',
        'phase-artifact-minimum': 'minimumBytes', 'phase-artifact-maximum': 'maximumBytes' };
      const artifactField = artifactProperties[field];
      if (artifactField === 'minimumBytes' || artifactField === 'maximumBytes') {
        if (value && !/^[1-9][0-9]{0,8}$/u.test(value)) throw new Error('Artifact byte bounds must be positive bounded integers, or left unresolved.');
        if (value) artifact[artifactField] = Number(value); else delete artifact[artifactField];
      } else artifact[artifactField!] = value;
      selected.artifact = artifact;
    } else {
      if (field === 'phase-write-scope' && value !== 'artifact-only') throw new Error('This guide supports an explicit artifact-only request; new source effects require their admitted owner.');
      const bodyField = property[field]!;
      const assetReference = ['prompt', 'instructions', 'content'].includes(bodyField) ? selected[`${bodyField}Asset`] : undefined;
      if (assetReference !== undefined) {
        if (typeof assetReference !== 'string' || selected[bodyField] !== undefined) throw new Error('Choose one explicit content representation in advanced JSON first. No manual body or asset was removed.');
        const asset = Array.isArray(envelope.assets) ? envelope.assets.find((entry) => object(entry) && entry.path === assetReference) : undefined;
        if (!object(asset) || typeof asset.content !== 'string') throw new Error('The literal referenced asset is unavailable. No host file was read or content replaced.');
        asset.content = value;
      } else selected[bodyField] = ['phase-inputs', 'agent-tools'].includes(field) ? strings(value) : value;
    }
    // The parsed guide is a separate value; install its preserved definition collection explicitly.
    payload.definitions = { ...guide.definitions, [key]: entries };
  }
  return JSON.stringify(envelope, null, 2);
}

/** A new incomplete component set, not filler prompts, hidden operations or approved bindings. */
export function addWorkflowDraftStage(text: string, namespace: string): string {
  const envelope = workflowDraftEnvelope(text); const guide = workflowDraftGuide(text);
  if (guide.payload.intent === 'edit' || guide.payload.intent === 'fork') throw new Error('Workflow-only edit/copy reuses approved stages. Shared phase, agent, skill and template creation needs a separate reviewed package.');
  if (namespace.length > 64 || !ID.test(namespace)) throw new Error('Choose a bounded lower-case package identity before adding stages.');
  namespace = namespace.slice(0, 48).replace(/-$/u, '');
  if (guide.phases.length >= 32 || guide.workflows.length > 1) throw new Error('This guide supports one workflow and at most 32 candidate stages; advanced content is retained.');
  const used = new Set(Object.values(guide.definitions).flatMap((value) => Array.isArray(value)
    ? value.map((entry) => object(entry) ? entry.id : null) : []));
  let sequence = guide.phases.length + 1;
  while (used.has(`${namespace}-stage-${sequence}`) || used.has(`${namespace}-agent-${sequence}`)
      || used.has(`${namespace}-skill-${sequence}`) || used.has(`${namespace}-template-${sequence}`)) sequence += 1;
  const phase = `${namespace}-stage-${sequence}`; const agent = `${namespace}-agent-${sequence}`;
  const skill = `${namespace}-skill-${sequence}`; const template = `${namespace}-template-${sequence}`;
  const workflow = guide.workflows[0] ?? { id: namespace, phases: [] };
  if (workflow.phases !== undefined && (!Array.isArray(workflow.phases) || workflow.phases.length >= 32 || workflow.phases.some((entry) => typeof entry !== 'string'))) {
    throw new Error('Stage order is not a string list; resolve it in advanced JSON before adding a stage.');
  }
  workflow.phases = [...(workflow.phases as string[] ?? []), phase];
  envelope.payload = { schema: 'sflow-workflow-request@2', intent: 'create', ...guide.payload, definitions: { ...guide.definitions, workflows: [workflow],
    phases: [...guide.phases, { id: phase, label: '', inputs: [], agent, skills: [skill], template }],
    agents: [...guide.agents, { id: agent, description: '', prompt: '', toolBindings: [], skillRefs: [skill] }],
    skills: [...guide.skills, { id: skill, description: '', instructions: '', operationBindings: [], resources: [] }],
    templates: [...guide.templates, { id: template, content: '' }] } };
  return JSON.stringify(envelope, null, 2);
}

export function reorderWorkflowDraftStage(text: string, index: number, direction: number): string {
  const envelope = workflowDraftEnvelope(text); const guide = workflowDraftGuide(text);
  const workflow = guide.workflows[0]; const order = workflow?.phases;
  if (guide.workflows.length !== 1 || !Array.isArray(order) || order.length > 32 || order.some((entry) => typeof entry !== 'string')
      || !Number.isSafeInteger(index) || ![-1, 1].includes(direction) || index < 0 || index >= order.length
      || index + direction < 0 || index + direction >= order.length) throw new Error('Choose a valid adjacent stage move. No order was changed.');
  [order[index], order[index + direction]] = [order[index + direction], order[index]];
  envelope.payload = { ...guide.payload, definitions: { ...guide.definitions, workflows: guide.workflows } };
  return JSON.stringify(envelope, null, 2);
}

/** Reference selection is only a candidate edit. The compiler rechecks source/base and policy. */
export function selectWorkflowDraftCatalog(text: string, kind: string, id: string, index: number): string {
  const envelope = workflowDraftEnvelope(text); const guide = workflowDraftGuide(text);
  // Existing catalog IDs are literal identifiers, not newly authored pathname components.
  if (!id || Buffer.byteLength(id, 'utf8') > 512 || /[\0\r\n]/u.test(id)
      || Buffer.from(id, 'utf8').toString('utf8') !== id || !Number.isSafeInteger(index) || index < 0 || index >= 32) {
    throw new Error('Choose a bounded captured catalog reference.');
  }
  if (kind === 'phase') {
    if (guide.workflows.length !== 1 || !Array.isArray(guide.workflows[0]?.phases)
        || guide.workflows[0].phases.length >= 32 || guide.workflows[0].phases.some((value) => typeof value !== 'string')) throw new Error('Select one bounded workflow before adding an approved catalog stage.');
    if (!guide.workflows[0].phases.includes(id)) guide.workflows[0].phases.push(id);
  } else {
    const phase = guide.phases[index]; if (!phase) throw new Error('Select a candidate stage before binding a catalog component.');
    if (kind === 'agent' || kind === 'template') phase[kind] = { ref: { source: 'catalog', kind, id } };
    else {
      if (!['execution-task', 'approval-authority', 'quality-command'].includes(kind)) throw new Error('This catalog kind is not an editable phase binding.');
      if (guide.payload.bindings !== undefined && !object(guide.payload.bindings)) throw new Error('Resolve the binding map in advanced JSON before selecting a catalog value.');
      const bindings = object(guide.payload.bindings) ? guide.payload.bindings : {};
      const same = Object.entries(bindings).find(([, value]) => object(value) && value.kind === kind && value.id === id && (value.source === undefined || value.source === 'catalog'));
      let alias = same?.[0] ?? `${String(phase.id ?? 'stage').slice(0, 35)}-${kind}`;
      let suffix = 1; const base = alias;
      while (!same && Object.hasOwn(bindings, alias)) alias = `${base}-${suffix++}`;
      if (!same) bindings[alias] = { source: 'catalog', kind, id };
      guide.payload.bindings = bindings;
      if (kind === 'execution-task') phase.taskBinding = alias;
      else if (kind === 'approval-authority') phase.approvalBinding = alias;
      else {
        if (phase.qualityBindings !== undefined && (!Array.isArray(phase.qualityBindings) || phase.qualityBindings.some((value) => typeof value !== 'string'))) throw new Error('Quality bindings are not a string list; no existing value was removed.');
        phase.qualityBindings = [...new Set([...(phase.qualityBindings as string[] ?? []), alias])];
      }
    }
  }
  envelope.payload = { ...guide.payload, definitions: { ...guide.definitions, workflows: guide.workflows, phases: guide.phases } };
  return JSON.stringify(envelope, null, 2);
}

export function bindWorkflowDraftBase(text: string, baseRevision: string): string {
  const envelope = workflowDraftEnvelope(text); const guide = workflowDraftGuide(text);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseRevision)) throw new Error('The captured approved base is not exact.');
  if (guide.payload.target !== undefined && (!object(guide.payload.target)
      || (guide.payload.target.governs !== undefined && guide.payload.target.governs !== 'story')
      || (guide.payload.target.authority !== undefined && guide.payload.target.authority !== 'selected-repository'))) {
    throw new Error('The advanced request declares another target. No scope was silently changed; resolve it explicitly.');
  }
  const target = object(guide.payload.target) ? guide.payload.target : {};
  envelope.payload = { schema: 'sflow-workflow-request@2', intent: 'create', ...guide.payload,
    baseRevision, target: { hosts: [], ...target, governs: 'story', authority: 'selected-repository' } };
  return JSON.stringify(envelope, null, 2);
}

/** Prepare one exact-parent workflow-only request. It never deletes unrelated draft content. */
export function prepareWorkflowDraftChange(text: string, intent: 'edit' | 'fork', choice: {
  id: string; rawDefinitionSha256: string; phaseOrder: string[]
}, baseRevision: string): string {
  const guide = workflowDraftGuide(text); const envelope = workflowDraftEnvelope(text);
  if (!['edit', 'fork'].includes(intent) || !ID.test(choice.id) || choice.id.length > 64
      || !/^sha256:[a-f0-9]{64}$/u.test(choice.rawDefinitionSha256)
      || !Array.isArray(choice.phaseOrder) || !choice.phaseOrder.length || choice.phaseOrder.length > 32
      || choice.phaseOrder.some((id) => typeof id !== 'string' || !ID.test(id))) throw new Error('Select one exact captured approved workflow with a bounded stage order.');
  if (Object.values(guide.definitions).some((value) => !Array.isArray(value) || value.length)
      || Array.isArray(envelope.assets) && envelope.assets.length || guide.payload.changes !== undefined
      || guide.payload.bindings !== undefined || guide.payload.executionProposals !== undefined) {
    throw new Error('Use an empty component package for this workflow-only edit/copy. Existing definitions, assets or decisions were retained, not deleted.');
  }
  const targetId = intent === 'edit' ? choice.id : guide.payload.id;
  if (typeof targetId !== 'string' || !ID.test(targetId) || targetId.length > 64
      || intent === 'fork' && targetId === choice.id) throw new Error('A linked copy requires your explicit new package/workflow identity; it cannot replace its source.');
  const bound = workflowDraftEnvelope(bindWorkflowDraftBase(text, baseRevision));
  const payload = bound.payload as Record<string, unknown>;
  bound.payload = { ...payload, intent,
    changes: [{ kind: 'workflow', id: targetId, operation: intent,
      ...(intent === 'fork' ? { sourceId: choice.id } : {}), expectedDefinitionSha256: choice.rawDefinitionSha256 }],
    definitions: { ...guide.definitions, workflows: [{ id: targetId, phases: [...choice.phaseOrder] }] } };
  return JSON.stringify(bound, null, 2);
}
