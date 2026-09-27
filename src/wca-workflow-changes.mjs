/** Pure workflow-only changes. This is impact data, never a writer or an authority capability. */
import { createHash } from 'node:crypto';
import { canonicalJson, recordSha256 } from './records.mjs';
import { isPortableRepositoryPathComponent, SingularityFlowError } from './util.mjs';

export const WCA_WORKFLOW_CHANGES_PROFILE = 'wca-workflow-only-changes/v1';
export const WCA_WORKFLOW_CHANGE_LIMITS = Object.freeze({ changes: 16, workflows: 256,
  phases: 512, agents: 256, catalogEntries: 512, nodes: 4096, edges: 8192,
  inputNodes: 100000, depth: 32, inputBytes: 8 * 1024 * 1024, outputBytes: 2 * 1024 * 1024 });
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const PATCH_FIELDS = ['label', 'description', 'phases', 'plannedClaims', 'reworkLoops'];
const GROUPS = ['workflows', 'phases', 'agents', 'skills', 'templates'];
const digest = (value) => `sha256:${recordSha256(value)}`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
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
    if ((!plain(item) && !Array.isArray(item)) || active.has(item)) fail('WCA_CHANGE_INVALID', 'Workflow changes require ordinary acyclic JSON data.');
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

function dependencyGraph(definition, agents, replacements) {
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
    }
  };
  const named = (from, value) => {
    if (Array.isArray(value)) { for (const child of value) named(from, child); return; }
    if (!plain(value)) return;
    for (const [name, child] of Object.entries(value)) {
      if (name === 'artifactSet' && typeof child === 'string') link(from, 'artifact-set', child);
      if (name === 'inputs') for (const input of list(child, name)) {
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
      named(from, child);
    }
  };
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
  }
  for (const [id, server] of Object.entries(servers)) {
    if (!plain(server)) fail('WCA_CHANGE_INVALID', 'Captured server entries must be ordinary objects.');
    const from = key('mcp-server', id);
    for (const phaseId of server.phases ?? []) link(from, 'phase', phaseId, 'complete-server-scope');
    for (const agentId of server.agents ?? []) link(from, 'agent', agentId, 'complete-server-scope');
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
  const selected = new Set(roots); const pending = [...roots];
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
