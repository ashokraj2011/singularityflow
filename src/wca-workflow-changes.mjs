/** Pure bounded change planning. This is impact data, never a writer or an authority capability. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { canonicalJson, recordSha256 } from './records.mjs';
import { isPortableRepositoryPathComponent, SingularityFlowError } from './util.mjs';
import { resolveWorkType, validateDefinition, validateArtifactTemplateText,
  validateCapturedAgentBriefHeadingContracts, validateWorldModelPromptReferences } from './config.mjs';
import { parseAgentDependencies } from './agents.mjs';
import { portableFilesystemPathIdentity } from './configuration-assets.mjs';
import { normalizeTemplateCatalog } from './template-catalog.mjs';
import { markdownWorldModelViews } from './world-model-views.mjs';

export const WCA_WORKFLOW_CHANGES_PROFILE = 'wca-workflow-only-changes/v1';
export const WCA_SHARED_PHASE_CHANGES_PROFILE = 'wca-shared-phase-impact/v1';
export const WCA_SHARED_AGENT_CHANGES_PROFILE = 'wca-shared-agent-text-impact/v1';
export const WCA_SHARED_TEMPLATE_CHANGES_PROFILE = 'wca-shared-template-content-impact/v1';
export const WCA_WORKFLOW_CHANGE_LIMITS = Object.freeze({ changes: 16, workflows: 256,
  phases: 512, agents: 256, catalogEntries: 512, nodes: 4096, edges: 8192,
  inputNodes: 100000, depth: 32, inputBytes: 8 * 1024 * 1024, outputBytes: 2 * 1024 * 1024 });
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const PATCH_FIELDS = ['label', 'description', 'phases', 'plannedClaims', 'reworkLoops'];
const SHARED_PHASE_FIELDS = ['label', 'description', 'artifact', 'artifactSet', 'defaultTemplate',
  'inputs', 'approval', 'repairBudget', 'clarification', 'specificationQuality', 'testEvidenceFrom'];
const GROUPS = ['workflows', 'phases', 'agents', 'skills', 'templates'];
const digest = (value) => `sha256:${recordSha256(value)}`;
const textDigest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const plain = (value) => value !== null && typeof value === 'object'
  && !types.isProxy(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function fail(code, message, fieldPath = 'changes') {
  throw Object.assign(new SingularityFlowError(message, { code }), { fieldPath });
}
function bound(count, maximum) {
  if (count > maximum) fail('WCA_CHANGE_LIMIT', 'Workflow change impact exceeds its bounded profile; no partial plan was returned.');
}
function closed(value, fields, label) {
  if (!plain(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    fail('WCA_CHANGE_INVALID', `${label} has an unsupported closed shape.`);
  }
}
function identifier(value) {
  if (typeof value !== 'string' || value.length > 64 || !ID.test(value)
      || !isPortableRepositoryPathComponent(value)) fail('WCA_CHANGE_INVALID', 'Select an exact portable catalog identifier.');
  return value;
}
function stableId(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 512
      || /[\u0000-\u001f\u007f]/u.test(value)) fail('WCA_CHANGE_INVALID', 'A dependency identity is not bounded literal data.');
  return value;
}
function copyJson(value) {
  let count = 0; let literalBytes = 0; const active = new Set();
  const reserve = (text) => {
    literalBytes += Buffer.byteLength(text);
    bound(literalBytes, WCA_WORKFLOW_CHANGE_LIMITS.inputBytes);
  };
  function visit(item, depth) {
    bound(++count, WCA_WORKFLOW_CHANGE_LIMITS.inputNodes);
    bound(depth, WCA_WORKFLOW_CHANGE_LIMITS.depth);
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') {
      reserve(item);
      if (Buffer.from(item).toString('utf8') !== item) fail('WCA_CHANGE_INVALID', 'Workflow changes require exact UTF-8 data.');
      return item;
    }
    if (types.isProxy(item) || (!plain(item) && !Array.isArray(item)) || active.has(item)) fail('WCA_CHANGE_INVALID', 'Workflow changes require ordinary acyclic JSON data.');
    if (Reflect.ownKeys(item).some((key) => typeof key !== 'string')
        || Object.values(Object.getOwnPropertyDescriptors(item)).some((entry) => !Object.hasOwn(entry, 'value'))) {
      fail('WCA_CHANGE_INVALID', 'Workflow changes cannot contain accessors or symbol fields.');
    }
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index))) {
        fail('WCA_CHANGE_INVALID', 'Workflow changes require dense ordinary arrays.');
      }
      result = item.map((child) => visit(child, depth + 1));
    } else result = Object.fromEntries(Object.entries(item).map(([key, child]) => {
      reserve(key); return [key, visit(child, depth + 1)];
    }));
    active.delete(item); return result;
  }
  const copied = visit(value, 0);
  bound(Buffer.byteLength(canonicalJson(copied)), WCA_WORKFLOW_CHANGE_LIMITS.inputBytes);
  return copied;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** The raw workType object, not a resolved/migrated policy or a label, owns this identity. */
export function workflowDefinitionSha256(rawWorkType) {
  const value = copyJson(rawWorkType);
  if (!plain(value)) fail('WCA_CHANGE_INVALID', 'An exact raw workflow definition is required.');
  return digest(value);
}

/** Exact raw phase identity; defaults, effective overrides and labels are not substitutes. */
export function phaseDefinitionSha256(rawPhase) {
  const value = copyJson(rawPhase);
  if (!plain(value)) fail('WCA_CHANGE_INVALID', 'An exact raw phase definition is required.');
  return digest(value);
}

/** Exact UTF-8 bytes, never parsed metadata or a discovered display name. */
export function agentTextSha256(text) {
  const value = copyJson(text);
  if (typeof value !== 'string') fail('WCA_CHANGE_INVALID', 'Exact agent source text is required.');
  return textDigest(value);
}

/** A named template's raw string/object declaration owns this identity. */
export function templateDefinitionSha256(rawTemplate) {
  const value = copyJson(rawTemplate);
  if (typeof value !== 'string' && !plain(value)) fail('WCA_CHANGE_INVALID', 'An exact raw template declaration is required.');
  return digest(value);
}

function catalog(value, maximum) {
  if (value === undefined) return {};
  if (!plain(value)) fail('WCA_CHANGE_INVALID', 'An approved dependency catalog is unavailable.');
  bound(Object.keys(value).length, maximum); return value;
}
function list(value, label) {
  if (!Array.isArray(value)) fail('WCA_CHANGE_INVALID', `${label} must be an explicit array.`);
  return value;
}
function phaseIds(value) {
  const values = list(value, 'Workflow phase order').map((entry) => {
    if (typeof entry === 'string') return identifier(entry);
    if (plain(entry) && Object.keys(entry).length === 1 && plain(entry.ref)) entry = entry.ref;
    closed(entry, ['source', 'kind', 'id'], 'Workflow phase reference');
    if (entry.source !== 'catalog' || entry.kind !== 'phase') {
      fail('WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED', 'Workflow changes can select existing approved phases only.');
    }
    return identifier(entry.id);
  });
  bound(values.length, WCA_WORKFLOW_CHANGE_LIMITS.phases);
  if (!values.length || new Set(values).size !== values.length) fail('WCA_CHANGE_INVALID', 'Workflow phase order must be nonempty and unique.');
  return values;
}

function dependencyGraph(definition, agents, replacements, { fullCatalog = false, sharedContent = false, templateContents = [] } = {}) {
  const nodes = new Map(); const edges = new Map();
  const key = (kind, id) => `${kind}:${stableId(id)}`;
  const addNode = (kind, id, value, extras = {}) => {
    const identity = key(kind, id); const sha = digest(value); const previous = nodes.get(identity);
    if (previous && previous.definitionSha256 !== sha) fail('WCA_CHANGE_DEPENDENCY_AMBIGUOUS', 'One dependency identity resolves to different approved definitions.');
    if (!previous) { bound(nodes.size + 1, WCA_WORKFLOW_CHANGE_LIMITS.nodes); nodes.set(identity, { kind, id, definitionSha256: sha, ...extras }); }
    return identity;
  };
  const link = (from, kind, id, relation = 'declared-reference') => {
    const to = key(kind, id);
    if (!nodes.has(to)) fail('WCA_CHANGE_DEPENDENCY_UNAVAILABLE', 'A selected declared dependency is absent from the captured approved catalog.');
    const identity = `${from}\0${to}\0${relation}`;
    if (!edges.has(identity)) { bound(edges.size + 1, WCA_WORKFLOW_CHANGE_LIMITS.edges); edges.set(identity, { from, to, relation }); }
  };
  const workflows = catalog(definition.workTypes, WCA_WORKFLOW_CHANGE_LIMITS.workflows);
  const phases = catalog(definition.phases, WCA_WORKFLOW_CHANGE_LIMITS.phases);
  const templates = catalog(definition.templates, WCA_WORKFLOW_CHANGE_LIMITS.catalogEntries);
  const sets = catalog(definition.artifactSets, WCA_WORKFLOW_CHANGE_LIMITS.catalogEntries);
  const authorities = catalog(definition.approvalAuthorities, WCA_WORKFLOW_CHANGE_LIMITS.catalogEntries);
  const servers = catalog(definition.mcpServers, WCA_WORKFLOW_CHANGE_LIMITS.catalogEntries);
  const viewDeclarations = new Map(list(definition.worldModel?.views ?? [], 'Declared world-model views').map((view) => [stableId(view), view]));
  const contentMap = new Map(templateContents.map((entry) => [entry.path, entry.content]));
  bound(viewDeclarations.size, WCA_WORKFLOW_CHANGE_LIMITS.catalogEntries);
  for (const [kind, values] of [['workflow', workflows], ['phase', phases], ['template', templates],
    ['artifact-set', sets], ['approval-authority', authorities], ['mcp-server', servers]]) {
    for (const [id, value] of Object.entries(values)) addNode(kind, identifier(id), value);
  }
  for (const server of Object.values(servers)) if (!plain(server)) fail('WCA_CHANGE_INVALID', 'Captured server entries must be ordinary objects.');
  const agentMap = new Map();
  for (const agent of agents) {
    if (!plain(agent)) fail('WCA_CHANGE_INVALID', 'Captured agent entries must be ordinary objects.');
    for (const name of ['phases', 'defaultFor', 'tools', 'worldModelViews', 'dependencies']) list(agent[name] ?? [], `Agent ${name}`);
    const id = identifier(agent.id);
    if (agentMap.has(id)) fail('WCA_CHANGE_DEPENDENCY_AMBIGUOUS', 'The captured agent catalog repeats an identity.');
    // Discovery paths may be temporary mounts. Exact source text and metadata are stable identity.
    const identity = { id, scope: agent.scope ?? 'unknown',
      textSha256: typeof agent.text === 'string' ? `sha256:${createHash('sha256').update(agent.text).digest('hex')}` : null,
      phases: agent.phases ?? [], defaultFor: agent.defaultFor ?? [], tools: agent.tools ?? [],
      worldModelViews: agent.worldModelViews ?? [], dependencies: agent.dependencies ?? [] };
    addNode('agent', id, identity, { source: agent.scope === 'repository' ? 'approved-catalog' : 'installed-agent-registry' });
    agentMap.set(id, agent);
    for (const dependency of list(agent.dependencies ?? [], 'Agent dependencies')) {
      if (!plain(dependency)) fail('WCA_CHANGE_INVALID', 'Captured agent dependencies must be ordinary objects.');
      addNode('agent-dependency', `${id}/${identifier(dependency.id)}`, dependency,
        { availability: 'declared-not-fetched', packageBinding: 'unbound' });
    }
  }
  const policy = Object.fromEntries(Object.entries(definition).filter(([name]) =>
    !['workTypes', 'phases', 'templates', 'artifactSets', 'approvalAuthorities', 'mcpServers', 'agents', 'agentCatalog', 'agentPromptsRoot'].includes(name)));
  addNode('policy', 'repository', policy);
  const view = (from, reference) => {
    const id = stableId(reference);
    // A legacy/default view is a declared reference, not a fabricated retained contract.
    addNode('world-model-view', id, { id, declaration: viewDeclarations.get(id) ?? null },
      { availability: viewDeclarations.has(id) ? 'declared-view;contract-owned-by-compiler' : 'not-retained-in-raw-source;validation-owned-by-compiler' });
    link(from, 'world-model-view', id, 'world-model-view');
  };
  const template = (from, reference) => {
    if (reference == null) return;
    stableId(reference);
    if (reference.startsWith('template:')) link(from, 'template', identifier(reference.slice(9)), 'template');
    else if (reference.startsWith('agent:')) {
      const match = /^agent:([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(reference);
      if (!match) fail('WCA_CHANGE_INVALID', 'An agent template reference is unsupported.');
      link(from, 'agent', match[1], 'agent-template');
      link(from, 'agent-dependency', `${match[1]}/${match[2]}`, 'agent-template');
    } else {
      if (reference.startsWith('/') || reference.includes('\\') || reference.split('/').some((part) => !isPortableRepositoryPathComponent(part))) {
        fail('WCA_CHANGE_INVALID', 'A template dependency has an unsafe path.');
      }
      addNode('template-path', reference, { path: reference, root: definition.templatesRoot ?? 'singularity/templates' }, { availability: 'content-verified-by-compiler' });
      link(from, 'template-path', reference, 'template');
      if (sharedContent) {
        const contentPath = `${definition.templatesRoot ?? 'singularity/templates'}/${reference}`;
        if (contentMap.has(contentPath)) {
          addNode('template-content', contentPath, { path: contentPath, contentSha256: textDigest(contentMap.get(contentPath)) });
          link(key('template-path', reference), 'template-content', contentPath, 'exact-local-content');
        }
      }
    }
  };
  const named = (from, value) => {
    if (Array.isArray(value)) { for (const child of value) named(from, child); return; }
    if (!plain(value)) return;
    for (const [name, child] of Object.entries(value)) {
      if (name === 'artifactSet' && typeof child === 'string') link(from, 'artifact-set', child);
      // A compiled SKP readScope.inputs is a boolean, not a phase-reference collection.
      // Actual phase/binding input declarations are separately required to be arrays below.
      if (name === 'inputs' && Array.isArray(child)) for (const input of list(child, name)) {
        const phaseId = typeof input === 'string' ? input : input?.phase;
        if (phaseId !== undefined) link(from, 'phase', phaseId, 'input');
      }
      if (name === 'testEvidenceFrom' && typeof child === 'string') link(from, 'phase', child, 'test-evidence');
      if (name === 'rejectTo') for (const id of typeof child === 'string' ? [child] : list(child, name)) {
        link(from, 'phase', identifier(id), 'rejection-target');
      }
      if (name === 'consumes') for (const reference of list(child, name)) {
        if (typeof reference === 'string' && reference.includes('/')) link(from, 'phase', reference.split('/')[0], 'output-input');
      }
      if (['authorities', 'requiredAuthorities'].includes(name)) for (const id of list(child, name)) link(from, 'approval-authority', identifier(id));
      if (name === 'authority' && typeof child === 'string' && Object.hasOwn(authorities, child)) link(from, 'approval-authority', child);
      if (name === 'requiredServers') for (const id of list(child, name)) link(from, 'mcp-server', identifier(id));
      if (name === 'server' && typeof child === 'string' && value.tool) link(from, 'mcp-server', child);
      if (name === 'agents') for (const id of list(child, name)) link(from, 'agent', identifier(id));
      if (name === 'worldModelViews' || name === 'views' && Array.isArray(child) && child.every((entry) => typeof entry === 'string')) {
        for (const reference of list(child, name)) view(from, reference);
      }
      if (name === 'defaultTemplate' || name === 'template' && typeof child === 'string') template(from, child);
      if (fullCatalog) {
        if (['allowedPhases', 'blockRequiredUnfulfilledAt', 'clausePhases'].includes(name) && Array.isArray(child)) {
          for (const id of child) link(from, 'phase', identifier(id), 'policy-phase-reference');
        }
        if (name === 'phaseOverrides' && plain(child)) for (const id of Object.keys(child)) {
          link(from, 'phase', identifier(id), 'phase-override');
        }
        if (name === 'when' && plain(child)) for (const [field, kind] of [['phase', 'phase'], ['agent', 'agent'], ['workType', 'workflow']]) {
          for (const id of child[field] == null ? [] : Array.isArray(child[field]) ? child[field] : [child[field]]) {
            link(from, kind, identifier(id), 'injection-condition');
          }
        }
      }
      named(from, child);
    }
  };
  if (fullCatalog) named(key('policy', 'repository'), policy);
  for (const [id, phase] of Object.entries(phases)) {
    if (!plain(phase)) fail('WCA_CHANGE_INVALID', 'Captured phases must be ordinary objects.');
    const from = key('phase', id); named(from, phase);
    for (const input of list(phase.inputs ?? [], 'Phase inputs')) link(from, 'phase', typeof input === 'string' ? input : input?.phase, 'input');
    if (phase.testEvidenceFrom) link(from, 'phase', phase.testEvidenceFrom, 'test-evidence');
    for (const input of list(phase.skillBinding?.bindingRefs?.inputs ?? [], 'Skill inputs')) link(from, 'phase', input?.phase, 'skill-input');
    if (typeof phase.approval?.rejectTo === 'string') link(from, 'phase', phase.approval.rejectTo, 'rejection-target');
    if (typeof phase.generation?.task === 'string') {
      const taskId = identifier(phase.generation.task);
      addNode('execution-task', taskId, { id: taskId, owner: 'model-tasks/v1' }, { availability: 'validation-owned-by-compiler' });
      link(from, 'execution-task', taskId, 'generation-task');
    }
    const selected = phase.skillBinding?.bindingRefs?.skill;
    if (phase.kind === 'skill') {
      if (!selected || !SHA.test(selected.packageSha256 ?? '')) fail('WCA_CHANGE_DEPENDENCY_UNAVAILABLE', 'A skill phase lacks an exact retained package reference.');
      addNode('skill-package', `${identifier(selected.id)}/${selected.packageSha256}`, selected, { packageBinding: 'exact', availability: 'retained-by-configuration-owner' });
      link(from, 'skill-package', `${selected.id}/${selected.packageSha256}`, 'skill');
    }
    for (const [index, command] of list(phase.qualityCommands ?? [], 'Quality commands').entries()) {
      const commandId = `${id}/${plain(command) ? command.id ?? `quality-${index + 1}` : `quality-${index + 1}`}`;
      addNode('quality-command', commandId, command); link(from, 'quality-command', commandId, 'check');
    }
    for (const agent of agents) if ((agent.defaultFor ?? []).includes(id)) link(from, 'agent', agent.id, 'default-agent');
    for (const [serverId, server] of Object.entries(servers)) if ((server.phases ?? []).includes(id)) link(from, 'mcp-server', serverId, 'phase-server-scope');
  }
  for (const [id, set] of Object.entries(sets)) named(key('artifact-set', id), set);
  for (const [id, declaration] of Object.entries(templates)) {
    template(key('template', id), typeof declaration === 'string' ? declaration : declaration?.path);
  }
  for (const agent of agents) {
    const from = key('agent', agent.id);
    for (const reference of list(agent.worldModelViews ?? [], 'Agent world-model views')) view(from, reference);
    for (const dependency of agent.dependencies ?? []) link(from, 'agent-dependency', `${agent.id}/${dependency.id}`, 'agent-dependency');
    for (const [id, server] of Object.entries(servers)) if ((server.agents ?? []).includes(agent.id)) link(from, 'mcp-server', id, 'agent-server-scope');
    if (fullCatalog) {
      // Eligibility is not execution or a tool grant. Unrestricted roles are eligible for every
      // configured phase; dormant installed declarations outside this exact catalog stay dormant.
      for (const id of (agent.phases ?? []).length ? agent.phases : Object.keys(phases)) {
        if (Object.hasOwn(phases, id)) {
          link(from, 'phase', id, 'agent-phase-eligibility');
          if (sharedContent) link(key('phase', id), 'agent', agent.id, 'eligible-agent-not-executed');
        }
      }
      for (const id of agent.defaultFor ?? []) if (Object.hasOwn(phases, id)) link(from, 'phase', id, 'agent-default-for');
      for (const [id, server] of Object.entries(servers)) if (!(server.agents ?? []).length) {
        link(from, 'mcp-server', id, 'unrestricted-server-agent-eligibility');
      }
      for (const dependency of agent.dependencies ?? []) {
        const declarations = dependency.phase != null ? [dependency.phase]
          : (dependency.phases ?? []).length ? dependency.phases
            : ['skill', 'template'].includes(dependency.type) ? Object.keys(phases) : [];
        for (const phaseId of declarations) if (Object.hasOwn(phases, phaseId)) {
          link(key('agent-dependency', `${agent.id}/${dependency.id}`), 'phase', phaseId, 'agent-dependency-phase-scope');
        }
      }
    }
  }
  for (const [id, server] of Object.entries(servers)) {
    if (!plain(server)) fail('WCA_CHANGE_INVALID', 'Captured server entries must be ordinary objects.');
    const from = key('mcp-server', id);
    for (const phaseId of server.phases ?? []) link(from, 'phase', phaseId, 'complete-server-scope');
    for (const agentId of server.agents ?? []) link(from, 'agent', agentId, 'complete-server-scope');
    if (fullCatalog) {
      if (!(server.phases ?? []).length) for (const phaseId of Object.keys(phases)) link(from, 'phase', phaseId, 'unrestricted-server-phase-scope');
      if (!(server.agents ?? []).length) for (const agent of agents) link(from, 'agent', agent.id, 'unrestricted-server-agent-scope');
    }
  }
  const workflow = (from, value) => {
    if (!plain(value)) fail('WCA_CHANGE_INVALID', 'Captured workflows must be ordinary objects.');
    for (const phaseId of phaseIds(value.phases)) link(from, 'phase', phaseId, 'selected-phase');
    for (const reference of Object.values(value.templateOverrides ?? {})) template(from, reference);
    named(from, value); link(from, 'policy', 'repository', 'inherited-policy');
  };
  for (const [id, value] of Object.entries(workflows)) workflow(key('workflow', id), value);
  const roots = [];
  for (const replacement of replacements) {
    const from = addNode('candidate-workflow', replacement.id, replacement.definition);
    workflow(from, replacement.definition); roots.push(from);
  }
  const adjacency = new Map(); const dependents = new Map();
  for (const edge of edges.values()) {
    const values = adjacency.get(edge.from) ?? []; values.push(edge.to); adjacency.set(edge.from, values);
    const consumers = dependents.get(edge.to) ?? new Set(); consumers.add(edge.from); dependents.set(edge.to, consumers);
  }
  const selected = new Set(fullCatalog ? nodes.keys() : roots); const pending = [...roots];
  for (let index = 0; index < pending.length; index += 1) for (const to of adjacency.get(pending[index]) ?? []) {
    if (!selected.has(to)) { selected.add(to); pending.push(to); }
  }
  const selectedNodes = [...selected].sort(compare).map((id) => nodes.get(id));
  const selectedEdges = [...edges.values()].filter((edge) => selected.has(edge.from)).sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
  const sharedDependencies = selectedNodes.filter((node) => node.kind !== 'candidate-workflow').map((node) => ({
    kind: node.kind, id: node.id, definitionSha256: node.definitionSha256,
    directDependents: [...(dependents.get(key(node.kind, node.id)) ?? [])].filter((id) => !id.startsWith('candidate-workflow:'))
      .sort(compare).map((id) => ({ kind: nodes.get(id).kind, id: nodes.get(id).id }))
  }));
  return { graph: { nodes: selectedNodes, edges: selectedEdges },
    dependencyLocks: selectedNodes.filter((node) => node.kind !== 'candidate-workflow'), sharedDependencies };
}

/** Caller supplies owner-captured raw approved YAML and agent metadata; no I/O or discovery occurs. */
export function planWorkflowOnlyChanges(input = {}) {
  const empty = { profile: WCA_WORKFLOW_CHANGES_PROFILE, intent: null, status: 'blocked',
    replacements: [], dependencyLocks: [], graph: { nodes: [], edges: [] },
    impact: { scope: 'selected-approved-configuration-only', sharedDependencies: [],
      retainedStories: 'unchanged-not-inventoried', otherRepositories: 'unknown-not-inventoried',
      permissions: 'not-granted', execution: 'not-run', activation: 'inactive' }, findings: [] };
  try {
    const copied = copyJson(input); closed(copied, ['request', 'approvedDefinition', 'agents'], 'Workflow change planner input');
    const { request, approvedDefinition: definition, agents = [] } = copied;
    if (!plain(request) || !plain(definition)) fail('WCA_CHANGE_INVALID', 'Exact request and approved definition data are required.');
    if (!['edit', 'fork'].includes(request.intent)) fail('WCA_CHANGE_INVALID', 'This profile supports only explicit workflow edits and linked forks.');
    empty.intent = request.intent;
    list(agents, 'Captured agents'); bound(agents.length, WCA_WORKFLOW_CHANGE_LIMITS.agents);
    closed(request.definitions, GROUPS, 'Workflow-only definitions');
    for (const group of GROUPS.filter((name) => name !== 'workflows')) if (request.definitions[group] !== undefined
      && list(request.definitions[group], group).length) fail('WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED', 'Workflow edit/fork cannot create or change shared phase, agent, skill or template definitions.');
    for (const name of ['assets', 'executionProposals']) if (request[name] !== undefined && list(request[name], name).length) {
      fail('WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED', 'Workflow-only changes cannot attach new assets or executable proposals.');
    }
    const changes = list(request.changes, 'Explicit workflow changes');
    const patches = list(request.definitions.workflows, 'Workflow patches');
    bound(changes.length, WCA_WORKFLOW_CHANGE_LIMITS.changes); bound(patches.length, WCA_WORKFLOW_CHANGE_LIMITS.changes);
    if (!changes.length || changes.length !== patches.length) fail('WCA_CHANGE_INVALID', 'Every explicit workflow change needs exactly one matching patch.');
    const workflows = catalog(definition.workTypes, WCA_WORKFLOW_CHANGE_LIMITS.workflows);
    const phases = catalog(definition.phases, WCA_WORKFLOW_CHANGE_LIMITS.phases);
    const patchMap = new Map();
    for (const patch of patches) {
      closed(patch, ['id', ...PATCH_FIELDS], 'Workflow patch'); const id = identifier(patch.id);
      if (patchMap.has(id)) fail('WCA_CHANGE_INVALID', 'Workflow patches repeat an identity.'); patchMap.set(id, patch);
    }
    const replacements = []; const selectedIds = new Set();
    for (const change of changes) {
      closed(change, change.operation === 'fork'
        ? ['kind', 'id', 'operation', 'sourceId', 'expectedDefinitionSha256']
        : ['kind', 'id', 'operation', 'expectedDefinitionSha256'], 'Workflow change');
      if (change.kind !== 'workflow' || change.operation !== request.intent) fail('WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED', 'Only a matching workflow edit or linked fork is supported.');
      const id = identifier(change.id); const sourceId = request.intent === 'fork' ? identifier(change.sourceId) : id;
      if (selectedIds.has(id)) fail('WCA_CHANGE_INVALID', 'Workflow changes repeat a target identity.'); selectedIds.add(id);
      if (id.startsWith('sf-') || id.startsWith('sflow-')) fail('WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED', 'Privileged installed workflow identities cannot be replaced or forked.');
      if (!Object.hasOwn(workflows, sourceId)) fail('WCA_CHANGE_SOURCE_UNAVAILABLE', 'The selected workflow source is absent from the captured approved definition.');
      if (request.intent === 'fork' && (id === sourceId || Object.hasOwn(workflows, id))) fail('WCA_CHANGE_TARGET_EXISTS', 'A linked fork needs a new unused workflow identity.');
      const source = workflows[sourceId]; const expected = workflowDefinitionSha256(source);
      if (typeof change.expectedDefinitionSha256 !== 'string' || !SHA.test(change.expectedDefinitionSha256)
          || change.expectedDefinitionSha256 !== expected) fail('WCA_CHANGE_PARENT_STALE', 'The exact raw workflow parent changed; review the current source before applying this change.');
      const patch = patchMap.get(id); if (!patch) fail('WCA_CHANGE_INVALID', 'An explicit change has no matching workflow patch.');
      const replacement = structuredClone(source);
      for (const field of PATCH_FIELDS) if (Object.hasOwn(patch, field)) replacement[field] = structuredClone(patch[field]);
      if (typeof replacement.label !== 'string' || !replacement.label.trim() || Buffer.byteLength(replacement.label) > 512
          || /[\u0000-\u001f\u007f]/u.test(replacement.label)
          || replacement.description !== undefined && (typeof replacement.description !== 'string' || Buffer.byteLength(replacement.description) > 30000 || /\0/u.test(replacement.description))) {
        fail('WCA_CHANGE_INVALID', 'Workflow display fields require bounded literal text.');
      }
      replacement.phases = phaseIds(replacement.phases);
      for (const phaseId of replacement.phases) if (!Object.hasOwn(phases, phaseId)) fail('WCA_CHANGE_PHASE_UNAVAILABLE', 'Workflow changes can select existing captured phases only.');
      const originalOrder = phaseIds(source.phases);
      if (canonicalJson(originalOrder) !== canonicalJson(replacement.phases)
          && [...new Set([...originalOrder, ...replacement.phases])].some((phaseId) => phases[phaseId]?.kind === 'skill')) {
        fail('WCA_CHANGE_SKP_RECOMPILE_REQUIRED', 'Changing a workflow containing a skill phase requires an explicitly recompiled confirmed contract; linked bindings cannot be silently reused.');
      }
      const policyRelevantFields = ['phases', 'plannedClaims', 'reworkLoops'].filter((field) =>
        canonicalJson({ value: source[field] ?? null }) !== canonicalJson({ value: replacement[field] ?? null }));
      replacements.push({ id, operation: request.intent, sourceId, expectedDefinitionSha256: expected,
        beforeDefinitionSha256: request.intent === 'edit' ? expected : null,
        afterDefinitionSha256: workflowDefinitionSha256(replacement), definition: replacement,
        policyRelevantFields, dependencyMaterialization: 'linked-no-shared-object-change' });
    }
    replacements.sort((a, b) => compare(a.id, b.id));
    const projected = dependencyGraph(definition, agents, replacements);
    const result = { ...empty, status: 'ready', replacements, dependencyLocks: projected.dependencyLocks,
      graph: projected.graph, impact: { ...empty.impact, sharedDependencies: projected.sharedDependencies,
        changedWorkflowIds: replacements.map((row) => row.id), sharedDefinitions: 'unchanged',
        coverage: 'declared-approved-graph-complete-within-bounds;content-and-runtime-readiness-owned-by-compiler' } };
    const planned = { ...result, planSha256: digest(result) };
    bound(Buffer.byteLength(canonicalJson(planned)), WCA_WORKFLOW_CHANGE_LIMITS.outputBytes);
    return freeze(planned);
  } catch (error) {
    if (!(error instanceof SingularityFlowError)) throw error;
    const result = { ...empty, findings: [{ code: error.code, fieldPath: error.fieldPath ?? 'changes',
      message: error.message, category: 'submission-blocker', resolvingAction: 'workflow.author.edit' }] };
    return freeze({ ...result, planSha256: digest(result) });
  }
}

function validatedSharedPhaseDefinition(definition, agents, { prospective = false } = {}) {
  const projected = structuredClone(definition);
  projected.agentCatalog = agents;
  projected.agents = Object.fromEntries(agents.map((agent) => [agent.id, agent]));
  try { return validateDefinition(projected); }
  catch (error) {
    fail(prospective && error?.code?.startsWith('SKP_')
      ? 'WCA_SHARED_PHASE_SKP_RECOMPILE_REQUIRED'
      : prospective ? 'WCA_SHARED_PHASE_DEFINITION_INVALID' : 'WCA_SHARED_PHASE_SOURCE_INVALID',
    prospective
      ? 'The complete prospective definition is refused by the existing configuration owner; resolve all consumer contracts before reviewing this replacement.'
      : 'The complete captured source definition is unavailable or invalid under the existing configuration owner.',
    'changes');
  }
}

function reverseSharedPhaseImpact(before, after, phaseIds, rootKeys = null) {
  const nodeMap = new Map([...before.nodes, ...after.nodes].map((node) => [`${node.kind}:${node.id}`, node]));
  const incoming = new Map();
  const edgeMap = new Map([...before.edges, ...after.edges].map((edge) => [canonicalJson(edge), edge]));
  for (const edge of edgeMap.values()) {
    const values = incoming.get(edge.to) ?? new Set(); values.add(edge.from); incoming.set(edge.to, values);
  }
  const roots = new Set(rootKeys ?? phaseIds.map((id) => `phase:${id}`));
  const selected = new Set(roots); const pending = [...roots];
  for (let index = 0; index < pending.length; index += 1) for (const from of incoming.get(pending[index]) ?? []) {
    if (!selected.has(from)) { selected.add(from); pending.push(from); }
  }
  const direct = new Set([...roots].flatMap((root) => [...(incoming.get(root) ?? [])]));
  const consumers = [...selected].filter((key) => !roots.has(key)).sort(compare).map((key) => ({
    kind: nodeMap.get(key).kind, id: nodeMap.get(key).id, relation: direct.has(key) ? 'direct' : 'transitive'
  }));
  return { consumers, edges: [...edgeMap.values()].filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    .sort((left, right) => compare(canonicalJson(left), canonicalJson(right))) };
}

function effectiveSharedPhaseSha256(phase) {
  const value = structuredClone(phase);
  // resolveWorkType retains the raw fallback for compatibility, but its resolved `template`
  // owns consumption. A work-type template override can mask a shared fallback replacement.
  delete value.defaultTemplate;
  return digest(value);
}

function unchangedSharedPhaseExtensions(before, after, allowed) {
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (!allowed.includes(key) && (Object.hasOwn(before ?? {}, key) !== Object.hasOwn(after ?? {}, key)
        || digest({ value: before?.[key] ?? null }) !== digest({ value: after?.[key] ?? null }))) {
      fail('WCA_SHARED_PHASE_EFFECT_CHANGE_UNSUPPORTED', 'Unknown nested artifact extensions must remain exactly unchanged in this structural profile.');
    }
  }
}

/**
 * Plan exact existing ordinary phase replacements against one caller-captured catalog. This
 * pure API proves no catalog provenance or authorization: only a future separately confirmed
 * owner may recapture its inputs and use the impact plan. It emits no files or writer capability.
 * Execution/producer/source/MCP fields and unrecognized extensions must stay exactly unchanged.
 */
export function planSharedPhaseChanges(input = {}) {
  const empty = { profile: WCA_SHARED_PHASE_CHANGES_PROFILE, status: 'blocked', source: null,
    replacements: [], dependencyLocks: [], graph: { before: { nodes: [], edges: [] }, after: { nodes: [], edges: [] } },
    impact: { scope: 'captured-approved-configuration-only', consumers: [], affectedWorkflows: [],
      retainedStories: 'unchanged-not-inventoried', otherRepositories: 'unknown-not-inventoried',
      permissions: 'not-granted', execution: 'not-run', activation: 'inactive',
      submission: 'unavailable-from-this-planning-profile' }, findings: [] };
  try {
    const copied = copyJson(input); closed(copied, ['approvedDefinition', 'agents', 'changes'], 'Shared phase planner input');
    const { approvedDefinition: definition, agents, changes } = copied;
    if (!plain(definition)) fail('WCA_SHARED_PHASE_SOURCE_INVALID', 'Exact captured raw configuration data is required.');
    list(agents, 'Complete captured agent metadata'); bound(agents.length, WCA_WORKFLOW_CHANGE_LIMITS.agents);
    if (!agents.length || agents.some((agent) => !plain(agent) || typeof agent.text !== 'string')) {
      fail('WCA_SHARED_PHASE_CATALOG_INCOMPLETE', 'Complete captured agent metadata and exact source text are required; no discovery or name fallback occurs.');
    }
    list(changes, 'Explicit shared phase changes'); bound(changes.length, WCA_WORKFLOW_CHANGE_LIMITS.changes);
    if (!changes.length) fail('WCA_CHANGE_INVALID', 'Select at least one explicit shared phase replacement.');
    const phases = catalog(definition.phases, WCA_WORKFLOW_CHANGE_LIMITS.phases);
    // Bound and resolve every declared source dependency before invoking the broader validator.
    // fullCatalog never changes the historical workflow-only graph or its digest semantics.
    const before = dependencyGraph(definition, agents, [], { fullCatalog: true });
    const validatedBefore = validatedSharedPhaseDefinition(definition, agents);
    const candidate = structuredClone(definition); const seen = new Set(); const replacements = [];
    for (const change of changes) {
      closed(change, ['kind', 'id', 'operation', 'expectedDefinitionSha256', 'replacement'], 'Shared phase replacement');
      if (change.kind !== 'phase' || change.operation !== 'edit') {
        fail('WCA_SHARED_PHASE_UNSUPPORTED', 'This read-only profile supports exact existing ordinary phase edits, not deletion, forks or other shared object kinds.');
      }
      const id = identifier(change.id);
      if (seen.has(id)) fail('WCA_CHANGE_INVALID', 'Shared phase replacements repeat an identity.'); seen.add(id);
      if (id.startsWith('sf-') || id.startsWith('sflow-')) fail('WCA_SHARED_PHASE_UNSUPPORTED', 'Privileged installed phase identities cannot be replaced.');
      if (!Object.hasOwn(phases, id)) fail('WCA_SHARED_PHASE_SOURCE_UNAVAILABLE', 'The exact shared phase is absent from the captured source catalog.');
      const source = phases[id]; const expected = phaseDefinitionSha256(source);
      if (typeof change.expectedDefinitionSha256 !== 'string' || !SHA.test(change.expectedDefinitionSha256)
          || change.expectedDefinitionSha256 !== expected) {
        fail('WCA_CHANGE_PARENT_STALE', 'The exact raw phase parent changed; recapture and review the current catalog before planning an edit.');
      }
      if (!plain(change.replacement)) fail('WCA_CHANGE_INVALID', 'Shared phase replacement must contain the complete exact raw object.');
      if (source.kind === 'skill' || change.replacement.kind === 'skill') {
        fail('WCA_SHARED_PHASE_SKP_RECOMPILE_REQUIRED', 'Compiled skill phases require a separately confirmed recompiled binding; this profile cannot replace them.');
      }
      const changedFields = [...new Set([...Object.keys(source), ...Object.keys(change.replacement)])].filter((field) =>
        Object.hasOwn(source, field) !== Object.hasOwn(change.replacement, field)
        || digest({ value: source[field] ?? null }) !== digest({ value: change.replacement[field] ?? null })).sort(compare);
      if (changedFields.some((field) => !SHARED_PHASE_FIELDS.includes(field))) {
        fail('WCA_SHARED_PHASE_EFFECT_CHANGE_UNSUPPORTED', 'Execution, producer, MCP/tool, source-boundary and unknown-extension changes are outside this structural review profile.');
      }
      const replacement = structuredClone(change.replacement);
      unchangedSharedPhaseExtensions(source.artifact, replacement.artifact,
        ['path', 'kind', 'minimumBytes', 'maximumBytes', 'allowedExtensions', 'allowedMediaTypes', 'validation']);
      unchangedSharedPhaseExtensions(source.artifact?.validation, replacement.artifact?.validation,
        ['requiredHeadings', 'forbiddenPlaceholders']);
      if (typeof replacement.label !== 'string' || !replacement.label.trim() || Buffer.byteLength(replacement.label) > 512
          || /[\u0000-\u001f\u007f]/u.test(replacement.label)
          || replacement.description !== undefined && (typeof replacement.description !== 'string'
            || Buffer.byteLength(replacement.description) > 30000 || /\0/u.test(replacement.description))) {
        fail('WCA_CHANGE_INVALID', 'Phase display fields require bounded literal text.');
      }
      candidate.phases[id] = replacement;
      replacements.push({ kind: 'phase', id, operation: 'edit', expectedDefinitionSha256: expected,
        beforeDefinitionSha256: expected, afterDefinitionSha256: phaseDefinitionSha256(replacement),
        changedFields, definition: replacement });
    }
    replacements.sort((left, right) => compare(left.id, right.id));
    for (const phase of Object.values(phases)) if (phase.kind === 'skill'
        && (phase.skillBinding?.bindingRefs?.inputs ?? []).some((input) => replacements.some((replacement) =>
          replacement.id === input.phase && replacement.changedFields.some((field) => !['label', 'description'].includes(field))))) {
      fail('WCA_SHARED_PHASE_SKP_RECOMPILE_REQUIRED', 'A confirmed skill consumes this changed producer contract. Recompile its exact binding under separate consent before changing the shared structure.');
    }
    const after = dependencyGraph(candidate, agents, [], { fullCatalog: true });
    const validatedAfter = validatedSharedPhaseDefinition(candidate, agents, { prospective: true });
    const impact = reverseSharedPhaseImpact(before.graph, after.graph, replacements.map((row) => row.id));
    const affectedWorkflows = impact.consumers.filter((row) => row.kind === 'workflow').map((row) => {
      const oldResolved = resolveWorkType(validatedBefore, row.id); const newResolved = resolveWorkType(validatedAfter, row.id);
      const effectivePhases = replacements.filter((replacement) => oldResolved.phases.some((phase) => phase.id === replacement.id))
        .map((replacement) => {
          const oldPhase = oldResolved.phases.find((phase) => phase.id === replacement.id);
          const newPhase = newResolved.phases.find((phase) => phase.id === replacement.id);
          const beforeSha256 = effectiveSharedPhaseSha256(oldPhase); const afterSha256 = effectiveSharedPhaseSha256(newPhase);
          return { id: replacement.id, beforeSha256, afterSha256,
            status: beforeSha256 === afterSha256 ? 'unchanged-effective-phase' : 'changed-effective-phase',
            overrideFields: Object.keys(definition.workTypes[row.id].phaseOverrides?.[replacement.id] ?? {}).sort(compare),
            templateOverride: Object.hasOwn(definition.workTypes[row.id].templateOverrides ?? {}, replacement.id) };
        });
      return { id: row.id, relation: row.relation, effectivePhases,
        status: effectivePhases.some((phase) => phase.status === 'changed-effective-phase')
          ? 'effective-phase-changed' : effectivePhases.length ? 'effective-phase-unchanged' : 'declared-dependency-only' };
    });
    const result = { ...empty, status: 'ready-for-review',
      source: { definitionSha256: digest(definition), agentCatalogSha256: digest(before.graph.nodes.filter((node) => node.kind === 'agent')) },
      replacements, dependencyLocks: before.dependencyLocks,
      graph: { before: before.graph, after: after.graph }, impact: { ...empty.impact, consumers: impact.consumers,
        consumerEdges: impact.edges, affectedWorkflows, changedPhaseIds: replacements.map((row) => row.id),
        coverage: 'complete-declared-catalog-reference-impact-within-bounds;eligibility-is-not-execution',
        validation: 'existing-definition-owner-on-private-source-and-prospective-clones',
        excluded: ['retained-story-inventory', 'other-repository-inventory', 'agent-and-template-byte-readiness',
          'external-dependency-hydration', 'real-human-availability', 'host-qualification', 'authorization', 'submission'] } };
    const planned = { ...result, planSha256: digest(result) };
    bound(Buffer.byteLength(canonicalJson(planned)), WCA_WORKFLOW_CHANGE_LIMITS.outputBytes);
    return freeze(planned);
  } catch (error) {
    if (!(error instanceof SingularityFlowError)) throw error;
    const result = { ...empty, findings: [{ code: error.code, fieldPath: error.fieldPath ?? 'changes',
      message: error.message, category: 'submission-blocker', resolvingAction: 'workflow.author.edit' }] };
    return freeze({ ...result, planSha256: digest(result) });
  }
}

function contentPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
      || value.split('/').some((part) => !isPortableRepositoryPathComponent(part))) {
    fail('WCA_CHANGE_INVALID', 'Shared content requires an exact portable captured path.');
  }
  return value;
}
function agentFrontmatter(text) {
  const offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const opening = /^---\r?\n/u.exec(text.slice(offset));
  if (!opening) fail('WCA_SHARED_CONTENT_SOURCE_INVALID', 'A complete existing Agent Markdown frontmatter is required.');
  const remainder = text.slice(offset + opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/u.exec(remainder);
  if (!closing) fail('WCA_SHARED_CONTENT_SOURCE_INVALID', 'The existing Agent Markdown frontmatter is unavailable.');
  return text.slice(0, offset + opening[0].length + closing.index + closing[0].length);
}
function agentResourceTableBytes(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const tables = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^## remote (?:skills|artifact templates|generated artifacts)$/u.test(lines[index].trim().toLowerCase())) continue;
    const start = index; while (lines[index + 1]?.trim() === '') index += 1;
    while (lines[index + 1]?.trim().startsWith('|')) index += 1;
    tables.push(lines.slice(start, index + 1).join(''));
  }
  return tables;
}
function capturedAgent(agent) {
  if (!plain(agent) || typeof agent.text !== 'string') fail('WCA_SHARED_CONTENT_SOURCE_INVALID', 'Complete captured agent source text is required.');
  let parsed;
  try { parsed = parseAgentDependencies(agent.text, { source: agent.source ?? `${agent.id}.agent.md`, agentId: identifier(agent.id) }); }
  catch { fail('WCA_SHARED_CONTENT_SOURCE_INVALID', 'The captured Agent Markdown is invalid under its existing owner.'); }
  for (const field of ['phases', 'defaultFor', 'tools', 'worldModelViews', 'dependencies']) {
    if (digest(parsed[field]) !== digest(agent[field] ?? [])) fail('WCA_SHARED_CONTENT_SOURCE_INVALID', 'Captured agent metadata differs from its exact source text.');
  }
  return { ...agent, ...parsed };
}
function templateSelection(definition, reference) {
  stableId(reference);
  const named = reference.startsWith('template:');
  if (!named && !reference.startsWith('path:')) fail('WCA_SHARED_CONTENT_UNSUPPORTED', 'Select template:<catalog-id> or path:<existing-relative-path>; remote Agent resources are not hydrated.');
  const id = named ? identifier(reference.slice(9)) : null;
  if (named && !Object.hasOwn(definition.templates ?? {}, id)) fail('WCA_SHARED_CONTENT_SOURCE_UNAVAILABLE', 'The exact named template is absent from the captured catalog.');
  const raw = named ? definition.templates[id] : null;
  const relative = contentPath(named ? (typeof raw === 'string' ? raw : raw.path) : reference.slice(5));
  const path = contentPath(`${definition.templatesRoot ?? 'singularity/templates'}/${relative}`);
  const identity = portableFilesystemPathIdentity(path);
  if (!identity.endsWith('.md') || identity.split('/')[0].startsWith('.')) {
    fail('WCA_SHARED_CONTENT_UNSUPPORTED', 'This template profile replaces Markdown outside native discovery/configuration roots only; it cannot act as an Agent, skill, workflow or executable editor.');
  }
  return { id, named, raw, relative, path };
}
function textContracts(definition, templates, changedTexts, changedTemplates) {
  try {
    for (const { content } of changedTemplates) validateArtifactTemplateText(content);
    validateCapturedAgentBriefHeadingContracts(definition, templates);
    const references = new Map();
    for (const entry of changedTexts) for (const view of markdownWorldModelViews(entry.content)) {
      const paths = references.get(view) ?? []; paths.push(entry.path); references.set(view, paths);
    }
    validateWorldModelPromptReferences(definition, references);
  } catch (error) {
    fail(error?.code?.startsWith('SKP_') ? 'WCA_SHARED_CONTENT_SKP_RECOMPILE_REQUIRED' : 'WCA_SHARED_CONTENT_CONTRACT_INVALID',
      'The prospective exact text violates an existing template, preserved-heading or world-model view contract.');
  }
}

/** Pure exact text impact; arbitrary JSON is never approved provenance or a writer capability. */
function planSharedContentChanges(input, profile, kind) {
  const empty = { profile, status: 'blocked', source: null, replacements: [], dependencyLocks: [],
    graph: { before: { nodes: [], edges: [] }, after: { nodes: [], edges: [] } },
    impact: { scope: 'captured-approved-configuration-only', consumers: [], affectedWorkflows: [],
      retainedStories: 'unchanged-not-inventoried', otherRepositories: 'unknown-not-inventoried',
      permissions: 'not-granted', execution: 'not-run', activation: 'inactive', submission: 'unavailable-from-this-planning-profile' }, findings: [] };
  try {
    const copied = copyJson(input); closed(copied, ['approvedDefinition', 'agents', 'templateContents', 'changes'], 'Shared content planner input');
    const definition = copied.approvedDefinition;
    if (!plain(definition)) fail('WCA_SHARED_CONTENT_SOURCE_INVALID', 'Exact captured raw configuration data is required.');
    const agents = list(copied.agents, 'Complete captured agents').map(capturedAgent);
    bound(agents.length, WCA_WORKFLOW_CHANGE_LIMITS.agents);
    const contents = list(copied.templateContents ?? [], 'Captured template contents');
    bound(contents.length, WCA_WORKFLOW_CHANGE_LIMITS.catalogEntries);
    const templates = new Map();
    for (const entry of contents) {
      closed(entry, ['path', 'content'], 'Captured template content'); const path = contentPath(entry.path);
      if (typeof entry.content !== 'string' || templates.has(path)) fail('WCA_SHARED_CONTENT_SOURCE_INVALID', 'Captured template content must have exact unique UTF-8 text paths.');
      templates.set(path, entry.content);
    }
    const graphOptions = { fullCatalog: true, sharedContent: true, templateContents: contents };
    const before = dependencyGraph(definition, agents, [], graphOptions);
    const validatedBefore = validatedSharedPhaseDefinition(definition, agents);
    const candidate = structuredClone(definition); const nextAgents = [...agents]; const nextTemplates = new Map(templates);
    const changes = list(copied.changes, 'Explicit shared content changes');
    bound(changes.length, WCA_WORKFLOW_CHANGE_LIMITS.changes);
    if (!changes.length) fail('WCA_CHANGE_INVALID', 'Select an explicit exact shared content replacement.');
    const seen = new Set(); const selectedPaths = new Set(); const replacements = []; const roots = [];
    for (const change of changes) {
      closed(change, kind === 'agent' ? ['kind', 'id', 'operation', 'expectedTextSha256', 'replacement']
        : ['kind', 'id', 'operation', 'expectedDefinitionSha256', 'expectedContentSha256', 'replacement'], 'Shared content replacement');
      if (change.kind !== kind || change.operation !== 'edit' || seen.has(change.id)) fail('WCA_SHARED_CONTENT_UNSUPPORTED', 'Only unique exact existing content edits from this profile are supported, not deletion, forks or mixed kinds.');
      seen.add(change.id);
      if (kind === 'agent') {
        const id = identifier(change.id); const index = agents.findIndex((agent) => agent.id === id); const source = agents[index];
        if (!source || source.scope !== 'repository' || id.startsWith('sf-') || id.startsWith('sflow-')
            || !/^\.github\/agents\/[^/]+(?:\.agent)?\.md$/u.test(source.source ?? '')) {
          fail('WCA_SHARED_CONTENT_SOURCE_UNAVAILABLE', 'Only the exact existing nonprivileged repository Agent Markdown file can be replaced.');
        }
        const path = contentPath(source.source); closed(change.replacement, ['text'], 'Agent text replacement');
        const text = change.replacement.text;
        if (typeof text !== 'string' || !text.trim()) fail('WCA_CHANGE_INVALID', 'Agent replacement needs exact nonempty literal UTF-8 text.');
        if (change.expectedTextSha256 !== agentTextSha256(source.text)) fail('WCA_CHANGE_PARENT_STALE', 'The exact agent text parent changed; recapture and review the current source.');
        let parsed;
        try { parsed = parseAgentDependencies(text, { source: path, agentId: id }); }
        catch { fail('WCA_SHARED_CONTENT_CONTRACT_INVALID', 'The prospective Agent Markdown is invalid under its existing owner.'); }
        if (agentFrontmatter(text) !== agentFrontmatter(source.text)
            || digest(parsed.dependencies) !== digest(source.dependencies)
            || digest(agentResourceTableBytes(text)) !== digest(agentResourceTableBytes(source.text))) {
          fail('WCA_SHARED_AGENT_EFFECT_CHANGE_UNSUPPORTED', 'This profile edits body prose only. Exact frontmatter, tools, eligibility, metadata and remote resource tables must remain unchanged.');
        }
        if (Object.entries(definition.phases ?? {}).some(([phaseId, phase]) => phase.kind === 'skill'
            && (!(source.phases ?? []).length || source.phases.includes(phaseId) || source.defaultFor.includes(phaseId)))) {
          fail('WCA_SHARED_CONTENT_SKP_RECOMPILE_REQUIRED', 'An eligible configured skill phase requires a new exact reviewed agent/binding proof; old skill consent cannot cover replacement prose.');
        }
        nextAgents[index] = { ...source, ...parsed, text };
        roots.push(`agent:${id}`); replacements.push({ kind, id, operation: 'edit', path,
          beforeTextSha256: agentTextSha256(source.text), afterTextSha256: agentTextSha256(text), text,
          changedFields: source.text === text ? [] : ['body'] });
      } else {
        const selection = templateSelection(definition, change.id); const { path, named, raw, id } = selection;
        if (!templates.has(path) || !before.graph.nodes.some((node) => node.kind === 'template-content' && node.id === path)) {
          fail('WCA_SHARED_CONTENT_SOURCE_UNAVAILABLE', 'The selected local template is not retained in the exact captured catalog closure.');
        }
        if (selectedPaths.has(path)) fail('WCA_CHANGE_INVALID', 'Aliases of one physical template cannot receive separate replacements.'); selectedPaths.add(path);
        closed(change.replacement, ['content', 'definition'], 'Template text replacement');
        const content = change.replacement.content;
        if (typeof content !== 'string' || !content.trim()) fail('WCA_CHANGE_INVALID', 'Template replacement needs exact nonempty literal UTF-8 text.');
        if (change.expectedContentSha256 !== textDigest(templates.get(path))
            || change.expectedDefinitionSha256 !== (named ? templateDefinitionSha256(raw) : null)) {
          fail('WCA_CHANGE_PARENT_STALE', 'The exact raw template declaration or content parent changed; recapture it before reviewing an edit.');
        }
        let declaration = raw;
        if (change.replacement.definition !== undefined) {
          if (!named) fail('WCA_SHARED_CONTENT_UNSUPPORTED', 'Legacy path templates have no named declaration to replace.');
          declaration = change.replacement.definition;
          const oldValue = normalizeTemplateCatalog({ [id]: raw })[id]; const nextValue = normalizeTemplateCatalog({ [id]: declaration })[id];
          if (oldValue.path !== nextValue.path || oldValue.kind !== nextValue.kind) fail('WCA_SHARED_TEMPLATE_EFFECT_CHANGE_UNSUPPORTED', 'Template paths and artifact kinds stay exact; only named label and description prose may change.');
          for (const field of ['label', 'description']) if (nextValue[field] !== null && (typeof nextValue[field] !== 'string'
              || Buffer.byteLength(nextValue[field]) > (field === 'label' ? 512 : 30000) || /[\u0000-\u001f\u007f]/u.test(nextValue[field]))) {
            fail('WCA_CHANGE_INVALID', 'Named template display prose requires bounded literal text.');
          }
          candidate.templates[id] = declaration;
        }
        nextTemplates.set(path, content); roots.push(`template-content:${path}`);
        if (named) roots.push(`template:${id}`);
        replacements.push({ kind, id: change.id, operation: 'edit', path,
          beforeDefinitionSha256: named ? templateDefinitionSha256(raw) : null,
          afterDefinitionSha256: named ? templateDefinitionSha256(declaration) : null,
          beforeContentSha256: textDigest(templates.get(path)), afterContentSha256: textDigest(content), content,
          ...(named ? { catalogId: id, definition: declaration } : {}) });
      }
    }
    const nextContents = [...nextTemplates].map(([path, content]) => ({ path, content }));
    const after = dependencyGraph(candidate, nextAgents, [], { ...graphOptions, templateContents: nextContents });
    const validatedAfter = validatedSharedPhaseDefinition(candidate, nextAgents, { prospective: true });
    const impact = reverseSharedPhaseImpact(before.graph, after.graph, [], roots);
    if (replacements.some((row) => kind === 'template' ? row.beforeContentSha256 !== row.afterContentSha256 : row.beforeTextSha256 !== row.afterTextSha256)
        && impact.consumers.some((row) => row.kind === 'phase' && candidate.phases[row.id]?.kind === 'skill')) {
      fail('WCA_SHARED_CONTENT_SKP_RECOMPILE_REQUIRED', 'The changed producer text closure reaches a confirmed skill contract; this profile cannot silently reuse its old consent.');
    }
    const changedTexts = replacements.map((row) => ({ path: row.path, content: row.text ?? row.content }));
    textContracts(validatedAfter, nextTemplates, changedTexts, kind === 'template' ? replacements : []);
    const affectedWorkflows = impact.consumers.filter((row) => row.kind === 'workflow').map((row) => {
      const oldResolved = resolveWorkType(validatedBefore, row.id); const nextResolved = resolveWorkType(validatedAfter, row.id);
      const effectivePhases = nextResolved.phases.filter((phase) => kind === 'agent'
        ? replacements.some((replacement) => { const agent = agents.find((value) => value.id === replacement.id);
          return !agent.phases.length || agent.phases.includes(phase.id); })
        : replacements.some((replacement) => `${candidate.templatesRoot}/${phase.template}` === replacement.path)).map((phase) => ({
          id: phase.id, beforeSha256: effectiveSharedPhaseSha256(oldResolved.phases.find((value) => value.id === phase.id)),
          afterSha256: effectiveSharedPhaseSha256(phase), status: 'phase-policy-unchanged-content-consumer',
          templateOverride: Object.hasOwn(definition.workTypes[row.id].templateOverrides ?? {}, phase.id),
          ...(kind === 'agent' ? { agentSelection: replacements.some((replacement) => agents.find((agent) => agent.id === replacement.id).defaultFor.includes(phase.id))
            ? 'existing-default' : 'eligible-alternative-not-selected' } : {}) }));
      return { id: row.id, relation: row.relation, effectivePhases,
        status: effectivePhases.length ? 'effective-content-consumer' : 'declared-dependency-only' };
    });
    replacements.sort((a, b) => compare(a.id, b.id));
    const result = { ...empty, status: 'ready-for-review', source: { definitionSha256: digest(definition),
      agentCatalogSha256: digest(before.graph.nodes.filter((node) => node.kind === 'agent')),
      templateContentsSha256: digest(contents.map(({ path, content }) => ({ path, sha256: textDigest(content) })).sort((a, b) => compare(a.path, b.path))) },
      replacements, dependencyLocks: before.dependencyLocks, graph: { before: before.graph, after: after.graph },
      impact: { ...empty.impact, consumers: impact.consumers, consumerEdges: impact.edges, affectedWorkflows,
        coverage: 'complete-declared-catalog-reference-impact-within-bounds;eligibility-is-not-execution',
        validation: 'existing-definition-and-captured-text-owners;full-agent-catalog-validation-required-from-compiler-owner',
        excluded: ['retained-story-inventory', 'other-repository-inventory', 'packaged-agent-catalog-provenance', 'unselected-session-overrides', 'external-dependency-hydration',
          'real-human-availability', 'host-qualification', 'authorization', 'submission'] } };
    const planned = { ...result, planSha256: digest(result) }; bound(Buffer.byteLength(canonicalJson(planned)), WCA_WORKFLOW_CHANGE_LIMITS.outputBytes);
    return freeze(planned);
  } catch (error) {
    if (!(error instanceof SingularityFlowError)) throw error;
    const result = { ...empty, findings: [{ code: error.code, fieldPath: error.fieldPath ?? 'changes', message: error.message,
      category: 'submission-blocker', resolvingAction: 'workflow.author.edit' }] };
    return freeze({ ...result, planSha256: digest(result) });
  }
}

export function planSharedAgentChanges(input = {}) {
  return planSharedContentChanges(input, WCA_SHARED_AGENT_CHANGES_PROFILE, 'agent');
}
export function planSharedTemplateChanges(input = {}) {
  return planSharedContentChanges(input, WCA_SHARED_TEMPLATE_CHANGES_PROFILE, 'template');
}
